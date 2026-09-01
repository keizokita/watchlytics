import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { GENRES, genreId, titleType } from "@watchlytics/contract";
import { db, pg } from "./db/client.ts";
import { genres, titleExternalIds, titles, users } from "./db/schema.ts";

/**
 * A fixture entra pela MESMA porta que um fornecedor real usaria:
 * title_external_ids com provider='fixture'. A PK (provider, external_id) é o
 * que torna o seed idempotente — não há checagem em código para esquecer.
 */
const PROVIDER = "fixture";

const fixtureTitle = z.object({
  slug: z.string().min(1),
  type: titleType,
  title: z.string().min(1),
  originalTitle: z.string().nullable().default(null),
  overview: z.string().min(1),
  year: z.number().int().min(1900).max(2100),
  runtime: z.number().int().positive().nullable().default(null),
  lang: z.string().length(2),
  genres: z.array(genreId).min(1),
  score: z.number().int().min(0).max(100),
  voteAverage: z.number().min(0).max(10),
  voteCount: z.number().int().min(0),
});

const fixtureUrl = new URL("../../../seed/titles.json", import.meta.url);
const parsed = z
  .array(fixtureTitle)
  .parse(JSON.parse(await readFile(fixtureUrl, "utf8")));

const duplicateSlugs = parsed
  .map((t) => t.slug)
  .filter((s, i, all) => all.indexOf(s) !== i);
if (duplicateSlugs.length) {
  throw new Error(`slugs repetidos na fixture: ${duplicateSlugs.join(", ")}`);
}

await db
  .insert(genres)
  .values(GENRES.map((g) => ({ id: g.id, name: g.name })))
  .onConflictDoUpdate({ target: genres.id, set: { name: sql`excluded.name` } });

// Usuário do shim C1. Produção não define DEV_USER_ID, então não cria nada.
const devUserId = process.env["DEV_USER_ID"];
if (devUserId) {
  await db
    .insert(users)
    .values({ id: devUserId, handle: "dev", displayName: "Dev" })
    .onConflictDoNothing();
}

const seeded = new Set(
  (
    await db
      .select({ externalId: titleExternalIds.externalId })
      .from(titleExternalIds)
      .where(eq(titleExternalIds.provider, PROVIDER))
  ).map((r) => r.externalId),
);

const pending = parsed.filter((t) => !seeded.has(t.slug));

await db.transaction(async (tx) => {
  for (const t of pending) {
    const [row] = await tx
      .insert(titles)
      .values({
        type: t.type,
        title: t.title,
        originalTitle: t.originalTitle,
        overview: t.overview,
        releaseYear: t.year,
        runtimeMinutes: t.runtime,
        originalLanguage: t.lang,
        genreIds: t.genres,
        score: t.score,
        voteAverage: t.voteAverage.toFixed(1),
        voteCount: t.voteCount,
      })
      .returning({ id: titles.id });

    if (!row) throw new Error(`insert falhou para ${t.slug}`);

    await tx
      .insert(titleExternalIds)
      .values({ titleId: row.id, provider: PROVIDER, externalId: t.slug });
  }
});

console.log(
  `gêneros: ${GENRES.length} | títulos inseridos: ${pending.length} | já existentes: ${seeded.size}`,
);

await pg.end();
