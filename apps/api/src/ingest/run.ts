import { and, eq, sql } from "drizzle-orm";
import type { TitleType } from "@watchlytics/contract";
import { db, pg } from "../db/client.ts";
import { titleExternalIds, titles } from "../db/schema.ts";
import { discoverUrl, normalize, type TmdbItem } from "./tmdb.ts";

/**
 * Ingestão do catálogo do TMDB.
 *
 *   npm run ingest -w @watchlytics/api            # padrão
 *   npm run ingest -w @watchlytics/api -- --from 2015 --min-votes 800
 *   npm run ingest -w @watchlytics/api -- --dry-run
 *
 * Idempotente: entra pela mesma porta da fixture, title_external_ids com
 * provider='tmdb'. Rodar de novo atualiza o que mudou e não duplica nada.
 *
 * O alvo NÃO é o acervo inteiro. Título irreconhecível quebra o ritmo do swipe:
 * um catálogo de 900 mil seria pior produto que um de 15 mil. A régua é
 * `--min-votes`, e ela é o botão de curadoria.
 */
const PROVIDER = "tmdb";

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const FROM = arg("from", 1970);
const TO = arg("to", new Date().getFullYear());
const MIN_VOTES = arg("min-votes", 500);
/**
 * Anime tem base de votantes menor que blockbuster de Hollywood: com a régua
 * global, "Frieren" não entraria e a aba Anime abriria vazia. Piso próprio.
 */
const MIN_VOTES_ANIME = arg("min-votes-anime", 80);
/**
 * Mesma doença do anime, pior: com a régua global o gênero Reality inteiro
 * fecha em 8 títulos — reality não acumula voto no TMDB como ficção acumula.
 * Piso próprio pelo mesmo motivo, e mais baixo porque a base é menor.
 */
const MIN_VOTES_REALITY = arg("min-votes-reality", 50);
const DRY = flag("dry-run");

const token = process.env["TMDB_READ_TOKEN"];
if (!token) {
  throw new Error(
    "TMDB_READ_TOKEN ausente. Gere em themoviedb.org/settings/api (Read Access Token v4) e ponha em apps/api/.env",
  );
}

/**
 * Bearer, não `?api_key=`: chave em query string vaza em log de servidor, em
 * proxy e no header Referer. Header não.
 */
const headers = { Authorization: `Bearer ${token}`, accept: "application/json" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uma requisição por vez com pausa: nunca chegamos perto do teto do TMDB. */
let lastCall = 0;
async function get(url: string, attempt = 0): Promise<{ results?: TmdbItem[]; total_pages?: number }> {
  const since = Date.now() - lastCall;
  if (since < 60) await sleep(60 - since);
  lastCall = Date.now();

  const res = await fetch(url, { headers });

  if (res.status === 429) {
    // Respeita o Retry-After quando vem; senão recua exponencialmente.
    const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 2 ** attempt * 1000;
    if (attempt > 5) throw new Error("429 persistente no TMDB");
    await sleep(wait);
    return get(url, attempt + 1);
  }
  if (res.status >= 500 && attempt < 5) {
    await sleep(2 ** attempt * 500);
    return get(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`TMDB ${res.status} em ${url.split("?")[0]}`);
  return res.json() as Promise<{ results?: TmdbItem[]; total_pages?: number }>;
}

let inserted = 0;
let updated = 0;
let skipped = 0;

async function upsert(n: NonNullable<ReturnType<typeof normalize>>) {
  if (DRY) return;

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ titleId: titleExternalIds.titleId })
      .from(titleExternalIds)
      .where(
        and(
          eq(titleExternalIds.provider, PROVIDER),
          eq(titleExternalIds.externalId, n.externalId),
        ),
      );

    const values = {
      type: n.type,
      title: n.title,
      originalTitle: n.originalTitle,
      overview: n.overview,
      posterUrl: n.posterUrl,
      backdropUrl: n.backdropUrl,
      releaseYear: n.releaseYear,
      originalLanguage: n.originalLanguage,
      genreIds: n.genreIds,
      score: n.score,
      voteAverage: n.voteAverage,
      voteCount: n.voteCount,
      syncedAt: new Date(),
    };

    if (existing) {
      // Título, sinopse e pôster mudam no TMDB. Nosso id nunca — é o que os
      // swipes e os matches referenciam.
      await tx.update(titles).set(values).where(eq(titles.id, existing.titleId));
      updated++;
      return;
    }

    const [row] = await tx.insert(titles).values(values).returning({ id: titles.id });
    if (!row) throw new Error(`insert falhou para tmdb:${n.externalId}`);
    await tx
      .insert(titleExternalIds)
      .values({ titleId: row.id, provider: PROVIDER, externalId: n.externalId })
      .onConflictDoNothing();
    inserted++;
  });
}

async function bucket(type: TitleType, year: number, kind?: "anime" | "reality") {
  const minVotes =
    kind === "anime"
      ? MIN_VOTES_ANIME
      : kind === "reality"
        ? MIN_VOTES_REALITY
        : MIN_VOTES;
  let page = 1;
  let pages = 1;

  do {
    const data = await get(
      discoverUrl({
        type,
        year,
        page,
        minVotes,
        anime: kind === "anime",
        reality: kind === "reality",
      }),
    );
    pages = Math.min(data.total_pages ?? 1, 500); // o teto do /discover

    for (const item of data.results ?? []) {
      const n = normalize(item, type, minVotes);
      if (!n) {
        skipped++;
        continue;
      }
      await upsert(n);
    }
    page++;
  } while (page <= pages);
}

const started = Date.now();
console.log(
  `ingestão tmdb | anos ${FROM}-${TO} | min-votes ${MIN_VOTES} (anime ${MIN_VOTES_ANIME}, reality ${MIN_VOTES_REALITY})${DRY ? " | DRY-RUN" : ""}`,
);

for (const year of Array.from({ length: TO - FROM + 1 }, (_, i) => FROM + i)) {
  for (const type of ["movie", "tv"] as const) {
    await bucket(type, year);
    // Balde dedicado: no ranking global por votos o anime fica sub-representado,
    // e a aba Anime é feature de manchete. Sem ele, ela abre quase vazia.
    await bucket(type, year, "anime");
  }
  // Reality só existe como gênero de série no TMDB.
  await bucket("tv", year, "reality");
  console.log(
    `${year}: +${inserted} novos, ~${updated} atualizados, ${skipped} fora do portão`,
  );
}

const total = await db.select({ n: sql<number>`count(*)::int` }).from(titles);
console.log(
  `\nfim em ${Math.round((Date.now() - started) / 1000)}s | inseridos ${inserted} | atualizados ${updated} | descartados ${skipped} | catálogo: ${total[0]?.n ?? "?"}`,
);

await pg.end();
