#!/usr/bin/env node
/**
 * feed-bench — mede p50/p95 do GET /v1/feed contra o catálogo real.
 *
 * Existe porque o gatilho do PLAN §4 ("p95 > 200ms → cache de página, e aí entra
 * Redis") nunca foi medido: a única medição era o EXPLAIN do A6, feito sobre a
 * fixture de 94 títulos. Produção tem ~9,8k, e a query carrega boost por gênero,
 * ruído semeado e keyset.
 *
 * MEDE, NÃO OTIMIZA. A decisão sobre cache é do usuário e está no PLAN.
 *
 * Uso (a api precisa estar de pé apontando para o MESMO banco):
 *   node tools/feed-bench.mjs --api http://localhost:3003 --samples 100
 *
 * Por que várias contas: `requireUserId` limita 120 req/min POR CONTA
 * (ACCOUNT_PER_MIN). Uma conta só transformaria metade da amostra em 429. As
 * contas nascem idênticas — mesmo conjunto de swipes — para que a medição
 * compare cenário, não perfil de usuário.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
process.loadEnvFile(join(ROOT, "apps/api/.env"));

const { default: postgres } = await import("postgres");
const { signAccess } = await import(join(ROOT, "apps/api/src/auth.ts"));

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};

const API = arg("api", `http://localhost:${process.env["WL_API_PORT"] ?? 3003}`);
const SAMPLES = Number(arg("samples", 100));
const WARMUP = Number(arg("warmup", 10));
const SWIPES = Number(arg("swipes", 400));
const CONTAS = Number(arg("accounts", 30));
const CONC = Number(arg("conc", 10));
const MARCA = process.env["WL_BENCH_TAG"] ?? randomUUID().slice(0, 8);

const sql = postgres(process.env["DATABASE_URL"]);

// ─── estatística ────────────────────────────────────────────────────────────

/** Percentil por interpolação linear; com n=100 a diferença é decimal, mas
 *  evita que p95 de amostra pequena vire "o pior de 20". */
function pct(ordenado, p) {
  if (!ordenado.length) return NaN;
  const i = (ordenado.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi
    ? ordenado[lo]
    : ordenado[lo] + (ordenado[hi] - ordenado[lo]) * (i - lo);
}

const resumo = (ms) => {
  const o = [...ms].sort((a, b) => a - b);
  return {
    n: o.length,
    min: o[0],
    p50: pct(o, 0.5),
    p95: pct(o, 0.95),
    p99: pct(o, 0.99),
    max: o.at(-1),
  };
};

const ms = (x) => (Number.isFinite(x) ? `${x.toFixed(1)}ms` : "—");

/** `node tools/feed-bench.mjs --check` — o percentil é a única conta que pode
 *  errar em silêncio e fazer o relatório inteiro mentir. */
if (process.argv.includes("--check")) {
  const { default: assert } = await import("node:assert/strict");
  const cem = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(pct(cem, 0), 1);
  assert.equal(pct(cem, 1), 100);
  assert.equal(pct(cem, 0.5), 50.5); // entre o 50º e o 51º
  assert.equal(pct([7], 0.95), 7);
  assert.equal(pct([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Number.isNaN(pct([], 0.5)));
  // resumo ordena por valor, não pela ordem de chegada.
  assert.deepEqual(resumo([3, 1, 2]), { n: 3, min: 1, p50: 2, p95: 2.9, p99: 2.98, max: 3 });
  console.log("ok");
  process.exit(0);
}

// ─── contas de bancada ──────────────────────────────────────────────────────

/**
 * Conta como o OAuth a deixaria DEPOIS das duas portas: `birth_year` e
 * `handle_chosen` preenchidos. Sem isso `/v1/feed` responde 403 e a medição
 * mede a porta, não o feed. (CLAUDE.md: porta nova invalida conta de fixture
 * criada em SQL — é exatamente este o caso.)
 */
async function criarContas(n, swipesPorConta, grupo) {
  const linhas = await sql`
    insert into users ${sql(
      Array.from({ length: n }, (_, i) => ({
        handle: `bench-${MARCA}-${grupo}-${i}`,
        display_name: "Feed Bench",
        birth_year: 1990,
        handle_chosen: true,
      })),
    )}
    returning id`;
  const ids = linhas.map((r) => r.id);

  if (swipesPorConta > 0) {
    // Swipes sobre o topo do score: é o que o feed serve, então é o que o
    // usuário real já decidiu. Direção alternada 50/50 para que os pesos de
    // gênero não degenerem em "tudo like".
    await sql`
      insert into swipes (user_id, title_id, direction, updated_at)
      select u.id,
             t.id,
             case when (t.rn % 2) = 0 then 1 else -1 end,
             now()
        from unnest(${ids}::uuid[]) u(id)
        join (
          select id, row_number() over (order by score desc, id desc) rn
            from titles
           order by score desc, id desc
           limit ${swipesPorConta}
        ) t on true
      on conflict do nothing`;
  }

  // O planner precisa enxergar o volume novo, senão o primeiro cenário mede
  // estatística velha e os seguintes medem outra coisa.
  await sql`analyze swipes`;

  return ids.map((id) => ({ id, token: signAccess(id) }));
}

/**
 * Apaga TODA conta de bancada, não só as desta execução: um run que morre no
 * meio (erro de porta, 429, Ctrl-C) deixa contas para trás, e a marca delas
 * morre junto com o processo. Assume que a ferramenta é dona do banco — o que é
 * verdade na faixa por sessão do CLAUDE.md. `users` cascateia para `swipes`.
 */
const limpar = () => sql`delete from users where handle like 'bench-%'`;

// ─── requisição ─────────────────────────────────────────────────────────────

async function pedir(conta, params) {
  const url = `${API}/v1/feed${params ? `?${params}` : ""}`;
  const t0 = performance.now();
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${conta.token}` },
  });
  const corpo = await res.json();
  const dt = performance.now() - t0;
  if (res.status !== 200) {
    throw new Error(`${res.status} ${JSON.stringify(corpo).slice(0, 200)}`);
  }
  return { dt, corpo };
}

/**
 * Uma amostra. `paginas` diz quantas requisições ela custa e qual é
 * cronometrada: paginação precisa buscar a página 1 para ter cursor, e o que
 * interessa é a última.
 */
async function amostra(nome, conta, montar, paginas) {
  let cursor = null;
  let dt = 0;
  let corpo = null;

  for (let p = 1; p <= paginas; p++) {
    const params = montar(cursor);
    ({ dt, corpo } = await pedir(
      conta,
      cursor
        ? `${params}${params ? "&" : ""}cursor=${encodeURIComponent(cursor)}`
        : params,
    ));
    cursor = corpo.nextCursor;
    if (!cursor && p < paginas) {
      throw new Error(`${nome}: acabou o feed na página ${p}, sem cursor`);
    }
  }
  return { dt, corpo };
}

/**
 * Roda um cenário com as contas em rodízio. `conc` = requisições em voo ao
 * mesmo tempo: com 1 mede a latência que um usuário sozinho vê (o piso), com N
 * mede o que N pessoas simultâneas veem — que é a pergunta do beta.
 */
async function cenario(nome, contas, montar, paginas = 1, conc = 1) {
  const tempos = [];
  const relaxados = new Set();
  let itens = null;
  let rodada = 0;

  /** Uma leva de `conc` amostras em voo ao mesmo tempo. */
  const leva = async (quantas, guardar) => {
    const lote = [];
    for (let k = 0; k < quantas; k++) {
      const conta = contas[rodada++ % contas.length];
      lote.push(amostra(nome, conta, montar, paginas));
    }
    for (const { dt, corpo } of await Promise.all(lote)) {
      if (!guardar) continue;
      tempos.push(dt);
      for (const r of corpo.relaxed ?? []) relaxados.add(r);
      itens ??= corpo.items.length;
    }
  };

  // Aquecimento fora do relógio: as primeiras requisições pagam JIT, pool de
  // conexões e cache frio, e entrariam no p95 como se fossem o caso comum.
  for (let i = 0; i < WARMUP; i += conc) {
    await leva(Math.min(conc, WARMUP - i), false);
  }

  const t0 = performance.now();
  for (let i = 0; i < SAMPLES; i += conc) {
    await leva(Math.min(conc, SAMPLES - i), true);
  }
  const wall = (performance.now() - t0) / 1000;

  return {
    nome,
    itens,
    conc,
    // Requisições, não amostras: a paginação custa `paginas` requisições cada.
    rps: (SAMPLES * paginas) / wall,
    relaxados: [...relaxados],
    ...resumo(tempos),
  };
}

// ─── EXPLAIN ANALYZE da query de verdade ────────────────────────────────────

/**
 * Usa `feedPage().toSQL()`, o mesmo caminho do teste A6: dar EXPLAIN numa query
 * reescrita à mão mede a cópia, que envelhece à parte da rota.
 */
async function explain(conta, q, rotulo) {
  const { feedPage } = await import(join(ROOT, "apps/api/src/routes/feed.ts"));
  const [u] = await sql`select taste_vector from users where id = ${conta.id}`;
  // pgvector sem parser volta como string "[0.5,...]" pelo postgres.js cru.
  const bruto = u?.taste_vector;
  const pesos =
    typeof bruto === "string"
      ? JSON.parse(bruto)
      : (bruto ?? Array.from({ length: 19 }, () => 0.5));

  const query = feedPage(q, conta.id, {
    weights: pesos.map(Number),
    seed: 1,
    recycle: false,
    dropped: [],
    after: null,
  }).toSQL();

  const plano = await sql.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, SERIALIZE) ${query.sql}`,
    query.params,
  );
  return `── ${rotulo}\n${plano.map((r) => r["QUERY PLAN"]).join("\n")}`;
}

// ─── de onde vem o tempo ────────────────────────────────────────────────────

/**
 * `/v1/feed` faz TRÊS idas ao banco, não uma. Medir só a query do deck diria
 * que o feed custa 34ms quando a resposta custa 77ms. Esta função cronometra
 * cada ida de fora da rota — sem instrumentar `feed.ts`, que não é meu.
 *
 * Os SQL são os mesmos que `auth.ts` e `feed.ts` emitem; se algum deles mudar,
 * este bloco passa a medir o passado. É atribuição de custo, não contrato.
 */
async function decomposicao(conta, repeticoes = 50) {
  const { feedPage } = await import(join(ROOT, "apps/api/src/routes/feed.ts"));
  const [u] = await sql`select taste_vector from users where id = ${conta.id}`;
  const bruto = u?.taste_vector;
  const pesos = (
    typeof bruto === "string"
      ? JSON.parse(bruto)
      : (bruto ?? Array.from({ length: 19 }, () => 0.5))
  ).map(Number);

  const query = feedPage({}, conta.id, {
    weights: pesos,
    seed: 1,
    recycle: false,
    dropped: [],
    after: null,
  }).toSQL();

  const passos = {
    "requireUserId: SELECT users pela PK": () =>
      sql`select birth_year, handle_chosen from users where id = ${conta.id}`,
    "recomputeWeights: agregado de swipes": () => sql`
      select g as genre,
             count(*) filter (where s.direction = 1) as likes,
             count(*) as total
        from swipes s
        join titles t on t.id = s.title_id,
             unnest(t.genre_ids) g
       where s.user_id = ${conta.id}
       group by g`,
    "recomputeWeights: UPDATE taste_vector": () =>
      sql`update users set taste_vector = ${`[${pesos.join(",")}]`} where id = ${conta.id}`,
    "feedPage: a query do deck": () => sql.unsafe(query.sql, query.params),
  };

  const out = [];
  for (const [nome, correr] of Object.entries(passos)) {
    const t = [];
    for (let i = 0; i < repeticoes; i++) {
      const t0 = performance.now();
      await correr();
      t.push(performance.now() - t0);
    }
    out.push({ nome, ...resumo(t) });
  }
  return out;
}

// ─── main ───────────────────────────────────────────────────────────────────

const FILTRO_COMBINADO = "types=movie&genres=7&yearFrom=2010&yearTo=2020";

async function main() {
  const [{ count: catalogo }] = await sql`select count(*) from titles`;
  console.log(
    `catálogo: ${catalogo} títulos · api: ${API} · amostras: ${SAMPLES} ` +
      `(+${WARMUP} de aquecimento) · contas: ${CONTAS} × ${SWIPES} swipes · conc: ${CONC}\n`,
  );

  await limpar();
  const comHistorico = await criarContas(CONTAS, SWIPES, "hist");
  const vazias = await criarContas(CONTAS, 0, "vazia");

  const linhas = [];
  linhas.push(await cenario("conta vazia, sem filtro", vazias, () => ""));
  linhas.push(
    await cenario(`conta com ${SWIPES} swipes, sem filtro`, comHistorico, () => ""),
  );
  linhas.push(
    await cenario("filtro combinado (tipo+gênero+ano)", comHistorico, () =>
      FILTRO_COMBINADO,
    ),
  );
  linhas.push(
    await cenario("paginação: página 2", comHistorico, () => "", 2),
  );
  linhas.push(
    await cenario("paginação: página 3", comHistorico, () => "", 3),
  );
  // O beta convida 10 a 30 pessoas. Sozinho o feed é o piso; o que dói é
  // quando várias pessoas abrem o deck ao mesmo tempo.
  linhas.push(
    await cenario(
      `${CONC} pessoas simultâneas, sem filtro`,
      comHistorico,
      () => "",
      1,
      CONC,
    ),
  );

  const larg = Math.max(...linhas.map((l) => l.nome.length));
  console.log(
    `${"cenário".padEnd(larg)}  ${"n".padStart(4)}  ${"min".padStart(8)}` +
      `  ${"p50".padStart(8)}  ${"p95".padStart(8)}  ${"p99".padStart(8)}  ${"max".padStart(8)}` +
      `  ${"req/s".padStart(7)}  itens`,
  );
  for (const l of linhas) {
    console.log(
      `${l.nome.padEnd(larg)}  ${String(l.n).padStart(4)}  ${ms(l.min).padStart(8)}` +
        `  ${ms(l.p50).padStart(8)}  ${ms(l.p95).padStart(8)}  ${ms(l.p99).padStart(8)}` +
        `  ${ms(l.max).padStart(8)}  ${l.rps.toFixed(1).padStart(7)}  ${l.itens}` +
        (l.relaxados.length ? `  relaxed=${l.relaxados.join(",")}` : ""),
    );
  }

  const pior = Math.max(...linhas.map((l) => l.p95));
  console.log(
    `\nGATILHO PLAN §4 (p95 > 200ms): pior p95 medido = ${ms(pior)} → ` +
      (pior > 200 ? "ATINGIDO" : "não atingido"),
  );

  console.log("\nde onde vem o tempo de UMA resposta (só o banco, sem HTTP):");
  for (const p of await decomposicao(comHistorico[0])) {
    console.log(
      `  ${p.nome.padEnd(40)}  p50 ${ms(p.p50).padStart(8)}  p95 ${ms(p.p95).padStart(8)}`,
    );
  }

  console.log("\n" + (await explain(comHistorico[0], {}, "sem filtro")));
  console.log(
    "\n" +
      (await explain(
        comHistorico[0],
        { types: ["movie"], genres: [7], yearFrom: 2010, yearTo: 2020 },
        "filtro combinado",
      )),
  );

  await limpar();
  console.log(JSON.stringify({ catalogo: Number(catalogo), cenarios: linhas }));
}

try {
  await main();
} finally {
  await sql.end();
}
