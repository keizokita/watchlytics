import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { swipeBatch } from "@watchlytics/contract";
import { requireUserId } from "../auth.ts";
import { db } from "../db/client.ts";
import { swipes, titles } from "../db/schema.ts";

export function swipeRoutes(app: FastifyInstance) {
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
   * A7 — undo. Idempotente de propósito: 204 tendo apagado linha ou não.
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
}
