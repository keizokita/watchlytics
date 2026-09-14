import { sessionUser, type SessionUser } from "@watchlytics/contract";
import { t } from "./strings.ts";

/**
 * Token de acesso da sessão, em memória.
 *
 * Fora do Login.tsx porque quem precisa dele não é só a tela de login: o feed,
 * a fila de swipes e o onboarding também mandam `Authorization`, e a fila é um
 * módulo sem React — importar um .tsx ali arrastaria a árvore de componentes
 * para dentro do teste dela.
 *
 * Memória, e não localStorage: o refresh mora no cookie httpOnly (C3), então
 * recarregar a página retoma a sessão sem nunca ter exposto o access a XSS.
 */
let accessToken: string | null = null;

export const getAccessToken = () => accessToken;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};

/** Header de autorização, ou nada quando não há sessão. */
export const auth = (): HeadersInit =>
  accessToken ? { authorization: `Bearer ${accessToken}` } : {};

/**
 * Troca o refresh do cookie por um access novo. Uma promessa compartilhada, e
 * não uma chamada por requisição: o refresh é rotacionado e o servidor trata
 * reuso como replay, revogando a sessão INTEIRA (C3, routes/auth.ts:301). Duas
 * requisições que levem 401 ao mesmo tempo — o feed e o flush da fila, que é o
 * caso normal — derrubariam a sessão que estavam tentando salvar.
 */
let refreshing: Promise<Refresh> | null = null;

/**
 * Três respostas, e não duas.
 *
 * `false` juntava "você não tem sessão" com "não consigo saber", e só a
 * primeira justifica mandar a pessoa para a tela de entrada. Quem tinha sessão
 * válida no cookie e pedia refresh no segundo errado via a tela de entrada como
 * se nunca tivesse entrado — sem erro, sem aviso, e indistinguível de um
 * visitante, porque visitante sem sessão produz o MESMO 401 nesta rota.
 */
export type Refresh = "ok" | "sem-sessao" | "indisponivel";

export function refreshAccess(): Promise<Refresh> {
  refreshing ??= (async () => {
    try {
      const res = await fetch("/v1/auth/refresh", { method: "POST" });
      // SÓ 401 quer dizer "sem sessão": é a única forma que o servidor tem de
      // dizer isso (`unauthorized()` em auth.ts:33, e as quatro saídas do
      // `rotate`). O resto é o servidor não conseguindo responder —
      // 429 do teto por IP (routes/auth.ts:462) incluído, que de outro jeito
      // desloga quem só fez requisição demais.
      if (res.status === 401) return "sem-sessao";
      if (!res.ok) return "indisponivel";

      const body = (await res.json()) as { access?: unknown };
      // 200 sem `access` é defeito do servidor, não ausência de sessão. Cair
      // para "indisponivel" preserva a sessão que pode estar boa; o contrário
      // descarta uma sessão válida por causa de um corpo malformado.
      if (typeof body.access !== "string") return "indisponivel";
      setAccessToken(body.access);
      return "ok";
    } catch {
      // `fetch` só rejeita por rede/CORS. Nunca é resposta do servidor, então
      // nunca é "sem sessão".
      return "indisponivel";
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * `fetch` com Authorization que sobrevive ao access expirando.
 *
 * O access dura 15 minutos (auth.ts:18) e até hoje só era renovado na carga da
 * página: quem ficasse mais que isso numa tela — os 20 swipes do onboarding
 * chegam lá — levava 401 na requisição seguinte e o app pintava erro fatal com
 * a sessão ainda válida no cookie.
 *
 * Uma tentativa só de renovar. Se o refresh não devolveu `"ok"`, o 401 original
 * vai para quem chamou — e nenhum chamador descarta a sessão por causa dele:
 * todos pintam erro na tela em que estão (main.tsx:283). É por isso que a
 * distinção das três respostas não precisa subir até aqui: quem destruía sessão
 * por não saber era o `resume()`, no boot, e é lá que ela é lida.
 */
export async function authedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = () =>
    fetch(url, { ...init, headers: { ...init.headers, ...auth() } });

  const res = await send();
  if (res.status !== 401) return res;
  return (await refreshAccess()) === "ok" ? send() : res;
}

/**
 * Quem está logado, para o shell decidir o que montar.
 *
 * Store externa em vez de estado local do <Login>: o link de entrar mora na
 * nav, mas quem precisa saber se há sessão é o shell inteiro. Sem um lugar só,
 * o sign-out atualizaria a nav e deixaria o resto da tela achando que ainda
 * tem usuário.
 */
/**
 * Três estados, não dois: `undefined` é "ainda não sei", enquanto o refresh do
 * C3 está no ar. Sem ele o shell pintaria a tela de entrada por um instante
 * para quem já tem sessão, a cada carga.
 */
let user: SessionUser | null | undefined = undefined;
const listeners = new Set<() => void>();

export const getUser = () => user;

export const setUser = (next: SessionUser | null) => {
  user = next;
  for (const l of listeners) l();
};

export const subscribeUser = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * O servidor não conseguiu responder, e por isso NÃO se sabe se há sessão.
 *
 * Lança em vez de devolver `null` porque `null` é uma afirmação — "esta pessoa
 * não tem sessão" — e ela vira a tela de entrada. Quem lança faz o `boot()`
 * rejeitar, e aí o shell fica no terceiro estado (`undefined`, "ainda não sei")
 * com o erro e o `retry` à vista.
 *
 * Segue a convenção do `Login.tsx`, que é quem pega: o detalhe técnico vai para
 * o console e o que sobe é texto de usuário, porque o `catch` de lá lê
 * `e.message` direto.
 */
function indisponivel(detalhe: string): Error {
  console.error(detalhe);
  return new Error(navigator.onLine ? t.errorGeneric : t.errorOffline);
}

/**
 * Sessão anterior: o refresh está no cookie, que o servidor lê e rotaciona.
 *
 * Mora aqui, e não no `Login.tsx`: é lógica de sessão, não de componente, e o
 * `node --test` da web não carrega `.tsx` — no arquivo antigo o caminho que
 * este conserto endireita ficaria sem teste nenhum.
 *
 * As três saídas são diferentes de propósito. Antes eram duas, e a pessoa com
 * sessão válida no cookie caía na tela de entrada sempre que a api não
 * respondia — sem erro e sem aviso, indistinguível de quem nunca entrou.
 *
 * **Nenhuma retentativa automática aqui**, ao contrário do `exchange()` do
 * `Login.tsx`, que repete uma vez em 5xx. O refresh é rotacionado, e o servidor trata reuso como replay
 * revogando a sessão INTEIRA (C3). Um 5xx depois de o servidor já ter
 * rotacionado é indistinguível de um 5xx antes: repetir sozinho arriscaria
 * derrubar de vez a sessão que a retentativa existe para salvar. E num 429 a
 * retentativa imediata é o que causou o 429. Quem repete é a pessoa, pelo
 * botão — que é o mesmo custo de recarregar a página, com alguém decidindo.
 */
export async function resume(): Promise<SessionUser | null> {
  const refresh = await refreshAccess();
  if (refresh === "sem-sessao") return null;
  if (refresh === "indisponivel") throw indisponivel("/v1/auth/refresh não respondeu");

  const me = await authedFetch("/v1/auth/me");
  if (me.ok) return sessionUser.parse(await me.json());
  // Mesma regra da rota de refresh: só 401 é o servidor dizendo que não há
  // sessão. Um 500 aqui derrubava a sessão mesmo com o refresh tendo dado certo.
  if (me.status === 401) return null;
  throw indisponivel(`/v1/auth/me respondeu ${me.status}`);
}
