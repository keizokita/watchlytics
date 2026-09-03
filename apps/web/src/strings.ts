/**
 * Todas as strings de UI em um lugar.
 *
 * Não é infra de i18n — é o que faz adicionar i18n depois custar um dia em vez
 * de duas semanas. O mercado do v1 é global com inglês como base (PLAN §1).
 */
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
  error: (m: string) => `error: ${m}`,
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
  signOut: "Sign out",
  signedInAs: (handle: string) => `Signed in as @${handle}`,
  authNotConfigured: "Sign-in is not configured on this build.",
  /**
   * C5 — o que a conta grava em `consents` na primeira entrada. Mudou o texto,
   * suba a CONSENT_VERSION do backend: é a versão DESTE aviso que fica
   * registrada. Sem link porque a política ainda não existe (PLAN §9).
   */
  consentNotice:
    "By signing in you agree that your swipes are used to personalize what you see next.",
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
  // D5 — perfil público
  publicProfile: "Public profile",
  publicProfileHint:
    "Your profile is private. Turning it on publishes only aggregate stats — never your library, and only once you have watched 10 titles.",

  /** Diz o que some ANTES do clique irreversível — o resumo é o aviso. */
  deleteAccountConfirm:
    "Delete your account for good? Your swipes, library, matches and friendships are erased immediately. This cannot be undone.",
} as const;
