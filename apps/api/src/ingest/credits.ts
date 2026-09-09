import { and, eq, isNull, sql } from "drizzle-orm";
import { titleType } from "@watchlytics/contract";
import { db, pg } from "../db/client.ts";
import { titleExternalIds, titles } from "../db/schema.ts";
import { get } from "./http.ts";
import { TMDB_API } from "./tmdb.ts";

/**
 * I1.1 — segunda passada: o elenco principal de cada título.
 *
 *   npm run ingest:credits -w @watchlytics/api
 *   npm run ingest:credits -w @watchlytics/api -- --limit 200
 *   npm run ingest:credits -w @watchlytics/api -- --dry-run
 *
 * **Comando separado, e não um trecho dentro do `run.ts`.** Três razões, em
 * ordem de peso:
 *
 * 1. `/discover` não aceita `append_to_response`, então elenco é obrigatoriamente
 *    uma requisição a mais POR TÍTULO. Embutir na carga dobraria o tempo dela.
 * 2. A fila aqui é "todo título sem elenco", não "os títulos desta carga". Um
 *    título que entrou semana passada nunca ganharia elenco se isto só rodasse
 *    junto do `/discover`.
 * 3. O `run.ts` é retomável por balde (tipo × ano); este é retomável por
 *    título. Misturar os dois deixaria a granularidade pior das duas.
 *
 * **Rode em série com a carga, não em paralelo.** A janela de 60ms do
 * `http.ts` é estado de módulo, logo por PROCESSO: dois comandos ao mesmo tempo
 * são duas janelas contra a mesma cota do TMDB. Está escrito lá e vale aqui.
 */

/**
 * Guardamos 5, o card mostra 3 (I1.2).
 *
 * O caro é a passada de rede — uma requisição por título, ~9,8 mil títulos —,
 * não os bytes. Se o card quiser 4 ou 5 depois, é mudança de front; com 3
 * guardados seria uma segunda varredura do catálogo inteiro.
 */
export const CAST_STORED = 5;

/** Só o path muda entre filme e série; o resto do cliente é o mesmo. */
export const creditsUrl = (type: "movie" | "tv", externalId: string) =>
  `${TMDB_API}/${type}/${externalId}/credits`;

type CastEntry = { name?: unknown; order?: unknown };

/**
 * Os nomes que ficam, na ordem em que o TMDB os considera principais.
 *
 * Pura de propósito: é aqui que mora tudo que pode dar errado com o formato, e
 * o teste alcança isso sem chave e sem banco.
 *
 * Ordena por `order` em vez de confiar na ordem do array — o campo existe
 * justamente porque é ele que carrega o significado, e um dia a resposta vem
 * embaralhada. Deduplica por nome porque ator com dois papéis aparece duas
 * vezes no `cast`, e "Tom Hanks · Tom Hanks" no card lê como defeito.
 */
export function mainCast(payload: unknown, limit = CAST_STORED): string[] {
  const cast = (payload as { cast?: unknown })?.cast;
  if (!Array.isArray(cast)) return [];

  const ordenado = (cast as CastEntry[])
    .filter((c) => typeof c.name === "string" && c.name.trim() !== "")
    .map((c) => ({
      nome: (c.name as string).trim(),
      // Sem `order` vai para o fim, não para o começo: ausência de posição não
      // é a primeira posição.
      ordem: typeof c.order === "number" ? c.order : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.ordem - b.ordem);

  const nomes: string[] = [];
  for (const { nome } of ordenado) {
    if (!nomes.includes(nome)) nomes.push(nome);
    if (nomes.length === limit) break;
  }
  return nomes;
}

/**
 * 404 do TMDB é título que saiu do acervo deles, não falha nossa.
 *
 * String e não código porque o `http.ts` é ponto congelado e só lança
 * `Error("TMDB 404 em ...")` — trocar isso é mudança na fase serial. Amarrado
 * por teste para o dia em que a mensagem mudar não virar silêncio.
 */
export const ehNaoEncontrado = (e: unknown) =>
  e instanceof Error && /^TMDB 404 /.test(e.message);

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

/** Entrypoint: só roda quando o arquivo é o programa, nunca ao ser importado. */
if (import.meta.filename === process.argv[1]) {
  const LIMIT = arg("limit", Number.POSITIVE_INFINITY);
  const DRY = process.argv.includes("--dry-run");

  /**
   * A fila é a própria coluna: `credits_synced_at IS NULL` com o índice parcial
   * `titles_sem_elenco` (I0.2). Não há cursor a guardar — retomar é refazer
   * esta consulta, e o que já foi buscado não volta. Por isso `ingest_state`
   * não é usado aqui: ele existe para as varreduras do I2, que precisam avançar
   * mesmo quando não encontram nada.
   */
  const fila = await db
    .select({
      id: titles.id,
      type: titles.type,
      externalId: titleExternalIds.externalId,
      title: titles.title,
    })
    .from(titles)
    .innerJoin(titleExternalIds, eq(titleExternalIds.titleId, titles.id))
    .where(and(isNull(titles.creditsSyncedAt), eq(titleExternalIds.provider, "tmdb")))
    .orderBy(sql`${titles.score} DESC`)
    .limit(Number.isFinite(LIMIT) ? LIMIT : 1_000_000);

  const [{ restante } = { restante: 0 }] = await db
    .select({ restante: sql<number>`count(*)::int` })
    .from(titles)
    .where(isNull(titles.creditsSyncedAt));

  console.log(
    `elenco tmdb | ${fila.length} nesta passada de ${restante} sem elenco${DRY ? " | DRY-RUN" : ""}`,
  );

  const started = Date.now();
  let comElenco = 0;
  let semElenco = 0;
  let sumiram = 0;

  for (const [i, t] of fila.entries()) {
    let nomes: string[] = [];
    try {
      // `titles.type` é `text` com o domínio só no comentário, e o schema é
      // ponto congelado — quem estreita para "movie" | "tv" é o contrato, aqui
      // na leitura. Linha com tipo fora do domínio é corrupção e derruba a
      // passada de propósito: seguir montaria url inválida para o catálogo todo.
      const tipo = titleType.parse(t.type);
      nomes = mainCast(await get<unknown>(creditsUrl(tipo, t.externalId)));
    } catch (e) {
      if (!ehNaoEncontrado(e)) throw e;
      // Marca como buscado mesmo assim: sem isso o título fica na fila para
      // sempre e uma passada seguinte gasta a mesma requisição de novo.
      sumiram++;
    }

    if (!DRY) {
      await db
        .update(titles)
        .set({ castNames: nomes, creditsSyncedAt: new Date() })
        .where(eq(titles.id, t.id));
    }

    if (nomes.length > 0) comElenco++;
    else semElenco++;

    if ((i + 1) % 200 === 0) {
      console.log(`  ${i + 1}/${fila.length} — último: ${t.title}`);
    }
  }

  console.log(
    `\nfim em ${Math.round((Date.now() - started) / 1000)}s | com elenco ${comElenco} | sem elenco ${semElenco} | fora do TMDB ${sumiram}`,
  );

  await pg.end();
}
