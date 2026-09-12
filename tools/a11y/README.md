# tools/a11y — a auditoria de acessibilidade, medida

Scripts que dirigem um Chrome headless por CDP e **medem** acessibilidade em vez
de olhar um print: árvore de acessibilidade, foco lido do DOM depois de um Tab
de verdade, e contraste lido no pixel que está por baixo de cada glifo.

Nasceram da auditoria que antecedeu o beta. Ficam aqui porque as conclusões
delas envelhecem: o contraste do card depende de onde o bloco de texto cai, e
isso muda com a tipografia; a ordem de Tab muda com qualquer botão novo.

Não substituem o `run-watchlytics` (`.claude/skills/run-watchlytics/driver.mjs`),
que é quem prova que o app funciona. Estes aqui só perguntam se ele é usável sem
mouse e sem enxergar.

## Rodar

Precisa de Postgres semeado, `apps/api/.env` e `google-chrome` — o mesmo setup
do `run-watchlytics`. Cada script sobe o que faltar (api e vite) e derruba no
fim.

```bash
node --env-file=apps/api/.env tools/a11y/foco.mjs                 # ordem de Tab no deck
node --env-file=apps/api/.env tools/a11y/foco.mjs '#/library'
node --env-file=apps/api/.env tools/a11y/contraste.mjs            # contraste no card
node --env-file=apps/api/.env tools/a11y/estouro.mjs              # estouro horizontal
node --env-file=apps/api/.env tools/a11y/acoes.mjs deck           # foco e anúncio por cena
```

Sobe em **3100 (api) e 5273 (vite)**, não nas 3000/5173 do `run-watchlytics`:
as duas ferramentas precisam poder rodar ao mesmo tempo, e numa máquina com mais
de um worktree as portas padrão costumam já estar ocupadas por outra sessão —
falar com a api errada não dá erro, dá uma medição que descreve outra branch.
`A11Y_API_PORT` e `A11Y_WEB_PORT` trocam as portas; o `API_ORIGIN` que o vite
lê sai daí sozinho.

| script | o que mede |
|---|---|
| `foco.mjs` | Ordem de Tab: cada parada com papel, nome, tamanho do alvo, `:focus-visible` e o outline que ela realmente pinta. Aceita `#/hash` e `--viewport LxA`. |
| `contraste.mjs` | Contraste real do texto, no pixel. `[tela] [seletor…] [--viewport LxA]`. |
| `estouro.mjs` | Estouro horizontal elemento a elemento, nas três telas e em quatro larguras. |
| `acoes.mjs` | O que acontece DEPOIS de uma ação: onde o foco fica e o que é anunciado. Cenas: `deck`, `erro`, `erro-swipe`, `porta`, `onboarding`, `library`, `friends`. |
| `biblioteca.mjs` | Biblioteca com itens de verdade: foco ao mover um item de aba, e a chegada de uma notificação. |
| `amigos.mjs` | Busca e pedido de amizade: o que é anunciado e onde o foco cai. |
| `movimento.mjs` | `prefers-reduced-motion` nos dois modos. |
| `nomes.mjs` | Papel e nome de nós específicos, como o leitor de tela os vê. |
| `layout.mjs` | Impressão digital da geometria — para comparar antes/depois de mexer no shell. |
| `posteres.mjs` | Põe pôster sintético (`branco`/`cinza`) ou tira (`limpar`) em todos os títulos. |
| `lib.mjs` | O encanamento: Chrome por CDP, servidores, sessão descartável, decoder de PNG. |

## O que custou caro descobrir

**A fixture não tem pôster.** `npm run seed` deixa `poster_url` nulo em 94 de 94
títulos (e `cast_names` vazio), então o card cai no forro `gradient(id)`, que é
escuro por construção. Medir contraste assim aprova por acidente: foi o que
escondeu o título do card em 2.36:1 sobre imagem clara. Por isso o
`posteres.mjs` — branco é o teto de claridade de um pôster, logo o pior caso
real.

**Medir o retângulo do texto não é medir o texto.** Duas fotos do mesmo
recorte, uma com o texto pintado e outra com `color: transparent`. Entram na
conta só os pixels que são núcleo de letra na primeira E mudaram entre as duas.
Sem a segunda prova entram a borda do botão (mesma cor do texto) e o texto de um
filho, que a regra não apaga — os dois aparecem como "1.00:1" e reprovam
controle que passa.

**`Input.dispatchKeyEvent` sem `text` não clica.** Enter e dígito chegam ao DOM
mas não geram `keypress`, e é o `keypress` que vira clique em `<button>`. A
auditoria quase reprovou o botão Like por causa disso.

**Tecla de verdade é o que liga `:focus-visible`.** `el.focus()` por script não
casa o seletor, e o outline medido sairia `none` num app que pinta foco direito.

**`--force-prefers-reduced-motion=0` não desliga nada.** Os dois modos saíam
iguais. Quem desliga é `Emulation.setEmulatedMedia` com `no-preference`.

**Texto em `role="status"` não entra no nome do elemento que o contém.** Medido
no badge de notificações: a mesma frase não serve de nome do link e de região
viva ao mesmo tempo.

**`document.scrollWidth` não denuncia estouro.** `html` e `body` têm
`overflow-x: clip`, que mata a barra e some com a prova junto. Quem denuncia é o
retângulo de cada elemento contra a largura da janela.
