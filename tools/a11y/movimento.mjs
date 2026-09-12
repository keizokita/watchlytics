/** prefers-reduced-motion: o que muda de verdade no DOM, nos dois modos. */
import { openChrome, servers, abrirSessao, devolver, evaluate, waitFor, sleep, WEB } from "./lib.mjs";

const SONDA = `(() => {
  const top = document.querySelector('.deck .deck-card:last-child');
  const badge = document.querySelector('.badge-like');
  const fantasma = getComputedStyle(document.body);
  return JSON.stringify({
    reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    cardTransition: getComputedStyle(top).transition,
    cardInline: top.style.transition,
    badgeTransform: getComputedStyle(badge).transform,
    botaoTransition: getComputedStyle(document.querySelector('.actions button')).transitionDuration,
  });
})()`;

const srv = await servers();
for (const reduce of [true, false]) {
  const page = await openChrome({ viewport: "430x932", reduce });
  let user;
  try {
    user = await abrirSessao(page);
    await page.cmd("Page.navigate", { url: WEB + "/" });
    await waitFor(page, ".deck-card", 40_000);
    await sleep(1000);
    console.log(`reduce=${reduce}: ${await evaluate(page, SONDA)}`);
  } finally { await devolver(user); page.close(); }
}
srv.stop();
process.exit(0);
