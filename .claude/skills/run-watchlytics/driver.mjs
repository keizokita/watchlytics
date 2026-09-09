#!/usr/bin/env node
/**
 * Driver do run-watchlytics: como um agente dirige este app sem uma janela.
 *
 * Duas camadas, porque é nelas que os PRs mexem:
 *   api  — sobe o Fastify em processo e bate nas rotas com app.inject(),
 *          sem porta e sem servidor de verdade. Segundos, não minutos.
 *   web  — sobe api + vite, dirige um Chrome headless por CDP e tira print.
 *
 * Sem dependência nova: o WebSocket é o global do Node ≥22, o navegador é o
 * google-chrome do sistema. `npm install` não muda por causa deste arquivo.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHOTS = join(tmpdir(), "watchlytics-run");
const API = "http://localhost:3000";
const WEB = "http://localhost:5173";

/** Espelha o VISIBLE do Deck.tsx: os cards que pedem pôster por conta própria. */
const VISIVEIS_NO_DOM = 3;

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a porta responder. Poll, nunca `sleep 5`: o vite varia de 0.4s a 8s. */
async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`${url} não respondeu em ${timeoutMs}ms`);
}

const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✘"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
};

// ─── api: servidor em processo, usuário descartável ─────────────────────────

/**
 * Roda contra um usuário novo a cada execução em vez do DEV_USER_ID do .env.
 *
 * auth.ts lê process.env a cada requisição, então dá para trocar o usuário
 * depois do boot. Importa porque os swipes do driver não podem sujar o feed
 * de quem estiver com o app aberto no navegador — e porque o DELETE do
 * usuário no fim leva os swipes junto por ON DELETE CASCADE.
 */
async function cmdApi() {
  // import() e não import estático: db/client.ts lê DATABASE_URL no topo do
  // módulo, logo o .env precisa já estar carregado quando ele for avaliado.
  const { db, pg } = await import(join(ROOT, "apps/api/src/db/client.ts"));
  const { users, swipes } = await import(join(ROOT, "apps/api/src/db/schema.ts"));
  const { buildServer } = await import(join(ROOT, "apps/api/src/server.ts"));
  const { eq } = await import("drizzle-orm");

  // Restaurado no finally: em `all`, o cmdWeb roda depois e sobe uma api que
  // HERDA este env. Deixar o usuário descartável aqui faria o POST /v1/swipes
  // do navegador estourar a FK contra um usuário já apagado.
  const original = process.env["DEV_USER_ID"];
  const userId = crypto.randomUUID();
  const handle = `driver-${userId.slice(0, 8)}`;
  await db.insert(users).values({ id: userId, handle, displayName: "Driver" });
  process.env["DEV_USER_ID"] = userId;

  const app = buildServer();
  const get = (url) => app.inject({ method: "GET", url });
  const post = (payload) =>
    app.inject({ method: "POST", url: "/v1/swipes", payload });

  try {
    const health = await get("/health");
    ok("GET /health", health.json().ok === true);

    const feed = await get("/v1/feed");
    const items = feed.json().items;
    ok("GET /v1/feed devolve 20", items.length === 20, items[0]?.title);

    // NÃO "score desc": desde o A4 o feed ordena por `final` = score × boost de
    // gênero + ruído (feed.ts:267), e o ruído é requisito — deck determinístico
    // parece quebrado (PLAN §5.2). O `final` não viaja no contrato, então de
    // fora o que dá para afirmar é o que a ordenação promete de verdade: a
    // página sai do topo do catálogo, não do meio. Passava por acidente com a
    // fixture de 94; com 9,9k títulos o ruído reordena sempre.
    const [{ mediana }] = await pg`
      select percentile_cont(0.5) within group (order by score) as mediana
      from titles`;
    const scores = items.map((i) => i.score);
    ok(
      "feed puxa do topo do catálogo, não do meio",
      scores.every((s) => s > Number(mediana)),
      `menor da página ${Math.min(...scores)} · mediana ${Number(mediana)}`,
    );

    const ts = new Date().toISOString();
    const batch = [{ titleId: items[0].id, direction: 1, clientTs: ts }];
    const first = await post(batch);
    ok("POST /v1/swipes aceita", first.json().accepted === 1);

    const again = await post(batch);
    ok(
      "reenvio é upsert, não duplicata",
      again.json().accepted === 1,
      JSON.stringify(again.json()),
    );

    const unknown = await post([
      { titleId: crypto.randomUUID(), direction: -1, clientTs: ts },
    ]);
    ok("título desconhecido é descartado", unknown.json().skipped === 1);

    const bad = await post([]);
    ok("lote vazio responde 400", bad.statusCode === 400);

    const after = await get("/v1/feed");
    const stillThere = after.json().items.some((i) => i.id === items[0].id);
    ok("like sai do feed", !stillThere);

    delete process.env["DEV_USER_ID"];
    ok("sem DEV_USER_ID a rota responde 401", (await get("/v1/feed")).statusCode === 401);
  } finally {
    await db.delete(swipes).where(eq(swipes.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await app.close();
    await pg.end();
    if (original === undefined) delete process.env["DEV_USER_ID"];
    else process.env["DEV_USER_ID"] = original;
  }
}

// ─── chrome por CDP ─────────────────────────────────────────────────────────

/**
 * Cliente CDP mínimo. `--remote-debugging-port=0` faz o Chrome escolher a
 * porta e anunciar a URL no stderr — sem isso, duas execuções em paralelo
 * brigam pela 9222.
 */
async function openChrome() {
  const profile = mkdtempSync(join(tmpdir(), "watchlytics-chrome-"));
  const chrome = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chrome não anunciou o devtools")), 30_000);
    let buf = "";
    chrome.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/ws:\/\/\S+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    chrome.on("exit", (c) => reject(new Error(`chrome saiu com ${c}: ${buf}`)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("websocket do devtools recusou"));
  });

  let nextId = 0;
  const pending = new Map();
  const errors = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params.exceptionDetails.exception?.description ?? "exception");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      // A url vem fora do text; sem ela, "Failed to load resource" não diz o quê.
      errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.trim());
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  // flatten: as respostas da aba voltam pela MESMA conexão, com sessionId.
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

  const page = {
    errors,
    cmd: (method, params) => send(method, params, sessionId),
    close: () => {
      ws.close();
      chrome.kill();
    },
  };

  await page.cmd("Page.enable");
  await page.cmd("Runtime.enable");
  await page.cmd("Log.enable");
  // Deck.tsx lê prefers-reduced-motion UMA vez, no mount: emular depois do
  // navigate não adianta. Com reduce o FLY_MS de 260ms vira 0 e o card troca
  // na hora — o driver não fica adivinhando quanto esperar pela animação.
  await page.cmd("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  // Retrato por padrão: é um app de swipe, e o card é `aspect-ratio: 2/3`.
  // `--viewport LxA` troca para conferir desktop, onde sobra altura e as
  // decisões de alinhamento vertical aparecem.
  const [w, h] = arg("--viewport", "430x932").split("x").map(Number);
  await page.cmd("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile: w < 700,
  });

  return page;
}

/** Espera o seletor existir. React monta depois do fetch — nav não basta. */
async function waitFor(page, selector, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await page.cmd("Runtime.evaluate", {
      expression: `!!document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: true,
    });
    if (result.value) return;
    await sleep(200);
  }
  const { result } = await page.cmd("Runtime.evaluate", {
    expression: "document.body.innerText.slice(0, 400)",
    returnByValue: true,
  });
  throw new Error(`"${selector}" não apareceu em ${timeoutMs}ms. body: ${result.value}`);
}

const evaluate = async (page, expression) =>
  (await page.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
    .result.value;

/** Espera `fn()` mudar de valor. O commit do deck é assíncrono mesmo com ms=0. */
async function until(fn, done, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (done(last)) return last;
    await sleep(100);
  }
  throw new Error(`${what} não aconteceu em ${timeoutMs}ms (último: ${last})`);
}

/** Teclado de verdade: Deck.tsx escuta keydown no window, não no card. */
const pressKey = async (page, key, code) => {
  for (const type of ["keyDown", "keyUp"]) {
    await page.cmd("Input.dispatchKeyEvent", {
      type,
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
  }
};

/** Título do card do topo. O topo é o ÚLTIMO no DOM: Deck.tsx renderiza reverse(). */
const TOP = ".deck .deck-card:last-child .card-title";
const topTitle = (page) =>
  evaluate(page, `document.querySelector(${JSON.stringify(TOP)})?.innerText ?? null`);

async function screenshot(page, out) {
  const { data } = await page.cmd("Page.captureScreenshot", { format: "png" });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`  print: ${out}`);
}

// ─── web: api + vite + chrome ───────────────────────────────────────────────

/**
 * Confere que o swipe do navegador chegou no banco, e APAGA o que este run
 * gravou.
 *
 * Espera em vez de checar na hora: swipeQueue.ts (B6) põe o swipe em
 * localStorage e só faz POST 3s depois (FLUSH_MS) ou aos 5 pendentes. Checar
 * logo após o clique dá zero linha.
 *
 * Apagar importa: sem isso cada execução come dois títulos do feed do usuário
 * de dev — com 94 na fixture o deck acabaria em ~47 runs. A janela por
 * updated_at evita ter que descobrir o uuid do card pelo DOM, já que Deck.tsx
 * usa o id como `key` e o React não põe isso no HTML.
 */
async function checkSwipesGravados(desde, esperados, ignorar = []) {
  const userId = process.env["DEV_USER_ID"];
  if (!userId) return ok("DEV_USER_ID definida para conferir os swipes", false);

  // Conexão própria, NÃO a de db/client.ts: aquele módulo é um singleton e o
  // cmdApi já chamou pg.end() nele. Em `all`, reusar dá CONNECTION_ENDED.
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env["DATABASE_URL"]);
  // Os swipes emprestados para abrir o onboarding caem na MESMA janela, e são
  // dezoito contra dois: sem tirá-los, o `until` volta satisfeito no primeiro
  // poll e a contagem nunca bate. Por id, não por relógio — a folga de um
  // segundo da janela é justamente o que não dá para arbitrar aqui.
  const emprestado = new Set(ignorar);
  const janela = async () =>
    (
      await sql`
        select title_id, direction from swipes
        where user_id = ${userId} and updated_at >= ${desde}`
    ).filter((r) => !emprestado.has(r.title_id));
  try {
    let rows = [];
    try {
      rows = await until(
        janela,
        (r) => r.length >= esperados,
        `a fila do navegador dar flush de ${esperados} swipes`,
        15_000,
      );
    } catch {
      rows = await janela();
    }
    ok(
      `o navegador gravou ${esperados} swipes`,
      rows.length === esperados,
      rows.map((r) => r.direction).join(",") || "nenhum — a fila deu flush?",
    );
    await sql`delete from swipes where user_id = ${userId} and updated_at >= ${desde}`;
  } finally {
    await sql.end();
  }
}

/**
 * detached + kill(-pid): o `npm run dev:*` é um wrapper que não repassa
 * SIGTERM. Matar o grupo inteiro é o que realmente libera a porta — senão a
 * próxima execução morre com EADDRINUSE.
 */
function spawnGroup(script, log) {
  const child = spawn("npm", ["run", script], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  return child;
}

async function cmdWeb() {
  const url = arg("--url", WEB);
  const selector = arg("--wait", ".deck-card");
  const out = arg("--out", join(SHOTS, "web.png"));
  const started = [];
  const log = [];
  let sessao = null;
  /** Swipes que este run inseriu só para abrir o portão do onboarding. */
  let emprestados = [];
  // Um segundo de folga: o relógio do Postgres não é o mesmo do Node.
  const desde = new Date(Date.now() - 1000);

  const up = async (u) => {
    try {
      await fetch(u, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
    }
  };

  try {
    if (!(await up(`${API}/health`))) {
      console.log("subindo a api…");
      started.push(spawnGroup("dev:api", log));
      await waitForHttp(`${API}/health`);
    }
    if (!(await up(url))) {
      console.log("subindo o vite…");
      started.push(spawnGroup("dev:web", log));
      await waitForHttp(url);
    }

    const page = await openChrome();
    try {
      // Sem isto o shell pinta a tela de entrada e o deck nunca monta: desde o
      // C2/C3 o Root só monta o app com sessão, e o shim do DEV_USER_ID não
      // vale para o `POST /v1/auth/refresh` que o Login.tsx usa para resolvê-la.
      await page.cmd("Network.enable");
      sessao = await abrirSessao(page);
      emprestados = await cumprirOnboarding();

      await page.cmd("Page.navigate", { url });
      await waitFor(page, selector);

      const deck = await evaluate(
        page,
        `(() => { const top = document.querySelector('.deck .deck-card:last-child');
          return { cards: document.querySelectorAll('.deck-card').length,
                   botoes: [...document.querySelectorAll('.actions button')].map(b => b.innerText),
                   fundo: getComputedStyle(top).backgroundImage }; })()`,
      );
      const first = await topTitle(page);
      ok("deck renderizou", Boolean(first), first);
      ok("3 cards no DOM (profundidade)", deck?.cards === 3, String(deck?.cards));
      // B4: o gradiente do id é FORRO, não alternativa — as duas camadas, nesta
      // ordem. Só "inclui linear-gradient" era verde no card SEM pôster nenhum,
      // que é o único caso que o B4 não precisa consertar; a ordem é o que pega
      // a regressão se alguém voltar ao ternário.
      ok(
        "pôster na frente, gradiente do id atrás (B4)",
        /^url\(.+\)\s*,\s*linear-gradient\(/.test(deck?.fundo ?? ""),
        deck?.fundo.slice(0, 80),
      );
      // O forro só evita o card preto; quem mata o flash é a pré-carga do
      // Deck.tsx, e sem esta linha apagar o efeito continuaria tudo verde.
      // Resource timing em vez de Network.requestWillBeSent: o dispatcher do
      // openChrome não coleciona requisição, e aqui não precisa colecionar.
      // ...e resource timing só lista o que TERMINOU de carregar. Lido na hora,
      // milissegundos depois de o deck montar, o número é zero mesmo com a
      // pré-carga certa — a asserção reprovaria o código bom. Espera, como o
      // checkSwipesGravados faz com o flush da fila.
      const conta = () =>
        evaluate(
          page,
          `performance.getEntriesByType("resource")
             .filter((r) => r.name.startsWith("https://image.tmdb.org/")).length`,
        );
      let pedidos = 0;
      try {
        pedidos = await until(
          conta,
          (n) => n > VISIVEIS_NO_DOM,
          "a pré-carga pedir além dos cards que estão no DOM",
          15_000,
        );
      } catch {
        pedidos = await conta();
      }
      ok(
        "pré-carga passou dos cards do DOM (B4)",
        pedidos > VISIVEIS_NO_DOM,
        `${pedidos} pôsteres pedidos, ${deck?.cards} cards no DOM`,
      );
      // Contém, não igual: B7 enfiou um Undo no meio e vai vir mais coisa.
      const botoes = deck?.botoes ?? [];
      ok(
        "botões Pass e Like presentes",
        botoes.includes("Pass") && botoes.includes("Like"),
        String(botoes),
      );

      await screenshot(page, out);

      // Fluxo de verdade nº1: clicar em Like avança o deck. Por texto, não por
      // posição: a ordem dos botões já mudou uma vez (B7 inseriu o Undo).
      await evaluate(
        page,
        `[...document.querySelectorAll('.actions button')]
           .find(b => b.innerText.trim() === 'Like').click()`,
      );
      const second = await until(
        () => topTitle(page),
        (v) => v && v !== first,
        "o card do topo trocar depois do Like",
      );
      ok("clique em Like avança o deck", Boolean(second), `${first} → ${second}`);

      // Fluxo de verdade nº2: B3 promete que o gesto não é o único caminho.
      await pressKey(page, "ArrowLeft", 37);
      const third = await until(
        () => topTitle(page),
        (v) => v && v !== second,
        "o card do topo trocar depois do ArrowLeft",
      );
      ok("ArrowLeft (pass) avança o deck", Boolean(third), `${second} → ${third}`);

      await screenshot(page, out.replace(/\.png$/, "-depois.png"));

      const real = page.errors.filter((e) => !/favicon/i.test(e));
      ok("console sem erro", real.length === 0, real.join(" | "));

      await checkSwipesGravados(desde, 2, emprestados);
    } finally {
      page.close();
    }
  } finally {
    await devolver(sessao, emprestados);
    for (const c of started) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
    if (process.exitCode) console.log(log.join(""));
  }
}

/**
 * Sessão de verdade para o headless ver as telas autenticadas.
 *
 * O shim do DEV_USER_ID não resolve isto: ele vale para `requireUserId`, e o
 * shell do web decide o que montar pelo `resume()` do Login.tsx, que chama
 * `POST /v1/auth/refresh` — rota que lê o cookie httpOnly e não passa pelo
 * shim. Sem cookie, `resume()` devolve null e a tela é sempre a de entrada.
 *
 * Grava a linha de `sessions` com a mesma primitiva da api (`newRefreshToken`,
 * importada e não copiada, senão o formato do token derivaria em silêncio) e
 * planta o cookie pelo CDP, que enxerga httpOnly. `Path=/v1/auth` é o mesmo do
 * routes/auth.ts.
 */
async function abrirSessao(page) {
  const userId = process.env["DEV_USER_ID"];
  if (!userId) throw new Error("--sessao precisa de DEV_USER_ID em apps/api/.env");

  const { newRefreshToken, REFRESH_TTL_S } = await import(
    join(ROOT, "apps/api/src/auth.ts")
  );
  const id = crypto.randomUUID();
  const { token, hash } = newRefreshToken(id);

  await comBanco(
    (sql) => sql`
      insert into sessions (id, user_id, refresh_token_hash, expires_at, user_agent)
      values (${id}, ${userId}, ${hash},
              ${new Date(Date.now() + REFRESH_TTL_S * 1000)}, 'driver.mjs shot')`,
  );

  await page.cmd("Network.setCookie", {
    name: "wl_refresh",
    value: token,
    domain: "localhost",
    path: "/v1/auth",
    httpOnly: true,
  });
  return id;
}

/**
 * Passa o usuário de dev pelo portão do onboarding (D4).
 *
 * `remaining = ONBOARDING_SWIPES - swipes do usuário` (routes/onboarding.ts:97),
 * e enquanto sobra o Home monta a tela de gêneros, não o deck. Um DEV_USER_ID
 * limpo deixava o cmdWeb esperando `.deck-card` para sempre.
 *
 * Completa pelos títulos MENOS populares de propósito: os swipes daqui somem no
 * fim, mas enquanto existem eles saem do feed, e comer o topo do catálogo
 * mudaria justamente o card que as asserções vão olhar.
 */
async function cumprirOnboarding() {
  const userId = process.env["DEV_USER_ID"];
  if (!userId) return [];
  const { ONBOARDING_SWIPES } = await import("@watchlytics/contract");

  return comBanco(async (sql) => {
    const [{ n }] = await sql`
      select count(*)::int as n from swipes where user_id = ${userId}`;
    const faltam = ONBOARDING_SWIPES - n;
    if (faltam <= 0) return [];

    const rows = await sql`
      insert into swipes (user_id, title_id, direction)
      select ${userId}, t.id, 1 from titles t
      where not exists (
        select 1 from swipes s where s.user_id = ${userId} and s.title_id = t.id
      )
      order by t.score asc
      limit ${faltam}
      returning title_id`;
    return rows.map((r) => r.title_id);
  });
}

/** Conexão própria: db/client.ts é singleton e o cmdApi já deu pg.end() nele. */
async function comBanco(fn) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env["DATABASE_URL"]);
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Devolve ao banco o que o run pegou emprestado.
 *
 * A sessão porque vale 30 dias, e os swipes porque saem do feed enquanto
 * existem — com execuções repetidas o deck de quem está com o app aberto ia
 * encolhendo sem ninguém ter swipado.
 */
async function devolver(sessao, emprestados) {
  if (!sessao && emprestados.length === 0) return;
  await comBanco(async (sql) => {
    if (sessao) await sql`delete from sessions where id = ${sessao}`;
    if (emprestados.length > 0) {
      await sql`
        delete from swipes
        where user_id = ${process.env["DEV_USER_ID"]}
          and title_id in ${sql(emprestados)}`;
    }
  });
}

/**
 * Print de uma tela qualquer, sem asserção nenhuma sobre o conteúdo.
 *
 * O `cmdWeb` não serve: ele afirma coisas sobre `.deck-card` antes de disparar
 * a foto, então apontá-lo para outra rota quebra na primeira consulta.
 */
async function cmdShot() {
  const url = arg("--url", WEB);
  const selector = arg("--wait", "body");
  const out = arg("--out", join(SHOTS, "shot.png"));
  const started = [];
  const log = [];
  let sessao = null;
  let emprestados = [];

  const up = async (u) => {
    try {
      await fetch(u, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
    }
  };

  try {
    if (!(await up(`${API}/health`))) {
      console.log("subindo a api…");
      started.push(spawnGroup("dev:api", log));
      await waitForHttp(`${API}/health`);
    }
    if (!(await up(WEB))) {
      console.log("subindo o vite…");
      started.push(spawnGroup("dev:web", log));
      await waitForHttp(WEB);
    }

    const page = await openChrome();
    try {
      await page.cmd("Network.enable");
      if (process.argv.includes("--sessao")) {
        sessao = await abrirSessao(page);
        // Mesmo portão do cmdWeb: sem os 20 swipes o Home monta a tela de
        // gêneros, e um `--wait .deck-card` espera para sempre.
        emprestados = await cumprirOnboarding();
      }
      await page.cmd("Page.navigate", { url });
      await waitFor(page, selector);
      await screenshot(page, out);
      const real = page.errors.filter((e) => !/favicon/i.test(e));
      ok("console sem erro", real.length === 0, real.join(" | "));
    } finally {
      page.close();
    }
  } finally {
    await devolver(sessao, emprestados);
    for (const c of started) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
    if (process.exitCode) console.log(log.join(""));
  }
}

// ─── entrada ────────────────────────────────────────────────────────────────

const cmd = process.argv[2] ?? "all";

// Antes de qualquer import() de apps/api: db/client.ts lê DATABASE_URL no topo.
try {
  process.loadEnvFile(join(ROOT, "apps/api/.env"));
} catch {
  console.error("falta apps/api/.env — `cp apps/api/.env.example apps/api/.env`");
  process.exit(2);
}

if (cmd === "api") await cmdApi();
else if (cmd === "web") await cmdWeb();
else if (cmd === "shot") await cmdShot();
else if (cmd === "all") {
  console.log("── api ──");
  await cmdApi();
  console.log("── web ──");
  await cmdWeb();
} else {
  console.error(
    "uso: driver.mjs [api|web|shot|all] [--url U] [--wait SEL] [--out P] [--sessao]",
  );
  process.exit(2);
}
process.exit(process.exitCode ?? 0);
