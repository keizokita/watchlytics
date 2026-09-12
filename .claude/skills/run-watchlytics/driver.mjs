#!/usr/bin/env node
/**
 * Driver do run-watchlytics: como um agente dirige este app sem uma janela.
 *
 * Três camadas, porque é nelas que os PRs mexem:
 *   api    — sobe o Fastify em processo e bate nas rotas com app.inject(),
 *            sem porta e sem servidor de verdade. Segundos, não minutos.
 *   web    — sobe api + vite, dirige um Chrome headless por CDP e tira print.
 *   social — duas contas ao mesmo tempo, em contextos de navegação separados:
 *            é o β6, o único caminho para provar amizade, match e notificação,
 *            que não existem com uma identidade só.
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
 * Era o shim de autenticação trocado no meio do processo; o β3 apagou o shim, e
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
async function openBrowser() {
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
  /**
   * Um balde de erros e de requisições POR ABA, chaveado pelo sessionId.
   *
   * Era um array só, e bastava enquanto o driver tinha uma aba. O `social`
   * dirige duas ao mesmo tempo: com um array compartilhado, o console de uma
   * conta cairia na asserção da outra. O modo flatten põe o `sessionId` em
   * todo evento, que é a chave.
   */
  const abas = new Map();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }
    const aba = abas.get(msg.sessionId);
    if (!aba) return;

    if (msg.method === "Network.requestWillBeSent") {
      aba.requests.push(msg.params.request.url);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      aba.errors.push(msg.params.exceptionDetails.exception?.description ?? "exception");
    }
    // `warning` junto de `error`: a falha de flush da fila de swipes é um
    // console.warn (swipeQueue.ts:104), e só com `error` ela saía verde aqui
    // enquanto a asserção seguinte reprovava sem dizer a causa.
    if (
      msg.method === "Runtime.consoleAPICalled" &&
      (msg.params.type === "error" || msg.params.type === "warning")
    ) {
      aba.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      // A url vem fora do text; sem ela, "Failed to load resource" não diz o quê.
      aba.errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.trim());
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const fechar = () => {
    ws.close();
    chrome.kill();
  };

  /**
   * Uma aba, com `errors` e `requests` próprios.
   *
   * As URLs pedidas vêm do CDP e NÃO de `performance.getEntriesByType`: aquela
   * lista é do DOCUMENTO, e o vite força um page reload na primeira execução
   * depois de um arquivo mudar — a timeline zerava no meio da medição e
   * reprovava código bom, com um zero redondo. Aqui os eventos vão se somando e
   * o reload não apaga nada. Exige `Network.enable` antes do navigate.
   *
   * `isolada` abre um CONTEXTO de navegação próprio: cookie, localStorage e
   * sessionStorage separados. É o que permite duas contas vivas no mesmo
   * Chrome — duas abas comuns dividiriam o cookie de refresh, e a segunda
   * sessão sobrescreveria a primeira.
   */
  async function novaAba({ isolada = false } = {}) {
    const browserContextId = isolada
      ? (await send("Target.createBrowserContext")).browserContextId
      : undefined;
    const { targetId } = await send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    // flatten: as respostas da aba voltam pela MESMA conexão, com sessionId.
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

    const balde = { errors: [], requests: [] };
    abas.set(sessionId, balde);

    const page = {
      errors: balde.errors,
      requests: balde.requests,
      cmd: (method, params) => send(method, params, sessionId),
      close: () => send("Target.closeTarget", { targetId }),
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

  return { novaAba, close: fechar };
}

/** Uma aba só — o caso de `api`, `web` e `shot`. Fechá-la fecha o navegador. */
async function openChrome() {
  const browser = await openBrowser();
  const page = await browser.novaAba();
  page.close = browser.close;
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

/**
 * Sobe o que ainda não estiver de pé, e só isso: rodar com a api já aberta num
 * terminal é o caso normal de quem está mexendo no app. O que este comando
 * subiu vai para `started`, que é quem o `finally` derruba.
 */
async function garantirServidores(url, started, log) {
  const up = async (u) => {
    try {
      await fetch(u, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
    }
  };

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

  // Quem atende pode não ser este app. O `up()` acima só prova que ALGUÉM
  // respondeu, e nesta máquina há mais de um worktree: o vite de outra sessão
  // na mesma porta faz o driver dirigir o app do vizinho, contra o banco dele,
  // e reprovar com "o seletor não apareceu" — que é verdade e não ajuda.
  //
  // Sem `--port` no spawn de propósito: `npm run dev:web -- --port 5174` não
  // chega no vite (o npm come a flag e passa "5174" como RAIZ do servidor, que
  // responde 404 em tudo). Quem precisa de outra porta sobe o vite na mão e
  // passa `--url` — este comando reusa o que já estiver de pé.
  const html = await (await fetch(url)).text();
  if (!html.includes('id="root"')) {
    throw new Error(
      `${url} responde, mas não é o app deste worktree. Outra sessão está na ` +
        "porta: suba o vite noutra (`npx vite --port 5174` em apps/web) e rode " +
        "com `--url http://localhost:5174`, ou espere ela terminar.",
    );
  }
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

  try {
    await garantirServidores(url, started, log);

    const page = await openChrome();
    try {
      // Sem isto o shell pinta a tela de entrada e o deck nunca monta: desde o
      // C2/C3 o Root só monta o app com sessão, e o shim de autenticação não
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
 * O shim de autenticação não resolvia o portão de entrada: o shell decide o que
 * montar pelo `resume()` do Login.tsx, que chama `POST /v1/auth/refresh` — rota
 * que lê o cookie httpOnly e não passa pelo shim.
 *
 * E o usuário é DESCARTÁVEL, criado a cada run, porque o run precisa ESCREVER: os
 * 20 swipes que abrem o onboarding, mais os do próprio teste. Escrevendo no
 * usuário compartilhado, um Ctrl-C no meio deixava 20 LIKEs para sempre — e o
 * feed exclui LIKE incondicionalmente, então aqueles títulos sumiam do deck
 * local sem ninguém ter swipado. A execução seguinte também não consertava:
 * com 20 swipes já presentes ela não emprestava nada, e perdia junto a lista
 * do que limpar.
 *
 * Funciona porque a api resolve o usuário pelo Bearer da sessão, e não existe
 * mais atalho nenhum no ambiente. E a limpeza vira uma linha só —
 * `delete from users` cascateia sessão e swipes.
 */
async function abrirSessao(page) {
  const { newRefreshToken, REFRESH_TTL_S, signAccess } = await import(
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

  await mesmoBanco(userId, signAccess(userId));

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
 * A api que atende :3000 é a DESTE worktree?
 *
 * Custa uma requisição e evita a falha mais cara que este driver produz. O
 * `garantirServidores` reusa o que já estiver de pé — o caso normal de quem
 * está com a api aberta num terminal —, mas outro worktree na mesma máquina
 * também atende :3000, com OUTRO banco. Aí a sessão que acabou de ser plantada
 * não existe para quem responde, o `resume()` leva 401, e o sintoma é a tela de
 * entrada com um `.deck-card` que nunca aparece: 30s de timeout dizendo "o
 * seletor não apareceu", que é verdade e não ajuda em nada.
 *
 * O access token vai assinado em vez do refresh do cookie de propósito: usar o
 * refresh aqui o ROTACIONARIA, e o navegador ficaria com um token velho —
 * replay, na leitura correta do C3, e a sessão morreria por causa da sonda.
 */
async function mesmoBanco(userId, access) {
  const res = await fetch(`${API}/v1/auth/me`, {
    headers: { authorization: `Bearer ${access}` },
  });
  if (res.ok) return;
  throw new Error(
    `a api de ${API} não enxerga o banco deste worktree (${res.status} em /v1/auth/me ` +
      `para o usuário ${userId}). Outra sessão subiu a api na mesma porta? ` +
      "Derrube a dela (`fuser -k 3000/tcp`) ou espere ela terminar.",
  );
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

  try {
    await garantirServidores(WEB, started, log);

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

// ─── social: duas contas, duas sessões, o loop do β6 pela tela ──────────────

/**
 * β6 — amizade, match e notificação entre DUAS contas, dirigidos pela tela.
 *
 * Por que um comando novo e não mais asserções no `web`: o `web` prova o deck
 * de UMA conta, e nada do que é social existe com uma identidade só. Duas abas
 * comuns não serviriam — elas dividem o cookie de refresh, e a segunda sessão
 * sobrescreveria a primeira. Cada conta ganha um contexto de navegação próprio
 * (`novaAba({ isolada: true })`), que é o mesmo que dois navegadores.
 *
 * O que este comando NÃO prova é o β6.1: o `sub` do Google não se falsifica
 * daqui, então as contas nascem no banco como o OAuth as deixaria — sem
 * `birth_year`, que é o que faz a porta de idade (β2) ser cobrada pela tela em
 * vez de contornada por SQL.
 *
 * Print não vale como prova aqui. Toda asserção lê o ESTADO depois da ação: a
 * linha no Postgres, ou a lista que a outra conta passou a enxergar.
 */

/** Ano que passa na porta: qualquer um com MIN_AGE ou mais serve. */
const ANO_ADULTO = 1990;

/** Quantas vezes cada sessão rotaciona o refresh na prova do β6.2. */
const RECARGAS = 2;

/** Rótulos da tela que as asserções procuram (apps/web/src/strings.ts). */
const TELA = {
  amigos: "Your friends",
  pedidos: "Friend requests",
  enviados: "Sent",
  resultados: "Results",
  aceitar: "Accept",
  adicionar: "Add friend",
  abaPessoas: "People",
  abaComum: "In common",
  abaAvisos: "Alerts",
};

/** `evaluate` que devolve null em vez de explodir: durante um reload o contexto morre. */
const talvez = async (page, expr) => {
  try {
    return await evaluate(page, expr);
  } catch {
    return null;
  }
};

const corpo = (page) => talvez(page, "document.body.innerText");

/**
 * Clica pelo TEXTO, nunca por posição — é a convenção do resto do driver.
 *
 * Sem caixa porque `innerText` devolve o texto RENDERIZADO: `.lib h2` tem
 * `text-transform: uppercase` (screenCss.ts), então o "Results" do
 * strings.ts chega aqui como "RESULTS". Comparar cru daria um seletor que não
 * acha nada e uma espera de 10s dizendo que a busca não respondeu — quando ela
 * tinha respondido, e estava na tela.
 */
async function clicar(page, seletor, texto) {
  const achou = await evaluate(
    page,
    `(() => {
       const alvo = ${JSON.stringify(texto)}.trim().toLowerCase();
       const el = [...document.querySelectorAll(${JSON.stringify(seletor)})]
         .find((e) => e.innerText.trim().toLowerCase() === alvo);
       if (!el) return false;
       el.click();
       return true;
     })()`,
  );
  if (!achou) throw new Error(`"${texto}" não está em ${seletor}`);
}

/**
 * Escreve num campo controlado pelo React.
 *
 * `Input.insertText` e não `el.value = …`: a atribuição direta não dispara o
 * `onChange`, então o estado do componente continua vazio e o botão de enviar
 * segue desabilitado — a tela ficaria certa e o app não teria recebido nada.
 */
async function digitar(page, seletor, valor) {
  await evaluate(page, `document.querySelector(${JSON.stringify(seletor)}).focus()`);
  await page.cmd("Input.insertText", { text: String(valor) });
}

/**
 * Recarrega e espera o documento NOVO.
 *
 * A marca existe porque `Page.reload` volta antes de a página trocar: o
 * `waitFor` acharia o seletor no DOM velho e a asserção passaria sobre a tela
 * anterior. A marca morre com o documento, então ela sumir é a prova de que o
 * React montou de novo — e, de quebra, de que o `resume()` do Login.tsx rodou e
 * rotacionou o refresh (C3).
 */
async function recarregar(page, seletor) {
  await evaluate(page, "window.__b6 = 1");
  await page.cmd("Page.reload");
  await until(
    () =>
      talvez(
        page,
        `!window.__b6 && !!document.querySelector(${JSON.stringify(seletor)})`,
      ),
    (v) => v === true,
    "o documento novo montar",
    30_000,
  );
}

/** O que a nav mostra: é ela que some com a porta de idade fechada. */
const LINK_AMIGOS = '.shell nav a[href="#/friends"]';

/** Handles de uma seção da tela de amigos, na ordem em que ela os mostra. */
const handlesDaSecao = (page, titulo) =>
  evaluate(
    page,
    `(() => {
       const alvo = ${JSON.stringify(titulo)}.trim().toLowerCase();
       const h = [...document.querySelectorAll('.lib h2')]
         .find((e) => e.innerText.trim().toLowerCase() === alvo);
       if (!h) return [];
       return [...h.parentElement.querySelectorAll('.lib-list .lib-meta')]
         .map((e) => e.innerText.trim());
     })()`,
  );

/** As três listas do critério do β6.3, como a TELA as mostra. */
async function tresListas(page) {
  return {
    amigos: await handlesDaSecao(page, TELA.amigos),
    entrando: await handlesDaSecao(page, TELA.pedidos),
    saindo: await handlesDaSecao(page, TELA.enviados),
  };
}

const soAmigo = (l, handle) =>
  l.amigos.join(",") === `@${handle}` && l.entrando.length === 0 && l.saindo.length === 0;

/** Texto de cada linha de lista — serve para avisos e para títulos em comum. */
const linhasDaLista = (page) =>
  evaluate(
    page,
    `[...document.querySelectorAll('.lib-list li')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim())`,
  );

const badge = (page) =>
  talvez(page, `document.querySelector('.nav-badge')?.innerText ?? null`);

/** Abre a tela de amigos na aba pedida, clicando — a aba vive no hash (E6). */
async function abaDeAmigos(page, nome) {
  await evaluate(page, `location.hash = "#/friends"`);
  await waitFor(page, ".lib-tabs");
  await clicar(page, ".lib-tabs button", nome);
  await sleep(100);
}

/** Conta como o OAuth a deixaria: sem ano de nascimento, com sessão de verdade. */
async function criarConta(sql, nome) {
  const { newRefreshToken, REFRESH_TTL_S } = await import(
    join(ROOT, "apps/api/src/auth.ts")
  );
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const handle = `${nome}-${userId.slice(0, 8)}`;
  const { token, hash } = newRefreshToken(sessionId);

  await sql`
    insert into users (id, handle, display_name)
    values (${userId}, ${handle}, ${nome})`;
  await sql`
    insert into sessions (id, user_id, refresh_token_hash, expires_at, user_agent)
    values (${sessionId}, ${userId}, ${hash},
            ${new Date(Date.now() + REFRESH_TTL_S * 1000)}, 'driver.mjs social')`;

  return { userId, sessionId, handle, nome, token };
}

/**
 * Deixa UM título no deck da conta, e o mesmo para as duas.
 *
 * O match precisa do MESMO título curtido pelos dois lados, e a ordem do feed
 * tem ruído por requisito (A4) — não dá para saber qual card estará no topo.
 * Em vez de swipar até achar, a conta nasce com o catálogo inteiro decidido
 * menos um: o card do topo passa a ser o mesmo dos dois lados, e o Like que
 * interessa é o único que sobra. De quebra isto cumpre o onboarding (D4), que
 * conta swipes.
 *
 * LIKE e não descarte: o feed exclui o curtido para sempre, enquanto o
 * descartado volta em 180 dias (A2). E como estes swipes NÃO passam pela rota,
 * eles não viram entrada de catálogo — a biblioteca de cada conta continua
 * sendo só o que a tela gravou, que é o que o match vai cruzar.
 */
const deckDeUmTitulo = (sql, userId, titleId) => sql`
  insert into swipes (user_id, title_id, direction)
  select ${userId}, t.id, 1 from titles t where t.id <> ${titleId}`;

/** Assistidos de fixture, para o piso do β6.5 ficar a UM clique de distância. */
const assistidosDeFixture = (sql, userId, exceto, quantos) => sql`
  insert into library_entries (user_id, title_id, status, watched_at)
  select ${userId}, t.id, 'watched', now() from titles t
  where t.id <> ${exceto} order by t.score desc limit ${quantos}`;

async function cmdSocial() {
  const url = arg("--url", WEB);
  const started = [];
  const log = [];
  const postgres = (await import("postgres")).default;
  const { STATS_MIN_WATCHED } = await import("@watchlytics/contract");
  // Conexão própria e uma só: db/client.ts é singleton e o `all` já pode ter
  // chamado pg.end() nele.
  const sql = postgres(process.env["DATABASE_URL"]);
  let contas = [];
  let browser = null;

  try {
    await garantirServidores(url, started, log);

    // O título vem do banco, nunca escrito à mão: `titles.id` é defaultRandom e
    // refazer o seed troca todos (SKILL.md).
    const [alvo] = await sql`select id, title from titles order by score desc limit 1`;

    const a = await criarConta(sql, "ana");
    const b = await criarConta(sql, "bruno");
    contas = [a.userId, b.userId];
    const sessoes = [a.sessionId, b.sessionId];
    const par = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];

    for (const c of [a, b]) await deckDeUmTitulo(sql, c.userId, alvo.id);
    await assistidosDeFixture(sql, a.userId, alvo.id, STATS_MIN_WATCHED - 1);

    browser = await openBrowser();
    const abrir = async (conta) => {
      const page = await browser.novaAba({ isolada: true });
      await page.cmd("Network.enable");
      await page.cmd("Network.setCookie", {
        name: "wl_refresh",
        value: conta.token,
        domain: "localhost",
        path: "/v1/auth",
        httpOnly: true,
      });
      return page;
    };
    const pa = await abrir(a);
    const pb = await abrir(b);

    // ── β2 · a porta de idade, nas duas contas ────────────────────────────
    for (const p of [pa, pb]) {
      await p.cmd("Page.navigate", { url });
      await waitFor(p, ".age-gate");
    }
    const semNav = await Promise.all(
      [pa, pb].map((p) => evaluate(p, "document.querySelectorAll('.shell nav a').length")),
    );
    ok(
      "β2 a porta de idade fecha as duas contas antes de qualquer tela",
      semNav.every((n) => n === 0),
      `links de nav: ${semNav.join(" e ")}`,
    );

    for (const p of [pa, pb]) {
      await digitar(p, ".age-gate input", ANO_ADULTO);
      await clicar(p, ".age-gate button", "Continue");
      await waitFor(p, LINK_AMIGOS);
    }
    const [{ comIdade }] = await sql`
      select count(*)::int as "comIdade" from users
      where id in ${sql(contas)} and birth_year is not null`;
    ok(
      "β2 as duas contas passam a porta pela tela, e só então o app monta",
      comIdade === 2,
      `${comIdade}/2 com ano gravado`,
    );

    // ── β6.2 · duas sessões vivas, cada uma rotacionando o próprio refresh ─
    const hashes = new Map(sessoes.map((id) => [id, new Set()]));
    const anotar = async () => {
      for (const r of await sql`
        select id, refresh_token_hash from sessions where id in ${sql(sessoes)}`) {
        hashes.get(r.id).add(r.refresh_token_hash);
      }
    };
    await anotar(); // a primeira carga já rotacionou uma vez de cada lado

    // Alternado de propósito: é isto que põe a rotação de uma sessão ENTRE
    // duas da outra, que é o padrão que um detector de replay ingênuo derruba.
    for (let i = 0; i < RECARGAS; i++) {
      for (const p of [pa, pb]) {
        await recarregar(p, LINK_AMIGOS);
        await anotar();
      }
    }

    const giros = sessoes.map((id) => hashes.get(id).size);
    ok(
      "β6.2 cada sessão rotacionou o próprio refresh, sem tocar na outra (C3)",
      giros.every((n) => n === RECARGAS + 1),
      `${giros.join(" e ")} hashes distintos, esperado ${RECARGAS + 1} de cada`,
    );

    const vivas = await sql`
      select id from sessions where id in ${sql(sessoes)} and revoked_at is null`;
    ok(
      "β6.2 nenhuma rotação foi lida como replay — as duas sessões seguem vivas",
      vivas.length === 2,
      `${vivas.length}/2 sem revoked_at`,
    );

    const shells = await Promise.all([corpo(pa), corpo(pb)]);
    ok(
      "β6.2 e as duas telas continuam autenticadas, cada uma na sua conta",
      shells[0].includes(`@${a.handle}`) && shells[1].includes(`@${b.handle}`),
      `@${a.handle} e @${b.handle}`,
    );

    // ── β6.4 (primeira metade) · o like vem ANTES do aceite ───────────────
    // É o que o E4 tem para cruzar depois: sem like anterior, o aceite não
    // teria nada retroativo a casar e a prova seria do E3, não do E4.
    for (const p of [pa, pb]) {
      await evaluate(p, `location.hash = ""`);
      await waitFor(p, ".deck-card");
      await clicar(p, ".actions button", "Like");
    }

    const curtiram = () => sql`
      select user_id from library_entries
      where title_id = ${alvo.id} and user_id in ${sql(contas)}`;
    let entradas = [];
    try {
      entradas = await until(
        curtiram,
        (r) => r.length === 2,
        "a fila dos dois navegadores dar flush do like",
        20_000,
      );
    } catch {
      entradas = await curtiram();
    }
    ok(
      "as duas contas curtiram o MESMO título pelo deck",
      entradas.length === 2,
      `${alvo.title} — ${entradas.length}/2 entradas de catálogo`,
    );

    const cedo = await sql`
      select 1 from matches where user_a = ${par[0]} and user_b = ${par[1]}`;
    ok(
      "sem amizade não há match, mesmo com o título curtido dos dois lados (E3)",
      cedo.length === 0,
      `${cedo.length} linhas em matches`,
    );

    // ── β6.3 · amizade ponta a ponta pela tela ────────────────────────────
    await abaDeAmigos(pa, TELA.abaPessoas);
    await digitar(pa, ".friend-search input", b.handle);
    await clicar(pa, ".friend-search button", "Search");
    const achados = await until(
      () => handlesDaSecao(pa, TELA.resultados),
      (r) => r.length > 0,
      "a busca por handle responder",
    );
    ok(
      "β6.3 a busca acha o outro pelo handle (E1)",
      achados.includes(`@${b.handle}`),
      achados.join(" ") || "nenhum resultado",
    );

    await clicar(pa, ".lib-list button", TELA.adicionar);
    const pedido = await until(
      () => sql`
        select user_a, user_b, requested_by, status from friendships
        where user_a = ${par[0]} and user_b = ${par[1]}`,
      (r) => r.length === 1,
      "o pedido de amizade chegar ao banco",
    );
    ok(
      "β6.3 o pedido grava o par normalizado e quem pediu (E2)",
      pedido[0].status === "pending" &&
        pedido[0].requested_by === a.userId &&
        pedido[0].user_a < pedido[0].user_b,
      `${pedido[0].status}, pedido por ${a.handle}`,
    );

    const enviados = await until(
      () => handlesDaSecao(pa, TELA.enviados),
      (l) => l.length > 0,
      "a lista de enviados do A recarregar",
    );
    await abaDeAmigos(pb, TELA.abaPessoas);
    const recebidos = await handlesDaSecao(pb, TELA.pedidos);
    ok(
      "β6.3 um lado vê o pedido em Sent e o outro em Friend requests",
      enviados.includes(`@${b.handle}`) && recebidos.includes(`@${a.handle}`),
      `${enviados.join(" ")} · ${recebidos.join(" ")}`,
    );

    await clicar(pb, ".lib-list button", TELA.aceitar);
    await until(
      () => handlesDaSecao(pb, TELA.amigos),
      (l) => l.includes(`@${a.handle}`),
      "o aceite recarregar as listas do B",
    );
    // O A não estava olhando: a tela dele só sabe do aceite quando recarrega,
    // que é exatamente o que a outra pessoa faz do outro lado do mundo.
    await recarregar(pa, ".lib-tabs");

    const listas = { a: await tresListas(pa), b: await tresListas(pb) };
    ok(
      "β6.3 as três listas ficam certas dos DOIS lados",
      soAmigo(listas.a, b.handle) && soAmigo(listas.b, a.handle),
      JSON.stringify(listas),
    );

    // ── β6.4 · match retroativo e notificação agregada ────────────────────
    const [casado] = await sql`
      select strength from matches
      where user_a = ${par[0]} and user_b = ${par[1]} and title_id = ${alvo.id}`;
    ok(
      "β6.4 o aceite cruza os catálogos e casa o título curtido antes (E4)",
      casado?.strength === 3,
      casado ? `força ${casado.strength}` : "nenhum match",
    );

    const avisos = await sql`
      select user_id, type, payload from notifications where user_id in ${sql(contas)}`;
    ok(
      "β6.4 uma notificação agregada por pessoa, não uma por título (E4)",
      avisos.length === 2 &&
        avisos.every((n) => n.type === "friend_matches" && n.payload.count === 1),
      `${avisos.length} avisos: ${avisos.map((n) => `${n.type}/${n.payload.count}`).join(" ")}`,
    );

    ok(
      "β6.4 o badge aparece para quem não estava olhando (E6)",
      (await badge(pa)) === "1",
      `badge do A: ${(await badge(pa)) ?? "ausente"}`,
    );

    await clicar(pa, ".lib-tabs button", TELA.abaAvisos);
    const lidos = await until(
      () => linhasDaLista(pa),
      (l) => l.length > 0,
      "a aba de avisos carregar",
    );
    ok(
      "β6.4 o aviso chega escrito na tela, com handle e contagem",
      lidos.some((l) => l.includes(`@${b.handle}`) && l.includes("1 title")),
      lidos[0] ?? "lista vazia",
    );
    ok(
      "β6.4 o badge zera ao abrir a aba (E6)",
      (await until(() => badge(pa), (v) => v === null, "o badge cair")) === null,
    );

    for (const [p, eu, outro] of [
      [pa, a, b],
      [pb, b, a],
    ]) {
      await clicar(p, ".lib-tabs button", TELA.abaComum);
      const comuns = await until(
        () => linhasDaLista(p),
        (l) => l.length > 0,
        `a aba de títulos em comum do ${eu.nome} carregar`,
      );
      ok(
        `β6.4 ${eu.nome} vê o título em comum com @${outro.handle} (E5)`,
        comuns.some((l) => l.includes(alvo.title) && l.includes(`@${outro.handle}`)),
        comuns[0] ?? "lista vazia",
      );
    }

    // O console é conferido AQUI, e não no fim: o β6.5 sai do app de propósito
    // para ler um perfil privado, e o 404 dele é a resposta certa — contá-lo
    // como erro de console faria a asserção reprovar justamente o acerto.
    for (const [p, c] of [
      [pa, a],
      [pb, b],
    ]) {
      const reais = p.errors.filter((e) => !/favicon/i.test(e));
      ok(`console sem erro na sessão de ${c.nome}`, reais.length === 0, reais.join(" | "));
    }

    // ── β6.5 · perfil público do outro, com o piso de assistidos ──────────
    const perfilDoA = async (marca) => {
      // Query só para o navegador não reaproveitar o documento anterior.
      await pb.cmd("Page.navigate", { url: `${url}/u/${a.handle}?v=${marca}` });
      await waitFor(pb, "body");
      return (await corpo(pb)) ?? "";
    };

    ok(
      "β6.5 perfil privado não existe nem para o amigo (D5)",
      (await perfilDoA(0)).includes("No public profile"),
      "404 antes do clique em Public profile",
    );

    await evaluate(pa, `location.hash = "#/library"`);
    await waitFor(pa, ".lib-public input");
    await evaluate(pa, `document.querySelector('.lib-public input').click()`);
    await until(
      () => sql`select is_public from users where id = ${a.userId}`,
      (r) => r[0]?.is_public === true,
      "o perfil do A virar público",
    );

    const fechado = await perfilDoA(1);
    ok(
      `β6.5 abaixo de ${STATS_MIN_WATCHED} assistidos o agregado nem é calculado (D3)`,
      fechado.includes(`${STATS_MIN_WATCHED - 1} titles watched`) &&
        fechado.includes(`stats unlock at ${STATS_MIN_WATCHED}`),
      fechado.split("\n").filter(Boolean).slice(-2).join(" · "),
    );

    // O décimo assistido é marcado na TELA — é ele que cruza o piso.
    //
    // Sem clicar em "Interested": é a aba inicial do Library.tsx, e clicar na
    // aba JÁ selecionada deixa a tela em "Loading…" para sempre — o clique faz
    // `setReady(false)` mas o `tab` não muda, então o efeito que recarrega não
    // reentra. É defeito do app, não do driver, e está no relatório do β6.
    await until(
      () => talvez(pa, `document.querySelectorAll('.lib-list .lib-move').length`),
      (n) => n > 0,
      "o título curtido aparecer em Interested",
    );
    await evaluate(
      pa,
      `(() => {
         const li = [...document.querySelectorAll('.lib-list li')]
           .find((l) => l.querySelector('strong')?.innerText.trim() === ${JSON.stringify(alvo.title)});
         li.querySelector('.lib-move').click();
       })()`,
    );
    const assistidos = await until(
      () => sql`
        select count(*)::int as n from library_entries
        where user_id = ${a.userId} and status = 'watched'`,
      (r) => r[0].n >= STATS_MIN_WATCHED,
      "o décimo assistido ser gravado",
    );

    const aberto = await perfilDoA(2);
    ok(
      "β6.5 o décimo assistido, marcado na tela, abre o agregado do perfil",
      aberto.includes(`${STATS_MIN_WATCHED} titles watched`) &&
        !aberto.includes("stats unlock"),
      `${assistidos[0].n} assistidos · ${aberto.split("\n").filter(Boolean).at(-2) ?? ""}`,
    );
  } finally {
    // A cascata leva sessão, swipes, catálogo, amizade, match e notificação.
    if (contas.length) await sql`delete from users where id in ${sql(contas)}`;
    await sql.end();
    browser?.close();
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
else if (cmd === "social") await cmdSocial();
else if (cmd === "all") {
  console.log("── api ──");
  await cmdApi();
  console.log("── web ──");
  await cmdWeb();
} else {
  console.error(
    "uso: driver.mjs [api|web|shot|social|all] [--url U] [--wait SEL] [--out P] [--sessao]",
  );
  process.exit(2);
}
process.exit(process.exitCode ?? 0);
