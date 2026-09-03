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

## Estado: 29 de 39 tarefas

| Trilha | | |
|---|---|---|
| **S** esqueleto | 6/7 | falta só o deploy (bloqueado em contas) |
| **A** feed | 8/8 | backend e UI de filtro completos |
| **B** swipe | 6/7 | B4 (pré-carga de imagem) pausada — não há pôster |
| **C** identidade | 6/6 | completa — falta exercitar contra o Google real |
| **D** catálogo | 3/5 | falta D4 (onboarding) e D5 (perfil público) |
| **E** social | 0/6 | não começou |

**Funciona ponta a ponta:** Postgres → API Fastify → deck no navegador. Swipe
com gesto, teclado, undo e fila offline; o catálogo inteiro passa uma vez sem
repetir; o LIKE vira coleção com abas e estatísticas.

**53 testes** (48 API + 5 fila), `npm run check` limpo nos três pacotes.

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

- **Fonte de catálogo em aberto.** O v1 roda sobre `seed/titles.json` (94
  títulos). `title_external_ids` isola o fornecedor.
- **Anime é gênero (id 3), não tipo.** Um anime é filme OU série.
- **`swipes` é upsert com PK `(user_id, title_id)`, não append-only.** É essa
  PK que dá dedup, o "já avaliei?" do feed e a idempotência do buffer offline.
- **Match só entre amigos** no v1, mas `taste_vector` já é `vector(19)`.
- **Mercado global, base em inglês.**
- **Só OAuth, sem senha.** Login nunca é por email — a chave é
  `identities (provider, provider_user_id)`.
- **Perfil público mostra só estatísticas agregadas**, com piso de 10 assistidos.

## Bloqueado na pessoa, não no código

1. **Contas para o S7** — Neon, Fly, Cloudflare. Os artefatos estão prontos e
   verificados em container. O remote existe e recebeu o primeiro push em
   2026-09-02, então o CI do GitHub já roda; falta o destino do deploy.
2. **Credenciais do Google Cloud** para C2 funcionar de verdade. A troca de
   código está isolada em `providers.google` e testada com stub; o fluxo real
   nunca foi exercitado.
3. **Escolher o fornecedor de catálogo.** Não bloqueia A/B/C/D, bloqueia o beta.
4. **Veredito do gesto no celular.** Duas perguntas em aberto que revertem
   decisões: o gesto tem peso? (senão, `framer-motion` se justifica) e o card
   convence sem pôster? (senão, a escolha de fornecedor sobe para o topo).

## Problemas conhecidos

- **Flake não explicado:** `A5 degrau 1` falhou uma vez e não reproduziu em 6
  tentativas, incluindo com banco sujo e simulando primeira execução. Se
  aparecer de novo, há uma pista a mais.
- **C1 é dívida com prazo.** O shim `DEV_USER_ID` em `auth.ts` injeta usuário
  fixo. Produção não define a variável e responde 401. Sai quando o OAuth estiver
  em produção — não deixe virar permanente.
- **Fixture esgota numa sessão.** 94 títulos, e o onboarding do D4 vai consumir
  20 na porta de entrada. Serve para construir e demonstrar, não para o beta.
- **Rate limit é por instância** (Map em memória). Com duas máquinas no Fly, o
  teto dobra.

## Próximos passos sugeridos

1. **D5** — perfil público e `GET /u/:handle` com OG tags. Agora que o C6
   existe, expor perfil já vem com exclusão e portabilidade atrás.
2. **D4** — onboarding. Decida o recorte antes: 20 swipes obrigatórios sobre 94
   títulos queimam 20% do catálogo na porta de entrada.
3. **Trilha E** — social e match. C está completa, então a dependência de
   usuários de verdade virou só a credencial do Google.
