import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { TASTE_VECTOR_DIM } from "@watchlytics/contract";

/** Função, não constante: reusar a mesma instância de builder entre tabelas quebra. */
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ─── identidade ─────────────────────────────────────────────────────────────

/**
 * `handle` e `email` são armazenados SEMPRE em minúsculas, normalizados na
 * borda da API. Evita a extensão citext e o índice funcional que ela pouparia.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  email: text("email"), // informativo, NUNCA chave de login
  avatarUrl: text("avatar_url"),
  isPublic: boolean("is_public").notNull().default(false),
  preferredGenres: smallint("preferred_genres").array(),
  tasteVector: vector("taste_vector", { dimensions: TASTE_VECTOR_DIM }),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const identities = pgTable(
  "identities",
  {
    provider: text("provider").notNull(), // google | apple
    providerUserId: text("provider_user_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailAtProvider: text("email_at_provider"),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerUserId] }),
    index("identities_user").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

// ─── catálogo ───────────────────────────────────────────────────────────────

export const genres = pgTable("genres", {
  id: smallint("id").primaryKey(),
  name: text("name").notNull(),
});

export const titles = pgTable(
  "titles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(), // movie | tv
    title: text("title").notNull(),
    originalTitle: text("original_title"),
    overview: text("overview").notNull(),
    /** NULL enquanto não houver fornecedor: o card cai no gradiente. */
    posterUrl: text("poster_url"),
    backdropUrl: text("backdrop_url"),
    releaseYear: smallint("release_year").notNull(),
    runtimeMinutes: smallint("runtime_minutes"),
    originalLanguage: char("original_language", { length: 2 }).notNull(),
    /** IDs NOSSOS (contract/genres.ts), nunca de fornecedor. */
    genreIds: smallint("genre_ids").array().notNull(),
    /** Popularidade normalizada 0-100. Métrica nossa — nenhum fornecedor vaza daqui. */
    score: smallint("score").notNull().default(0),
    voteAverage: numeric("vote_average", { precision: 3, scale: 1 }),
    voteCount: integer("vote_count"),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (t) => [
    index("titles_genres_gin").using("gin", t.genreIds),
    index("titles_score")
      .on(sql`${t.score} DESC`)
      .where(sql`${t.score} > 10`),
    check("titles_type_valid", sql`${t.type} IN ('movie','tv')`),
  ],
);

/** A porta de troca de fornecedor. A fixture entra por aqui como provider='fixture'. */
export const titleExternalIds = pgTable(
  "title_external_ids",
  {
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.externalId] }),
    unique("title_external_ids_one_per_provider").on(t.titleId, t.provider),
  ],
);

// ─── decisão e catálogo pessoal ─────────────────────────────────────────────

/**
 * Upsert, NÃO append-only (PLAN §4). Uma linha por (user, title).
 *
 * A PK composta entrega dedup, o "já avaliei?" do feed e a idempotência do
 * envio em lote do buffer offline — sem UUID de request nem tabela de dedup.
 *
 * ponytail: descarta o histórico de swipes. Se análise comportamental virar
 * requisito, criar swipe_events append-only — sem mexer nesta tabela.
 */
export const swipes = pgTable(
  "swipes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    direction: smallint("direction").notNull(), // 1 = like, -1 = dislike
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.titleId] }),
    // O índice do match: caminho inverso, só likes.
    index("swipes_likes_by_title")
      .on(t.titleId, t.userId)
      .where(sql`${t.direction} = 1`),
    check("swipes_direction_valid", sql`${t.direction} IN (1,-1)`),
  ],
);

export const libraryEntries = pgTable(
  "library_entries",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // interested | watched
    rating: smallint("rating"),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    watchedAt: timestamp("watched_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.titleId] }),
    index("library_by_user_status").on(t.userId, t.status, sql`added_at DESC`),
    check("library_status_valid", sql`${t.status} IN ('interested','watched')`),
    check(
      "library_rating_range",
      sql`${t.rating} IS NULL OR ${t.rating} BETWEEN 1 AND 5`,
    ),
  ],
);

// ─── social ─────────────────────────────────────────────────────────────────

/** Par sempre normalizado user_a < user_b: mata o bug das duas linhas invertidas. */
export const friendships = pgTable(
  "friendships",
  {
    userA: uuid("user_a")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userB: uuid("user_b")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // pending | accepted | blocked
    createdAt: createdAt(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userA, t.userB] }),
    index("friendships_incoming").on(t.userB, t.status),
    check("friendships_ordered", sql`${t.userA} < ${t.userB}`),
    check(
      "friendships_status_valid",
      sql`${t.status} IN ('pending','accepted','blocked')`,
    ),
  ],
);

export const matches = pgTable(
  "matches",
  {
    userA: uuid("user_a")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userB: uuid("user_b")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    strength: smallint("strength").notNull(), // 3 forte | 2 média | 1 fraca
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userA, t.userB, t.titleId] }),
    check("matches_ordered", sql`${t.userA} < ${t.userB}`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_unread")
      .on(t.userId)
      .where(sql`${t.readAt} IS NULL`),
  ],
);

export const consents = pgTable(
  "consents",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    version: text("version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ip: text("ip"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.version] })],
);

