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
.lib { width: min(40rem, 92vw); display: grid; gap: 1rem; padding-bottom: 2rem; }
.lib-tabs { display: flex; gap: 0.5rem; }
.lib-tabs button {
  flex: 1; padding: 0.6rem 0.5rem; border-radius: 999px;
  border: 1px solid rgb(255 255 255 / 0.18); background: rgb(255 255 255 / 0.06);
  color: var(--muted); font: inherit; font-weight: 600; cursor: pointer;
}
.lib-tabs button[aria-selected="true"] { color: var(--fg); border-color: var(--fg); }
.lib-tabs button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }

.lib-locked { margin: 0; color: var(--muted); font-size: 0.9rem; }
.lib-hint { margin: 0; color: var(--muted); font-size: 0.85rem; }
.lib-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.lib-list li { border: 1px solid rgb(255 255 255 / 0.12); border-radius: 14px;
  padding: 0.85rem 1rem; display: grid; gap: 0.6rem; }
.lib-item { display: grid; gap: 0.15rem; }
.lib-meta { color: var(--muted); font-size: 0.8rem; }
.lib-move { padding: 0.45rem 0.9rem; border-radius: 999px;
  border: 1px solid rgb(255 255 255 / 0.18); background: none; color: var(--fg);
  font: inherit; font-size: 0.85rem; cursor: pointer; }
.lib button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.lib h1 { margin: 0; font-size: 1.4rem; }
.lib h2 { margin: 0 0 0.5rem; font-size: 0.8rem; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); }
`;
