import assert from "node:assert/strict";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { authResponse, sessionUser } from "@watchlytics/contract";
import { ACCESS_TTL_S, signAccess, verifyAccess } from "./auth.ts";
import { db, pg } from "./db/client.ts";
import { identities, sessions, users } from "./db/schema.ts";
import { providers } from "./routes/auth.ts";
import { buildServer } from "./server.ts";

/**
 * C2, C3 e C4.
 *
 * A chamada ao token endpoint do Google é o ÚNICO ponto que não dá para
 * exercitar sem credenciais — e é justamente o pedaço sem lógica nossa. Tudo
 * depois dela (conta, sessão, rotação, replay, revogação, 401, rate limit) é
 * lógica nossa e está testado de verdade aqui.
 *
 * Precisa do banco migrado: npm run migrate && npm run seed
 */

const REDIRECT = "http://localhost:5173/";
process.env["AUTH_SECRET"] = "chave-de-teste-com-mais-de-32-caracteres";
process.env["GOOGLE_REDIRECT_URIS"] = `${REDIRECT},http://outro.local/`;

const app = buildServer();

/** Um IP por teste: o rate limit é por IP e não pode vazar entre casos. */
let ips = 0;
const freshIp = () => `198.51.100.${++ips}`;

const created: string[] = [];

test.after(async () => {
  if (created.length) {
    // Cascata leva identities e sessions junto.
    await db.delete(users).where(inArray(users.id, created));
  }
  await app.close();
  await pg.end();
});

type LoginOpts = {
  sub: string;
  email?: string | null;
  transport?: "cookie" | "body";
  ip?: string;
  redirectUri?: string;
};

function stubGoogle(sub: string, email: string | null) {
  providers.google = async () => ({
    providerUserId: sub,
    email,
    displayName: "Test Person",
    avatarUrl: null,
  });
}

async function login(opts: LoginOpts) {
  stubGoogle(opts.sub, opts.email ?? null);
  return app.inject({
    method: "POST",
    url: "/v1/auth/oauth/google",
    headers: { "cf-connecting-ip": opts.ip ?? freshIp() },
    payload: {
      code: "codigo-do-provedor",
      codeVerifier: "v".repeat(43),
      redirectUri: opts.redirectUri ?? REDIRECT,
      transport: opts.transport ?? "cookie",
    },
  });
}

/** Login nativo: devolve o refresh no corpo, que é o que os testes de C3 usam. */
async function loginNative(sub: string) {
  const res = await login({ sub, transport: "body" });
  assert.equal(res.statusCode, 200, res.body);
  const body = authResponse.parse(res.json());
  assert.ok(body.refresh, "transporte body devolve o refresh");
  created.push(body.user.id);
  return { ...body, refresh: body.refresh };
}

const refresh = (token: string, ip = freshIp()) =>
  app.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    headers: { "cf-connecting-ip": ip },
    payload: { refresh: token, transport: "body" },
  });

// ─── C3: JWT de acesso ──────────────────────────────────────────────────────

test("access token: assina, verifica, e rejeita adulteração", () => {
  const id = "00000000-0000-4000-8000-00000000beef";
  const token = signAccess(id);

  assert.equal(verifyAccess(token), id, "ida e volta");
  assert.equal(verifyAccess("lixo"), null);
  assert.equal(verifyAccess(`${token}x`), null, "assinatura alterada");

  // Troca o sub mantendo a assinatura: é o ataque óbvio.
  const [header, , signature] = token.split(".") as [string, string, string];
  const forged = Buffer.from(
    JSON.stringify({ sub: "outro", exp: Math.floor(Date.now() / 1000) + 60 }),
  ).toString("base64url");
  assert.equal(verifyAccess(`${header}.${forged}.${signature}`), null);

  // alg=none é o furo clássico — o header do token nunca é lido.
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url");
  assert.equal(verifyAccess(`${none}.${forged}.`), null);
});

test("access token expira em 15 minutos", () => {
  const token = signAccess("00000000-0000-4000-8000-00000000beef");
  const now = Date.now;
  try {
    Date.now = () => now() + (ACCESS_TTL_S - 5) * 1000;
    assert.ok(verifyAccess(token), "ainda vale faltando 5s");
    Date.now = () => now() + (ACCESS_TTL_S + 5) * 1000;
    assert.equal(verifyAccess(token), null, "expirou");
  } finally {
    Date.now = now;
  }
});

// ─── C2: troca do código e conta ────────────────────────────────────────────

test("primeiro login cria conta, identidade e sessão", async () => {
  const res = await login({ sub: "google-sub-novo", email: "ana@gmail.com" });
  assert.equal(res.statusCode, 200, res.body);

  const body = authResponse.parse(res.json());
  created.push(body.user.id);

  assert.equal(verifyAccess(body.access), body.user.id, "access é do usuário");
  assert.equal(body.expiresIn, ACCESS_TTL_S);
  assert.equal(body.refresh, undefined, "no transporte cookie o refresh não vai no corpo");

  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /^wl_refresh=[^;]+/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/v1\/auth/);

  const [identity] = await db
    .select()
    .from(identities)
    .where(eq(identities.providerUserId, "google-sub-novo"));
  assert.equal(identity?.userId, body.user.id);
  assert.equal(identity?.provider, "google");

  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, body.user.id));
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]?.refreshTokenHash.length, 0, "hash gravado, não o token");
});

test("segundo login com o mesmo sub reusa a conta", async () => {
  const first = authResponse.parse((await login({ sub: "sub-repetido" })).json());
  created.push(first.user.id);

  const second = authResponse.parse((await login({ sub: "sub-repetido" })).json());
  assert.equal(second.user.id, first.user.id, "mesma identidade, mesma conta");

  const rows = await db
    .select()
    .from(identities)
    .where(eq(identities.providerUserId, "sub-repetido"));
  assert.equal(rows.length, 1);
});

test("email igual em subs diferentes NÃO deduplica a conta", async () => {
  // O relay da Apple e o Google do mesmo humano são emails diferentes; e dois
  // provedores podem devolver o mesmo email sem ser a mesma pessoa. Vincular
  // contas é ação explícita do usuário, nunca efeito colateral do login.
  const a = authResponse.parse(
    (await login({ sub: "sub-a", email: "mesmo@gmail.com" })).json(),
  );
  const b = authResponse.parse(
    (await login({ sub: "sub-b", email: "mesmo@gmail.com" })).json(),
  );
  created.push(a.user.id, b.user.id);

  assert.notEqual(a.user.id, b.user.id, "duas contas, não uma");
  assert.notEqual(a.user.handle, b.user.handle, "handle colidiu e ganhou sufixo");
});

test("transporte nativo devolve o refresh no corpo e não põe cookie", async () => {
  const res = await login({ sub: "sub-nativo", transport: "body" });
  const body = authResponse.parse(res.json());
  created.push(body.user.id);

  assert.ok(body.refresh, "SecureStore precisa do token no corpo");
  assert.equal(res.headers["set-cookie"], undefined);
});

test("provedor desconhecido é 404 e corpo inválido é 400", async () => {
  const ip = freshIp();
  const unknown = await app.inject({
    method: "POST",
    url: "/v1/auth/oauth/facebook",
    headers: { "cf-connecting-ip": ip },
    payload: { code: "x", codeVerifier: "v".repeat(43), redirectUri: REDIRECT },
  });
  assert.equal(unknown.statusCode, 404);

  const bad = await app.inject({
    method: "POST",
    url: "/v1/auth/oauth/google",
    headers: { "cf-connecting-ip": ip },
    payload: { code: "x", codeVerifier: "curto", redirectUri: REDIRECT },
  });
  assert.equal(bad.statusCode, 400, "code_verifier fora do RFC 7636");
});

test("redirectUri fora da allowlist é recusado antes de falar com o provedor", async () => {
  let chamou = false;
  providers.google = async () => {
    chamou = true;
    throw new Error("não deveria chegar aqui");
  };

  const res = await login({ sub: "irrelevante", redirectUri: "http://evil.example/" });
  assert.equal(res.statusCode, 400);
  assert.equal(chamou, false, "nada é enviado ao provedor");
});

// ─── C3: rotação, replay e revogação ────────────────────────────────────────

test("refresh rotaciona: o token novo vale, o velho não", async () => {
  const { refresh: r0 } = await loginNative("sub-rotacao");

  const res = await refresh(r0);
  assert.equal(res.statusCode, 200, res.body);
  const r1 = (res.json() as { refresh?: string }).refresh;
  assert.ok(r1);
  assert.notEqual(r1, r0, "o refresh é trocado a cada uso");

  assert.equal((await refresh(r1)).statusCode, 200, "o corrente continua valendo");
});

test("refresh reusado é rejeitado E revoga a sessão inteira", async () => {
  const { refresh: r0, user } = await loginNative("sub-replay");

  const rotated = await refresh(r0);
  assert.equal(rotated.statusCode, 200);
  const r1 = (rotated.json() as { refresh: string }).refresh;

  // Replay: alguém apresenta o token já rotacionado.
  assert.equal((await refresh(r0)).statusCode, 401, "reuso é rejeitado");

  // E a sessão cai junto — quem tem o token corrente também perde o acesso,
  // porque não dá para saber se a vítima é ele ou o atacante.
  assert.equal((await refresh(r1)).statusCode, 401, "o token corrente morre junto");

  const [row] = await db.select().from(sessions).where(eq(sessions.userId, user.id));
  assert.ok(row?.revokedAt, "revoked_at gravado");
});

test("refresh expirado é rejeitado", async () => {
  const { refresh: token, user } = await loginNative("sub-expirado");

  await db
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(sessions.userId, user.id));

  assert.equal((await refresh(token)).statusCode, 401);
});

test("refresh forjado ou de sessão inexistente é 401", async () => {
  assert.equal((await refresh("lixo")).statusCode, 401);
  assert.equal(
    (await refresh("00000000-0000-4000-8000-0000000000ff.qualquercoisa")).statusCode,
    401,
    "sessão inexistente",
  );

  // Segredo errado para uma sessão REAL: mesmo tratamento de replay.
  const { refresh: token, user } = await loginNative("sub-forjado");
  const forged = `${token.split(".")[0]}.segredo-errado`;
  assert.equal((await refresh(forged)).statusCode, 401);

  const [row] = await db.select().from(sessions).where(eq(sessions.userId, user.id));
  assert.ok(row?.revokedAt, "adivinhação também derruba a sessão");
});

test("refresh pelo cookie, sem nada no corpo (caminho da web)", async () => {
  const res = await login({ sub: "sub-cookie" });
  const body = authResponse.parse(res.json());
  created.push(body.user.id);

  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const rotated = await app.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    headers: { "cf-connecting-ip": freshIp(), cookie },
  });

  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal(
    (rotated.json() as { refresh?: string }).refresh,
    undefined,
    "na web o refresh só existe no cookie",
  );
  assert.match(String(rotated.headers["set-cookie"]), /^wl_refresh=[^;]+/);
});

test("logout revoga a sessão; refresh depois dele é 401", async () => {
  const { refresh: token } = await loginNative("sub-logout");

  const out = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    payload: { refresh: token },
  });
  assert.equal(out.statusCode, 204);
  assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);

  assert.equal((await refresh(token)).statusCode, 401);
});

test("logout com o id da sessão mas sem o segredo não derruba ninguém", async () => {
  const { refresh: token } = await loginNative("sub-logout-alheio");

  // O id da sessão é metade pública do token: não pode bastar para revogar.
  await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    payload: { refresh: `${token.split(".")[0]}.chute` },
  });

  assert.equal((await refresh(token)).statusCode, 200, "a sessão legítima sobreviveu");
});

// ─── C4: middleware de auth e rate limit ────────────────────────────────────

test("rota protegida: 401 sem token, 200 com token válido", async () => {
  const { access, user } = await loginNative("sub-protegida");

  const ok = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: { authorization: `Bearer ${access}` },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(sessionUser.parse(ok.json()), user);

  const saved = process.env["DEV_USER_ID"];
  delete process.env["DEV_USER_ID"];
  try {
    const anon = await app.inject({ method: "GET", url: "/v1/auth/me" });
    assert.equal(anon.statusCode, 401);
  } finally {
    if (saved) process.env["DEV_USER_ID"] = saved;
  }
});

test("Bearer inválido é 401 mesmo com o shim do C1 ligado", async () => {
  assert.ok(process.env["DEV_USER_ID"], "este teste só faz sentido com o shim ligado");

  for (const bad of ["Bearer lixo", "Bearer ", `Bearer ${signAccess("x")}z`]) {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: bad },
    });
    assert.equal(res.statusCode, 401, `${bad} não pode cair no usuário de dev`);
  }
});

test("rate limit por IP nas rotas que emitem token", async () => {
  const ip = freshIp();
  stubGoogle("sub-rate-ip", null);

  let last = 0;
  for (let i = 0; i < 21; i++) {
    const res = await login({ sub: "sub-rate-ip", ip });
    last = res.statusCode;
    if (i === 0) created.push(authResponse.parse(res.json()).user.id);
    if (i < 20) assert.equal(res.statusCode, 200, `requisição ${i + 1} ainda dentro do teto`);
  }
  assert.equal(last, 429, "a 21ª do mesmo IP é barrada");

  // Outro IP não paga pelo vizinho.
  assert.equal((await login({ sub: "sub-rate-ip" })).statusCode, 200);
});

test("rate limit por conta nas rotas autenticadas", async () => {
  const { access } = await loginNative("sub-rate-conta");
  const me = () =>
    app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${access}`, "cf-connecting-ip": freshIp() },
    });

  let last = 0;
  // O teto é por conta, então trocar de IP a cada chamada não ajuda.
  for (let i = 0; i < 121; i++) last = (await me()).statusCode;
  assert.equal(last, 429);
});
