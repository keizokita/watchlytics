import { gt, isNull, or, sql } from "drizzle-orm";
import type { TitleType } from "@watchlytics/contract";
import { db, pg } from "../db/client.ts";
import { swipes, titleExternalIds, titles } from "../db/schema.ts";
import { ehNaoEncontrado } from "./credits.ts";
import { get } from "./http.ts";
import { gravarEstado, lerEstado } from "./state.ts";
import { TMDB_API, normalize, type Normalized, type TmdbItem } from "./tmdb.ts";
import { carimbarConferido, upsert } from "./upsert.ts";

/**
 * I2 — o catálogo vivo. Duas varreduras num comando só:
 *
 *   npm run ingest:changes -w @watchlytics/api              # o dia anterior
 *   npm run ingest:changes -w @watchlytics/api -- --frios 0 # só o /changes
 *   npm run ingest:changes -w @watchlytics/api -- --dry-run
 *
 * **I2.1 — `/changes`.** O TMDB publica, por dia, a lista de ids que ele mesmo
 * marcou como alterados: ~9 mil filmes e ~2,8 mil séries. Buscar o detalhe de
 * todos seria uma hora de rede por dia. Buscamos o detalhe só da INTERSEÇÃO com
 * o nosso catálogo — os outros são títulos que nunca passaram na régua de votos.
 * O custo vira "listar as páginas de ids" (~120 requisições) mais uma requisição
 * por título nosso que mudou, que é dezenas, não milhares.
 *
 * **Título NOVO não entra por aqui, de propósito.** Para saber se um id
 * desconhecido passa na régua, seria preciso buscar o detalhe dele — os mesmos
 * 12 mil detalhes por dia que este desenho existe para não buscar. Catálogo novo
 * é trabalho da carga do `/discover` (`run.ts`), que já filtra por votos na
 * própria consulta e agora é retomável (I2.3). Esta varredura é sobre não
 * apodrecer o que já temos; aquela é sobre crescer.
 *
 * **I2.2 — pull-through do frio.** Ver `filaFria()`.
 *
 * **Rode em série com as outras ingestões.** A janela de 60ms do `http.ts` é
 * estado de módulo, logo por PROCESSO: dois comandos ao mesmo tempo são duas
 * janelas contra a mesma cota do TMDB.
 */

/** O `/changes` do TMDB recusa intervalo maior que isto. */
export const MAX_DIAS_JANELA = 14;
const DIA_MS = 86_400_000;

export const CHAVE_CURSOR = "changes_cursor";

/** Título frio é o que não conferimos há mais de 30 dias (I2.2). */
export const DIAS_FRIO = 30;
/**
 * "Lido" para efeito da fila fria: swipado nesta janela. O card que ninguém
 * viu não tem pressa nenhuma de estar atualizado.
 */
export const DIAS_CIRCULANDO = 7;

export const dataIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type Janela = { start: string; end: string };

/**
 * Fatia [inicio, fim] em janelas que o `/changes` aceita.
 *
 * As janelas se ENCOSTAM num dia em comum (a seguinte começa no dia em que a
 * anterior terminou) em vez de se emendarem sem sobra. Reprocessar um dia custa
 * a mesma requisição de novo e a escrita é idempotente; perder um dia no meio de
 * uma retomada longa custa um título congelado que ninguém mais vai procurar.
 */
export function janelas(
  inicio: string,
  fim: string,
  maxDias = MAX_DIAS_JANELA,
): Janela[] {
  const fimMs = Date.parse(`${fim}T00:00:00Z`);
  let cur = Date.parse(`${inicio}T00:00:00Z`);
  if (!Number.isFinite(cur) || !Number.isFinite(fimMs)) return [];

  const out: Janela[] = [];
  // `cur < fimMs`, não `<=`: cursor já em hoje significa nada novo a varrer, e
  // rodar o comando duas vezes no mesmo dia não pode refazer a passada inteira.
  while (cur < fimMs) {
    const end = Math.min(cur + maxDias * DIA_MS, fimMs);
    out.push({ start: dataIso(cur), end: dataIso(end) });
    cur = end;
  }
  return out;
}

export const changesUrl = (type: TitleType, j: Janela, page: number) =>
  `${TMDB_API}/${type}/changes?start_date=${j.start}&end_date=${j.end}&page=${page}`;

/** O detalhe é a ÚNICA rota que devolve um título por id; `/discover` não busca por id. */
export const detalheUrl = (type: TitleType, externalId: string) =>
  `${TMDB_API}/${type}/${externalId}`;

const texto = (v: unknown) => (typeof v === "string" ? v : "");
const numero = (v: unknown) => (typeof v === "number" ? v : 0);
const caminho = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

/**
 * Adapta a resposta do detalhe ao formato que o `normalize()` congelado espera.
 *
 * O `/discover` devolve `genre_ids: number[]`; o detalhe devolve
 * `genres: [{id, name}]`. É a única diferença estrutural entre os dois, e é o
 * motivo de esta função existir: `tmdb.ts` é ponto congelado e a régua de
 * qualidade (pôster, sinopse, ano, gênero nosso) tem que continuar sendo a
 * mesma nas duas entradas. Traduzir aqui mantém UM portão para o catálogo.
 *
 * Pura de propósito: é aqui que mora tudo que pode dar errado com o formato.
 *
 * `null` quando a resposta não é um título utilizável — inclusive quando virou
 * `adult`, que o `/discover` nunca traria (`include_adult=false`).
 */
export function paraTmdbItem(detalhe: unknown, type: TitleType): TmdbItem | null {
  const d = detalhe as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || typeof d["id"] !== "number") return null;
  if (d["adult"] === true) return null;

  const genreIds = Array.isArray(d["genres"])
    ? (d["genres"] as { id?: unknown }[])
        .map((g) => g?.id)
        .filter((id): id is number => typeof id === "number")
    : [];

  const ehFilme = type === "movie";
  return {
    id: d["id"],
    title: ehFilme ? texto(d["title"]) : undefined,
    name: ehFilme ? undefined : texto(d["name"]),
    original_title: ehFilme ? texto(d["original_title"]) : undefined,
    original_name: ehFilme ? undefined : texto(d["original_name"]),
    overview: texto(d["overview"]),
    poster_path: caminho(d["poster_path"]),
    backdrop_path: caminho(d["backdrop_path"]),
    release_date: ehFilme ? texto(d["release_date"]) : undefined,
    first_air_date: ehFilme ? undefined : texto(d["first_air_date"]),
    original_language: texto(d["original_language"]),
    genre_ids: genreIds,
    vote_average: numero(d["vote_average"]),
    vote_count: numero(d["vote_count"]),
  };
}

/**
 * O título já está no catálogo: a régua de VOTOS não se aplica de novo.
 *
 * Ela é portão de entrada, escolhido na I0.1 — e o lado que se corrige sem
 * apagar dado de usuário é o apertado. Reaplicá-la na atualização faria um
 * título cair fora só porque o TMDB reajustou a contagem, e "cair fora" aqui
 * significaria congelar a linha (nunca apagar). Os outros portões do
 * `normalize` continuam valendo: sem pôster ou sem sinopse o card quebra.
 */
export const MIN_VOTES_REFRESCO = 0;

export function normalizarDetalhe(
  detalhe: unknown,
  type: TitleType,
): Normalized | null {
  const item = paraTmdbItem(detalhe, type);
  return item && normalize(item, type, MIN_VOTES_REFRESCO);
}

// ─── I2.1: a varredura do /changes ──────────────────────────────────────────

type Alvo = { id: string; type: TitleType; externalId: string };

/**
 * O catálogo inteiro na memória, chaveado por tipo+id externo.
 *
 * Chave composta porque os ids do TMDB são de namespaces diferentes: o filme
 * 1429 e a série 1429 são coisas distintas, e `/movie/changes` só fala de
 * filmes. Sem o tipo na chave, uma série alterada faria a gente reescrever um
 * filme com os dados dela.
 *
 * ponytail: ~10 mil linhas cabem em memória com folga e a alternativa é um
 * `IN (...)` de 9 mil ids por página do `/changes`. Se o catálogo passar da casa
 * dos milhões, virar tabela temporária e um `JOIN`.
 */
async function catalogoPorIdExterno(): Promise<Map<string, Alvo>> {
  const linhas = await db
    .select({
      id: titles.id,
      type: titles.type,
      externalId: titleExternalIds.externalId,
    })
    .from(titleExternalIds)
    .innerJoin(titles, sql`${titles.id} = ${titleExternalIds.titleId}`)
    .where(sql`${titleExternalIds.provider} = 'tmdb'`);

  const mapa = new Map<string, Alvo>();
  for (const l of linhas) {
    const type = l.type as TitleType;
    mapa.set(`${type}:${l.externalId}`, { id: l.id, type, externalId: l.externalId });
  }
  return mapa;
}

/** Só os ids: o detalhe de cada um é a requisição cara, e só a interseção a paga. */
async function idsAlterados(type: TitleType, j: Janela): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await get<{
      results?: { id?: unknown }[];
      total_pages?: number;
    }>(changesUrl(type, j, page));
    pages = Math.min(data.total_pages ?? 1, 500);
    for (const r of data.results ?? []) {
      if (typeof r?.id === "number") ids.push(String(r.id));
    }
    page++;
  } while (page <= pages);
  return ids;
}

type Desfecho = "inserido" | "atualizado" | "portao" | "sumiu";

/** Uma requisição de detalhe, uma escrita. O carimbo cobre os dois desvios. */
async function refrescar(alvo: Alvo, dry: boolean): Promise<Desfecho> {
  let detalhe: unknown;
  try {
    detalhe = await get<unknown>(detalheUrl(alvo.type, alvo.externalId));
  } catch (e) {
    if (!ehNaoEncontrado(e)) throw e;
    // Saiu do acervo do TMDB. Fica no nosso: apagar cascatearia em swipe e match.
    if (!dry) await carimbarConferido(alvo.id);
    return "sumiu";
  }

  const n = normalizarDetalhe(detalhe, alvo.type);
  if (!n) {
    if (!dry) await carimbarConferido(alvo.id);
    return "portao";
  }
  return (await upsert(n, { dry })) === "inserido" ? "inserido" : "atualizado";
}

// ─── I2.2: pull-through do título frio ──────────────────────────────────────

/**
 * A fila do pull-through: título frio que está circulando no deck.
 *
 * **Por que é fila e não leitura que atualiza.** O critério pede "se atualiza ao
 * ser lido", e o caminho óbvio — o feed vê `synced_at` velho e busca no TMDB —
 * é exatamente o que não pode acontecer: transformaria um GET de 20 cards em até
 * 20 chamadas de rede a um terceiro DENTRO da requisição, e o feed passaria a
 * ter a latência e a disponibilidade do TMDB. Escrita no caminho de leitura
 * ainda traz o resto: contenção de lock em `titles` na hora do pico, que é
 * justamente quando mais gente lê.
 *
 * Então a leitura não busca: ela ENFILEIRA, e a fila é derivada, sem tabela
 * nova. Quem foi lido deixa rastro em `swipes`, e o rastro é a fila:
 *
 *     frio (synced_at > 30d ou nunca)  ∩  swipado nos últimos 7 dias
 *
 * Ordenado pelo swipe mais recente: o que mais gente está vendo agora atualiza
 * primeiro. O preço é a demora — o título frio lido hoje fica fresco na próxima
 * passada, não neste swipe. Para pôster e sinopse, que é o que muda, um dia de
 * atraso não é nada; para o feed, meio segundo a mais por card seria tudo.
 *
 * O `--frios` completa a passada com títulos frios não circulantes (score
 * primeiro) quando sobra orçamento, para que um catálogo parado também degele.
 */
export async function filaFria(limite: number): Promise<Alvo[]> {
  if (limite <= 0) return [];

  const circulando = db
    .select({
      titleId: swipes.titleId,
      visto: sql<Date>`max(${swipes.createdAt})`.as("visto"),
    })
    .from(swipes)
    .where(gt(swipes.createdAt, sql`now() - ${`${DIAS_CIRCULANDO} days`}::interval`))
    .groupBy(swipes.titleId)
    .as("circulando");

  const linhas = await db
    .select({
      id: titles.id,
      type: titles.type,
      externalId: titleExternalIds.externalId,
    })
    .from(titles)
    .innerJoin(
      titleExternalIds,
      sql`${titleExternalIds.titleId} = ${titles.id} and ${titleExternalIds.provider} = 'tmdb'`,
    )
    .leftJoin(circulando, sql`${circulando.titleId} = ${titles.id}`)
    .where(
      or(
        isNull(titles.syncedAt),
        sql`${titles.syncedAt} < now() - ${`${DIAS_FRIO} days`}::interval`,
      ),
    )
    // Lido primeiro; o resto do frio por popularidade, para degelar o catálogo
    // parado sem nunca passar na frente de quem está no deck de alguém.
    .orderBy(sql`${circulando.visto} desc nulls last, ${titles.score} desc`)
    .limit(limite);

  return linhas.map((l) => ({
    id: l.id,
    type: l.type as TitleType,
    externalId: l.externalId,
  }));
}

// ─── o comando ──────────────────────────────────────────────────────────────

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

if (import.meta.filename === process.argv[1]) {
  const DRY = process.argv.includes("--dry-run");
  /** Teto da fila fria por passada: é o que mantém o comando em minutos. */
  const FRIOS = arg("frios", 500);
  const hoje = dataIso(Date.now());

  const cursor = await lerEstado<{ date?: string }>(CHAVE_CURSOR);
  /**
   * Sem cursor, começa ONTEM e não no início dos tempos: a primeira passada não
   * tem por que reprocessar semanas, e o catálogo acabou de ser carregado.
   */
  const desde = cursor?.date ?? dataIso(Date.now() - DIA_MS);
  const pendentes = janelas(desde, hoje);

  console.log(
    `changes tmdb | de ${desde} a ${hoje} | ${pendentes.length} janela(s) | fila fria até ${FRIOS}${DRY ? " | DRY-RUN" : ""}`,
  );

  const started = Date.now();
  const catalogo = await catalogoPorIdExterno();
  const conta: Record<Desfecho, number> = {
    inserido: 0,
    atualizado: 0,
    portao: 0,
    sumiu: 0,
  };
  let listadas = 0;
  let requisicoes = 0;

  for (const j of pendentes) {
    for (const type of ["movie", "tv"] as const) {
      const ids = await idsAlterados(type, j);
      listadas += ids.length;
      const nossos = ids
        .map((id) => catalogo.get(`${type}:${id}`))
        .filter((a): a is Alvo => a !== undefined);

      for (const alvo of nossos) {
        conta[await refrescar(alvo, DRY)]++;
        requisicoes++;
      }
      console.log(
        `  ${j.start}→${j.end} ${type}: ${ids.length} alterados no tmdb, ${nossos.length} nossos`,
      );
    }
    /**
     * Avança por janela, e mesmo quando nenhum título nosso mudou: a janela foi
     * perguntada, e é isso que o cursor guarda. Por janela e não no fim da
     * passada para que uma queda no meio de uma retomada longa não jogue fora as
     * janelas já varridas.
     */
    if (!DRY) await gravarEstado(CHAVE_CURSOR, { date: j.end });
  }

  const frios = await filaFria(FRIOS);
  for (const alvo of frios) {
    conta[await refrescar(alvo, DRY)]++;
    requisicoes++;
  }
  console.log(`  fila fria: ${frios.length} título(s) com mais de ${DIAS_FRIO} dias`);

  console.log(
    `\nfim em ${Math.round((Date.now() - started) / 1000)}s | ${listadas} ids listados no tmdb | ${requisicoes} detalhes buscados | inseridos ${conta.inserido} | atualizados ${conta.atualizado} | fora do portão ${conta.portao} | fora do TMDB ${conta.sumiu}`,
  );

  await pg.end();
}
