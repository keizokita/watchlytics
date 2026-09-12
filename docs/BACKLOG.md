# Watchlytics — Separação de atividades

> Complementa [PLAN.md](./PLAN.md). O plano diz *o quê* e *por quê*; este diz
> *em que ordem* e *o que pode andar em paralelo*.
>
> **Solo?** Leia como ordem de execução.
> **2–3 pessoas?** Leia como trilhas — S é de todos, depois A/B/C são paralelas.

---

## 0. O esqueleto que atravessa tudo (bloqueia todo o resto)

Nada se separa antes disto. É uma fatia vertical fina — banco → API → tela —
sem nenhuma feature. Existe para provar que os canos se conectam, não para
entregar valor.

```
watchlytics/
  packages/contract/    Zod: schemas + tipos derivados. A costura entre api e web.
  apps/api/             Fastify + Drizzle
  apps/web/             Vite + React
  seed/titles.json      ~100 títulos, UUIDs fixos
```

| id | Tarefa | Pronto quando | |
|---|---|---|---|
| S1 | npm workspace, tsconfig base | `npm run check` passa | ✅ |
| S2 | `packages/contract` com os schemas Zod do §6 | Os mesmos tipos importam em api e web | ✅ |
| S3 | **Uma** migration com o schema inteiro do §4 + `pgvector` | `npm run migrate` sobe do zero | ✅ |
| S4 | Seed: 19 gêneros + `titles.json` | `npm run seed` roda duas vezes sem duplicar | ✅ |
| S5 | `GET /v1/feed` — 20 títulos, sem filtro, sem auth | `curl` devolve JSON que valida contra o contrato | ✅ |
| S6 | Uma página, um card, gradiente no lugar do pôster | Card vindo do Postgres na tela | ✅ |
| S7 | **Deploy do esqueleto** — Neon + Fly + Pages | URL pública mostra o card | ✅ login real, 20 swipes no onboarding e OG servindo em `/u/keizokita1` — [DEPLOY.md](./DEPLOY.md) |

**Desvios do plano original, decididos na execução:**

- **npm workspaces em vez de pnpm** — npm já estava instalado; uma ferramenta a
  menos para quem clonar. Trocar por pnpm se o `node_modules` achatado causar
  dependência fantasma.
- **Sem `tsx`/`ts-node`** — Node ≥23 executa `.ts` nativamente. Só o `contract`
  compila, porque type-stripping não vale para pacote dentro de `node_modules`.
- **Sem eslint/prettier** — `strict` do TypeScript já pega o que importa.
  Adicionar quando a primeira discussão de formatação em PR acontecer.
- **Postgres em 5433**, não 5432: a porta padrão estava ocupada na máquina de
  desenvolvimento.
- **Sem `@fastify/cors`** — o dev server do Vite faz proxy de `/v1` para a API.
  Mesma origem em dev e em produção, que é como vai rodar atrás do CDN.
- **Sem TanStack Query ainda** — S6 é um `fetch`. Entra em B5, quando houver
  mutação otimista e cache para gerenciar.

**Uma migration só, não seis.** É greenfield, não há banco de ninguém para
migrar incrementalmente. Fatie quando existir dado em produção.

**S7 não vai para o fim.** Deploy no primeiro dia transforma o susto de
integração de duas semanas em vinte minutos de CORS.

---

## 1. Trilhas

Depois do esqueleto, cinco trilhas. **A, B e C correm em paralelo de verdade** —
B trabalha contra mock do contrato e não espera A.

### A — Feed e catálogo · backend · depende de S

| id | Tarefa | Pronto quando | |
|---|---|---|---|
| A0 | `POST /v1/swipes` em lote e idempotente | Reenviar o mesmo lote não duplica nem falha. Teste automatizado | ✅ |
| A1 | Filtros: tipo, gênero, ano, idioma | Contrato e query aceitam os quatro | ✅ |
| A7 | `DELETE /v1/swipes/:titleId` | Idempotente: 204 tendo apagado linha ou não | ✅ |
| A2 | Exclusão de já-avaliado + reciclagem de dislike (180d) | Título curtido nunca reaparece; descartado volta após a janela | ✅ |
| A3 | Paginação por cursor, lotes de 20 | Duas páginas seguidas sem sobreposição | ✅ |
| A4 | Boost por gênero (`taste_vector`) + ruído | Dois usuários com gostos opostos veem ordens diferentes | ✅ |
| A5 | Degradação em 3 degraus da fila vazia | Nunca aparece deck vazio sem mensagem | ✅ |
| A6 | Índices do §4 + `EXPLAIN` de sanidade | Feed usa index scan, não seq scan em `swipes` | ✅ |

### B — Deck e swipe · frontend · depende de S2 (contrato), **não** de A

| id | Tarefa | Pronto quando | |
|---|---|---|---|
| B1 | Pilha de 3 cards, `translate3d` | Só 3 cards no DOM, verificado no inspector | ✅ |
| B2 | Gesto Pointer Events, disparo por distância **ou** velocidade | Flick curto e rápido conta | ✅ |
| B3 | Botões + setas do teclado + `prefers-reduced-motion` + `aria-live` | Fluxo completo sem tocar na tela | ✅ |
| B4 | Pré-carregamento das 5 próximas imagens | Sem flash ao trocar de card | ✅ pré-carga das 5 seguintes com `new Image()` **e** o gradiente do id virou forro atrás do pôster (`poster.ts`) — sem ele o card ficava preto enquanto a imagem não chegava, e para sempre se falhasse |
| B5 | Mutação otimista + `POST /v1/swipes` em lote | Card sai da tela antes da resposta | ✅ |
| B6 | Buffer offline em `localStorage`, flush a cada 5 ou 3s | Modo avião: 10 swipes, volta a rede, os 10 chegam | ✅ |
| B7 | Undo de 1 | Desfaz sem duplicar swipe no servidor | ✅ |

### C — Identidade · fullstack · independente de A, B e D

| id | Tarefa | Pronto quando | |
|---|---|---|---|
| C1 | `DEV_USER_ID` no `.env` injetando usuário fixo | A/B/D destravam sem OAuth | ✅ |
| C2 | Google OAuth PKCE, troca do código **no backend** | Login real ponta a ponta | ✅ |
| C3 | JWT 15min + refresh opaco rotacionado em `sessions` | Refresh usado duas vezes é rejeitado | ✅ |
| C4 | Middleware de auth + rate limit | 401 correto, limite por IP e por conta | ✅ |
| C5 | Consentimento versionado no primeiro login | Linha em `consents` com versão | ✅ |
| C6 | `DELETE /v1/me` e `POST /v1/me/export` | Exclusão em cascata verificada; export abre como JSON | ✅ |

> C1 é dívida deliberada. Sai no merge de C2 — não deixe virar bypass permanente.

### D — Catálogo pessoal e perfil · fullstack · depende de A + B

| id | Tarefa | Pronto quando | |
|---|---|---|---|
| D1 | `PUT /v1/library/:id` — status e rating | LIKE vira entrada; `interested → watched` grava `watched_at` | ✅ |
| D2 | Telas: interessado / assistido / descartados | Descartados lê de `swipes`, não de `library_entries` | ✅ |
| D3 | Stats + piso de 10 assistidos | Abaixo de 10 a página pública não mostra agregados | ✅ |
| D4 | Onboarding: gêneros → deck estratificado de 20 → `taste_vector` | Contador visível; feed sai calibrado | ✅ |
| D5 | Perfil público + rota `GET /u/:handle` com OG tags | Link em WhatsApp/Slack renderiza preview | ✅ |

> **D4 colide com a fixture.** 20 swipes obrigatórios sobre ~100 títulos queimam
> 20% do catálogo na porta de entrada. Aceitável para construir e demonstrar,
> inviável para o beta da fase 2.

### E — Social e match · fullstack · depende de D (status) + C (usuários reais)

| id | Tarefa | Pronto quando | |
|---|---|---|---|
| E1 | Handle único + busca (≥3 chars, nunca por email) | Busca não confirma existência de conta | ✅ |
| E2 | Pedido e aceite de amizade | Par normalizado `user_a < user_b`, sem linha invertida | ✅ |
| E3 | Match no like, na mesma transação | Dois amigos curtem o mesmo título → linha em `matches` | ✅ |
| E4 | Match retroativo no aceite, notificação **agregada** | 37 comuns geram 1 notificação, não 37 | ✅ |
| E5 | Aba "títulos em comum" com força do match | Forte notifica, fraco só aparece | ✅ |
| E6 | Notificações + polling 60s + badge | Badge zera ao abrir | ✅ |

---

## 2. Grafo de dependências

```
        S (esqueleto)
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
        A (feed)       B (swipe)      C (identidade)
        └──────┬───────┘              │
               ▼                      │
               D (catálogo/perfil)    │
               └──────────┬───────────┘
                          ▼
                          E (social/match)
```

**Caminho crítico:** `S → A/B → D → E`.
**C fica fora dele** — é a trilha para dar a quem entrar depois, ou para
encaixar nas janelas em que A/B estiverem bloqueadas.

---

## 3. Regras de fatiamento

1. **Fatia vertical, nunca por camada.** "Backend faz tudo, depois o frontend
   consome" garante que nada funciona até o último dia. Cada tarefa acima
   atravessa o que precisar atravessar.
2. **O contrato é a fronteira.** Mudou o contrato? É PR próprio, mergeado antes
   de qualquer trilha depender dele. É isso que deixa B correr sem A.
3. **Pronto = demonstrável.** As colunas "pronto quando" são propositalmente
   observáveis. "Implementei o endpoint" não é pronto.
4. **Uma verificação executável por tarefa não-trivial.** A2, B6, C3, E2 e E4
   têm lógica que quebra silenciosamente — cada uma leva um teste, não uma suíte.

---

## 4. Fora deste backlog

Fases 4 (Expo) e 5 (recomendação avançada) do [PLAN.md](./PLAN.md#9-roadmap).
Não fatie agora — o contrato `/v1` precisa congelar primeiro.

---

## 5. Trilhas de ingestão (I) — o catálogo real

> Escrito depois que a fonte fechou em TMDB. O worker de carga inicial já existe
> (`npm run ingest`); estas trilhas são o que falta para o catálogo ser completo
> e não apodrecer.

### Fase serial — ANTES de spawnar qualquer agente

Estes dois passos não paralelizam, e pular qualquer um repete os erros da rodada
anterior de agentes.

| id | Tarefa | Quem | Por que é serial |
|---|---|---|---|
| I0.1 ✅ | Rodar a ingestão local e escolher `--min-votes` swipando | usuário | Nenhum agente consegue decidir a régua: só olhando o deck se sabe se o título é reconhecível |
| I0.2 ✅ | **Uma** migration + **todas** as adições de contrato que as trilhas precisam | eu | `schema.ts` e `contract/index.ts` foram os pontos de contenção da última vez. Mudam uma vez, antes, e ficam CONGELADOS |

> **I0.1 fechou em 2026-09-08: régua 800** (anime 80, reality 50) — 7583 títulos
> em produção, fixture apagada. A régua não foi escolhida pelo volume e sim pela
> direção do erro: baixá-la depois só insere, subi-la exige `DELETE` em `titles`,
> e as FKs são `ON DELETE CASCADE` — levaria junto swipe, biblioteca e match de
> quem já tivesse avaliado. Começar apertado é o único lado que se corrige sem
> apagar dado de usuário.

> **I0.2 fechou em 2026-09-09.** Uma migration (`0003_high_purple_man.sql`) e um
> campo de contrato. Em `titles`: `cast_names text[]` com default `'{}'` e
> `credits_synced_at`, que é o que torna a segunda passada da I1.1 retomável —
> NULL significa *nunca buscado*, diferente de *buscado e sem elenco*. Mais o
> índice parcial `titles_sem_elenco`, que é a fila da carga e encolhe conforme
> ela anda. Nova tabela `ingest_state (key, value jsonb, updated_at)`: duas
> chaves, `changes_cursor` (I2.1) e `backfill_cursor` (I2.3) — nada disso se
> deriva de `titles`, porque uma varredura sem mudança nenhuma também precisa
> avançar. No contrato, um campo só: `castNames: string[]`, array vazio e nunca
> null. `toTitle` (feed.ts) é o único lugar que monta `Title`, e a `library.ts`
> o importa — as duas rotas passaram a devolver elenco numa linha.
>
> Junto veio `ingest/http.ts`: o cliente do TMDB com pausa, recuo e leitura do
> `Retry-After` era a função privada `get()` dentro do `run.ts`. A I1.1 tem que
> respeitar "o mesmo rate limit" e não pode tocar em `run.ts` — o critério dela
> era inalcançável sem duplicar o recuo ou criar cola sem dono, que foi o erro
> do `swipes.ts` na rodada anterior. Mover foi de comportamento neutro, com uma
> exceção deliberada: o `TMDB_READ_TOKEN` passou a ser lido por chamada e não no
> import, senão qualquer teste que importasse o módulo morreria ao carregar.
> `http.test.ts` cobre exatamente essa troca.
>
> **Fora do congelamento, de propósito:** nada de AniList (estúdio, fonte,
> temporada). O I3 continua sem consumidor — coluna para dado que nenhuma tela
> mostra é construir adiantado, que é o que este projeto vinha evitando.
>
> Três objetos já existiam nos bancos de dev e de teste, criados por um `push`
> fora do git e sem migration: as duas colunas e a `ingest_state` — esta última
> com exatamente as mesmas três colunas que a migration cria. Foram dropadas
> (vazias) e recriadas pela migration, senão o `migrate` de qualquer clone novo
> quebraria em `42P07`.

### Regras de paralelização (aprendidas errando)

1. **Worktree a partir do `main` atual**, e confira o `merge-base`. Na rodada
   anterior os três nasceram de um commit anterior a um refactor e o merge teria
   revertido a separação de rotas.
2. **Database próprio por agente** (`wl_i1`, `wl_i2`, …). Os testes fazem
   `DELETE` e rodam em processos paralelos.
3. **Todo arquivo tem dono, inclusive os de cola.** Da última vez `swipes.ts`
   ficou sem dono e a tarefa que precisava dele contornou de um jeito que teve
   que ser refeito na integração.
4. **`schema.ts`, `contract/index.ts` e `ingest/http.ts` estão congelados** após
   I0.2. Precisou de coluna, de campo ou de outro comportamento de rede? Fala
   antes; não edita.
5. **Commite antes de terminar.** Um agente morreu por limite de sessão com todo
   o trabalho fora do git.
6. **Arquivo de teste cria usuário próprio.** Ver `library.test.ts`.

### I1 — Elenco no card

Estava na descrição original do produto e nunca foi implementado. O card promete
elenco desde o primeiro dia e nunca mostrou nenhum.

| id | Tarefa | Pronto quando |
|---|---|---|
| I1.1 ✅ | Segunda passada de ingestão buscando `/{type}/{id}/credits` | Uma requisição por título, respeitando o mesmo rate limit; retomável — `ingest/credits.ts`, comando próprio, fila é a coluna `credits_synced_at` |
| I1.2 ✅ | Até 3 nomes no card | Título sem elenco não quebra o card, só não mostra a linha |

**Possui:** `apps/api/src/ingest/credits.ts` + teste · `apps/web/src/Card.tsx`
**Não toca:** `ingest/run.ts`, `ingest/tmdb.ts`, `ingest/http.ts`, nada de rota.
**Usa:** `get()` de `ingest/http.ts` — é ele que dá o "mesmo rate limit" do
critério. Era privado dentro do `run.ts` e saiu de lá no I0.2 justamente porque
esta tarefa não pode tocar naquele arquivo. **Não copie o recuo:** um 429
aprendido numa cópia não ensina nada à outra.
**Atenção:** `/discover` não aceita `append_to_response`, então elenco é
necessariamente uma segunda passada. Decida se roda junto da carga ou como
comando separado, e diga por quê.

> **I1.2 fechou em 2026-09-10.** Uma linha no `Card.tsx` e uma classe a mais no
> seletor da meta. O corte de 3 é do card, não do contrato (que guarda 5) nem da
> ingestão: mudar quantos nomes cabem não pode obrigar a rebuscar elenco.
> A linha é a ÚLTIMA do card de propósito — sem elenco ela some e nada acima
> muda de lugar; no meio, card com e sem elenco moveriam a sinopse a cada swipe.
> Reticência em uma linha só, como a meta, porque três nomes longos com wrap
> empurram a sinopse para fora do card.
>
> **Passada rodada em 2026-09-10, banco de dev:** 9830 títulos em 1717s (~29
> min), fila zerada, 9769 com elenco e média de 4,86 nomes guardados. Os 61 sem
> elenco não são falha: 48 séries e 13 filmes, e os de score mais alto são
> antologia (`Black Mirror`, `Love, Death & Robots`) ou animação sem diálogo
> (`Flow`, `Piper`) — `/tv/{id}/credits` respondeu para 97,4% das séries, então
> não há buraco sistemático a corrigir. Nenhum 404: `fora do TMDB 0`.
>
> Os dois estados foram vistos no navegador, um em cada ponta da fila (que anda
> por score DESC): com 525 buscados o card do topo era `Hercules`, score 63,
> ainda na frente da fronteira — nenhuma linha e nada deslocado; com 1500, o
> topo era `Shrek 2` com "Mike Myers · Eddie Murphy · Cameron Diaz".

### I2 — Catálogo vivo

Sem isto o catálogo apodrece: em doze meses não tem nenhum título do ano.

| id | Tarefa | Pronto quando |
|---|---|---|
| I2.1 ✅ | `/changes` diário: atualiza só o que o TMDB marcou como alterado | Roda em minutos, não horas — 152s sobre 9830 títulos |
| I2.2 ✅ | Pull-through de `synced_at > 30d` | Título frio volta para a fila ao ser lido; a fila é derivada de `swipes`, e a leitura não espera rede |
| I2.3 ✅ | Retomada da carga inicial | Morreu em 2003, recomeça em 2003 e não em 1970 |

**Possui:** `apps/api/src/ingest/changes.ts` + teste · `apps/api/src/ingest/state.ts`
**Não toca:** `tmdb.ts` (parte pura, compartilhada), `Card.tsx`, rotas.

> **I2 fechou em 2026-09-12.** Um comando novo (`npm run ingest:changes`), o
> `state.ts` com as duas chaves de `ingest_state`, e o `upsert()` que era privado
> do `run.ts` virando `ingest/upsert.ts` — pela mesma razão que o `get()` saiu
> dele no I0.2: a I2.1 grava exatamente os mesmos campos pela exatamente mesma
> porta, e a alternativa era uma segunda cópia da escrita para divergir no
> primeiro campo novo.
>
> **I2.1, medido no banco `wl_i2` com os 9830 títulos de produção copiados:**
> a janela de 2026-09-11 a 2026-09-12 levou **152s** — 6905 ids listados pelo
> TMDB (5187 filmes, 1718 séries), dos quais **838 eram nossos** (647 + 191), e
> os 838 foram atualizados. Zero inserção, zero exclusão, catálogo continua
> 9830 e os uuids conferidos contra o banco de origem não mudaram. Rodar de novo
> no mesmo dia custa 0 requisição: o cursor já está em hoje.
>
> O que faz caber em minutos é buscar o detalhe só da INTERSEÇÃO. Os ~12 mil ids
> que o TMDB altera por dia, buscados um a um, seriam ~12 min só de rede por dia
> e cresceriam com o acervo deles, não com o nosso.
>
> **Título NOVO não entra pelo `/changes`, de propósito.** Para saber se um id
> desconhecido passa na régua seria preciso buscar o detalhe dele — os mesmos 12
> mil por dia que o desenho existe para não buscar. Crescer é trabalho da carga
> do `/discover`, que filtra por votos na própria consulta e agora é retomável.
> Foi medido: revarrer 2023–2026 com a régua 800 levou 9s e trouxe **4 títulos
> de 2026** que cruzaram os 800 votos desde a carga de 2026-09-08.
>
> **I2.2 é fila, não leitura que escreve.** O caminho óbvio — o feed vê
> `synced_at` velho e busca no TMDB — transformaria um GET de 20 cards em até 20
> chamadas a um terceiro dentro da requisição, e o feed passaria a ter a latência
> e a disponibilidade do TMDB, mais contenção de lock em `titles` na hora do
> pico. Então a leitura não busca: quem foi lido deixa rastro em `swipes`, e o
> rastro É a fila — frio há mais de 30 dias ∩ swipado nos últimos 7, o mais
> recém-visto primeiro, e o resto do frio por score quando sobra orçamento.
> Nenhuma tabela nova. O preço é a demora: o título frio lido hoje fica fresco na
> próxima passada, não neste swipe. Para pôster e sinopse, um dia não é nada.
> Verificado com 30 títulos frios e `--frios 5`: degelaram os 3 de score 0 que
> tinham swipe de 2h atrás e só depois os 2 de score mais alto.
>
> **I2.3 guarda o último ano CONCLUÍDO, não o ano em andamento** — ano
> interrompido no meio tem que ser refeito inteiro, que é idempotente e custa
> minutos; pular um ano meio carregado deixa um buraco que nada mais fecha.
> Junto do ano vai a régua (`2000-2026/800/80/50`): sem isso, rodar
> `--min-votes 300` depois de uma carga com 800 retomaria em 2003 como se os anos
> anteriores já tivessem sido varridos com 300, e o catálogo teria duas metades
> de critérios diferentes parecendo completo. Carga completa recomeça do início
> em vez de virar comando que não faz nada — é assim que título novo entra.
>
> **Dois carimbos sem escrita, que é o que evita fila eterna:** título que saiu
> do TMDB (404) e título que voltou sem pôster levam `synced_at = now()` sem
> upsert. Sem o carimbo eles reentram na fila fria toda passada, gastando a mesma
> requisição todo dia. É a lição do `credits_synced_at` na I1.1 — "buscado e
> rejeitado" não é "nunca buscado". E nenhum dos dois apaga: as FKs são
> `ON DELETE CASCADE` e um `DELETE` levaria swipe, biblioteca e match junto.
>
> **A régua de votos não é reaplicada na atualização** (`MIN_VOTES_REFRESCO = 0`).
> Ela é portão de entrada, escolhido na I0.1 justamente porque o lado que se
> corrige sem apagar dado de usuário é o apertado. Os outros portões do
> `normalize` continuam valendo: sem pôster ou sem sinopse o card quebra.
>
> **O que NÃO foi feito:** o agendamento. "Diário" aqui é o comando ser barato o
> bastante para rodar todo dia, não um cron — pôr o `/changes` no `fly.toml` é
> operação contra produção e está fora de trilha de agente. Também não entrou
> `runtime_minutes`, que o detalhe do TMDB traz de graça e o `/discover` não:
> nenhuma tela mostra duração, e preencher só pela I2.1 deixaria a coluna cheia
> para os títulos que mudaram e vazia para o resto.

### I3 — Enriquecimento de anime (AniList) · **opcional, e eu não faria agora**

O PLAN §2.2 promete AniList enriquecendo anime com estúdio, fonte (mangá/light
novel), temporada de exibição e score da comunidade.

**O problema:** nenhum desses campos tem consumidor. O card não mostra estúdio
nem fonte, e não há tela que mostre. Seria dado entrando no banco para ninguém
ver — construir adiantado, que é exatamente o que o resto do projeto evitou.

Só vale abrir esta trilha junto de quem vá exibir os campos. Se for aberta:

**Possui:** `apps/api/src/ingest/anilist.ts` + teste.
**NÃO toca em UI** — `Card.tsx` é da I1, e duas trilhas no mesmo arquivo foi o
que criou a confusão da rodada passada.
**Casamento:** por id externo quando houver; senão título + ano. Ambíguo vai
para fila manual, nunca heurística agressiva — dedup errado gera título
duplicado, que é o defeito que mais custa a descobrir.

### Fora destas trilhas

A sequência de produção — secret, ingestão real, `DELETE` da fixture, remoção do
seed do `release_command` — é operação destrutiva contra produção, está
documentada no `fly.toml` e depende de autorização do usuário. Não é trilha de
agente.

---

## 6. Fase beta — objetivo e trilhas

### O objetivo, em uma frase

> **10 a 30 pessoas reais usando o app com amigos de verdade por duas semanas,
> sem que a gente precise ficar olhando.**

Esse "sem ficar olhando" é o que separa beta de demo. Demo funciona com alguém
do lado explicando; beta tem que sobreviver a estranho, de madrugada, no celular
dele, sem ninguém por perto — e alguém tem que ficar sabendo quando quebrar.

O beta é a primeira vez que o produto é testado de verdade: as features sociais
(amizade, match, títulos em comum) nunca funcionaram entre duas pessoas que não
sejam a mesma. Match com um usuário só é código sem prova.

### O que já está pronto

As 39 tarefas do backlog (S/A/B/C/D/E), o catálogo real em produção com régua
800, elenco no card, deploy e CI. **Feature não é o que falta.**

### P0 — bloqueia o convite

Nada disso é opcional: sem os três, convidar alguém é irresponsável ou ilegal.

| id | Tarefa | Por quê | |
|---|---|---|---|
| β1 | Política de privacidade e termos de uso, com link no aviso de consentimento | O `consentNotice` promete um acordo que não existe em lugar nenhum. Mercado global = GDPR, não só LGPD | ✅ `docs/legal/*`, e a `CONSENT_VERSION` subiu junto com o texto (β1.1) |
| β2 | Idade mínima no cadastro | COPPA (menor de 13 nos EUA) e GDPR. Está no PLAN §8 desde o começo e nunca saiu do papel | ✅ 16 anos, gravada no login e cobrada em toda rota autenticada |
| β3 | Remover o shim do C1 | `DEV_USER_ID` segue em `auth.ts` com o OAuth em produção. Era para sair no merge do C2 — é exatamente o "não deixe virar permanente" | ✅ o nome não existe mais em `apps/`, `.github/` nem `.claude/` |

> **β1 fechou em 2026-09-11**, em três PRs (#21, #22, #26). O texto descreve o
> que o produto faz hoje, conferido contra o schema e as rotas: o hash do
> refresh e o User-Agent em `sessions`, o IP em `consents` (o único guardado de
> propósito, porque a lei pede prova do consentimento), a exclusão em cascata
> sem soft-delete, os 30 dias da sessão e os 180 do descarte. GDPR além de LGPD,
> com base legal por finalidade. O §8.7 do PLAN virou parágrafo próprio: o
> backend chama o TMDB sem nenhum dado do usuário, mas o navegador busca pôster
> e elenco no CDN deles, o que revela IP e quais títulos a pessoa viu.
>
> **β1.1** foi achado conferindo se a γ tinha subido a versão do aviso — não
> tinha. A `CONSENT_VERSION` ficou em `2026-09-02` enquanto o texto já era
> outro, e cada conta criada nesse intervalo gravou a aceitação de uma versão
> que não estava mais na tela. Registro errado é pior que registro ausente: o
> ausente se vê, e é o registro que a lei manda poder mostrar. Subiu para
> `2026-09-11`. Junto apareceu que a política afirmava que o app pede o aceite
> de novo quando o texto muda — e o app não faz isso, porque o consentimento é
> gravado uma vez, dentro da transação que cria a conta. Entre construir o gate
> de re-consentimento e fazer a política dizer a verdade, ficou a verdade: num
> beta fechado as contas anteriores são poucas e conhecidas, então a política
> promete escrever para elas, que é cumprível por uma pessoa. O gate ficou como
> `ponytail:` nomeado em `auth.ts`.
>
> **β1.2** tirou os links do blob do GitHub. Não foi estética: para sair do modo
> Testing, o formulário da tela de consentimento do Google exige o link da
> política num domínio verificado no Search Console, e `github.com` não é um
> domínio que a gente possa verificar — `pages.dev` é. `apps/web/legal.mjs`
> renderiza `docs/legal/*.md` para `public/legal/` no build, então a fonte
> continua sendo o markdown que o repositório versiona e não nasce uma segunda
> cópia para manter desatualizada. O build falha se um documento não virar HTML
> com título.
>
> **β1.3** fechou os `[PREENCHER]` que sobravam, no mesmo dia (#29). Nenhum dos
> campos exigia empresa, que era o receio: controlador pode ser pessoa natural
> (GDPR art. 4(7), LGPD art. 5º VI). O encarregado da LGPD fica dispensado —
> agente de tratamento de pequeno porte não precisa indicar um (Res. CD/ANPD nº
> 2/2022), precisa manter canal com o titular, e o canal é o mesmo e-mail. O
> representante na UE não é exigido porque o beta não é oferecido na UE, no EEE
> nem no Reino Unido, e isso é verificável: no modo Testing cada testador entra
> por e-mail digitado à mão numa lista de no máximo 100. Contagem de
> `[PREENCHER]` nos dois documentos: **zero**.
>
> **O que continua aberto:** publicar a tela de consentimento do Google, que é
> do usuário. Para 10 a 30 pessoas a lista de test users resolve sem esse custo.

> **β2 fechou em 2026-09-11**: o backend no #19, a tela no #21.
>
> `POST /v1/auth/age` grava `users.birth_year` quando o ano satisfaz os 16. Quando
> não satisfaz, responde `200` com `{ ok: false, minAge: 16 }`, **não grava o ano**
> e revoga as sessões da conta: guardar "tentou entrar e é menor" acumularia
> justamente o dado que a lei manda não coletar.
>
> O bloqueio mora no `requireUserId`, o único ponto por onde toda rota autenticada
> passa — um guard por rota seria o mesmo código quinze vezes, e a décima sexta
> rota nasceria sem ele. Enquanto `birth_year` for nulo a resposta é `403`, e não
> `401`: a sessão é válida, o que falta é a porta. As exceções são as três que
> precisam funcionar com a porta fechada — `/v1/auth/me`, que é como o cliente
> descobre que precisa perguntar; `/v1/auth/age`, que é a resposta; e o logout,
> senão a conta ficaria presa na única tela que enxerga. O access em circulação
> ainda vale por até 15 minutos depois da recusa, e é por isso que quem segura é a
> porta em toda requisição, não a revogação.
>
> Na tela, com `needsAgeGate` a nav sai junto com o conteúdo: "não passa da tela"
> inclui não contornar por um link. Pede o ano, nunca a data. A decisão de idade é
> do servidor; o cliente só valida a forma do ano, para que digitação pela metade
> não vire recusa. A lógica ficou em `ageGate.ts`, fora do `.tsx`, porque a suíte
> da web roda em `node --test` sem DOM — seis casos, incluindo a prova de que o
> corpo que vai para a rede leva `birthYear` e só ele.

> **β3 fechou em 2026-09-11** (#19). `requireUserId` deixou de aceitar requisição
> sem `Authorization`: o `req` passou a ser obrigatório e o bloco que resolvia o
> usuário por variável de ambiente foi apagado.
>
> O nome da variável não sobreviveu em `apps/`, `.github/` nem `.claude/`, e isso
> é o ponto: enquanto o nome seguisse vivo num `process.env`, o caminho de volta
> para o atalho continuava aberto. O seed não cria mais o usuário de dev, e
> `server.test.ts`, `feed.test.ts` e `swipes.test.ts` passaram a criar e limpar a
> própria conta, como os outros arquivos já faziam — três arquivos de teste
> compartilhando uma conta era o que produzia corrida entre suítes rodando em
> paralelo no mesmo banco.

### P1 — bloqueia confiar no beta

Dá para convidar sem isso. Você só não fica sabendo de nada. **As duas fecharam
em 2026-09-11** (PRs #20 e #23).

| id | Tarefa | Por quê | |
|---|---|---|---|
| β4 | Error handler + log estruturado na api | Hoje um 500 em produção é invisível: sem logger, sem handler, sem nada | ✅ `apps/api/src/obs.ts`, com redação de segredo |
| β5 | Um caminho de retorno do usuário | Beta sem canal de feedback é beta que não ensina nada. Um `mailto:` resolve — não construa formulário | ✅ `mailto:` no rodapé do shell, fora do `user &&`, e os `[PREENCHER]` de contato preenchidos |

> **β4 fechou em 2026-09-11** (#20). Antes, um 500 não deixava rastro nenhum: o
> Fastify subia sem logger e o error handler padrão devolvia a mensagem interna
> ao cliente sem registrar nada em lugar algum. Agora toda requisição sai em uma
> linha JSON, que é como o Fly agrega, e um 500 produz uma linha de nível error
> com stack, método, rota e o id de correlação que o cliente recebeu no corpo —
> a resposta leva só o id. 4xx fica fora do log de erro: 401 sem token e 400 de
> validação são o contrato funcionando, e alerta que dispara no esperado é
> alerta que a gente aprende a ignorar.
>
> **Sem dependência nova.** O pino já vem dentro do Fastify, já escreve JSON por
> linha e já põe o `reqId` no logger filho de cada requisição.
>
> A redação de segredo é o que mais vale, e são duas camadas. Os serializers são
> lista de PERMISSÃO: o padrão do pino despeja toda propriedade própria do erro,
> e um erro do postgres carrega `query` e `parameters` — onde moram o hash do
> refresh e o e-mail. Em cima disso, `scrub()` passa em URL, mensagem e stack. O
> e-mail não é paranoia: `duplicate key … Key (email)=(a@b.com)` vem pronto na
> mensagem do postgres, sem ninguém escrever `log(email)`.
>
> **Medido em produção no mesmo dia:** com `?cursor=VISIVEL123&code=SEGREDO456`,
> a linha de acesso saiu `cursor=VISIVEL123&code=[redigido]` — a redação acerta
> o alvo sem cegar o log. No buffer logo após o deploy, 7×200, 3×401, 2×403 e
> zero linhas de nível error.
>
> **Sentry ficou de fora:** conta nova, SDK novo e egress a partir do processo
> que serve requisição, para um beta de 10 a 30 pessoas em que o `fly logs` já
> mostra a linha. Se a decisão mudar, agora existe linha estruturada para mandar.
>
> **A retenção ficou declarada no mesmo dia**, pelo β1.3 (#29): a política diz
> que log operacional não é retido por nós, envelhece no fluxo do provedor de
> hospedagem e não fica cópia. Isso é consequência direta desta tarefa — o log
> passou a existir, então passou a precisar de declaração.

> **β5 fechou em 2026-09-11** (#23). O link fica no rodapé do shell, que já
> existia para a atribuição do TMDB, e **fora do `user &&`**: quem não consegue
> entrar é justamente quem mais precisa conseguir contar isso.
>
> `mailto:` e não formulário, como o backlog já pedia. Formulário quer rota,
> tabela, moderação e uma tela de "obrigado", e nada disso ensina mais do que um
> e-mail ensina. O assunto vai preenchido para separar o beta do resto da caixa.
> O endereço leva o sufixo `+watchlytics`, que serve para filtrar e **não** para
> proteger: o endereço base continua legível no `href`. Trocar por uma conta só
> do app no dia em que o volume justificar.
>
> O link ficou em linha própria e sublinhado depois de ser visto no navegador:
> colado na atribuição do TMDB, ele lia como a primeira frase do texto legal, e
> ninguém clica em texto legal. Sem teste — é uma constante e um link, não há
> ramo para quebrar; o que vale aqui é a conferência nos dois estados, deslogado
> e logado, com o console limpo. Confirmado depois no bundle publicado.
>
> Junto foram os quatro `[PREENCHER: e-mail de contato]` de `privacy.md` e
> `terms.md`: a política prometia um canal de contato que não existia em lugar
> nenhum, que é o mesmo defeito do β5, só que no papel.
>
> **Falta uma coisa, e é fora do código:** criar o filtro no Gmail para
> `+watchlytics`. Sem ele o sufixo não organiza nada.

### P2 — qualidade do que eles vão ver

| id | Tarefa | Por quê | |
|---|---|---|---|
| β6 | Loop social provado entre duas contas reais | Amizade, match e notificação nunca rodaram entre duas contas distintas *pela tela* | 🔑 precisa de um segundo `sub` do Google — não de uma segunda pessoa. Checklist abaixo |
| β7 | Onboarding conferido contra o catálogo real | O deck estratificado dos 20 swipes foi desenhado para 94 títulos, não para milhares com régua 800 | ✅ medido em 9830 títulos: 20/20 itens e 19/19 gêneros, ~100ms, duas vezes por conta |

### β6 — a checklist, e o que ela NÃO precisa provar

O loop social entre dois usuários distintos **já está provado na suíte**:
`friends.test.ts` cobre busca por handle (E1), normalização do par e as três
listas (E2), as três forças de match (E3), o cruzamento retroativo no aceite com
uma notificação por pessoa em vez de uma por título (E4) e o match forte
notificando na hora (E5). Nada disso precisa ser refeito à mão — refazer teste
verde no navegador é o jeito mais caro de não descobrir nada.

O que a suíte não alcança é tudo o que depende de uma conta **criada pelo
Google** e de uma sessão **de verdade no navegador**. É só isso que a checklist
cobre. E para isso basta um segundo `sub` do Google: qualquer segunda conta que
você já tenha serve para ensaiar, e o primeiro amigo que logar entrega a coisa
real de graça.

| id | O que provar | Pronto quando |
|---|---|---|
| β6.1 | Conta nova entra por OAuth | O handle sai de outro local-part sem colidir; `consents` ganha a linha com a `CONSENT_VERSION` corrente; a porta de idade é cobrada — ela nunca rodou num cadastro real |
| β6.2 | Duas sessões vivas ao mesmo tempo | Navegadores (ou dispositivos) diferentes, cada um rotacionando o próprio cookie de refresh sem derrubar o outro. O C3 trata reuso de refresh como replay e revoga a sessão inteira: duas sessões legítimas não podem disparar isso |
| β6.3 | Amizade ponta a ponta pela tela | A busca B pelo handle e pede; B vê em "Friend requests" e aceita; as três listas ficam certas dos DOIS lados |
| β6.4 | Match e notificação na tela | Os dois curtem o mesmo título e cada um vê o match. Dê um like ANTES do aceite para exercitar o cruzamento retroativo do E4 |
| β6.5 | Perfil público do outro | `/u/<handle>` do outro, com o piso de 10 assistidos respeitado |

**Atenção — o badge leva até 60s.** `NotificationsBadge` faz poll de
`/v1/notifications` a cada 60 segundos (`Friends.tsx:435`), e só a aba de avisos
zera na hora. Notificação que "não chegou" em 10 segundos é o intervalo do poll,
não defeito. Quem testar precisa saber disso antes, senão vira bug reportado.

**Atenção — publique o app no Google antes de chamar alguém.** Os escopos são
`openid email profile`, todos não-sensíveis: app só com escopo não-sensível vai
para "In production" sem verificação do Google. Em modo Testing você tem que
cadastrar o Gmail de cada pessoa antes, o teto é 100, e quem não está na lista vê
"access blocked" — você descobre isso pelo WhatsApp dela.

### Divisão para agentes paralelos

**Fase serial, antes de spawnar** (mesma regra que funcionou na rodada I):
uma migration só, com a coluna que β2 precisa, e o contrato congelado depois.

| Trilha | Escopo | Possui | Não toca |
|---|---|---|---|
| **α — Conformidade** | β1 + a tela do β2 | `docs/legal/*`, `Onboarding.tsx`, `Login.tsx`, `strings.ts` | backend, rotas |
| **β — Observabilidade** | β4 | `apps/api/src/obs.ts` (novo), `server.ts` | rotas, web |
| **γ — Auth endurecida** | β3 + o backend do β2 | `auth.ts`, `apps/api/src/routes/*` | web, docs |

As três são disjuntas por arquivo. α e γ se encontram só no requisito "gravar a
idade": γ faz o backend, α faz a tela, e o contrato entre elas foi congelado na
fase serial.

**As três fecharam em 2026-09-11** (PRs #19, #20, #21 e #22). O encontro entre α
e γ funcionou como desenhado: o backend chegou primeiro e a tela encaixou no
contrato congelado, sem ida e volta. O P0 inteiro está em `main` e no ar.

**Fora das trilhas, e são do usuário:** publicar a tela de consentimento do
Google (ou cadastrar os testadores — o modo Testing tem teto de 100 e só admite
e-mail listado), e convidar as pessoas.
