import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NotificationsResponse } from "@watchlytics/contract";
import { requireUserId } from "../auth.ts";
import { db } from "../db/client.ts";
import { notifications } from "../db/schema.ts";

/**
 * E6 — a caixa de notificações e o badge.
 *
 * Sem push e sem websocket: o cliente pergunta de minuto em minuto (PLAN §7).
 * Uma conexão viva por usuário custaria uma máquina a mais no Fly para
 * entregar aviso de amizade, que ninguém precisa ver no mesmo segundo.
 */

/** Cabe numa tela rolada com folga; o resto é histórico que ninguém abre. */
const PAGE = 50;

export function notificationRoutes(app: FastifyInstance): void {
  app.get("/v1/notifications", async (req): Promise<NotificationsResponse> => {
    const userId = requireUserId(req);

    const items = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(PAGE);

    // Contado no banco, não sobre `items`: o badge tem que valer para a caixa
    // inteira, senão ele para de crescer na quinquagésima notificação.
    const [naoLidas] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

    return {
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        payload: n.payload,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
      unread: naoLidas?.n ?? 0,
    };
  });

  /**
   * "Badge zera ao abrir": marca a caixa inteira, não item por item. Ler é
   * abrir a lista — pedir um clique por notificação só para zerar o badge é
   * trabalho que o usuário não pediu.
   */
  app.post("/v1/notifications/read", async (req) => {
    const userId = requireUserId(req);

    const lidas = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });

    return { unread: 0, marked: lidas.length };
  });
}
