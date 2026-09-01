/**
 * Todas as strings de UI em um lugar.
 *
 * Não é infra de i18n — é o que faz adicionar i18n depois custar um dia em vez
 * de duas semanas. O mercado do v1 é global com inglês como base (PLAN §1).
 */
export const t = {
  pass: "Pass",
  like: "Like",
  passHint: "Not interested (arrow left)",
  likeHint: "Interested (arrow right)",
  loading: "loading…",
  emptyCatalog: "Catalog is empty — did the seed run?",
  exhausted: "That's everything for now.",
  exhaustedHint: "You've been through the whole catalog. More titles are coming.",
  error: (m: string) => `error: ${m}`,
  movie: "Movie",
  series: "Series",
} as const;
