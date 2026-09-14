# Deploy (S7)

Tudo que não depende de credencial já está no repositório e **foi verificado
localmente**: imagem construída, `release_command` rodado, `/health` e `/v1/feed`
respondendo pela porta publicada, shutdown gracioso em 0.10s.

O que falta são as três contas. Todas em tier gratuito.

## Arquitetura do deploy

```
navegador ──► Cloudflare Pages (estático + Function)
                      │  /v1/*  e  /u/*  proxy
                      ▼
                 Fly.io (api, container)
                      │
                      ▼
                 Neon (Postgres + pgvector)
```

**Por que o proxy e não CORS:** mantém origem única. `pages.dev` e `fly.dev` são
domínios registráveis diferentes, então sem o proxy o refresh token em cookie
`httpOnly` (tarefa C3) seria cookie de terceiro — bloqueado pelos navegadores.
Custo: um hop pelo edge. Ganho: nada de CORS e `SameSite=Lax` funcionando.

---

## 1. Neon (banco)

1. Criar projeto em [neon.tech](https://neon.tech), região mais próxima do Fly.
2. Copiar a connection string do endpoint **direto (unpooled)**.

> Use o endpoint direto, não o pooled. O pooler do Neon é PgBouncer em modo
> transaction, e ele briga com prepared statements do `postgres.js` e com DDL de
> migration. Na escala alvo (~10k usuários, máquinas com auto-stop) a contagem de
> conexões não é problema. Trocar para pooled só quando o Fly escalar horizontal.

A extensão `vector` é criada pelo próprio `migrate.ts` — nada manual.

## 2. Fly (api)

```bash
# flyctl não está instalado nesta máquina
curl -L https://fly.io/install.sh | sh

fly auth login
fly apps create watchlytics-api          # nome é global; se estiver tomado,
                                         # troque em apps/api/fly.toml também

fly secrets set DATABASE_URL='<string do Neon>' -a watchlytics-api
fly secrets set AUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" -a watchlytics-api
fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile
```

> Falta um terceiro secret, o `TMDB_READ_TOKEN`, sem o qual o catálogo nunca se
> atualiza. Ele tem passo próprio na [seção 5](#5-ingestão-do-catálogo-i2),
> junto do agendamento que o usa.

O `release_command` roda `migrate` antes de trocar as máquinas — se a migration
falhar, o deploy aborta sem derrubar o que está no ar.

Verificar:

```bash
curl https://watchlytics-api.fly.dev/health          # {"ok":true}
curl https://watchlytics-api.fly.dev/v1/feed         # 401 não autenticado
```

> `primary_region = "gru"` (São Paulo) porque é de onde você desenvolve. O
> mercado é global, então quando houver usuário fora do Brasil vale medir e
> considerar `iad`. Trocar região é uma linha.

> O `seed` saiu do `release_command` em 2026-09-08: o catálogo de produção é o
> do TMDB (7583 títulos, `--min-votes 800`) e a fixture foi apagada. O porquê de
> não devolvê-lo está em [`fly.toml`](../apps/api/fly.toml). O CI continua
> semeando — lá a fixture é o que os testes esperam.

## 3. Cloudflare Pages (web)

```bash
npx wrangler login
npx wrangler pages project create watchlytics --production-branch main
```

O `API_ORIGIN` que a Function usa **não** vai no painel: está em
[`apps/web/wrangler.toml`](../apps/web/wrangler.toml). É URL pública, não
segredo, e no arquivo ela aparece no diff e o deploy do CI já sai configurado —
variável cadastrada na UI é passo manual que ninguém repete. Sem ela a Function
devolve 500 com mensagem explícita, em vez de falhar silenciosamente.

Primeiro deploy manual:

```bash
npm run build -w @watchlytics/contract
VITE_GOOGLE_CLIENT_ID=<client id> npm run build -w @watchlytics/web
cd apps/web && npx wrangler pages deploy dist --project-name=watchlytics
```

O `cd apps/web` importa: o wrangler só enxerga `functions/` a partir do cwd.

> `VITE_GOOGLE_CLIENT_ID` é lido em **build time** (`Login.tsx`). Buildar sem
> ele sobe um front que mostra a tela de login e estoura ao clicar.

## 3b. Google OAuth

Cliente "Web application" em
[console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials):

| Campo | Valor |
|---|---|
| Authorized JavaScript origins | `https://watchlytics.pages.dev`, `http://localhost:5173` |
| Authorized redirect URIs | `https://watchlytics.pages.dev/`, `http://localhost:5173/` |

A **barra final** não é decoração: `Login.tsx` monta `${origin}/` e o servidor
compara byte a byte com a allowlist.

```bash
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  GOOGLE_REDIRECT_URIS='https://watchlytics.pages.dev/' -a watchlytics-api
```

`GOOGLE_REDIRECT_URIS` de produção leva **só** a URL de produção. Incluir
`localhost` ali deixaria desviar um código de produção para a máquina de quem
pedir.

> A tela de consentimento em **Testing** só admite quem estiver na lista de test
> users (teto de 100). Antes de convidar gente para o beta, adicione os testers
> em [Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience)
> — vale na hora, sem revisão.

Para **publicar** (sair do Testing e tirar o teto), o formulário pede homepage e
link da política, e os domínios precisam estar em *Authorized domains*
verificados no Search Console. O que colar:

| Campo | Valor |
|---|---|
| Application home page | `https://watchlytics.pages.dev/` |
| Privacy policy link | `https://watchlytics.pages.dev/legal/privacy` |
| Terms of service link | `https://watchlytics.pages.dev/legal/terms` |

**Sem o `.html`.** Medido em 2026-09-13: `/legal/privacy.html` responde **308**
para `/legal/privacy`, que é onde a página está. O formulário do Google valida a
URL que você colar, e campo obrigatório apontando para redirecionamento é risco
desnecessário justamente no passo que trava a publicação.

As duas páginas são geradas no build por `apps/web/legal.mjs` a partir de
`docs/legal/*.md` — é por isso que elas ficam no domínio do app e não no
GitHub, que não dá para verificar como domínio nosso.

> **Os `[PREENCHER]` saíram em 2026-09-11 (β1).** Os cinco campos que este aviso
> cobrava estão respondidos: controlador nomeado (pessoa física, no Brasil),
> encarregado, representante na UE, data de vigência (`2026-09-11`) e lei
> aplicável (Brasil, comarca de Maringá). `git grep PREENCHER docs/legal/` não
> devolve nada. Publicar deixou de estar bloqueado por aqui.
>
> **O que sobrou é condição, não campo em branco.** O encarregado (LGPD art. 41)
> e o representante na UE (GDPR art. 27) estão declarados como **não nomeados**,
> cada um com a isenção que o dispensa — porte pequeno na Resolução CD/ANPD nº
> 2/2022, e o art. 27(2)(a) para processamento ocasional, sem categoria especial
> e de baixo risco. As duas isenções descrevem o beta fechado de hoje: sair do
> convite-only, ou crescer, reabre as duas, e a própria política promete nomear
> um representante antes disso. Reler as duas linhas antes de abrir ao público.
>
> O que o formulário de publicação ainda cobra de verdade são os *Authorized
> domains* verificados no Search Console — ver o parágrafo acima.

### Plano para publicar (sair do Testing)

Publicar não é preferência: em **Testing o refresh token expira em 7 dias**.
Num beta de duas semanas todo mundo é deslogado no meio, vê tela de login de
novo e uma parte não volta. Some com isso o teto de 100 e o cadastro manual de
cada e-mail.

A favor: os escopos são `openid email profile`, **não sensíveis**. Aplicativo
que só pede escopo básico não passa pela revisão de verificação.

| # | Passo | Onde |
|---|---|---|
| 1 | Conferir que as duas páginas legais abrem, **sem `.html`** | `curl -o /dev/null -w '%{http_code}' https://watchlytics.pages.dev/legal/privacy` |
| 2 | Preencher home page, política e termos com as URLs da tabela acima | [Auth Platform → Branding](https://console.cloud.google.com/auth/branding) |
| 3 | Verificar `watchlytics.pages.dev` no Search Console e pôr em *Authorized domains* | [Search Console](https://search.google.com/search-console) |
| 4 | Publicar | Auth Platform → Audience → *Publish app* |
| 5 | Entrar com uma conta FORA da lista de testers, em anônimo | prova que o teto caiu |

**NÃO envie logo.** Upload de logotipo dispara a revisão de marca, que é
processo de dias. Sem logo, a tela mostra o nome do app e segue.

**O risco real é o passo 3.** `pages.dev` está na Public Suffix List, então o
Search Console trata cada subdomínio como site próprio e a verificação por
arquivo ou meta tag deve funcionar. Se o Google recusar o domínio mesmo assim,
a saída é domínio próprio apontado para o Pages — e aí muda também
`GOOGLE_REDIRECT_URIS`, `PUBLIC_ORIGIN` e as origens autorizadas. Descubra isso
ANTES de avisar as pessoas.

**Se publicar travar**, Testing atende 10 a 30 pessoas. O preço é o relogin
semanal, e ele precisa estar dito no convite — senão parece defeito.

## 4. GitHub (CI)

O workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) roda
typecheck, migration, seed, checagem de idempotência do seed e o teste de
contrato do feed; em `main`, deploya as duas pontas.

Em Settings → Secrets and variables → Actions.

**Secrets:**

| Secret | Onde obter |
|---|---|
| `FLY_API_TOKEN` | `fly tokens create deploy -a watchlytics-api` |
| `CLOUDFLARE_API_TOKEN` | painel Cloudflare → API Tokens → **Create Custom Token**, permissão `Account` → `Cloudflare Pages` → **Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | `npx wrangler whoami` |

**Variables** (não são segredo, e `vars` deixa isso explícito):

| Variable | Para quê |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | build do front; sem ela o login sobe inerte |

> Use o token de **Pages → Edit**, não o template "Edit Cloudflare Workers":
> Pages e Workers são permissões separadas.

O CI **não** precisa de `DATABASE_URL` de produção: ele sobe um Postgres com
pgvector como service container.

---

## 5. Ingestão do catálogo (I2)

O código que mantém o catálogo vivo já existe (`ingest/changes.ts`), mas em
produção falta o secret e falta quem o chame todo dia. Catálogo que não se
atualiza apodrece: em doze meses não tem nenhum título do ano.

### Onde a passada diária roda

Num **workflow agendado do GitHub** que cria uma **máquina efêmera no Fly**:
[`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml).

O relógio é do GitHub; a execução é do Fly. `fly console` levanta uma máquina a
partir da imagem do último release, roda o comando e a destrói. Como a máquina
nasce dentro do app, ela herda os secrets do app — `DATABASE_URL` e
`TMDB_READ_TOKEN` não passam pelo GitHub. O único secret que o workflow usa é o
`FLY_API_TOKEN`, que já está cadastrado para o deploy. **Nenhum secret novo.**

As duas alternativas e por que não:

| Alternativa | Por que não |
|---|---|
| Máquina agendada do Fly (`fly machine run --schedule daily`) | É criada uma vez, fora do `fly deploy`, e fica presa na imagem daquele dia. Meses depois a ingestão roda código velho e ninguém percebe — o mesmo apodrecimento que ela existe para evitar. E a falha só aparece para quem for olhar `fly logs` de uma máquina que já esqueceu que existe. |
| Actions com a `DATABASE_URL` de produção nos secrets | Exposição nova: a credencial do banco num terceiro lugar, legível por qualquer workflow do repositório. O desenho acima entrega o mesmo agendamento sem ela. |

O `auto_stop`/`min_machines_running = 0` da máquina de serviço **não** atrapalha
nenhum dos dois: a máquina da ingestão é outra, efêmera, e não está no pool do
`http_service`.

> Uma passada perdida se recupera sozinha. O cursor fica em `ingest_state`, e o
> `janelas()` fatia de onde parou até hoje em janelas de até 14 dias. Por isso o
> agendamento não precisa de retry, alerta nem fila: um dia sem rodar custa um
> dia a mais na passada seguinte.

### O que executar, em ordem

**1. Pegar o token do TMDB.** Em
[themoviedb.org/settings/api](https://www.themoviedb.org/settings/api), copiar o
**API Read Access Token (v4)** — é o JWT longo, não a "API Key (v3)". O
`ingest/http.ts` manda `Authorization: Bearer`, e a chave v3 não serve.

**2. Cadastrar como secret do Fly:**

```bash
fly secrets set TMDB_READ_TOKEN='<read access token v4>' -a watchlytics-api
```

> `fly secrets set` reinicia as máquinas do app. Faça junto de um deploy ou
> fora do horário de uso.

**3. Deployar a branch da ingestão.** O workflow usa a imagem do **último
release** — se `ingest/changes.ts` ainda não estiver nela, a máquina efêmera
sobe sem o arquivo. Um push em `main` com o código do I2 já resolve (o CI
deploya).

**4. Conferir sem escrever nada:**

```bash
fly console -a watchlytics-api -C "node apps/api/src/ingest/changes.ts --dry-run"
```

Saída esperada: uma linha `changes tmdb | de <ontem> a <hoje> | 1 janela(s) ...`
e, no fim, `fim em Ns | ... | DRY-RUN`. Se der
`TMDB_READ_TOKEN ausente`, o passo 2 não pegou; se der erro de módulo não
encontrado, é o passo 3.

**5. Rodar a primeira passada de verdade** pela UI: Actions → *ingestão diária
(tmdb /changes)* → **Run workflow**. É o mesmo caminho que o cron vai usar, e é
o que prova que o `FLY_API_TOKEN` tem permissão de criar máquina. A partir daí
ela roda sozinha às 06:00 UTC (03:00 em São Paulo).

**6. Conferir que o cursor andou:**

```sql
select key, value, updated_at from ingest_state where key = 'changes_cursor';
```

### Uma vez só, não agendado

O catálogo de produção foi carregado antes do I1, então **os títulos de lá não
têm elenco** — o card não mostra a linha. A passada de elenco é um comando à
parte, retomável, e roda no mesmo lugar:

```bash
fly console -a watchlytics-api -C "node apps/api/src/ingest/credits.ts"
```

Levou ~29 min para 9830 títulos no banco de dev. Se cair no meio, rodar de novo
continua de onde parou — a fila é a coluna `credits_synced_at`.

> **Uma ingestão por vez.** A pausa de 60ms do `ingest/http.ts` é estado de
> módulo, logo por processo: dois comandos ao mesmo tempo são duas janelas
> contra a mesma cota do TMDB. Não rode o de elenco enquanto o workflow diário
> estiver rodando.

### O que pode dar errado depois

- **O GitHub desliga cron de repositório parado há 60 dias.** Chega por e-mail e
  volta com um clique em Actions — ou com qualquer push.
- **Run cancelado por timeout deixa a máquina efêmera de pé.** `fly machine
  list -a watchlytics-api` mostra; `fly machine destroy <id>` limpa.
- **`FLY_API_TOKEN` expirado** aparece como falha no passo do `flyctl`, não como
  passada vazia.

---

## Definition of done do S7

- [ ] `https://watchlytics-api.fly.dev/health` devolve `{"ok":true}`
- [ ] A URL pública do Pages mostra o card do Breaking Bad
- [ ] `/v1/feed` na URL do Pages devolve o 401 JSON da api, não um erro do Pages
      (o feed exige sessão desde o C1; o que se prova aqui é o proxy, não o feed)
- [ ] `PUBLIC_ORIGIN` definida no Fly com a URL do Pages, e `/u/<handle>` de um
      perfil público abre com as OG tags (é o que o WhatsApp lê)
- [ ] Um push em `main` dispara o CI e redeploya as duas pontas
- [ ] `TMDB_READ_TOKEN` no `fly secrets list` e o workflow *ingestão diária*
      verde num disparo manual, com `changes_cursor` gravado em `ingest_state`

## Custo

Zero enquanto estiver nos tiers gratuitos. O que muda isso primeiro é o Neon
(limite de horas de compute e storage); Fly com `min_machines_running = 0`
suspende quando ninguém acessa.

A ingestão diária soma pouco: uma máquina `shared-cpu-1x`/512mb viva por ~5 min
por dia (~2,5 h/mês, na ordem de **US$ 0,01/mês**) e um job do Actions de ~6 min
por dia (~3 h/mês — grátis em repositório público; contra as 2000 min/mês do
tier gratuito se for privado). O TMDB não cobra. O que cresce de verdade é o
Neon, porque a passada escreve em `titles` todo dia.

> Suspender a máquina significa cold start de alguns segundos na primeira
> requisição. O shell do Pages é estático e aparece na hora, então o usuário vê
> a página imediatamente e só o card demora — é por isso que o front não está
> sendo servido pelo Fly.
