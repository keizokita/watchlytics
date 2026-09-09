import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { mensagem } from "./errors.ts";
import { t } from "./strings.ts";

/** `navigator` é um getter configurável no Node — dá para trocar por um duplo. */
const rede = (onLine: boolean) =>
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine },
    configurable: true,
  });

/** Guarda o que o `console.error` recebeu e devolve o console ao normal. */
function espiaConsole() {
  const original = console.error;
  const vistos: unknown[] = [];
  console.error = (...args: unknown[]) => void vistos.push(...args);
  return {
    vistos,
    restaura: () => {
      console.error = original;
    },
  };
}

afterEach(() => rede(true));

/**
 * O motivo desta função existir: a UI é em inglês e o que o código lança é
 * português técnico. Antes isto ia direto para a tela.
 */
test("o detalhe técnico não chega na tela — chega no console", () => {
  rede(true);
  const espia = espiaConsole();
  const causa = new Error("feed respondeu 500");
  try {
    const texto = mensagem(causa);
    assert.equal(texto, t.errorGeneric);
    assert.ok(!texto.includes("500"));
    assert.ok(!texto.includes("respondeu"));
    assert.deepEqual(espia.vistos, [causa]);
  } finally {
    espia.restaura();
  }
});

test("offline e falha do servidor são mensagens diferentes", () => {
  const espia = espiaConsole();
  try {
    rede(false);
    assert.equal(mensagem(new Error("feed respondeu 500")), t.errorOffline);
    rede(true);
    assert.equal(mensagem(new Error("feed respondeu 500")), t.errorGeneric);
  } finally {
    espia.restaura();
  }
});

/** ZodError não é `Error` com mensagem curta: é o JSON inteiro do contrato. */
test("o que não é Error também não vaza", () => {
  rede(true);
  const espia = espiaConsole();
  try {
    assert.equal(mensagem({ issues: [{ path: ["items", 0, "id"] }] }), t.errorGeneric);
    assert.equal(mensagem("boom"), t.errorGeneric);
  } finally {
    espia.restaura();
  }
});
