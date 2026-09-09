import type { TmdbItem } from "./tmdb.ts";

/**
 * O único cliente HTTP do TMDB — com pausa, recuo e leitura do Retry-After.
 *
 * Extraído do `run.ts` na fase serial do I0.2, e pelo mesmo motivo que
 * `schema.ts` e `contract/index.ts` congelaram: era ponto de contenção. A I1.1
 * precisa respeitar "o mesmo rate limit" e não pode tocar em `run.ts`; sem este
 * arquivo a saída seria duplicar o recuo exponencial, e um 429 aprendido de um
 * lado não ensinaria nada ao outro.
 *
 * **Dono: ninguém.** Como `schema.ts`, muda na fase serial ou não muda. Trilha
 * que precisar de outro comportamento de rede fala antes.
 *
 * ponytail: o estado da janela é de módulo, logo por PROCESSO. Isto unifica o
 * código, não o orçamento — dois comandos rodando ao mesmo tempo têm cada um a
 * sua janela de 60ms contra a mesma cota do TMDB. Se a carga de elenco virar
 * processo separado e concorrente, o teto passa a ser esse, e a saída é uma
 * fila fora do processo (ou rodar em série), não um sleep maior aqui.
 */

/**
 * Lido a cada chamada, não no import: um `throw` no topo do módulo derrubaria
 * qualquer teste que só quisesse importar uma função daqui — que é exatamente o
 * que a I1.1 vai fazer. A mensagem é a mesma, só chega no primeiro request.
 */
function auth() {
  const token = process.env["TMDB_READ_TOKEN"];
  if (!token) {
    throw new Error(
      "TMDB_READ_TOKEN ausente. Gere em themoviedb.org/settings/api (Read Access Token v4) e ponha em apps/api/.env",
    );
  }
  /**
   * Bearer, não `?api_key=`: chave em query string vaza em log de servidor, em
   * proxy e no header Referer. Header não.
   */
  return { Authorization: `Bearer ${token}`, accept: "application/json" };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uma requisição por vez com pausa: nunca chegamos perto do teto do TMDB. */
let lastCall = 0;

/**
 * `T` porque o corpo depende da rota: `/discover` devolve página, `/credits`
 * devolve elenco. O que é comum — e é só o que mora aqui — é a espera.
 */
export async function get<T = { results?: TmdbItem[]; total_pages?: number }>(
  url: string,
  attempt = 0,
): Promise<T> {
  const since = Date.now() - lastCall;
  if (since < 60) await sleep(60 - since);
  lastCall = Date.now();

  const res = await fetch(url, { headers: auth() });

  if (res.status === 429) {
    // Respeita o Retry-After quando vem; senão recua exponencialmente.
    const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 2 ** attempt * 1000;
    if (attempt > 5) throw new Error("429 persistente no TMDB");
    await sleep(wait);
    return get<T>(url, attempt + 1);
  }
  if (res.status >= 500 && attempt < 5) {
    await sleep(2 ** attempt * 500);
    return get<T>(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`TMDB ${res.status} em ${url.split("?")[0]}`);
  return res.json() as Promise<T>;
}
