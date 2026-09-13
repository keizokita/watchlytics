import type { FastifyInstance } from "fastify";

/**
 * Cabeçalhos de segurança da api (issue #42).
 *
 * A api não é só JSON: `GET /u/:handle` devolve o HTML do perfil público (D5),
 * e o Pages repassa essa resposta pela Function de proxy — que devolve o
 * `Response` do Fly como veio, cabeçalhos inclusos. Ou seja, o que se põe aqui
 * é o que chega ao navegador nas duas rotas, e é por isso que este arquivo
 * existe em vez de um `_headers` no Pages: `_headers` é do asset estático, não
 * da resposta de Function.
 *
 * `onSend` e não `onRequest`: o gancho tem que valer também para a resposta que
 * o error handler monta, e para o 404 que nenhuma rota atendeu.
 *
 * **Só a metade que não quebra nada**, que é o que o próprio issue recomenda.
 * Faltam de propósito:
 *
 * - `Content-Security-Policy` — tarefa própria, com `Report-Only` primeiro. O
 *   app carrega pôster de `image.tmdb.org` por desenho e o login é do Google;
 *   uma CSP errada quebra em produção de um jeito que o teste local não pega.
 * - `X-Frame-Options` e `Permissions-Policy` — entram junto da CSP, que é quem
 *   diz `frame-ancestors` de verdade.
 * - `preload` no HSTS — é inscrição numa lista de navegador que se remove em
 *   semanas, não em um deploy. Compromisso do usuário, não de um PR.
 */
const CABECALHOS = {
  /**
   * Um ano, e subdomínio junto. Sem isto a PRIMEIRA visita ainda aceita um
   * downgrade para http antes do redirecionamento — que é justamente a visita
   * em que o cookie de refresh pode viajar.
   *
   * Mandar sempre, inclusive em dev sobre http: o navegador ignora HSTS fora de
   * TLS, então não há o que ramificar por ambiente. Ramificação por ambiente é
   * código que só executa onde ninguém está olhando.
   */
  "strict-transport-security": "max-age=31536000; includeSubDomains",

  /**
   * O `/v1/me/export` devolve JSON que a pessoa baixa, e o `/u/:handle` devolve
   * HTML. Sem `nosniff` o navegador pode adivinhar o tipo pelo conteúdo — e
   * adivinhar errado em cima de dado que veio de usuário é como resposta de
   * dado vira execução de script.
   */
  "x-content-type-options": "nosniff",

  /**
   * O Pages já manda este; a api não mandava nenhum. Importa porque o perfil
   * público é a página que circula em link: sem ele, o caminho completo sai no
   * `Referer` para o CDN de pôster de terceiro.
   */
  "referrer-policy": "strict-origin-when-cross-origin",
} as const;

export function securityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_req, reply) => {
    for (const [nome, valor] of Object.entries(CABECALHOS)) {
      reply.header(nome, valor);
    }
  });
}
