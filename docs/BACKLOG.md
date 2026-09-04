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
| B4 | Pré-carregamento das 5 próximas imagens | Sem flash ao trocar de card | ⏸ sem imagem enquanto não há fornecedor |
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
