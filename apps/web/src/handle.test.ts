import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { HANDLE_RESERVED } from "@watchlytics/contract";
import {
  checarDisponibilidade,
  escolherHandle,
  normalizar,
  validar,
} from "./handle.ts";
import { setAccessToken } from "./session.ts";

beforeEach(() => {
  setAccessToken("tok");
  // A consulta manda o detalhe da falha para o console de propósito; aqui ele
  // só sujaria a saída do `node --test`.
  console.warn = () => {};
});

/** Registra o que saiu para a rede, para provar o que NÃO saiu. */
function stub(reply: () => Response) {
  const chamadas: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    chamadas.push({
      url: String(url),
      body: init.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return reply();
  }) as unknown as typeof fetch;
  return chamadas;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/**
 * A sessão como a rota a devolve: `POST /v1/auth/handle` responde o
 * `sessionUser` inteiro, com a porta já fechada.
 */
const sessao = (handle: string) => ({
  id: "00000000-0000-4000-8000-000000000001",
  handle,
  displayName: "Quem escolheu",
  avatarUrl: null,
  isPublic: false,
  needsAgeGate: false,
  needsHandle: false,
});

// ─── o que a tela julga a cada tecla ────────────────────────────────────────

/**
 * O meio de uma palavra não é erro. Esta é a diferença entre um campo que
 * ajuda e um que pisca vermelho na primeira letra.
 */
test("o que ainda está sendo digitado não é acusado de errado", () => {
  for (const parcial of ["", "k", "ke", "a_"]) {
    assert.deepEqual(validar(parcial), { kind: "short" }, `"${parcial}"`);
  }
});

test("o que já está errado é acusado na primeira tecla, não no envio", () => {
  // Começar com dígito ou `_` está errado desde o começo: digitar mais não
  // conserta, então esperar completar 3 caracteres seria esconder a resposta.
  for (const ruim of ["1k", "_k", "1", "-"]) {
    assert.deepEqual(validar(ruim), { kind: "invalid" }, `"${ruim}"`);
  }
});

test("caractere fora da regra reprova, com tamanho ou sem", () => {
  for (const ruim of ["keizo kita", "keizo-kita", "keizo.kita", "keizoKitá", "1keizo"]) {
    assert.deepEqual(validar(ruim), { kind: "invalid" }, `"${ruim}"`);
  }
});

test("acima de 20 caracteres reprova — o contrato fecha em 20", () => {
  assert.deepEqual(validar("a".repeat(20)), { kind: "ok", handle: "a".repeat(20) });
  assert.deepEqual(validar("a".repeat(21)), { kind: "invalid" });
});

/**
 * Maiúscula e `@` são o gesto de quem cola um handle de outro lugar. Corrigir
 * é melhor do que acusar: o contrato grava minúsculo de qualquer jeito.
 */
test("maiúscula, espaço e @ colado viram o handle, não erro", () => {
  assert.equal(normalizar("  @KeizoKita "), "keizokita");
  assert.deepEqual(validar("@Keizo_Kita"), { kind: "ok", handle: "keizo_kita" });
});

/**
 * Reservado é decidido no cliente porque a lista VEM do contrato — não custa
 * requisição e não vaza nada que já não esteja no bundle. E sai como
 * "indisponível", não como "inválido": para quem escolhe, `admin` e um handle
 * já tomado são o mesmo problema, que é o que a rota também responde.
 */
test("reservado é indisponível, e não gasta requisição", () => {
  const chamadas = stub(() => json({ handle: "admin", available: true }));
  for (const nome of HANDLE_RESERVED) {
    if (nome.length < 3) continue; // "u" e "me" reprovam antes, por tamanho
    assert.deepEqual(validar(nome), { kind: "unavailable" }, nome);
  }
  assert.deepEqual(chamadas, []);
});

// ─── a consulta de disponibilidade ──────────────────────────────────────────

test("a consulta manda o handle na query e lê o contrato", async () => {
  const chamadas = stub(() => json({ handle: "keizo", available: true }));
  assert.equal(await checarDisponibilidade("keizo"), "livre");
  assert.equal(chamadas[0]?.url, "/v1/auth/handle/available?handle=keizo");

  stub(() => json({ handle: "keizo", available: false }));
  assert.equal(await checarDisponibilidade("keizo"), "ocupado");
});

/**
 * Um 404 é a rota não estar lá — web publicado à frente da api, proxy errado,
 * caminho renomeado. Ler isso como "ocupado" mandaria a pessoa trocar de handle
 * por causa de um problema de implantação, e ela não pode trocar depois.
 */
test("rota ausente não vira handle ocupado", async () => {
  stub(() => json({ error: "not found" }, 404));
  assert.equal(await checarDisponibilidade("keizo"), "desconhecido");
});

/**
 * O rate limit da trilha A é o motivo de existir debounce. Quando ele disparar
 * mesmo assim, a resposta é calar — não acusar o handle.
 */
test("rate limit, erro de servidor e rede caída também calam", async () => {
  for (const status of [429, 500, 503]) {
    stub(() => json({ error: "no" }, status));
    assert.equal(await checarDisponibilidade("keizo"), "desconhecido", String(status));
  }

  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
  assert.equal(await checarDisponibilidade("keizo"), "desconhecido");
});

test("resposta fora do contrato cala, e não vira veredito", async () => {
  stub(() => json({ handle: "keizo" }));
  assert.equal(await checarDisponibilidade("keizo"), "desconhecido");
});

// ─── o envio, que é definitivo ──────────────────────────────────────────────

test("o envio manda o handle normalizado, e só ele", async () => {
  const chamadas = stub(() => json(sessao("keizokita")));

  assert.deepEqual(await escolherHandle("  @KeizoKita "), {
    kind: "ok",
    user: sessao("keizokita"),
  });
  assert.deepEqual(chamadas, [
    { url: "/v1/auth/handle", body: { handle: "keizokita" } },
  ]);
});

/**
 * A sessão que volta para a tela é a do SERVIDOR, e não uma remontada aqui:
 * quem sabe o que ficou gravado é quem gravou. Se a api normalizar diferente
 * do cliente, é a dela que vale — e `needsHandle` fechado vem junto, que é o
 * que tira a porta da tela.
 */
test("o envio devolve a sessão que a api mandou, não uma remontada", async () => {
  stub(() => json({ ...sessao("outro_handle"), displayName: "Nome do servidor" }));

  const r = await escolherHandle("keizokita");
  assert.equal(r.kind, "ok");
  assert.equal(r.kind === "ok" && r.user.handle, "outro_handle");
  assert.equal(r.kind === "ok" && r.user.displayName, "Nome do servidor");
  assert.equal(r.kind === "ok" && r.user.needsHandle, false);
});

/** Resposta fora do contrato lança: sessão pela metade é pior que erro. */
test("resposta do envio fora do contrato lança", async () => {
  stub(() => json({ ok: true }));
  await assert.rejects(escolherHandle("keizokita"));
});

/** Duas pessoas escolhendo o mesmo handle no mesmo segundo: quem decide é o POST. */
test("409 é o handle tomado entre a consulta e o envio", async () => {
  stub(() => json({ error: "taken" }, 409));
  assert.deepEqual(await escolherHandle("keizo"), { kind: "taken" });
});

/**
 * No envio o 404 LANÇA em vez de virar desfecho: a tela pinta erro genérico e
 * mantém o formulário. Vira "esse handle não serve" e a pessoa troca de handle
 * por causa de uma rota ausente — e não há troca depois.
 */
test("no envio, a rota ausente lança e não vira recusa do handle", async () => {
  stub(() => json({ error: "not found" }, 404));
  await assert.rejects(escolherHandle("keizo"), /respondeu 404/);

  stub(() => json({ error: "boom" }, 500));
  await assert.rejects(escolherHandle("keizo"), /respondeu 500/);
});

test("o que o contrato reprova não chega a sair do dispositivo", async () => {
  const chamadas = stub(() => json(sessao("keizokita")));
  assert.deepEqual(await escolherHandle("1keizo"), { kind: "invalid" });
  assert.deepEqual(await escolherHandle("admin"), { kind: "invalid" });
  assert.deepEqual(chamadas, []);
});
