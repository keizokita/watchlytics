import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { buildApp, scrub } from "./obs.ts";

/**
 * O que estes testes guardam: que um 500 em produção deixa rastro suficiente
 * para ser depurado, e que esse rastro não carrega segredo nenhum.
 *
 * Não precisam de banco: `buildApp` é só Fastify + logger + error handler.
 */

/** Captura as linhas JSON que o pino escreveria em stdout. */
function captura() {
  const linhas: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      linhas.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    linhas,
    /** Tudo junto: é assim que o segredo chegaria no agregador do Fly. */
    texto: () => linhas.join(""),
    eventos: () => linhas.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const SEGREDO = "a".repeat(48);

test("um 500 sai no log com stack, rota e método; o cliente leva só o id", async () => {
  const log = captura();
  const app = buildApp(log.stream);
  app.get("/v1/explode/:id", async () => {
    throw new Error("coluna inexistente em titles");
  });

  const res = await app.inject({ method: "GET", url: "/v1/explode/42" });
  await app.close();

  assert.equal(res.statusCode, 500);

  const corpo = res.json();
  assert.equal(typeof corpo.requestId, "string");
  assert.ok(corpo.requestId.length > 0, "resposta carrega o id de correlação");
  assert.equal(corpo.message, "erro interno", "mensagem interna não vaza");
  assert.ok(
    !JSON.stringify(corpo).includes("coluna inexistente"),
    "stack e mensagem interna não vão para o cliente",
  );

  const erro = log
    .eventos()
    .find((e) => typeof e["level"] === "number" && (e["level"] as number) >= 50);
  assert.ok(erro, "o 500 produziu uma linha de nível error");

  const err = erro["err"] as { stack?: string; message?: string };
  assert.match(err.stack ?? "", /obs\.test\.ts/, "stack no log");
  assert.equal(err.message, "coluna inexistente em titles");
  assert.equal(erro["method"], "GET");
  assert.equal(erro["route"], "/v1/explode/:id");
  assert.equal(
    erro["reqId"],
    corpo.requestId,
    "o id do log é o mesmo que o cliente recebeu",
  );
});

test("4xx não polui o log de erro", async () => {
  const log = captura();
  const app = buildApp(log.stream);
  app.get("/v1/negado", async () => {
    throw Object.assign(new Error("não autenticado"), { statusCode: 401 });
  });

  const res = await app.inject({ method: "GET", url: "/v1/negado" });
  await app.close();

  assert.equal(res.statusCode, 401);
  assert.equal(
    res.json().message,
    "não autenticado",
    "4xx mantém a mensagem que o cliente já usava",
  );
  assert.equal(
    log
      .eventos()
      .filter(
        (e) => typeof e["level"] === "number" && (e["level"] as number) >= 50,
      ).length,
    0,
    "nenhuma linha de erro para um 401",
  );
});

test("segredo nunca vira linha de log", async (t) => {
  const anterior = process.env["AUTH_SECRET"];
  process.env["AUTH_SECRET"] = SEGREDO;
  t.after(() => {
    if (anterior === undefined) delete process.env["AUTH_SECRET"];
    else process.env["AUTH_SECRET"] = anterior;
  });

  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.assinatura-secreta";
  const refresh = "rt_9f3c1d2e8a7b6c5d4e3f2a1b";
  const oauth = "4/0AeanS0b-codigo-do-google";

  const log = captura();
  const app = buildApp(log.stream);
  app.get("/v1/auth/callback", async () => {
    // O jeito realista de vazar: ninguém loga o segredo de propósito, ele vem
    // dentro da mensagem de um erro de baixo nível.
    throw new Error(
      `falha ao trocar o código: {"refresh_token":"${refresh}","id_token":"${jwt}"} ` +
        `para keizokita1@gmail.com com AUTH_SECRET=${SEGREDO}`,
    );
  });

  const res = await app.inject({
    method: "GET",
    url: `/v1/auth/callback?code=${oauth}&code_verifier=v3rif1er&state=ok`,
    headers: { authorization: `Bearer ${jwt}` },
  });
  await app.close();

  assert.equal(res.statusCode, 500);

  const texto = log.texto();
  assert.ok(texto.length > 0, "sanidade: alguma coisa foi logada");
  for (const segredo of [
    SEGREDO,
    jwt,
    refresh,
    oauth,
    "v3rif1er",
    "keizokita1@gmail.com",
  ]) {
    assert.ok(
      !texto.includes(segredo),
      `vazou no log: ${segredo.slice(0, 12)}…`,
    );
  }

  // A redação não pode apagar o que serve para depurar.
  assert.match(texto, /\/v1\/auth\/callback/, "a rota continua no log");
  assert.match(texto, /state=ok/, "parâmetro inofensivo continua legível");
});

test("scrub redige em texto livre", () => {
  assert.equal(
    scrub("Key (email)=(ana@exemplo.com) already exists"),
    "Key (email)=([email]) already exists",
  );
  assert.equal(
    scrub("GET /cb?code=abc&state=ok"),
    "GET /cb?code=[redigido]&state=ok",
  );
  assert.equal(scrub("sem nada sensível"), "sem nada sensível");
});
