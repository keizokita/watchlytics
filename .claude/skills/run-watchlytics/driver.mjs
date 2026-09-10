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
 * Roda contra um usuário novo a cada execução, com Bearer de verdade.
 *
 * Era o shim do DEV_USER_ID trocado no meio do processo; o β3 apagou o shim, e
 * agora o driver assina um access token para o usuário descartável — o mesmo
 * caminho que a produção usa. Descartável importa porque os swipes do driver
 * não podem sujar o feed de quem estiver com o app aberto, e o DELETE do
 * usuário no fim leva os swipes junto por ON DELETE CASCADE.
 */
async function cmdApi() {
  // import() e não import estático: db/client.ts lê DATABASE_URL no topo do
  // módulo, logo o .env precisa já estar carregado quando ele for avaliado.
  const { db, pg } = await import(join(ROOT, "apps/api/src/db/client.ts"));
  const { users, swipes } = await import(join(ROOT, "apps/api/src/db/schema.ts"));
  const { buildServer } = await import(join(ROOT, "apps/api/src/server.ts"));
  const { signAccess } = await import(join(ROOT, "apps/api/src/auth.ts"));
  const { eq } = await import("drizzle-orm");

  const userId = crypto.randomUUID();
  const handle = `driver-${userId.slice(0, 8)}`;
  await db.insert(users).values({ id: userId, handle, displayName: "Driver" });

  const app = buildServer();
  const headers = { authorization: `Bearer ${signAccess(userId)}` };
  const get = (url) => app.inject({ method: "GET", url, headers });
  const post = (payload) =>
    app.inject({ method: "POST", url: "/v1/swipes", payload, headers });

  try {
    const health = await get("/health");
    ok("GET /health", health.json().ok === true);

    // β2 — o usuário nasce sem ano e por isso nasce sem app. A porta é a única
    // coisa que responde antes dela ser respondida.
    const fechada = await get("/v1/feed");
    ok("sem ano de nascimento o feed é 403 (β2)", fechada.statusCode === 403);

    const porta = await app.inject({
      method: "POST",
      url: "/v1/auth/age",
      headers,
      payload: { birthYear: new Date().getFullYear() - 30 },
    });
    ok("a porta de idade abre com maior de idade", porta.json().ok === true);

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

    const anon = await app.inject({ method: "GET", url: "/v1/feed" });
    ok("sem Authorization a rota responde 401", anon.statusCode === 401);
  } finally {
    await db.delete(swipes).where(eq(swipes.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await app.close();
    await pg.end();
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
  /**
   * URLs pedidas, acumuladas pelo CDP.
   *
   * Não dá para usar `performance.getEntriesByType("resource")`: aquela lista é
   * do DOCUMENTO, e o vite força um page reload na primeira execução depois de
   * um arquivo mudar — o que zerava a timeline no meio da medição e reprovava
   * código bom, com um zero redondo. Aqui os eventos vão se somando e o reload
   * não apaga nada. Exige `Network.enable` antes do navigate.
   */
  const requests = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      requests.push(msg.params.request.url);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params.exceptionDetails.exception?.description ?? "exception");
    }
    // `warning` junto de `error`: a falha de flush da fila de swipes é um
    // console.warn (swipeQueue.ts:104), e só com `error` ela saía verde aqui
    // enquanto a asserção seguinte reprovava sem dizer a causa.
    if (
      msg.method === "Runtime.consoleAPICalled" &&
      (msg.params.type === "error" || msg.params.type === "warning")
    ) {
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
    requests,
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
 * Confere que o swipe do navegador chegou no banco.
 *
 * Espera em vez de checar na hora: swipeQueue.ts (B6) põe o swipe em
 * localStorage e só faz POST 3s depois (FLUSH_MS) ou aos 5 pendentes. Checar
 * logo após o clique dá zero linha.
 *
 * Conta TUDO do usuário do run, não uma janela de tempo: ele nasceu neste run,
 * então o que existe é o onboarding (`base`) mais o que o navegador gravou. Sem
 * relógio não há folga de um segundo para arbitrar, e sem janela não há como
 * apagar por engano o que outra pessoa swipou. Não apaga nada — quem limpa é o
 * `devolver`, que leva o usuário inteiro.
 */
async function checkSwipesGravados(userId, base, esperados) {
  // Conexão própria, NÃO a de db/client.ts: aquele módulo é um singleton e o
  // cmdApi já chamou pg.end() nele. Em `all`, reusar dá CONNECTION_ENDED. Uma
  // só para o polling inteiro — abrir por tentativa seriam ~150 conexões.
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env["DATABASE_URL"]);
  const todos = () => sql`select direction from swipes where user_id = ${userId}`;
  try {
    let rows = [];
    try {
      rows = await until(
        todos,
        (r) => r.length >= base + esperados,
        `a fila do navegador dar flush de ${esperados} swipes`,
        15_000,
      );
    } catch {
      rows = await todos();
    }
    const doNavegador = rows.length - base;
    ok(
      `o navegador gravou ${esperados} swipes`,
      doNavegador === esperados,
      doNavegador > 0
        ? `${doNavegador} além dos ${base} do onboarding`
        : "nenhum — a fila deu flush?",
    );
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
  /** Usuário descartável do run; `devolver` o apaga com tudo que ele criou. */
  let usuario = null;
  /** Quantos swipes o onboarding custou — a linha de base da checagem final. */
  let base = 0;

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
      usuario = await abrirSessao(page);
      base = await cumprirOnboarding(usuario);

      await page.cmd("Page.navigate", { url });
      await waitFor(page, selector);

      const deck = await evaluate(
        page,
        `(() => { const top = document.querySelector('.deck .deck-card:last-child');
          return { cards: document.querySelectorAll('.deck-card').length,
                   botoes: [...document.querySelectorAll('.actions button')].map(b => b.innerText),
                   fundo: getComputedStyle(top).backgroundImage,
                   elenco: top.querySelector('.card-cast')?.innerText ?? "" }; })()`,
      );
      const first = await topTitle(page);
      ok("deck renderizou", Boolean(first), first);
      ok("3 cards no DOM (profundidade)", deck?.cards === 3, String(deck?.cards));
      // I1.2: até 3 nomes, e a linha só existe quando há elenco. A asserção é
      // sobre o CAMINHO INTEIRO — coluna cast_names, contrato, toTitle, card —,
      // que é o que nenhum teste de unidade alcança: `Card.tsx` é JSX e o
      // `node --test` não sabe apagá-lo.
      //
      // Só o topo do feed, e de propósito: a I1.1 busca por score decrescente,
      // então o que está no topo é justamente o que já foi buscado. Um card sem
      // elenco lá em cima significa regressão, não catálogo incompleto.
      const nomes = deck?.elenco ? deck.elenco.split(" · ") : [];
      ok(
        "elenco no card, até 3 nomes (I1.2)",
        nomes.length > 0 && nomes.length <= 3,
        deck?.elenco || "linha ausente — o card de topo devia ter elenco",
      );
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
      //
      // A contagem sai do `page.requests` do CDP, e NÃO de
      // `performance.getEntriesByType("resource")`: aquela lista pertence ao
      // documento, e o vite força um page reload na primeira execução depois
      // de um arquivo mudar — a timeline zerava no meio da medição e a
      // asserção reprovava código bom, com um zero redondo. Ver o comentário
      // do `requests` no openChrome.
      // Espera porque o pedido não é síncrono com a montagem do card: os três
      // do DOM saem pelo CSS e os outros pelo efeito de pré-carga, um tick
      // depois. Três é o piso — passar disso só acontece se a pré-carga rodou.
      const conta = () =>
        page.requests.filter((u) => u.startsWith("https://image.tmdb.org/")).length;
      let pedidos = 0;
      try {
        pedidos = await until(
          conta,
          (n) => n > VISIVEIS_NO_DOM,
          "a pré-carga pedir além dos cards que estão no DOM",
          15_000,
        );
      } catch {
        pedidos = conta();
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

      await checkSwipesGravados(usuario, base, 2);
    } finally {
      page.close();
    }
  } finally {
    await devolver(usuario);
    for (const c of started) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
    if (process.exitCode) console.log(log.join(""));
  }
}

/**
 * Usuário descartável com sessão, para o headless entrar no app.
 *
 * O shim do DEV_USER_ID não resolve o portão de entrada: o shell decide o que
 * montar pelo `resume()` do Login.tsx, que chama `POST /v1/auth/refresh` — rota
 * que lê o cookie httpOnly e não passa pelo shim.
 *
 * E o usuário é DESCARTÁVEL, não o do .env, porque o run precisa ESCREVER: os
 * 20 swipes que abrem o onboarding, mais os do próprio teste. Escrevendo no
 * usuário compartilhado, um Ctrl-C no meio deixava 20 LIKEs para sempre — e o
 * feed exclui LIKE incondicionalmente, então aqueles títulos sumiam do deck
 * local sem ninguém ter swipado. A execução seguinte também não consertava:
 * com 20 swipes já presentes ela não emprestava nada, e perdia junto a lista
 * do que limpar.
 *
 * Funciona porque a api resolve o usuário pelo Bearer da sessão, não pelo shim:
 * o DEV_USER_ID do processo da api nunca entra nesta conta. E a limpeza vira
 * uma linha só — `delete from users` cascateia sessão e swipes.
 */
async function abrirSessao(page) {
  const { newRefreshToken, REFRESH_TTL_S } = await import(
    join(ROOT, "apps/api/src/auth.ts")
  );
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const { token, hash } = newRefreshToken(sessionId);

  await comBanco(async (sql) => {
    // β2 — nasce com a porta de idade já respondida. A TELA que pergunta o ano
    // é da trilha α e ainda não existe; enquanto não existir, o headless não
    // teria como responder e pararia no 403 antes de ver o deck.
    await sql`
      insert into users (id, handle, display_name, birth_year)
      values (${userId}, ${`driver-${userId.slice(0, 8)}`}, 'Driver', 1990)`;
    await sql`
      insert into sessions (id, user_id, refresh_token_hash, expires_at, user_agent)
      values (${sessionId}, ${userId}, ${hash},
              ${new Date(Date.now() + REFRESH_TTL_S * 1000)}, 'driver.mjs')`;
  });

  // Path=/v1/auth é o mesmo do routes/auth.ts: o cookie não vai em mais nada.
  await page.cmd("Network.setCookie", {
    name: "wl_refresh",
    value: token,
    domain: "localhost",
    path: "/v1/auth",
    httpOnly: true,
  });
  return userId;
}


/**
 * Passa o usuário do run pelo portão do onboarding (D4).
 *
 * `remaining = ONBOARDING_SWIPES - swipes do usuário` (routes/onboarding.ts:97),
 * e enquanto sobra o Home monta a tela de gêneros, não o deck.
 *
 * Pelos títulos MENOS populares de propósito: LIKE sai do feed, e gastar o topo
 * do catálogo mudaria justamente o card que as asserções vão olhar.
 */
async function cumprirOnboarding(userId) {
  const { ONBOARDING_SWIPES } = await import("@watchlytics/contract");
  await comBanco(
    (sql) => sql`
      insert into swipes (user_id, title_id, direction)
      select ${userId}, t.id, 1 from titles t
      order by t.score asc
      limit ${ONBOARDING_SWIPES}`,
  );
  return ONBOARDING_SWIPES;
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
 * Some com o usuário do run. Sessão e swipes vão junto por ON DELETE CASCADE,
 * então não há lista para manter nem janela de tempo para acertar.
 */
async function devolver(userId) {
  if (!userId) return;
  await comBanco((sql) => sql`delete from users where id = ${userId}`);
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
  let usuario = null;

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
        usuario = await abrirSessao(page);
        // Mesmo portão do cmdWeb: sem os 20 swipes o Home monta a tela de
        // gêneros, e um `--wait .deck-card` espera para sempre.
        await cumprirOnboarding(usuario);
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
    await devolver(usuario);
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
