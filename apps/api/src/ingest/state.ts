import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { ingestState } from "../db/schema.ts";

/**
 * I2 — o estado das varreduras de ingestão, em `ingest_state` (I0.2).
 *
 * Duas chaves, uma por varredura: `changes_cursor` (I2.1) e `backfill_cursor`
 * (I2.3). Ficam aqui e não em cada comando porque a regra que vale para as duas
 * é a mesma e é fácil de errar: **o cursor avança mesmo quando a passada não
 * encontrou nada**. Uma janela do `/changes` sem nenhum título nosso alterado é
 * trabalho concluído, não trabalho a refazer — se ela não avançasse, a varredura
 * de amanhã releria a de hoje, e a de depois releria as duas.
 *
 * É por isso também que o cursor não se deriva de `titles`: `max(synced_at)` diz
 * quando escrevemos pela última vez, nunca até que dia já perguntamos.
 */

/** `null` quando a chave nunca foi gravada — que é diferente de gravada vazia. */
export async function lerEstado<T>(key: string): Promise<T | null> {
  const [linha] = await db
    .select({ value: ingestState.value })
    .from(ingestState)
    .where(eq(ingestState.key, key));
  return (linha?.value as T | undefined) ?? null;
}

/**
 * Grava a chave inteira, sem merge: o valor é pequeno e tem um dono só por
 * chave. Merge parcial aqui só criaria a pergunta "quem apagou meu campo?" numa
 * tabela que existe justamente para ser simples de ler.
 */
export async function gravarEstado(key: string, value: unknown): Promise<void> {
  await db
    .insert(ingestState)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: ingestState.key,
      set: { value, updatedAt: new Date() },
    });
}

// ─── I2.3: retomada da carga inicial ────────────────────────────────────────

export const CHAVE_BACKFILL = "backfill_cursor";

/**
 * O último ano CONCLUÍDO da carga, e a régua com que ele foi concluído.
 *
 * Concluído, não "em andamento": um ano interrompido no meio tem que ser
 * refeito inteiro. Refazer um ano é idempotente e custa minutos; pular um ano
 * meio carregado deixa um buraco que nada mais fecha.
 */
export type Backfill = { ano: number; regua: string };

/**
 * A assinatura dos parâmetros da carga. O cursor só vale para a MESMA régua.
 *
 * Sem isto, rodar `--min-votes 300` depois de uma carga com 800 retomaria em
 * 2003 como se os anos anteriores já tivessem sido varridos com 300 — e eles
 * não foram. O erro seria silencioso e do pior tipo: um catálogo que parece
 * completo e tem duas metades com critérios diferentes.
 */
export const regua = (p: {
  from: number;
  to: number;
  minVotes: number;
  minVotesAnime: number;
  minVotesReality: number;
}) =>
  `${p.from}-${p.to}/${p.minVotes}/${p.minVotesAnime}/${p.minVotesReality}`;

/**
 * Em que ano a carga recomeça. Pura: o teste alcança sem banco.
 *
 * "Morreu em 2003, recomeça em 2003" — o cursor guarda 2002 como último ano
 * concluído, então a retomada é `ano + 1`.
 *
 * Carga anterior COMPLETA volta para o começo, não vira comando que não faz
 * nada: revarrer os anos é como título novo entra no catálogo (o `/changes` da
 * I2.1 só atualiza o que já temos, por decisão explícita lá).
 */
export function anoDeRetomada(
  cursor: Backfill | null,
  assinatura: string,
  from: number,
  to: number,
): { ano: number; motivo: string } {
  if (!cursor) return { ano: from, motivo: "sem cursor: carga do começo" };
  if (cursor.regua !== assinatura) {
    return { ano: from, motivo: `régua mudou (${cursor.regua}): carga do começo` };
  }
  if (cursor.ano < from || cursor.ano >= to) {
    return { ano: from, motivo: `carga anterior completa em ${cursor.ano}: recomeçando` };
  }
  return { ano: cursor.ano + 1, motivo: `retomando de ${cursor.ano + 1}` };
}
