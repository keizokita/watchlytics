/**
 * Todas as strings de UI em um lugar.
 *
 * Não é infra de i18n — é o que faz adicionar i18n depois custar um dia em vez
 * de duas semanas. O mercado do v1 é global com inglês como base (PLAN §1).
 */
/**
 * β1 — onde os dois documentos ficam públicos.
 *
 * Aponta para o markdown no GitHub, que é público, renderiza e é a MESMA fonte
 * que o repositório versiona — copiar o texto para `public/` criaria uma segunda
 * versão para manter desatualizada.
 *
 * ponytail: o link sai do domínio do app, o que é estranho para documento legal.
 * Vira `/legal/privacy` servido pelo Pages no dia em que houver domínio próprio
 * e um renderizador de markdown — não antes, e não por causa disto.
 */
const LEGAL_BASE = "https://github.com/keizokita/watchlytics/blob/main/docs/legal";
export const PRIVACY_URL = `${LEGAL_BASE}/privacy.md`;
export const TERMS_URL = `${LEGAL_BASE}/terms.md`;

export const t = {
  pass: "Pass",
  like: "Like",
  undo: "Undo",
  passHint: "Not interested (arrow left)",
  likeHint: "Interested (arrow right)",
  undoHint: "Undo last swipe (backspace)",
  loading: "loading…",
  emptyCatalog: "Catalog is empty — did the seed run?",
  exhausted: "That's everything for now.",
  exhaustedHint: "You've been through the whole catalog. More titles are coming.",
  /**
   * O que aparece na tela quando algo falha. O detalhe técnico não vem junto:
   * ele é em português, nomeia rota e status, e vai para o console (errors.ts).
   * A frase não manda fazer nada: quem carrega a ação é o botão `retry`.
   */
  errorGeneric: "Something went wrong.",
  errorOffline: "You are offline. Check your connection.",
  /** Só nas cargas automáticas: onde o erro veio de um botão, ele é o retry. */
  retry: "Try again",
  movie: "Movie",
  series: "Series",
  /** O número sozinho no chip do card não diz de que escala ele é. */
  voteHint: (n: number) => `Rated ${n.toFixed(1)} out of 10`,

  // D4 — onboarding
  onboardingTitle: "Let's calibrate your feed.",
  onboardingGenresHint:
    "Pick the genres you actually watch. You can change this later.",
  onboardingStart: "Start swiping",
  onboardingCount: (done: number, total: number) =>
    `${done} of ${total} swipes`,

  // D2 — catálogo pessoal
  navDeck: "Deck",
  navLibrary: "Library",
  navFriends: "Friends",
  tabInterested: "Interested",
  tabWatched: "Watched",
  tabDiscarded: "Discarded",
  emptyInterested: "Nothing here yet — like a few titles in the deck.",
  emptyWatched: "Mark something as watched and it shows up here.",
  emptyDiscarded: "Nothing discarded.",
  discardedHint: "Discarded titles come back to the deck after 180 days.",
  markWatched: "Mark as watched",
  markInterested: "Move back to interested",
  rateHint: (n: number) => `Rate ${n} out of 5`,
  clearRating: "Clear rating",

  // D3 — estatísticas
  stats: "Your stats",
  statsWatched: "Watched",
  statsTime: "Time watched",
  statsHours: (h: number) => `${h}h`,
  statsDecade: "Favorite decade",
  statsDecadeValue: (d: number) => `${d}s`,
  statsGenres: "Top genres",
  /** Piso de agregação: a tela explica por que ainda não há número. */
  statsLocked: (missing: number, floor: number) =>
    `${missing} more watched to unlock your stats — averages over fewer than ${floor} titles would just spell out your library.`,

  signIn: "Sign in with Google",
  /** Porta de entrada: é a primeira coisa que um visitante deslogado lê. */
  signedOutTitle: "Find what to watch next.",
  signedOutBody:
    "Swipe through a catalog, keep what you like, and see what you have in common with friends. Sign in to start.",
  signOut: "Sign out",
  signedInAs: (handle: string) => `Signed in as @${handle}`,
  authNotConfigured: "Sign-in is not configured on this build.",
  /**
   * C5 — o que a conta grava em `consents` na primeira entrada. Mudou o texto,
   * suba a CONSENT_VERSION do backend: é a versão DESTE aviso que fica
   * registrada.
   *
   * β1 — o texto mudou: agora nomeia os dois documentos e o grafo social, que a
   * política declara como base de consentimento separada. A CONSENT_VERSION de
   * routes/auth.ts PRECISA subir junto, e ela é da trilha γ — sem isso a conta
   * grava que aceitou um aviso que ninguém leu.
   */
  consentNotice:
    "By signing in you agree to the Terms of Use, and to the Privacy Policy — including using your swipes and your friends list to personalize what you see next.",
  privacyPolicy: "Privacy Policy",
  terms: "Terms of Use",

  // β2 — porta de idade. Ano, nunca data completa: é o mínimo que responde à
  // única pergunta que a lei nos deixa fazer (ver docs/legal/privacy.md).
  ageGateTitle: "One question before you start.",
  ageGateBody: (min: number) =>
    `Watchlytics is for people ${min} and over. We ask for the year you were born and nothing else — not the day, not the month.`,
  ageGateLabel: "Year you were born",
  ageGateAction: "Continue",
  /** O ano está fora do intervalo que o contrato aceita, não é recusa. */
  ageGateInvalid: "Enter the four digits of the year you were born.",
  /**
   * A recusa. Sem culpa, sem "tente de novo": a pessoa respondeu com honestidade
   * e a resposta encerra o assunto. Diz também que nada foi guardado, porque é
   * verdade e é a parte que importa para quem acabou de digitar o ano.
   */
  ageGateRefused: (min: number) =>
    `Thanks for answering honestly. Watchlytics is only for people ${min} and over, so we can't set up your account. We did not keep the year you entered, and there is nothing here for you to come back to.`,
  authStateMismatch: "Sign-in did not come back from where it started.",

  // A1 — filtros
  filters: "Filters",
  filterType: "Filter by type",
  filterGenre: "Filter by genre",
  filterLanguage: "Filter by language",
  filterYearFrom: "Released from year",
  filterYearTo: "Released up to year",
  anyType: "Any type",
  anyGenre: "Any genre",
  anyLanguage: "Any language",
  yearFrom: "From",
  yearTo: "To",
  // A5 — o aviso é obrigatório: deck vazio sem explicação parece bug
  relaxedNames: {
    year: "year",
    genre: "genre",
    type: "type",
    language: "language",
  } as Record<string, string>,
  relaxedBanner: (names: string[]) =>
    `Nothing matched — ignoring your ${new Intl.ListFormat("en").format(names)} filter${names.length > 1 ? "s" : ""}.`,
  recycleOffer: "Nothing new matches. Want to see titles you passed on before?",
  recycleAction: "Show passed titles",
  recycled: "Showing titles you passed on before.",

  // C6 — os dois direitos sobre a própria conta (LGPD/GDPR)
  account: "Your data",
  accountHint:
    "Your export opens as a JSON file: swipes, library, friends and matches. Deleting erases all of it right away — there is no undo and no grace period.",
  exportData: "Download my data",
  deleteAccount: "Delete my account",
  // E1/E2 — amigos
  friends: "Friends",
  friendSearchLabel: "Search people by handle",
  friendSearchPlaceholder: "handle",
  friendSearchAction: "Search",
  friendResults: "Results",
  /** Uma mensagem para os dois casos: termo curto e ninguém encontrado. */
  friendNoResults: (min: number) =>
    `Nobody to show. Search by handle, at least ${min} characters — never by email.`,
  friendTabPeople: "People",
  friendTabCommon: "In common",
  friendTabAlerts: "Alerts",
  friendAdd: "Add friend",
  friendIncoming: "Friend requests",
  friendAccept: "Accept",
  friendYours: "Your friends",
  friendNone: "No friends yet. Search a handle above.",
  friendOutgoing: "Sent",

  // E5 — a força do match é o par de status dos dois lados
  matchStrength: {
    3: "You both want to watch it",
    2: "One of you has seen it",
    1: "You have both seen it",
  } as Record<number, string>,
  commonNone: "Nothing in common yet. Add a friend, or keep swiping.",
  commonMore: "Load more",

  // E6 — notificações
  alertCommon: (handle: string, n: number) =>
    `You and @${handle} have ${n} ${n === 1 ? "title" : "titles"} in common.`,
  alertMatch: (handle: string, title: string) =>
    `You and @${handle} both want to watch ${title}.`,
  /** Cliente antigo, tipo novo: some com a linha seria pior que isto. */
  alertUnknown: "Something new happened.",
  alertsNone: "Nothing new.",
  alertsBadge: (n: number) => `${n} unread ${n === 1 ? "notification" : "notifications"}`,

  // D5 — perfil público
  publicProfile: "Public profile",
  publicProfileHint:
    "Your profile is private. Turning it on publishes only aggregate stats — never your library, and only once you have watched 10 titles.",

  /** Diz o que some ANTES do clique irreversível — o resumo é o aviso. */
  deleteAccountConfirm:
    "Delete your account for good? Your swipes, library, matches and friendships are erased immediately. This cannot be undone.",

  /**
   * Exigência dos termos de uso do TMDB, não cortesia. O texto é o que eles
   * pedem literalmente — não reescreva nem traduza: é a fonte do catálogo e a
   * condição de usar o tier gratuito.
   */
  tmdbAttribution:
    "This product uses the TMDB API but is not endorsed or certified by TMDB.",
} as const;
