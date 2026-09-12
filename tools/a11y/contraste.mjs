/**
 * Contraste medido no pixel, não estimado no papel.
 *
 * Para cada alvo: esconde só o GLIFO (color: transparent), fotografa o
 * retângulo que sobrou — pôster, degradê, pílula, o que estiver lá — e compara
 * cada pixel com a cor do texto. Screenshot com o texto por cima não serviria:
 * mediria o próprio texto.
 *
 * uso: node --env-file=apps/api/.env .a11y/contraste.mjs [tela] [seletor…]
 */
import {
  openChrome, servers, abrirSessao, devolver, evaluate, waitFor, sleep,
  shot, luminance, contrast, parseColor, WEB,
} from "./lib.mjs";

const tela = process.argv[2] ?? "";
const iv = process.argv.indexOf("--viewport");
const vp = iv === -1 ? "430x932" : process.argv[iv + 1];
const alvos = process.argv.slice(3).filter((a, i, arr) => a !== "--viewport" && arr[i - 1] !== "--viewport");

const PADRAO = [
  ".deck .deck-card:last-child .card-title",
  ".deck .deck-card:last-child .card-original",
  ".deck .deck-card:last-child .card-meta",
  ".deck .deck-card:last-child .card-overview",
  ".deck .deck-card:last-child .card-cast",
  ".deck .deck-card:last-child .card-kind",
  ".deck .deck-card:last-child .card-score",
  ".shell nav a",
  ".consent",
  ".attribution a",
  ".notice-hint",
];

const seletores = alvos.length ? alvos : PADRAO;

/**
 * Contraste só onde há GLIFO.
 *
 * Duas fotos do mesmo retângulo: uma com o texto pintado, outra com
 * `color: transparent`. O pixel que é núcleo de letra na primeira (cor do
 * texto, cheia) dá a posição; a segunda diz o que está POR BAIXO dele. Sem
 * isso a medição pega canto de pílula e entrelinha — fundo que letra nenhuma
 * ocupa — e reprova controle que passa.
 */
async function medir(page, sel) {
  const info = await evaluate(
    page,
    `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height,
               cor: cs.color, tamanho: parseFloat(cs.fontSize), peso: cs.fontWeight,
               texto: (el.innerText||'').replace(/\\s+/g,' ').slice(0, 30) };
    })()`,
  );
  if (!info) return null;

  const clip = {
    x: Math.round(info.x),
    y: Math.round(info.y),
    width: Math.max(1, Math.round(info.w)),
    height: Math.max(1, Math.round(info.h)),
  };
  const comTexto = await shot(page, clip);
  await evaluate(page, `document.querySelector(${JSON.stringify(sel)}).style.color = 'transparent'`);
  await sleep(120);
  const semTexto = await shot(page, clip);
  await evaluate(page, `document.querySelector(${JSON.stringify(sel)}).style.color = ''`);

  const { r, g, b } = parseColor(info.cor);
  const lt = luminance(r, g, b);
  const razoes = [];
  for (let i = 0; i < comTexto.px.length; i += 4) {
    const dr = Math.abs(comTexto.px[i] - r);
    const dg = Math.abs(comTexto.px[i + 1] - g);
    const db = Math.abs(comTexto.px[i + 2] - b);
    // núcleo de letra: cor cheia do texto, não meio-tom de borda…
    if (dr > 10 || dg > 10 || db > 10) continue;
    // …e que SUMIU quando o glifo ficou transparente. Sem esta segunda prova
    // entram no cálculo a borda do botão (que é da mesma cor do texto) e o
    // texto de um filho, que a regra não apaga — os dois apareceriam como
    // "contraste 1.00:1" e reprovariam controle que passa.
    const mudou =
      Math.abs(comTexto.px[i] - semTexto.px[i]) > 12 ||
      Math.abs(comTexto.px[i + 1] - semTexto.px[i + 1]) > 12 ||
      Math.abs(comTexto.px[i + 2] - semTexto.px[i + 2]) > 12;
    if (!mudou) continue;
    razoes.push(
      contrast(lt, luminance(semTexto.px[i], semTexto.px[i + 1], semTexto.px[i + 2])),
    );
  }
  if (razoes.length === 0) return { ...info, semGlifo: true };
  razoes.sort((a, b) => a - b);
  const p = (q) => razoes[Math.floor(q * (razoes.length - 1))];
  const grande = info.tamanho >= 24 || (info.tamanho >= 18.66 && Number(info.peso) >= 700);
  const piso = grande ? 3 : 4.5;
  const abaixo = razoes.filter((x) => x < piso).length / razoes.length;
  return { ...info, min: p(0), p05: p(0.05), mediana: p(0.5), piso, abaixo, grande, n: razoes.length };
}

const srv = await servers();
const page = await openChrome({ viewport: vp, scale: 1 });
let user;
try {
  user = await abrirSessao(page);
  await page.cmd("Page.navigate", { url: `${WEB}/${tela}` });
  await waitFor(page, tela ? ".lib" : ".deck-card", 40_000);
  await sleep(1500);

  console.log(`tela ${tela || "#/ (deck)"} ${vp} — contraste medido no pixel de fundo\n`);
  for (const sel of seletores) {
    const m = await medir(page, sel);
    if (!m) {
      console.log(`${sel}\n  (ausente nesta tela)`);
      continue;
    }
    if (m.semGlifo) {
      console.log(`${sel}\n  (nenhum pixel de glifo — texto vazio?)`);
      continue;
    }
    const veredito = m.abaixo === 0 ? "PASSA" : m.abaixo > 0.02 ? "REPROVA" : "limítrofe";
    console.log(
      `${sel}  "${m.texto}"\n` +
        `  ${m.tamanho}px ${m.peso} cor ${m.cor} piso ${m.piso}:1 → ${veredito}\n` +
        `  pior ${m.min.toFixed(2)}:1 · p5 ${m.p05.toFixed(2)}:1 · mediana ${m.mediana.toFixed(2)}:1 · ` +
        `${(m.abaixo * 100).toFixed(1)}% dos ${m.n} pixels de glifo abaixo do piso`,
    );
  }
} finally {
  await devolver(user);
  page.close();
  srv.stop();
}
process.exit(0);
