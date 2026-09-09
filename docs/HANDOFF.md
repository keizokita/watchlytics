# Handoff — contexto para retomar o projeto

> Para uma sessão nova (outro chat, outra pessoa) entrar sem repetir descobertas.
> Mantenha atualizado: se algo aqui ficar falso, corrija junto com a mudança.

## O produto

Watchlytics — descoberta de filmes, séries e anime por swipe. Direita = LIKE,
esquerda = descarte. O LIKE vira catálogo pessoal, e sobre isso existe uma
camada social com match entre amigos.

**v1 é só web** (desktop + mobile browser). O app nativo é a fase 4 e **reusa a
API inteira** — é por isso que a API é separada, sem sessão por cookie e sem
HTML renderizado no servidor. Toda decisão de arquitetura protege esse caminho.

## Leia antes de mexer

| | |
|---|---|
| [PLAN.md](./PLAN.md) | Decisões de produto e arquitetura, com o porquê de cada uma |
| [BACKLOG.md](./BACKLOG.md) | 39 tarefas em 6 trilhas, dependências e critério de pronto |
| [DEPLOY.md](./DEPLOY.md) | Neon + Fly + Cloudflare, passo a passo |

O `git log` é documentação de verdade aqui: cada commit explica a decisão, não
só a mudança. Vale ler antes de propor refazer algo.

## Estado: 39 de 39 tarefas (+ trilhas de ingestão: 1 de 7)

| Trilha | | |
|---|---|---|
| **S** esqueleto | 7/7 | completa — em produção, com login real atravessado |
| **A** feed | 8/8 | backend e UI de filtro completos |
| **B** swipe | 7/7 | completa — B4 fechado em `b4/poster-com-fallback` |
| **C** identidade | 6/6 | completa e exercitada contra o Google real em produção |
| **D** catálogo | 5/5 | completa |
| **E** social | 6/6 | completa |

**Funciona ponta a ponta:** Postgres → API Fastify → deck no navegador. Swipe
com gesto, teclado, undo e fila offline; o catálogo inteiro passa uma vez sem
repetir; o LIKE vira coleção com abas e estatísticas.

**106 testes** (89 API + 17 web), `npm run check` limpo nos três pacotes e as
18 asserções do `driver.mjs all` verdes (2026-09-08).
A trilha **I** (catálogo real, BACKLOG §5) tem só I0.1 fechada; I0.2 é o portão
serial que segura I1 e I2.

## Ambiente — o que custa caro redescobrir

```bash
npm run db:up      # Postgres + pgvector via podman, porta 5433 (a 5432 está ocupada)
npm run migrate
npm run seed       # idempotente por PK, pode rodar sempre
npm run dev:api    # :3000
npm run dev:web    # :5173, faz proxy de /v1 (sem CORS)
npm test           # precisa do banco de pé e semeado
npm run check      # typecheck dos 3 pacotes
```

- **Node ≥24.** O projeto executa `.ts` direto, sem `tsx` e sem build step. Só
  `packages/contract` compila — type stripping não vale dentro de `node_modules`.
- **Sempre `npm run build -w @watchlytics/contract`** depois de mexer no
  contrato, antes de `check` ou `test`. Esquecer disso produz erro de export
  que parece bug de código.
- `apps/api/.env` é gitignored. Copie de `.env.example`. Precisa de
  `DATABASE_URL`, `DEV_USER_ID` e `AUTH_SECRET` (≥32 chars).
- Se `npm run` reclamar de `ERR_UNKNOWN_FILE_EXTENSION`, há um pacote `node`
  antigo em algum `node_modules` acima do projeto sombreando o nvm.

## Convenções

- **Comentários em português; strings de UI em inglês**, centralizadas em
  `apps/web/src/strings.ts` (o mercado do v1 é global).
- **Comentário explica POR QUE, não o quê.** Simplificação deliberada leva um
  `ponytail:` nomeando o teto e o caminho de saída. Há vários no código — são
  dívida rastreada, não descuido.
- **Estilo enxuto.** Nenhuma abstração sem uso real, nenhuma dependência nova
  sem justificativa forte. Runtime hoje: `fastify`, `drizzle-orm`, `postgres`,
  `zod`, `react`, `react-dom`. Sem Redis, sem storage, sem lib de JWT, sem
  framer-motion — todas decisões conscientes, com o motivo no commit.
- **Testes com `node:test` + `node:assert/strict`**, sem framework. Um teste por
  lógica que pode quebrar em silêncio; constraint de banco vale mais que teste.
- **Nunca simplifique**: validação de entrada na borda com Zod, segurança,
  acessibilidade, e tratamento de erro que evita perda de dado.
- Arquivo de teste roda em processo próprio e **em paralelo** contra o mesmo
  banco. Teste que escreve muito cria usuário próprio (veja `library.test.ts`).

## Decisões que já foram tomadas — não reabra sem motivo novo

Detalhe e justificativa no PLAN §1. Resumo do que costuma ser questionado:

- **Fonte de catálogo: TMDB.** Fechada em 04/09/2026 junto com a decisão de não
  monetizar — o tier gratuito é não-comercial, e é exatamente o nosso caso.
  `title_external_ids` continua sendo o seguro contra troca de fornecedor.
- **Não haverá monetização.** Reabrir isso obriga a reabrir a fonte de dados
  ANTES de cobrar, não depois.
- **Anime é gênero (id 3), não tipo.** Um anime é filme OU série.
- **`swipes` é upsert com PK `(user_id, title_id)`, não append-only.** É essa
  PK que dá dedup, o "já avaliei?" do feed e a idempotência do buffer offline.
- **Match só entre amigos** no v1, mas `taste_vector` já é `vector(19)`.
- **Mercado global, base em inglês.**
- **Só OAuth, sem senha.** Login nunca é por email — a chave é
  `identities (provider, provider_user_id)`.
- **Perfil público mostra só estatísticas agregadas**, com piso de 10 assistidos.

## Bloqueado na pessoa, não no código

1. **Veredito do gesto no celular.** Uma pergunta em aberto que reverte
   decisão: o gesto tem peso? (senão, `framer-motion` se justifica). A outra —
   "o card convence sem pôster?" — perdeu o objeto: agora há pôster.

As contas do S7 e as credenciais do Google saíram desta lista em 2026-09-03; o
fornecedor de catálogo saiu em 2026-09-08, fechado em TMDB, e a régua (I0.1)
fechou no mesmo dia em 800. Os secrets do CI foram cadastrados em 2026-09-08 e
os três jobs passam em `main`.

O que está provado hoje, e vale mais escrito do que redescoberto:

- **api** <https://watchlytics-api.fly.dev> — `/health` devolve `{"ok":true}`,
  uma máquina em `gru` com auto-suspend.
- **front** <https://watchlytics.pages.dev> — a Function de `/v1/*` e `/u/*`
  faz proxy para o Fly. Origem única, sem CORS, como o PLAN previa.
- **banco** Neon com pgvector, schema migrado e **7583 títulos do TMDB**
  (`--min-votes 800`, anime 80, reality 50). A fixture de 94 foi apagada em
  2026-09-08 e o seed saiu do `release_command` — não o devolva, o porquê está
  no `fly.toml`.
- **OAuth Google validado em produção**: `redirectUri` fora da allowlist leva
  400 e um `code` falso leva 401 "provedor recusou o código" — ou seja, client
  id e secret estão carregados e a troca com o Google acontece de verdade.

**Atravessado de ponta a ponta em 2026-09-04**: login Google real (usuário
`keizokita1`), onboarding com os 20 swipes gravados no Postgres de produção, e
`/u/keizokita1` servindo `og:url` com o `PUBLIC_ORIGIN`. O S7 é ✅.

E há um terceiro, maior: **nenhum login jamais completou** — 0 usuários e 0
sessões no banco de produção. O que a linha acima prova é que a troca com o
Google acontece; não prova que alguém atravessou ela até o fim. Falta saber se o
`POST /v1/auth/oauth/google` chega a ser chamado ou se o Google barra antes com
`redirect_uri_mismatch`, e isso só o Network do DevTools responde.

## Problemas conhecidos

- **Flake não explicado:** `A5 degrau 1` falhou uma vez e não reproduziu em 6
  tentativas, incluindo com banco sujo e simulando primeira execução. Se
  aparecer de novo, há uma pista a mais.
- **C1 é dívida com prazo, e o cliente já saiu dela.** O shim `DEV_USER_ID` em
  `auth.ts` injeta usuário fixo; produção não define a variável e responde 401.
  O lado web não depende mais dele: o token vive em `apps/web/src/session.ts` e
  todo fetch autenticado (feed, fila de swipes, undo, onboarding, conta, social)
  manda `Authorization` pelo helper `auth()`. Falta remover o shim do servidor,
  e isso só acontece com o OAuth de verdade em produção — não deixe virar
  permanente.
- **A fixture esgotava numa sessão** — 94 títulos com o onboarding do D4
  consumindo 20 na porta de entrada. Resolvido em 2026-09-08: 7583 títulos do
  TMDB, ~378 decks de 20. O do CI e o `watchlytics_test` continuam na fixture, e
  é ela que os testes esperam. O banco de **desenvolvimento** tem os dois:
  9924 títulos, dos quais os 94 da fixture não têm `poster_url` e têm o maior
  `score` — ou seja, o topo do deck local é justamente o que não exercita o
  pôster (e Inception, Interstellar e outros aparecem duplicados).
- **O shim escondeu um 401 até a produção.** Com login válido, `/v1/feed`
  respondia 401 no ar porque o front nunca mandava `Authorization`; em dev o
  `DEV_USER_ID` atendia a requisição sem header e o bug não aparecia. Foi o
  deploy que revelou, não o teste — um shim que substitui a autenticação
  esconde exatamente a classe de bug que ele finge cobrir.
- **`POST /v1/swipes` passou a respeitar o Bearer.** Antes chamava
  `requireUserId()` sem `req`, então swipe de usuário logado era gravado no
  `DEV_USER_ID`. Com OAuth em produção isso teria misturado catálogo de gente
  diferente.
- **Rate limit é por instância** (Map em memória). Com duas máquinas no Fly, o
  teto dobra.
- **A notificação carrega o texto pronto.** `friendHandle` e `title` vão
  dentro do payload, não só os ids: a caixa é instantâneo, não consulta. Um
  handle trocado depois não reescreve aviso antigo — e é por isso que a tela
  não faz um fetch por linha.
- **CSS de tela mora em `screenCss.ts`.** As classes `.lib-*` eram do
  `Library.tsx` e não existiam quando a tela de amigos montava: mesmas classes,
  aparência de formulário cru. O `index.html` continua sendo só do deck.
- **A aba da tela social vive no hash** (`#/friends/common`). É o que deixa o
  botão voltar funcionar e o que torna a tela dirigível pelo driver.

## Próximos passos sugeridos

1. **I0.2 — congelar `schema.ts` e `contract/index.ts`.** Portão serial que
   sobrou: uma migration com todas as adições que I1 e I2 precisam, antes de
   spawnar qualquer agente. Foram os pontos de contenção da rodada anterior.
2. **Remover o shim `DEV_USER_ID`** do `auth.ts`. A condição que segurava isto
   caiu: um login real completou em produção, então o shim já não é o único
   caminho de entrada. O cliente saiu dele no S7+C1; falta o servidor.
3. **Veredito do gesto no celular** (§Bloqueado 1). Duas perguntas que revertem
   decisões já tomadas; nenhuma se responde no terminal, só com o app na mão.
4. **Trilha I — elenco no card (I1.1 → I1.2).** Com as 39 fechadas, é o que
   sobra de conteúdo antes do beta; I0.2 já congelou o contrato que ela usa.
