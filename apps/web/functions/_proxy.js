/**
 * Proxy para a API no Fly, compartilhado pelas rotas que a Cloudflare precisa
 * repassar: `/v1/*` (JSON) e `/u/*` (o HTML do perfil público, D5).
 *
 * Existe para manter ORIGEM ÚNICA em produção. Sem isso, web em pages.dev e API
 * em fly.dev são domínios registráveis diferentes, e o refresh token em cookie
 * httpOnly (C3) viraria cookie de terceiro — que os navegadores bloqueiam.
 *
 * Custo: um hop pelo edge da Cloudflare. Ganho: nada de CORS e SameSite=Lax
 * funcionando de verdade.
 *
 * Em JS puro de propósito: tipar isso exigiria @cloudflare/workers-types só
 * para oito linhas. O `_` no nome é o que faz o Pages tratar como módulo, e
 * não como rota.
 */
export function onRequest({ request, env }) {
  if (!env.API_ORIGIN) {
    return new Response("API_ORIGIN não configurada no Pages", { status: 500 });
  }
  const { pathname, search } = new URL(request.url);
  return fetch(new Request(new URL(pathname + search, env.API_ORIGIN), request));
}
