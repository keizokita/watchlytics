import type { SessionUser } from "@watchlytics/contract";

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
let refreshing: Promise<boolean> | null = null;

export function refreshAccess(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch("/v1/auth/refresh", { method: "POST" });
      if (!res.ok) return false;
      const body = (await res.json()) as { access?: unknown };
      if (typeof body.access !== "string") return false;
      setAccessToken(body.access);
      return true;
    } catch {
      return false;
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
 * Uma tentativa só de renovar: se o refresh falhou, o 401 é verdadeiro (sessão
 * revogada ou expirada) e vai para quem chamou, que já sabe pintar a entrada.
 */
export async function authedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = () =>
    fetch(url, { ...init, headers: { ...init.headers, ...auth() } });

  const res = await send();
  if (res.status !== 401) return res;
  return (await refreshAccess()) ? send() : res;
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
