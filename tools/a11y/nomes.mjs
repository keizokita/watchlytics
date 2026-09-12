/**
 * Nome e papel de nós específicos, como o leitor de tela os vê.
 * uso: node --env-file=apps/api/.env .a11y/nomes.mjs <tela> <seletor> [seletor…]
 */
import { openChrome, servers, abrirSessao, devolver, waitFor, axOf, sleep, WEB } from "./lib.mjs";

const tela = process.argv[2] ?? "";
const seletores = process.argv.slice(3);

const srv = await servers();
const page = await openChrome({ viewport: "430x932" });
let user;
try {
  user = await abrirSessao(page);
  await page.cmd("Page.navigate", { url: `${WEB}/${tela}` });
  await waitFor(page, seletores[0], 40_000);
  await sleep(1200);

  for (const sel of seletores) {
    const nos = await axOf(page, sel);
    console.log(`\n${sel}`);
    if (!nos) {
      console.log("  (não existe na tela)");
      continue;
    }
    for (const n of nos) {
      console.log(`  ${n.ignored ? "IGNORADO " : ""}${n.role} "${n.name}" ${n.props}`);
    }
  }
} finally {
  await devolver(user);
  page.close();
  srv.stop();
}
process.exit(0);
