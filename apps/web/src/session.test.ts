import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  auth,
  authedFetch,
  getAccessToken,
  getUser,
  setAccessToken,
  setUser,
  subscribeUser,
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
