/**
 * Biblioteca com conteúdo de verdade: onde o foco cai quando um item muda de
 * aba, e o que é anunciado quando chega notificação.
 */
import {
  openChrome, servers, abrirSessao, devolver, evaluate, waitFor, tab, enter,
  comBanco, sleep, axTree, printAx, until, WEB, DESCREVE,
} from "./lib.mjs";

const foco = (page) => evaluate(page, DESCREVE);
const vivo = (page) =>
  evaluate(page, `[...document.querySelectorAll('[aria-live], [role="alert"], [role="status"]')]
    .map(e => ({ live: e.getAttribute('aria-live') || e.getAttribute('role'), texto: (e.innerText||'').replace(/\s+/g,' ').slice(0,60) }))`);

const srv = await servers();
const page = await openChrome({ viewport: "430x932" });
let user;
try {
  user = await abrirSessao(page);
  await comBanco(async (sql) => {
    await sql`insert into library_entries (user_id, title_id, status, rating)
              select ${user}, t.id, 'interested', null from titles t order by t.score desc limit 3`;
    await sql`insert into library_entries (user_id, title_id, status, rating)
              select ${user}, t.id, 'watched', 4 from titles t order by t.score asc limit 2`;
  });
  await page.cmd("Page.navigate", { url: WEB + "/#/library" });
  await waitFor(page, ".lib-list", 40_000);
  await sleep(1500);

  console.log("— biblioteca com 3 itens —");
  printAx(await axTree(page).then((l) => l.filter((n) => /button|listitem|tab|heading|checkbox|link/.test(n.role))));

  console.log("\nordem de tab:");
  const alvos = [];
  for (let i = 0; i < 18; i++) {
    await tab(page);
    const d = await foco(page);
    if (d.tag === "BODY") { console.log("  ⟲ fim do ciclo"); break; }
    alvos.push(d);
    console.log(`  ${d.tag}${d.role ? `[${d.role}]` : ""} "${d.text}" ${d.w}x${d.h} alvo:${d.w >= 44 && d.h >= 44 ? "ok" : "PEQUENO"} fv:${d.fv}`);
  }

  // Foco antes e depois de mover um item de aba (o botão some com a lista).
  for (let i = 0; i < 30; i++) {
    await tab(page);
    const d = await foco(page);
    if (d.text === "Mark as watched") break;
    if (d.tag === "BODY") break;
  }
  console.log("\nfoco antes de 'Mark as watched':", JSON.stringify(await foco(page)));
  const antes = await evaluate(page, `document.querySelectorAll('.lib-list li').length`);
  await enter(page);
  await until(() => evaluate(page, `document.querySelectorAll('.lib-list li').length`), (n) => n !== antes, "a lista encolher");
  await sleep(600);
  console.log("foco depois:", JSON.stringify(await foco(page)));
  console.log("regiões vivas:", JSON.stringify(await vivo(page)));

  // Notificação chegando com a página aberta: o badge é o único sinal.
  await comBanco((sql) => sql`insert into notifications (user_id, type, payload)
     values (${user}, 'match', ${JSON.stringify({ friendHandle: "amiga", title: "Death Note" })})`);
  console.log("\nesperando o badge (o polling é de 60s, mas o load inicial já passou)…");
  const badge = await until(
    () => evaluate(page, `document.querySelector('.nav-badge')?.outerHTML ?? null`),
    (v) => v !== null,
    "o badge aparecer",
    70_000,
  ).catch(() => null);
  console.log("badge:", badge);
  console.log("regiões vivas quando o aviso chega:", JSON.stringify(await vivo(page)));
  console.log("foco:", JSON.stringify(await foco(page)));
} finally {
  await devolver(user);
  page.close();
  srv.stop();
}
process.exit(0);
