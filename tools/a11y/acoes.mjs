/**
 * O que acontece DEPOIS de uma ação: onde o foco fica e o que é anunciado.
 * uso: node --env-file=apps/api/.env .a11y/acoes.mjs <cena>
 *   deck | erro | library | friends | porta
 */
import {
  openChrome, servers, abrirSessao, devolver, evaluate, waitFor, tab, enter,
  pressKey, sleep, axTree, printAx, until, WEB, DESCREVE,
} from "./lib.mjs";

const cena = process.argv[2] ?? "deck";

const foco = (page) => evaluate(page, DESCREVE);
const vivo = (page) =>
  evaluate(
    page,
    `[...document.querySelectorAll('[aria-live], [role="alert"], [role="status"]')]
       .map(e => ({ live: e.getAttribute('aria-live') || e.getAttribute('role'),
                    texto: (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80),
                    cls: String(e.className||'').slice(0,24) }))`,
  );
const topo = (page) =>
  evaluate(page, `document.querySelector('.deck .deck-card:last-child .card-title')?.innerText ?? null`);

const clique = (page, texto) =>
  evaluate(
    page,
    `[...document.querySelectorAll('button, a')].find(b => b.innerText.trim() === ${JSON.stringify(texto)})?.click() ?? 'nao-achou'`,
  );

const srv = await servers();
const page = await openChrome({ viewport: "430x932" });
let user;
try {
  if (cena === "porta") {
    user = await abrirSessao(page, { birthYear: null, onboarded: false });
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".age-gate");
    await sleep(800);

    console.log("— porta de idade, antes de responder —");
    printAx(await axTree(page));
    console.log("\nregiões vivas:", JSON.stringify(await vivo(page)));

    // Tab até o campo e digita um ano de menor de idade.
    for (let i = 0; i < 12; i++) {
      await tab(page);
      const d = await foco(page);
      if (d.tag === "INPUT") break;
    }
    console.log("foco no campo:", JSON.stringify(await foco(page)));
    for (const [k, c] of [["2", 50], ["0", 48], ["1", 49], ["5", 53]]) await pressKey(page, k, c);
    await enter(page);
    await sleep(1500);

    console.log("\n— depois da recusa —");
    console.log("foco:", JSON.stringify(await foco(page)));
    console.log("regiões vivas:", JSON.stringify(await vivo(page)));
    printAx(await axTree(page));
    console.log("\nfocalizáveis restantes:",
      await evaluate(page, `[...document.querySelectorAll('a[href],button,input,select')].length`));
  }

  if (cena === "onboarding") {
    user = await abrirSessao(page, { onboarded: false });
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".onboarding", 40_000);
    await sleep(1000);

    console.log("— onboarding: escolha de gêneros —");
    printAx(await axTree(page));
    console.log("regiões vivas:", JSON.stringify(await vivo(page)));
    console.log("ordem de tab (8 primeiras):");
    for (let i = 0; i < 8; i++) {
      await tab(page);
      const d = await foco(page);
      console.log(`  ${d.tag} "${d.text}" ${d.w}x${d.h} fv:${d.fv} pressed=${await evaluate(page, "document.activeElement.getAttribute('aria-pressed')")}`);
    }
    // escolhe o gênero focado e segue
    await enter(page);
    await sleep(200);
    console.log("aria-pressed depois do Enter:", await evaluate(page, "document.activeElement.getAttribute('aria-pressed')"));
    await evaluate(page, `[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Start swiping').click()`);
    await waitFor(page, ".deck-card", 40_000);
    await sleep(800);

    console.log("\n— onboarding: deck dos 20 —");
    console.log("contador:", await evaluate(page, `document.querySelector('.onboarding-count')?.innerText.replace(/\\s+/g,' ')`));
    console.log("regiões vivas:", JSON.stringify(await vivo(page)));
    const antes = await topo(page);
    await pressKey(page, "ArrowRight", 39);
    await until(() => topo(page), (v) => v && v !== antes, "o card trocar");
    console.log("depois de um swipe:", JSON.stringify(await vivo(page)));
    console.log("foco:", JSON.stringify(await foco(page)));
    const prog = await evaluate(page, `(() => { const p = document.querySelector('progress'); return p ? { value: p.value, max: p.max } : null; })()`);
    console.log("progress:", JSON.stringify(prog));
  }

  if (cena === "erro-swipe") {
    // O caso de campo: a pessoa está decidindo pelo teclado e a rede cai.
    user = await abrirSessao(page);
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".deck-card", 40_000);
    await sleep(800);
    for (let i = 0; i < 20; i++) {
      await tab(page);
      const d = await foco(page);
      if (d.text.startsWith("Interested")) break;
    }
    console.log("foco antes:", JSON.stringify(await foco(page)));
    await page.cmd("Network.setBlockedURLs", { urls: ["*/v1/feed*"] });
    for (let i = 0; i < 22; i++) {
      await enter(page);
      await sleep(250);
      if (await evaluate(page, `!!document.querySelector('.notice.error')`)) break;
    }
    console.log("erro na tela:", await evaluate(page, `document.querySelector('.notice.error')?.innerText.replace(/\\s+/g,' ')`));
    console.log("foco depois:", JSON.stringify(await foco(page)));
    console.log("regiões vivas:", JSON.stringify(await vivo(page)));
  }

  if (cena === "deck" || cena === "erro") {
    user = await abrirSessao(page);
    if (cena === "erro") {
      // Falha de verdade no caminho do feed: a rede recusa, como em campo.
      await page.cmd("Network.setBlockedURLs", { urls: ["*/v1/feed*"] });
    }
    await page.cmd("Page.navigate", { url: WEB + "/" });

    await waitFor(page, cena === "erro" ? ".notice.error" : ".deck-card", 40_000);
    await sleep(1000);

    if (cena === "deck") {
      console.log("— deck montado —");
      printAx(await axTree(page));
      console.log("\nregiões vivas:", JSON.stringify(await vivo(page)));

      const antes = await topo(page);
      // Tab até o botão Like e aciona pelo TECLADO.
      for (let i = 0; i < 20; i++) {
        await tab(page);
        const d = await foco(page);
        if (d.text.startsWith("Interested")) break;
      }
      console.log("\nfoco antes do Like:", JSON.stringify(await foco(page)));
      await enter(page);
      const depois = await until(() => topo(page), (v) => v && v !== antes, "o card trocar");
      console.log(`card: ${antes} → ${depois}`);
      console.log("foco depois do Like:", JSON.stringify(await foco(page)));
      console.log("regiões vivas:", JSON.stringify(await vivo(page)));

      // Undo pelo teclado (Backspace, o atalho que o botão anuncia).
      await pressKey(page, "Backspace", 8);
      await sleep(800);
      console.log("\nfoco depois do Backspace (undo):", JSON.stringify(await foco(page)));
      console.log("topo depois do undo:", await topo(page));
      console.log("regiões vivas:", JSON.stringify(await vivo(page)));
    } else {
      console.log("— deck com o feed falhando —");
      printAx(await axTree(page));
      console.log("\nregiões vivas:", JSON.stringify(await vivo(page)));
      console.log("foco:", JSON.stringify(await foco(page)));
    }
  }

  if (cena === "library" || cena === "friends") {
    user = await abrirSessao(page);
    await page.cmd("Page.navigate", { url: `${WEB}/#/${cena === "library" ? "library" : "friends"}` });
    await waitFor(page, ".lib-tabs");
    await sleep(1500);

    console.log(`— ${cena} —`);
    printAx(await axTree(page));
    console.log("\nregiões vivas:", JSON.stringify(await vivo(page)));

    // Tab até a primeira aba e tenta navegar com seta, como manda o papel tab.
    for (let i = 0; i < 20; i++) {
      await tab(page);
      const d = await foco(page);
      if (d.role === "tab") break;
    }
    console.log("\nfoco na primeira aba:", JSON.stringify(await foco(page)));
    await pressKey(page, "ArrowRight", 39);
    console.log("depois de ArrowRight:", JSON.stringify(await foco(page)));
    await tab(page);
    console.log("depois de Tab:", JSON.stringify(await foco(page)));
    await enter(page);
    await sleep(1200);
    console.log("depois de Enter (troca de aba):", JSON.stringify(await foco(page)));
    console.log("regiões vivas:", JSON.stringify(await vivo(page)));
    console.log("\nordem de tab a partir daqui:");
    for (let i = 0; i < 8; i++) {
      await tab(page);
      const d = await foco(page);
      console.log(`  ${d.tag}${d.role ? `[${d.role}]` : ""} "${d.text}" ${d.w}x${d.h} fv:${d.fv}`);
    }
  }

  const erros = page.errors.filter((e) => !/favicon/i.test(e));
  if (erros.length) console.log("\nconsole:", erros.join(" | "));
} finally {
  await devolver(user);
  page.close();
  srv.stop();
}
process.exit(0);
