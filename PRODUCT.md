# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primários: duplas e pequenos grupos de amigos que querem assistir junto e não
convergem num título.** A situação é uma decisão compartilhada — duas pessoas,
dois gostos, e a negociação que trava antes de qualquer um dar play. O job é
chegar a um título que ambos querem ver.

O swipe solo é a calibração que torna o match possível, não o fim em si. Isso
não afrouxa o requisito da fase 1 de ser **usável sozinho** (PLAN §9): é o único
caminho de entrada, já que ninguém chega com amigos no app. O valor completo só
existe a partir do primeiro amigo aceito.

## Product Purpose

Descoberta de filmes, séries e anime por swipe, com catálogo pessoal
(`interessado` / `assistido` + nota opcional) e match entre amigos. Sucesso é um
par de amigos sair com um título em comum que os dois querem ver — o match forte
(ambos `interested`), que é o único que dispara notificação junto com o médio.

## Positioning

O match cruza os catálogos de amigos **no momento do like, na mesma transação**
(PLAN §5.3) — a graça é aparecer na hora, não num digest. Um tracker de catálogo
não tem o grafo; um agregador de streaming não tem o gosto calibrado por swipe.

Anime é **gênero de primeira classe** (id sintético 3, derivado de
`Animation + original_language = 'ja'`), não um tipo à parte nem uma tag — um só
predicado de filtro, o mesmo que qualquer outro gênero.

## Operating Context

- Navegador desktop e mobile (mesma SPA; não há app nativo no v1 — fase 4 reusa
  a API inteira).
- Sessão curta e frequentemente compartilhada: a decisão acontece com alguém.
- Onboarding obrigatório: consentimento → gêneros → **20 swipes** antes do feed
  calibrado. O atrito é conhecido e mitigado com contador visível; abandono no
  onboarding é para ser medido desde o dia 1.
- Entrada só por Google OAuth (PKCE). Sem senha, sem reset, sem email.
- Notificações in-app por polling de 60s. Sem push, sem email.
- Catálogo pessoal é sempre restrito a amigos. Perfil público expõe apenas
  estatísticas agregadas.

## Capabilities and Constraints

**Confirmado no escopo do v1:** filtros de tipo/gênero/ano/idioma; swipe por
gesto, botão e teclado com undo de 1 e buffer offline; catálogo com aba de
descartados; estatísticas (gêneros dominantes, total, tempo estimado, década);
busca por handle, pedido/aceite de amizade; match em tempo real no like e
retroativo no aceite; boost de gênero sobre popularidade; exportação e exclusão
real de dados.

**Fora do v1 por decisão:** filtro de disponibilidade em streaming (viável, mas
exige `users.region` de volta), chat, watch party, resenhas, tracking de
episódios, listas customizadas, importação Trakt/Letterboxd/MAL, i18n, match com
desconhecidos, trailers no card.

**Terminologia do domínio:** *interessado* e *assistido* são estados
**exclusivos** de `library_entries`, com transição só numa direção. *Dislike*
não é estado de catálogo — vive em `swipes` e volta ao deck despriorizado após
180 dias. *Score* é métrica própria (0–100), não a nota do fornecedor.

**Restrições técnicas duradouras:** o backend não sabe que existe um navegador —
nenhum HTML no servidor exceto a rota OG `/u/:handle`, nenhuma rota dependente de
cookie de sessão, nenhuma resposta que assuma tamanho de tela. Pôsteres nunca são
baixados nem re-hospedados. Design tokens vivem em JSON puro para o app nativo
consumir; compartilha-se *token*, nunca componente. Strings de UI ficam
centralizadas em `apps/web/src/strings.ts` desde o primeiro componente.

**Explicitamente indecidido — não inventar:**

- Fornecedor de catálogo. TMDB está decidido no papel (PLAN §1) mas a ingestão
  não entrou; até lá o catálogo é a fixture.
- Política de privacidade e termos escritos (jurídico, antes do beta aberto).
- Idade mínima no cadastro (COPPA).
- Nome, domínio e identidade visual.

## Brand Commitments

**Nenhum.** "Watchlytics" é nome de trabalho e não é vinculante. Não há logo,
paleta, tipografia, voz ou referência de marca fechada — trabalho visual futuro
pode propor tudo do zero.

O único fato de linguagem confirmado é mecânico, não de marca: a base é inglês
(mercado global, PLAN §1) e toda string de UI passa por `strings.ts`.

## Evidence on Hand

- `seed/titles.json` — 94 títulos de fixture com UUIDs fixos no arquivo. Serve
  para construir e demonstrar; **não** sustenta o beta da fase 2, onde 20 swipes
  de onboarding queimam 20% do catálogo.
- Nenhuma imagem. `poster_url` nasce `NULL` e o card renderiza um gradiente
  determinístico derivado do `id`. Não há pôster, logo, screenshot ou asset de
  marca no repositório.
- **Não existe e não deve ser fabricado:** usuário real, depoimento, cliente,
  estudo de caso, imprensa, benchmark, métrica de uso, preço, plano ou qualquer
  alegação de tração. O produto não será monetizado (decidido em 04/09/2026), o
  que também significa que não há nada comercial a alegar.

## Product Principles

1. **Usável sozinho é requisito, não bônus.** Cold start social — zero amigos,
   zero matches — é o maior risco do produto. Nada pode depender de já haver
   alguém do outro lado.
2. **O match é o produto; o swipe é como se chega nele.** A calibração existe
   para o cruzamento valer, e o cruzamento acontece na hora.
3. **Título irreconhecível quebra o ritmo.** Catálogo curado por popularidade
   vence catálogo grande — mais acervo seria pior produto, não melhor.
4. **Gesto é atalho, nunca caminho único.** Botão e teclado têm paridade
   funcional total com o swipe.
5. **Privado por padrão, agregado quando público.** Catálogo é friends-only
   sempre; gosto de mídia infere religião, orientação e política por dedução,
   mesmo não sendo dado sensível pela letra da lei.

## Accessibility & Inclusion

Tratada como não negociável (PLAN §7), com requisitos já implementados que o
trabalho futuro precisa preservar:

- Paridade funcional total entre gesto, botões e setas do teclado.
- Alvo de toque mínimo de 44px (WCAG 2.5.8), fixado no token `--tap`.
- Contraste AA verificado nos tokens de cor — `--pass` foi clareado de `#e0525f`
  para `#e8636f` justamente por reprovar por um triz.
- `prefers-reduced-motion` corta a física do swipe e faz corte seco, mas mantém
  os carimbos: eles são o que diz para onde o card vai.
- Card em região `aria-live`, anunciando o título ao entrar.
- Foco visível em tudo que recebe foco.
