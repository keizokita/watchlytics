import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ageGateInput,
  MIN_AGE,
  oauthExchange,
  oauthProvider,
  refreshRequest,
  type AgeGateResponse,
  type AuthResponse,
  type AuthTransport,
  type SessionUser,
} from "@watchlytics/contract";
import {
  ACCESS_TTL_S,
  REFRESH_TTL_S,
  clientIp,
  constantTimeEqual,
  hashRefresh,
  httpError,
  idadeMinimaOk,
  newRefreshToken,
  rateLimit,
  requireUserId,
  sessionIdOf,
  signAccess,
} from "../auth.ts";
import { db } from "../db/client.ts";
import { consents, identities, sessions, swipes, users } from "../db/schema.ts";

/**
 * C2/C3/C4 — troca do código OAuth, rotação do refresh e sessão.
 *
 * A troca do código acontece SEMPRE aqui, nunca no browser: é o que faz o app
 * Expo da fase 4 reusar este endpoint sem backend novo, e o que mantém o
 * client_secret fora do cliente.
 */

/** Login e refresh são raros; quem passa disso está abusando. */
const MINT_PER_MIN = 20;

const COOKIE = "wl_refresh";

/**
 * C5 — a versão do aviso que o usuário leu ao entrar. Desde o β1 ela tem um
 * documento atrás: docs/legal/privacy.md e terms.md, nomeados pelo próprio
 * aviso. Mude junto com o texto de `consentNotice` em apps/web/src/strings.ts,
 * nunca sozinha — e é por isso que ela sobe aqui.
 *
 * `profiling` é o único kind gravado: pelo PLAN §8.1 a conta em si roda por
 * execução de contrato, e é o perfilamento de gosto que precisa de
 * consentimento específico.
 *
 * ponytail: sem re-consentimento, e o gatilho que a nota anterior previa JÁ
 * disparou — o texto mudou no β1. Subir a versão vale só para quem criar conta
 * depois: as contas anteriores seguem com `2026-09-02`, que era um aviso que não
 * nomeava documento nenhum. Num beta fechado isso se resolve falando com as
 * poucas contas que existem, que é exatamente o que a política promete. Vira
 * gate no middleware de auth quando houver gente demais para avisar uma por uma.
 *
 * ponytail: o grafo social ainda não tem kind próprio, e a política já o declara
 * como consentimento separado. A PK (user, kind, version) aceita a segunda
 * linha; falta gravá-la e pedir essa aceitação na tela.
 */
const CONSENT_VERSION = "2026-09-11";

const unauthorized = () => httpError(401, "não autenticado");

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw httpError(500, `${name} não configurada`);
  return value;
}

// ─── Google ─────────────────────────────────────────────────────────────────

export type ProviderIdentity = {
  /** `sub` do provedor. Com o provider, é a ÚNICA chave de login. */
  providerUserId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

async function exchangeWithGoogle(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<ProviderIdentity> {
  const clientId = env("GOOGLE_CLIENT_ID");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: env("GOOGLE_CLIENT_SECRET"),
    }),
  });

  // Código expirado, já usado ou verifier errado. Não vaza o motivo do Google
  // para o cliente — mas registra no servidor: um 401 opaco nos dois lados é
  // indepurável em produção, e o corpo de erro do Google não tem segredo
  // nenhum (é `{"error":"invalid_grant"}` e afins, sem token).
  if (!res.ok) {
    console.warn(
      `google/token ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
    throw httpError(401, "provedor recusou o código");
  }

  const body = (await res.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") {
    throw httpError(502, "provedor não devolveu id_token");
  }

  const claims = decodeJwtPayload(body.id_token);

  // A assinatura do id_token NÃO é verificada, e é seguro exatamente aqui: o
  // token veio da resposta direta do token endpoint sobre TLS, autenticada com
  // o nosso client_secret — não passou por cliente nenhum. É o caso que o
  // próprio Google documenta como dispensável de validação de assinatura.
  // O que continua obrigatório é conferir a quem o token se destina.
  if (
    !GOOGLE_ISSUERS.has(String(claims["iss"])) ||
    claims["aud"] !== clientId ||
    typeof claims["sub"] !== "string" ||
    !claims["sub"]
  ) {
    // O aud é o client_id que o FRONT usou na autorização; o clientId daqui
    // vem do secret do servidor. Divergir significa dois client ids em jogo,
    // e sem este log a diferença é invisível.
    console.warn(
      `id_token rejeitado: iss=${String(claims["iss"])} aud=${String(claims["aud"])} esperado=${clientId}`,
    );
    throw httpError(401, "id_token não é para esta aplicação");
  }

  const email = typeof claims["email"] === "string" ? claims["email"] : null;
  return {
    providerUserId: claims["sub"],
    // Informativo (PLAN §4): nunca é chave de login, nunca deduplica conta.
    email: claims["email_verified"] === true ? email : null,
    displayName: typeof claims["name"] === "string" ? claims["name"] : null,
    avatarUrl: typeof claims["picture"] === "string" ? claims["picture"] : null,
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw httpError(502, "id_token malformado");
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (typeof claims !== "object" || claims === null) throw new Error();
    return claims as Record<string, unknown>;
  } catch {
    throw httpError(502, "id_token malformado");
  }
}

/**
 * O ponto de substituição do teste.
 *
 * ponytail: objeto mutável em vez de injeção de dependência — sem credenciais
 * do Google não há como exercitar a chamada real, e tudo que vem DEPOIS dela
 * (conta, sessão, rotação) é o que realmente precisa de teste.
 */
export const providers = {
  google: exchangeWithGoogle as (
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ) => Promise<ProviderIdentity>,
};

// ─── conta ──────────────────────────────────────────────────────────────────

const handleSeed = (identity: ProviderIdentity) => {
  const base = (identity.email?.split("@")[0] ?? identity.displayName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);
  return base.length >= 3 ? base : "user";
};

const suffix = () => Math.random().toString(36).slice(2, 6);

/**
 * Encontra a conta por (provider, provider_user_id) ou cria uma nova.
 *
 * NUNCA procura por email. O relay da Apple e o Google do mesmo humano são
 * endereços diferentes, e dois provedores podem devolver o mesmo email sem
 * serem a mesma pessoa. Vincular contas é ação explícita do usuário — jamais
 * um efeito colateral do login.
 */
async function findOrCreateUser(
  provider: string,
  identity: ProviderIdentity,
  ip: string,
): Promise<string> {
  const lookup = async () => {
    const [row] = await db
      .select({ userId: identities.userId })
      .from(identities)
      .where(
        and(
          eq(identities.provider, provider),
          eq(identities.providerUserId, identity.providerUserId),
        ),
      );
    return row?.userId ?? null;
  };

  const existing = await lookup();
  if (existing) return existing;

  try {
    return await db.transaction(async (tx) => {
      const seed = handleSeed(identity);
      let userId: string | undefined;

      // Handle é único no banco; ON CONFLICT DO NOTHING evita abortar a
      // transação e o sufixo aleatório resolve a colisão sem consulta prévia.
      for (let i = 0; i < 5 && !userId; i++) {
        const [row] = await tx
          .insert(users)
          .values({
            handle: i === 0 ? seed : `${seed}-${suffix()}`,
            displayName: identity.displayName ?? seed,
            email: identity.email,
            avatarUrl: identity.avatarUrl,
          })
          .onConflictDoNothing({ target: users.handle })
          .returning({ id: users.id });
        userId = row?.id;
      }
      if (!userId) throw httpError(503, "não foi possível gerar um handle");

      await tx.insert(identities).values({
        provider,
        providerUserId: identity.providerUserId,
        userId,
        emailAtProvider: identity.email,
      });

      // Na MESMA transação da conta: conta que existe sem consentimento é
      // exatamente o que o registro versionado deveria provar que não acontece.
      await tx.insert(consents).values({
        userId,
        kind: "profiling",
        version: CONSENT_VERSION,
        ip,
      });
      return userId;
    });
  } catch (e) {
    // Dois primeiros logins simultâneos: a PK de identities recusa o segundo e
    // a transação desfaz o usuário órfão. Quem perdeu reusa o vencedor.
    const winner = await lookup();
    if (winner) return winner;
    throw e;
  }
}

async function loadUser(userId: string): Promise<SessionUser> {
  const [row] = await db
    .select({
      id: users.id,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      isPublic: users.isPublic,
      birthYear: users.birthYear,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw unauthorized();

  // β2 — o ano em si NUNCA sai da API: vira booleano aqui. O cliente precisa
  // saber se deve perguntar, não a idade de ninguém.
  //
  // Quem BLOQUEIA enquanto isto for true é o `requireUserId` (β2): esta rota e
  // a `/v1/auth/age` são as duas que respondem com a porta fechada.
  const { birthYear, ...user } = row;
  return { ...user, needsAgeGate: birthYear === null };
}

// ─── sessão ─────────────────────────────────────────────────────────────────

async function startSession(
  userId: string,
  userAgent: string | undefined,
): Promise<string> {
  const id = randomUUID();
  const { token, hash } = newRefreshToken(id);
  await db.insert(sessions).values({
    id,
    userId,
    refreshTokenHash: hash,
    expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
    userAgent: userAgent ?? null,
  });
  return token;
}

const revoke = (id: string) =>
  db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));

/**
 * C3 — rotação com detecção de replay.
 *
 * Um refresh já usado não bate com o hash corrente, mas ainda carrega o id da
 * sessão: revogamos a sessão inteira. Quem tem o token válido (vítima ou
 * atacante, não dá para saber qual) perde o acesso junto — é o comportamento
 * correto, porque o segredo comprovadamente vazou.
 */
async function rotate(
  token: string,
): Promise<{ userId: string; refresh: string }> {
  const id = sessionIdOf(token);
  if (!id) throw unauthorized();

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id));
  if (!session) throw unauthorized();

  if (!constantTimeEqual(hashRefresh(token), session.refreshTokenHash)) {
    await revoke(id);
    throw unauthorized();
  }
  if (session.revokedAt || session.expiresAt <= new Date()) throw unauthorized();

  const next = newRefreshToken(id);
  const rotated = await db
    .update(sessions)
    .set({ refreshTokenHash: next.hash })
    // O hash antigo no WHERE fecha a corrida: de duas renovações simultâneas
    // com o mesmo token, só uma escreve.
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.refreshTokenHash, session.refreshTokenHash),
      ),
    )
    .returning({ id: sessions.id });

  if (!rotated.length) {
    await revoke(id);
    throw unauthorized();
  }
  return { userId: session.userId, refresh: next.token };
}

/**
 * β2 — o que fazer com quem declara menos de MIN_AGE.
 *
 * Apaga a conta, e a cascata leva identidade, sessão e consentimento junto. É o
 * que a política promete e o único fim honesto: a conta nasceu no login do
 * Google minutos antes e não tem nada dentro além do que o Google mandou.
 *
 * O `unless` é o que impede isto de virar arma. Conta anterior ao β2 também tem
 * `birth_year` nulo, e essa tem catálogo, swipes e amizades — um erro de
 * digitação (2015 em vez de 1995) apagaria a vida de alguém sem confirmação
 * nenhuma. Por isso o apagar só vale para conta que NUNCA entrou no
 * app, e quem já entrou apenas perde a sessão e continua fora até responder um
 * ano válido. Os dados dessa pessoa não são meus para destruir por engano.
 *
 * O sinal de "nunca entrou" é ter zero swipes: o onboarding (D4) exige
 * ONBOARDING_SWIPES antes de qualquer outra tela, então conta que usou o app
 * tem swipe, e conta que não tem swipe não tem mais nada a perder.
 */
async function recusar(userId: string): Promise<void> {
  const [usou] = await db
    .select({ userId: swipes.userId })
    .from(swipes)
    .where(eq(swipes.userId, userId))
    .limit(1);

  if (!usou) {
    await db.delete(users).where(eq(users.id, userId));
    return;
  }

  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

// ─── transporte ─────────────────────────────────────────────────────────────

/**
 * `Path=/v1/auth` porque nenhuma outra rota precisa do refresh — o access vai
 * em header. Reduz a superfície do cookie a três endpoints.
 */
function setRefreshCookie(reply: FastifyReply, token: string, maxAge: number) {
  reply.header(
    "set-cookie",
    `${COOKIE}=${token}; Path=/v1/auth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
  );
}

const readRefreshCookie = (req: FastifyRequest) =>
  req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

function respond(
  reply: FastifyReply,
  transport: AuthTransport,
  userId: string,
  refresh: string,
) {
  const tokens = { access: signAccess(userId), expiresIn: ACCESS_TTL_S };
  if (transport === "body") return { ...tokens, refresh };

  setRefreshCookie(reply, refresh, REFRESH_TTL_S);
  return tokens;
}

// ─── rotas ──────────────────────────────────────────────────────────────────

/**
 * Registrado direto na instância raiz (não via `app.register`): não há hook
 * global aqui, então encapsulamento não acrescentaria nada.
 */
export function registerAuth(app: FastifyInstance): void {
  /** Só o que emite token é limitado por IP; o resto é limitado por conta. */
  const limitByIp = (req: FastifyRequest) => {
    if (!rateLimit(`ip:${clientIp(req)}`, MINT_PER_MIN)) {
      throw httpError(429, "muitas tentativas");
    }
  };

  app.post<{ Params: { provider: string } }>(
    "/v1/auth/oauth/:provider",
    async (req, reply): Promise<AuthResponse | { error: string }> => {
      limitByIp(req);

      const provider = oauthProvider.safeParse(req.params.provider);
      if (!provider.success) {
        reply.code(404);
        return { error: "provedor desconhecido" };
      }

      const parsed = oauthExchange.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "requisição inválida" };
      }
      const { code, codeVerifier, redirectUri, transport } = parsed.data;

      // Allowlist: o redirect_uri vai para o provedor e volta como destino do
      // código. Aceitar o que o cliente mandar abre redirecionamento aberto.
      const allowed = env("GOOGLE_REDIRECT_URIS")
        .split(",")
        .map((u) => u.trim());
      if (!allowed.includes(redirectUri)) {
        reply.code(400);
        return { error: "redirectUri não autorizado" };
      }

      const identity = await providers[provider.data](
        code,
        codeVerifier,
        redirectUri,
      );
      const userId = await findOrCreateUser(
        provider.data,
        identity,
        clientIp(req),
      );
      const refresh = await startSession(userId, req.headers["user-agent"]);

      return {
        ...respond(reply, transport, userId, refresh),
        user: await loadUser(userId),
      };
    },
  );

  app.post("/v1/auth/refresh", async (req, reply) => {
    limitByIp(req);

    const parsed = refreshRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "requisição inválida" };
    }

    const token = parsed.data.refresh ?? readRefreshCookie(req);
    if (!token) throw unauthorized();

    const { userId, refresh } = await rotate(token);
    return respond(reply, parsed.data.transport, userId, refresh);
  });

  /** Revoga a sessão apresentada. Sem refresh não há o que revogar: 204 mesmo assim. */
  app.post("/v1/auth/logout", async (req, reply) => {
    const parsed = refreshRequest.safeParse(req.body ?? {});
    const token = (parsed.success ? parsed.data.refresh : undefined) ??
      readRefreshCookie(req);

    const id = token ? sessionIdOf(token) : null;
    if (id && token) {
      const [session] = await db
        .select({ hash: sessions.refreshTokenHash })
        .from(sessions)
        .where(eq(sessions.id, id));
      // Só revoga com o token corrente em mãos: senão o id de sessão, que é
      // metade pública do token, viraria um DoS de logout alheio.
      if (session && constantTimeEqual(hashRefresh(token), session.hash)) {
        await revoke(id);
      }
    }

    setRefreshCookie(reply, "", 0);
    reply.code(204);
    return null;
  });

  /**
   * Rota protegida de verdade: é por ela que o cliente sabe quem ele é.
   *
   * Fora da porta de idade de propósito: é ela que devolve `needsAgeGate`, e
   * bloqueá-la deixaria o cliente sem saber por que foi bloqueado.
   */
  app.get("/v1/auth/me", async (req) =>
    loadUser(await requireUserId(req, { ageGate: false })),
  );

  /**
   * β2 — a porta de idade.
   *
   * Responde 200 com `ok: false` em vez de 4xx: a avaliação da porta funcionou,
   * o que ela decidiu está no corpo, e o cliente que acabou de perguntar a idade
   * precisa LER a resposta — um 403 aqui cairia no mesmo tratamento genérico de
   * erro que a porta fechada de todas as outras rotas.
   *
   * A recusa não grava o ano e apaga a conta que acabou de nascer — ver
   * `recusar` abaixo. Guardar "tentou entrar e é menor" seria acumular
   * justamente o dado que a lei manda não coletar, e a conta criada no login
   * guarda nome, e-mail e avatar vindos do Google: deixá-la de pé seria guardar
   * dado pessoal de menor declarado, que é o oposto do que a política promete.
   */
  app.post("/v1/auth/age", async (req, reply): Promise<AgeGateResponse | { error: string }> => {
    const userId = await requireUserId(req, { ageGate: false });

    const parsed = ageGateInput.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "requisição inválida" };
    }

    if (!idadeMinimaOk(parsed.data.birthYear)) {
      await recusar(userId);
      setRefreshCookie(reply, "", 0);
      return { ok: false, minAge: MIN_AGE };
    }

    // `isNull` no WHERE: a porta se responde UMA vez. Sem isso, quem já passou
    // poderia reescrever o ano, e a coluna deixaria de ser prova de nada.
    await db
      .update(users)
      .set({ birthYear: parsed.data.birthYear })
      .where(and(eq(users.id, userId), isNull(users.birthYear)));

    return { ok: true, minAge: MIN_AGE };
  });
}
