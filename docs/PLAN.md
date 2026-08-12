# Watchlytics — Plano de Produto e Arquitetura

> v1 web (desktop + mobile browser). App nativo é fase 4 e reusa a API inteira.
> Documento vivo — as decisões abaixo estão fechadas salvo revisão explícita.

---

## 1. Decisões fechadas

| # | Tema | Decisão | Consequência principal |
|---|---|---|---|
| 1 | Fonte de dados | **Em aberto.** v1 roda sobre fixture hard-coded (§5.1) | Decisão adiada sem custo — `title_external_ids` e `score` interno já isolam o fornecedor |
| 2 | Anime | **Gênero sintético (`id 3`)**, não tipo | Um só predicado de filtro: `genre_ids && $preferidos` |
| 3 | Monetização | Em aberto, provavelmente futura | `popularity` do TMDB nunca sai do backend; atribuição correta desde o dia 1 |
| 4 | Escala alvo (12m) | ~10k usuários | Feed por query direta, match em tempo real, sem Redis |
| 5 | Match | **Só entre amigos** no v1, modelado para desconhecidos | `taste_vector` já nasce como `vector(19)` |
| 6 | Mercado | **Global, base em inglês** | Uma coluna `overview`; `users.region` alimenta o filtro de streaming |
| 7 | Auth | **Só OAuth** (Google no v1, Apple na fase 4) | Sem senha, sem reset, sem provedor de email |
| 8 | Catálogo | **Fixture de ~100 títulos** no v1. ~50k populares quando houver fornecedor | Feed, match e onboarding funcionam sem rede |
| 9 | Perfil público | **Só estatísticas agregadas** | Catálogo é sempre restrito a amigos |
| 10 | Onboarding | Gêneros + **20 swipes obrigatórios** | Deck estratificado, pool estático precomputado |
| 11 | Interessado × Assistido | Estados **exclusivos**, transição `interessado → assistido` | `watched_at` gravado na transição |
| 12 | Nota | `rating` 1–5 **opcional** ao marcar assistido | Coluna nullable, alimenta a recomendação |
| 13 | DISLIKE | **Reciclável após 180 dias**, volta despriorizado | É um `WHERE`, não um job |
| 14 | Notificações | **Polling** in-app (60s) | SSE/WebSocket só quando houver chat |

---

## 2. Escopo do MVP

### Dentro da v1

| Área | Entrega |
|---|---|
| Conta | Google OAuth (PKCE), perfil **privado por padrão** |
| Onboarding | Consentimento → gêneros → 20 swipes → feed calibrado |
| Feed | Filtros: tipo, gênero (inclui Anime), ano, idioma |
| Swipe | Gesto + botões + teclado, undo de 1, buffer offline |
| Catálogo | `interessado` / `assistido`, rating 1–5 opcional, aba de descartados |
| Stats | Gêneros dominantes, total assistido, tempo estimado, década favorita |
| Perfil público | Só stats agregadas, mínimo de 10 assistidos, rota OG compartilhável |
| Social | Busca por handle, pedido/aceite de amizade, lista de amigos |
| Match | Tempo real no like + retroativo no aceite + aba "títulos em comum" |
| Recomendação | Boost por gênero sobre popularidade |
| Privacidade | Exportação, exclusão real, consentimento versionado |

### Fora da v1, explicitamente

**Filtro de disponibilidade em streaming** (dependia do fornecedor de catálogo —
volta quando ele for escolhido) · chat e grupos · watch party · resenhas e comentários · tracking de episódios ·
listas customizadas · importação Trakt/Letterboxd/MAL · app nativo e push ·
Sign in with Apple · qualquer ML · deep link para player · notificação por email ·
i18n · match com desconhecidos · trailers no card.

---

## 3. Stack

| Camada | Escolha | Descartado e por quê |
|---|---|---|
| Frontend | React + Vite + TS, **SPA** | **Next.js** — mistura backend no frontend, e é justamente essa fronteira que o app nativo reusa |
| Gesto/animação | `motion` (framer-motion) | Física de swipe artesanal em mobile browser é onde todo mundo se dá mal |
| Estado servidor | TanStack Query | Redux, SWR |
| Estado cliente | `useReducer` local do deck | Zustand — adicionar quando doer |
| Backend | Node + Fastify + TS, REST `/v1` | **tRPC** — acopla cliente ao servidor por tipos, quebra "API pública desde o dia 1". **NestJS** — cerimônia sem retorno. **GraphQL** — um consumidor não paga a complexidade |
| Banco | Postgres + `pgvector` (Neon) | **Supabase full-stack** — modelo "cliente fala com o banco" é o oposto do que o nativo pede. **Mongo** — domínio é relacional |
| ORM | Drizzle | **Prisma** — mais mágica, menos controle onde o SQL importa |
| Auth | OAuth PKCE → JWT 15min + refresh opaco rotacionado | **Sessão por cookie** — não serve nativo. **Clerk/Auth0** — lock-in de identidade é o pior lock-in |
| Cache | **Nenhum.** `titles` no Postgres É o cache | Redis — entra quando o feed p95 passar de 200ms |
| Storage | **Nenhum.** Pôster vem do CDN do TMDB | R2/S3 quando houver upload de avatar |
| Jobs | Worker Node com `setInterval` | BullMQ, Temporal, Airflow |
| Deploy | Front: Cloudflare Pages · API+worker: Fly.io · DB: Neon | Vercel Functions — acopla ao runtime deles |

**Transporte do token:** web guarda o refresh em cookie `httpOnly SameSite=Lax`;
nativo em SecureStore. **Mesmo endpoint, transporte diferente** — é isso que faz
a fase 4 ser só UI.

---

## 4. Modelo de dados

```sql
CREATE EXTENSION vector;

-- ─── identidade ────────────────────────────────────────────────────────────
users (
  id uuid PK, handle citext UNIQUE, display_name text,
  email citext,                       -- informativo, NUNCA chave de login
  avatar_url text,
  is_public boolean DEFAULT false,    -- controla só a página de stats
                                      -- users.region sai: existia só para o
                                      -- filtro de streaming. Volta com ele.
  preferred_genres smallint[],        -- onboarding, editável
  taste_vector vector(19),            -- uma dimensão por gênero, ordem de §4.1
  created_at timestamptz, deleted_at timestamptz
)

identities (
  provider text, provider_user_id text, user_id uuid REFERENCES users ON DELETE CASCADE,
  email_at_provider citext, linked_at timestamptz,
  PRIMARY KEY (provider, provider_user_id)
)

sessions (id uuid PK, user_id uuid, refresh_token_hash text, expires_at, revoked_at, user_agent)

-- ─── catálogo ──────────────────────────────────────────────────────────────
titles (
  id uuid PK, type text,              -- movie | tv
  title text, original_title text,    -- "Attack on Titan" vs "Shingeki no Kyojin"
  overview text,                      -- en-US
  poster_url text, backdrop_url text, -- URL completa; NULL = gradiente do id
  release_year smallint, runtime_minutes smallint,
  original_language char(2),
  genre_ids smallint[],               -- IDs NOSSOS (§4.1), nunca de fornecedor
  score smallint,                     -- popularidade normalizada 0-100, métrica NOSSA
  vote_average numeric(3,1), vote_count integer,
  raw jsonb, synced_at timestamptz
)

genres (id smallint PK, name text)      -- 19 linhas, seed fixo, §4.1
-- o mapa fornecedor→gênero é constante no código de ingestão, não no banco
title_external_ids (
  title_id uuid, provider text, external_id text,
  PRIMARY KEY (provider, external_id),            -- ingestão idempotente
  UNIQUE (title_id, provider)
)

-- ─── decisão e catálogo pessoal ────────────────────────────────────────────
swipes (
  user_id uuid REFERENCES users ON DELETE CASCADE,
  title_id uuid REFERENCES titles,
  direction smallint,                 -- 1 = like, -1 = dislike
  created_at timestamptz, updated_at timestamptz,
  PRIMARY KEY (user_id, title_id)     -- upsert, NÃO append-only
)

library_entries (
  user_id uuid, title_id uuid,
  status text,                        -- interested | watched
  rating smallint,                    -- 1-5, nullable
  added_at timestamptz, watched_at timestamptz,
  PRIMARY KEY (user_id, title_id)
)

-- ─── social ────────────────────────────────────────────────────────────────
friendships (
  user_a uuid, user_b uuid, requested_by uuid,
  status text,                        -- pending | accepted | blocked
  created_at, responded_at,
  PRIMARY KEY (user_a, user_b), CHECK (user_a < user_b)
)

matches (
  user_a uuid, user_b uuid, title_id uuid,
  strength smallint,                  -- 3 forte | 2 média | 1 fraca
  created_at timestamptz,
  PRIMARY KEY (user_a, user_b, title_id), CHECK (user_a < user_b)
)

notifications (id, user_id, type, payload jsonb, read_at, created_at)
consents (user_id, kind, version, accepted_at, ip)
```

### 4.1 Gêneros canônicos (19)

IDs próprios, não os do TMDB — três gêneros são merges e não têm id único lá.
A ordem desta tabela **é** a ordem das dimensões do `taste_vector`.

| id | Gênero | TMDB filme | TMDB série |
|---|---|---|---|
| 1 | Action & Adventure | 28, 12 | 10759 |
| 2 | Animation | 16 | 16 |
| 3 | **Anime** | — | — (derivado: `2 = ANY(genre_ids) AND original_language = 'ja'`) |
| 4 | Comedy | 35 | 35 |
| 5 | Crime | 80 | 80 |
| 6 | Documentary | 99 | 99 |
| 7 | Drama | 18 | 18 |
| 8 | Family | 10751 | 10751 |
| 9 | History | 36 | — |
| 10 | Horror | 27 | — |
| 11 | Kids | — | 10762 |
| 12 | Music | 10402 | — |
| 13 | Mystery | 9648 | 9648 |
| 14 | Reality | — | 10764 |
| 15 | Romance | 10749 | — |
| 16 | Sci-Fi & Fantasy | 878, 14 | 10765 |
| 17 | Thriller | 53 | — |
| 18 | War & Politics | 10752 | 10768 |
| 19 | Western | 37 | 37 |

**Excluídos na ingestão:** `10770 TV Movie`, `10763 News`, `10767 Talk`,
`10766 Soap` — não são conteúdo de descoberta.

**Sci-Fi e Fantasy fundidos:** o TMDB separa em filme (`878`, `14`) e junta em
série (`10765`). Fundir é lossy para filme; a alternativa — mapear `10765` para
os dois — faz o filtro "Fantasy" devolver toda série de ficção científica.
Reversível a baixo custo.

> **Lacuna aceita no v1:** o TMDB não tem Horror, Thriller, Romance, History nem
> Music para séries. Série de terror vem como Drama/Mystery, então filtrar
> "Horror" devolve quase só filmes. Corrigir exige derivar de keywords — fase 3,
> se alguém reclamar.

> **Validar na fase 0:** conferir esta tabela contra `/genre/movie/list` e
> `/genre/tv/list` ao vivo antes de rodar o seed. Dois requests.

### Por que `swipes` é upsert e não append-only

A PK composta entrega **três coisas de graça**: dedup, o teste "já avaliei?" do
feed (index-only scan) e **idempotência do envio em lote** — reenviar um swipe do
buffer offline é `ON CONFLICT DO UPDATE`, sem UUID de request nem tabela de dedup.
O crescimento fica limitado a `usuários × títulos avaliados`, com teto no tamanho
do catálogo. Append-only não tem teto.

> `ponytail: upsert descarta histórico de swipes. Se análise comportamental virar`
> `requisito, adicionar swipe_events append-only — sem mexer nesta tabela.`

`library_entries` é separada porque dislike nunca vira catálogo e é a maioria das
linhas; o catálogo é lido a cada abertura de perfil. A aba "descartados" é uma
view sobre `swipes`.

### Índices críticos

| Índice | Serve |
|---|---|
| `swipes (user_id, title_id)` PK | feed: exclusão do já-avaliado |
| `swipes (title_id, user_id) WHERE direction = 1` | **match** — o índice que mais importa |
| `library_entries (user_id, status, added_at DESC)` | perfil / catálogo |
| `titles USING GIN (genre_ids)` | filtro de gênero (`&&`) |
| `titles (score DESC) WHERE score > 10` | ordenação do feed |
| `title_external_ids (provider, external_id)` PK | ingestão idempotente |
| `friendships (user_b, status)` | pedidos recebidos |
| `notifications (user_id) WHERE read_at IS NULL` | badge |

Deliberadamente **sem** índice em `type`, `release_year` isolados: com ~50k
títulos o Postgres varre em milissegundos. Índice só quando o `EXPLAIN` reclamar.

---

## 5. Arquitetura

```
┌─────────────┐        ┌──────────────────┐        ┌────────────┐
│ SPA (Vite)  │──HTTP──│  API Fastify /v1 │────────│  Postgres  │
│ web + PWA   │  JWT   │   (stateless)    │        │   (Neon)   │
└─────────────┘        └────────┬─────────┘        └─────┬──────┘
┌─────────────┐                 │                        │
│ App Expo    │─────────────────┘                  ┌─────┴──────┐
│  (fase 4)   │  MESMA API, MESMOS ENDPOINTS       │  Worker    │──▶ TMDB
└─────────────┘                                    │ ingestão   │──▶ AniList
                                                   └────────────┘
```

**A regra que sustenta tudo:** o backend não sabe que existe um navegador.
Nenhum HTML no servidor (exceto a rota OG do perfil público), nenhuma rota
dependente de cookie de sessão, nenhuma resposta que assuma tamanho de tela.

### 5.1 Dados do catálogo — fixture no v1

A escolha de fornecedor está **adiada de propósito**. Até lá o catálogo é um
arquivo:

```
seed/titles.json     ~100 títulos, UUIDs fixos no arquivo → seed idempotente
```

Cobertura mínima da fixture, para o produto ser exercitável de verdade:
os 19 gêneros representados, ≥15 anime, filmes e séries misturados,
faixa de anos de 1970 a 2025, e `score` variado (senão o feed sai sempre igual).

**Sem imagens externas.** `poster_url` nasce `NULL` e o card renderiza um
gradiente determinístico derivado do `id`. Isso ship a mecânica de swipe sem
nenhuma dependência de rede, CDN ou licença — e quando houver fornecedor, é
preencher a coluna.

> `ponytail: gradiente no lugar do pôster. O card real depende de imagem —`
> `validar a mecânica com pôsteres de verdade antes de considerar a fase 1 fechada.`

**Quando um fornecedor for escolhido**, o desenho já está pronto e nada aqui muda
de forma: worker paginando o catálogo por `(tipo × ano)`, portão de qualidade na
entrada (`poster_url IS NOT NULL AND vote_count >= 20` — card sem pôster destrói
o swipe, e é mais barato filtrar na entrada), atualização incremental diária,
enriquecimento assíncrono fora do caminho crítico, e pull-through para registros
com `synced_at > 30d`. O `title_external_ids` absorve o fornecedor sem tocar em
`titles`.

**Regra que vale para qualquer fornecedor:** nunca baixar nem re-hospedar
imagens. Os direitos dos pôsteres são dos estúdios; mirror em massa é o item que
mais provavelmente tira o app do ar.

### 5.2 Feed

```sql
SELECT t.* FROM titles t
WHERE t.type = ANY($types)
  AND (t.genre_ids && $genres OR $genres IS NULL)
  AND t.release_year BETWEEN $y1 AND $y2
  AND NOT EXISTS (
    SELECT 1 FROM swipes s
    WHERE s.user_id = $me AND s.title_id = t.id
      AND (s.direction = 1 OR s.updated_at > now() - interval '180 days')
  )
ORDER BY t.score * $genre_boost + random() * $noise DESC
LIMIT 20;
```

Lotes de 20; o cliente pede os próximos quando restam 5. O ruído multiplicativo
é essencial — feed determinístico parece quebrado.

**Fila vazia — degradação em 3 degraus, sempre com aviso na tela:**
1. Relaxa filtros um a um (ano → gênero → tipo), dizendo qual relaxou.
2. Oferece reciclar dislikes com mais de 180 dias.
3. Ingere mais páginas do TMDB para aquele recorte, em background.

Nunca mostrar deck vazio sem explicação.

### 5.3 Match — tempo real

No `POST /v1/swipes` com like, na mesma transação: `INSERT ... SELECT` cruzando
o índice parcial de likes com os amigos aceitos, `ON CONFLICT DO NOTHING`.
Com centenas de amigos é sub-milissegundo. Batch só adicionaria latência de
produto — a graça é o match aparecer na hora.

**O aceite de amizade é o único caso batch:** interseção retroativa dos dois
catálogos, uma vez. Pode render centenas de matches → **uma** notificação
agregada ("você e Ana têm 37 títulos em comum"), nunca 37.

| Situação | Força | Notifica? |
|---|---|---|
| Ambos `interested` | forte | ✅ é o gancho "vamos assistir isso" |
| Um `interested`, outro `watched` | média | ✅ "Ana já viu, pode recomendar" |
| Ambos `watched` | fraca | ❌ aparece na aba, não notifica |

### 5.4 Recomendação

**v1 — só o `$genre_boost`:**

```
peso(gênero) = (likes no gênero + 1) / (swipes no gênero + 2)    -- Laplace
score_final  = score × (1 + Σ pesos dos gêneros do título) × (0.85 + random()×0.3)
```

Recalculado a cada N swipes em `users.taste_vector`. Sem tabela, sem job, sem serviço.

**Evolução, nessa ordem:** keywords do TMDB somadas aos gêneros → filtro
colaborativo (só depois de ~1000 usuários ativos, antes não há sinal) →
embeddings de sinopse com pgvector (resolve cold start de título novo).

> Ressalva: **vetor de gênero é sinal fraco de afinidade entre pessoas** — todo
> mundo gosta de Ação/Drama/Comédia. A similaridade real está na sobreposição de
> títulos curtidos. Quando a fase 5 chegar: vetor filtra candidatos barato →
> sobreposição ordena. O vetor existe agora porque é grátis, não porque resolve.

---

## 6. Contrato da API

```
POST   /v1/auth/oauth/:provider       ← { code, code_verifier }  → { access, refresh }
POST   /v1/auth/refresh
GET    /v1/feed?type=&genres=&year_from=&providers=&cursor=      → { items[], next_cursor }
GET    /v1/onboarding/deck                                        → 20 títulos estratificados
POST   /v1/swipes                     ← [{ title_id, direction, client_ts }]   ⚑ lote, idempotente
DELETE /v1/swipes/:title_id                                       ⚑ undo
PUT    /v1/library/:title_id          ← { status, rating? }
GET    /v1/me/stats
GET    /v1/users/:handle              → stats se is_public e ≥10 assistidos
GET    /u/:handle                     → HTML com OG tags (única rota SSR do sistema)
GET    /v1/friends · POST /v1/friends/requests · POST /v1/friends/requests/:id/accept
GET    /v1/matches?cursor=
GET    /v1/notifications
POST   /v1/me/export · DELETE /v1/me                              ⚑ LGPD/GDPR
```

Os ⚑ existem por causa do mobile e do offline. Desenhá-los depois custa uma
migração de cliente.

---

## 7. Mecânica de swipe

**Gesto:** Pointer Events (unifica mouse/touch/caneta), `touch-action: pan-y` no
card. Disparo por **distância OU velocidade** — flick rápido e curto tem que
contar. Rotação e opacidade dos selos proporcionais ao deslocamento.

**Performance:**
- Só **3 cards no DOM**, `transform: translate3d`, nunca `left/top`.
- Pré-carregar imagens dos próximos 5 com `new Image()`, tamanho `w500`.
- Mutação otimista: **o swipe nunca espera resposta da rede.**

**Undo:** pilha de 1. Se ainda está no buffer offline, remove do buffer.

**Offline:** buffer em `localStorage`, flush a cada 5 itens ou 3s, em lote.
A PK composta torna o reenvio idempotente de graça. Sem service worker no v1.

**Acessibilidade — não negociável:**
- Botões de like/dislike com paridade funcional total. Swipe é atalho, nunca caminho único.
- Setas do teclado no desktop.
- `prefers-reduced-motion` corta a física, faz corte seco.
- Card em região `aria-live` anunciando o título ao entrar.

---

## 8. Privacidade (LGPD + GDPR)

Mercado global aciona GDPR (usuário europeu) e COPPA (menor de 13 nos EUA).
O plano já é GDPR-grade; o que se acrescenta é banner de consentimento se houver
analytics, idade mínima no cadastro, e termos nomeando jurisdição.

1. **Base legal:** execução de contrato para a conta; **consentimento específico
   e versionado** para perfilamento de gosto e grafo social, registrado em `consents`.
2. **Privado por padrão.** Público é opt-in e expõe só stats agregadas.
3. **Piso de agregação:** stats públicas só com ≥10 assistidos.
4. **Exclusão real** em até 30 dias, cascata completa + revogação do token OAuth.
   Nada de soft-delete de PII fingindo ser exclusão.
5. **Portabilidade:** `POST /v1/me/export` → JSON com catálogo, swipes, amigos, matches.
6. **Grafo social:** nunca expor amigos de perfil privado; busca só por handle,
   nunca por email; não confirmar existência de conta.
7. **Terceiros:** o backend chama TMDB/AniList sem nenhum dado do usuário — bom.
   Mas o navegador carrega imagens do CDN do TMDB, revelando IP e títulos vistos.
   **Isso precisa constar na política de privacidade.**

---

## 9. Roadmap

| Fase | Duração | Entrega | Marco |
|---|---|---|---|
| **0 — Fundação** | 1 sem | Repo, schema, migrations, seed dos 19 gêneros + fixture de ~100 títulos, Google OAuth + refresh rotacionado | API responde autenticada, sem nenhuma dependência externa de dados |
| **1 — Swipe solo** | 3–4 sem | Onboarding, feed, gesto, catálogo, perfil, stats | **Usável sozinho** — requisito, não bônus |
| **2 — Social** | 2–3 sem | Amizade, match tempo real + retroativo, aba de comuns, notificações | **Beta fechado** |
| **3 — Refino** | 2 sem | Boost de gênero, filtro de streaming, AniList, undo/offline, PWA, perfil público | 🎯 **API congela em `/v1`** |
| **4 — Nativo** | 3–4 sem | Expo reusando a API. Só UI + push + SecureStore + Sign in with Apple | Loja |
| **5 — Inteligência** | — | Colaborativo, pgvector em produção, importação Trakt/MAL, match com desconhecidos | — |

### Pré-requisitos da fase 4 (por isso a fase 3 é o marco)

- ✅ Auth por token, sem dependência de cookie — fase 0
- ✅ Endpoints em lote e idempotentes — fase 1
- ✅ Zero HTML no servidor (exceto rota OG) — arquitetural
- ✅ Versionamento `/v1` com política de depreciação — app em loja não atualiza sozinho
- ✅ **Design tokens em JSON puro**, consumidos por CSS vars na web e objeto JS no RN.
  Compartilhe *tokens*, não componentes — react-native-web custa mais que reescrever 15 telas.
- ✅ Strings centralizadas em `strings.ts` desde o primeiro componente

---

## 10. Riscos

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| **Termos do fornecedor futuro** (TMDB gratuito é só não-comercial; outros variam) | Média | **Crítico** | Reavaliar junto com a decisão de monetização. `score` interno e `title_external_ids` já desacoplam |
| **Direitos de imagem dos pôsteres** | Média | Alto | Nunca re-hospedar, atribuição visível ao fornecedor. Adiado com a fixture (sem imagem) |
| **Cold start social** — 0 amigos = 0 matches | **Alta** | **Alto** | Maior risco do produto. Fase 1 boa sozinha, convite com deep link, comuns já no 1º amigo |
| **Atrito dos 20 swipes obrigatórios** | Média | Médio | Contador visível, deck reconhecível. **Medir abandono no onboarding desde o dia 1** |
| **Duas fontes = títulos duplicados** (se o fornecedor escolhido precisar de complemento para anime) | Média | Médio | Casar por id externo compartilhado; ambíguos vão para fila manual, nunca heurística agressiva. Fonte secundária sempre assíncrona e fora do caminho crítico |
| **Exaustão do catálogo com a fixture** | **Certa** | Alto | 20 swipes de onboarding queimam 20% de 100 títulos. Serve para construir e demonstrar, **não** para o beta da fase 2 — até lá, fornecedor escolhido ou fixture na casa dos milhares |
| **Apple só devolve nome/email na 1ª autorização** | Alta | Médio | Gravar antes de qualquer validação. Fase 4 |
| **Enumeração de usuários / spam de amizade** | Alta | Baixo | Rate limit por IP e conta, busca ≥3 chars, teto de pedidos pendentes |
| **Gosto de mídia infere religião/orientação/política** | Média | Alto | Não é sensível pela letra da lei, é por inferência. Catálogo sempre friends-only |

### Gatilhos de mudança arquitetural (não construir antes)

| Sintoma | Mudança |
|---|---|
| Feed p95 > 200ms | Cache de página por `(user, hash dos filtros)` → entra Redis |
| Ingestão não fecha a janela diária | Worker separado com fila real |
| `swipes` > ~50M linhas | Particionar por hash de `user_id` |
| Match no like > 50ms | Denormalizar `friend_ids` em array no `users` |

---

## 11. Pendências abertas

- [ ] Decidir monetização antes de qualquer feature paga (bloqueia TMDB comercial)
- [ ] Política de privacidade e termos escritos antes do beta aberto — jurídico, não engenharia
- [ ] Idade mínima no cadastro (COPPA)
- [ ] Nome/domínio/identidade visual
- [ ] **Escolher o fornecedor de catálogo** — não bloqueia a fase 0 nem a 1.
      Bloqueia sair do beta fechado: ~100 títulos esgotam rápido com uso real.
      Comparativo TMDB / AniList / Jikan / Kitsu / Wikidata está preservado no
      histórico — retomar quando o produto justificar a decisão
- [x] ~~Definir os gêneros canônicos e o mapa TMDB filme↔série~~ → §4.1
