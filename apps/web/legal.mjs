import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

/**
 * Os documentos legais servidos pelo PRÓPRIO domínio do app.
 *
 * Antes eram links para o blob do GitHub, e isso tinha duas falhas. A primeira
 * é operacional: repositório privado ou renomeado leva junto a política que o
 * aviso de consentimento promete. A segunda trava o beta — a tela de
 * consentimento do Google, para sair do modo Testing, exige o link da política
 * num `Authorized domain` verificado no Search Console, e `github.com` não é um
 * domínio que a gente possa verificar.
 *
 * Gera em `public/legal/` e não direto em `dist/`: assim o `vite dev` serve as
 * mesmas páginas que a produção, pelo mesmo caminho, sem plugin nenhum.
 *
 * ponytail: `marked` em vez de escrever o conversor. Markdown parece fácil até
 * a primeira tabela — e a política tem quatro. É devDependency: roda no build,
 * não vai para o bundle.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const ENTRADA = join(AQUI, "../../docs/legal");
const SAIDA = join(AQUI, "public/legal");

/**
 * CSS embutido, não importado: são duas páginas estáticas que ninguém navega a
 * partir do app, e um arquivo a mais seria um request a mais para servir texto.
 *
 * `color-scheme` sozinho já entrega o modo escuro do navegador sem media query.
 */
const PAGINA = (titulo, corpo) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto; padding: 2rem 1.25rem 6rem; max-width: 46rem;
    font: 16px/1.65 system-ui, sans-serif;
  }
  h1 { line-height: 1.2; }
  h2 { margin-top: 2.5rem; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid currentColor; padding: .4rem .6rem; text-align: left; }
  code { font-size: .9em; }
  blockquote {
    margin: 1.5rem 0; padding-left: 1rem; border-left: 3px solid currentColor;
    opacity: .8;
  }
  .voltar { display: inline-block; margin-bottom: 2rem; }
</style>
</head>
<body>
<a class="voltar" href="/">← Watchlytics</a>
${corpo}</body>
</html>
`;

await mkdir(SAIDA, { recursive: true });

const arquivos = (await readdir(ENTRADA)).filter((f) => f.endsWith(".md"));
if (arquivos.length === 0) throw new Error(`nenhum .md em ${ENTRADA}`);

for (const arquivo of arquivos) {
  const md = await readFile(join(ENTRADA, arquivo), "utf8");
  const corpo = await marked.parse(md);

  // A checagem que faz este script valer o arquivo: markdown que não virou
  // HTML sai como parágrafo único, e uma política ilegível passaria despercebida
  // até alguém abrir a página — provavelmente o revisor do Google.
  if (!corpo.includes("<h1")) {
    throw new Error(`${arquivo} não gerou título: o documento perdeu a estrutura`);
  }

  // O `<title>` é o h1 do documento inteiro ("Watchlytics — Privacy Policy"):
  // é o que o revisor do Google vê na aba, e já nomeia app e documento.
  const titulo = /^#\s+(.+)$/m.exec(md)?.[1] ?? "Watchlytics — Legal";
  const destino = join(SAIDA, arquivo.replace(/\.md$/, ".html"));
  await writeFile(destino, PAGINA(titulo, corpo));
  console.log(`legal: ${arquivo} → public/legal/${arquivo.replace(/\.md$/, ".html")}`);
}
