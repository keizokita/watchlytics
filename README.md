# Watchlytics

Descoberta de filmes, séries e anime por swipe, com catálogo pessoal e match
entre amigos.

- [docs/PLAN.md](docs/PLAN.md) — decisões de produto e arquitetura
- [docs/BACKLOG.md](docs/BACKLOG.md) — trilhas de trabalho e dependências
- [docs/DEPLOY.md](docs/DEPLOY.md) — Neon + Fly + Cloudflare Pages

## Requisitos

| | |
|---|---|
| Node | **≥ 23** — o projeto roda `.ts` direto, sem `tsx` nem build step |
| podman | Postgres local (ou use qualquer Postgres com `pgvector`) |

## Subindo

```bash
npm install
npm run build -w @watchlytics/contract   # único pacote que compila
npm run db:up                            # Postgres + pgvector na porta 5433
cp apps/api/.env.example apps/api/.env
npm run migrate
npm run seed
```

`npm run seed` é idempotente: rodar de novo não duplica nada. A garantia é a PK
`(provider, external_id)` de `title_external_ids`, não uma checagem em código.

## Rodando

```bash
npm run dev:api    # http://localhost:3000
npm run dev:web    # http://localhost:5173  (faz proxy de /v1 para a api)
npm test           # teste de contrato do feed — precisa do banco semeado
npm run check      # typecheck dos três pacotes
```

O Vite faz proxy de `/v1`, então não há CORS: em dev e em produção o front e a
API ficam na mesma origem.

## Estrutura

```
packages/contract/   Zod: a costura entre api e web. Mude aqui em PR próprio.
apps/api/            Fastify + Drizzle
seed/titles.json     Catálogo hard-coded (94 títulos) enquanto não há fornecedor
```

## Dados do catálogo

Nenhum fornecedor externo foi escolhido ainda — ver [PLAN.md §5.1](docs/PLAN.md).
Até lá o catálogo é a fixture, e os cards renderizam um gradiente derivado do
`id` em vez de pôster. A fixture entra pela mesma porta que um fornecedor real
usaria (`title_external_ids` com `provider='fixture'`).

## Se `npm run migrate` reclamar de `.ts`

Seus scripts npm estão pegando um Node antigo. Causa comum: um pacote `node`
instalado por engano em algum diretório acima do projeto (`~/node_modules/node`),
que o npm injeta no PATH dos scripts. Confira com:

```bash
npm exec -- node -v      # tem que bater com `node -v`
```
