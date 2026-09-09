import test from "node:test";
import assert from "node:assert/strict";
import { get } from "./http.ts";

/**
 * A extração do I0.2 mudou UMA coisa de comportamento: o token deixou de ser
 * lido no topo do módulo e passou a ser lido por chamada. Era necessário — um
 * `throw` no import derrubaria qualquer teste que só importasse daqui —, mas
 * troca "quebra ao carregar" por "quebra no primeiro request", e a mensagem é a
 * única coisa que o operador tem para saber o que fazer.
 */
test("sem TMDB_READ_TOKEN o erro diz onde gerar a chave, e não vaza para a rede", async () => {
  const antes = process.env["TMDB_READ_TOKEN"];
  delete process.env["TMDB_READ_TOKEN"];
  try {
    await assert.rejects(
      // URL inalcançável de propósito: se o token fosse ignorado, o teste
      // falharia por erro de rede em vez de passar por acidente.
      () => get("http://127.0.0.1:1/nao-deve-ser-chamado"),
      /TMDB_READ_TOKEN ausente/,
    );
  } finally {
    if (antes !== undefined) process.env["TMDB_READ_TOKEN"] = antes;
  }
});
