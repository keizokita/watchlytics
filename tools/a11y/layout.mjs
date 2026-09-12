/** Impressão digital da geometria: para comparar antes/depois de mexer no shell. */
import { openChrome, servers, abrirSessao, devolver, evaluate, waitFor, sleep, axTree, WEB } from "./lib.mjs";

const SONDA = `(() => {
  const r = (s) => { const el = document.querySelector(s); if (!el) return null;
    const b = el.getBoundingClientRect();
    return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  return JSON.stringify({
    nav: r('.shell nav'), filtros: r('.filters'), deck: r('.deck'),
    botoes: r('.actions'), rodape: r('.attribution'), lib: r('.lib'),
    alturaDoc: document.documentElement.scrollHeight,
  });
})()`;

const srv = await servers();
for (const vp of ["430x932", "360x640", "1280x800"]) {
  const page = await openChrome({ viewport: vp });
  let user;
  try {
    user = await abrirSessao(page);
    for (const [nome, hash, espera] of [["deck", "", ".deck-card"], ["library", "#/library", ".lib"]]) {
      await page.cmd("Page.navigate", { url: `${WEB}/${hash}` });
      await waitFor(page, espera, 40_000);
      await sleep(1200);
      console.log(`${vp} ${nome}: ${await evaluate(page, SONDA)}`);
      if (nome === "deck") {
        const marcos = (await axTree(page)).filter((n) => /main|navigation|contentinfo|banner|region/.test(n.role));
        console.log(`   marcos: ${marcos.map((m) => m.role + (m.name ? `"${m.name}"` : "")).join(", ") || "nenhum além do documento"}`);
      }
    }
  } finally { await devolver(user); page.close(); }
}
srv.stop();
process.exit(0);
