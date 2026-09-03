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
fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile
```

O `release_command` roda `migrate` e depois `seed` antes de trocar as máquinas —
se a migration falhar, o deploy aborta sem derrubar o que está no ar.

Verificar:

```bash
curl https://watchlytics-api.fly.dev/health          # {"ok":true}
curl https://watchlytics-api.fly.dev/v1/feed | head  # 20 títulos
```

> `primary_region = "gru"` (São Paulo) porque é de onde você desenvolve. O
> mercado é global, então quando houver usuário fora do Brasil vale medir e
> considerar `iad`. Trocar região é uma linha.

> O `seed` no `release_command` existe porque o catálogo é uma fixture e o seed é
> idempotente por PK. **Remover quando houver fornecedor de catálogo real.**

## 3. Cloudflare Pages (web)

```bash
npm i -g wrangler
wrangler login
wrangler pages project create watchlytics --production-branch main
```

Depois, no painel do projeto → Settings → Environment variables, criar em
**Production** e **Preview**:

```
API_ORIGIN = https://watchlytics-api.fly.dev
```

Sem essa variável a Function devolve 500 com mensagem explícita, em vez de falhar
silenciosamente.

Primeiro deploy manual:

```bash
npm run build -w @watchlytics/contract
npm run build -w @watchlytics/web
cd apps/web && wrangler pages deploy dist --project-name=watchlytics
```

O `cd apps/web` importa: o wrangler só enxerga `functions/` a partir do cwd.

## 4. GitHub (CI)

O workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) roda
typecheck, migration, seed, checagem de idempotência do seed e o teste de
contrato do feed; em `main`, deploya as duas pontas.

```bash
gh repo create watchlytics --private --source=. --push   # gh não está instalado
```

Secrets do repositório (Settings → Secrets and variables → Actions):

| Secret | Onde obter |
|---|---|
| `FLY_API_TOKEN` | `fly tokens create deploy -a watchlytics-api` |
| `CLOUDFLARE_API_TOKEN` | painel Cloudflare → API Tokens → template "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | painel Cloudflare, barra lateral |

O CI **não** precisa de `DATABASE_URL` de produção: ele sobe um Postgres com
pgvector como service container.

---

## Definition of done do S7

- [ ] `https://watchlytics-api.fly.dev/health` devolve `{"ok":true}`
- [ ] A URL pública do Pages mostra o card do Breaking Bad
- [ ] `/v1/feed` na URL do Pages responde (prova que o proxy funciona)
- [ ] `PUBLIC_ORIGIN` definida no Fly com a URL do Pages, e `/u/<handle>` de um
      perfil público abre com as OG tags (é o que o WhatsApp lê)
- [ ] Um push em `main` dispara o CI e redeploya as duas pontas

## Custo

Zero enquanto estiver nos tiers gratuitos. O que muda isso primeiro é o Neon
(limite de horas de compute e storage); Fly com `min_machines_running = 0`
suspende quando ninguém acessa.

> Suspender a máquina significa cold start de alguns segundos na primeira
> requisição. O shell do Pages é estático e aparece na hora, então o usuário vê
> a página imediatamente e só o card demora — é por isso que o front não está
> sendo servido pelo Fly.
