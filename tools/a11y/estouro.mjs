/**
 * Estouro horizontal medido ELEMENTO A ELEMENTO.
 *
 * `document.scrollWidth` não serve: html e body têm `overflow-x: clip`, que
 * mata a barra de rolagem e some com a prova junto. Quem denuncia é o retângulo
 * de cada elemento contra a largura da janela.
 */
import { openChrome, servers, abrirSessao, devolver, evaluate, waitFor, sleep, WEB } from "./lib.mjs";

const telas = [
  ["#/ (deck)", "", ".deck-card"],
  ["#/library", "#/library", ".lib"],
  ["#/friends", "#/friends", ".lib"],
];
const viewports = process.argv.slice(2).length ? process.argv.slice(2) : ["320x568", "360x640", "430x932", "1280x800"];

const SONDA = `(() => {
  const w = document.documentElement.clientWidth;
  const fora = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > w + 0.5 || r.left < -0.5) {
      fora.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 30),
                  left: Math.round(r.left), right: Math.round(r.right),
                  texto: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 28) });
    }
  }
  return { w, scrollW: document.documentElement.scrollWidth,
           scrollH: document.documentElement.scrollHeight,
           clientH: document.documentElement.clientHeight, fora: fora.slice(0, 8) };
})()`;

const srv = await servers();
for (const vp of viewports) {
  const page = await openChrome({ viewport: vp });
  let user;
  try {
    user = await abrirSessao(page);
    for (const [nome, hash, espera] of telas) {
      await page.cmd("Page.navigate", { url: `${WEB}/${hash}` });
      await waitFor(page, espera, 40_000);
      await sleep(1200);
      const r = await evaluate(page, SONDA);
      const rola = r.scrollH > r.clientH ? `rola ${r.scrollH - r.clientH}px na vertical` : "sem rolagem vertical";
      console.log(`${vp} ${nome}: ${r.fora.length ? "ESTOURA" : "cabe"} · ${rola}`);
      for (const f of r.fora) {
        console.log(`   ${f.tag}.${f.cls} ${f.left}..${f.right} (janela ${r.w}) "${f.texto}"`);
      }
    }
  } finally {
    await devolver(user);
    page.close();
  }
}
srv.stop();
process.exit(0);
