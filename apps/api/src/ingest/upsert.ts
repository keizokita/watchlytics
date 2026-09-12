import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { titleExternalIds, titles } from "../db/schema.ts";
import type { Normalized } from "./tmdb.ts";

/**
 * A única escrita de título vinda do TMDB — a porta de idempotência.
 *
 * Era a função privada `upsert()` do `run.ts`. Saiu de lá pelo mesmo motivo que
 * o `get()` saiu no I0.2: a I2.1 precisa gravar exatamente os mesmos campos
 * pela exatamente mesma porta, e a alternativa seria uma segunda cópia. Duas
 * cópias de uma escrita divergem no primeiro campo novo — e a divergência
 * aparece como "o título atualizado pelo /changes não tem o que a carga grava",
 * que é caro de descobrir.
 *
 * **`title_external_ids` com provider='tmdb' é a porta, e o nosso uuid NUNCA
 * muda.** É ele que `swipes`, `library_entries` e `matches` referenciam: trocar
 * o id de um título por causa de uma reingestão apagaria o histórico de quem já
 * avaliou. Por isso a linha existente é atualizada no lugar, nunca substituída.
 */
const PROVIDER = "tmdb";

export type Resultado = "inserido" | "atualizado";

/** `null` em dry-run: nada foi escrito, e contar seria mentir no relatório. */
export async function upsert(
  n: Normalized,
  opts: { dry?: boolean } = {},
): Promise<Resultado | null> {
  if (opts.dry) return null;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ titleId: titleExternalIds.titleId })
      .from(titleExternalIds)
      .where(
        and(
          eq(titleExternalIds.provider, PROVIDER),
          eq(titleExternalIds.externalId, n.externalId),
        ),
      );

    const values = {
      type: n.type,
      title: n.title,
      originalTitle: n.originalTitle,
      overview: n.overview,
      posterUrl: n.posterUrl,
      backdropUrl: n.backdropUrl,
      releaseYear: n.releaseYear,
      originalLanguage: n.originalLanguage,
      genreIds: n.genreIds,
      score: n.score,
      voteAverage: n.voteAverage,
      voteCount: n.voteCount,
      syncedAt: new Date(),
    };

    if (existing) {
      // Título, sinopse e pôster mudam no TMDB. Nosso id nunca — é o que os
      // swipes e os matches referenciam.
      await tx.update(titles).set(values).where(eq(titles.id, existing.titleId));
      return "atualizado";
    }

    const [row] = await tx.insert(titles).values(values).returning({ id: titles.id });
    if (!row) throw new Error(`insert falhou para tmdb:${n.externalId}`);
    await tx
      .insert(titleExternalIds)
      .values({ titleId: row.id, provider: PROVIDER, externalId: n.externalId })
      .onConflictDoNothing();
    return "inserido";
  });
}

/**
 * Marca o título como CONFERIDO sem reescrever nada.
 *
 * Existe para o caso que parece não ter caso: perguntamos ao TMDB e a resposta
 * não deu upsert — o título saiu do acervo deles (404), ou voltou sem pôster e
 * o `normalize` o rejeitou. Sem carimbar, `synced_at` fica velho para sempre e
 * o título reentra na fila fria de toda passada, gastando a mesma requisição
 * todo dia, eternamente. É a mesma lição do `credits_synced_at` na I1.1:
 * "buscado e rejeitado" não é "nunca buscado".
 *
 * E NUNCA apaga. As FKs são `ON DELETE CASCADE`: um `DELETE` aqui levaria junto
 * swipe, biblioteca e match de quem já avaliou o título.
 */
export async function carimbarConferido(titleId: string): Promise<void> {
  await db.update(titles).set({ syncedAt: new Date() }).where(eq(titles.id, titleId));
}
