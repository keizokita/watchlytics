/**
 * Encanamento da auditoria de a11y: Chrome por CDP, servidores e sessão.
 * Mesmo desenho do driver.mjs do run-watchlytics (que é do agente do β6 e não
 * pode ser tocado) — aqui só o que a auditoria precisa a mais: árvore de
 * acessibilidade, foco de verdade e leitura de pixel.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Portas próprias, e não as 3000/5173 do run-watchlytics: as duas ferramentas
 * precisam poder rodar ao mesmo tempo, e em máquina com mais de um worktree as
 * padrão costumam já estar ocupadas por outra sessão. Falar com a api errada
 * não dá erro — dá uma medição que descreve outra branch.
 */
export const API = `http://localhost:${process.env["A11Y_API_PORT"] ?? 3100}`;
export const WEB = `http://localhost:${process.env["A11Y_WEB_PORT"] ?? 5273}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✘"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
};

export async function waitForHttp(url, timeoutMs = 90_000) {
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

const up = async (u) => {
  try {
    await fetch(u, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
};

function spawnGroup(cmd, extraEnv, log, args = [], cwd = ROOT) {
  const [bin, ...pre] = cmd;
  const child = spawn(bin, [...pre, ...args], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  return child;
}

/** Sobe api:3100 e vite:5273 se faltarem. Portas próprias: 3000/5173 são de outra sessão. */
export async function servers(log = []) {
  const started = [];
  if (!(await up(`${API}/health`))) {
    started.push(
      spawnGroup(["npm", "run", "dev:api"], { PORT: new URL(API).port }, log),
    );
    await waitForHttp(`${API}/health`);
  }
  if (!(await up(WEB))) {
    // vite direto, não `npm run`: o npm come `--port` antes de chegar no vite.
    started.push(
      spawnGroup(
        [join(ROOT, "node_modules/.bin/vite"), "--port", new URL(WEB).port, "--strictPort"],
        { API_ORIGIN: API },
        log,
        [],
        join(ROOT, "apps/web"),
      ),
    );
    await waitForHttp(WEB);
  }
  return {
    stop() {
      for (const c of started) {
        try {
          process.kill(-c.pid, "SIGTERM");
        } catch {}
      }
    },
    log,
  };
}

export async function openChrome({ viewport = "430x932", scale = 1, reduce = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "wl-a11y-chrome-"));
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
    if (
      msg.method === "Runtime.consoleAPICalled" &&
      (msg.params.type === "error" || msg.params.type === "warning")
    ) {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
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
  await page.cmd("DOM.enable");
  await page.cmd("Accessibility.enable");
  await page.cmd("Network.enable");
  // Emulação, não flag de linha de comando: `--force-prefers-reduced-motion=0`
  // não desliga nada, e a medição dos dois modos saía igual.
  await page.cmd("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" },
    ],
  });
  const [w, h] = viewport.split("x").map(Number);
  await page.cmd("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: scale,
    mobile: w < 700,
  });
  return page;
}

export const evaluate = async (page, expression) =>
  (
    await page.cmd("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result.value;

export async function waitFor(page, selector, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(page, `!!document.querySelector(${JSON.stringify(selector)})`)) return;
    await sleep(200);
  }
  const body = await evaluate(page, "document.body.innerText.slice(0,400)");
  throw new Error(`"${selector}" não apareceu em ${timeoutMs}ms. body: ${body}`);
}

export async function until(fn, done, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (done(last)) return last;
    await sleep(100);
  }
  throw new Error(`${what} não aconteceu em ${timeoutMs}ms (último: ${JSON.stringify(last)})`);
}

/** Teclado de verdade: só ele liga :focus-visible e os atalhos do window. */
export async function pressKey(page, key, code, modifiers = 0) {
  // `text` é o que faz o Chrome gerar o keypress — e é o keypress que vira
  // clique em <button>. Sem ele, Enter e dígito chegam ao DOM sem ativar nada,
  // e a auditoria reprovaria um botão que funciona.
  const text = key === "Enter" ? "\r" : key.length === 1 ? key : undefined;
  for (const type of ["keyDown", "keyUp"]) {
    await page.cmd("Input.dispatchKeyEvent", {
      type,
      key,
      code: key,
      modifiers,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      ...(text && type === "keyDown" ? { text, unmodifiedText: text } : {}),
    });
  }
  await sleep(60);
}

export const tab = (page, shift = false) => pressKey(page, "Tab", 9, shift ? 8 : 0);
export const enter = (page) => pressKey(page, "Enter", 13);
export const space = (page) => pressKey(page, " ", 32);

// ─── banco e sessão ─────────────────────────────────────────────────────────

export async function comBanco(fn) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env["DATABASE_URL"]);
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Usuário descartável com sessão plantada. `birthYear` null deixa a porta de
 * idade fechada — é assim que se audita a própria porta.
 */
export async function abrirSessao(page, { birthYear = 1990, onboarded = true } = {}) {
  const { newRefreshToken, REFRESH_TTL_S } = await import(join(ROOT, "apps/api/src/auth.ts"));
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const { token, hash } = newRefreshToken(sessionId);

  await comBanco(async (sql) => {
    await sql`
      insert into users (id, handle, display_name, birth_year)
      values (${userId}, ${`a11y-${userId.slice(0, 8)}`}, 'Auditoria', ${birthYear})`;
    await sql`
      insert into sessions (id, user_id, refresh_token_hash, expires_at, user_agent)
      values (${sessionId}, ${userId}, ${hash},
              ${new Date(Date.now() + REFRESH_TTL_S * 1000)}, 'a11y.mjs')`;
    if (onboarded) {
      const { ONBOARDING_SWIPES } = await import("@watchlytics/contract");
      await sql`
        insert into swipes (user_id, title_id, direction)
        select ${userId}, t.id, 1 from titles t order by t.score asc limit ${ONBOARDING_SWIPES}`;
    }
  });

  await page.cmd("Network.setCookie", {
    name: "wl_refresh",
    value: token,
    domain: "localhost",
    path: "/v1/auth",
    httpOnly: true,
  });
  return userId;
}

export async function devolver(userId) {
  if (!userId) return;
  await comBanco((sql) => sql`delete from users where id = ${userId}`);
}

// ─── pixel: contraste medido, não estimado ──────────────────────────────────

/** PNG 8 bits (tipo 2 ou 6) → {w,h,px:Uint8Array RGBA}. Sem dependência. */
export function decodePng(buf) {
  let pos = 8;
  let w = 0,
    h = 0,
    colorType = 0,
    bitDepth = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`png inesperado: depth ${bitDepth} tipo ${colorType}`);
  }
  const ch = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * 4);
  const line = new Uint8Array(w * ch);
  const prev = new Uint8Array(w * ch);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[o++];
    for (let i = 0; i < w * ch; i++) {
      const x = raw[o + i];
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[i] = v & 0xff;
    }
    o += w * ch;
    for (let x = 0; x < w; x++) {
      px[(y * w + x) * 4] = line[x * ch];
      px[(y * w + x) * 4 + 1] = line[x * ch + 1];
      px[(y * w + x) * 4 + 2] = line[x * ch + 2];
      px[(y * w + x) * 4 + 3] = ch === 4 ? line[x * ch + 3] : 255;
    }
    prev.set(line);
  }
  return { w, h, px };
}

const chan = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = (r, g, b) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
export const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

export function parseColor(css) {
  const m = css.match(/-?[\d.]+/g).map(Number);
  return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 };
}

/** Recorte da tela, já decodificado. `clip` em px de CSS. */
export async function shot(page, clip) {
  const { data } = await page.cmd("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: false,
  });
  return decodePng(Buffer.from(data, "base64"));
}

// ─── árvore de acessibilidade ───────────────────────────────────────────────

/** O que um leitor de tela vê em um nó: papel, nome e o que está anunciado. */
export async function axOf(page, selector) {
  const { root } = await page.cmd("DOM.getDocument", { depth: 1 });
  const { nodeId } = await page.cmd("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { nodes } = await page.cmd("Accessibility.getPartialAXTree", {
    nodeId,
    fetchRelatives: false,
  });
  return nodes.map((n) => ({
    role: n.role?.value,
    name: n.name?.value ?? "",
    ignored: n.ignored === true,
    props: (n.properties ?? [])
      .filter((p) => p.value?.value !== false && p.value?.value !== "")
      .map((p) => `${p.name}=${p.value.value}`)
      .join(" "),
  }));
}

/** Árvore inteira, achatada e sem o ruído de nó ignorado. */
export async function axTree(page) {
  const { nodes } = await page.cmd("Accessibility.getFullAXTree", {});
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const depth = (n) => {
    let d = 0;
    let p = byId.get(n.parentId);
    while (p) {
      d++;
      p = byId.get(p.parentId);
    }
    return d;
  };
  return nodes
    .filter((n) => !n.ignored && n.role?.value !== "none" && n.role?.value !== "generic")
    .map((n) => ({
      d: depth(n),
      role: n.role?.value,
      name: (n.name?.value ?? "").replace(/\s+/g, " ").slice(0, 70),
      props: (n.properties ?? [])
        .filter((p) => !["focusable", "editable", "settable"].includes(p.name))
        .filter((p) => p.value?.value !== false && p.value?.value !== "")
        .map((p) => `${p.name}=${p.value.value}`)
        .join(" "),
    }));
}

export const printAx = (linhas) => {
  for (const n of linhas) {
    console.log(`${"  ".repeat(n.d)}${n.role}${n.name ? ` "${n.name}"` : ""}${n.props ? `  {${n.props}}` : ""}`);
  }
};

/** Retrato do elemento com foco: alvo, foco visível e posição. */
export const DESCREVE = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: "BODY" };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const ax = el.getAttribute('aria-label') || (el.innerText || el.value || '').trim();
  return {
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 28),
    text: ax.replace(/\\s+/g, ' ').slice(0, 44),
    role: el.getAttribute('role') || '',
    w: Math.round(r.width), h: Math.round(r.height),
    x: Math.round(r.x), y: Math.round(r.y),
    fv: el.matches(':focus-visible'),
    outline: cs.outlineStyle === 'none' ? 'none' : cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
    inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
    ti: el.getAttribute('tabindex') ?? '',
  };
})()`;
