import assert from "node:assert/strict";
import test from "node:test";
import { feedResponse } from "@watchlytics/contract";
import { signAccess } from "./auth.ts";
import { db, pg } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { buildServer } from "./server.ts";

process.env["AUTH_SECRET"] ??= "chave-de-teste-com-mais-de-32-caracteres";

/**
 * Usuário próprio do arquivo, criado aqui: os arquivos de teste rodam em
 * paralelo contra o mesmo banco, e nenhum deles depende do seed criar conta.
 *
 * β3 — o feed é rota autenticada e o shim saiu: quem autentica é o Bearer
 * assinado abaixo, e sem header isto seria 401.
 *
 * β2 — nasce com a porta de idade já respondida: sem ano, toda rota é 403.
 */
const USER = "00000000-0000-4000-8000-0000000000f5";

await db
  .insert(users)
  .values({ id: USER, handle: "server-test", displayName: "S5", birthYear: 1990 })
  .onConflictDoNothing();

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

  const res = await app.inject({
    method: "GET",
    url: "/v1/feed",
    headers: { authorization: `Bearer ${signAccess(USER)}` },
  });
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
