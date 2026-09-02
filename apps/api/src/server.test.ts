import assert from "node:assert/strict";
import test from "node:test";
import { feedResponse } from "@watchlytics/contract";
import { pg } from "./db/client.ts";
import { buildServer } from "./server.ts";

/**
 * O que este teste guarda: que a resposta do feed continua satisfazendo o
 * contrato. Se alguém trocar um campo no schema do banco e esquecer o
 * mapeamento, o .parse() quebra aqui e não no cliente.
 *
 * Precisa do banco semeado: npm run db:up && npm run migrate && npm run seed
 */
test("GET /v1/feed devolve um lote válido pelo contrato", async (t) => {
  const app = buildServer();
  t.after(async () => {
    await app.close();
    await pg.end();
  });

  const res = await app.inject({ method: "GET", url: "/v1/feed" });
  assert.equal(res.statusCode, 200);

  const body = feedResponse.parse(res.json());
  assert.equal(body.items.length, 20, "lote de 20");

  // A ordem deixou de ser score DESC em A4 — entrou o boost por gênero e o
  // ruído multiplicativo. Quem guarda a ordenação agora é routes/feed.test.ts.

  // Sem fornecedor de catálogo, todo card cai no gradiente.
  assert.ok(
    body.items.every((i) => i.posterUrl === null),
    "fixture não tem pôster",
  );
});
