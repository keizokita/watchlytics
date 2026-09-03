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
  /** Degrau 2 da fila vazia: o usuário aceitou rever o que já descartou. */
  recycle: z.stringbool().optional(),
});
export type FeedQuery = z.infer<typeof feedQuery>;

export const feedResponse = z.object({
  items: z.array(title),
  nextCursor: z.string().nullable(),
  /** Qual filtro o degrau de degradação relaxou, se relaxou (PLAN §5.2). */
  relaxed: z.array(z.string()).optional(),
});
export type FeedResponse = z.infer<typeof feedResponse>;

/**
 * D4 — o onboarding exige 20 swipes antes do feed calibrado (PLAN §1 item 10).
 *
 * O número é contrato e não constante de um lado só: a tela mostra o contador e
 * a API decide quando acabou. Duas definições divergiriam no dia em que alguém
 * mudasse uma.
 */
export const ONBOARDING_SWIPES = 20;

/**
 * `remaining: 0` é o fim do onboarding, e aí `items` vem vazio de propósito —
 * o cliente consulta esta rota na abertura e não paga 20 títulos para descobrir
 * que já terminou.
 *
 * `genres` vazio significa "ainda não escolheu", que é o primeiro degrau da
 * tela. O deck vem estratificado sobre os gêneros escolhidos, ou sobre todos
 * enquanto não houver escolha — as 19 dimensões do taste_vector precisam de
 * sinal, não só as preferidas.
 */
export const onboardingDeck = z.object({
  genres: z.array(genreId),
  remaining: z.number().int().min(0),
  items: z.array(title),
});
export type OnboardingDeck = z.infer<typeof onboardingDeck>;

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
  /** D5 — privado por padrão (PLAN §8.2). A tela precisa saber para oferecer. */
  isPublic: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUser>;

/**
 * E1 — o que uma pessoa vê de outra antes de haver amizade. Sem email, sem
 * `is_public`, sem contagem: a busca não é lugar de vazar nada além do nome
 * que a própria pessoa escolheu.
 */
export const publicUser = z.object({
  id: z.uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.url().nullable(),
});
export type PublicUser = z.infer<typeof publicUser>;

/** Piso da busca (PLAN §10): abaixo disso a rota nem consulta. */
export const HANDLE_SEARCH_MIN = 3;

export const userSearchResponse = z.object({ items: z.array(publicUser) });

/** E2 — as três listas saem juntas: a tela mostra as três ao mesmo tempo. */
export const friendsResponse = z.object({
  friends: z.array(publicUser),
  /** Pedidos que EU recebi e posso aceitar. */
  incoming: z.array(publicUser),
  /** Pedidos que eu mandei e ainda não foram respondidos. */
  outgoing: z.array(publicUser),
});
export type FriendsResponse = z.infer<typeof friendsResponse>;

/**
 * E5 — um título em comum com um amigo. A força é o par de status (PLAN §5.3):
 * 3 ambos querem ver, 2 um já viu, 1 os dois já viram.
 */
export const matchEntry = z.object({
  friend: publicUser,
  title,
  strength: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  createdAt: z.iso.datetime(),
});
export type MatchEntry = z.infer<typeof matchEntry>;

export const matchesResponse = z.object({
  items: z.array(matchEntry),
  nextCursor: z.string().nullable(),
});

/** Força que vira notificação na hora (PLAN §5.3). O resto só aparece na aba. */
export const MATCH_NOTIFY_STRENGTH = 3;

/**
 * E6 — o payload é `unknown` de propósito: cada `type` tem a sua forma, e
 * congelar aqui obrigaria a subir o contrato a cada notificação nova. Quem
 * decide o que renderizar é a tela, pelo `type`.
 */
export const notification = z.object({
  id: z.uuid(),
  type: z.string(),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});

export const notificationsResponse = z.object({
  items: z.array(notification),
  /** O badge. Zera quando a tela marca como lidas. */
  unread: z.number().int(),
});
export type NotificationsResponse = z.infer<typeof notificationsResponse>;

export const authResponse = authTokens.extend({ user: sessionUser });
export type AuthResponse = z.infer<typeof authResponse>;

  /** Degrau 2 da fila vazia: o usuário aceitou rever o que já descartou. */
/**
 * Vocabulário do `relaxed` — os degraus de degradação do PLAN §5.2.
 *
 * Os quatro primeiros são o degrau 1 (filtro afrouxado, na ordem da escada);
 * `dislikes` é o degrau 2 aceito, `recycle-offer` é o degrau 2 oferecido e
 * `exhausted` é o degrau 3. Existe para o cliente ter uma frase por caso —
 * deck vazio sem explicação é o que o degrau proíbe.
 */
export const feedRelaxation = z.enum([
  "year",
  "genre",
  "type",
  "language",
  "dislikes",
  "recycle-offer",
  "exhausted",
]);
export type FeedRelaxation = z.infer<typeof feedRelaxation>;
