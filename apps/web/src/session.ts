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
