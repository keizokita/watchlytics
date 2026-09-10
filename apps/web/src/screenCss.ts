/**
 * CSS que as telas de conteúdo dividem — catálogo (D) e social (E).
 *
 * Estava só no Library.tsx, dentro do `<style>` do componente, e por isso não
 * existia quando a tela de amigos montava: mesmas classes, aparência de
 * formulário cru. Módulo em vez de arquivo .css porque é assim que o resto do
 * projeto carrega estilo de tela, e o index.html é do deck.
 *
 * ponytail: vira um .css importado pelo Vite quando alguém quiser cache
 * separado do bundle. Enquanto for uma string, não paga build extra.
 */
export const SCREEN_CSS = `
/* Porcentagem e não 92vw: o body já tem 1.25rem de padding de cada lado, e a
   unidade de viewport não sabe disso. Em 360px, 92vw dava 331px num espaço de
   320 — o container inteiro vazava 11px, e como html e body têm overflow-x
   clip, o que vazava sumia sem rolagem: a aba "Alerts" e o botão "Search"
   ficavam cortados e inalcançáveis. A porcentagem mede o que existe. */
.lib { width: min(40rem, 100%); display: grid; gap: 1rem; padding-bottom: 2rem; }
.lib-tabs { display: flex; gap: 0.5rem; }
.lib-tabs button {
  /* min-width 0 para o botão poder encolher abaixo do próprio texto quando os
     três dividem uma tela estreita. Não era a causa do corte (essa era o input
     da busca, em Friends.tsx), mas sem isto a fileira volta a vazar assim que
     um rótulo crescer. */
  flex: 1; min-width: 0;
  min-height: var(--tap); padding: 0.6rem 0.5rem; border-radius: var(--r-pill);
  border: 1px solid var(--line); background: var(--surface);
  color: var(--muted); font: inherit; font-weight: 600; cursor: pointer;
  /* depois do shorthand "font", que reseta o tamanho. Era o único controle-
     pílula do app em 16px; filtro, gênero e nota já são menores que isso. */
  font-size: 0.9rem;
}
.lib-tabs button[aria-selected="true"] { color: var(--fg); border-color: var(--fg); }
.lib-tabs button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }

/* Erro com ação: o texto e o "tentar de novo" empilham, centralizados. */
.lib .notice.error { display: grid; gap: 0.6rem; justify-items: center; }

.lib-locked { margin: 0; color: var(--muted); font-size: 0.9rem; }
.lib-hint { margin: 0; color: var(--muted); font-size: 0.85rem; }
.lib-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.lib-list li { border: 1px solid var(--line); border-radius: var(--r-panel);
  padding: 0.85rem 1rem; display: grid; gap: 0.6rem; }
.lib-item { display: grid; gap: 0.15rem; }
.lib-meta { color: var(--muted); font-size: 0.8rem; }
/* --tap, e não a altura que o padding der: 44px é o alvo mínimo que o resto
   do app já respeita (WCAG 2.5.8). Estas telas tinham ficado de fora, e este é
   o botão de mover, exportar, buscar, adicionar amigo e paginar. */
.lib-move { display: inline-flex; align-items: center; justify-content: center;
  min-height: var(--tap); padding: 0.45rem 0.9rem; border-radius: var(--r-pill);
  border: 1px solid var(--line); background: none; color: var(--fg);
  font: inherit; font-size: 0.85rem; cursor: pointer; }
.lib button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.lib h1 { margin: 0; font-size: 1.4rem; }
.lib h2 { margin: 0 0 0.5rem; font-size: 0.8rem; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); }
`;
