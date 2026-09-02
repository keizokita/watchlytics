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
step. O node do PATH do sandbox não é o certo — carregue o nvm:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 25   # v25.4.0
```

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
cp apps/api/.env.example apps/api/.env     # DATABASE_URL + DEV_USER_ID
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
| `driver.mjs web` | Garante api:3000 + vite:5173 (subindo o que faltar), dirige o Chrome headless pelo deck, tira dois prints e confere os swipes no banco. |
| `driver.mjs all` | Os dois, nessa ordem. Padrão. |

Flags do `web`: `--url` (padrão `http://localhost:5173`), `--wait <seletor>`
(padrão `.deck-card`), `--out <arquivo.png>`.

Prints → `/tmp/watchlytics-run/web.png` (deck inicial) e `web-depois.png`
(depois dos dois swipes). Saída verde esperada:

```
── api ──
✔ GET /health
✔ GET /v1/feed devolve 20 — Breaking Bad
✔ feed vem em score desc
✔ POST /v1/swipes aceita
✔ reenvio é upsert, não duplicata — {"accepted":1,"skipped":0}
✔ título desconhecido é descartado
✔ lote vazio responde 400
✔ like sai do feed
✔ sem DEV_USER_ID a rota responde 401
── web ──
✔ deck renderizou — Breaking Bad
✔ 3 cards no DOM (profundidade) — 3
✔ pôster é o gradiente determinístico — linear-gradient(160deg, rgb(37, 116, 83), …)
✔ botões Pass e Like presentes — Pass,Undo,Like
✔ clique em Like avança o deck — Breaking Bad → Game of Thrones
✔ ArrowLeft (pass) avança o deck — Game of Thrones → Inception
✔ console sem erro
✔ o navegador gravou 2 swipes — 1,-1
```

O último ✔ é o que fecha o circuito: clique no DOM → `POST /v1/swipes` →
linha no Postgres. O driver apaga essas linhas no fim (veja Gotchas).

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
em rede nem em Postgres. `apps/api/src/swipes.test.ts` limpa os swipes do
`DEV_USER_ID` no `after`, então dá para rodar em cima do banco de
desenvolvimento sem sujar nada.

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
- **`DEV_USER_ID` tem que ser restaurada.** O `cmdApi` troca a variável por um
  usuário descartável (e apaga no fim, levando os swipes por `ON DELETE
  CASCADE`). Em `all`, o `cmdWeb` roda depois e sobe uma api que **herda** esse
  env — deixar o usuário apagado aí faz o `POST /v1/swipes` do navegador
  estourar a FK.
- **O swipe NÃO vira `POST` na hora.** `swipeQueue.ts` (B6) grava em
  `localStorage` e só faz flush 3s depois (`FLUSH_MS`) ou quando junta 5
  pendentes. Conferir o banco logo após o clique devolve zero linha — o driver
  faz polling até 15s. Se você precisa do flush imediato, o gatilho é
  `visibilitychange` para `hidden`.
- **O `driver.mjs web` grava swipes de verdade** com o `DEV_USER_ID` do `.env`,
  e apaga só o que ele mesmo gravou (janela por `updated_at`). Sem isso cada
  execução comeria dois títulos do feed: com 94 na fixture o deck acabaria em
  ~47 runs.
- **`/health` não toca no banco.** Responde `{"ok":true}` com o Postgres
  desligado; quem quebra é `/v1/feed`, com 500 e a query inteira no corpo. Não
  use `/health` como readiness probe do banco.
- **`npm run dev:*` não repassa SIGTERM.** Matar o pid do npm deixa o node/vite
  vivo segurando a porta. O driver sobe com `detached: true` e mata o grupo
  (`process.kill(-pid)`); na mão, `fuser -k 3000/tcp 5173/tcp`.
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
- **Tela com `error: feed respondeu 500`**: api de pé, Postgres não.
  `npm run db:up` e o `pg_isready`.
