import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyRequest } from "fastify";

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
 * Identidade da requisição. Lança 401 (ou 429) — Fastify traduz `statusCode`.
 *
 * `req` é opcional só enquanto o shim do C1 existir: as rotas que ainda não o
 * passam continuam funcionando com o usuário fixo do ambiente.
 */
export function requireUserId(req?: FastifyRequest): string {
  const header = req?.headers.authorization;

  if (header?.startsWith("Bearer ")) {
    const userId = verifyAccess(header.slice(7));
    // Bearer presente e inválido NUNCA cai no shim: senão, em ambiente de dev,
    // um token expirado passaria a valer como o usuário fixo.
    if (!userId) throw unauthorized();

    if (!rateLimit(`account:${userId}`, ACCOUNT_PER_MIN)) {
      throw httpError(429, "muitas requisições");
    }
    return userId;
  }

  // ponytail: shim do C1 — usuário fixo do ambiente para as trilhas A, B e D
  // andarem sem OAuth. SAI quando o fluxo do Google estiver em produção: apagar
  // este bloco, tornar `req` obrigatório e passar `req` em toda rota. Em
  // produção DEV_USER_ID não é definida, então o caminho abaixo já é 401.
  const dev = process.env["DEV_USER_ID"];
  if (dev) return dev;

  throw unauthorized();
}
