/** Busca e pedido de amizade: o que é anunciado e onde o foco fica. */
import {
  openChrome, servers, abrirSessao, devolver, evaluate, waitFor, tab, enter,
  pressKey, comBanco, sleep, until, WEB, DESCREVE,
} from "./lib.mjs";

const foco = (page) => evaluate(page, DESCREVE);
const vivo = (page) =>
  evaluate(page, `[...document.querySelectorAll('[aria-live], [role="alert"], [role="status"]')]
    .map(e => ({ live: e.getAttribute('aria-live') || e.getAttribute('role'), texto: (e.innerText||'').replace(/\s+/g,' ').slice(0,60) }))`);

const srv = await servers();
const page = await openChrome({ viewport: "430x932" });
let user, outro;
try {
  user = await abrirSessao(page);
  outro = crypto.randomUUID();
  await comBanco((sql) => sql`insert into users (id, handle, display_name, birth_year)
    values (${outro}, 'vizinha', 'Vizinha', 1990)`);

  await page.cmd("Page.navigate", { url: WEB + "/#/friends" });
  await waitFor(page, ".friend-search input", 40_000);
  await sleep(1200);

  // digita o handle no campo, pelo teclado
  for (let i = 0; i < 20; i++) {
    await tab(page);
    if ((await foco(page)).tag === "INPUT") break;
  }
  console.log("foco no campo:", JSON.stringify(await foco(page)));
  for (const c of "vizinha") await pressKey(page, c, c.toUpperCase().charCodeAt(0));
  await enter(page);
  await until(() => evaluate(page, `document.querySelectorAll('.lib-list li').length`), (n) => n > 0, "o resultado chegar");
  await sleep(500);
  console.log("depois da busca — foco:", JSON.stringify(await foco(page)));
  console.log("depois da busca — regiões vivas:", JSON.stringify(await vivo(page)));
  console.log("resultados no DOM:", await evaluate(page, `document.querySelectorAll('.lib-list li').length`));

  // Tab até "Add friend" e aciona
  for (let i = 0; i < 20; i++) {
    await tab(page);
    const d = await foco(page);
    if (d.text === "Add friend") break;
    if (d.tag === "BODY") break;
  }
  console.log("\nfoco antes de 'Add friend':", JSON.stringify(await foco(page)));
  await enter(page);
  await until(
    () => evaluate(page, `[...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Add friend')`),
    (v) => v === false,
    "o botão sumir",
  );
  await sleep(500);
  console.log("foco depois:", JSON.stringify(await foco(page)));
  console.log("regiões vivas:", JSON.stringify(await vivo(page)));
} finally {
  await devolver(user);
  await devolver(outro);
  page.close();
  srv.stop();
}
process.exit(0);
