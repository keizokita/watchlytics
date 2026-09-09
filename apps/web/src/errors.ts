import { t } from "./strings.ts";

/**
 * O que a pessoa lê quando algo falha.
 *
 * Existe porque todo `catch` da web fazia `e instanceof Error ? e.message :
 * String(e)` e mandava o resultado direto para a tela. A UI é em inglês e as
 * mensagens do código são português técnico ("feed respondeu 500", "accept
 * respondeu 403") — quando não são o JSON inteiro de um ZodError, que é o que
 * `parse()` joga quando o contrato não bate. Nada disso diz à pessoa o que
 * fazer, e o nome da rota é informação de quem escreveu o código.
 *
 * O detalhe não some, muda de dono: vai para o console, que é onde quem
 * depura procura.
 *
 * ponytail: dois casos, não uma taxonomia de erro. Offline e "deu errado" são
 * as duas situações em que a pessoa pode fazer coisas DIFERENTES; separar 500
 * de 400 na tela não muda a ação dela. Vira mais casos quando existir um erro
 * que peça uma terceira ação.
 */
export function mensagem(e: unknown): string {
  console.error(e);
  return navigator.onLine ? t.errorGeneric : t.errorOffline;
}
