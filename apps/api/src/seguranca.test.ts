import assert from "node:assert/strict";
import test from "node:test";
import { pg } from "./db/client.ts";
import { buildServer } from "./server.ts";

process.env["AUTH_SECRET"] ??= "chave-de-teste-com-mais-de-32-caracteres";

/**
 * #42 — os cabeçalhos de segurança da api.
 *
 * Sem fixture e sem conta: as três respostas abaixo não tocam o banco, e o que
 * está sob teste é o gancho, não a rota. Um arquivo de teste que cria usuário
 * para conferir cabeçalho estaria testando o `insert`.
 *
 * As três de propósito, e não uma: o gancho é `onSend` justamente para pegar o
 * caminho de sucesso, o que o error handler monta e o 404 que não é de rota
 * nenhuma. Com `onRequest`, ou com o header posto dentro de cada handler, os
 * dois últimos sairiam pelados — e é no 404 que um sniff de conteúdo teria a
 * chance mais barata.
 */
const ESPERADOS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const app = buildServer();

test.after(async () => {
  await app.close();
  await pg.end();
});

for (const [nome, resposta] of [
  ["200 de rota que existe", { method: "GET", url: "/health" }],
  ["401 que o error handler monta", { method: "GET", url: "/v1/feed" }],
  ["404 que não é de rota nenhuma", { method: "GET", url: "/nao-existe" }],
] as const) {
  test(`#42 — os cabeçalhos vão no ${nome}`, async () => {
    const res = await app.inject(resposta);

    for (const [cabecalho, valor] of Object.entries(ESPERADOS)) {
      assert.equal(
        res.headers[cabecalho],
        valor,
        `${cabecalho} ausente ou diferente no ${nome} (status ${res.statusCode})`,
      );
    }
  });
}

/**
 * A CSP daqui existe por causa de UMA página, e é essa página que o teste
 * precisa olhar: o `/u/:handle` é o HTML que circula em link.
 *
 * Confere o que a política PERMITE contra o que o template realmente usa, e não
 * a string contra ela mesma — isso o laço acima já faz. Se alguém puser um
 * `<script>` ou um `<img>` no perfil público, a página passa a nascer quebrada
 * em produção e o único aviso seria este teste.
 *
 * O 404 e não um perfil de verdade: o corpo dos dois sai do mesmo handler, com
 * o mesmo `reply.type("text/html")`, e um perfil exigiria criar conta — o que
 * poria fixture num arquivo que existe para testar um gancho.
 */
test("#42 — o HTML do perfil público não usa nada que a CSP dele proíba", async () => {
  const res = await app.inject({ method: "GET", url: "/u/ninguem" });

  assert.match(res.headers["content-type"] ?? "", /text\/html/);
  assert.doesNotMatch(res.body, /<script/i, "`script-src` está em 'none'");
  assert.doesNotMatch(res.body, /<img/i, "o template não devia carregar imagem");
  assert.doesNotMatch(res.body, /<form/i, "`form-action` está em 'none'");
  assert.doesNotMatch(res.body, /<base/i, "`base-uri` está em 'none'");
});
