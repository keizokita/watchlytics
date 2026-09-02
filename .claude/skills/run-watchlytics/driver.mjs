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

    const scores = items.map((i) => i.score);
    ok(
      "feed vem em score desc",
      String(scores) === String([...scores].sort((a, b) => b - a)),
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
  // Retrato: é um app de swipe, e o card é `aspect-ratio: 2/3`.
  await page.cmd("Emulation.setDeviceMetricsOverride", {
    width: 430,
    height: 932,
    deviceScaleFactor: 2,
    mobile: true,
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
async function checkSwipesGravados(desde, esperados) {
  const userId = process.env["DEV_USER_ID"];
  if (!userId) return ok("DEV_USER_ID definida para conferir os swipes", false);

  // Conexão própria, NÃO a de db/client.ts: aquele módulo é um singleton e o
  // cmdApi já chamou pg.end() nele. Em `all`, reusar dá CONNECTION_ENDED.
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env["DATABASE_URL"]);
  const janela = () => sql`
    select direction from swipes
    where user_id = ${userId} and updated_at >= ${desde}`;
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
      await page.cmd("Page.navigate", { url });
      await waitFor(page, selector);

      const deck = await evaluate(
        page,
        `(() => { const top = document.querySelector('.deck .deck-card:last-child');
          return { cards: document.querySelectorAll('.deck-card').length,
                   botoes: [...document.querySelectorAll('.actions button')].map(b => b.innerText),
                   fundo: getComputedStyle(top).backgroundImage.slice(0, 60) }; })()`,
      );
      const first = await topTitle(page);
      ok("deck renderizou", Boolean(first), first);
      ok("3 cards no DOM (profundidade)", deck?.cards === 3, String(deck?.cards));
      ok("pôster é o gradiente determinístico", Boolean(deck?.fundo.startsWith("linear-gradient")), deck?.fundo);
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

      await checkSwipesGravados(desde, 2);
    } finally {
      page.close();
    }
  } finally {
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
else if (cmd === "all") {
  console.log("── api ──");
  await cmdApi();
  console.log("── web ──");
  await cmdWeb();
} else {
  console.error("uso: driver.mjs [api|web|all] [--url U] [--wait SEL] [--out P]");
  process.exit(2);
}
process.exit(process.exitCode ?? 0);
