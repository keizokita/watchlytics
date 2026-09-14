import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  auth,
  authedFetch,
  getAccessToken,
  getUser,
  refreshAccess,
  resume,
  setAccessToken,
  setUser,
  subscribeUser,
  type Refresh,
} from "./session.ts";

beforeEach(() => {
  setAccessToken(null);
});

/**
 * O shell decide o que montar por este valor. Se ele nascer `null` em vez de
 * `undefined`, quem já tem sessão vê a tela de entrada piscar a cada carga —
 * e pior, o app monta como deslogado antes do refresh responder.
 */
test("a sessão nasce indefinida, não deslogada", () => {
  assert.equal(getUser(), undefined);
});

test("assinantes são avisados quando a sessão muda", () => {
  let avisos = 0;
  const unsubscribe = subscribeUser(() => void avisos++);

  setUser({ id: "u1", handle: "keizo" } as never);
  assert.equal(avisos, 1);
  assert.equal(getUser()?.handle, "keizo");

  setUser(null);
  assert.equal(avisos, 2);
  assert.equal(getUser(), null);

  unsubscribe();
  setUser(null);
  assert.equal(avisos, 2, "depois de cancelar, ninguém mais é avisado");
});

test("auth() só manda header quando há token", () => {
  assert.deepEqual(auth(), {});
  setAccessToken("tok-1");
  assert.deepEqual(auth(), { authorization: "Bearer tok-1" });
});

/**
 * O access dura 15 minutos e antes disto só era renovado na carga da página:
 * os 20 swipes do onboarding passam desse tempo, e o 401 seguinte virava erro
 * fatal com a sessão ainda válida no cookie.
 *
 * O par de casos que importa é (1) renovar e repetir e (2) renovar UMA vez só
 * para N requisições simultâneas — o refresh é rotacionado e reuso revoga a
 * sessão inteira, então um refresh por requisição derrubaria quem ia salvar.
 */
test("401 renova o access e repete a requisição", async () => {
  setAccessToken("velho");
  const enviados: (string | undefined)[] = [];
  let refreshes = 0;

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (url === "/v1/auth/refresh") {
      refreshes++;
      return new Response(JSON.stringify({ access: "novo" }), { status: 200 });
    }
    const sent = new Headers(init.headers).get("authorization") ?? undefined;
    enviados.push(sent);
    return new Response("", { status: sent === "Bearer novo" ? 200 : 401 });
  }) as typeof fetch;

  const res = await authedFetch("/v1/feed");

  assert.equal(res.status, 200);
  assert.equal(refreshes, 1);
  assert.deepEqual(enviados, ["Bearer velho", "Bearer novo"]);
  assert.equal(getAccessToken(), "novo");
});

test("401 simultâneo renova uma vez só, não uma por requisição", async () => {
  setAccessToken("velho");
  let refreshes = 0;

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (url === "/v1/auth/refresh") {
      refreshes++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ access: "novo" }), { status: 200 });
    }
    const sent = new Headers(init.headers).get("authorization");
    return new Response("", { status: sent === "Bearer novo" ? 200 : 401 });
  }) as typeof fetch;

  const todas = await Promise.all([
    authedFetch("/v1/feed"),
    authedFetch("/v1/swipes", { method: "POST" }),
    authedFetch("/v1/notifications"),
  ]);

  assert.deepEqual(todas.map((r) => r.status), [200, 200, 200]);
  assert.equal(refreshes, 1, "um refresh reusado é replay: o servidor revoga a sessão");
});

test("refresh recusado devolve o 401 a quem chamou", async () => {
  setAccessToken("velho");

  globalThis.fetch = (async (url: string) =>
    new Response("", { status: url === "/v1/auth/refresh" ? 401 : 401 })) as typeof fetch;

  const res = await authedFetch("/v1/feed");
  assert.equal(res.status, 401, "sem sessão, o 401 é verdadeiro e a tela de entrada aparece");
});

/**
 * O defeito que estes testes fixam: `refreshAccess` devolvia um booleano, e
 * `false` queria dizer as duas coisas — "você não tem sessão" e "não consigo
 * saber". Só a primeira justifica mandar a pessoa para a tela de entrada, e o
 * `resume()` mandava nas duas.
 *
 * O que torna isto pior que um bug comum é que nada existente pega: quem abre o
 * app sem sessão produz o MESMO 401 nesta rota, então "fui deslogado por
 * engano" e "não tenho sessão" são a mesma tela, o mesmo console e a mesma
 * asserção verde. O `driver.mjs` nem passa por ali, porque planta sessão antes
 * de navegar.
 *
 * Por isso o teste é aqui e com `fetch` trocado: ele não precisa da api fora do
 * ar, nem de cold start, nem de produção. Uma medição de hoje envelhece no
 * próximo deploy; esta asserção, não.
 */

/** Respostas na ordem em que o código pedir. `Error` na lista = falha de rede. */
function fetchFalso(...respostas: (Response | Error)[]) {
  const fila = [...respostas];
  const chamadas: string[] = [];
  globalThis.fetch = ((url: string) => {
    chamadas.push(url);
    const proxima = fila.shift();
    if (proxima === undefined) throw new Error(`fetch inesperado para ${url}`);
    return proxima instanceof Error ? Promise.reject(proxima) : Promise.resolve(proxima);
  }) as typeof fetch;
  return chamadas;
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// `indisponivel()` lê `navigator.onLine` para escolher a frase. No node não há
// navigator com essa propriedade; online é o caso normal e é o que interessa
// aqui — o que está sob teste é QUANDO se lança, não qual frase sobe.
globalThis.navigator ??= { onLine: true } as Navigator;

// ── o que cada resposta do /v1/auth/refresh quer dizer ──────────────────────

const casos: [string, Response | Error, Refresh][] = [
  ["401 é a ÚNICA forma de dizer que não há sessão", json(401), "sem-sessao"],
  ["503: servidor fora do ar não é sessão ausente", json(503), "indisponivel"],
  ["500: idem", json(500), "indisponivel"],
  // O teto por IP é de 20/min (routes/auth.ts:462), e antes disto estourá-lo
  // deslogava. Reproduzido nesta máquina rodando o driver duas vezes seguidas.
  ["429: teto de requisições não é sessão ausente", json(429), "indisponivel"],
  ["400: requisição ruim não diz nada sobre a sessão", json(400), "indisponivel"],
  ["falha de rede não é resposta do servidor", new Error("rede caiu"), "indisponivel"],
  // 200 sem `access` é defeito do servidor. Tratar como "sem sessão"
  // descartaria uma sessão que pode estar boa por causa de um corpo malformado.
  ["200 sem `access` é defeito, não ausência", json(200, { nada: 1 }), "indisponivel"],
];

for (const [nome, resposta, esperado] of casos) {
  test(`refreshAccess — ${nome}`, async () => {
    fetchFalso(resposta);
    assert.equal(await refreshAccess(), esperado);
    assert.equal(getAccessToken(), null, "nenhum destes devia gravar access");
  });
}

test("refreshAccess — 200 com `access` grava o token e diz ok", async () => {
  fetchFalso(json(200, { access: "tok-novo" }));

  assert.equal(await refreshAccess(), "ok");
  assert.equal(getAccessToken(), "tok-novo");
});

// ── e o que o boot faz com cada uma ────────────────────────────────────────

test("resume — 401 no refresh desloga, como sempre", async () => {
  fetchFalso(json(401));
  assert.equal(await resume(), null);
});

test("resume — 503 no refresh NÃO descarta a sessão: lança", async () => {
  const chamadas = fetchFalso(json(503));

  await assert.rejects(() => resume());
  // Não devolver `null` é o conserto inteiro: `null` vira `setUser(null)`, que
  // é a tela de entrada para quem tem sessão válida no cookie.
  assert.deepEqual(chamadas, ["/v1/auth/refresh"], "não devia seguir para o /me");
});

test("resume — 429 no refresh também lança, em vez de deslogar", async () => {
  fetchFalso(json(429));
  await assert.rejects(() => resume());
});

test("resume — 503 no /v1/auth/me lança, mesmo com o refresh tendo dado certo", async () => {
  // A terceira porta do defeito: o refresh funcionou, o access está em mãos, e
  // um 5xx na rota seguinte derrubava a sessão do mesmo jeito.
  fetchFalso(json(200, { access: "tok" }), json(503));

  await assert.rejects(() => resume());
  assert.equal(getAccessToken(), "tok", "o access renovado não devia ser jogado fora");
});

test("resume — 401 no /v1/auth/me desloga: aí o servidor disse", async () => {
  fetchFalso(json(200, { access: "tok" }), json(401), json(401));
  assert.equal(await resume(), null);
});

test("resume — caminho feliz devolve o usuário", async () => {
  const user = {
    id: "9f1c0c2e-0000-4000-8000-000000000001",
    handle: "alguem",
    displayName: "Alguém",
    avatarUrl: null,
    isPublic: false,
    needsAgeGate: false,
    needsHandle: false,
  };
  fetchFalso(json(200, { access: "tok" }), json(200, user));

  assert.deepEqual(await resume(), user);
});

// ── authedFetch: um refresh indisponível não pode virar sessão perdida ──────

test("authedFetch — refresh indisponível devolve o 401 original, sem repetir", async () => {
  setAccessToken("tok-velho");
  const chamadas = fetchFalso(json(401), json(503));

  const res = await authedFetch("/v1/feed");

  assert.equal(res.status, 401);
  assert.deepEqual(chamadas, ["/v1/feed", "/v1/auth/refresh"]);
  assert.equal(getAccessToken(), "tok-velho", "o access não devia ser apagado");
});
