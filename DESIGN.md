---
name: Watchlytics
description: Uma sala escura onde só o título está iluminado — descoberta por swipe em quase-preto, com duas cores e nenhuma decoração.
colors:
  ink: "#0e0f13"
  paper: "#f2f3f7"
  muted: "#9aa0ad"
  affirm: "#35c98b"
  refuse: "#e8636f"
  affirm-ink: "#06231a"
  surface: "rgb(255 255 255 / 0.06)"
  surface-hi: "rgb(255 255 255 / 0.12)"
  line: "rgb(255 255 255 / 0.16)"
typography:
  display:
    fontFamily: "system-ui, sans-serif"
    fontSize: "clamp(1.05rem, 7.6cqi, 1.7rem)"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "clamp(1.15rem, 5vw, 1.5rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.1rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
  meta:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  pill: "999px"
  card: "22px"
  panel: "14px"
  badge: "12px"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.25rem"
  xl: "2rem"
  tap: "2.75rem"
components:
  button-like:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.affirm}"
    rounded: "{rounded.pill}"
    padding: "0 1.2rem"
    height: "{spacing.tap}"
    width: "6.5rem"
  button-pass:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.refuse}"
    rounded: "{rounded.pill}"
    padding: "0 1.2rem"
    height: "{spacing.tap}"
    width: "6.5rem"
  button-undo:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0 0.9rem"
    height: "{spacing.tap}"
  button-commit:
    backgroundColor: "color-mix(in srgb, #35c98b 16%, transparent)"
    textColor: "{colors.affirm}"
    rounded: "{rounded.pill}"
    padding: "0 1.6rem"
    height: "{spacing.tap}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.refuse}"
    rounded: "{rounded.pill}"
    padding: "0.45rem 0.9rem"
    typography: "{typography.body}"
  chip-genre:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "0 0.9rem"
    height: "{spacing.tap}"
  chip-genre-selected:
    backgroundColor: "color-mix(in srgb, #35c98b 12%, transparent)"
    textColor: "{colors.affirm}"
    rounded: "{rounded.pill}"
    padding: "0 0.9rem"
    height: "{spacing.tap}"
  chip-card-meta:
    backgroundColor: "rgb(0 0 0 / 0.5)"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "0.3em 0.65em"
  input-filter:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "0 0.85rem"
    height: "{spacing.tap}"
  nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0.4rem 0.9rem"
  nav-link-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "0.4rem 0.9rem"
  badge-count:
    backgroundColor: "{colors.affirm}"
    textColor: "{colors.affirm-ink}"
    rounded: "{rounded.pill}"
    padding: "0 0.3rem"
    height: "1.15rem"
    width: "1.15rem"
---

# Design System: Watchlytics

## Overview

**Creative North Star: "A Sala Escura"**

A luz está apagada de propósito. O fundo é quase-preto (`#0e0f13`), as superfícies
são vidro a 6% de branco, e o texto secundário fica num cinza que existe para ser
lido sem ser visto. Nada disso é economia de esforço: é o que faz o card do topo
ser a única coisa iluminada da tela. O sistema investe toda a sua energia visual
num objeto só — o título que está sendo decidido — e recua em todo o resto.

Daí vem a regra de profundidade. O card do deck é o único elemento com sombra
real; painéis, listas e controles são planos, separados por um fio de 1px
translúcido e por camada tonal. Numa sala escura, um objeto com sombra é um
objeto sob um foco — se tudo tem sombra, nada está iluminado.

O gesto é emprestado do baralho, não do app de namoro: rotação proporcional ao
deslocamento, disparo por distância **ou** velocidade, carimbo que cresce
conforme a decisão se forma. Mas o produto não é o gesto — é a decisão. Por isso
o par verde/vermelho carrega semântica em todo o sistema, e não apenas no deck,
enquanto nenhuma terceira cor entra.

**Key Characteristics:**

- Escuro por declaração, não por preferência: `color-scheme: dark` fixo, sem tema claro.
- Duas cores no mundo inteiro — afirmação e recusa. O resto é neutro.
- Uma única sombra, e ela pertence ao card.
- Tudo é pílula; o card é a única exceção de forma.
- A tipografia escala pelo container, não pela viewport — o card encolhe e o texto acompanha.
- Nenhuma imagem, nenhum ícone, nenhum asset: a cor do pôster é derivada do `id`.

## Colors

Uma paleta de dois gestos sobre um neutro frio: tudo que não é decisão é cinza-azulado.

### Primary

- **Verde Afirmação** (`#35c98b`): o "sim" do sistema, em qualquer contexto —
  curtir no deck, gênero selecionado no onboarding, o botão que fecha o
  onboarding, e o badge que diz que algo novo chegou. É a única cor que aparece
  em elemento não-destrutivo.

### Secondary

- **Vermelho Recusa** (`#e8636f`): o "não" — passar no deck, erro de tela e a
  única ação destrutiva da conta. Foi clareado de `#e0525f` porque, como texto
  sobre `surface` sobre `ink`, o valor antigo dava 4,44:1 e reprovava AA por um
  triz; aqui dá 5,2:1 e a mesma cor ainda serve de traço.

### Neutral

- **Quase-Preto Frio** (`#0e0f13`): o fundo, e a razão do sistema funcionar. Não
  é preto puro — tem hue azul, o que evita o card gradiente parecer descolado.
- **Papel Frio** (`#f2f3f7`): texto primário, foco visível, e o estado ativo de
  qualquer controle. Nunca branco puro.
- **Cinza de Serviço** (`#9aa0ad`): metadado, dica, rótulo de seção, link de nav
  inativo. É o cinza que fecha AA sobre o fundo e nada além disso — e "o fundo"
  é literal: **dentro do card do deck ele não entra**, porque lá o fundo é
  fotografia. Medido no pôster do Frozen II, ele dá 3,14:1 contra a imagem, e o
  Papel Frio dá 7,44:1 no mesmo pixel.
- **Vidro** (`rgb(255 255 255 / 0.06)`), **Vidro Alto** (`0.12`) e
  **Fio** (`0.16`): não são três cinzas, são um só material em três
  intensidades — superfície em repouso, superfície em hover, e o traço que
  separa. Todo controle do sistema é feito desses três.
- **Verde-Tinta** (`#06231a`): existe para uma coisa só — texto sobre o badge
  verde. Branco sobre `#35c98b` dá ~2:1, e o badge é justamente o que precisa
  ser lido de relance.

### Named Rules

**A Regra das Duas Cores.** O sistema tem exatamente duas cores cromáticas, e
elas significam sim e não. Uma tela nova não ganha um azul de informação, um
âmbar de aviso nem um roxo de marca. Se um elemento precisa de cor, primeiro
pergunte se ele é uma afirmação ou uma recusa; se não for nenhuma das duas, ele
é neutro.

**A Regra do Verde Semântico.** Verde não é a cor da marca — é a cor do "sim".
Por isso ele pinta o chip de gênero selecionado e o badge de notificação sem
contradição: selecionar é afirmar, e "chegou algo" é uma afirmação. O que ele
nunca faz é decorar: um cabeçalho verde ou uma borda verde ornamental quebra a
regra.

**A Regra do Contraste Verificado.** Toda cor de texto do sistema tem uma razão
de contraste conferida contra a superfície em que de fato aparece — não contra o
fundo da página. `--pass` foi clareado exatamente por essa conta. Uma cor nova
entra com o número medido, ou não entra.

**A Regra da Foto Sem Teto.** Dentro do card, todo texto é Papel Frio. O degradê
de duas pontas foi calibrado contra `gradient(id)`, que tem claridade limitada
por construção (`hsl` a 30% e 12% de lightness); uma fotografia não tem esse
teto, e nenhum degradê que ainda deixe ver o pôster garante contraste contra ela.
A defesa é a cor do texto, não a do fundo.

## Typography

**Display Font:** *a definir* — o sistema está comprometido a ganhar uma família
própria para título de card e cabeçalhos; hoje ela ainda é `system-ui`.
**Body Font:** `system-ui, sans-serif` — e fica. Corpo, controle e metadado
continuam na fonte do sistema operacional de quem usa: sem webfont no caminho
crítico, sem FOUT, e o app nativo da fase 4 herda de graça.
**Label/Mono Font:** nenhuma distinta. Números usam `font-variant-numeric:
tabular-nums` na nota do card, não uma família mono.

**Character:** hoje o caráter não vem da família — vem do peso, do tracking
negativo (`-0.015em`) nos títulos e do fato de o texto do card escalar por
*container query* em vez de viewport. A display própria, quando entrar, deve
somar personalidade a esse esqueleto, não substituí-lo.

### Hierarchy

- **Display** (700, `clamp(1.05rem, 7.6cqi, 1.7rem)`, 1.12): o título do card, e
  só ele. A unidade `cqi` é a decisão que importa — o tamanho responde à largura
  do card, não da janela.
- **Headline** (700, `clamp(1.15rem, 5vw, 1.5rem)`, `-0.015em`): o `h1` de tela.
  O valor normativo é o do onboarding, o único que carrega o tracking negativo
  do sistema. **Duas telas divergem hoje** e devem convergir para cá: a home
  deslogada usa `1.6rem`/1.2 fixo (`main.tsx`) e biblioteca/amigos usam `1.4rem`
  fixo (`screenCss.ts`) — três tamanhos para o mesmo papel, nenhum tokenizado.
- **Title** (600, `1.1rem`): o valor de uma estatística. É o único lugar onde um
  número é grande.
- **Body** (400, `1rem`, 1.5): texto corrido, sinopse, controle. Sinopse é
  cortada em 3 linhas fixas por `line-clamp`, não deixada vazar.
- **Label** (700, `0.8rem`, `+0.08em`, caixa alta, em Cinza de Serviço): rótulo
  de seção (`h2`). Caixa alta com tracking positivo é o único tratamento
  tipográfico "de sistema" que existe aqui. Duas variantes próximas convivem com
  ele por bons motivos: o contador do onboarding (`0.85rem`, `+0.06em`) e o chip
  de tipo do card (`clamp(0.6rem, 3.4cqi, 0.75rem)`, `+0.09em`), que escala por
  container como todo o resto do card.
- **Meta** (400, `0.85rem` nominal, em Cinza de Serviço **fora do card**): ano,
  gêneros, título original, dica sob um controle, rótulo de estatística. O degrau
  que define este papel é o de **cor**, não o de tamanho — e é por isso que o
  tamanho derivou: existem hoje quatro valores em uso (`0.75`, `0.8`, `0.85`,
  `0.9rem`) para o mesmo papel, escolhidos caso a caso. `0.85rem` é o nominal;
  texto novo de metadado usa ele, e os outros três convergem quando alguém
  passar por eles.

### Named Rules

**A Regra do Container.** Dentro do card, tipografia mede-se em `cqi`, nunca em
`vw`. O deck encolhe quando a tela é baixa (`--deck-w` é limitado pela altura
disponível), e tipo preso à viewport transbordaria exatamente aí.

**A Regra da Altura Fixa.** O rodapé do card fica na mesma altura de um título
para o outro — sinopse com clamp de 3 linhas, metadado em uma linha só com
reticências. Sem isso a pilha pulsa a cada swipe, e o pulso lê como defeito.

## Layout

Não há grid nem breakpoints. O sistema é uma coluna única, centrada na
horizontal, e todo o responsivo é resolvido por `clamp()`, `min()`, `max()` e
`flex-wrap` — a única media query de layout do projeto é
`prefers-reduced-motion`.

Na vertical o shell é um **app shell**: nav no topo, atribuição no rodapé, e o
conteúdo entre os dois. Quem distribui a folga de uma janela alta são duas
margens `auto` — uma na atribuição, que sempre existe, e outra nos `.filters`,
que só o deck tem. Com as duas, a folga se divide igualmente e o grupo
filtros + deck + botões fica centrado; com só a primeira, toda a folga vai para
o rodapé e o conteúdo fica no topo.

**A medida que governa tudo** é `--deck-w`:

```
min(22rem, 88vw, max(11rem, calc((100dvh - var(--deck-reserve)) * 2 / 3)))
```

Ela limita a largura do card pelo que sobra de **altura** depois da nav, dos
filtros, dos botões e das folgas (`--deck-reserve: 19.5rem`). É por isso que em
tela baixa o deck encolhe em vez de vazar, e é a mesma medida que o fantasma de
carregamento e o painel de vazio usam — duas fórmulas iguais divergem.

Existem duas larguras-limiar implícitas, ambas por `flex-wrap`, não por media
query: os filtros cabem em uma linha até `37rem`, e quebram em duas de `360px`
para cima — o caso previsto na reserva de `19.5rem`.

**Ritmo:** `0.5 / 0.75 / 1 / 1.25 / 2rem` como gaps de grid; `2.75rem` (`--tap`)
como altura mínima de qualquer coisa clicável, por WCAG 2.5.8.

### Named Rules

**A Regra da Reserva.** Qualquer coisa nova que ocupe altura permanente acima ou
abaixo do deck entra em `--deck-reserve`. A reserva é fixa porque CSS não mede
quantas linhas os filtros ocuparam; esquecer de somar não quebra nada visível —
só corta o deck em telas baixas.

**A Regra da Chrome Parada.** Nav e atribuição não se movem entre telas. Uma
tela curta empurra a folga para o rodapé, nunca para cima da nav — antes disso
a nav aparecia a ~120px na Library e a ~550px em Friends vazia, e a mesma
chrome mudando de lugar lê como tela diferente, não como tela vazia.

**A Regra do Clip no Eixo X.** `html, body { overflow-x: clip }`. O card voa para
±1,4× a largura da tela e, mesmo absoluto, contaria para a área de rolagem. O
eixo Y fica rolável **de propósito**: sem ele, em tela baixa os botões de
decisão — o caminho não-gestual exigido pela acessibilidade — ficariam
inalcançáveis.

## Elevation & Depth

O sistema é **plano, com uma única exceção deliberada**. O card do deck é o
único elemento com `box-shadow`; painéis, listas, controles e a nav são planos e
se separam por camada tonal (`--surface`) mais um fio de 1px (`--line`).

O card carrega duas coisas ao mesmo tempo: uma sombra baixa e espalhada, que o
levanta do fundo, e um **fio de luz interno** de 1px, que existe porque card
escuro sobre fundo escuro perde o recorte sem ele. Os dois cards de trás recebem
`brightness(0.55) saturate(0.45)` — apagados, viram sombra, e o olho vai para o
topo da pilha. Antes disso, cada um sorteava o próprio hue e a faixa que sobrava
lia como defeito de renderização, não como pilha.

### Shadow Vocabulary

- **Foco do deck** (`0 18px 45px -12px rgb(0 0 0 / 0.75)` + `inset 0 0 0 1px rgb(255 255 255 / 0.09)`): o card do topo, e nada mais.
- **Recuo do deck** (`0 10px 30px -14px rgb(0 0 0 / 0.6)`): os dois cards de trás, junto com o escurecimento.

### Named Rules

**A Regra do Foco Único.** Sombra é privilégio do card do deck. Uma tela nova não
ganha `box-shadow` — ganha `--surface` e `--line`. Se dois elementos têm sombra
na mesma tela, nenhum dos dois está em foco.

## Shapes

Duas formas, e a fronteira entre elas é semântica.

**Pílula** (`999px`) é a forma de tudo que se opera: botão, chip de gênero, chip
do card, campo de filtro, link de nav, badge. Não há botão retangular no sistema.

**Card** (`22px`) é a forma do conteúdo que se decide, e só o deck a usa — junto
com o painel de vazio e o de erro, que ocupam exatamente a pegada dele.

Entre as duas há dois raios de serviço: `14px` para painel de lista, estatística
e conta, e `12px` para o carimbo LIKE/PASS, que precisa parecer estampado, não
macio.

**Traço, não preenchimento.** A silhueta de um controle vem do fio de 1px; o
preenchimento é vidro a 6%, quase ausente. É por isso que um botão colorido
(`.pass`, `.like`, `.lib-danger`) troca só a cor do fio e do texto, e não o fundo.

### Named Rules

**A Regra da Pílula.** Se o usuário pode clicar, arrastar ou digitar nele, é
pílula. Se ele lê e decide sobre aquilo, é card. Não há terceira categoria.

## Components

Os controles são **táteis e confiantes**: têm presença física, respondem ao toque
com `scale(0.96)` e transições de 120ms, e ocupam os `2.75rem` de alvo mínimo
mesmo quando caberiam em menos. O deck é um gesto — os botões também precisam
parecer objetos.

### Buttons

- **Shape:** pílula (`999px`), altura mínima `2.75rem`, largura mínima `6.5rem`
  nas ações de decisão.
- **Pass / Like:** fundo `--surface`, texto e fio na cor semântica a 38% de
  opacidade (`color-mix`). No hover o fio vai a 100% e o fundo recebe 16% da cor.
  Classe por papel (`.pass` / `.like`), nunca por posição — a ordem já mudou uma
  vez quando o Undo entrou entre os dois.
- **Undo (terciário):** sem fundo, sem fio, texto em Cinza de Serviço, largura
  mínima zerada. Desfazer não pode competir com decidir. Desabilitado a 35%.
- **Commit (onboarding):** o único botão com fundo colorido — 16% de verde,
  fio verde a 100%. Existe porque fecha o onboarding, que é o degrau de atrito
  medido do produto.
- **Danger:** fio e texto em Vermelho Recusa, sem fundo. É o único vermelho da
  tela de conta.
- **Hover / Focus:** `outline: 2px solid var(--fg); outline-offset: 2px`, aplicado
  por uma regra `:where(...)` única com especificidade zero — qualquer regra
  posterior ajusta o offset sem `!important`.

### Chips

- **Gênero (onboarding):** pílula com `--surface` e fio. Selecionado troca para
  12% de verde, fio e texto verdes. O estado real é `aria-pressed`; o visual é
  consequência dele, nunca uma segunda verdade.
- **Tipo e nota (card):** fundo `rgb(0 0 0 / 0.5)` com fio interno branco a 20%,
  porque flutuam sobre um gradiente de hue imprevisível. Tipo em caixa alta com
  tracking; nota em `tabular-nums`.

### Cards / Containers

- **Corner Style:** `22px` no deck, `14px` em painel de lista/estatística/conta.
- **Background:** o card é um gradiente derivado do `id` (`hsl(h 52% 30%)` →
  `hsl(h+45 58% 12%)`, 160°) sobreposto por um degradê preto de **duas pontas** —
  escuro no topo para os chips, escuro no rodapé para o texto. Um degradê só não
  bastava: sem a parada de cima o chip caía na parte clara; sem `0.72` embaixo o
  Cinza de Serviço não fechava AA contra os hues mais claros sorteados.
- **Shadow Strategy:** ver **A Regra do Foco Único**.
- **Internal Padding:** `clamp(0.7rem, 5.5cqi, 1.25rem)` — o padding também
  escala pelo container.

### Inputs / Fields

- **Style:** pílula, `--surface`, fio de 1px, altura `--tap`. `<select>` tem teto
  de `9.5rem` com reticências, porque ele se dimensiona pela maior opção e
  "Action & Adventure" sozinho levava 177px.
- **Focus:** o mesmo outline de 2px do sistema. Dentro da pílula de intervalo de
  ano o offset vira `-3px`, senão o outline vaza por cima do vizinho.
- **Intervalo (de/até):** dois inputs dentro de uma pílula só, separados por um
  `box-shadow` de 1px. Separados, quebravam em linhas diferentes em 360px e
  estouravam a reserva de altura.
- **Placeholder:** `--muted` com `opacity: 1` — o cinza padrão do Chrome não
  fecha AA sobre `--surface`.

### Navigation

- Pílulas de texto em Cinza de Serviço; a ativa ganha `--surface` e Papel Frio,
  marcada por `aria-current="page"`. O item ativo é um controle em repouso como
  qualquer outro — o que o distingue é a cor do texto, não uma superfície
  própria.
- Sem sessão, a nav some inteira (as três telas seriam 401) e desce para depois
  do conteúdo (`order: 2`): a pessoa lê o que é o app antes do call-to-action.
- O badge de contagem é a única superfície de fundo sólido verde do sistema.

### O Card do Deck (componente-assinatura)

Três no DOM, nunca mais. O do topo recebe os Pointer Events e um
`translate3d(x, y, 0) rotate(x/22deg)`; os de trás sobem `-18px` cada e
encolhem 4% — **para cima**, não para baixo, porque por cima o que aparece é
gradiente limpo e por baixo apareceria o rodapé de texto do card seguinte.

O progresso do gesto sai do JS como **um** número com sinal (`--swipe`, ±1 no
limiar) e o CSS decide o resto: `opacity: var(--swipe)` no carimbo LIKE,
`calc(-1 * var(--swipe))` no PASS. Valor fora de 0–1 é clampado pelo próprio
CSS, então um valor basta para os dois.

### Estados: vazio, carregando, erro

Os três ocupam **a pegada exata do deck** (`.deck-slot`), não um espaço menor.

- **Carregando:** um fantasma com a medida do card (`--deck-w` × 1.5) pulsando
  em 1.5s. Quando o feed chega, o deck nasce no lugar do fantasma em vez de
  empurrar a página.
- **Vazio:** contorno com a pegada do card. Sem ele, "acabou" era uma frase
  boiando num buraco — o contorno diz *que* lugar está vazio.
- **Erro:** o mesmo painel, em Vermelho Recusa a 8% de fundo e 35% de fio. O que
  falhou foi o deck, então o erro ocupa o lugar dele.

## Do's and Don'ts

### Do:

- **Do** usar `--surface`, `--surface-hi` e `--line` para qualquer superfície ou
  traço novo. Os três são um material só; escrever `rgb(255 255 255 / 0.14)` na
  mão cria um quarto que ninguém consegue mudar depois.
- **Do** dar `min-height: var(--tap)` a tudo que recebe toque, inclusive
  `<select>` e `<input>`. O token existe porque é requisito WCAG 2.5.8, não
  porque 44px é bonito.
- **Do** medir o contraste contra a superfície onde o texto de fato aparece.
  Teste de auditoria: um texto novo em Cinza de Serviço sobre `--surface` fecha
  4,5:1? Se não fecha, ele é Papel Frio ou não existe.
- **Do** manter paridade total entre gesto, botão e teclado em qualquer
  interação nova. Setas para decidir, Backspace para desfazer.
- **Do** deixar `prefers-reduced-motion` cortar a física e manter o significado:
  os carimbos continuam aparecendo, só perdem o crescimento. Eles são o que diz
  para onde o card vai.
- **Do** escalar tipografia e padding dentro do card por `cqi`, e o resto por
  `clamp` com `vw`.
- **Do** somar em `--deck-reserve` qualquer elemento novo de altura permanente
  em volta do deck.

### Don't:

- **Don't** introduzir uma terceira cor cromática. Verde é sim, vermelho é não,
  todo o resto é neutro — inclusive aviso, informação e sucesso não-acionável.
- **Don't** adicionar `box-shadow` a nada que não seja o card do deck. Use
  camada tonal e o fio de 1px.
- **Don't** usar canto retangular em controle. Se é clicável, é pílula.
- **Don't** construir uma grade de pôsteres com carrosséis por categoria. É
  exatamente o catalogão de streaming que o produto existe para não ser: a grade
  não faz ninguém decidir.
- **Don't** tratar a tela de estatísticas como dashboard. Sem cartela de KPI, sem
  gráfico de barras, sem densidade de analítico — é um resumo pessoal em `<dl>`,
  e o nome de trabalho "Watchlytics" não autoriza o contrário.
- **Don't** deixar um estado de deck (vazio, carregando, erro) ocupar menos que a
  pegada do card. A página saltar 500px entre estados lê como bug.
- **Don't** pintar estado com CSS que não derive do atributo ARIA. `aria-pressed`
  e `aria-selected` carregam o estado; o visual é consequência, não uma segunda
  fonte de verdade.
- **Don't** usar `vw` para tipografia dentro do card, nem `left/top` para o
  gesto. `cqi` e `translate3d`, sempre.
