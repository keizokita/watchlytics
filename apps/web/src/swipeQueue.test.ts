import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

/**
 * O cenário do modo avião: swipar offline, voltar a rede, tudo chega.
 *
 * Esta fila é o único ponto do cliente onde um swipe pode sumir sem ninguém
 * perceber — o card já saiu da tela quando a rede falha. Daí o teste.
 */
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

let online = true;
let received: unknown[][] = [];
let headers: Record<string, string>[] = [];
const spy = (async (
  _url: string,
  init: { body: string; headers: Record<string, string> },
) => {
  if (!online) throw new TypeError("fetch failed");
  received.push(JSON.parse(init.body));
  headers.push(init.headers);
  return { ok: true, status: 200 };
}) as unknown as typeof fetch;
globalThis.fetch = spy;

const { enqueue, flush, drop, pendingCount } = await import("./swipeQueue.ts");
const { setAccessToken } = await import("./session.ts");

const swipe = (n: number, direction: 1 | -1 = 1) => ({
  titleId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  direction,
  clientTs: new Date(1700000000000 + n).toISOString(),
});

beforeEach(() => {
  store.clear();
  received = [];
  headers = [];
  online = true;
  // Há testes que trocam o fetch para simular 503; sem isto o spy fica perdido
  // e os testes seguintes observam um mock que não registra nada.
  globalThis.fetch = spy;
  setAccessToken(null);
});

test("offline acumula, online entrega tudo", async () => {
  online = false;
  for (let n = 1; n <= 10; n++) enqueue(swipe(n));
  await flush();
  assert.equal(received.length, 0, "nada saiu enquanto offline");
  assert.equal(pendingCount(), 10, "os 10 continuam na fila");

  online = true;
  await flush();
  assert.equal(received.flat().length, 10, "os 10 chegam ao voltar a rede");
  assert.equal(pendingCount(), 0, "fila esvazia após confirmação");
});

test("falha do servidor não descarta a fila", async () => {
  globalThis.fetch = (async () => ({ ok: false, status: 503 })) as never;
  enqueue(swipe(1));
  await flush();
  assert.equal(pendingCount(), 1, "503 mantém o swipe na fila");

  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    received.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  }) as never;
  await flush();
  assert.equal(pendingCount(), 0);
});

test("mesma decisão do título é substituída, não duplicada", () => {
  enqueue(swipe(1, -1));
  enqueue(swipe(1, 1));
  assert.equal(pendingCount(), 1, "uma entrada por título");
});

test("drop remove da fila antes do envio (undo sem rede)", () => {
  enqueue(swipe(1));
  assert.equal(drop(swipe(1).titleId), true, "estava na fila");
  assert.equal(pendingCount(), 0);
  assert.equal(drop(swipe(1).titleId), false, "já tinha ido: undo precisa do DELETE");
});

test("fila corrompida no storage é descartada, não propagada", () => {
  store.set("watchlytics.pending-swipes", "{ isto não é json válido");
  assert.equal(pendingCount(), 0);
});

/**
 * Em produção não existe o shim do C1: sem este header o lote inteiro leva 401
 * e a fila retenta para sempre, em silêncio, com o card já fora da tela.
 */
test("o lote viaja com a sessão quando há login", async () => {
  setAccessToken("tok-123");
  enqueue(swipe(1));
  await flush();
  assert.equal(headers[0]?.["authorization"], "Bearer tok-123");
});

test("sem login o lote vai sem Authorization, não com um header vazio", async () => {
  enqueue(swipe(1));
  await flush();
  assert.ok(headers.every((h) => h["authorization"] === undefined));
});
