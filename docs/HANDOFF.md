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

## Estado: 39 de 39 tarefas (+ trilhas de ingestão: 7 de 7)

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

**188 testes** (145 API + 43 web), `npm run check` limpo nos três pacotes e o
`driver.mjs all` com 50 asserções verdes — `api`, `web` e `handle` (recontado em
`main` em 2026-09-13, num banco criado do zero). As 4 vermelhas do `all` são o
limite da fixture de 94 títulos, não regressão: elenco (I1.2) e as duas do
pôster (B4) precisam do catálogo ingerido, e "feed puxa do topo" pisca porque a
mediana fica perto demais do topo. O `social` (23 asserções) roda fora do `all`.

**O β8 fechou em 2026-09-13** (BACKLOG §7): o handle deixou de sair do e-mail.
Toda conta entra com `handle_chosen = false` e escolhe o handle numa porta nova,
logo depois da porta de idade — inclusive as que já existem.

**A fase beta fechou em 2026-09-13**, com o β6 — o último item — provado entre
duas contas Google de verdade em produção.

**E no mesmo dia uma varredura funcional pelo navegador abriu oito itens**
(BACKLOG §8, a β9): dez fluxos que o `driver.mjs` não cobre, dirigidos por CDP.
**Em 2026-09-13 fecharam cinco deles e três das cinco issues abertas**, em cinco
PRs (#61 a #65) mesclados no mesmo dia e conferidos em produção depois do deploy.

Os dois que bloqueavam o convite caíram: a porta de idade passou a mostrar o
aviso que o app escreveu para ela — o `min` do campo fazia a validação nativa
cancelar o envio, e quem respondia era o navegador, no idioma dele — e HSTS está
no ar nas duas origens. O perfil público, que é o link que circula, ganhou
caminho de volta (#37) e `og:image` (#38). Antes deles, a β9.6 tinha tirado PII
de pé: apagar a conta deixava o handle dela no aviso de quem foi amigo.

A β9.2 **não procedia** — foi medida numa branch velha e já estava consertada em
`main` pela auditoria de acessibilidade.

**O que continua aberto:** a trilha F (β9.5, β9.7, β9.8, #40, #41), que é
ferramenta; alinhar o `recusar()` do `auth.ts`, que hoje não produz sobra; e a
CSP do #42, que é tarefa própria com `Report-Only` primeiro. Nenhum deles
bloqueia convidar gente.

Fora do código, para convidar gente: publicar a tela de consentimento do Google
ou cadastrar os testadores (modo Testing, teto de 100), o filtro do Gmail para
`+watchlytics`, e o veredito do gesto no celular.
A trilha **I** (catálogo real, BACKLOG §5) fechou inteira: I0.1 (régua), I0.2
(migration 0003 + `castNames` no contrato), I1 (elenco) e I2 (catálogo vivo).
**`schema.ts` e `contract/index.ts` continuam CONGELADOS** — quem precisar de
coluna nova fala antes em vez de editar. Só a I3 (AniList) segue aberta, e de
propósito: nenhum dos campos dela tem tela que mostre.

## Ambiente — o que custa caro redescobrir

```bash
npm run db:up      # Postgres + pgvector via podman, porta 5433 (a 5432 está ocupada)
npm run migrate
npm run seed       # idempotente por PK, pode rodar sempre
npm run dev:api    # :3000 (PORT troca)
npm run dev:web    # :5173, faz proxy de /v1 (sem CORS; API_ORIGIN troca o alvo)
npm test           # precisa do banco de pé e semeado
npm run check      # typecheck dos 3 pacotes
```

- **Mais de uma sessão na máquina?** Reserve porta e banco antes de subir
  qualquer coisa — a tabela de faixas está no [CLAUDE.md](../CLAUDE.md), seção
  "Porta e banco por sessão". `WL_API_PORT` e `WL_WEB_PORT` movem o
  `driver.mjs`; `A11Y_API_PORT` e `A11Y_WEB_PORT` movem o `tools/a11y`. Porta
  compartilhada não dá erro: dá uma medição que descreve a branch do vizinho.
- **Banco de desenvolvimento também atrasa.** Em 2026-09-13 ele estava três
  migrations atrás (`handle_chosen` não existia) e toda conta de fixture do
  driver morria no insert. `npm run migrate` depois de trocar de branch é mais
  barato que diagnosticar isso.
- **Precisa do catálogo real num banco de DESENVOLVIMENTO? Clone, não ingira.**
  O banco de dev já tem os 9830 títulos: `podman exec watchlytics-db createdb
  -U dev -T watchlytics wl_sN` leva segundos, contra as horas de um
  `npm run ingest` — e dispensa o `TMDB_READ_TOKEN` e o risco de gravar o cursor
  de ingestão no banco errado. Depois, `npm run migrate` com o seu
  `DATABASE_URL` (num clone já migrado, "relation already exists" seguido de
  "migrations aplicadas" é o esperado) e um `analyze`.
  **Nunca clone para o banco de teste.** Ele espera a fixture de 94 do
  `npm run seed`, e com catálogo real o `A5 degrau 1` reprova sem defeito
  nenhum: o teste monta um recorte impossível de propósito (série coreana de
  faroeste depois de 2024) e espera a escada descer `year → genre → type`; com
  9830 títulos o recorte deixa de ser impossível no gênero e a escada para em
  `['year','genre']`. Medido duas vezes, em sessões diferentes, em 2026-09-13 —
  e a suíte leva 85s em vez de ~3s. Não é contagem de linha: as asserções de 20
  são tamanho de página e continuam valendo. É conteúdo.
  E **banco de medição não é banco de teste**: rodar a suíte contra o banco onde
  você mede deixa usuários e swipes para trás (4 e 44, na vez em que isso foi
  medido). Os títulos sobrevivem, mas a conta de "quantos swipes esta conta
  tem?" não — e é dela que sai a latência do feed.
- **Medindo latência contra `localhost:5433`? Desconte ~40ms.** O encaminhador
  de porta do podman rootless trava ~40ms por consulta quando a resposta cruza
  certas fronteiras de pacote — ACK atrasado do Linux encontrando Nagle. Medido
  em 2026-09-13: o mesmo `select * from titles limit 20` custa 0,8ms dentro do
  container e 41,7ms pela porta publicada, com 0,76ms de CPU. Não é do app e não
  existe em produção. Vale para **qualquer** medição que passe por ali,
  `driver.mjs` incluído — ele afirma comportamento e não tempo, então nada do
  que existe hoje fica inválido, mas asserção de duração ali estaria medindo o
  encaminhador. E o absoluto do servidor oscila: o mesmo `EXPLAIN` da query do
  feed deu 21,4ms e 42ms no mesmo dia, sem mudança no banco nem na query —
  **compare execuções inteiras entre si, não números avulsos.** Detalhe e as
  quatro medições que fecham o caso em
  [../tools/feed-bench.md](../tools/feed-bench.md).

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
**A segunda conta Google saiu desta lista em 2026-09-13**, e com ela o β6
inteiro. `@keizoteste` nasceu pelo OAuth em produção — aviso de consentimento
visível no clique que cria, porta de idade cobrada, porta do handle logo atrás —
e o loop social rodou entre ela e `@keizo`: busca por handle, pedido, aceite, as
listas certas dos dois lados e 20 matches com as forças 3 e 2. Detalhes no
BACKLOG §6.

**Saiu desta lista em 2026-09-09:** "conferir o login no Network do DevTools".
Os quatro elos foram medidos de fora e o caminho está inteiro — ver o bloco
abaixo. Não precisa de você.

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

> **Havia aqui a afirmação de que "nenhum login jamais completou — 0 usuários e
> 0 sessões". Era falsa, e contradizia o parágrafo logo acima.** Revalidado em
> 2026-09-09, os quatro elos, cada um medido de fora:
>
> 1. **Front não está inerte.** O `client_id` está compilado no bundle servido
>    (`/assets/index-*.js`) — `VITE_GOOGLE_CLIENT_ID` é build time e a variable
>    do Actions existe.
> 2. **A API aceita o `redirect_uri` que o front manda.** `POST
>    /v1/auth/oauth/google` com `https://watchlytics.pages.dev/` e código falso
>    responde **401 "provedor recusou o código"** — ou seja, passou pela
>    allowlist e falou com o Google. Sem a barra final responde 400: o
>    `REDIRECT_URI` do `Login.tsx` é `${window.location.origin}/`, com barra, e a
>    comparação da allowlist é string exata.
> 3. **O Google não barra.** A URL de autorização com o client id e o
>    `redirect_uri` de produção responde 302 e segue para a tela de login,
>    carregando `app_domain=https://watchlytics.pages.dev`. Um
>    `redirect_uri_mismatch` daria Erro 400 antes de qualquer tela.
> 4. **Existe usuário em produção.** `/v1/users/keizokita1` responde 200 com
>    `avatarUrl` em `lh3.googleusercontent.com` — essa URL só existe se a troca
>    de token com o Google tiver dado certo.
>
> Não dá para contar sessões daqui (sem `flyctl` e sem a URL do Neon), então o
> "0 sessões" não foi refutado nem confirmado. Mas ele não é evidência de login
> quebrado: sessão expira e sai na saída da conta. A hipótese mais provável para
> os zeros originais é consulta ao banco errado — o Neon tem branches.
>
> **Não reabra isto sem um erro observado.** O caminho está medido ponta a ponta.

## Problemas conhecidos

- **EM ABERTO, mecanismo confirmado no código e NUNCA observado rodando: o boot
  desloga por indisponibilidade.** Quem tem sessão válida no cookie e pega a API
  indisponível vai para a tela de entrada, sem erro e sem aviso. São **três
  portas**, não uma, e quem consertar só a primeira fecha um terço:
  - `session.ts:39` — `if (!res.ok) return false`: um 503 é `!ok` como um 401.
  - `session.ts:44` — o `catch`: API fora do ar, sem resposta nenhuma, também
    vira `false`.
  - `Login.tsx:131` — `me.ok ? … : null`: um 503 no `/v1/auth/me` manda para a
    entrada mesmo com o refresh tendo dado certo.

  **`authedFetch` NÃO está afetado**: ele só chama `refreshAccess` quando a
  resposta é exatamente 401 (`session.ts:72`), então um 503 sai por ali direto.
  O estrago é do `resume()`, no boot.

  **Nenhuma verificação atual pega** — a tela deslogada já produz 401 em
  `/v1/auth/refresh` por definição, então "deslogado por engano" é idêntico a
  "sem sessão", e o `driver.mjs` não passa por ali porque planta sessão.

  O cold start **não** é o gatilho: nas duas janelas frias de 2026-09-14, 9
  sondas, todas 401 — o proxy do Fly segura a requisição
  ([../tools/cold-start.md](../tools/cold-start.md)). Sobra 5xx de outra origem:
  piscada do Neon, troca de máquina em deploy. Frequência eventual, não
  previsível.

  O conserto não é retentativa, é parar de colapsar "indisponível" e "sem
  sessão" na mesma resposta. Testável sem produção: `fetch` stubado devolvendo
  503 e a asserção de que a sessão sobrevive. `errorOffline`, `errorGeneric` e
  `retry` já existem no `strings.ts` e o `Login` já renderiza `error`, então
  provavelmente não precisa de string nova nem de arquivo compartilhado.
- **O cold start está medido e NÃO bloqueia o beta.** Retomar de suspensão
  custa 0,42–0,57s, sem um único 5xx. Mas só o caminho `suspend → resume` foi
  medido; `stopped → start` (deploy, ou o Fly convertendo suspenso em parado)
  continua sem número, e é o caminho provável de quem abre o link depois de uma
  noite sem tráfego. O `~6s` do `fly.toml` e o *"meio minuto de ociosidade"* do
  `Login.tsx` não descrevem o que foi medido: a ociosidade até suspender é
  ~7min33s. Detalhe e as duas formas de graça de fechar a lacuna em
  [../tools/cold-start.md](../tools/cold-start.md).
- **EM ABERTO, e não confirmado: swipe que some depois do onboarding.** Em
  2026-09-13, com duas contas reais, os swipes de `@keizoteste` geraram match
  normalmente **durante** o onboarding (20 linhas entre 04:17 e 04:23). Depois
  dele, likes dados no deck com filtro de gênero não produziram match nenhum,
  mesmo com 46 títulos do mesmo gênero curtidos do outro lado e a consulta sendo
  simétrica. **Não há diagnóstico ainda:** falta olhar, na conta que swipou, se
  os títulos estão em `Library → Interested` e se `localStorage.getItem('wl.swipes')`
  tem fila presa. As três hipóteses são fila que não descarrega (B6), swipe que
  não vira `library_entries`, e defeito no `matchOnLike` — e o conserto é
  diferente em cada uma. O `driver.mjs web` cobre esse caminho inteiro e
  **passa**, então o recorte não é "a fila está quebrada": é produção, ou janela
  anônima, ou aquela sessão. Não é bloqueio do beta — o β6 fechou com os 20
  matches que existem —, mas é swipe que a pessoa deu e o servidor talvez não
  tenha visto, o que é sério se for real.
- **Título buscado e sem elenco é normal, não falha.** Três casos no banco de
  dev: JUJUTSU KAISEN, Black Mirror e Love, Death & Robots. O `/credits` do TMDB
  não devolve elenco fixo para antologia nem para boa parte do anime. É por isso
  que `credits_synced_at` preenchido com `cast_names` vazio é um estado
  esperado, e diferente de *nunca buscado* — e é o caso que o `{cast && ...}` do
  `Card.tsx` existe para tratar.
- **O print do driver quase nunca mostra o pôster.** Cada run sobe um vite novo,
  que força um page reload logo depois do primeiro load; a foto sai do documento
  recém-recarregado, antes de a imagem pintar. O app está certo — a asserção do
  B4 lê `url(...), linear-gradient(...)` no `background` e passa. Não conclua
  regressão de pôster a partir do `web.png`, e não meça carregamento com
  `performance.getEntriesByType("resource")`: essa lista é por documento e zera
  no reload. A contagem da pré-carga usa `page.requests` do CDP por esse motivo.

- **Flake não explicado:** `A5 degrau 1` falhou uma vez e não reproduziu em 6
  tentativas, incluindo com banco sujo e simulando primeira execução. Se
  aparecer de novo, há uma pista a mais.
  **Pista de 2026-09-13, e o mecanismo está medido:** contra um banco com o
  catálogo real em vez da fixture de 94, essa asserção reprova *sempre* (ver a
  bullet do clone em §Ambiente). Então a pergunta útil não é "flake?", é **qual
  comando foi usado**:

  | comando | banco | resultado |
  |---|---|---|
  | `npm test` | o de teste, sempre | seguro por construção |
  | `node --test src/routes/feed.test.ts` | nenhum | morre alto: "DATABASE_URL não definida" |
  | `node --env-file-if-exists=.env --test src/…` | **o de DEV** | `A5 degrau 1` reprova sem defeito |

  O `npm test` é seguro porque o `--env-file` do Node **não** sobrescreve
  variável já definida, então o `DATABASE_URL=` inline do script sempre ganha
  (medido nas duas árvores). O caminho humano que produz o falso vermelho é
  copiar o comando de dentro do `package.json` para rodar um arquivo só e deixar
  o prefixo para trás. Não é intermitente: é determinístico contra o banco
  errado, e o que oscila é o comando. Isso **não** prova que foi o que aconteceu
  na ocorrência registrada acima — mas é a primeira coisa a perguntar.

  Proposta registrada e **não implementada**, para quem for dono de
  `db/client.ts`: recusar a subida sob `node:test` quando o banco não termina em
  `_test` fecharia a classe inteira em ~4 linhas, em vez desta ocorrência. Dá
  para escrever sem heurística — o runner se identifica em
  `process.env.NODE_TEST_CONTEXT` (`"child-v8"` dentro do teste, indefinido
  fora; medido no v25.4.0), e a convenção `_test` já vale em todos os bancos.
  Falha alta dizendo qual banco veio, nunca silenciosa.
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
  é ela que os testes esperam. O banco de **desenvolvimento** também já saiu
  dela: medido em 2026-09-08, são **9830 títulos e 9830 com `poster_url`** — ou
  seja, nenhuma linha sem pôster, e o deck local exercita o caminho da imagem em
  todo card. Há duplicatas, mas de título repetido no próprio catálogo do TMDB
  (`Return` ×7, `Pinocchio` ×4, `Teenage Mutant Ninja Turtles` ×4), não de
  fixture convivendo com ingestão.
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

**O plano está em [BACKLOG.md §8](./BACKLOG.md)** — a β9, com os oito achados da
varredura, as cinco issues abertas, quem possui qual arquivo e em que ordem
entra. Aqui fica só a ordem de quem vai começar agora.

1. **Convidar as primeiras pessoas.** Não depende de código, e desde
   2026-09-13 não depende mais de acabamento nenhum: publicar a tela de
   consentimento do Google ou cadastrar os testadores no modo Testing (teto de
   100, só e-mail listado).
2. **Veredito do gesto no celular** (§Bloqueado 1). Duas perguntas que revertem
   decisões já tomadas; nenhuma se responde no terminal, só com o app na mão.
3. **Trilha F** (BACKLOG §8), quando incomodar: hoje o `driver.mjs all` termina
   vermelho na última asserção do `handle`, e a causa está diagnosticada — o
   próprio driver aborta o fetch ao recarregar a página (β9.8). Verde de novo
   vale mais depois do convite do que antes dele.

As trilhas P, H, U e V fecharam nos PRs #62, #63, #64 e #65, e a β9.6 no #59.

As trilhas V (cor) e F (ferramenta) cabem depois do convite. E fica registrado
que o `driver.mjs all` termina vermelho hoje na última asserção do `handle`, por
um `fetch` que o próprio driver aborta ao recarregar a página — é a β9.8, e não
é regressão do app.

O β5 fechou junto (PR #23): o retorno é um `mailto:` no rodapé do shell, fora
do `user &&`, porque quem não consegue entrar é quem mais precisa contar isso —
e com ele saíram os quatro `[PREENCHER: e-mail de contato]` que a política tinha
deixado em aberto. O β7 fechou também:
o deck do onboarding foi medido contra os 9830 títulos e entrega 20/20 itens
cobrindo os 19 gêneros em ~100ms, duas vezes na vida de cada conta — o porquê
de não virar tabela materializada está no comentário de `routes/onboarding.ts`.

A trilha I saiu do caminho: a I1 fechou inteira em 2026-09-10, passada incluída
— 9830 títulos em 1717s, fila zerada, **9769 com elenco**, média de 4,86 nomes.
Rodou pelo topo do score primeiro (é o índice parcial `titles_sem_elenco`
funcionando), então o deck tinha elenco muito antes do fim. Os 61 sem elenco não
são falha: antologia (`Black Mirror`) e animação sem diálogo (`Flow`), e nenhum
404.

A I2 fechou em 2026-09-12 e entrou junto das outras três na integração do mesmo
dia. `npm run ingest:changes` atualiza só a interseção entre o que o TMDB marcou
como alterado e o nosso catálogo — reproduzido numa cópia dos 9834 títulos de
produção: 239s, 10067 ids listados, 1300 nossos atualizados, zero inserção, zero
exclusão e **zero uuid trocado**. O elenco da I1 sobrevive à atualização: o
`UPDATE` não lista `cast_names` nem `credits_synced_at`.

O pull-through da I2.2 é FILA, não leitura que escreve — nada fora de
`src/ingest/` importa o módulo e nenhuma rota mudou. Medido com os 9834 títulos
marcados como frios: `/v1/feed` respondeu em 33ms e 26ms, sem uma chamada ao
TMDB. O agendamento diário **não** foi feito: "diário" aqui é o comando ser
barato o bastante para rodar todo dia, e pôr isso no `fly.toml` é operação contra
produção.
