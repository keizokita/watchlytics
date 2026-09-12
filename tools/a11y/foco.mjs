/**
 * Caminhada de teclado: Tab de verdade, foco lido do DOM a cada parada.
 * uso: node --env-file=apps/api/.env .a11y/foco.mjs [#/hash] [--viewport LxA]
 */
import { openChrome, servers, abrirSessao, devolver, evaluate, waitFor, tab, sleep, WEB, DESCREVE } from "./lib.mjs";

const hash = process.argv[2]?.startsWith("#") ? process.argv[2] : "";
const vp = process.argv.includes("--viewport")
  ? process.argv[process.argv.indexOf("--viewport") + 1]
  : "430x932";
const espera = process.argv.includes("--wait")
  ? process.argv[process.argv.indexOf("--wait") + 1]
  : ".shell";


const FOCALIZAVEIS = `[...document.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,[tabindex]:not([tabindex="-1"])')]
  .map(el => (el.getAttribute('aria-label') || el.innerText || el.value || el.tagName).replace(/\\s+/g,' ').trim().slice(0,40))`;

export async function caminhada(page, max = 30) {
  const paradas = [];
  for (let i = 0; i < max; i++) {
    await tab(page);
    const d = await evaluate(page, DESCREVE);
    paradas.push(d);
    if (paradas.length > 1 && d.tag === "BODY") break;
  }
  return paradas;
}

const srv = await servers();
const page = await openChrome({ viewport: vp });
let user;
try {
  user = await abrirSessao(page);
  await page.cmd("Page.navigate", { url: WEB + "/" + hash });
  await waitFor(page, espera);
  await sleep(1200);

  const focalizaveis = await evaluate(page, FOCALIZAVEIS);
  console.log(`tela: ${hash || "#/ (deck)"}  viewport ${vp}`);
  console.log(`focalizáveis no DOM (${focalizaveis.length}): ${focalizaveis.join(" | ")}\n`);

  const paradas = await caminhada(page);
  for (const [i, d] of paradas.entries()) {
    if (d.tag === "BODY") {
      console.log(`${String(i + 1).padStart(2)}. ⟲ voltou para o documento (fim do ciclo)`);
      continue;
    }
    const alvo = d.w >= 44 && d.h >= 44 ? "44✓" : `${d.w}x${d.h}✗`;
    console.log(
      `${String(i + 1).padStart(2)}. ${d.tag}${d.role ? `[${d.role}]` : ""} "${d.text}"` +
        `  alvo ${alvo}  fv:${d.fv ? "sim" : "NÃO"}  outline:${d.outline}` +
        `  ${d.inView ? "" : "FORA DA VIEWPORT "}` +
        `(${d.x},${d.y} ${d.w}x${d.h})`,
    );
  }
  const erros = page.errors.filter((e) => !/favicon/i.test(e));
  if (erros.length) console.log("\nconsole:", erros.join(" | "));
} finally {
  await devolver(user);
  page.close();
  srv.stop();
}
process.exit(0);
