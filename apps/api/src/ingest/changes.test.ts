import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIAS_JANELA,
  MIN_VOTES_REFRESCO,
  changesUrl,
  detalheUrl,
  janelas,
  normalizarDetalhe,
  paraTmdbItem,
} from "./changes.ts";

/**
 * Só a parte pura: sem chave do TMDB e sem Postgres, como o tmdb.test.ts.
 * O `changes.ts` só executa a varredura quando é o programa, então importar
 * aqui não dispara rede nenhuma.
 */

// ─── janelas ────────────────────────────────────────────────────────────────

test("um dia de intervalo é uma janela só", () => {
  assert.deepEqual(janelas("2026-09-11", "2026-09-12"), [
    { start: "2026-09-11", end: "2026-09-12" },
  ]);
});

test("cursor já em hoje não gera janela — rodar duas vezes no dia não refaz nada", () => {
  assert.deepEqual(janelas("2026-09-12", "2026-09-12"), []);
});

test("cursor no futuro não anda para trás", () => {
  assert.deepEqual(janelas("2026-09-20", "2026-09-12"), []);
});

/**
 * O teste da retomada longa: o TMDB recusa mais de 14 dias, então um mês parado
 * tem que virar várias janelas — e nenhuma pode pular um dia.
 */
test("retomada longa vira janelas de no máximo 14 dias, sem buraco entre elas", () => {
  const js = janelas("2026-08-01", "2026-09-12");
  assert.deepEqual(js, [
    { start: "2026-08-01", end: "2026-08-15" },
    { start: "2026-08-15", end: "2026-08-29" },
    { start: "2026-08-29", end: "2026-09-12" },
  ]);

  for (const j of js) {
    const dias = (Date.parse(j.end) - Date.parse(j.start)) / 86_400_000;
    assert.ok(dias <= MAX_DIAS_JANELA, `${j.start}→${j.end} tem ${dias} dias`);
  }
  // Encostam no dia em comum: reprocessar é idempotente, pular congela título.
  for (let i = 1; i < js.length; i++) {
    assert.equal(js[i]!.start, js[i - 1]!.end);
  }
  assert.equal(js.at(-1)!.end, "2026-09-12");
});

test("janela atravessa a virada do mês e do ano sem quebrar a data", () => {
  assert.deepEqual(janelas("2025-12-28", "2026-01-05"), [
    { start: "2025-12-28", end: "2026-01-05" },
  ]);
});

test("data inválida não vira varredura do começo dos tempos", () => {
  assert.deepEqual(janelas("nunca", "2026-09-12"), []);
});

// ─── urls ───────────────────────────────────────────────────────────────────

test("a url do /changes carrega a janela e a página", () => {
  assert.equal(
    changesUrl("movie", { start: "2026-09-11", end: "2026-09-12" }, 3),
    "https://api.themoviedb.org/3/movie/changes?start_date=2026-09-11&end_date=2026-09-12&page=3",
  );
  assert.equal(
    changesUrl("tv", { start: "2026-09-11", end: "2026-09-12" }, 1),
    "https://api.themoviedb.org/3/tv/changes?start_date=2026-09-11&end_date=2026-09-12&page=1",
  );
});

test("o detalhe usa o tipo do título, que é o que muda entre filme e série", () => {
  assert.equal(detalheUrl("movie", "808"), "https://api.themoviedb.org/3/movie/808");
  assert.equal(detalheUrl("tv", "1429"), "https://api.themoviedb.org/3/tv/1429");
});

// ─── adaptação do detalhe ───────────────────────────────────────────────────

const filme = {
  id: 808,
  title: "Shrek",
  original_title: "Shrek",
  overview: "Um ogro e um burro.",
  poster_path: "/shrek.jpg",
  backdrop_path: "/shrek-bg.jpg",
  release_date: "2001-05-18",
  original_language: "en",
  genres: [{ id: 16, name: "Animation" }, { id: 35, name: "Comedy" }],
  vote_average: 7.779,
  vote_count: 19286,
};

const serie = {
  id: 1429,
  name: "Attack on Titan",
  original_name: "進撃の巨人",
  overview: "Titãs.",
  poster_path: "/aot.jpg",
  backdrop_path: null,
  first_air_date: "2013-04-07",
  original_language: "ja",
  genres: [{ id: 16, name: "Animation" }, { id: 10759, name: "Action & Adventure" }],
  vote_average: 8.7,
  vote_count: 7683,
};

/**
 * A razão de esta função existir: `/discover` manda `genre_ids: number[]` e o
 * detalhe manda `genres: [{id}]`. O `normalize()` é ponto congelado e só
 * entende o primeiro — se a tradução errar, o título perde todos os gêneros, e
 * título sem gênero é invisível para todo filtro e para o boost.
 */
test("genres: [{id}] do detalhe vira genre_ids que o normalize congelado entende", () => {
  assert.deepEqual(paraTmdbItem(filme, "movie")?.genre_ids, [16, 35]);
  assert.deepEqual(paraTmdbItem(serie, "tv")?.genre_ids, [16, 10759]);
});

test("série usa name/first_air_date; filme usa title/release_date", () => {
  const f = paraTmdbItem(filme, "movie")!;
  assert.equal(f.title, "Shrek");
  assert.equal(f.release_date, "2001-05-18");
  const s = paraTmdbItem(serie, "tv")!;
  assert.equal(s.name, "Attack on Titan");
  assert.equal(s.first_air_date, "2013-04-07");
});

test("o detalhe passa pelo MESMO portão de qualidade da carga", () => {
  const n = normalizarDetalhe(filme, "movie")!;
  assert.equal(n.externalId, "808");
  assert.equal(n.title, "Shrek");
  assert.equal(n.posterUrl, "https://image.tmdb.org/t/p/w500/shrek.jpg");
  assert.equal(n.voteAverage, "7.8");
  // Animação japonesa ganha o gênero Anime (id 3), derivado e não do TMDB.
  assert.ok(normalizarDetalhe(serie, "tv")!.genreIds.includes(3));
});

test("sem pôster ou sem sinopse continua barrado: card mudo quebra o swipe", () => {
  assert.equal(normalizarDetalhe({ ...filme, poster_path: null }, "movie"), null);
  assert.equal(normalizarDetalhe({ ...filme, overview: "" }, "movie"), null);
});

/**
 * A régua de votos é portão de ENTRADA (I0.1). Reaplicá-la na atualização faria
 * um título já no catálogo ser rejeitado só porque o TMDB reajustou a contagem
 * — e rejeitar aqui significa congelar a linha, nunca apagar.
 */
test("título já nosso não é barrado por contagem de votos na atualização", () => {
  assert.equal(MIN_VOTES_REFRESCO, 0);
  const pouco = normalizarDetalhe({ ...filme, vote_count: 1 }, "movie");
  assert.equal(pouco?.title, "Shrek");
  assert.equal(pouco?.score, 0);
});

test("virou adult: não atualiza — o /discover nunca traria isso", () => {
  assert.equal(paraTmdbItem({ ...filme, adult: true }, "movie"), null);
  assert.equal(normalizarDetalhe({ ...filme, adult: true }, "movie"), null);
});

test("resposta fora do formato não vira título vazio no catálogo", () => {
  assert.equal(paraTmdbItem(null, "movie"), null);
  assert.equal(paraTmdbItem({}, "movie"), null);
  assert.equal(paraTmdbItem({ id: "808" }, "movie"), null);
  assert.equal(paraTmdbItem("nada", "movie"), null);
  // Com id mas sem o resto, o portão do normalize é quem barra.
  assert.equal(normalizarDetalhe({ id: 1 }, "movie"), null);
});

test("genres sujo não derruba a passada inteira", () => {
  assert.deepEqual(paraTmdbItem({ ...filme, genres: [{ name: "sem id" }, { id: 35 }] }, "movie")?.genre_ids, [35]);
  assert.deepEqual(paraTmdbItem({ ...filme, genres: "não é lista" }, "movie")?.genre_ids, []);
});
