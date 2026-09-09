import type { Title } from "@watchlytics/contract";

/**
 * O fundo do card, em duas camadas.
 *
 * Módulo próprio e não dentro do Card.tsx: são funções puras, e o teste da
 * suíte roda com `node --test src/*.test.ts` — importar um .tsx de lá traria
 * JSX, que o type stripping do Node não sabe apagar.
 */

/**
 * Pôster determinístico a partir do id.
 *
 * Nasceu como substituto do pôster enquanto não havia fornecedor de catálogo.
 * Com o TMDB ele mudou de papel: virou o forro que aparece antes de a imagem
 * chegar, e o que sobra se ela nunca chegar.
 */
export function gradient(id: string): string {
  const h = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `linear-gradient(160deg, hsl(${h} 52% 30%), hsl(${(h + 45) % 360} 58% 12%))`;
}

/**
 * B4 — pôster na frente, gradiente do id ATRÁS.
 *
 * Duas camadas, e não uma escolha entre as duas. Escolhendo, o card ficava
 * PRETO enquanto a imagem não chegava — e para sempre se ela falhasse —, com o
 * título por cima e o `--muted` sem contraste nenhum. Enquanto o catálogo era a
 * fixture isso não aparecia, porque `posterUrl` era sempre nulo; com o TMDB ele
 * quase nunca é, e o caminho sem fundo virou o caminho normal.
 *
 * A url vai entre aspas E com a aspa escapada: sem as aspas, um parêntese no
 * caminho quebra a declaração; com elas mas sem o escape, uma aspa no caminho
 * fecha a string mais cedo e faz a mesma coisa. Nos dois casos o que se perde é
 * a declaração inteira — o forro junto com o pôster, que é exatamente o card
 * preto que esta função existe para impedir. `%22` porque uma aspa literal em
 * URL é para vir percent-encoded de qualquer forma.
 */
export function cardBackground(item: Title): string {
  const fundo = gradient(item.id);
  if (!item.posterUrl) return fundo;
  return `center / cover url("${item.posterUrl.replaceAll('"', "%22")}"), ${fundo}`;
}
