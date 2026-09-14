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
 * Falta de propósito: `preload` no HSTS — é inscrição numa lista de navegador
 * que se remove em semanas, não em um deploy. Compromisso do usuário, não de
 * um PR.
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

  /**
   * A CSP daqui é de UMA página: o HTML de `GET /u/:handle` (D5).
   *
   * O resto do que a api responde é JSON, e CSP em JSON é inerte — o navegador
   * só aplica diretiva de busca a documento. Por isso não há ramificação por
   * rota: uma política só, no mesmo gancho do resto, é menos código e não tem
   * caminho que só executa onde ninguém olha.
   *
   * É OUTRA política, mais apertada que a do `apps/web/public/_headers`, porque
   * é outra página. O perfil público é template estático em `routes/profile.ts`:
   * um `<style>` inline, texto e um link. Nenhum script, nenhuma imagem, nenhum
   * `fetch`. `default-src 'none'` fecha tudo isso de uma vez, e o
   * `'unsafe-inline'` do `style-src` é só pelo `<style>` — que não vale hash
   * porque hash de folha inline exige que ela nunca mude, e ela muda com o CSS.
   *
   * `img-src 'self'` é a única folga, e não é do template: o navegador pede
   * `/favicon.ico` sozinho em toda página. Sem esta linha a recusa vira erro de
   * console em cima de um arquivo que ninguém vê — barulho vermelho na página
   * que mais circula por fora, que é onde barulho custa mais caro.
   *
   * `frame-ancestors 'none'` e não `X-Frame-Options`: aqui a CSP está
   * BLOQUEANDO, então a diretiva moderna vale sozinha. No `_headers` do app é o
   * contrário — lá a CSP está em `Report-Only` e quem impede o enquadramento é
   * o `X-Frame-Options`.
   *
   * Bloqueando e não `Report-Only` porque esta página cabe inteira numa
   * leitura: o template é um só, não tem bundle, e o que ela carrega está
   * enumerado acima. O app do Pages entra em `Report-Only` justamente porque
   * não cabe — são 320 kB de React e caminhos que nenhuma medição local
   * atravessa. Medido com o `driver.mjs social`, que abre o perfil público pela
   * tela: nenhuma violação.
   */
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",

  /**
   * O perfil público não pede câmera, microfone nem localização, e é a página
   * da api que circula em link — a que um estranho abre.
   */
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
} as const;

export function securityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_req, reply) => {
    for (const [nome, valor] of Object.entries(CABECALHOS)) {
      reply.header(nome, valor);
    }
  });
}
