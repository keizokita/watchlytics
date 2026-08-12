/**
 * Gêneros canônicos — PLAN.md §4.1.
 *
 * IDs são NOSSOS, nunca de fornecedor: três gêneros são merges e não têm id
 * único em catálogo externo nenhum.
 *
 * A ORDEM DESTE ARRAY É A ORDEM DAS DIMENSÕES DO `users.taste_vector`.
 * Inserir no meio invalida todos os vetores já gravados — só acrescente no fim.
 */
export const GENRES = [
  { id: 1, name: "Action & Adventure" },
  { id: 2, name: "Animation" },
  { id: 3, name: "Anime" },
  { id: 4, name: "Comedy" },
  { id: 5, name: "Crime" },
  { id: 6, name: "Documentary" },
  { id: 7, name: "Drama" },
  { id: 8, name: "Family" },
  { id: 9, name: "History" },
  { id: 10, name: "Horror" },
  { id: 11, name: "Kids" },
  { id: 12, name: "Music" },
  { id: 13, name: "Mystery" },
  { id: 14, name: "Reality" },
  { id: 15, name: "Romance" },
  { id: 16, name: "Sci-Fi & Fantasy" },
  { id: 17, name: "Thriller" },
  { id: 18, name: "War & Politics" },
  { id: 19, name: "Western" },
] as const;

/** Dimensões do taste_vector. Muda só se GENRES crescer. */
export const TASTE_VECTOR_DIM = GENRES.length;

export const GENRE_IDS: readonly number[] = GENRES.map((g) => g.id);

export const GENRE_NAME_BY_ID: ReadonlyMap<number, string> = new Map(
  GENRES.map((g) => [g.id, g.name]),
);
