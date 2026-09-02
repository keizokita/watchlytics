import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  feedQuery,
  GENRES,
  type FeedQuery,
  type FeedRelaxation,
  type FeedResponse,
  type Title,
} from "@watchlytics/contract";
import { requireUserId } from "../auth.ts";
import { db } from "../db/client.ts";
import { swipes, titles, users } from "../db/schema.ts";

/** Lote do PLAN §5.2. O cliente pede os próximos quando restam 5. */
const PAGE = 20;

/** Dislike volta ao feed depois disso. PLAN §1 item 13. */
const DISLIKE_RECYCLE_DAYS = 180;

/**
 * Escada da degradação (A5). PLAN §5.2 fecha em ano → gênero → tipo; `language`
 * entra no fim porque nasceu depois do plano e sem ele um filtro de idioma
 * sozinho não teria degrau nenhum — daria deck vazio, que é o que a escada proíbe.
 */
const LADDER = ["year", "genre", "type", "language"] as const;
type Relaxable = (typeof LADDER)[number];

type Row = typeof titles.$inferSelect;

/** numeric volta como string do postgres.js; o contrato pede número. */
const toTitle = (r: Row): Title => ({
  id: r.id,
  type: r.type as Title["type"],
  title: r.title,
  originalTitle: r.originalTitle,
  overview: r.overview,
  posterUrl: r.posterUrl,
  backdropUrl: r.backdropUrl,
  releaseYear: r.releaseYear,
  runtimeMinutes: r.runtimeMinutes,
  originalLanguage: r.originalLanguage,
  genreIds: r.genreIds,
  score: r.score,
  voteAverage: Number(r.voteAverage ?? 0),
});

// ─── cursor (A3) ────────────────────────────────────────────────────────────

/**
 * Keyset, não OFFSET: entre uma página e outra o usuário swipa, as linhas sob o
 * offset somem e a página seguinte pularia títulos.
 *
 * `seed` viaja no cursor porque o ruído é semeado (ver `scoreExpr`): sem ele a
 * segunda página reembaralharia e repetiria item — que é justamente o teste de A3.
 */
const cursorPayload = z.object({
  seed: z.number().int(),
  score: z.number(),
  id: z.uuid(),
});
type Cursor = z.infer<typeof cursorPayload>;

const encodeCursor = (c: Cursor) =>
  Buffer.from(JSON.stringify(c)).toString("base64url");

function decodeCursor(raw: string): Cursor | null {
  try {
    const json: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    return cursorPayload.parse(json);
  } catch {
    return null; // cursor de outra versão ou adulterado: 400, não 500
  }
}

// ─── boost por gênero (A4) ──────────────────────────────────────────────────

/**
 * peso(gênero) = (likes + 1) / (swipes + 2) — Laplace, PLAN §5.4.
 *
 * A suavização é o que faz o usuário novo funcionar: sem swipe nenhum todo
 * gênero vale 1/2, o boost fica uniforme e o feed é só popularidade.
 *
 * A posição no vetor é `id - 1`: `GENRES` é 1..19 contíguo e genres.ts proíbe
 * inserir no meio justamente para esta indexação (e a do `taste_vector`) valer.
 */
async function recomputeWeights(userId: string): Promise<number[]> {
  const rows = await db.execute(sql`
    SELECT g AS genre,
           count(*) FILTER (WHERE ${swipes.direction} = 1) AS likes,
           count(*) AS total
      FROM ${swipes}
      JOIN ${titles} ON ${titles.id} = ${swipes.titleId},
           unnest(${titles.genreIds}) g
     WHERE ${swipes.userId} = ${userId}
     GROUP BY g`);

  const weights = GENRES.map(() => 0.5);
  for (const r of rows as unknown as Record<string, unknown>[]) {
    const i = Number(r["genre"]) - 1;
    if (i < 0 || i >= weights.length) continue; // gênero fora da tabela: ignora
    weights[i] = (Number(r["likes"]) + 1) / (Number(r["total"]) + 2);
  }

  await db
    .update(users)
    .set({ tasteVector: weights })
    .where(eq(users.id, userId));

  return weights;
}

/**
 * Recalcula na primeira página e reusa o gravado nas seguintes.
 *
 * Duas razões: o boost precisa ficar congelado durante a paginação (mudou o
 * peso, mudou a ordem, e o keyset passa a pular ou repetir), e assim o vetor é
 * recalculado uma vez por sessão de feed em vez de a cada swipe.
 *
 * ponytail: teto é um UPDATE por abertura de feed. Quando doer, mover o cálculo
 * para o POST /v1/swipes a cada N swipes — a leitura aqui já não muda.
 */
async function weightsFor(userId: string, paging: boolean): Promise<number[]> {
  if (paging) {
    const [row] = await db
      .select({ v: users.tasteVector })
      .from(users)
      .where(eq(users.id, userId));
    if (row?.v?.length === GENRES.length) return row.v;
  }
  return recomputeWeights(userId);
}

/**
 * score × (1 + Σ pesos dos gêneros do título) × (0.85 + ruído × 0.3) — PLAN §5.4.
 *
 * O ruído é `hashtextextended(id, seed)` e não `random()`: multiplicativo e
 * variando a cada feed novo (semente nova), mas estável dentro de uma paginação.
 * Feed determinístico parece quebrado; feed que reembaralha entre páginas repete
 * card, que parece pior ainda.
 */
function scoreExpr(weights: number[], seed: number): SQL<number> {
  const literal = `{${weights.join(",")}}`;
  return sql<number>`${titles.score}::float8
    * (1 + (SELECT coalesce(sum((${literal}::float8[])[g]), 0)
              FROM unnest(${titles.genreIds}) g))
    * (0.85 + 0.3 * (hashtextextended(${titles.id}::text, ${seed}::int8)
                     & 2147483647)::float8 / 2147483647.0)`;
}

// ─── filtros (A1) ───────────────────────────────────────────────────────────

/**
 * A2 — o que o usuário já decidiu não volta. Like nunca; dislike depois de 180
 * dias, ou já (`recycle`), que é o degrau 2 da fila vazia.
 */
const notDecided = (userId: string, recycle: boolean) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(swipes)
      .where(
        and(
          eq(swipes.userId, userId),
          eq(swipes.titleId, titles.id),
          recycle
            ? eq(swipes.direction, 1)
            : or(
                eq(swipes.direction, 1),
                gt(
                  swipes.updatedAt,
                  sql`now() - make_interval(days => ${DISLIKE_RECYCLE_DAYS})`,
                ),
              ),
        ),
      ),
  );

/** Um filtro só conta na escada de degradação se o usuário pediu por ele. */
const isSet = (q: FeedQuery, f: Relaxable): boolean =>
  f === "year"
    ? q.yearFrom !== undefined || q.yearTo !== undefined
    : f === "genre"
      ? !!q.genres?.length
      : f === "type"
        ? !!q.types?.length
        : !!q.languages?.length;

function filters(q: FeedQuery, dropped: readonly Relaxable[]): SQL[] {
  const keep = (f: Relaxable) => isSet(q, f) && !dropped.includes(f);
  const out: SQL[] = [];

  if (keep("type")) out.push(inArray(titles.type, q.types!));
  if (keep("genre")) {
    // `&&` (overlap) casa o índice GIN de genre_ids: um dos gêneros basta.
    out.push(sql`${titles.genreIds} && ${`{${q.genres!.join(",")}}`}::smallint[]`);
  }
  if (keep("year")) {
    if (q.yearFrom !== undefined) out.push(gte(titles.releaseYear, q.yearFrom));
    if (q.yearTo !== undefined) out.push(lte(titles.releaseYear, q.yearTo));
  }
  if (keep("language")) out.push(inArray(titles.originalLanguage, q.languages!));

  return out;
}

// ─── a query ────────────────────────────────────────────────────────────────

/**
 * O score vive em subquery porque o keyset compara contra ele: `(final, id) <
 * (cursor.score, cursor.id)` precisa do valor nomeado, e repetir a expressão nos
 * três lugares (select, where, order by) é como se erra a paginação.
 *
 * ponytail: a subquery calcula o score de todo candidato antes de cortar. Com a
 * fixture é ruído; passando de ~50k títulos, materializar o top-N por score num
 * CTE antes do boost é o próximo passo.
 *
 * Devolve o builder, não o resultado: o teste de A6 chama `.toSQL()` para dar
 * EXPLAIN na query de verdade, e não numa cópia que envelhece à parte.
 */
export function feedPage(
  q: FeedQuery,
  userId: string,
  opts: {
    weights: number[];
    seed: number;
    recycle: boolean;
    dropped: readonly Relaxable[];
    after: Cursor | null;
  },
) {
  const scored = db
    .select({
      ...getTableColumns(titles),
      final: scoreExpr(opts.weights, opts.seed).as("final"),
    })
    .from(titles)
    .where(
      and(...filters(q, opts.dropped), notDecided(userId, opts.recycle)),
    )
    .as("f");

  return db
    .select()
    .from(scored)
    .where(
      opts.after
        ? sql`(${scored.final}, ${scored.id}) < (${opts.after.score}::float8, ${opts.after.id}::uuid)`
        : undefined,
    )
    .orderBy(desc(scored.final), desc(scored.id))
    .limit(PAGE);
}

/** `?genres=1,2` e `?genres=1&genres=2` são a mesma coisa. */
function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  return (Array.isArray(v) ? v : [v])
    .flatMap((x: unknown) => String(x).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── rota ───────────────────────────────────────────────────────────────────

export function feedRoutes(app: FastifyInstance) {
  app.get("/v1/feed", async (req, reply) => {
    const userId = requireUserId();
    const raw = (req.query ?? {}) as Record<string, unknown>;

    const parsed = feedQuery.safeParse({
      types: list(raw["types"]),
      genres: list(raw["genres"])?.map(Number),
      yearFrom: raw["yearFrom"],
      yearTo: raw["yearTo"],
      languages: list(raw["languages"])?.map((s) => s.toLowerCase()),
      cursor: raw["cursor"],
      recycle: raw["recycle"],
    });
    if (!parsed.success) {
      reply.code(400);
      return { error: "filtros inválidos", detail: parsed.error.issues };
    }
    const q = parsed.data;

    const after = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !after) {
      reply.code(400);
      return { error: "cursor inválido" };
    }

    const recycle = q.recycle === true;
    const seed = after?.seed ?? Math.floor(Math.random() * 2 ** 31);
    const weights = await weightsFor(userId, after !== null);

    // A5, degrau 1: tenta com tudo, depois vai soltando na ordem da escada.
    // Só entra na escada o filtro que o usuário realmente pediu.
    const relaxable = LADDER.filter((f) => isSet(q, f));
    for (let n = 0; n <= relaxable.length; n++) {
      const dropped = relaxable.slice(0, n);
      const rows = await feedPage(q, userId, {
        weights,
        seed,
        recycle,
        dropped,
        after,
      });

      const last = rows.at(-1);
      if (!last) continue;

      const relaxed: FeedRelaxation[] = recycle
        ? ["dislikes", ...dropped]
        : [...dropped];

      const res: FeedResponse = {
        items: rows.map(toTitle),
        // Página cheia significa "pode haver mais", não "há mais": a última
        // página cheia entrega um cursor que devolve vazio. Barato, e o cliente
        // já sabe tratar vazio — é o degrau 3.
        nextCursor:
          rows.length === PAGE
            ? encodeCursor({ seed, score: last.final, id: last.id })
            : null,
        ...(relaxed.length ? { relaxed } : {}),
      };
      return res;
    }

    // A5, degrau 2: sobrou o que ele descartou. Oferece, não impõe — o cliente
    // repete a chamada com ?recycle=1.
    if (!recycle) {
      const [pending] = await db
        .select({ one: sql`1` })
        .from(swipes)
        .where(and(eq(swipes.userId, userId), eq(swipes.direction, -1)))
        .limit(1);
      if (pending) {
        return {
          items: [],
          nextCursor: null,
          relaxed: ["recycle-offer"],
        } satisfies FeedResponse;
      }
    }

    // A5, degrau 3: acabou mesmo. O plano manda ingerir mais páginas do
    // fornecedor aqui — não há fornecedor no v1 (PLAN §5.1), então resta a
    // mensagem. Que é o requisito: nunca deck vazio sem explicação.
    return {
      items: [],
      nextCursor: null,
      relaxed: ["exhausted"],
    } satisfies FeedResponse;
  });
}
