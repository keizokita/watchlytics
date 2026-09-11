import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { MIN_AGE } from "@watchlytics/contract";
import { submitBirthYear } from "./ageGate.ts";
import { setAccessToken } from "./session.ts";

beforeEach(() => {
  setAccessToken("tok");
});

/** Registra o que saiu para a rede, para provar o que NÃO saiu. */
function stub(reply: () => Response) {
  const corpos: unknown[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    corpos.push(JSON.parse(String(init.body)));
    return reply();
  }) as typeof fetch;
  return corpos;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("ano aceito libera a tela", async () => {
  const corpos = stub(() => json({ ok: true, minAge: MIN_AGE }));

  assert.deepEqual(await submitBirthYear("1990"), { kind: "ok" });
  // O ano, e só o ano: dia e mês nunca foram coletados, e o corpo é a prova.
  assert.deepEqual(corpos, [{ birthYear: 1990 }]);
});

/**
 * A recusa vem do SERVIDOR, não de uma conta de idade no cliente: é ele que
 * apaga a sessão e não grava o ano. O cliente só precisa saber qual é o piso
 * para escrever a mensagem.
 */
test("ano recusado devolve o piso que o servidor informou", async () => {
  stub(() => json({ ok: false, minAge: MIN_AGE }));

  assert.deepEqual(await submitBirthYear("2020"), {
    kind: "refused",
    minAge: MIN_AGE,
  });
});

/**
 * Digitação pela metade não é resposta de idade. Se isto fosse para a rede, um
 * "1" viraria recusa — e recusa não tem segunda chance.
 */
test("o que não é ano nem chega a sair do dispositivo", async () => {
  for (const entrada of ["", "  ", "abc", "1", "99", "1899", "3000"]) {
    const corpos = stub(() => json({ ok: true, minAge: MIN_AGE }));
    assert.deepEqual(
      await submitBirthYear(entrada),
      { kind: "invalid" },
      `"${entrada}" deveria reprovar na forma`,
    );
    assert.deepEqual(corpos, [], `"${entrada}" não deveria ir para a rede`);
  }
});

test("o ano do ano que vem reprova: o contrato fecha no ano corrente", async () => {
  const corpos = stub(() => json({ ok: true, minAge: MIN_AGE }));
  const futuro = String(new Date().getFullYear() + 1);

  assert.deepEqual(await submitBirthYear(futuro), { kind: "invalid" });
  assert.deepEqual(corpos, []);
});

/**
 * Falha de rede ou de servidor não é recusa: lança, e a tela mantém o formulário
 * para a pessoa tentar de novo. Confundir os dois trancaria fora quem tem idade
 * por causa de um 500.
 */
test("erro do servidor lança, e não vira recusa", async () => {
  stub(() => json({ error: "nope" }, 500));
  await assert.rejects(submitBirthYear("1990"), /respondeu 500/);

  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
  await assert.rejects(submitBirthYear("1990"), /offline/);
});

/**
 * Resposta que não valida contra o contrato também lança em vez de virar
 * recusa: `ok` ausente seria `undefined`, e `undefined` é falso.
 */
test("resposta fora do contrato lança, e não vira recusa", async () => {
  stub(() => json({ minAge: MIN_AGE }));
  await assert.rejects(submitBirthYear("1990"));
});
