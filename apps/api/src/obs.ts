import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type { Writable } from "node:stream";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
} from "fastify";

/**
 * Observabilidade da api: logger estruturado, error handler global e redação
 * de segredo antes de qualquer coisa virar linha de log.
 *
 * Sem dependência nova. O pino já vem dentro do Fastify, já escreve uma linha
 * JSON por evento — que é exatamente o que o Fly agrega — e já põe um id de
 * correlação no logger filho de cada requisição. Um logger próprio aqui seria
 * reescrever o que a dependência que já está instalada faz melhor.
 *
 * Sentry e afins ficaram de fora: são conta nova, SDK novo e egress a partir do
 * processo que serve requisição, para um beta de 10 a 30 pessoas em que o
 * `fly logs` já mostra a linha. A decisão de assinar é do usuário; o que este
 * arquivo garante é que, quando ela vier, exista linha estruturada para mandar.
 */

// ─── Redação ────────────────────────────────────────────────────────────────

/**
 * Nomes de campo cujo valor nunca pode aparecer no log. A lista casa por
 * SUBSTRING de propósito: `id_token`, `refresh_token`, `code_verifier` e
 * `client_secret` entram todos por `token`, `refresh`, `code` e `secret`.
 * Redigir demais custa uma linha de debug; redigir de menos custa uma conta.
 */
const SENSIVEL =
  "[a-z0-9_.-]*(?:token|secret|password|passwd|refresh|code|email|auth)[a-z0-9_.-]*";

/** `?code=abc`, `&access_token=xyz` — a query string do OAuth mora na URL. */
const COMO_QUERY = new RegExp(`\\b(${SENSIVEL})=([^&\\s"']*)`, "gi");

/** `"refreshToken": "abc"` — erro do postgres imprime a linha que violou. */
const COMO_JSON = new RegExp(
  `"(${SENSIVEL})"\\s*:\\s*("[^"]*"|[^,}\\s]+)`,
  "gi",
);

/** JWT solto, sem nome de campo por perto: header `eyJ` e três blocos. */
const COMO_JWT = /\beyJ[\w-]*\.[\w-]+\.[\w-]*/g;

/**
 * E-mail em qualquer posição. É o vazamento mais fácil de acontecer sem
 * ninguém escrever `log(email)`: `duplicate key ... Key (email)=(a@b.com)`
 * vem pronto na mensagem do postgres.
 */
const COMO_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Redige segredo em texto livre: URL, mensagem de erro, stack. */
export function scrub(text: string): string {
  // O AUTH_SECRET é literal e não tem nome de campo do lado quando escapa —
  // sai por comparação com o valor, lido a cada chamada porque o processo pode
  // subir sem ele (teste, ferramenta de linha de comando).
  const segredo = process.env["AUTH_SECRET"];
  const semSegredo =
    segredo && segredo.length >= 8 ? text.split(segredo).join("[redigido]") : text;

  return semSegredo
    .replace(COMO_QUERY, "$1=[redigido]")
    .replace(COMO_JSON, '"$1":"[redigido]"')
    .replace(COMO_JWT, "[redigido]")
    .replace(COMO_EMAIL, "[email]");
}

// ─── Logger ─────────────────────────────────────────────────────────────────

/**
 * Serializers são lista de PERMISSÃO, não de bloqueio. O serializer padrão do
 * pino despeja toda propriedade própria do erro, e um erro do postgres carrega
 * `query` e `parameters` — onde moram o hash do refresh e o e-mail. Escolher
 * campo a campo é o que impede o vazamento de um erro que ainda não existe.
 */
function loggerOptions(dest?: Writable) {
  return {
    // Com `dest`, quem chamou quer as linhas de volta para inspecionar — é o
    // teste. O LOG_LEVEL do ambiente (silent, durante a suíte) não vale ali,
    // senão o teste da redação passaria por não ter nada para ler.
    level: dest ? "info" : (process.env["LOG_LEVEL"] ?? "info"),
    serializers: {
      req: (req: {
        method: string;
        url: string;
        routeOptions?: { url?: string };
      }) => ({
        method: req.method,
        url: scrub(req.url),
        route: req.routeOptions?.url ?? null,
        // Sem `ip`: o padrão do Fastify loga o endereço remoto, e para depurar
        // um 500 método e rota bastam. Menos dado pessoal em repouso no Fly.
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      err: (err: Error & { statusCode?: number }) => ({
        type: err.name,
        message: scrub(err.message ?? ""),
        stack: scrub(err.stack ?? ""),
        statusCode: err.statusCode ?? null,
      }),
    },
    // Rede de segurança para quem vier depois e logar um objeto direto, sem
    // passar por serializer nenhum.
    redact: {
      paths: [
        "token",
        "refresh",
        "code",
        "email",
        "password",
        "secret",
        "*.token",
        "*.refresh",
        "*.code",
        "*.email",
        "*.password",
        "*.secret",
        "headers.authorization",
        "headers.cookie",
      ],
      censor: "[redigido]",
    },
    ...(dest ? { stream: dest } : {}),
  };
}

// ─── Composição ─────────────────────────────────────────────────────────────

/**
 * Fastify já configurado. `dest` existe para o teste capturar as linhas; em
 * produção fica indefinido e o pino escreve em stdout, que é de onde o Fly lê.
 */
export function buildApp(dest?: Writable): FastifyInstance {
  const app = Fastify({
    // Id de correlação. O Fastify o injeta como `reqId` no logger filho, então
    // toda linha da requisição já sai com ele — inclusive a do erro. É o fio
    // entre "quebrou na minha tela" e a linha no `fly logs`.
    genReqId: () => randomUUID(),
    logger: loggerOptions(dest),
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;

    if (status < 500) {
      // 4xx é o contrato funcionando: 401 sem token, 400 de validação, 404 de
      // handle que não existe. Não entra no log de erro — alerta que dispara
      // no esperado é alerta que a gente aprende a ignorar. A linha de acesso
      // do próprio Fastify continua registrando o status.
      reply.code(status).send({
        statusCode: status,
        error: STATUS_CODES[status] ?? "Error",
        message: err.message,
      });
      return;
    }

    req.log.error(
      { err, method: req.method, route: req.routeOptions?.url ?? scrub(req.url) },
      "erro não tratado",
    );

    // Stack e mensagem interna ficam no log. O cliente leva só o id, que é o
    // que ele pode nos mandar sem que a gente exponha o de dentro do processo.
    reply.code(status).send({
      statusCode: status,
      error: STATUS_CODES[status] ?? "Internal Server Error",
      message: "erro interno",
      requestId: req.id,
    });
  });

  return app;
}
