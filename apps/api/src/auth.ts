import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { MIN_AGE } from "@watchlytics/contract";
import { db } from "./db/client.ts";
import { users } from "./db/schema.ts";

/**
 * Primitivas de identidade: JWT de acesso, refresh opaco e rate limit.
 *
 * Sem biblioteca de JWT: HS256 é um HMAC-SHA256 sobre `header.payload` e o
 * `node:crypto` já faz isso — a dependência traria sobretudo os algoritmos
 * assimétricos e o parsing de JWKS, que não usamos.
 */

/** Curto de propósito: um access vazado expira sozinho. Revogar é com o refresh. */
export const ACCESS_TTL_S = 15 * 60;

/** Janela ABSOLUTA da sessão — a rotação não estende. 30 dias e faz login de novo. */
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;

/** Teto por conta, em toda rota autenticada por JWT. */
const ACCOUNT_PER_MIN = 120;

export const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

const unauthorized = () => httpError(401, "não autenticado");

// ─── JWT de acesso ──────────────────────────────────────────────────────────

/** Fixo: nunca lemos `alg` do token, então o header é constante. */
const HEADER = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");

function secret(): Buffer {
  const s = process.env["AUTH_SECRET"];
  // Lido a cada uso e não no import: server.ts é importado por testes e por
  // ferramentas que não assinam nada, e não devem morrer por causa disso.
  if (!s || s.length < 32) {
    throw httpError(500, "AUTH_SECRET ausente ou menor que 32 caracteres");
  }
  return Buffer.from(s, "utf8");
}

const mac = (data: string) =>
  createHmac("sha256", secret()).update(data).digest("base64url");

/** Comparação em tempo constante de dois textos ASCII (assinaturas, hashes). */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  // timingSafeEqual exige mesmo tamanho; tamanho não é segredo aqui.
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signAccess(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, iat: now, exp: now + ACCESS_TTL_S }),
  ).toString("base64url");
  const signed = `${HEADER}.${payload}`;
  return `${signed}.${mac(signed)}`;
}

/** Devolve o `sub` ou null. Nunca lança: token inválido é 401, não 500. */
export function verifyAccess(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  // O algoritmo é NOSSO, nunca o que o token declara: aceitar `alg` do token é
  // a família clássica de furos de JWT (alg=none, HS256 assinado com a chave
  // pública de RS256).
  if (!constantTimeEqual(signature, mac(`${header}.${payload}`))) return null;

  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (typeof claims !== "object" || claims === null) return null;
    const { sub, exp } = claims as { sub?: unknown; exp?: unknown };
    if (typeof sub !== "string" || typeof exp !== "number") return null;
    if (exp * 1000 <= Date.now()) return null;
    return sub;
  } catch {
    return null;
  }
}

// ─── refresh opaco ──────────────────────────────────────────────────────────

/**
 * Formato `<sessionId>.<segredo>`.
 *
 * O id no token é o que torna a detecção de replay possível: um refresh já
 * rotacionado não bate com nenhum hash gravado, mas ainda diz QUAL sessão
 * revogar. Sem ele, o token vazado seria só "desconhecido" e a sessão do
 * atacante continuaria viva.
 */
export function newRefreshToken(sessionId: string): {
  token: string;
  hash: string;
} {
  const token = `${sessionId}.${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashRefresh(token) };
}

/** Nunca gravamos o token em claro: o banco vazado não devolve sessões. */
export const hashRefresh = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionIdOf(token: string): string | null {
  const id = token.split(".")[0];
  // Validar antes de consultar: uuid malformado vira erro 22P02 do Postgres.
  return id && UUID.test(id) ? id : null;
}

// ─── rate limit ─────────────────────────────────────────────────────────────

/**
 * Janela fixa em memória. É o que cabe no v1: uma instância no Fly, ~10k
 * usuários, e o PLAN §3 diz "cache: nenhum".
 *
 * ponytail: contador POR INSTÂNCIA. Com duas instâncias o teto vira o dobro.
 * Vira Redis no mesmo dia em que o feed precisar de um.
 */
const buckets = new Map<string, { hits: number; resetAt: number }>();

/** true = pode seguir. */
export function rateLimit(key: string, perMinute: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    // Varre só quando o mapa cresce: sem timer, sem job.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    buckets.set(key, { hits: 1, resetAt: now + 60_000 });
    return true;
  }

  bucket.hits += 1;
  return bucket.hits <= perMinute;
}

/**
 * IP do cliente real.
 *
 * Em produção a API só recebe tráfego pelo proxy do Pages (functions/v1), então
 * `req.ip` é sempre a borda da Cloudflare — o limite viraria global. Os headers
 * são postos por Cloudflare e Fly nas respectivas bordas.
 *
 * ponytail: header é forjável por quem alcançar o Fly direto. Aceitável porque
 * este limite é anti-abuso, não fronteira de segurança — nada aqui é adivinhável
 * por força bruta (código OAuth de uso único, refresh de 256 bits).
 */
export function clientIp(req: FastifyRequest): string {
  const header = req.headers["cf-connecting-ip"] ?? req.headers["fly-client-ip"];
  return typeof header === "string" && header.length <= 45 ? header : req.ip;
}

// ─── porta de entrada das rotas ─────────────────────────────────────────────

/**
 * Identidade da requisição. Lança 401, 403 ou 429 — Fastify traduz `statusCode`.
 *
 * β3 — o shim do C1 saiu daqui em 2026-09-10. Era uma variável de ambiente com
 * um id de usuário atendendo qualquer requisição sem `Authorization`, e ele já
 * tinha escondido um 401 até a produção: em dev o front nunca mandava header e o
 * bug só apareceu no ar. Um atalho que substitui a autenticação esconde
 * exatamente a classe de bug que ele finge cobrir, e com o OAuth no ar ele não
 * era mais o único caminho de entrada — era só o caminho sem senha.
 *
 * β2 — e é aqui que a porta de idade fecha, no ÚNICO ponto por onde toda rota
 * autenticada passa. Um guard por rota seria o mesmo código quinze vezes, e a
 * décima sexta rota nasceria sem ele.
 *
 * `ageGate: false` é para as duas rotas que precisam funcionar com a porta
 * fechada: `/v1/auth/me`, que é como o cliente descobre que precisa perguntar,
 * e `/v1/auth/age`, que é a resposta. Qualquer outra rota com a porta aberta
 * seria uma conta sem idade usando o app. `false` dispensa a PORTA, nunca a
 * conta: as duas rotas continuam exigindo que o dono do token exista.
 *
 * ponytail: uma consulta pela PK em toda requisição autenticada. O alternativo
 * seria carimbar a idade no access token e não consultar nada — mas aí quem
 * passa pela porta continua bloqueado até o token expirar (15 min), porque
 * `ageGateResponse` não devolve token novo, e conta apagada seguiria entrando
 * pelo mesmo prazo. A consulta é honesta e some no dia em que aparecer no
 * perfil de latência.
 */
export async function requireUserId(
  req: FastifyRequest,
  opts?: { ageGate?: boolean },
): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();

  const userId = verifyAccess(header.slice(7));
  if (!userId) throw unauthorized();

  if (!rateLimit(`account:${userId}`, ACCOUNT_PER_MIN)) {
    throw httpError(429, "muitas requisições");
  }

  const [row] = await db
    .select({ birthYear: users.birthYear })
    .from(users)
    .where(eq(users.id, userId));

  // Token válido de uma conta que não existe mais. Acontece de propósito: a
  // recusa da porta de idade apaga a conta, e o access dela ainda vale por até
  // 15 minutos. Não autenticado é a resposta certa — 403 diria "falta responder
  // a porta", e não falta: não há mais a quem responder.
  if (!row) throw unauthorized();

  if (opts?.ageGate !== false && row.birthYear === null) {
    throw httpError(403, "porta de idade pendente");
  }
  return userId;
}

/** Idade em anos cheios não dá para saber só com o ano; este é o ano corrente. */
export const idadeMinimaOk = (birthYear: number) =>
  new Date().getFullYear() - birthYear >= MIN_AGE;
