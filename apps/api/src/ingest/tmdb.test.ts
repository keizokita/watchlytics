import assert from "node:assert/strict";
import test from "node:test";
import { GENRE_IDS } from "@watchlytics/contract";
import {
  ANIME,
  discoverUrl,
  mapGenres,
  normalize,
  normalizeScore,
  type TmdbItem,
} from "./tmdb.ts";

/**
 * Só a parte pura: nada de rede, nada de banco, nenhuma chave necessária.
 *
 * O que estas asserções guardam é o que quebra em silêncio — mapa de gênero
 * errado some com o título de todo filtro, e portão frouxo deixa entrar card
 * sem pôster, que é o que destrói a mecânica de swipe.
 */

/**
 * Payload de SÉRIE: o TMDB usa `name`/`first_air_date`, e só filme usa
 * `title`/`release_date`. Trocar os dois é erro fácil de cometer e silencioso —
 * `normalize` devolve null e o balde inteiro do ano vira "fora do portão" sem
 * nenhum erro aparecer. Foi exatamente o que aconteceu na primeira versão deste
 * arquivo, e fez o teste do portão passar por motivo errado.
 */
const base: TmdbItem = {
  id: 1396,
  name: "Breaking Bad",
  original_name: "Breaking Bad",
  overview: "Um professor de química terminal começa a cozinhar metanfetamina.",
  poster_path: "/abc.jpg",
  backdrop_path: "/def.jpg",
  first_air_date: "2008-01-20",
  original_language: "en",
  genre_ids: [80, 18, 53],
  vote_average: 8.9,
  vote_count: 14200,
};

test("todo gênero mapeado existe no nosso catálogo de 19", () => {
  const tmdbTodos = [
    28, 12, 10759, 16, 35, 80, 99, 18, 10751, 36, 27, 10762, 10402, 9648,
    10764, 10749, 878, 14, 10765, 53, 10752, 10768, 37,
  ];
  for (const id of mapGenres(tmdbTodos, "en")) {
    assert.ok(GENRE_IDS.includes(id), `gênero ${id} não existe em genres.ts`);
  }
});

test("os merges do TMDB caem num gênero só", () => {
  // Action + Adventure (filme) e Action & Adventure (série) → o mesmo id nosso
  assert.deepEqual(mapGenres([28, 12], "en"), mapGenres([10759, 10759], "en"));
  // Sci-Fi e Fantasy separados no filme, juntos na série
  assert.deepEqual(mapGenres([878, 14], "en"), mapGenres([10765], "en"));
});

test("gênero de não-descoberta é descartado", () => {
  // TV Movie, News, Talk, Soap não viram nada
  assert.deepEqual(mapGenres([10770, 10763, 10767, 10766], "en"), []);
});

test("anime é animação japonesa, e só", () => {
  assert.ok(mapGenres([16], "ja").includes(ANIME), "animação japonesa é anime");
  assert.ok(!mapGenres([16], "en").includes(ANIME), "Pixar não é anime");
  assert.ok(!mapGenres([18], "ja").includes(ANIME), "drama japonês não é anime");
});

test("score sai de vote_count, em escala log", () => {
  assert.equal(normalizeScore(100), 0);
  assert.equal(normalizeScore(0), 0);
  assert.ok(normalizeScore(1000) > normalizeScore(100));
  assert.ok(normalizeScore(100_000) <= 100, "não estoura o smallint 0-100");
  assert.ok(normalizeScore(10_000_000) <= 100, "clampa no absurdo");
});

test("portão barra card que quebraria o deck", () => {
  const barra = (patch: Partial<TmdbItem>, motivo: string) =>
    assert.equal(normalize({ ...base, ...patch }, "tv", 500), null, motivo);

  // guarda contra o falso-verde: sem esta linha, um `base` quebrado faria todas
  // as asserções abaixo passarem sem testar nada
  assert.ok(normalize(base, "tv", 500), "o item de base tem que passar");

  barra({ poster_path: null }, "sem pôster");
  barra({ overview: "" }, "sem sinopse");
  barra({ vote_count: 12 }, "abaixo da régua de curadoria");
  barra({ genre_ids: [10770] }, "sem nenhum gênero nosso");
  barra({ first_air_date: "" }, "sem ano");
  barra({ name: undefined }, "série sem `name` (campo de filme não serve)");
});

test("item válido é normalizado para o nosso formato", () => {
  const n = normalize(base, "tv", 500);
  assert.ok(n);
  assert.equal(n.externalId, "1396");
  assert.equal(n.releaseYear, 2008);
  assert.equal(n.originalTitle, null, "título original igual não é repetido");
  assert.match(n.posterUrl ?? "", /^https:\/\/image\.tmdb\.org\/t\/p\/w500\//);
  assert.equal(n.voteAverage, "8.9", "numeric do postgres.js quer string");
  assert.equal(n.originalLanguage.length, 2, "cabe no char(2)");
  assert.deepEqual(n.genreIds, [5, 7, 17], "Crime, Drama, Thriller");
});

test("discover particiona por tipo e ano, com a régua de votos", () => {
  const filme = new URL(discoverUrl({ type: "movie", year: 1999, page: 2, minVotes: 500 }));
  assert.equal(filme.searchParams.get("primary_release_year"), "1999");
  assert.equal(filme.searchParams.get("vote_count.gte"), "500");
  assert.equal(filme.searchParams.get("sort_by"), "vote_count.desc");

  // série usa outro parâmetro de ano — trocar os dois devolve zero resultado
  const serie = new URL(discoverUrl({ type: "tv", year: 1999, page: 1, minVotes: 500 }));
  assert.equal(serie.searchParams.get("first_air_date_year"), "1999");
  assert.equal(serie.searchParams.get("primary_release_year"), null);

  const anime = new URL(
    discoverUrl({ type: "tv", year: 2023, page: 1, minVotes: 80, anime: true }),
  );
  assert.equal(anime.searchParams.get("with_genres"), "16");
  assert.equal(anime.searchParams.get("with_original_language"), "ja");

  // Reality tem piso próprio pelo mesmo motivo do anime, mas sem filtro de
  // idioma: o gênero é 10764 e vale para série de qualquer país.
  const reality = new URL(
    discoverUrl({ type: "tv", year: 2019, page: 1, minVotes: 50, reality: true }),
  );
  assert.equal(reality.searchParams.get("with_genres"), "10764");
  assert.equal(reality.searchParams.get("with_original_language"), null);
  assert.equal(reality.searchParams.get("vote_count.gte"), "50");
});
