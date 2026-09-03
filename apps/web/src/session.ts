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
