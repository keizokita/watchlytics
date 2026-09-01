import { and, desc, eq, gt, inArray, notExists, or, sql } from "drizzle-orm";
import Fastify from "fastify";
import { z } from "zod";
import { swipeBatch, type Title } from "@watchlytics/contract";
import { requireUserId } from "./auth.ts";
import { db, pg } from "./db/client.ts";
import { swipes, titles } from "./db/schema.ts";

/** Dislike volta ao feed depois disso, despriorizado. PLAN §0 item 4. */
const DISLIKE_RECYCLE_DAYS = 180;

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

export function buildServer() {
  const app = Fastify();

  app.get("/health", async () => ({ ok: true }));

  /**
   * Lote de 20 ordenado por score, sem o que o usuário já avaliou.
   *
   * Filtros são A1; boost por gênero e ruído são A4; degradação da fila vazia
   * é A5. Aqui só o feed base com a exclusão.
   */
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

  /**
   * A0 — recebe o buffer offline do cliente.
   *
   * Idempotente por construção: a PK (user_id, title_id) transforma reenvio em
   * upsert. Sem UUID de request, sem tabela de dedup.
   */
  app.post("/v1/swipes", async (req, reply) => {
    const userId = requireUserId();

    const parsed = swipeBatch.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "lote inválido", detail: parsed.error.issues };
    }

    // Dedup DENTRO do lote é obrigatório, não otimização: o Postgres recusa um
    // ON CONFLICT DO UPDATE que afete a mesma linha duas vezes. O buffer
    // offline pode ter o mesmo título repetido — a última decisão vence.
    const byTitle = new Map(parsed.data.map((s) => [s.titleId, s]));
    const ids = [...byTitle.keys()];

    // Título desconhecido não pode envenenar o lote inteiro: o cliente ficaria
    // reenviando para sempre. Filtramos e devolvemos a contagem.
    const known = new Set(
      (
        await db
          .select({ id: titles.id })
          .from(titles)
          .where(inArray(titles.id, ids))
      ).map((r) => r.id),
    );

    const now = Date.now();
    const rows = [...byTitle.values()]
      .filter((s) => known.has(s.titleId))
      .map((s) => {
        // clientTs é do cliente, logo não confiável: no futuro, nunca.
        // Importa porque a janela de reciclagem do dislike conta a partir dele.
        const at = new Date(Math.min(Date.parse(s.clientTs), now));
        return {
          userId,
          titleId: s.titleId,
          direction: s.direction,
          createdAt: at,
          updatedAt: at,
        };
      });

    if (rows.length) {
      await db
        .insert(swipes)
        .values(rows)
        .onConflictDoUpdate({
          target: [swipes.userId, swipes.titleId],
          set: {
            direction: sql`excluded.direction`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    return { accepted: rows.length, skipped: ids.length - rows.length };
  });

  /**
   * B7 — undo. Idempotente de propósito: 204 tendo apagado linha ou não.
   * O cliente pode chamar depois de já ter removido o swipe da fila local.
   */
  app.delete<{ Params: { titleId: string } }>(
    "/v1/swipes/:titleId",
    async (req, reply) => {
      const userId = requireUserId();
      const titleId = req.params.titleId;

      if (!z.uuid().safeParse(titleId).success) {
        reply.code(400);
        return { error: "titleId inválido" };
      }

      await db
        .delete(swipes)
        .where(and(eq(swipes.userId, userId), eq(swipes.titleId, titleId)));

      reply.code(204);
      return null;
    },
  );

  return app;
}

if (import.meta.main) {
  const port = Number(process.env["PORT"] ?? 3000);
  const app = buildServer();
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`api em http://localhost:${port}`);

  // Sem isso o Fly manda SIGTERM, espera, e mata com SIGKILL a cada deploy —
  // derrubando requisição em voo e deixando conexão pendurada no Postgres.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, async () => {
      await app.close();
      await pg.end();
      process.exit(0);
    });
  }
}
