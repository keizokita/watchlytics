import { eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  GENRE_IDS,
  ONBOARDING_SWIPES,
  type OnboardingDeck,
  type Title,
} from "@watchlytics/contract";
import { requireUserId } from "../auth.ts";
import { db } from "../db/client.ts";
import { swipes, titles, users } from "../db/schema.ts";
import { toTitle } from "./feed.ts";

/**
 * D4 — a porta de entrada: gêneros → 20 swipes → feed calibrado (PLAN §1.10).
 *
 * Não há rota para calibrar nada. O `taste_vector` é recalculado pelo feed a
 * partir dos swipes (A4, `recomputeWeights`), então os 20 swipes obrigatórios
 * calibram por construção — este arquivo só garante que eles cubram gêneros
 * diferentes, senão as 19 dimensões saem com 18 delas no 0.5 do Laplace.
 */

/**
 * Estratificado = round-robin entre gêneros, não top-20 global.
 *
 * `row_number() PARTITION BY g` dá a posição do título dentro de cada gênero;
 * ordenar por essa posição entrega primeiro o melhor de cada gênero, depois o
 * segundo de cada, e assim por diante. O `min(rn)` desempata título de vários
 * gêneros — quem é o primeiro de Terror não volta na rodada de Drama.
 *
 * Duas consultas em vez de uma porque `db.execute` devolve as chaves em
 * snake_case, e o `toTitle` do feed espera a linha mapeada pelo drizzle. Pegar
 * os ids no SQL e o resto no builder reusa o conversor em vez de manter um
 * segundo.
 *
 * ponytail: o PLAN §1.10 fala de "pool estático precomputado". Com a fixture de
 * 94 títulos isso seria cache de uma consulta que roda em milissegundos. Vira
 * tabela materializada quando o catálogo passar de alguns milhares.
 */
async function stratified(
  userId: string,
  genres: readonly number[],
  limit: number,
): Promise<Title[]> {
  const pick = async (from: readonly number[]) => {
    const rows = await db.execute(sql`
      SELECT id, min(rn) AS rn
        FROM (SELECT t.id,
                     row_number() OVER (PARTITION BY g
                                        ORDER BY t.score DESC, t.id) AS rn
                FROM ${titles} t, unnest(t.genre_ids) g
               WHERE g = ANY(${`{${from.join(",")}}`}::smallint[])
                 AND NOT EXISTS (SELECT 1
                                   FROM ${swipes} s
                                  WHERE s.user_id = ${userId}::uuid
                                    AND s.title_id = t.id)) p
       GROUP BY id
       ORDER BY rn, id
       LIMIT ${limit}`);
    return (rows as unknown as { id: string }[]).map((r) => r.id);
  };

  let ids = await pick(genres);
  // Um gênero só escolhido pode não ter 20 títulos por decidir, e onboarding
  // que não fecha tranca o app inteiro. O sinal preferido já foi coletado nos
  // primeiros; o resto do catálogo completa.
  if (ids.length < limit && genres.length < GENRE_IDS.length) {
    const rest = await pick(GENRE_IDS);
    ids = [...ids, ...rest.filter((id) => !ids.includes(id))].slice(0, limit);
  }
  if (ids.length === 0) return [];

  const rows = await db.select().from(titles).where(inArray(titles.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // A ordem é a do SQL: `inArray` não a preserva.
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toTitle(row)] : [];
  });
}

export function onboardingRoutes(app: FastifyInstance): void {
  app.get("/v1/onboarding/deck", async (req): Promise<OnboardingDeck> => {
    const userId = requireUserId(req);

    const [me] = await db
      .select({ genres: users.preferredGenres })
      .from(users)
      .where(eq(users.id, userId));

    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(swipes)
      .where(eq(swipes.userId, userId));

    const genres = me?.genres ?? [];
    const remaining = Math.max(0, ONBOARDING_SWIPES - (counted?.n ?? 0));

    return {
      genres,
      remaining,
      items:
        remaining === 0
          ? []
          : await stratified(
              userId,
              genres.length > 0 ? genres : GENRE_IDS,
              ONBOARDING_SWIPES,
            ),
    };
  });
}
