# Watchlytics

**Descoberta de filmes, séries e anime por swipe** — catálogo pessoal, perfil
público e match com amigos quando os dois curtem o mesmo título.

**▶ [watchlytics.pages.dev](https://watchlytics.pages.dev)** — no ar, em beta.
Login com Google. Funciona no navegador do celular, com gesto de arrastar de
verdade.

[![check & deploy](https://github.com/keizokita/watchlytics/actions/workflows/deploy.yml/badge.svg)](https://github.com/keizokita/watchlytics/actions/workflows/deploy.yml)
[![licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-informational)](LICENSE)

<!-- ─────────────────────────────────────────────────────────────────────────
     O GIF do swipe entra AQUI, e é o que mais vale nesta página: é um app de
     gesto, e gesto não se explica em prosa. Para publicar, basta pôr o arquivo
     em docs/media/swipe.gif e descomentar a linha abaixo.

<p align="center">
  <img src="docs/media/swipe.gif" alt="Um card sendo arrastado para a direita; o próximo card aparece atrás" width="320">
</p>

     Como gravar, para o resultado não pesar nem ficar ilegível:

     · viewport de 390x844 (iPhone 14) — é o tamanho em que o deck mede +0 de
       folga, então nada fica cortado na captura;
     · 3 a 5 segundos: um like para a direita, um pass para a esquerda, e o
       card seguinte entrando. Nada mais — quem assiste decide em 2 segundos;
     · alvo de 2MB. O GitHub serve até 10MB, mas o README é a primeira coisa
       que carrega e um GIF pesado atrasa a página inteira;
     · se passar disso, troque por .mp4 (o GitHub renderiza vídeo no README
       arrastando o arquivo para a caixa de edição, que devolve uma URL de
       user-attachments);
     · use a conta de demonstração, não a sua: o deck mostra títulos reais e
       o rodapé mostra o @handle de quem está logado.
     ───────────────────────────────────────────────────────────────────────── -->

| | |
|---|---|
| **Catálogo** | 9.830 títulos do TMDB, filtrados por volume de votos — curadoria é `WHERE`, não projeto de banco |
| **Testes** | 214 (156 na API, 58 na web) em `node --test`, sem framework |
| **Stack** | TypeScript de ponta a ponta · Fastify · Drizzle · Postgres 17 + pgvector · React 19 + Vite |
| **Infra** | Neon + Fly.io + Cloudflare Pages — custo inicial próximo de zero, sem lock-in |
| **Código** | ~14 mil linhas, 14 tabelas, 228 commits |

---

## O que este repositório mostra

Não é um CRUD com tela bonita. As três coisas que valem olhar:

**1. Cada decisão técnica tem o porquê escrito, junto com o que foi recusado.**
[`docs/PLAN.md`](docs/PLAN.md) tem a tabela de decisões fechadas com a
alternativa rejeitada e a razão. Exemplos:

| Escolhido | Recusado, e por quê |
|---|---|
| React + Vite, **SPA** | **Next.js** — mistura servidor no frontend, e é justamente essa fronteira que o app nativo vai reusar |
| REST `/v1` | **tRPC** — acopla cliente a servidor por tipos e quebra "API pública desde o dia 1". **GraphQL** — um consumidor não paga a complexidade |
| Drizzle | **Prisma** — mais mágica onde o SQL importa |
| Postgres como cache | **Redis** — entra quando o p95 do feed passar de 200ms, não antes |
| `node:crypto` (HS256) | **Biblioteca de JWT** — ~40 linhas, e o algoritmo é **nosso**, nunca o que o token declara: é assim que morre a família `alg=none` |

**2. Os números vêm de medição, não de estimativa.**
Latência de feed, retomada de suspensão do Fly (0,42–0,57s, sem um único 5xx),
encaixe de tela em 320×568 — cada um foi medido, e o método está escrito junto.
[`docs/BACKLOG.md §8`](docs/BACKLOG.md) cataloga nove casos em que uma medição
**rodou no lugar certo e respondeu outra pergunta** — um `sleep` que prova que o
tempo passou e é lido como "a tela assentou", um `grep` de literal que não
enxerga nome montado em template, uma conta vazia que cabe em qualquer viewport.
Quatro dessas lições viraram checagem automática em vez de parágrafo.

**3. Privacidade é requisito, não rodapé.**
Consentimento versionado no primeiro login, porta de idade que guarda **o ano** e
não a data completa (minimização), exportação de dados, exclusão de conta que
varre também as notificações de terceiros que citam o usuário apagado, e
`@handle` escolhido pela pessoa para que o e-mail nunca apareça no frontend.

---

## Arquitetura

```
┌──────────────────┐   /v1/*   ┌───────────────┐        ┌──────────────┐
│ Cloudflare Pages │ ────────► │ Fastify (Fly) │ ─────► │ Neon Postgres│
│  React 19 + Vite │  (proxy)  │    Drizzle    │        │  + pgvector  │
└──────────────────┘           └───────────────┘        └──────────────┘
         └──────────── packages/contract (Zod) ────────────┘
```

**Um proxy, não CORS.** Uma Pages Function encaminha `/v1/*` para o Fly, então
front e API ficam na mesma origem em dev e em produção. `pages.dev` e `fly.dev`
são domínios registráveis diferentes: sem o proxy, o refresh token em cookie
`httpOnly` seria cookie de terceiro e os navegadores o bloqueariam. Custo de um
hop pelo edge; ganho de `SameSite=Lax` funcionando e zero CORS.

**`packages/contract` é a costura.** Um pacote Zod que api e web importam: o
schema valida na borda do servidor e tipa o cliente, sem acoplar um ao outro
como o tRPC faria. É o único pacote que compila.

**Sem build step.** Node ≥ 23 executa `.ts` nativamente. Não há `tsx`, não há
bundler no backend, e `tsc` roda só como `--noEmit`.

### Três decisões de modelagem

**`swipes` é upsert, não append-only.** PK `(user_id, title_id)`. Isso entrega de
graça a deduplicação, o teste de "já avaliou?" que o feed precisa em toda página,
e a idempotência do lote offline — um swipe reenviado por rede ruim não vira dois.

**O índice do match é parcial.** `(title_id, user_id) WHERE direction = 1`: só
likes entram, porque descartes nunca são consultados por título. O índice fica
uma fração do tamanho de um índice completo.

**`score` vem de `vote_count`, nunca de `popularity`.** O `popularity` do TMDB é
métrica proprietária e é uma janela móvel — usá-la reordenaria o feed entre duas
ingestões sem nada no nosso código ter mudado.

---

## Rodando local

```bash
npm install
npm run build -w @watchlytics/contract   # único pacote que compila
npm run db:up                            # Postgres 17 + pgvector, porta 5433
cp apps/api/.env.example apps/api/.env
npm run migrate
npm run seed                             # fixture de 94 títulos, idempotente
```

```bash
npm run dev:api    # http://localhost:3000
npm run dev:web    # http://localhost:5173   (proxy de /v1 para a api)
npm test           # 214 testes
npm run check      # typecheck dos três pacotes
```

O seed é idempotente pela PK `(provider, external_id)` de `title_external_ids`,
não por checagem em código. A fixture entra pela mesma porta que o TMDB usa
(`provider='fixture'`), então trocar de fornecedor não exige tocar no schema.

<details>
<summary><code>npm run migrate</code> reclamando de <code>.ts</code>?</summary>

Seus scripts npm estão pegando um Node antigo. Causa comum: um pacote `node`
instalado por engano em algum diretório acima do projeto
(`~/node_modules/node`), que o npm injeta no PATH dos scripts.

```bash
npm exec -- node -v      # tem que bater com `node -v`
```
</details>

---

## Estrutura

```
packages/contract/    Zod — a costura entre api e web
apps/api/             Fastify + Drizzle · rotas em src/routes/
apps/web/             React 19 + Vite, SPA
tools/a11y/           Réguas de acessibilidade e de encaixe em tela
docs/                 PLAN, BACKLOG, DEPLOY, HANDOFF
```

## Documentação

| | |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | Decisões de produto e arquitetura, com as alternativas recusadas |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Trilhas, dependências, e o catálogo de erros de medição |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Neon + Fly + Cloudflare Pages, passo a passo |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Estado atual e armadilhas de ambiente |

## Licença

[MIT](LICENSE). O código é livre para usar, modificar e distribuir.

Vale a distinção: a licença cobre **este código**, e não os dados do catálogo.
Os metadados e as imagens vêm do TMDB sob os termos deles, que são de uso **não
comercial** no plano gratuito — é por isso que o produto não tem monetização, e
essa restrição foi o que de fato fechou a escolha do fornecedor
([`PLAN.md §1`](docs/PLAN.md)).

---

Dados de filmes e séries por [TMDB](https://www.themoviedb.org/). Este produto
usa a API do TMDB mas não é endossado nem certificado pelo TMDB.
