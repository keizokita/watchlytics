import { and, desc, eq, gt, notExists, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Title } from "@watchlytics/contract";
import { requireUserId } from "../auth.ts";
import { db } from "../db/client.ts";
import { swipes, titles } from "../db/schema.ts";

/** Dislike volta ao feed depois disso, despriorizado. PLAN §0 item 4. */
const DISLIKE_RECYCLE_DAYS = 180;

type Row = typeof titles.$inferSelect;

/** numeric volta como string do postgres.js; o contrato pede número. */
export const toTitle = (r: Row): Title => ({
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

/**
 * Lote de 20 ordenado por score, sem o que o usuário já avaliou.
 *
 * Filtros são A1; paginação é A3; boost por gênero e ruído são A4; degradação
 * da fila vazia é A5. Aqui só o feed base com a exclusão.
 */
export function feedRoutes(app: FastifyInstance) {
  app.get("/v1/feed", async () => {
    const userId = requireUserId();

    const rows = await db
      .select()
      .from(titles)
      .where(
        notExists(
          db
            .select({ one: sql`1` })
            .from(swipes)
            .where(
              and(
                eq(swipes.userId, userId),
                eq(swipes.titleId, titles.id),
                or(
                  // like nunca volta; dislike volta depois da janela
                  eq(swipes.direction, 1),
                  gt(
                    swipes.updatedAt,
                    sql`now() - make_interval(days => ${DISLIKE_RECYCLE_DAYS})`,
                  ),
                ),
              ),
            ),
        ),
      )
      .orderBy(desc(titles.score))
      .limit(20);

    return { items: rows.map(toTitle), nextCursor: null };
  });
}
