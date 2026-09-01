import { z } from "zod";
import { GENRE_IDS } from "./genres.ts";

export * from "./genres.ts";

/**
 * A costura entre apps/api e apps/web.
 *
 * Só existe aqui o que já é consumido pelas duas pontas. Endpoint novo entra
 * neste arquivo em PR próprio, mergeado ANTES da trilha que depende dele —
 * é isso que deixa a trilha do swipe correr sem esperar a do feed.
 */

export const titleType = z.enum(["movie", "tv"]);
export type TitleType = z.infer<typeof titleType>;

export const genreId = z.number().int().refine((n) => GENRE_IDS.includes(n), {
  message: "gênero desconhecido",
});

export const title = z.object({
  id: z.uuid(),
  type: titleType,
  title: z.string(),
  originalTitle: z.string().nullable(),
  overview: z.string(),
  /** null enquanto não houver fornecedor de catálogo: o card cai no gradiente. */
  posterUrl: z.url().nullable(),
  backdropUrl: z.url().nullable(),
  releaseYear: z.number().int(),
  runtimeMinutes: z.number().int().nullable(),
  originalLanguage: z.string().length(2),
  genreIds: z.array(genreId),
  score: z.number().int().min(0).max(100),
  voteAverage: z.number(),
});
export type Title = z.infer<typeof title>;

export const feedQuery = z.object({
  types: z.array(titleType).optional(),
  genres: z.array(genreId).optional(),
  yearFrom: z.coerce.number().int().optional(),
  yearTo: z.coerce.number().int().optional(),
  languages: z.array(z.string().length(2)).optional(),
  cursor: z.string().optional(),
});
export type FeedQuery = z.infer<typeof feedQuery>;

export const feedResponse = z.object({
  items: z.array(title),
  nextCursor: z.string().nullable(),
  /** Qual filtro o degrau de degradação relaxou, se relaxou (PLAN §5.2). */
  relaxed: z.array(z.string()).optional(),
});
export type FeedResponse = z.infer<typeof feedResponse>;

export const swipeDirection = z.union([z.literal(1), z.literal(-1)]);

export const swipeInput = z.object({
  titleId: z.uuid(),
  direction: swipeDirection,
  /** Carimbo do cliente: o buffer offline pode entregar minutos depois. */
  clientTs: z.iso.datetime(),
});
export type SwipeInput = z.infer<typeof swipeInput>;

/** Em lote de propósito: o buffer offline manda vários de uma vez. */
export const swipeBatch = z.array(swipeInput).min(1).max(50);

export const swipeBatchResponse = z.object({
  accepted: z.number().int(),
  /** Títulos que não existem mais no catálogo. O cliente pode descartá-los. */
  skipped: z.number().int(),
});
export type SwipeBatchResponse = z.infer<typeof swipeBatchResponse>;

export const libraryStatus = z.enum(["interested", "watched"]);
export type LibraryStatus = z.infer<typeof libraryStatus>;
