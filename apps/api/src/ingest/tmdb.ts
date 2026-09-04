import type { TitleType } from "@watchlytics/contract";

/**
 * Parte pura da ingestão do TMDB: mapa de gêneros, normalização e montagem de
 * URL. Sem rede e sem banco, para o teste rodar sem chave e sem Postgres.
 *
 * Atribuição exigida pelos termos, e que precisa aparecer no app:
 *   "This product uses the TMDB API but is not endorsed or certified by TMDB."
 */

export const TMDB_API = "https://api.themoviedb.org/3";
export const TMDB_IMAGE = "https://image.tmdb.org/t/p";

/** Nunca guardamos a URL montada: só o path. Se o CDN mudar, é uma constante. */
export const posterUrl = (path: string | null) =>
  path ? `${TMDB_IMAGE}/w500${path}` : null;
export const backdropUrl = (path: string | null) =>
  path ? `${TMDB_IMAGE}/w780${path}` : null;

/**
 * Mapa fornecedor → nossos 19 gêneros (contract/genres.ts §4.1).
 *
 * Vive no código de ingestão, não no banco: é constante de um fornecedor, e o
 * banco guarda só IDs nossos. Três dos nossos são merges e não têm id único no
 * TMDB — daí o mapa ser de muitos para um.
 *
 * O TMDB usa listas diferentes para filme e série (`Action` 28 + `Adventure` 12
 * no filme viram `Action & Adventure` 10759 na série), então o mapa é único e
 * cobre os dois.
 */
const TMDB_TO_OURS: Record<number, number> = {
  28: 1, 12: 1, 10759: 1, // Action & Adventure
  16: 2,                  // Animation
  35: 4,                  // Comedy
  80: 5,                  // Crime
  99: 6,                  // Documentary
  18: 7,                  // Drama
  10751: 8,               // Family
  36: 9,                  // History
  27: 10,                 // Horror
  10762: 11,              // Kids
  10402: 12,              // Music
  9648: 13,               // Mystery
  10764: 14,              // Reality
  10749: 15,              // Romance
  878: 16, 14: 16, 10765: 16, // Sci-Fi & Fantasy
  53: 17,                 // Thriller
  10752: 18, 10768: 18,   // War & Politics
  37: 19,                 // Western
};

/** Nosso id 3. Derivado, não vem do TMDB. */
export const ANIME = 3;

/**
 * Descartados de propósito: TV Movie (10770), News (10763), Talk (10767) e
 * Soap (10766). Não são conteúdo de descoberta — ninguém swipa procurando
 * talk show, e eles só poluiriam o deck.
 */
const DROPPED = new Set([10770, 10763, 10767, 10766]);

export function mapGenres(
  tmdbGenreIds: number[],
  originalLanguage: string,
): number[] {
  const ours = new Set<number>();
  for (const g of tmdbGenreIds) {
    if (DROPPED.has(g)) continue;
    const mapped = TMDB_TO_OURS[g];
    if (mapped) ours.add(mapped);
  }
  // Anime é animação japonesa. ponytail: erra em Castlevania/Arcane, que são
  // ocidentais com estética de anime. Cruzar com a lista do AniList se doer.
  if (ours.has(2) && originalLanguage === "ja") ours.add(ANIME);
  return [...ours].sort((a, b) => a - b);
}

/**
 * `score` 0–100 derivado de vote_count, NÃO do `popularity` do TMDB.
 *
 * Duas razões. `popularity` é métrica proprietária deles e o PLAN §1 proíbe que
 * ela saia do backend — se trocarmos de fornecedor, o ranking inteiro morre com
 * ela. E é uma janela móvel: dispara para o que estreou nesta semana e muda a
 * ordem do feed entre duas ingestões, sem o catálogo ter mudado.
 *
 * vote_count é reconhecimento acumulado — estável, e é exatamente o eixo pelo
 * qual curamos. Log porque a distribuição é de cauda longa: sem ele, os cinco
 * blockbusters da década esmagariam todo o resto.
 *
 *   100 votos → 0    1.000 → 33    10.000 → 66    100.000 → 100
 */
export function normalizeScore(voteCount: number): number {
  if (voteCount <= 0) return 0;
  const raw = Math.round((Math.log10(voteCount) - 2) * 33);
  return Math.max(0, Math.min(100, raw));
}

export type TmdbItem = {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  original_language: string;
  genre_ids: number[];
  vote_average: number;
  vote_count: number;
};

export type Normalized = {
  externalId: string;
  type: TitleType;
  title: string;
  originalTitle: string | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseYear: number;
  originalLanguage: string;
  genreIds: number[];
  score: number;
  voteAverage: string;
  voteCount: number;
};

/** `null` quando o item não passa no portão de qualidade. */
export function normalize(
  item: TmdbItem,
  type: TitleType,
  minVotes: number,
): Normalized | null {
  const title = (type === "movie" ? item.title : item.name) ?? "";
  const date = (type === "movie" ? item.release_date : item.first_air_date) ?? "";
  const year = Number(date.slice(0, 4));

  // Portão de qualidade na ENTRADA, não na query do feed: card sem pôster
  // destrói a mecânica de swipe, e sinopse vazia deixa o card mudo. Mais barato
  // barrar aqui uma vez do que filtrar em toda leitura.
  if (!title || !item.poster_path || !item.overview) return null;
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  if (item.vote_count < minVotes) return null;

  const genreIds = mapGenres(item.genre_ids ?? [], item.original_language);
  // Sem gênero nosso, o título é invisível para todo filtro e para o boost.
  if (genreIds.length === 0) return null;

  const originalTitle =
    (type === "movie" ? item.original_title : item.original_name) ?? null;

  return {
    externalId: String(item.id),
    type,
    title,
    originalTitle: originalTitle === title ? null : originalTitle,
    overview: item.overview,
    posterUrl: posterUrl(item.poster_path),
    backdropUrl: backdropUrl(item.backdrop_path),
    releaseYear: year,
    // char(2) no schema: `cn`, `ja`, `pt`. Vem "cn"/"zh" e às vezes vazio.
    originalLanguage: (item.original_language || "en").slice(0, 2),
    genreIds,
    score: normalizeScore(item.vote_count),
    voteAverage: item.vote_average.toFixed(1),
    voteCount: item.vote_count,
  };
}

/**
 * O `/discover` corta em 500 páginas por consulta, então não dá para paginar o
 * acervo inteiro de uma vez — particionamos por (tipo × ano). Com o piso de
 * votos junto, cada balde fica muito abaixo do teto.
 */
export function discoverUrl(opts: {
  type: TitleType;
  year: number;
  page: number;
  minVotes: number;
  anime?: boolean;
}): string {
  const p = new URLSearchParams({
    include_adult: "false",
    page: String(opts.page),
    sort_by: "vote_count.desc",
    "vote_count.gte": String(opts.minVotes),
  });
  p.set(
    opts.type === "movie" ? "primary_release_year" : "first_air_date_year",
    String(opts.year),
  );
  if (opts.anime) {
    p.set("with_genres", "16");
    p.set("with_original_language", "ja");
  }
  return `${TMDB_API}/discover/${opts.type}?${p}`;
}
