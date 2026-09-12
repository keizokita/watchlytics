import { useEffect, useRef, type ReactNode } from "react";

/**
 * O painel de falha, do jeito que um leitor de tela e um teclado precisam.
 *
 * `role="alert"` porque nada mais avisava. Medido na auditoria: com o feed
 * caindo no meio de uma sessão de teclado, o deck era trocado por um painel
 * vermelho e a página ficava sem nenhuma região viva — quem não vê a tela não
 * ficava sabendo que a decisão não entrou, e continuava apertando a seta.
 *
 * `foco` é para o caso em que o painel nasce NO LUGAR do que tinha o foco: o
 * botão Like desmonta junto com o deck, e o foco volta para o começo do
 * documento (medido: `document.activeElement` vira o body). Onde o painel só se
 * soma à tela — erro da biblioteca, erro dos amigos — não se rouba o foco de
 * quem estava no meio de outra coisa: ali o `role="alert"` já faz o trabalho.
 *
 * `tabIndex={-1}` deixa o painel receber foco por código sem entrar na ordem
 * de Tab.
 */
export function Alerta({
  className,
  foco = false,
  children,
}: {
  className?: string;
  foco?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (foco) ref.current?.focus();
  }, [foco]);

  return (
    <div ref={ref} role="alert" tabIndex={-1} className={className}>
      {children}
    </div>
  );
}
