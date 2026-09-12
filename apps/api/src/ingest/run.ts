import { sql } from "drizzle-orm";
import type { TitleType } from "@watchlytics/contract";
import { db, pg } from "../db/client.ts";
import { titles } from "../db/schema.ts";
import { get } from "./http.ts";
import {
  CHAVE_BACKFILL,
  anoDeRetomada,
  gravarEstado,
  lerEstado,
  regua,
  type Backfill,
} from "./state.ts";
import { discoverUrl, normalize } from "./tmdb.ts";
import { upsert } from "./upsert.ts";

/**
 * Ingestão do catálogo do TMDB.
 *
 *   npm run ingest -w @watchlytics/api            # padrão
 *   npm run ingest -w @watchlytics/api -- --from 2015 --min-votes 800
 *   npm run ingest -w @watchlytics/api -- --dry-run
 *   npm run ingest -w @watchlytics/api -- --restart   # ignora o cursor
 *
 * Idempotente: entra pela mesma porta da fixture, title_external_ids com
 * provider='tmdb'. Rodar de novo atualiza o que mudou e não duplica nada.
 *
 * **Retomável (I2.3).** Uma carga inteira são ~57 anos × 5 baldes e leva horas;
 * morrer no meio e recomeçar em 1970 gastaria de novo tudo que já funcionou.
 * O cursor `backfill_cursor` guarda o último ano CONCLUÍDO, junto da régua com
 * que foi concluído — ver `anoDeRetomada()` em `state.ts`, que é onde essa
 * decisão mora e onde o teste a alcança.
 *
 * O alvo NÃO é o acervo inteiro. Título irreconhecível quebra o ritmo do swipe:
 * um catálogo de 900 mil seria pior produto que um de 15 mil. A régua é
 * `--min-votes`, e ela é o botão de curadoria.
 */
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
/** I2.3: ignora o cursor e refaz a carga do começo. */
const RESTART = flag("restart");

let inserted = 0;
let updated = 0;
let skipped = 0;

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
      const r = await upsert(n, { dry: DRY });
      if (r === "inserido") inserted++;
      else if (r === "atualizado") updated++;
    }
    page++;
  } while (page <= pages);
}

const started = Date.now();
const ASSINATURA = regua({
  from: FROM,
  to: TO,
  minVotes: MIN_VOTES,
  minVotesAnime: MIN_VOTES_ANIME,
  minVotesReality: MIN_VOTES_REALITY,
});
const cursor = RESTART ? null : await lerEstado<Backfill>(CHAVE_BACKFILL);
const { ano: INICIO, motivo } = anoDeRetomada(cursor, ASSINATURA, FROM, TO);

console.log(
  `ingestão tmdb | anos ${FROM}-${TO} | min-votes ${MIN_VOTES} (anime ${MIN_VOTES_ANIME}, reality ${MIN_VOTES_REALITY})${DRY ? " | DRY-RUN" : ""}`,
);
console.log(RESTART ? "--restart: carga do começo" : motivo);

for (const year of Array.from({ length: TO - INICIO + 1 }, (_, i) => INICIO + i)) {
  for (const type of ["movie", "tv"] as const) {
    await bucket(type, year);
    // Balde dedicado: no ranking global por votos o anime fica sub-representado,
    // e a aba Anime é feature de manchete. Sem ele, ela abre quase vazia.
    await bucket(type, year, "anime");
  }
  // Reality só existe como gênero de série no TMDB.
  await bucket("tv", year, "reality");
  // Grava DEPOIS de o ano fechar, e não antes: o cursor só promete o que já
  // terminou. Dry-run não grava — não escreveu título nenhum para retomar.
  if (!DRY) {
    await gravarEstado(CHAVE_BACKFILL, { ano: year, regua: ASSINATURA } satisfies Backfill);
  }
  console.log(
    `${year}: +${inserted} novos, ~${updated} atualizados, ${skipped} fora do portão`,
  );
}

const total = await db.select({ n: sql<number>`count(*)::int` }).from(titles);
console.log(
  `\nfim em ${Math.round((Date.now() - started) / 1000)}s | inseridos ${inserted} | atualizados ${updated} | descartados ${skipped} | catálogo: ${total[0]?.n ?? "?"}`,
);

await pg.end();
