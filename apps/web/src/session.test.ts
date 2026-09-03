import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { auth, getUser, setAccessToken, setUser, subscribeUser } from "./session.ts";

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
