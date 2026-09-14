/**
 * A régua de encaixe: cada tela CABE no telefone, ou quanto falta para caber.
 *
 * A barra de rolagem vertical do app é de propósito (o index.html clipa só o
 * eixo X), porque em tela baixa os botões de Pass/Undo/Like saem do alcance e
 * eles são o caminho não-gestual que a acessibilidade exige. Então o alvo desta
 * medição não é "não rola": é QUANTO falta de altura para o conteúdo caber, e
 * quais controles ficam abaixo da dobra enquanto não cabe.
 *
 * uso:
 *   node --env-file=apps/api/.env tools/a11y/cabe.mjs            # tudo
 *   node --env-file=apps/api/.env tools/a11y/cabe.mjs deck lib.* # filtra cena
 *   CABE_VIEWPORTS=320x568,740x360 node ... tools/a11y/cabe.mjs
 *
 * Sai 1 se alguma tela não couber, estourar na horizontal, deixar controle
 * abaixo da dobra ou servir alvo de toque menor que --tap.
 */
import {
  openChrome, servers, abrirSessao, devolver, evaluate, waitFor, sleep, comBanco, WEB,
} from "./lib.mjs";

const VIEWPORTS = (process.env["CABE_VIEWPORTS"] ?? "320x568,360x640,390x844,430x932,740x360")
  .split(",")
  .map((v) => v.trim());

/**
 * Uma medição, um `Runtime.evaluate`. Tudo sai de `getBoundingClientRect`:
 * `document.scrollWidth` não denuncia estouro porque html e body têm
 * `overflow-x: clip`, que mata a barra e some com a prova junto.
 */
const SONDA = `(() => {
  const de = document.documentElement;
  const W = de.clientWidth, H = de.clientHeight;
  const rem = parseFloat(getComputedStyle(de).fontSize);
  const tapCss = getComputedStyle(de).getPropertyValue('--tap').trim();
  const tap = tapCss.endsWith('rem') ? parseFloat(tapCss) * rem : parseFloat(tapCss) || 44;

  const visivel = (el, r) => r.width > 0 && r.height > 0 &&
    getComputedStyle(el).visibility !== 'hidden';
  const nome = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 32);
  const marca = (el) => el.tagName.toLowerCase() +
    (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.').slice(0, 34) : '');

  // Estouro horizontal, elemento a elemento.
  const estouro = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
    const r = el.getBoundingClientRect();
    if (!visivel(el, r)) continue;
    if (r.right > W + 0.5 || r.left < -0.5) {
      estouro.push({ el: marca(el), l: Math.round(r.left), r: Math.round(r.right), txt: nome(el) });
    }
  }

  // Controles: fora da dobra, e alvo pequeno.
  const SEL = 'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
  const foraDaDobra = [], alvoPequeno = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (!visivel(el, r)) continue;
    const d = { el: marca(el), txt: nome(el), y: Math.round(r.top), b: Math.round(r.bottom),
                w: Math.round(r.width), h: Math.round(r.height) };
    if (r.bottom > H + 0.5 || r.top < -0.5) foraDaDobra.push(d);
    // Link de texto não é alvo de toque: o piso de --tap é do controle que
    // tem caixa própria (fundo, borda ou padding). Sem esta separação o
    // rodapé do TMDB reprova toda tela, e aí a marca deixa de significar algo.
    const cs = getComputedStyle(el);
    // Comparação de string, e não regex: a SONDA é template literal, e o
    // \\( do padrão viraria parêntese de grupo no caminho até a página — a
    // marca de alvo pequeno pegava fogo em toda tela por causa disso.
    const semFundo = cs.backgroundColor === 'transparent' || cs.backgroundColor.startsWith('rgba(0, 0, 0, 0)');
    const semCaixa = semFundo && parseFloat(cs.borderTopWidth) === 0 && parseFloat(cs.paddingTop) < 4;
    const textual = cs.display === 'inline' || (el.tagName === 'A' && semCaixa);
    if (!textual && (r.width < tap - 0.5 || r.height < tap - 0.5)) alvoPequeno.push(d);
  }

  // Folga vertical real: a coluna do shell é flex, então o que sobra é a altura
  // dela menos a soma dos itens e das folgas entre eles. Medir o bottom do
  // último item não serve: \`margin-top: auto\` no rodapé cola ele embaixo e a
  // conta daria zero de folga em qualquer tela.
  const shell = document.querySelector('.shell');
  let folga = null;
  if (shell) {
    const cs = getComputedStyle(shell);
    const gap = parseFloat(cs.rowGap) || 0;
    const itens = [...shell.children]
      .flatMap((el) => getComputedStyle(el).display === 'contents' ? [...el.children] : [el])
      .filter((el) => el.tagName !== 'STYLE' && visivel(el, el.getBoundingClientRect()));
    const soma = itens.reduce((a, el) => a + el.getBoundingClientRect().height, 0)
      + gap * Math.max(0, itens.length - 1);
    const alturaDisponivel = H - parseFloat(cs.marginTop || 0) - parseFloat(cs.marginBottom || 0)
      - parseFloat(getComputedStyle(document.body).paddingTop)
      - parseFloat(getComputedStyle(document.body).paddingBottom);
    folga = Math.round(alturaDisponivel - soma);
  }

  const acoes = document.querySelector('.actions');
  return {
    W, H, tap, folga,
    scrollH: de.scrollHeight, clientH: H,
    rola: Math.max(0, de.scrollHeight - H),
    acoes: acoes ? (() => { const r = acoes.getBoundingClientRect();
      return { y: Math.round(r.top), b: Math.round(r.bottom), dentro: r.bottom <= H + 0.5 }; })() : null,
    estouro: estouro.slice(0, 6), foraDaDobra: foraDaDobra.slice(0, 8), alvoPequeno: alvoPequeno.slice(0, 8),
    nEstouro: estouro.length, nFora: foraDaDobra.length, nPequeno: alvoPequeno.length,
  };
})()`;


/**
 * Conta POVOADA. A `abrirSessao` planta só os 20 likes do onboarding, e eles
 * não viram `library_entries`: as três abas da biblioteca e as três de amigos
 * abriam vazias, e lista vazia cabe em qualquer tela — a régua daria verde sem
 * ter medido nada. Aqui a fixture escreve onde cada aba lê de verdade:
 * `library_entries` (interessados e assistidos), `swipes.direction = -1`
 * (descartados), `friendships`, `matches` (títulos em comum) e `notifications`.
 *
 * Devolve o id do amigo criado, que também precisa ser apagado no fim.
 */
async function povoar(userId) {
  return comBanco(async (sql) => {
    const [amigo] = await sql`
      insert into users (handle, display_name, is_public, birth_year, handle_chosen)
      values (${`cabe-amiga-${userId.slice(0, 8)}`}, 'Amiga da Régua', true, 1990, true)
      returning id`;
    const [pendente] = await sql`
      insert into users (handle, display_name, is_public, birth_year, handle_chosen)
      values (${`cabe-pede-${userId.slice(0, 8)}`}, 'Quem Pediu', true, 1990, true)
      returning id`;
    const titulos = await sql`
      select id, title from titles where poster_url is not null or true
      order by score desc nulls last limit 36`;
    const fatia = (a, b) => titulos.slice(a, b);

    for (const [status, linhas] of [["interested", fatia(0, 12)], ["watched", fatia(12, 24)]]) {
      for (const t of linhas) {
        await sql`
          insert into library_entries (user_id, title_id, status, rating, watched_at)
          values (${userId}, ${t.id}, ${status}, ${status === "watched" ? 4 : null},
                  ${status === "watched" ? new Date() : null})
          on conflict do nothing`;
      }
    }
    for (const t of fatia(24, 36)) {
      await sql`
        insert into swipes (user_id, title_id, direction) values (${userId}, ${t.id}, -1)
        on conflict (user_id, title_id) do update set direction = -1`;
    }

    // O par é sempre normalizado user_a < user_b — a tabela tem CHECK para isso.
    const par = (x, y) => (x < y ? [x, y] : [y, x]);
    const [aA, aB] = par(userId, amigo.id);
    await sql`
      insert into friendships (user_a, user_b, requested_by, status, responded_at)
      values (${aA}, ${aB}, ${userId}, 'accepted', now())`;
    const [pA, pB] = par(userId, pendente.id);
    await sql`
      insert into friendships (user_a, user_b, requested_by, status)
      values (${pA}, ${pB}, ${pendente.id}, 'pending')`;

    for (const t of fatia(0, 10)) {
      await sql`
        insert into matches (user_a, user_b, title_id, strength)
        values (${aA}, ${aB}, ${t.id}, 3) on conflict do nothing`;
    }
    for (const t of fatia(0, 5)) {
      await sql`
        insert into notifications (user_id, type, payload)
        values (${userId}, 'match',
                ${sql.json({ friendId: amigo.id, friendHandle: `cabe-amiga-${userId.slice(0, 8)}`,
                             titleId: t.id, title: t.title })})`;
    }
    return [amigo.id, pendente.id];
  });
}

/** Contas extras criadas pela fixture, apagadas junto com a cena. */
const lixo = [];
const comFixture = async (page, opts) => {
  const u = await abrirSessao(page, opts);
  lixo.push(...(await povoar(u)));
  return u;
};

const limpar = async (page) => {
  // `about:blank` antes de tudo: navegar só o hash NÃO recarrega o app, e a
  // cena herdaria os dados que a anterior já tinha carregado — foi assim que a
  // cena de erro de amigos mediu uma tela sem erro nenhum.
  await page.cmd("Page.navigate", { url: "about:blank" });
  await page.cmd("Network.clearBrowserCookies");
  await page.cmd("Network.setBlockedURLs", { urls: [] });
  await page.cmd("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
};

const clicarAba = (page, rotulo) =>
  evaluate(page, `[...document.querySelectorAll('.lib-tabs button')]
     .find(b => b.innerText.trim() === ${JSON.stringify(rotulo)})?.click() ?? 'nao-achou'`);

/**
 * As cenas. Cada uma monta a sessão que precisa, navega e espera o que prova
 * que a tela chegou — nunca um `sleep` solto no lugar da prova.
 */
const CENAS = [
  ["deslogada", async (page) => {
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".signed-out");
    return null;
  }],
  ["porta-idade", async (page) => {
    const u = await abrirSessao(page, { birthYear: null, onboarded: false });
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".age-gate");
    return u;
  }],
  ["porta-handle", async (page) => {
    const u = await abrirSessao(page, { onboarded: false, handleChosen: false });
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".handle-gate");
    return u;
  }],
  ["onboarding", async (page) => {
    const u = await abrirSessao(page, { onboarded: false });
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".onboarding", 40_000);
    return u;
  }],
  ["deck", async (page) => {
    const u = await abrirSessao(page);
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".deck-card", 40_000);
    return u;
  }],
  ["deck-erro", async (page) => {
    const u = await abrirSessao(page);
    await page.cmd("Network.setBlockedURLs", { urls: ["*/v1/feed*"] });
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".notice.error", 40_000);
    return u;
  }],
  ...[["interested", "Interested"], ["watched", "Watched"], ["discarded", "Discarded"]].map(
    ([id, rotulo]) => [`lib-${id}`, async (page) => {
      const u = await comFixture(page);
      await page.cmd("Page.navigate", { url: `${WEB}/#/library` });
      await waitFor(page, ".lib-tabs", 40_000);
      if (id !== "interested") await clicarAba(page, rotulo);
      await sleep(1500);
      return u;
    }],
  ),
  ["lib-vazia", async (page) => {
    // Conta sem nada: o estado vazio é uma tela de verdade, e é a única que
    // sobra sem a fixture. Sem esta cena a régua mede só o caso cheio.
    const u = await abrirSessao(page);
    await page.cmd("Page.navigate", { url: `${WEB}/#/library` });
    await waitFor(page, ".lib-tabs", 40_000);
    await sleep(1500);
    return u;
  }],
  ["lib-carregando", async (page) => {
    const u = await comFixture(page);
    await page.cmd("Page.navigate", { url: `${WEB}/#/library` });
    await waitFor(page, ".lib-tabs", 40_000);
    // Latência absurda em vez de bloqueio: bloquear dá erro, e o que se quer
    // medir aqui é a tela ENQUANTO espera.
    await page.cmd("Network.emulateNetworkConditions", {
      offline: false, latency: 100_000, downloadThroughput: -1, uploadThroughput: -1,
    });
    await clicarAba(page, "Watched");
    await waitFor(page, ".lib .notice", 10_000);
    return u;
  }],
  ["lib-erro", async (page) => {
    const u = await comFixture(page);
    await page.cmd("Network.setBlockedURLs", { urls: ["*/v1/library*", "*/v1/me/stats*"] });
    await page.cmd("Page.navigate", { url: `${WEB}/#/library` });
    await waitFor(page, ".notice.error", 40_000);
    return u;
  }],
  ...["people", "common", "alerts"].map((id) => [
    `friends-${id}`, async (page) => {
      const u = await comFixture(page);
      await page.cmd("Page.navigate", { url: `${WEB}/#/friends/${id}` });
      await waitFor(page, ".lib-tabs", 40_000);
      await sleep(1500);
      return u;
    },
  ]),
  ["friends-erro", async (page) => {
    const u = await comFixture(page);
    await page.cmd("Network.setBlockedURLs", { urls: ["*/v1/friends*", "*/v1/matches*", "*/v1/notifications*"] });
    await page.cmd("Page.navigate", { url: `${WEB}/#/friends` });
    await waitFor(page, ".notice.error", 40_000);
    return u;
  }],
];

const filtros = process.argv.slice(2);
const cenas = filtros.length
  ? CENAS.filter(([nome]) => filtros.some((f) => new RegExp(`^${f.replace(/\*/g, ".*")}$`).test(nome)))
  : CENAS;

const matriz = new Map(); // cena -> viewport -> célula
let reprovou = false;

const srv = await servers();
for (const vp of VIEWPORTS) {
  const [w] = vp.split("x").map(Number);
  // Telefone deitado é telefone: 740x360 passaria por desktop pela largura.
  const page = await openChrome({ viewport: vp, mobile: true });
  console.log(`\n════ ${vp}${w > 700 ? " (paisagem)" : ""} ════`);
  for (const [nome, montar] of cenas) {
    let user = null;
    try {
      // Duas tentativas: montar a cena depende de rede e de sessão nova, e uma
      // falha isolada aí é ruído — não defeito de layout. Só reprova quem
      // falhar duas vezes.
      let m, ultimo;
      for (let tentativa = 1; tentativa <= 2 && !m; tentativa++) {
        try {
          for (const extra of lixo.splice(0)) await devolver(extra);
          await devolver(user);
          user = null;
          await limpar(page);
          user = await montar(page);
          await sleep(600);
          m = await evaluate(page, SONDA);
        } catch (e) {
          ultimo = e;
          if (tentativa === 2) throw e;
        }
      }
      void ultimo;
      const flags =
        (m.rola > 0 ? "R" : "") + (m.nFora ? "D" : "") + (m.nEstouro ? "X" : "") + (m.nPequeno ? "T" : "");
      const cabe = m.folga === null ? "?" : m.folga >= 0 ? `+${m.folga}` : `${m.folga}`;
      if (m.rola > 0 || m.nFora || m.nEstouro || m.nPequeno) reprovou = true;
      matriz.set(nome, { ...(matriz.get(nome) ?? {}), [vp]: `${cabe}${flags ? " " + flags : ""}` });

      console.log(`${nome}: folga ${cabe}px · ${m.rola ? `rola ${m.rola}px` : "não rola"}` +
        (m.acoes ? ` · botões ${m.acoes.dentro ? "dentro" : `FORA (bottom ${m.acoes.b} > ${m.H})`}` : ""));
      for (const f of m.foraDaDobra) console.log(`   abaixo da dobra: ${f.el} "${f.txt}" ${f.y}..${f.b} (dobra ${m.H})`);
      for (const f of m.estouro) console.log(`   estoura: ${f.el} "${f.txt}" ${f.l}..${f.r} (largura ${m.W})`);
      for (const f of m.alvoPequeno) console.log(`   alvo ${f.w}x${f.h} < ${m.tap}: ${f.el} "${f.txt}"`);
      if (m.nFora > m.foraDaDobra.length) console.log(`   (+${m.nFora - m.foraDaDobra.length} controles abaixo da dobra)`);
    } catch (e) {
      reprovou = true;
      matriz.set(nome, { ...(matriz.get(nome) ?? {}), [vp]: "ERRO" });
      console.log(`${nome}: ERRO — ${String(e.message).slice(0, 160)}`);
    } finally {
      await devolver(user);
      for (const extra of lixo.splice(0)) await devolver(extra);
    }
  }
  page.close();
}
srv.stop();

const largura = Math.max(14, ...[...matriz.keys()].map((k) => k.length));
console.log(`\n| ${"tela".padEnd(largura)} | ${VIEWPORTS.map((v) => v.padEnd(13)).join(" | ")} |`);
console.log(`|${"-".repeat(largura + 2)}|${VIEWPORTS.map(() => "-".repeat(15)).join("|")}|`);
for (const [nome, linha] of matriz) {
  console.log(`| ${nome.padEnd(largura)} | ${VIEWPORTS.map((v) => (linha[v] ?? "—").padEnd(13)).join(" | ")} |`);
}
console.log(`
número = folga vertical em px (negativo = falta tanto para caber)
R = rola na vertical · D = controle abaixo da dobra · X = estouro horizontal · T = alvo < --tap`);

process.exit(reprovou ? 1 : 0);
