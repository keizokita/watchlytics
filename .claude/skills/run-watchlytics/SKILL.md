---
name: run-watchlytics
description: Sobe, roda e dirige o Watchlytics (apps/api Fastify + apps/web Vite/React). Use para build, start, rodar a api, subir o web, rodar os testes, tirar screenshot/print do deck, dar swipe pelo navegador, ou conferir uma mudança no app rodando de verdade — não só no teste.
---

Monorepo npm com duas pontas que sobem juntas: `apps/api` (Fastify + Drizzle +
Postgres) e `apps/web` (Vite + React, com proxy de `/v1` para a api). O handle do
agente é `.claude/skills/run-watchlytics/driver.mjs`: ele bate nas rotas com
`app.inject()` e dirige um Chrome headless por CDP — clica em Like, aperta
ArrowLeft, tira print e confere que o swipe chegou no banco. Comece por ele.

Todos os caminhos são relativos à raiz do repositório.

## Prerequisites

Node **≥23** é obrigatório: o projeto executa `.ts` direto, sem `tsx` nem build
step. **Confira antes de carregar qualquer coisa:**

```bash
node -v      # nesta máquina: v25.4.0, direto do PATH
```

Se já estiver ≥23, **não** carregue o nvm. Havia aqui a instrução de sempre
rodar `export NVM_DIR=...; . nvm.sh; nvm use 25`, e ela custava caro por um
motivo que não é o óbvio: o preâmbulo transforma o comando numa linha composta,
e o classificador do modo automático barra linha composta que ele não reconhece.
O driver chegou a ser bloqueado no meio de uma verificação por causa disso.
`node .claude/skills/run-watchlytics/driver.mjs all`, puro, passa.

Se o `node -v` do PATH for antigo, aí sim carregue o nvm — e prefira abrir a
sessão com ele já ativo a prefixar cada comando.

`podman` (Postgres com `pgvector`) e `google-chrome` (o driver) já estão
instalados nesta máquina — nada foi instalado nesta sessão. Confira com:

```bash
podman --version && google-chrome --version && node -v
```

Numa Ubuntu limpa, o `podman` vem do apt (`sudo apt-get install -y podman`); o
`google-chrome-stable` **não** está nos repositórios da Ubuntu — vem do repo da
Google. Qualquer Chrome/Chromium serve, contanto que o binário se chame
`google-chrome` (senão troque o nome em `openChrome()` no driver).

## Setup

```bash
npm install
npm run build -w @watchlytics/contract     # único pacote que compila
cp apps/api/.env.example apps/api/.env     # DATABASE_URL + AUTH_SECRET
npm run db:up                              # pgvector:pg17 na porta 5433
```

**Espere o Postgres antes de migrar** — `npm run db:up` volta quando o container
sobe, não quando o banco aceita conexão:

```bash
timeout 60 bash -c 'until podman exec watchlytics-db pg_isready -U dev -d watchlytics >/dev/null 2>&1; do sleep 0.5; done'
npm run migrate     # → "migrations aplicadas"
npm run seed        # → "gêneros: 19 | títulos inseridos: 94 | já existentes: 0"
```

`npm run seed` é idempotente: a segunda vez imprime `inseridos: 0 | já
existentes: 94`, que é exatamente o gate do CI.

## Run (agent path)

```bash
node .claude/skills/run-watchlytics/driver.mjs all
```

Com o banco de pé e nada mais rodando, `all` leva ~5s: sobe o que faltar e
derruba no fim.

| comando | o que faz |
|---|---|
| `driver.mjs api` | Sobe o Fastify **em processo** e bate nas rotas com `app.inject()`. Sem porta, sem servidor. É o caminho para PR que mexe em `apps/api/src/`. |
| `driver.mjs web` | Garante api:3000 + vite:5173 (subindo o que faltar), **planta uma sessão e cumpre o onboarding** de um usuário descartável, dirige o Chrome headless pelo deck, tira dois prints e confere os swipes no banco. Desfaz as duas coisas no fim. |
| `driver.mjs social` | **β6** — duas contas com sessões simultâneas, em contextos de navegação separados. Porta de idade, rotação de refresh, amizade, match, notificação e perfil público, tudo pela tela. Cria as duas contas e as apaga no fim. |
| `driver.mjs all` | `api` e `web`, nessa ordem. Padrão. O `social` fica de fora: ele leva ~40s e sobe dois contextos. |

Flags do `web`: `--url` (padrão `http://localhost:5173`), `--wait <seletor>`
(padrão `.deck-card`), `--out <arquivo.png>`.

Prints → `/tmp/watchlytics-run/web.png` (deck inicial) e `web-depois.png`
(depois dos dois swipes). Saída verde esperada:

```
── api ──
✔ GET /health
✔ sem ano de nascimento o feed é 403 (β2)
✔ a porta de idade abre com maior de idade
✔ GET /v1/feed devolve 20 — Shrek
✔ feed puxa do topo do catálogo, não do meio — menor da página 61 · mediana 34
✔ POST /v1/swipes aceita
✔ reenvio é upsert, não duplicata — {"accepted":1,"skipped":0}
✔ título desconhecido é descartado
✔ lote vazio responde 400
✔ like sai do feed
✔ sem Authorization a rota responde 401
── web ──
✔ deck renderizou — Despicable Me
✔ 3 cards no DOM (profundidade) — 3
✔ pôster na frente, gradiente do id atrás (B4) — url("https://image.tmdb.org/t/p/w500/b1BT30….jpg"), linear-g
✔ pré-carga passou dos cards do DOM (B4) — 8 pôsteres pedidos, 3 cards no DOM
✔ botões Pass e Like presentes — Pass,Undo,Like
✔ clique em Like avança o deck — Despicable Me → The Super Mario Bros. Movie
✔ ArrowLeft (pass) avança o deck — The Super Mario Bros. Movie → Inside Out
✔ console sem erro
✔ o navegador gravou 2 swipes — 2 além dos 20 do onboarding
```

O último ✔ é o que fecha o circuito: clique no DOM → `POST /v1/swipes` →
linha no Postgres. O driver apaga essas linhas no fim (veja Gotchas).

### `social` — o loop entre duas contas (β6)

```
✔ β2 a porta de idade fecha as duas contas antes de qualquer tela — links de nav: 0 e 0
✔ β2 as duas contas passam a porta pela tela, e só então o app monta — 2/2 com ano gravado
✔ β6.2 cada sessão rotacionou o próprio refresh, sem tocar na outra (C3) — 3 e 3 hashes distintos
✔ β6.2 nenhuma rotação foi lida como replay — as duas sessões seguem vivas — 2/2 sem revoked_at
✔ β6.3 o pedido grava o par normalizado e quem pediu (E2) — pending, pedido por ana-…
✔ β6.3 as três listas ficam certas dos DOIS lados
✔ β6.4 o aceite cruza os catálogos e casa o título curtido antes (E4) — força 3
✔ β6.4 uma notificação agregada por pessoa, não uma por título (E4)
✔ β6.5 abaixo de 10 assistidos o agregado nem é calculado (D3)
✔ β6.5 o décimo assistido, marcado na tela, abre o agregado do perfil
```

São 23 asserções, e nenhuma delas é um print: o que vale é o estado depois da
ação — a linha no Postgres, ou a lista que a OUTRA conta passou a enxergar.

As duas contas nascem sem `birth_year`, como o OAuth as deixaria, e respondem a
porta de idade pela tela. O deck de cada uma nasce com o catálogo inteiro
decidido menos UM título: sem isso não há como fazer as duas curtirem o mesmo
card, porque a ordem do feed tem ruído por requisito (A4). O like vem ANTES do
aceite de propósito — é o que dá ao E4 algo retroativo para cruzar.

Quando falha, o driver despeja o log dos servidores que ele subiu. `✘ deck
renderizou` junto de `✘ console sem erro — … 500 … /v1/feed` é banco fora do
ar, não bug de front.

### Seletores que o driver usa

Se `apps/web/src/Deck.tsx` ou `Card.tsx` mudarem de marcação, é aqui que quebra:

| seletor | o quê |
|---|---|
| `.deck .deck-card:last-child` | card do topo — **último** no DOM, `Deck.tsx` renderiza `.reverse()` |
| `.card-title` | título (é `<h2>`, não `<h1>`) |
| `.actions button` + texto | Pass / Undo / Like — o driver acha **pelo texto**, não por posição |

Os botões são casados por `innerText`, de propósito: a ordem já mudou uma vez
(B7 inseriu o Undo entre Pass e Like) e `:last-child` teria quebrado calado.

### Chamar o código direto

Para exercitar uma função da api sem subir nada. `--env-file` **antes** do
`-e`, porque `apps/api/src/db/client.ts` lê `DATABASE_URL` no topo do módulo:

```bash
node --env-file=apps/api/.env --input-type=module -e '
  const { buildServer } = await import("./apps/api/src/server.ts");
  const app = buildServer();
  console.log((await app.inject({ method: "GET", url: "/v1/feed" })).json().items.length);
  await app.close(); process.exit(0);'   # → 20
```

## Run (human path)

```bash
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173 — abre no navegador, Ctrl-C para parar
```

Dois terminais. Headless não serve para nada: use o driver.

## Test

```bash
npm run check                     # tsc --noEmit nos três pacotes
npm test                          # 9 testes na api + 5 no web (~4s)
npm run build -w @watchlytics/web # o que o CI publica no Pages
```

Os testes da api precisam do banco semeado; os do web (`swipeQueue`) não tocam
em rede nem em Postgres. Cada arquivo de teste cria e apaga a própria conta de
fixture no `after`, então dá para rodar em cima do banco de desenvolvimento sem
sujar nada.

## Gotchas

- **Os UUIDs dos títulos NÃO são fixos.** `titles.id` é `defaultRandom()` e a
  fixture só traz `slug`; `title_external_ids` amarra os dois. Refazer o seed do
  zero troca todos os ids — e com eles o gradiente de cada card, que sai de
  `gradient(id)`. Nunca escreva um UUID de título em teste ou script; pegue do
  `/v1/feed`. (`docs/BACKLOG.md` §0 diz "UUIDs fixos" — está errado.)
- **O card do topo é o ÚLTIMO no DOM.** `Deck.tsx` faz `.reverse()` para o topo
  ficar por cima sem `z-index` brigando. `.deck-card:first-child` pega o card
  do fundo, que é `aria-hidden` e não responde a evento.
- **Emule `prefers-reduced-motion: reduce` ANTES do navigate.** `Deck.tsx` lê o
  `matchMedia` uma única vez, no mount. Com `reduce` o `FLY_MS` de 260ms vira 0
  e o card troca na hora — sem isso o driver fica adivinhando animação.
- **`db/client.ts` é um singleton e o `pg.end()` dele é global ao processo.**
  O `cmdApi` encerra o pool; qualquer código depois no mesmo processo que
  reimportar o módulo pega `CONNECTION_ENDED`. O `checkSwipesGravados` abre
  conexão própria com `postgres(...)` de propósito.
- **Conta sem ano de nascimento não usa o app.** O β2 fecha toda rota
  autenticada com 403 até `POST /v1/auth/age` receber um ano com 16 anos ou
  mais; só `/v1/auth/me` e a própria porta respondem antes disso. Usuário criado
  na mão em SQL precisa de `birth_year`, senão o deck nem carrega.
- **Não existe mais shim de autenticação.** O β3 tirou do `requireUserId` a
  variável de ambiente com id de usuário: o `cmdApi` cria um usuário
  descartável e assina um Bearer
  para ele (`signAccess`), e o `cmdWeb` planta sessão de verdade. Toda rota
  autenticada responde 401 sem header — inclusive no seu `curl` de dev.
- **O swipe NÃO vira `POST` na hora.** `swipeQueue.ts` (B6) grava em
  `localStorage` e só faz flush 3s depois (`FLUSH_MS`) ou quando junta 5
  pendentes. Conferir o banco logo após o clique devolve zero linha — o driver
  faz polling até 15s. Se você precisa do flush imediato, o gatilho é
  `visibilitychange` para `hidden`.
- **O `driver.mjs web` grava swipes de verdade** na conta descartável que ele
  mesmo cria, e apaga a conta no fim (a cascata leva os swipes). Sem isso cada
  execução comeria dois títulos do feed: com 94 na fixture o deck acabaria em
  ~47 runs.
- **`/health` não toca no banco.** Responde `{"ok":true}` com o Postgres
  desligado; quem quebra é `/v1/feed`, com 500 e a query inteira no corpo. Não
  use `/health` como readiness probe do banco.
- **`npm run dev:*` não repassa SIGTERM.** Matar o pid do npm deixa o node/vite
  vivo segurando a porta. O driver sobe com `detached: true` e mata o grupo
  (`process.kill(-pid)`); na mão, `fuser -k 3000/tcp 5173/tcp`.
- **Na fixture, três asserções do `web` NÃO passam, e não é regressão.** Banco
  recém-semeado tem os 94 títulos do `seed/titles.json`, e nenhum deles tem
  `poster_url` nem `cast_names` — o elenco (I1.2) e as duas do pôster (B4) só
  ficam verdes contra o catálogo ingerido do TMDB. Conferido no `driver.mjs` de
  `origin/main` em 2026-09-12, num `wl_b6` criado do zero. A saída verde acima é
  a do banco de desenvolvimento. Pela mesma razão, "feed puxa do topo do
  catálogo" pisca com 94 títulos: a mediana fica perto demais do topo.
- **Outra sessão na mesma porta é o erro mais caro daqui.** Há vários worktrees
  nesta máquina, cada um com o seu banco. Se a api de outro já estiver em :3000,
  o driver reusa — e a sessão que ele plantou não existe para quem responde.
  Duas conferências cobrem isso: `mesmoBanco` bate em `/v1/auth/me` com um
  access assinado (nunca com o refresh, que rotacionaria o cookie do navegador),
  e o `garantirServidores` confere que quem atende a `--url` serve o `id="root"`
  deste app. **Não dá para subir o vite noutra porta pelo `spawn`**: o npm come o
  `--port` e passa `5174` como RAIZ do servidor, que responde 404 em tudo. Suba
  na mão (`npx vite --port 5174 --strictPort` em `apps/web`) e passe `--url`.
- **`innerText` vem com o `text-transform` aplicado.** `.lib h2` é uppercase no
  `screenCss.ts`, então o "Results" do `strings.ts` chega como "RESULTS". Casar
  texto de tela sem normalizar a caixa dá seletor que não acha nada e uma espera
  de 10s culpando a requisição, que tinha respondido.
- **`chromium-cli` não existe nesta máquina.** O driver fala CDP direto no
  `google-chrome` pelo `WebSocket` global do Node — sem Playwright, sem `ws`, e
  `npm install` não muda por causa dele.
- **`--remote-debugging-port=0`**, não 9222: o Chrome anuncia a URL do devtools
  no stderr e duas execuções em paralelo não brigam pela porta.
- **O 404 de `/favicon.ico` é esperado.** `apps/web/index.html` não declara
  ícone e o Chrome pede assim mesmo; o driver filtra esse erro do console.

## Troubleshooting

- **`PostgresError: the database system is starting up`**: `npm run migrate`
  rodou rápido demais depois do `db:up`. Rode o `pg_isready` do Setup.
- **`Error: no container with name or ID "watchlytics-db" found`** no `db:up`:
  é ruído, não erro — o script é `podman start || podman run`, e o `start` falha
  quando o container ainda não existe. O `run` logo abaixo cria.
- **`TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`**:
  Node < 23 (visto no v22.12.0). `nvm use 25`.
- **`TypeError: process.loadEnvFile is not a function`**: Node bem antigo
  (visto no v18.19.1). Mesma correção.
- **`DrizzleQueryError … cause: CONNECTION_ENDED localhost:5433`**: alguém já
  chamou `pg.end()` no singleton do `db/client.ts` neste processo. Abra
  conexão própria.
- **`nvm is not compatible with the npm config "prefix" option`**: acontece
  depois de rodar `npx` em alguns shells. Contorne sem nvm:
  `export PATH="$HOME/.nvm/versions/node/v25.4.0/bin:$PATH"`.
- **`a api de http://localhost:3000 não enxerga o banco deste worktree`**: outra
  sessão subiu a api na mesma porta, com outro `DATABASE_URL`. Espere ela
  terminar ou derrube a dela (`fuser -k 3000/tcp`) — e confira antes de que tipo
  de processo é: `readlink /proc/<pid>/cwd` diz de qual worktree ele saiu.
- **`responde, mas não é o app deste worktree`**: o mesmo, do lado do vite.
- **Tela com `error: feed respondeu 500`**: api de pé, Postgres não.
  `npm run db:up` e o `pg_isready`.
