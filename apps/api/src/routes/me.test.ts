import assert from "node:assert/strict";
import test from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import { db, pg } from "../db/client.ts";
import {
  consents,
  friendships,
  identities,
  libraryEntries,
  matches,
  notifications,
  sessions,
  swipes,
  titles,
  users,
} from "../db/schema.ts";
import { buildServer } from "../server.ts";

/**
 * O que este arquivo guarda (C6, PLAN §8.4 e §8.5):
 *   1. a exclusão é REAL e em cascata — nenhuma linha sobra em tabela nenhuma
 *   2. apagar a minha conta não apaga a conta de quem é meu amigo
 *   3. o export abre como JSON e traz catálogo, swipes, amigos e matches
 *   4. o export não vaza credencial (hash de refresh não é dado pessoal)
 *
 * Usuário próprio, não o DEV_USER_ID do .env: os arquivos de teste rodam em
 * paralelo, e este aqui apaga a conta inteira.
 */
const USER = "00000000-0000-4000-8000-0000000000c6";
/** Ids escolhidos para cercar o USER: friendships exige `user_a < user_b`. */
const LEFT = "00000000-0000-4000-8000-0000000000c5";
const RIGHT = "00000000-0000-4000-8000-0000000000c7";

process.env["DEV_USER_ID"] = USER;

const app = buildServer();

const pool = await db.select().from(titles).orderBy(asc(titles.id)).limit(2);
assert.ok(pool.length === 2, "o banco precisa estar semeado (npm run seed)");
const [one, two] = [pool[0]!.id, pool[1]!.id];

/** Hash de sessão plantado: o export não pode conter isto em lugar nenhum. */
const SEGREDO = "hash-de-refresh-que-nao-pode-vazar-c6";

/** Uma linha em cada tabela que aponta para `users`. */
async function seed() {
  await db
    .insert(users)
    .values([
      { id: LEFT, handle: "c6-esquerda", displayName: "Esquerda" },
      { id: USER, handle: "c6-alvo", displayName: "Alvo", email: "alvo@exemplo.test" },
      { id: RIGHT, handle: "c6-direita", displayName: "Direita" },
    ])
    .onConflictDoNothing();

  await db
    .insert(identities)
    .values({
      provider: "google",
      providerUserId: "sub-c6",
      userId: USER,
      emailAtProvider: "alvo@exemplo.test",
    })
    .onConflictDoNothing();

  await db.insert(sessions).values({
    userId: USER,
    refreshTokenHash: SEGREDO,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  await db
    .insert(consents)
    .values({ userId: USER, kind: "profiling", version: "2026-09-02" })
    .onConflictDoNothing();

  await db
    .insert(swipes)
    .values({ userId: USER, titleId: one, direction: 1 })
    .onConflictDoNothing();

  await db
    .insert(libraryEntries)
    .values({ userId: USER, titleId: one, status: "watched", rating: 5 })
    .onConflictDoNothing();

  // Dos dois lados do par normalizado: a cascata tem que pegar dando na chave
  // `user_a` ou na `user_b`, e é fácil só uma estar coberta.
  await db
    .insert(friendships)
    .values([
      { userA: LEFT, userB: USER, requestedBy: LEFT, status: "accepted" },
      { userA: USER, userB: RIGHT, requestedBy: USER, status: "pending" },
    ])
    .onConflictDoNothing();

  await db
    .insert(matches)
    .values({ userA: LEFT, userB: USER, titleId: two, strength: 3 })
    .onConflictDoNothing();

  await db
    .insert(notifications)
    .values({ userId: USER, type: "match", payload: { titleId: two } });
}

/**
 * Conta, numa consulta só, tudo que aponta para um usuário.
 *
 * SQL cru de propósito: o que este teste tem que provar é que NENHUMA tabela
 * ficou para trás, e a lista explícita é a única forma de alguém que criar a
 * nona tabela ver que precisa vir aqui.
 */
async function rowsFor(id: string): Promise<Record<string, number>> {
  const rows = (await db.execute(sql`
    select
      (select count(*) from users           where id      = ${id}) as users,
      (select count(*) from identities      where user_id = ${id}) as identities,
      (select count(*) from sessions        where user_id = ${id}) as sessions,
      (select count(*) from consents        where user_id = ${id}) as consents,
      (select count(*) from swipes          where user_id = ${id}) as swipes,
      (select count(*) from library_entries where user_id = ${id}) as library_entries,
      (select count(*) from notifications   where user_id = ${id}) as notifications,
      (select count(*) from friendships
        where user_a = ${id} or user_b = ${id} or requested_by = ${id}) as friendships,
      (select count(*) from matches
        where user_a = ${id} or user_b = ${id}) as matches
  `)) as unknown as Record<string, unknown>[];

  return Object.fromEntries(
    Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)]),
  );
}

test.after(async () => {
  for (const id of [LEFT, USER, RIGHT]) {
    await db.delete(users).where(eq(users.id, id));
  }
  await app.close();
  await pg.end();
});

test("C6 — export abre como JSON e traz catálogo, swipes, amigos e matches", async () => {
  await seed();

  const res = await app.inject({ method: "POST", url: "/v1/me/export" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /application\/json/);
  assert.match(
    res.headers["content-disposition"] as string,
    /attachment; filename="watchlytics-c6-alvo\.json"/,
    "portabilidade é arquivo que a pessoa abre, não corpo de API",
  );

  // "abre como JSON" é o pronto-quando: parse do corpo cru, não do helper.
  const data = JSON.parse(res.body) as {
    user: { handle: string; email: string };
    identities: unknown[];
    consents: unknown[];
    swipes: unknown[];
    library: unknown[];
    friends: unknown[];
    matches: unknown[];
    notifications: unknown[];
  };

  assert.equal(data.user.handle, "c6-alvo");
  assert.equal(data.user.email, "alvo@exemplo.test");
  // PLAN §8.5 nomeia os quatro:
  assert.equal(data.library.length, 1, "catálogo");
  assert.equal(data.swipes.length, 1, "swipes");
  assert.equal(data.friends.length, 2, "amigos dos dois lados do par");
  assert.equal(data.matches.length, 1, "matches");
  // e o que o §8.1 manda registrar tem que sair junto:
  assert.equal(data.consents.length, 1);
  assert.equal(data.identities.length, 1);
  assert.equal(data.notifications.length, 1);

  assert.ok(
    !res.body.includes(SEGREDO),
    "sessão é credencial, não dado pessoal: o hash não pode sair no export",
  );
});

test("C6 — DELETE /v1/me apaga em cascata, sem sobrar linha em tabela nenhuma", async () => {
  await seed();

  const antes = await rowsFor(USER);
  for (const [tabela, n] of Object.entries(antes)) {
    assert.ok(n > 0, `o teste precisa de linha em ${tabela} para provar algo`);
  }

  const res = await app.inject({ method: "DELETE", url: "/v1/me" });
  assert.equal(res.statusCode, 204);

  const depois = await rowsFor(USER);
  assert.deepEqual(
    depois,
    Object.fromEntries(Object.keys(antes).map((k) => [k, 0])),
    "exclusão real: PLAN §8.4 proíbe soft-delete de PII fingindo ser exclusão",
  );

  // O cookie de refresh do navegador aponta para uma sessão que não existe mais.
  assert.match(
    res.headers["set-cookie"] as string,
    /wl_refresh=;.*Max-Age=0/,
    "a conta sumiu; o cliente não pode continuar com a credencial",
  );

  // A conta do amigo não é minha para apagar.
  assert.equal((await rowsFor(LEFT))["users"], 1);
  assert.equal((await rowsFor(RIGHT))["users"], 1);
});

test("C6 — apagar duas vezes é 404, não 500", async () => {
  const res = await app.inject({ method: "DELETE", url: "/v1/me" });
  assert.equal(res.statusCode, 404);
});

test("sem DEV_USER_ID as rotas de conta respondem 401", async () => {
  const saved = process.env["DEV_USER_ID"];
  delete process.env["DEV_USER_ID"];
  try {
    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/me/export" })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: "/v1/me" })).statusCode,
      401,
    );
  } finally {
    process.env["DEV_USER_ID"] = saved;
  }
});
