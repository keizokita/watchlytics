import assert from "node:assert/strict";
import test from "node:test";
import { asc, eq } from "drizzle-orm";
import {
  discardedResponse,
  libraryListResponse,
  profileStats,
  STATS_MIN_WATCHED,
} from "@watchlytics/contract";
import { db, pg } from "../db/client.ts";
import { libraryEntries, swipes, titles, users } from "../db/schema.ts";
import { buildServer } from "../server.ts";

/**
 * O que este arquivo guarda (D1–D3):
 *   1. like vira entrada de catálogo
 *   2. watched_at é carimbado na transição e não é reescrito depois
 *   3. rating aceita 1–5, aceita null, e recusa o resto na borda
 *   4. "descartados" sai de swipes, NUNCA de library_entries
 *   5. o piso de 10 assistidos não devolve agregado nenhum
 *
 * Usuário próprio, não o DEV_USER_ID do .env: os arquivos de teste rodam em
 * paralelo e a suíte de swipes limpa a tabela inteira do usuário dela.
 */
const USER = "00000000-0000-4000-8000-0000000000d1";
process.env["DEV_USER_ID"] = USER;

await db
  .insert(users)
  .values({ id: USER, handle: "trilha-d", displayName: "Trilha D" })
  .onConflictDoNothing();

/** Pool estável: o feed muda de ordem conforme os swipes do próprio teste. */
const pool = await db.select().from(titles).orderBy(asc(titles.id)).limit(20);
assert.ok(
  pool.length >= STATS_MIN_WATCHED + 2,
  "o banco precisa estar semeado (npm run seed)",
);

const app = buildServer();

const put = (titleId: string, body: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/v1/library/${titleId}`, payload: body });

const list = async (status: string) => {
  const res = await app.inject({ method: "GET", url: `/v1/library?status=${status}` });
  assert.equal(res.statusCode, 200);
  return libraryListResponse.parse(res.json()).items;
};

const discarded = async () => {
  const res = await app.inject({ method: "GET", url: "/v1/library/discarded" });
  assert.equal(res.statusCode, 200);
  return discardedResponse.parse(res.json()).items;
};

const stats = async () => {
  const res = await app.inject({ method: "GET", url: "/v1/me/stats" });
  assert.equal(res.statusCode, 200);
  return profileStats.parse(res.json());
};

const swipe = (titleId: string, direction: 1 | -1) =>
  app.inject({
    method: "POST",
    url: "/v1/swipes",
    payload: [{ titleId, direction, clientTs: new Date().toISOString() }],
  });

async function reset() {
  await db.delete(libraryEntries).where(eq(libraryEntries.userId, USER));
  await db.delete(swipes).where(eq(swipes.userId, USER));
}

const entryOf = async (titleId: string) =>
  (
    await db
      .select()
      .from(libraryEntries)
      .where(eq(libraryEntries.titleId, titleId))
  ).find((r) => r.userId === USER);

test.after(async () => {
  // cascata leva swipes e library_entries junto
  await db.delete(users).where(eq(users.id, USER));
  await app.close();
  await pg.end();
});

test("like vira entrada de catálogo em interessado", async () => {
  await reset();
  const [liked, disliked] = [pool[0]!.id, pool[1]!.id];

  await swipe(liked, 1);
  await swipe(disliked, -1);

  const items = await list("interested");
  assert.deepEqual(
    items.map((i) => i.title.id),
    [liked],
    "só o like vira entrada; o dislike nunca entra no catálogo",
  );
  assert.equal(items[0]?.rating, null, "like não inventa nota");
});

test("interested → watched carimba watched_at e não o reescreve depois", async () => {
  await reset();
  const id = pool[0]!.id;

  assert.equal((await put(id, { status: "interested" })).statusCode, 204);
  assert.equal((await entryOf(id))?.watchedAt, null, "interessado não tem data");

  assert.equal((await put(id, { status: "watched", rating: 4 })).statusCode, 204);
  const first = (await entryOf(id))?.watchedAt;
  assert.ok(first instanceof Date, "a transição carimba watched_at");

  // editar a nota não muda a data em que a pessoa assistiu
  await put(id, { status: "watched", rating: 5 });
  const after = await entryOf(id);
  assert.deepEqual(after?.watchedAt, first, "watched_at não é reescrito");
  assert.equal(after?.rating, 5);

  // e voltar para interessado zera: a coluna não pode mentir sobre o status,
  // senão as stats somam quem não assistiu
  await put(id, { status: "interested" });
  assert.equal((await entryOf(id))?.watchedAt, null);
});

test("rating é opcional, nullable e validado na borda", async () => {
  await reset();
  const id = pool[0]!.id;

  await put(id, { status: "watched" });
  assert.equal((await entryOf(id))?.rating, null, "assistido sem nota é válido");

  await put(id, { status: "watched", rating: 3 });
  assert.equal((await entryOf(id))?.rating, 3);

  // PUT é substituição: omitir a nota apaga a nota
  await put(id, { status: "watched" });
  assert.equal((await entryOf(id))?.rating, null);

  await put(id, { status: "watched", rating: null });
  assert.equal((await entryOf(id))?.rating, null);

  for (const bad of [0, 6, 2.5, "5"]) {
    assert.equal(
      (await put(id, { status: "watched", rating: bad })).statusCode,
      400,
      `rating ${JSON.stringify(bad)} tinha que ser recusado`,
    );
  }
  assert.equal((await put(id, { status: "seen" })).statusCode, 400);
  assert.equal((await put("não-é-uuid", { status: "watched" })).statusCode, 400);
  assert.equal(
    (await put("00000000-0000-4000-8000-0000000000ff", { status: "watched" }))
      .statusCode,
    404,
    "título fora do catálogo é 404, não 500 de FK",
  );
});

test("descartados lê swipes, não library_entries", async () => {
  await reset();
  const [inLibrary, thrownAway] = [pool[0]!.id, pool[1]!.id];

  // uma entrada de catálogo não pode aparecer entre os descartados…
  await put(inLibrary, { status: "watched", rating: 5 });
  // …e um dislike aparece sem nunca ter virado entrada
  await swipe(thrownAway, -1);

  assert.deepEqual(
    (await discarded()).map((t) => t.id),
    [thrownAway],
  );

  const rows = await db
    .select()
    .from(libraryEntries)
    .where(eq(libraryEntries.userId, USER));
  assert.deepEqual(
    rows.map((r) => r.titleId),
    [inLibrary],
    "descartar não escreve em library_entries",
  );
});

test("agregados só existem a partir de 10 assistidos", async () => {
  await reset();

  for (const row of pool.slice(0, STATS_MIN_WATCHED - 1)) {
    await put(row.id, { status: "watched" });
  }
  // e um interessado, que não pode contar como assistido
  await put(pool[STATS_MIN_WATCHED]!.id, { status: "interested" });

  const below = await stats();
  assert.equal(below.watchedCount, STATS_MIN_WATCHED - 1);
  assert.equal(below.aggregates, null, "abaixo do piso a API não agrega");

  await put(pool[STATS_MIN_WATCHED - 1]!.id, { status: "watched" });

  const at = await stats();
  const watched = pool.slice(0, STATS_MIN_WATCHED);
  assert.equal(at.watchedCount, STATS_MIN_WATCHED);
  assert.ok(at.aggregates, "no piso os agregados aparecem");
  assert.equal(
    at.aggregates.estimatedMinutes,
    watched.reduce((sum, r) => sum + (r.runtimeMinutes ?? 0), 0),
    "soma de runtime ignora só o interessado e trata null como zero",
  );

  const decades = new Map<number, number>();
  for (const r of watched) {
    const d = Math.floor(r.releaseYear / 10) * 10;
    decades.set(d, (decades.get(d) ?? 0) + 1);
  }
  const expected = [...decades].sort(([da, ca], [db_, cb]) => cb - ca || db_ - da);
  assert.equal(at.aggregates.favoriteDecade, expected[0]![0]);

  const counted = at.aggregates.topGenres.reduce((s, g) => s + g.count, 0);
  assert.ok(counted > 0 && at.aggregates.topGenres.length <= 3);
});

test("sem DEV_USER_ID o catálogo responde 401", async () => {
  const saved = process.env["DEV_USER_ID"];
  delete process.env["DEV_USER_ID"];
  try {
    const res = await app.inject({ method: "GET", url: "/v1/library?status=watched" });
    assert.equal(res.statusCode, 401);
  } finally {
    process.env["DEV_USER_ID"] = saved;
  }
});
