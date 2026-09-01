import assert from "node:assert/strict";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import type { SwipeInput } from "@watchlytics/contract";
import { db, pg } from "./db/client.ts";
import { swipes } from "./db/schema.ts";
import { buildServer } from "./server.ts";

/**
 * Guarda as três apostas de A0 + A2:
 *   1. reenvio do buffer offline é upsert, não duplicata
 *   2. título repetido dentro do mesmo lote não quebra o INSERT
 *   3. like nunca volta ao feed; dislike volta depois de 180 dias
 *
 * Precisa do banco semeado com DEV_USER_ID definido.
 */
const USER = process.env["DEV_USER_ID"];
if (!USER) throw new Error("DEV_USER_ID não definida (veja .env.example)");

const app = buildServer();
const feedIds = async () => {
  const res = await app.inject({ method: "GET", url: "/v1/feed" });
  assert.equal(res.statusCode, 200);
  return (res.json() as { items: { id: string }[] }).items.map((i) => i.id);
};
const post = (payload: SwipeInput[]) =>
  app.inject({ method: "POST", url: "/v1/swipes", payload });

/** Dois primeiros ids do feed, já estreitados para string. */
async function twoFeedIds(): Promise<[string, string]> {
  const [a, b] = await feedIds();
  assert.ok(a && b, "o feed precisa de ao menos dois títulos");
  return [a, b];
}

test.after(async () => {
  await db.delete(swipes).where(eq(swipes.userId, USER));
  await app.close();
  await pg.end();
});

test("lote reenviado faz upsert, não duplica", async () => {
  await db.delete(swipes).where(eq(swipes.userId, USER));
  const [liked, disliked] = await twoFeedIds();
  const ts = new Date().toISOString();

  const batch: SwipeInput[] = [
    { titleId: liked, direction: 1, clientTs: ts },
    { titleId: disliked, direction: -1, clientTs: ts },
  ];

  const first = await post(batch);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { accepted: 2, skipped: 0 });

  // o buffer offline pode reenviar o mesmo lote depois de uma falha de rede
  assert.deepEqual((await post(batch)).json(), { accepted: 2, skipped: 0 });

  const rows = await db.select().from(swipes).where(eq(swipes.userId, USER));
  assert.equal(rows.length, 2, "duas linhas, não quatro");
});

test("título repetido no mesmo lote não quebra o ON CONFLICT", async () => {
  await db.delete(swipes).where(eq(swipes.userId, USER));
  const [id] = await twoFeedIds();
  const ts = new Date().toISOString();

  const res = await post([
    { titleId: id, direction: -1, clientTs: ts },
    { titleId: id, direction: 1, clientTs: ts },
  ]);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { accepted: 1, skipped: 0 });

  const rows = await db.select().from(swipes).where(eq(swipes.userId, USER));
  assert.equal(rows[0]?.direction, 1, "a última decisão do lote vence");
});

test("título desconhecido é descartado sem envenenar o lote", async () => {
  await db.delete(swipes).where(eq(swipes.userId, USER));
  const [id] = await twoFeedIds();
  const ts = new Date().toISOString();

  const res = await post([
    { titleId: id, direction: 1, clientTs: ts },
    { titleId: "00000000-0000-4000-8000-0000000000ff", direction: 1, clientTs: ts },
  ]);

  assert.equal(res.statusCode, 200, "não pode falhar o lote inteiro");
  assert.deepEqual(res.json(), { accepted: 1, skipped: 1 });
});

test("like sai do feed para sempre; dislike volta depois de 180 dias", async () => {
  await db.delete(swipes).where(eq(swipes.userId, USER));
  const before = await twoFeedIds();
  const [liked, disliked] = before;
  const ts = new Date().toISOString();

  await post([
    { titleId: liked, direction: 1, clientTs: ts },
    { titleId: disliked, direction: -1, clientTs: ts },
  ]);

  const recent = await feedIds();
  assert.ok(!recent.includes(liked), "like sai do feed");
  assert.ok(!recent.includes(disliked), "dislike recente sai do feed");

  // envelhece os dois swipes além da janela de reciclagem
  await db
    .update(swipes)
    .set({ updatedAt: sql`now() - make_interval(days => 200)` })
    .where(eq(swipes.userId, USER));

  const aged = await feedIds();
  assert.ok(!aged.includes(liked), "like continua fora após 200 dias");
  assert.ok(aged.includes(disliked), "dislike antigo volta ao feed");
});

test("corpo inválido responde 400, não 500", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/swipes",
    payload: [{ titleId: "não é uuid", direction: 7, clientTs: "ontem" }],
  });
  assert.equal(res.statusCode, 400);
});

test("sem DEV_USER_ID a rota responde 401", async () => {
  const saved = process.env["DEV_USER_ID"];
  delete process.env["DEV_USER_ID"];
  try {
    assert.equal((await app.inject({ method: "GET", url: "/v1/feed" })).statusCode, 401);
  } finally {
    process.env["DEV_USER_ID"] = saved;
  }
});
