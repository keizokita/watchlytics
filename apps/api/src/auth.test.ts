import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  authResponse,
  handleRegex,
  MIN_AGE,
  sessionUser,
} from "@watchlytics/contract";
import { ACCESS_TTL_S, signAccess, verifyAccess } from "./auth.ts";
import { db, pg } from "./db/client.ts";
import {
  consents,
  friendships,
  identities,
  libraryEntries,
  notifications,
  sessions,
  swipes,
  titles,
  users,
} from "./db/schema.ts";
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
  assert.notEqual(a.user.handle, b.user.handle, "cada conta sorteia o seu");
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

  const anon = await app.inject({ method: "GET", url: "/v1/auth/me" });
  assert.equal(anon.statusCode, 401);
});

/**
 * β3 — o shim do C1 saiu, mas o teste fica: era ele que provava que um Bearer
 * quebrado NUNCA vira usuário de dev. Hoje prova que também não vira anônimo
 * com acesso: token estragado é 401, não "sem token".
 */
test("Bearer inválido é 401, nunca outra identidade", async () => {
  for (const bad of ["Bearer lixo", "Bearer ", `Bearer ${signAccess("x")}z`]) {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: bad },
    });
    assert.equal(res.statusCode, 401, `${bad} não pode autenticar ninguém`);
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

test("C5 — primeiro login grava consentimento versionado, o segundo não duplica", async () => {
  const first = authResponse.parse((await login({ sub: "sub-consent" })).json());
  created.push(first.user.id);

  const afterFirst = await db
    .select()
    .from(consents)
    .where(eq(consents.userId, first.user.id));

  assert.equal(afterFirst.length, 1, "uma linha por kind consentido");
  assert.equal(afterFirst[0]?.kind, "profiling");
  // A versão é o contrato do C5: sem ela não dá para provar O QUE foi aceito.
  assert.match(String(afterFirst[0]?.version), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(afterFirst[0]?.acceptedAt instanceof Date);
  assert.ok(afterFirst[0]?.ip, "o IP de quem aceitou fica registrado");

  await login({ sub: "sub-consent" });
  const afterSecond = await db
    .select()
    .from(consents)
    .where(eq(consents.userId, first.user.id));
  assert.equal(afterSecond.length, 1, "voltar a entrar não é aceitar de novo");
  assert.deepEqual(afterSecond[0]?.acceptedAt, afterFirst[0]?.acceptedAt);
});

// ─── β2: porta de idade ─────────────────────────────────────────────────────

/**
 * A conta nova nasce SEM ano — o Google não devolve idade e não vamos pedir a
 * ele. Enquanto ela não responder, o app inteiro fica fechado; o que abre é a
 * própria porta e a rota que diz que ela existe.
 */
const como = (userId: string) => ({ authorization: `Bearer ${signAccess(userId)}` });

const responderIdade = (userId: string, birthYear: number) =>
  app.inject({
    method: "POST",
    url: "/v1/auth/age",
    headers: como(userId),
    payload: { birthYear },
  });

test("β2 — conta sem ano não usa o app, mas enxerga a própria porta", async () => {
  const { user, refresh: token } = await loginNative("sub-porta-fechada");

  const fechada = await app.inject({
    method: "GET",
    url: "/v1/feed",
    headers: como(user.id),
  });
  assert.equal(fechada.statusCode, 403, "sem ano, rota autenticada é 403");

  const eu = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: como(user.id),
  });
  assert.equal(eu.statusCode, 200, "/me responde com a porta fechada");
  assert.equal(sessionUser.parse(eu.json()).needsAgeGate, true);

  // Sair tem que continuar possível com a porta fechada: uma conta que não pode
  // nem se deslogar ficaria presa na única tela que ela enxerga.
  const saiu = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    payload: { refresh: token },
  });
  assert.equal(saiu.statusCode, 204, "logout não passa pela porta de idade");
  assert.equal((await refresh(token)).statusCode, 401, "e revogou de verdade");
});

test("β2 — maior de idade passa a porta da idade, e para na do handle", async () => {
  const { user } = await loginNative("sub-porta-abre");

  const res = await responderIdade(user.id, new Date().getFullYear() - 30);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, minAge: MIN_AGE });

  // β8 mudou o que vem DEPOIS da idade: o app não abre direto, abre a segunda
  // porta. Quem prova que ela também abre é o teste do β8 mais abaixo.
  const aberta = await app.inject({
    method: "GET",
    url: "/v1/feed",
    headers: como(user.id),
  });
  assert.equal(aberta.statusCode, 403, "com ano gravado sobra a porta do handle");

  const eu = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: como(user.id),
  });
  const sessao = sessionUser.parse(eu.json());
  assert.equal(sessao.needsAgeGate, false);
  assert.equal(sessao.needsHandle, true, "a porta que sobrou é a do handle");
});

test("β2 — menor não entra, e a conta some inteira do banco", async () => {
  const { user, refresh: token } = await loginNative("sub-menor");

  const res = await responderIdade(user.id, new Date().getFullYear() - (MIN_AGE - 1));
  assert.equal(res.statusCode, 200, "a porta avaliou; o veredito está no corpo");
  assert.deepEqual(res.json(), { ok: false, minAge: MIN_AGE });

  // Não é "o ano não foi gravado": é a conta inteira que não existe mais. O
  // login do Google tinha gravado nome, e-mail e avatar, e nada disso é dado
  // que se guarde de alguém que acabou de declarar ter menos de MIN_AGE.
  const sobrou = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, user.id));
  assert.deepEqual(sobrou, [], "recusa apaga a conta, não só o ano");

  for (const [nome, tabela, coluna] of [
    ["identities", identities, identities.userId],
    ["sessions", sessions, sessions.userId],
    ["consents", consents, consents.userId],
  ] as const) {
    const linhas = await db.select().from(tabela).where(eq(coluna, user.id));
    assert.deepEqual(linhas, [], `${nome} devia ter ido junto pela cascata`);
  }

  // O access em circulação ainda vale por até 15 min. Sem dono, ele é 401 e não
  // 403: não falta responder a porta, falta a conta.
  const ainda = await app.inject({
    method: "GET",
    url: "/v1/feed",
    headers: como(user.id),
  });
  assert.equal(ainda.statusCode, 401, "token de conta apagada não autentica");

  assert.equal((await refresh(token)).statusCode, 401, "a sessão foi revogada");
});

test("β2 — conta que já usou o app não é apagada por um ano errado", async () => {
  const { user, refresh: token } = await loginNative("sub-anterior-ao-beta2");

  // Uma conta anterior ao β2: `birth_year` nulo, mas com uso de verdade dentro.
  // É o caso que transforma a recusa em arma se ela apagar sem olhar.
  const [titulo] = await db.select({ id: titles.id }).from(titles).limit(1);
  assert.ok(titulo, "o banco precisa estar semeado (npm run seed)");
  await db.insert(swipes).values({ userId: user.id, titleId: titulo.id, direction: 1 });

  const res = await responderIdade(user.id, new Date().getFullYear() - (MIN_AGE - 1));
  assert.deepEqual(res.json(), { ok: false, minAge: MIN_AGE });

  const [linha] = await db
    .select({ birthYear: users.birthYear })
    .from(users)
    .where(eq(users.id, user.id));
  assert.ok(linha, "conta com uso dentro NÃO é apagada");
  assert.equal(linha.birthYear, null, "e o ano de menor continua sem ser gravado");

  const meus = await db.select().from(swipes).where(eq(swipes.userId, user.id));
  assert.equal(meus.length, 1, "o que ela tinha continua lá");

  // Fica de fora do app, e não some: responder um ano válido a traz de volta.
  const ainda = await app.inject({
    method: "GET",
    url: "/v1/feed",
    headers: como(user.id),
  });
  assert.equal(ainda.statusCode, 403, "sem ano válido, segue sem app");
  assert.equal((await refresh(token)).statusCode, 401, "a sessão foi revogada");
});

/**
 * β9.6 fechou a sobra no `DELETE /v1/me`. Esta é a mesma regra na outra porta.
 *
 * O aviso de match do amigo é linha DELE, e guarda uma cópia do meu handle no
 * payload (`friends.ts` grava assim de propósito, para a tela não fazer um
 * fetch por linha). Nenhuma FK aponta daqui para mim, então a cascata passa
 * longe: quem varre tem que ser quem apaga — nas DUAS portas, senão a recusa da
 * idade apaga a conta e deixa o handle dela na tela de outra pessoa.
 *
 * Zero swipe não quer dizer zero catálogo: `PUT /v1/library/:titleId` grava
 * `library_entries` sem gravar swipe, e é de `library_entries` que sai o match
 * que gera o aviso. A sobra é alcançável, não é só teórica.
 */
async function avisosSobre(id: string): Promise<number> {
  const rows = (await db.execute(
    sql`select count(*) as n from notifications where payload->>'friendId' = ${id}`,
  )) as unknown as Record<string, unknown>[];
  return Number(rows[0]!["n"]);
}

/** Um amigo com dois avisos: um que cita `userId` no payload e um que não. */
async function amigoQueGuardaOHandle(userId: string, handle: string) {
  const { user: amigo } = await loginNative(`sub-amigo-de-${handle}`);
  await db.insert(notifications).values([
    {
      userId: amigo.id,
      type: "friend_matches",
      payload: { friendId: userId, friendHandle: handle, count: 3 },
    },
    { userId: amigo.id, type: "match", payload: { titleId: null } },
  ]);
  return amigo;
}

test("β2 — a recusa que apaga a conta varre o aviso que guarda o handle dela", async () => {
  const { user } = await loginNative("sub-menor-com-aviso");
  const amigo = await amigoQueGuardaOHandle(user.id, "menor-com-aviso");
  assert.equal(await avisosSobre(user.id), 1, "o aviso do amigo existe antes");

  const res = await responderIdade(user.id, new Date().getFullYear() - (MIN_AGE - 1));
  assert.deepEqual(res.json(), { ok: false, minAge: MIN_AGE });

  const sobrou = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
  assert.deepEqual(sobrou, [], "conta sem swipe é apagada");
  assert.equal(await avisosSobre(user.id), 0, "e o handle dela não fica no aviso de ninguém");

  // A varredura é pelo payload, não pelo dono da linha: o amigo continua de pé
  // e o aviso dele que não cita ninguém continua lá.
  const dele = await db.select().from(notifications).where(eq(notifications.userId, amigo.id));
  assert.equal(dele.length, 1, "só o aviso que citava o apagado saiu");
});

test("β2 — a recusa que NÃO apaga não varre aviso nenhum", async () => {
  const { user } = await loginNative("sub-menor-que-usou-com-aviso");

  const [titulo] = await db.select({ id: titles.id }).from(titles).limit(1);
  assert.ok(titulo, "o banco precisa estar semeado (npm run seed)");
  await db.insert(swipes).values({ userId: user.id, titleId: titulo.id, direction: 1 });
  await amigoQueGuardaOHandle(user.id, "usou-com-aviso");

  const res = await responderIdade(user.id, new Date().getFullYear() - (MIN_AGE - 1));
  assert.deepEqual(res.json(), { ok: false, minAge: MIN_AGE });

  const [linha] = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
  assert.ok(linha, "conta com uso dentro NÃO é apagada");

  // O par da asserção de cima, e o lado que é fácil perder: sem apagar não há o
  // que varrer. Varrer assim mesmo destruiria o aviso de quem continua amigo.
  assert.equal(await avisosSobre(user.id), 1, "o aviso do amigo continua de pé");
});

/**
 * O caso que "zero swipes" não enxergava. A conta fez o que o app pede, depois
 * desfez o swipe (A7): a linha de `swipes` some, a de `library_entries` fica, e
 * ela chega na porta de idade parecendo recém-nascida. Um 2015 no lugar de 1995
 * apagava tudo dela sem confirmação — que é exatamente o que o comentário do
 * `recusar` promete que não acontece.
 */
test("β2 — conta que desfez o swipe não é apagada: o catálogo dela continua lá", async () => {
  const { user } = await loginNative("sub-desfez-o-swipe");
  const [titulo] = await db.select({ id: titles.id }).from(titles).limit(1);
  assert.ok(titulo, "o banco precisa estar semeado (npm run seed)");

  // Passa a porta de idade e a do handle: é conta de gente, não conta nova.
  await db
    .update(users)
    .set({ birthYear: new Date().getFullYear() - 30, handleChosen: true })
    .where(eq(users.id, user.id));

  const swipou = await app.inject({
    method: "POST",
    url: "/v1/swipes",
    headers: como(user.id),
    payload: [{ titleId: titulo.id, direction: 1, clientTs: new Date().toISOString() }],
  });
  assert.equal(swipou.statusCode, 200, swipou.body);

  const desfez = await app.inject({
    method: "DELETE",
    url: `/v1/swipes/${titulo.id}`,
    headers: como(user.id),
  });
  assert.equal(desfez.statusCode, 204, "o undo apagou o swipe");
  const meus = await db.select().from(swipes).where(eq(swipes.userId, user.id));
  assert.deepEqual(meus, [], "e agora ela tem zero swipes");

  const noCatalogo = await db
    .select({ titleId: libraryEntries.titleId })
    .from(libraryEntries)
    .where(eq(libraryEntries.userId, user.id));
  assert.equal(noCatalogo.length, 1, "mas o catálogo que o like criou continua");

  const res = await responderIdade(user.id, new Date().getFullYear() - (MIN_AGE - 1));
  assert.deepEqual(res.json(), { ok: false, minAge: MIN_AGE });

  const [linha] = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
  assert.ok(linha, "zero swipes NÃO basta para apagar: ela tem coisa dentro");
});

/** A amizade sozinha também conta: é relação de outra pessoa, não só minha. */
test("β2 — conta com amizade e mais nada também não é apagada", async () => {
  const { user } = await loginNative("sub-so-amizade");
  const { user: amigo } = await loginNative("sub-so-amizade-do-outro");
  const [a, b] = [user.id, amigo.id].sort() as [string, string];

  await db
    .insert(friendships)
    .values({ userA: a, userB: b, requestedBy: a, status: "accepted" });

  const res = await responderIdade(user.id, new Date().getFullYear() - (MIN_AGE - 1));
  assert.deepEqual(res.json(), { ok: false, minAge: MIN_AGE });

  const [linha] = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
  assert.ok(linha, "amizade é coisa dentro");
});

test("β2 — a porta se responde uma vez só", async () => {
  const { user } = await loginNative("sub-porta-uma-vez");
  const anoOk = new Date().getFullYear() - 30;
  assert.equal((await responderIdade(user.id, anoOk)).statusCode, 200);

  // Segunda resposta é aceita pelo contrato, mas não reescreve a coluna: a
  // idade gravada é a que abriu a porta, não a última que alguém mandou.
  const depois = await responderIdade(user.id, new Date().getFullYear() - 50);
  assert.deepEqual(depois.json(), { ok: true, minAge: MIN_AGE });

  const [linha] = await db
    .select({ birthYear: users.birthYear })
    .from(users)
    .where(eq(users.id, user.id));
  assert.equal(linha?.birthYear, anoOk);
});

test("β2 — ano fora do formato é 400, não 500", async () => {
  const { user } = await loginNative("sub-ano-invalido");
  for (const birthYear of ["mil novecentos", 1899, new Date().getFullYear() + 1, 19.5]) {
    const res = await responderIdade(user.id, birthYear as number);
    assert.equal(res.statusCode, 400, `${birthYear} devia ser 400`);
  }
});

// ─── β8: o handle é escolhido, não derivado do e-mail ───────────────────────

/**
 * O defeito que o β8 fecha: `handleSeed` montava o handle com
 * `email.split("@")[0]`, e o perfil público publica o handle em `/u/<handle>`.
 * Quem lia o handle deduzia o e-mail — no caso comum, `@gmail.com` completa o
 * resto.
 *
 * Handle de teste sorteado: os arquivos de teste rodam em paralelo no mesmo
 * banco, e um handle fixo colidiria com a rodada do vizinho.
 */
const novoHandle = () => `t${randomBytes(4).toString("hex")}`;

/** Conta com a porta da idade já respondida — só a do handle fica de pé. */
async function contaComIdade(sub: string) {
  const { user, refresh: token } = await loginNative(sub);
  const res = await responderIdade(user.id, new Date().getFullYear() - 30);
  assert.equal(res.statusCode, 200, res.body);
  return { user, refresh: token };
}

const escolherHandle = (userId: string, handle: unknown) =>
  app.inject({
    method: "POST",
    url: "/v1/auth/handle",
    headers: como(userId),
    payload: { handle },
  });

const disponibilidade = (userId: string, handle: string, ip = freshIp()) =>
  app.inject({
    method: "GET",
    url: `/v1/auth/handle/available?handle=${encodeURIComponent(handle)}`,
    headers: { ...como(userId), "cf-connecting-ip": ip },
  });

test("β8 — o handle do login não sai do e-mail nem do nome", async () => {
  const res = await login({ sub: "sub-handle-neutro", email: "ana.silva@gmail.com" });
  const { user } = authResponse.parse(res.json());
  created.push(user.id);

  // O local-part inteiro, e cada pedaço dele: era assim que o e-mail vazava.
  for (const vazamento of ["ana.silva", "anasilva", "ana", "silva", "gmail"]) {
    assert.ok(
      !user.handle.includes(vazamento),
      `"${vazamento}" não pode aparecer em ${user.handle}`,
    );
  }
  // displayName do Google é o nome civil da pessoa, e também não entra.
  assert.ok(!user.handle.includes("test"), `nome do provedor em ${user.handle}`);

  // E o que sobra continua sendo um handle válido pelas regras do contrato:
  // quem abandonar o fluxo fica com um que a validação aceita.
  assert.match(user.handle, handleRegex);
  assert.equal(sessionUser.parse(user).needsHandle, true, "gerado não é escolhido");

  // E-mail continua guardado na conta: ele é informativo, o que mudou é que
  // ele não é mais publicado como handle.
  const [linha] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, user.id));
  assert.equal(linha?.email, "ana.silva@gmail.com");
});

test("β8 — dois logins seguidos não sorteiam o mesmo handle", async () => {
  const a = authResponse.parse((await login({ sub: "sub-sorteio-a" })).json());
  const b = authResponse.parse((await login({ sub: "sub-sorteio-b" })).json());
  created.push(a.user.id, b.user.id);
  assert.notEqual(a.user.handle, b.user.handle);
});

test("β8 — sem handle escolhido não usa o app, mas enxerga a própria porta", async () => {
  const { user, refresh: token } = await contaComIdade("sub-handle-fechado");

  const fechada = await app.inject({
    method: "GET",
    url: "/v1/feed",
    headers: como(user.id),
  });
  assert.equal(fechada.statusCode, 403, "sem handle escolhido, rota autenticada é 403");

  const eu = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: como(user.id),
  });
  assert.equal(eu.statusCode, 200, "/me responde com a porta fechada");
  assert.equal(sessionUser.parse(eu.json()).needsHandle, true);

  // A rota de disponibilidade é o apoio da tela de escolha: fechá-la deixaria
  // a pessoa escolhendo às cegas dentro da única tela que ela enxerga.
  assert.equal((await disponibilidade(user.id, novoHandle())).statusCode, 200);

  // E sair continua possível, pelo mesmo motivo do β2.
  const saiu = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    payload: { refresh: token },
  });
  assert.equal(saiu.statusCode, 204, "logout não passa pela porta do handle");
});

test("β8 — escolher abre o app e devolve a sessão já sem a porta", async () => {
  const { user } = await contaComIdade("sub-handle-escolhe");
  const handle = novoHandle();

  const res = await escolherHandle(user.id, handle);
  assert.equal(res.statusCode, 200, res.body);
  const sessao = sessionUser.parse(res.json());
  assert.equal(sessao.handle, handle);
  assert.equal(sessao.needsHandle, false, "a resposta já serve para sair da tela");

  const aberta = await app.inject({
    method: "GET",
    url: "/v1/feed",
    headers: como(user.id),
  });
  assert.equal(aberta.statusCode, 200, "com as duas portas abertas o feed responde");

  const [linha] = await db
    .select({ handle: users.handle, handleChosen: users.handleChosen })
    .from(users)
    .where(eq(users.id, user.id));
  assert.equal(linha?.handle, handle);
  assert.equal(linha?.handleChosen, true);
});

test("β8 — o handle se escolhe uma vez só", async () => {
  const { user } = await contaComIdade("sub-handle-uma-vez");
  const primeiro = novoHandle();
  assert.equal((await escolherHandle(user.id, primeiro)).statusCode, 200);

  // Trocar quebraria `/u/<handle>` já compartilhado e liberaria o antigo para
  // outra pessoa ocupar. Não é 200 silencioso: quem pediu precisa saber.
  const segundo = await escolherHandle(user.id, novoHandle());
  assert.equal(segundo.statusCode, 409, segundo.body);

  const [linha] = await db
    .select({ handle: users.handle })
    .from(users)
    .where(eq(users.id, user.id));
  assert.equal(linha?.handle, primeiro, "o handle gravado é o primeiro");
});

test("β8 — handle tomado é recusado ignorando caixa", async () => {
  const dona = await contaComIdade("sub-handle-dona");
  const outra = await contaComIdade("sub-handle-outra");
  const handle = novoHandle();

  assert.equal((await escolherHandle(dona.user.id, handle)).statusCode, 200);

  // @Ana e @ana não podem ser duas contas: a busca compara em lower e passaria
  // a ter duas respostas certas, inclusive a do perfil público.
  const res = await escolherHandle(outra.user.id, handle.toUpperCase());
  assert.equal(res.statusCode, 409, res.body);

  const eu = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: como(outra.user.id),
  });
  assert.equal(
    sessionUser.parse(eu.json()).needsHandle,
    true,
    "quem perdeu continua devendo a escolha",
  );
});

test("β8 — duas contas pedindo o mesmo handle ao mesmo tempo: uma só ganha", async () => {
  const a = await contaComIdade("sub-handle-corrida-a");
  const b = await contaComIdade("sub-handle-corrida-b");
  const handle = novoHandle();

  // A corrida se resolve no índice único, não numa consulta prévia: entre o
  // "está livre" e o UPDATE cabe a escrita da outra conta.
  const [ra, rb] = await Promise.all([
    escolherHandle(a.user.id, handle),
    escolherHandle(b.user.id, handle),
  ]);

  const codigos = [ra.statusCode, rb.statusCode].sort();
  assert.deepEqual(codigos, [200, 409], `${ra.body} | ${rb.body}`);

  const donos = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.handle}) = ${handle}`);
  assert.equal(donos.length, 1, "um dono, e o banco é quem decidiu qual");
});

test("β8 — formato inválido e reservado são 400, não 500", async () => {
  const { user } = await contaComIdade("sub-handle-invalido");

  for (const handle of ["ab", "1abc", "Ana!", "a".repeat(21), "com espaço", 42, null]) {
    const res = await escolherHandle(user.id, handle);
    assert.equal(res.statusCode, 400, `${String(handle)} devia ser 400`);
  }

  // Reservado colide com rota (`/u`, `/me`) ou induz a erro sobre quem fala.
  for (const handle of ["admin", "support", "api"]) {
    assert.equal((await escolherHandle(user.id, handle)).statusCode, 400, handle);
  }

  const eu = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: como(user.id),
  });
  assert.equal(sessionUser.parse(eu.json()).needsHandle, true, "nada foi gravado");
});

test("β8 — disponibilidade: livre, tomado e reservado", async () => {
  const { user } = await contaComIdade("sub-handle-disponivel");
  const handle = novoHandle();

  const livre = await disponibilidade(user.id, handle);
  assert.equal(livre.statusCode, 200, livre.body);
  assert.deepEqual(livre.json(), { handle, available: true });

  assert.equal((await escolherHandle(user.id, handle)).statusCode, 200);

  const tomado = await disponibilidade(user.id, handle.toUpperCase());
  assert.deepEqual(
    tomado.json(),
    { handle, available: false },
    "tomado ignorando caixa, e o eco volta normalizado",
  );

  // Reservado devolve o MESMO `available: false` de tomado: distinguir não
  // ajuda quem escolhe e entrega de graça a lista de reservados.
  const reservado = await disponibilidade(user.id, "admin");
  assert.deepEqual(reservado.json(), { handle: "admin", available: false });

  // Formato errado é erro de quem chamou, e aí sim tem resposta própria.
  for (const ruim of ["ab", "1abc", "Ana!"]) {
    assert.equal((await disponibilidade(user.id, ruim)).statusCode, 400, ruim);
  }
});

test("β8 — disponibilidade é limitada por IP: é oráculo de enumeração", async () => {
  const { user } = await contaComIdade("sub-handle-enumera");
  const ip = freshIp();

  let last = 0;
  for (let i = 0; i < 21; i++) {
    last = (await disponibilidade(user.id, novoHandle(), ip)).statusCode;
    if (i < 20) assert.equal(last, 200, `requisição ${i + 1} ainda dentro do teto`);
  }
  assert.equal(last, 429, "a 21ª do mesmo IP é barrada");

  assert.equal(
    (await disponibilidade(user.id, novoHandle())).statusCode,
    200,
    "outro IP não paga pelo vizinho",
  );
});

test("β8 — a ordem das portas: idade primeiro, handle depois", async () => {
  // Conta recém-criada: sem ano e sem handle escolhido. Pedir handle agora
  // seria pedir escolha a uma conta que a porta seguinte pode apagar.
  const { user } = await loginNative("sub-handle-ordem");

  const escolha = await escolherHandle(user.id, novoHandle());
  assert.equal(escolha.statusCode, 403, "a porta da idade responde antes");

  assert.equal(
    (await disponibilidade(user.id, novoHandle())).statusCode,
    403,
    "e a de disponibilidade junto",
  );

  // Respondida a idade, a porta do handle passa a ser a que responde.
  assert.equal((await responderIdade(user.id, new Date().getFullYear() - 30)).statusCode, 200);
  assert.equal((await escolherHandle(user.id, novoHandle())).statusCode, 200);
});

test("β8 — sem token não se escolhe handle nem se consulta disponibilidade", async () => {
  for (const url of ["/v1/auth/handle", "/v1/auth/handle/available?handle=qualquer"]) {
    const res = await app.inject({
      method: url.includes("available") ? "GET" : "POST",
      url,
      payload: { handle: "qualquer" },
    });
    assert.equal(res.statusCode, 401, url);
  }
});
