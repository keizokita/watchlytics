import assert from "node:assert/strict";
import test from "node:test";
import { asc, inArray } from "drizzle-orm";
import { STATS_MIN_WATCHED } from "@watchlytics/contract";
import { db, pg } from "../db/client.ts";
import { libraryEntries, titles, users } from "../db/schema.ts";
import { buildServer } from "../server.ts";

/**
 * D5 — o que este arquivo guarda:
 *   1. perfil privado é 404 IDÊNTICO ao inexistente (não confirma conta)
 *   2. o piso de 10 assistidos vale igual no perfil público (PLAN §8.3)
 *   3. as OG tags existem e são o que o crawler lê — não é SPA vazia
 *   4. display_name do usuário sai ESCAPADO no HTML
 *
 * Usuários próprios: os arquivos de teste rodam em paralelo.
 */
const PUBLICO = "00000000-0000-4000-8000-0000000000d5";
const PRIVADO = "00000000-0000-4000-8000-0000000000d6";

await db
  .insert(users)
  .values([
    {
      id: PUBLICO,
      handle: "perfil-publico",
      // O `<script>` é o teste do escape, não decoração.
      displayName: 'Ana <script>alert("xss")</script>',
      isPublic: true,
    },
    { id: PRIVADO, handle: "perfil-privado", displayName: "Bruno", isPublic: false },
  ])
  .onConflictDoNothing();

const pool = await db.select().from(titles).orderBy(asc(titles.id)).limit(20);
assert.ok(
  pool.length >= STATS_MIN_WATCHED,
  "o banco precisa estar semeado (npm run seed)",
);

const app = buildServer();

test.after(async () => {
  await db.delete(users).where(inArray(users.id, [PUBLICO, PRIVADO]));
  await app.close();
  await pg.end();
});

const watched = (userId: string, quantos: number) =>
  db
    .insert(libraryEntries)
    .values(
      pool.slice(0, quantos).map((titulo) => ({
        userId,
        titleId: titulo.id,
        status: "watched" as const,
        watchedAt: new Date(),
      })),
    )
    .onConflictDoNothing();

const get = (url: string) => app.inject({ method: "GET", url });

test("D5 — perfil privado e handle inexistente respondem o MESMO 404", async () => {
  const privado = await get("/v1/users/perfil-privado");
  const inexistente = await get("/v1/users/ninguem-aqui");

  assert.equal(privado.statusCode, 404);
  assert.equal(inexistente.statusCode, 404);
  // Corpo idêntico: qualquer diferença vira oráculo para varrer handles.
  assert.equal(privado.body, inexistente.body);

  assert.equal((await get("/u/perfil-privado")).statusCode, 404);
});

test("D5 — abaixo do piso o público não ganha agregado nenhum", async () => {
  await watched(PUBLICO, STATS_MIN_WATCHED - 1);

  const res = await get("/v1/users/perfil-publico");
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.stats.watchedCount, STATS_MIN_WATCHED - 1);
  assert.equal(body.stats.aggregates, null, "o agregado não é calculado, não é escondido");

  const html = (await get("/u/perfil-publico")).body;
  assert.match(html, /stats unlock at 10/);
  assert.doesNotMatch(html, /screen time/);
});

test("D5 — no piso o preview traz título, descrição e og:url", async () => {
  await watched(PUBLICO, STATS_MIN_WATCHED);

  const res = await get("/u/perfil-publico");
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);

  const html = res.body;
  // O que o WhatsApp e o Slack leem. Sem estas quatro não há preview.
  assert.match(html, /<meta property="og:title" content="[^"]+">/);
  assert.match(html, /<meta property="og:description" content="[^"]+">/);
  assert.match(html, /<meta property="og:url" content="[^"]*\/u\/perfil-publico">/);
  assert.match(html, /<meta property="og:type" content="profile">/);
  assert.match(html, new RegExp(`${STATS_MIN_WATCHED} titles watched`));

  // Sem og:image de propósito: não há pôster, e imagem quebrada no preview é
  // pior que preview de texto. Se um dia entrar, este assert cai junto.
  assert.doesNotMatch(html, /og:image/);
});

test("D5 — display_name do usuário nunca sai cru no HTML", async () => {
  const html = (await get("/u/perfil-publico")).body;

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  // Dentro do content= do meta também, senão o atributo fecha sozinho.
  assert.match(html, /content="Ana &lt;script&gt;[^"]*on Watchlytics"/);
});

test("D5 — handle fora do formato é 404, não 500", async () => {
  assert.equal((await get("/v1/users/..%2Fetc%2Fpasswd")).statusCode, 404);
  assert.equal((await get("/u/ab")).statusCode, 404);
});
