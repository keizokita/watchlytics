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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  openChrome, servers, abrirSessao, devolver, evaluate, waitFor, until, sleep, comBanco, ROOT, WEB,
} from "./lib.mjs";

/**
 * Procedência do instrumento E do que ele mede. A régua são DOIS arquivos —
 * `cabe.mjs` e `lib.mjs` — e um par desencontrado não dá erro: dá uma corrida
 * inteira parando na porta do handle, com sintoma de defeito de produto. Uma
 * matriz sem esta linha não prova de qual instrumento saiu.
 */
function procedencia() {
  const sha = (f) => createHash("sha1").update(readFileSync(new URL(f, import.meta.url))).digest("hex").slice(0, 12);
  let commit = "?";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const sujo = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (sujo) commit += "+local";
  } catch {}
  return `instrumento: cabe.mjs ${sha("./cabe.mjs")} · lib.mjs ${sha("./lib.mjs")} | medindo: ${ROOT} @ ${commit}`;
}

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
  // O alvo de um checkbox com <label> em volta é o rótulo: clicar nele alterna,
  // e é ele que o dedo acerta. Medir o <input> reprova toda caixa bem
  // construída para sempre, e mede o elemento errado ao fazer isso.
  const alvoDe = (el) => {
    const rot = el.closest('label') ||
      (el.id ? document.querySelector('label[for="' + el.id + '"]') : null);
    return rot && /^(checkbox|radio)$/.test(el.type ?? '') ? { el: rot, r: rot.getBoundingClientRect() }
                                                           : { el, r: el.getBoundingClientRect() };
  };
  const foraDaDobra = [], alvoPequeno = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (!visivel(el, r)) continue;
    const d = { el: marca(el), txt: nome(el), y: Math.round(r.top), b: Math.round(r.bottom),
                w: Math.round(r.width), h: Math.round(r.height) };
    // Controle de LINHA de lista não é controle de tela: numa lista longa os
    // botões das linhas de baixo estão abaixo da dobra porque a lista é longa,
    // e isso não é defeito. O que não pode sair de alcance é o controle da
    // própria tela — nav, abas, botões de conta.
    d.naLista = !!el.closest('.lib-list, .friend');
    // Numa tela que rola, estar abaixo da dobra não é estar fora de alcance:
    // rolar chega lá. Fora de alcance é o que a rolagem NÃO alcança — o que
    // cai além do documento rolável, ou o que algum ancestral clipa.
    const fim = document.documentElement.scrollHeight;
    const clipado = (() => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs2 = getComputedStyle(p), pr = p.getBoundingClientRect();
        if (/hidden|clip/.test(cs2.overflowY) && (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5)) return true;
      }
      return false;
    })();
    d.inalcancavel = clipado || r.bottom + scrollY > fim + 1 || r.top + scrollY < -1;
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
    const alvo = alvoDe(el);
    if (!textual && (alvo.r.width < tap - 0.5 || alvo.r.height < tap - 0.5)) {
      // O retângulo não é a área de toque. Um ::after com inset negativo
      // estica a área sem aparecer em rect nenhum, e um <label> em volta
      // entrega o clique à caixa. Quem responde é elementFromPoint, nos quatro
      // pontos a meio --tap do centro: se todos caem no próprio alvo (ou num
      // filho dele), a área efetiva já cobre o piso.
      const cx = alvo.r.left + alvo.r.width / 2, cy = alvo.r.top + alvo.r.height / 2;
      const meio = tap / 2 - 1;
      const pontos = [[cx, cy - meio], [cx, cy + meio], [cx - meio, cy], [cx + meio, cy]];
      const pega = pontos.every(([x, y]) => {
        const alvoNoPonto = document.elementFromPoint(x, y);
        return alvoNoPonto && (alvo.el.contains(alvoNoPonto) || alvoNoPonto === el ||
               (el.labels && [...el.labels].some((l) => l.contains(alvoNoPonto))));
      });
      if (!pega) {
        alvoPequeno.push({ ...d, el: marca(alvo.el), w: Math.round(alvo.r.width), h: Math.round(alvo.r.height) });
      }
    }
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

  // Pilha vertical da tela: tag@top+altura por filho. É ela que separa uma
  // lista que rola por natureza de uma tela cujo conteúdo nasce empurrado para
  // fora — o número da folga sozinho não distingue os dois.
  const alvoPilha = document.querySelector('.lib') || document.querySelector('.deck-wrap') ||
    document.querySelector('.onboarding') || document.querySelector('main > *');
  const pilha = alvoPilha ? [...alvoPilha.children]
    .filter((el) => el.tagName !== 'STYLE')
    .map((el) => { const r = el.getBoundingClientRect();
      return marca(el) + '@' + Math.round(r.top) + '+' + Math.round(r.height); }) : [];

  // A primeira linha da lista: numa tela que rola por natureza, o critério que
  // significa alguma coisa é esta linha caber INTEIRA antes de rolar.
  const itens = document.querySelectorAll('.lib-list > li').length;
  const li = document.querySelector('.lib-list > li');
  const primeiraLinha = li ? (() => { const r = li.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), cabe: r.bottom <= H + 0.5 }; })() : null;

  const acoes = document.querySelector('.actions');
  return {
    W, H, tap, folga, pilha, primeiraLinha, itens,
    scrollH: de.scrollHeight, clientH: H,
    rola: Math.max(0, de.scrollHeight - H),
    acoes: acoes ? (() => { const r = acoes.getBoundingClientRect();
      return { y: Math.round(r.top), b: Math.round(r.bottom), dentro: r.bottom <= H + 0.5 }; })() : null,
    estouro: estouro.slice(0, 6), foraDaDobra: foraDaDobra.slice(0, 8), alvoPequeno: alvoPequeno.slice(0, 8),
    nEstouro: estouro.length, nFora: foraDaDobra.length, nPequeno: alvoPequeno.length,
    nForaDaTela: foraDaDobra.filter((f) => !f.naLista).length,
    nInalcancavel: foraDaDobra.filter((f) => f.inalcancavel).length,
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

/**
 * "A tela parou", provado — e não `sleep(600)`, que aposta que o que acontece
 * DEPOIS de a tela chegar também terminou. A aposta se perde quando o navegador
 * roda frio: a mesma cena media -236 em suíte e -528 sozinha, no mesmo commit.
 *
 * Três provas: fonte pronta (troca de fonte muda altura de tudo), imagem dentro
 * da dobra carregada, e dois quadros seguidos com o mesmo `scrollHeight`.
 *
 * ponytail: dois quadros são ~32ms de quietude, e conteúdo de rede chega em
 * buracos maiores que isso — em tese dá para declarar assentado dentro de um
 * vão. Medido antes de reforçar: `lib-carregando` em 320x568 dá -528 sozinha e
 * -528 na suíte (antes eram -528 e -236), então hoje a prova basta. Se voltar a
 * divergir entre modos, o reforço é exigir o mesmo `scrollHeight` em dois POLLS
 * seguidos (240ms) em vez de dois quadros, mantendo os rAF dentro de cada poll.
 */
async function assentou(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const PROVA = `(async () => {
    await document.fonts.ready;
    const dentro = [...document.images].filter((i) => {
      const r = i.getBoundingClientRect();
      return r.height > 0 && r.top < innerHeight;
    });
    if (dentro.some((i) => !i.complete)) return { pronto: false, motivo: 'imagem' };
    const quadro = () => new Promise((r) => requestAnimationFrame(() => r(document.documentElement.scrollHeight)));
    const a = await quadro(), b = await quadro();
    return { pronto: a === b, motivo: 'altura', a, b };
  })()`;
  while (Date.now() < deadline) {
    const r = await evaluate(page, PROVA);
    if (r?.pronto) return;
    await sleep(120);
  }
  throw new Error("a tela não assentou em " + timeoutMs + "ms");
}

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
 * Clicar na aba não é estar NA aba. A lista da aba anterior continua no DOM
 * enquanto a nova carrega, então esperar `.lib-list` volta na hora e a medição
 * pode descrever o conteúdo velho: prova de presença não é prova de identidade.
 * A prova é o par — a aba pedida com `aria-pressed=true` E o aviso de
 * carregando fora da tela.
 *
 * O que NÃO era isto: "interested" e "watched" darem folga idêntica (-3529) no
 * `main`. Suspeitei da aba velha e estava errado — no `main` o botão "Clear
 * rating" é renderizado sempre, só desabilitado, então a altura da linha não
 * depende de haver nota e as duas abas somam igual. Duas telas de conteúdo
 * diferente PODEM dar o mesmo número quando o que decide a altura é o mesmo.
 */
async function trocarAba(page, rotulo) {
  await clicarAba(page, rotulo);
  await until(
    () => evaluate(page, `(() => {
      const b = [...document.querySelectorAll('.lib-tabs button')]
        .find((b) => b.innerText.trim() === ${JSON.stringify(rotulo)});
      if (!b) return 'sem-aba';
      const carregando = [...document.querySelectorAll('.lib .notice')]
        .some((n) => /^loading/i.test(n.innerText.trim()));
      return b.getAttribute('aria-pressed') === 'true' && !carregando;
    })()`),
    (v) => v === true,
    `a aba "${rotulo}" ficar pronta`,
    30_000,
  );
}

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
      await waitFor(page, ".lib-list, .lib .notice", 40_000);
      if (id !== "interested") await trocarAba(page, rotulo);
      await assentou(page);
      return u;
    }],
  ),
  ["lib-vazia", async (page) => {
    // Conta sem nada: o estado vazio é uma tela de verdade, e é a única que
    // sobra sem a fixture. Sem esta cena a régua mede só o caso cheio.
    const u = await abrirSessao(page);
    await page.cmd("Page.navigate", { url: `${WEB}/#/library` });
    await waitFor(page, ".lib-tabs", 40_000);
    await waitFor(page, ".lib-list, .lib .notice", 40_000);
    await assentou(page);
    return u;
  }],
  ["lib-carregando", async (page) => {
    const u = await comFixture(page);
    await page.cmd("Page.navigate", { url: `${WEB}/#/library` });
    await waitFor(page, ".lib-tabs", 40_000);
    // Pré-condição, não sorte: o painel de estatísticas só monta quando
    // /v1/me/stats responde, e ligar a latência antes disso media 292px a
    // menos — o mesmo commit dava -236 na suíte e -528 sozinho, porque quem
    // decidia era o tempo que as cenas anteriores gastaram.
    await waitFor(page, ".lib-stats", 30_000);
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
      await waitFor(page, ".lib-list, .lib-locked, .friend-search", 40_000);
      await assentou(page);
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

/**
 * Telas que rolam por NATUREZA, e não por defeito.
 *
 * É a família da tela que decide, não o estado dela. A biblioteca carrega um
 * bloco de conta de 436px embaixo da lista (`Library.tsx`), e só ele já é maior
 * que a dobra de 320x568 menos o chrome: somando abas 44 + estatísticas 276 +
 * aviso 24 + conta 436 dá 780px numa janela de 568. Ou seja, `lib-vazia`,
 * `lib-carregando` e `lib-erro` não cabem nem sem lista nenhuma — cobrar "não
 * rola" delas seria vermelho permanente por classificação errada, e vermelho
 * permanente esconde regressão melhor do que verde permanente.
 *
 * Que os 436px de configuração morem debaixo do catálogo é pergunta de
 * produto, não de layout, e a régua só a mede.
 */
const ROLA_POR_NATUREZA = /^(lib-|friends-)/;

const matriz = new Map(); // cena -> viewport -> célula
let reprovou = false;

console.log(procedencia());

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
          await assentou(page);
          m = await evaluate(page, SONDA);
        } catch (e) {
          ultimo = e;
          if (tentativa === 2) throw e;
        }
      }
      void ultimo;
      const cabe = m.folga === null ? "?" : m.folga >= 0 ? `+${m.folga}` : `${m.folga}`;
      // O que reprova depende do que a cena promete.
      //
      // Estouro horizontal e alvo pequeno reprovam sempre: nenhum deles tem
      // versão aceitável. Rolar e ter controle abaixo da dobra só reprovam nas
      // cenas que prometem CABER — deck, portas, onboarding, vazia, carregando,
      // erro. Numa lista povoada, rolar é o que uma lista faz, e os botões das
      // linhas de baixo estão fora da dobra porque a lista é longa; ali o
      // critério é outro: a primeira linha inteira antes de rolar, e nenhum
      // controle DA TELA fora de alcance.
      //
      // Régua sempre vermelha esconde regressão melhor do que régua sempre
      // verde: no vermelho que já estava lá ninguém olha duas vezes.
      const lista = ROLA_POR_NATUREZA.test(nome);
      const linhaCortada = lista && m.primeiraLinha !== null && !m.primeiraLinha.cabe;
      const falhou = m.nEstouro > 0 || m.nPequeno > 0 ||
        (lista ? m.nInalcancavel > 0 || linhaCortada : m.nFora > 0 || m.rola > 0);
      if (falhou) reprovou = true;
      const flags =
        (m.rola > 0 ? "R" : "") + ((lista ? m.nInalcancavel : m.nFora) ? "D" : "") +
        (linhaCortada ? "P" : "") + (m.nEstouro ? "X" : "") + (m.nPequeno ? "T" : "");
      matriz.set(nome, { ...(matriz.get(nome) ?? {}), [vp]: `${cabe}${flags ? " " + flags : ""}` });

      console.log(`${nome}: folga ${cabe}px · ${m.rola ? `rola ${m.rola}px` : "não rola"}` +
        (m.itens ? ` · ${m.itens} itens` : "") +
        (m.acoes ? ` · botões ${m.acoes.dentro ? "dentro" : `FORA (bottom ${m.acoes.b} > ${m.H})`}` : ""));
      if (m.primeiraLinha) {
        console.log(`   primeira linha: ${m.primeiraLinha.top}..${m.primeiraLinha.bottom} ` +
          `(dobra ${m.H}) ${m.primeiraLinha.cabe ? "inteira" : "CORTADA"}`);
      }
      for (const f of m.foraDaDobra) {
        const como = f.inalcancavel ? " FORA DE ALCANCE" : f.naLista ? " (linha de lista)" : "";
        console.log(`   abaixo da dobra${como}: ${f.el} "${f.txt}" ${f.y}..${f.b} (dobra ${m.H})`);
      }
      for (const f of m.estouro) console.log(`   estoura: ${f.el} "${f.txt}" ${f.l}..${f.r} (largura ${m.W})`);
      for (const f of m.alvoPequeno) console.log(`   alvo ${f.w}x${f.h} < ${m.tap}: ${f.el} "${f.txt}"`);
      if (m.pilha.length) console.log(`   pilha: ${m.pilha.join(" ")}`);
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

console.log(`\n${procedencia()}`);
const largura = Math.max(14, ...[...matriz.keys()].map((k) => k.length));
console.log(`\n| ${"tela".padEnd(largura)} | ${VIEWPORTS.map((v) => v.padEnd(13)).join(" | ")} |`);
console.log(`|${"-".repeat(largura + 2)}|${VIEWPORTS.map(() => "-".repeat(15)).join("|")}|`);
for (const [nome, linha] of matriz) {
  console.log(`| ${nome.padEnd(largura)} | ${VIEWPORTS.map((v) => (linha[v] ?? "—").padEnd(13)).join(" | ")} |`);
}
console.log(`
número = folga vertical em px (negativo = falta tanto para caber)
R = rola · D = controle fora de alcance (na tela que rola: o que a rolagem não
alcança; na que promete caber: qualquer um abaixo da dobra) · P = primeira linha cortada
X = estouro horizontal · T = alvo de toque < --tap (já descontando ::after e <label>)

reprova (saída 1): X e T sempre. Nas telas que prometem caber (deslogada,
portas, onboarding, deck, deck-erro), R e D também. Nas telas de lista
(lib-*, friends-*), que rolam por construção, o critério é P e D.`);

process.exit(reprovou ? 1 : 0);
