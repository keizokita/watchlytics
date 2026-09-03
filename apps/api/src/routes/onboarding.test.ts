import assert from "node:assert/strict";
import test from "node:test";
import { asc, eq } from "drizzle-orm";
import {
  GENRE_IDS,
  ONBOARDING_SWIPES,
  onboardingDeck,
} from "@watchlytics/contract";
import { db, pg } from "../db/client.ts";
import { swipes, titles, users } from "../db/schema.ts";
import { buildServer } from "../server.ts";

/**
 * O que este arquivo guarda (D4):
 *   1. o deck de entrada é ESTRATIFICADO: cobre todo gênero que o catálogo tem,
 *      coisa que os 20 melhores por score não fazem
 *   2. gênero escolhido vem primeiro, e o deck ainda fecha em 20 quando a
 *      escolha não tem 20 títulos — onboarding que não fecha tranca o app
 *   3. o contador desce com os swipes e o que já foi decidido não volta
 *   4. terminado, a rota não gasta 20 títulos para dizer que terminou
 *   5. PATCH /v1/me grava os gêneros e recusa id inválido e repetido
 *
 * Usuário próprio, não o DEV_USER_ID do .env: os arquivos rodam em paralelo.
 */
const USER = "00000000-0000-4000-8000-0000000000d4";
process.env["DEV_USER_ID"] = USER;

await db
  .insert(users)
  .values({ id: USER, handle: "trilha-d4", displayName: "Trilha D4" })
  .onConflictDoNothing();

const catalog = await db
  .select({ id: titles.id, genreIds: titles.genreIds, score: titles.score })
  .from(titles)
  .orderBy(asc(titles.id));
assert.ok(
  catalog.length > ONBOARDING_SWIPES,
  "o banco precisa estar semeado (npm run seed)",
);

const app = buildServer();

/** Estado limpo: o contador é contagem de swipes, e outro teste pode ter deixado. */
const reset = async (genres: number[] | null = null) => {
  await db.delete(swipes).where(eq(swipes.userId, USER));
  await db.update(users).set({ preferredGenres: genres }).where(eq(users.id, USER));
};

const deck = async () => {
  const res = await app.inject({ method: "GET", url: "/v1/onboarding/deck" });
  assert.equal(res.statusCode, 200, res.body);
  return onboardingDeck.parse(res.json());
};

const genresOf = (items: { genreIds: number[] }[]) =>
  new Set(items.flatMap((i) => i.genreIds));

test("o deck de entrada cobre mais gêneros que os 20 melhores por score", async () => {
  await reset();
  const { items, remaining } = await deck();

  assert.equal(items.length, ONBOARDING_SWIPES);
  assert.equal(remaining, ONBOARDING_SWIPES);

  const noCatalogo = genresOf(catalog);
  const noDeck = genresOf(items);
  for (const g of noCatalogo) {
    assert.ok(noDeck.has(g), `gênero ${g} ficou sem sinal no onboarding`);
  }

  // A prova de que a estratificação faz algo: o corte por score puro deixa
  // gênero de fora, e gênero sem swipe fica no 0.5 do Laplace para sempre.
  const porScore = [...catalog]
    .sort((a, b) => b.score - a.score)
    .slice(0, ONBOARDING_SWIPES);
  assert.ok(
    genresOf(porScore).size < noDeck.size,
    "estratificar não mudou nada em relação a ordenar por score",
  );
});

test("gênero escolhido vem primeiro, e o deck fecha em 20 mesmo assim", async () => {
  // Um gênero só, de propósito: é o caso em que a escolha não tem 20 títulos.
  const escolhido = 19; // Western
  const naFixture = catalog.filter((t) => t.genreIds.includes(escolhido));
  assert.ok(
    naFixture.length > 0 && naFixture.length < ONBOARDING_SWIPES,
    "a fixture precisa de um gênero raro para este teste valer",
  );

  await reset([escolhido]);
  const { items, genres } = await deck();

  assert.deepEqual(genres, [escolhido]);
  assert.equal(items.length, ONBOARDING_SWIPES, "o onboarding tem que fechar");
  for (const [i, item] of items.slice(0, naFixture.length).entries()) {
    assert.ok(
      item.genreIds.includes(escolhido),
      `item ${i} não é do gênero escolhido`,
    );
  }
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, "item repetido");
});

test("o contador desce com os swipes e o decidido não volta", async () => {
  await reset();
  const primeiro = await deck();

  const decididos = primeiro.items.slice(0, 3);
  await db.insert(swipes).values(
    decididos.map((t) => ({ userId: USER, titleId: t.id, direction: 1 as const })),
  );

  const depois = await deck();
  assert.equal(depois.remaining, ONBOARDING_SWIPES - decididos.length);
  for (const t of decididos) {
    assert.ok(
      !depois.items.some((i) => i.id === t.id),
      `${t.title} voltou depois de decidido`,
    );
  }
});

test("terminado o onboarding, a rota não gasta títulos para dizer isso", async () => {
  await reset();
  await db.insert(swipes).values(
    catalog.slice(0, ONBOARDING_SWIPES).map((t) => ({
      userId: USER,
      titleId: t.id,
      direction: -1 as const,
    })),
  );

  const { remaining, items } = await deck();
  assert.equal(remaining, 0);
  assert.deepEqual(items, [], "remaining 0 tem que vir com items vazio");
});

test("PATCH /v1/me grava os gêneros e recusa entrada inválida", async () => {
  await reset();
  const patch = (body: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/v1/me", payload: body });

  const ok = await patch({ preferredGenres: [1, 16] });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().preferredGenres, [1, 16]);

  // A visibilidade do D5 continua funcionando sozinha no mesmo endpoint.
  const so = await patch({ isPublic: true });
  assert.equal(so.statusCode, 200, so.body);
  assert.equal(so.json().isPublic, true);
  assert.deepEqual(
    so.json().preferredGenres,
    [1, 16],
    "PATCH parcial não pode apagar o outro campo",
  );

  for (const ruim of [
    {},
    { preferredGenres: [1, 1] },
    { preferredGenres: [GENRE_IDS.length + 1] },
    { preferredGenres: [0] },
  ]) {
    const res = await patch(ruim);
    assert.equal(res.statusCode, 400, `${JSON.stringify(ruim)} passou`);
  }
});

test.after(async () => {
  await db.delete(swipes).where(eq(swipes.userId, USER));
  await db.delete(users).where(eq(users.id, USER));
  await pg.end();
});
