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

export const rating = z.number().int().min(1).max(5);

/**
 * D1 — corpo de `PUT /v1/library/:titleId`.
 *
 * PUT é substituição, não patch: `rating` ausente grava NULL. Um PATCH que
 * distinguisse "não mandei" de "apague a nota" exigiria três estados no
 * cliente para uma tela que tem dois botões.
 */
export const libraryInput = z.object({
  status: libraryStatus,
  rating: rating.nullable().optional(),
});
export type LibraryInput = z.infer<typeof libraryInput>;

export const libraryEntry = z.object({
  title,
  status: libraryStatus,
  rating: rating.nullable(),
  addedAt: z.iso.datetime(),
  /** Carimbado na transição interested → watched, nunca antes. */
  watchedAt: z.iso.datetime().nullable(),
});
export type LibraryEntry = z.infer<typeof libraryEntry>;

export const libraryListResponse = z.object({
  items: z.array(libraryEntry),
});
export type LibraryListResponse = z.infer<typeof libraryListResponse>;

/**
 * D2 — descartados vêm de `swipes` (direction = -1), NÃO de `library_entries`.
 *
 * São ciclos de vida diferentes: o dislike é reciclável em 180 dias e some
 * sozinho da lista; a entrada de catálogo é uma decisão que o usuário tomou e
 * só ele desfaz. Por isso não há `status: "discarded"` — o tipo aqui é `Title`
 * puro, e é o contrato que impede alguém de fundir as duas tabelas depois.
 */
export const discardedResponse = z.object({
  items: z.array(title),
});
export type DiscardedResponse = z.infer<typeof discardedResponse>;

/** Piso de agregação — PLAN §8.3. Abaixo disso nenhum agregado sai da API. */
export const STATS_MIN_WATCHED = 10;

export const profileStats = z.object({
  watchedCount: z.number().int(),
  /**
   * `null` abaixo de STATS_MIN_WATCHED. Com 2 filmes assistidos, "gênero
   * dominante" e "década favorita" praticamente reconstroem o catálogo —
   * agregado de amostra minúscula não é agregado, é o dado cru.
   */
  aggregates: z
    .object({
      topGenres: z.array(
        z.object({ genreId, count: z.number().int() }),
      ),
      /** Soma de runtime_minutes; título sem runtime conta como zero. */
      estimatedMinutes: z.number().int(),
      favoriteDecade: z.number().int(),
    })
    .nullable(),
});
export type ProfileStats = z.infer<typeof profileStats>;


// ─── identidade (C2/C3) ─────────────────────────────────────────────────────

/** Apple entra aqui na fase 4 — a rota já é /v1/auth/oauth/:provider. */
export const oauthProvider = z.enum(["google"]);
export type OauthProvider = z.infer<typeof oauthProvider>;

/**
 * Para onde vai o refresh token.
 *
 * `cookie` — web: httpOnly, fora do alcance de XSS, nunca aparece no corpo.
 * `body`   — nativo: devolvido no JSON e guardado em SecureStore.
 *
 * Mesmo endpoint, transporte diferente. É isso que faz a fase 4 ser só UI.
 */
export const authTransport = z.enum(["cookie", "body"]);
export type AuthTransport = z.infer<typeof authTransport>;

export const oauthExchange = z.object({
  code: z.string().min(1).max(2048),
  /** RFC 7636 §4.1: 43–128 caracteres do alfabeto unreserved. */
  codeVerifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9\-._~]+$/, "code_verifier fora do alfabeto do RFC 7636"),
  /**
   * Precisa ser byte a byte o mesmo usado na autorização — o provedor recusa
   * a troca se divergir. O servidor ainda confere contra a própria allowlist.
   */
  redirectUri: z.url(),
  transport: authTransport.default("cookie"),
});
export type OauthExchange = z.infer<typeof oauthExchange>;

export const refreshRequest = z.object({
  /** Ausente no transporte cookie: aí o refresh vem do header Cookie. */
  refresh: z.string().min(1).max(512).optional(),
  transport: authTransport.default("cookie"),
});
export type RefreshRequest = z.infer<typeof refreshRequest>;

export const authTokens = z.object({
  access: z.string(),
  /** Segundos de vida do access. O cliente renova ANTES, não depois do 401. */
  expiresIn: z.number().int().positive(),
  /** Só no transporte body. No cookie este campo não existe, de propósito. */
  refresh: z.string().optional(),
});
export type AuthTokens = z.infer<typeof authTokens>;

/** O mínimo para a UI se identificar. Stats e catálogo têm rotas próprias. */
export const sessionUser = z.object({
  id: z.uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.url().nullable(),
});
export type SessionUser = z.infer<typeof sessionUser>;

export const authResponse = authTokens.extend({ user: sessionUser });
export type AuthResponse = z.infer<typeof authResponse>;
