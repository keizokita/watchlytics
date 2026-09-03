import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  libraryInput,
  libraryStatus,
  STATS_MIN_WATCHED,
  type LibraryEntry,
  type ProfileStats,
} from "@watchlytics/contract";
import { requireUserId } from "../auth.ts";
import { db } from "../db/client.ts";
import { libraryEntries, swipes, titles } from "../db/schema.ts";
import { toTitle } from "./feed.ts";

const uuid = z.uuid();

/** Década de um ano: 1994 → 1990. */
const decadeOf = (year: number) => Math.floor(year / 10) * 10;

export function libraryRoutes(app: FastifyInstance): void {
  /**
   * D1 — grava status e nota.
   *
   * PUT é substituição: mandar `{ status }` sem `rating` apaga a nota. O
   * contrato documenta isso; a tela sempre manda os dois.
   */
  app.put<{ Params: { titleId: string } }>(
    "/v1/library/:titleId",
    async (req, reply) => {
      const userId = requireUserId();

      if (!uuid.safeParse(req.params.titleId).success) {
        reply.code(400);
        return { error: "titleId inválido" };
      }

      const parsed = libraryInput.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "entrada inválida", detail: parsed.error.issues };
      }

      const { status, rating = null } = parsed.data;
      const titleId = req.params.titleId;

      // FK devolveria 500; um título que saiu do catálogo é 404 do cliente.
      const [known] = await db
        .select({ id: titles.id })
        .from(titles)
        .where(eq(titles.id, titleId));
      if (!known) {
        reply.code(404);
        return { error: "título desconhecido" };
      }

      const now = new Date();
      await db
        .insert(libraryEntries)
        .values({
          userId,
          titleId,
          status,
          rating,
          watchedAt: status === "watched" ? now : null,
        })
        .onConflictDoUpdate({
          target: [libraryEntries.userId, libraryEntries.titleId],
          set: {
            status: sql`excluded.status`,
            rating: sql`excluded.rating`,
            // Carimba na PRIMEIRA transição para watched e não reescreve: a
            // data em que a pessoa viu o filme não muda porque ela editou a
            // nota. Voltar para interested zera, senão a coluna passa a mentir
            // sobre o status — e as stats somam quem não assistiu.
            watchedAt: sql`CASE WHEN excluded.status = 'watched'
                                THEN coalesce(${libraryEntries.watchedAt}, excluded.watched_at)
                                ELSE NULL END`,
          },
        });

      reply.code(204);
      return null;
    },
  );

  /** D2 — abas "interessado" e "assistido". */
  app.get<{ Querystring: { status?: string } }>(
    "/v1/library",
    async (req, reply) => {
      const userId = requireUserId();

      const status = libraryStatus.safeParse(req.query.status);
      if (!status.success) {
        reply.code(400);
        return { error: "status inválido" };
      }


      const rows = await db
        .select()
        .from(libraryEntries)
        .innerJoin(titles, eq(titles.id, libraryEntries.titleId))
        .where(
          and(
            eq(libraryEntries.userId, userId),
            eq(libraryEntries.status, status.data),
          ),
        )
        .orderBy(desc(libraryEntries.addedAt));

      const items: LibraryEntry[] = rows.map((r) => ({
        title: toTitle(r.titles),
        status: r.library_entries.status as LibraryEntry["status"],
        rating: r.library_entries.rating,
        addedAt: r.library_entries.addedAt.toISOString(),
        watchedAt: r.library_entries.watchedAt?.toISOString() ?? null,
      }));

      return { items };
    },
  );

  /**
   * D2 — aba "descartados": lê `swipes`, não `library_entries`.
   *
   * Não é detalhe de implementação, é a diferença de ciclo de vida: o dislike
   * é reciclável em 180 dias (PLAN §4) e some sozinho desta lista quando o
   * título volta ao feed. Entrada de catálogo nunca expira.
   */
  app.get("/v1/library/discarded", async () => {
    const userId = requireUserId();

    const rows = await db
      .select()
      .from(swipes)
      .innerJoin(titles, eq(titles.id, swipes.titleId))
      .where(and(eq(swipes.userId, userId), eq(swipes.direction, -1)))
      .orderBy(desc(swipes.updatedAt));

    return { items: rows.map((r) => toTitle(r.titles)) };
  });

  /** D3 — estatísticas do próprio perfil. O D5 usa a MESMA função. */
  app.get("/v1/me/stats", async () => statsOf(requireUserId()));
}

/**
 * Agregados de um usuário qualquer — o dono (D3) ou um perfil público (D5).
 * Uma função só: piso de agregação que vale num lugar e não no outro é
 * exatamente como dado vaza.
 *
 * Agrega em JS de propósito: a lista de assistidos de uma pessoa é limitada
 * pelo tamanho do catálogo, e três GROUP BY (um deles com unnest) para
 * dezenas de linhas é SQL que ninguém vai querer manter.
 *
 * ponytail: vira uma query agregada quando o catálogo passar da casa dos
 * milhares E alguém tiver assistido milhares.
 */
export async function statsOf(userId: string): Promise<ProfileStats> {
  const rows = await db
    .select({
      releaseYear: titles.releaseYear,
      runtimeMinutes: titles.runtimeMinutes,
      genreIds: titles.genreIds,
    })
    .from(libraryEntries)
    .innerJoin(titles, eq(titles.id, libraryEntries.titleId))
    .where(
      and(
        eq(libraryEntries.userId, userId),
        eq(libraryEntries.status, "watched"),
      ),
    );

  // Piso de agregação (PLAN §8.3): abaixo dele o agregado NÃO é calculado,
  // não é só escondido na tela. O que a API não devolve não vaza.
  if (rows.length < STATS_MIN_WATCHED) {
    return { watchedCount: rows.length, aggregates: null } satisfies ProfileStats;
  }

  const byGenre = new Map<number, number>();
  const byDecade = new Map<number, number>();
  let estimatedMinutes = 0;

  for (const r of rows) {
    estimatedMinutes += r.runtimeMinutes ?? 0;
    const decade = decadeOf(r.releaseYear);
    byDecade.set(decade, (byDecade.get(decade) ?? 0) + 1);
    for (const g of r.genreIds) byGenre.set(g, (byGenre.get(g) ?? 0) + 1);
  }

  // Empate desempatado pelo id do gênero / pela década mais recente: sem
  // isso a ordem sai da iteração do Map e a tela muda sozinha entre reloads.
  const topGenres = [...byGenre]
    .sort(([ga, ca], [gb, cb]) => cb - ca || ga - gb)
    .slice(0, 3)
    .map(([genreId, count]) => ({ genreId, count }));

  const decades = [...byDecade].sort(([da, ca], [db, cb]) => cb - ca || db - da);

  return {
    watchedCount: rows.length,
    aggregates: {
      topGenres,
      estimatedMinutes,
      // rows.length >= STATS_MIN_WATCHED garante ao menos uma década.
      favoriteDecade: decades[0]![0],
    },
  } satisfies ProfileStats;
}
