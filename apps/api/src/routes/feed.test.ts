import assert from "node:assert/strict";
import test from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { feedResponse, type FeedResponse } from "@watchlytics/contract";
import { db, pg } from "../db/client.ts";
import { swipes, titles, users } from "../db/schema.ts";
import { buildServer } from "../server.ts";
import { feedPage } from "./feed.ts";

/**
 * O que este arquivo guarda:
 *   A1 os quatro filtros valendo juntos
 *   A3 duas páginas seguidas sem item repetido
 *   A4 gostos opostos produzindo ordens diferentes, e ruído entre sessões
 *   A5 os três degraus da fila vazia, sempre com aviso
 *   A6 a query do feed usando índice em swipes, não seq scan
 *
 * Precisa do banco semeado com DEV_USER_ID definido.
 */
const DEV = process.env["DEV_USER_ID"];
if (!DEV) throw new Error("DEV_USER_ID não definida (veja .env.example)");

/**
 * Usuários próprios do teste. Os casos de A4 e A5 precisam swipar o catálogo
 * inteiro — fazer isso no DEV_USER_ID atropelaria os outros arquivos de teste,
 * que rodam em paralelo contra o mesmo banco.
 */
const LOVES_DRAMA = "00000000-0000-4000-8000-0000000000a1";
const LOVES_ANIMATION = "00000000-0000-4000-8000-0000000000a2";
const SAW_EVERYTHING = "00000000-0000-4000-8000-0000000000a3";
/**
 * A3 pagina, e paginar exige que o conjunto não mude entre as duas páginas.
 * No DEV_USER_ID isso é corrida perdida: `swipes.test.ts` roda em paralelo e
 * apaga os swipes dele seis vezes, e como o score leva o peso por gênero
 * (A4), sumir com os swipes reordena o feed no meio da paginação — a segunda
 * página volta com item da primeira.
 */
const PAGINATES = "00000000-0000-4000-8000-0000000000a4";
const TEST_USERS = [LOVES_DRAMA, LOVES_ANIMATION, SAW_EVERYTHING, PAGINATES];

/** Os dois gêneros mais representados na fixture — material de sobra dos dois lados. */
const DRAMA = 7;
const ANIMATION = 2;

const app = buildServer();

/** Roda o feed como `userId`: o shim C1 (auth.ts) lê o usuário do ambiente. */
async function feed(userId: string, query = ""): Promise<FeedResponse> {
  const saved = process.env["DEV_USER_ID"];
  process.env["DEV_USER_ID"] = userId;
  try {
    const res = await app.inject({ method: "GET", url: `/v1/feed${query}` });
    assert.equal(res.statusCode, 200, `feed respondeu ${res.statusCode}`);
    return feedResponse.parse(res.json());
  } finally {
    process.env["DEV_USER_ID"] = saved;
  }
}

/** Ids dos títulos que têm `genre` e não têm `without`. */
async function idsOf(genre: number, without: number): Promise<string[]> {
  const rows = await db
    .select({ id: titles.id })
    .from(titles)
    .where(
      sql`${titles.genreIds} && ${`{${genre}}`}::smallint[]
          AND NOT ${titles.genreIds} && ${`{${without}}`}::smallint[]`,
    );
  return rows.map((r) => r.id);
}

const swipeAll = (userId: string, ids: string[], direction: 1 | -1) =>
  ids.length
    ? db
        .insert(swipes)
        .values(ids.map((titleId) => ({ userId, titleId, direction })))
        .onConflictDoUpdate({
          target: [swipes.userId, swipes.titleId],
          set: { direction: sql`excluded.direction` },
        })
    : Promise.resolve();

test.before(async () => {
  await db
    .insert(users)
    .values(
      TEST_USERS.map((id, i) => ({
        id,
        handle: `feed-test-${i}`,
        displayName: "Feed test",
      })),
    )
    .onConflictDoNothing();
});

test.after(async () => {
  await db.delete(users).where(inArray(users.id, TEST_USERS)); // cascata leva os swipes
  await app.close();
  await pg.end();
});

// ─── A1 ─────────────────────────────────────────────────────────────────────

test("A1: tipo, gênero, ano e idioma valem combinados", async () => {
  const r = await feed(
    DEV,
    "?types=movie&genres=1&yearFrom=1990&yearTo=2015&languages=en",
  );

  assert.ok(r.items.length > 0, "a fixture precisa casar com este recorte");
  assert.deepEqual(r.relaxed, undefined, "nada foi relaxado");
  for (const i of r.items) {
    assert.equal(i.type, "movie");
    assert.ok(i.genreIds.includes(1), `${i.title} sem o gênero pedido`);
    assert.ok(i.releaseYear >= 1990 && i.releaseYear <= 2015, i.title);
    assert.equal(i.originalLanguage, "en");
  }
});

test("A1: filtro inválido responde 400, não 500", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/feed?genres=999" });
  assert.equal(res.statusCode, 400);
});

// ─── A3 ─────────────────────────────────────────────────────────────────────

test("A3: duas páginas seguidas não repetem item", async () => {
  const first = await feed(PAGINATES);
  assert.equal(first.items.length, 20, "lote de 20");
  assert.ok(first.nextCursor, "página cheia devolve cursor");

  const second = await feed(
    PAGINATES,
    `?cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  assert.equal(second.items.length, 20);

  const seen = new Set(first.items.map((i) => i.id));
  const repeated = second.items.filter((i) => seen.has(i.id));
  assert.deepEqual(repeated.map((i) => i.title), [], "nada se repete");
});

test("A3: cursor adulterado responde 400", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/feed?cursor=lixo" });
  assert.equal(res.statusCode, 400);
});

// ─── A4 ─────────────────────────────────────────────────────────────────────

test("A4: gostos opostos veem ordens diferentes", async () => {
  const drama = (await idsOf(DRAMA, ANIMATION)).slice(0, 8);
  const animation = (await idsOf(ANIMATION, DRAMA)).slice(0, 8);
  assert.ok(drama.length === 8 && animation.length === 8, "fixture insuficiente");

  // Os dois avaliam os MESMOS títulos com sinais trocados: sobra o mesmo pool
  // para os dois, então a diferença de ordem só pode vir do boost.
  await db.delete(swipes).where(inArray(swipes.userId, TEST_USERS));
  await swipeAll(LOVES_DRAMA, drama, 1);
  await swipeAll(LOVES_DRAMA, animation, -1);
  await swipeAll(LOVES_ANIMATION, drama, -1);
  await swipeAll(LOVES_ANIMATION, animation, 1);

  const dramaFan = await feed(LOVES_DRAMA);
  const animationFan = await feed(LOVES_ANIMATION);

  const count = (r: FeedResponse, g: number) =>
    r.items.filter((i) => i.genreIds.includes(g)).length;

  assert.ok(
    count(dramaFan, DRAMA) > count(animationFan, DRAMA),
    `drama na página: fã de drama ${count(dramaFan, DRAMA)} vs ${count(animationFan, DRAMA)}`,
  );
  assert.ok(
    count(animationFan, ANIMATION) > count(dramaFan, ANIMATION),
    `animação na página: fã de animação ${count(animationFan, ANIMATION)} vs ${count(dramaFan, ANIMATION)}`,
  );

  // O vetor é o que fica gravado — o feed é só quem o consome (PLAN §5.4).
  const [row] = await db
    .select({ v: users.tasteVector })
    .from(users)
    .where(eq(users.id, LOVES_DRAMA));
  const v = row?.v;
  assert.equal(v?.length, 19, "uma dimensão por gênero");
  assert.ok(v[DRAMA - 1]! > 0.5, "gênero curtido pesa mais que o neutro");
  assert.ok(v[ANIMATION - 1]! < 0.5, "gênero descartado pesa menos");
});

test("A4: o ruído reordena entre uma abertura de feed e outra", async () => {
  const a = (await feed(DEV)).items.map((i) => i.id);
  const b = (await feed(DEV)).items.map((i) => i.id);
  assert.notDeepEqual(a, b, "feed determinístico parece quebrado");
});

// ─── A5 ─────────────────────────────────────────────────────────────────────

test("A5 degrau 1: relaxa ano → gênero → tipo e diz o que relaxou", async () => {
  // Recorte impossível de propósito: série coreana de faroeste depois de 2024.
  const r = await feed(DEV, "?types=tv&genres=19&yearFrom=2024&languages=ko");

  assert.ok(r.items.length > 0, "não pode sobrar deck vazio");
  assert.deepEqual(r.relaxed, ["year", "genre", "type"], "na ordem da escada");
  assert.ok(
    r.items.every((i) => i.originalLanguage === "ko"),
    "o filtro que ainda não foi relaxado continua valendo",
  );
});

test("A5 degrau 2 e 3: oferece reciclar, depois avisa que acabou", async () => {
  const all = (await db.select({ id: titles.id }).from(titles)).map((t) => t.id);
  await db.delete(swipes).where(eq(swipes.userId, SAW_EVERYTHING));
  await swipeAll(SAW_EVERYTHING, all, -1);

  const offered = await feed(SAW_EVERYTHING);
  assert.deepEqual(offered.items, [], "tudo descartado, nada a mostrar");
  assert.deepEqual(offered.relaxed, ["recycle-offer"], "oferece, não impõe");

  const recycled = await feed(SAW_EVERYTHING, "?recycle=1");
  assert.equal(recycled.items.length, 20, "os descartados voltam");
  assert.deepEqual(recycled.relaxed, ["dislikes"]);

  // agora tudo virou like: nem reciclando sobra alguma coisa
  await swipeAll(SAW_EVERYTHING, all, 1);
  for (const q of ["", "?recycle=1"]) {
    const done = await feed(SAW_EVERYTHING, q);
    assert.deepEqual(done.items, []);
    assert.deepEqual(done.relaxed, ["exhausted"], `degrau 3 em "${q}"`);
  }
});

// ─── A6 ─────────────────────────────────────────────────────────────────────

test("A6: o feed usa índice em swipes, não seq scan", async () => {
  // Com swipes quase vazia o planner varre a tabela e tem razão: são duas
  // páginas. O EXPLAIN só significa alguma coisa com volume, então o teste
  // fabrica ~28k linhas — uma ordem de grandeza abaixo do alvo de 12 meses.
  const bench = await db
    .insert(users)
    .values(
      Array.from({ length: 300 }, (_, i) => ({
        handle: `feed-bench-${i}`,
        displayName: "Bench",
      })),
    )
    .returning({ id: users.id });

  try {
    await db.execute(sql`
      INSERT INTO ${swipes} (user_id, title_id, direction)
      SELECT u.id, t.id, 1 FROM ${users} u, ${titles} t
       WHERE u.id = ANY(${`{${bench.map((b) => b.id).join(",")}}`}::uuid[])
      ON CONFLICT DO NOTHING`);
    await db.execute(sql`ANALYZE ${swipes}`);

    const query = feedPage(
      {},
      DEV,
      {
        weights: Array.from({ length: 19 }, () => 0.5),
        seed: 1,
        recycle: false,
        dropped: [],
        after: null,
      },
    ).toSQL();

    const plan = (await pg.unsafe(`EXPLAIN ${query.sql}`, query.params as never[]))
      .map((r) => String(r["QUERY PLAN"]))
      .join("\n");

    console.log(plan);
    assert.match(plan, /Index Scan on swipes|Bitmap Index Scan on swipes/);
    assert.doesNotMatch(plan, /Seq Scan on swipes/);
  } finally {
    await db.delete(users).where(
      inArray(
        users.id,
        bench.map((b) => b.id),
      ),
    );
    await db.execute(sql`ANALYZE ${swipes}`);
  }
});
