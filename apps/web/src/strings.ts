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
} as const;
