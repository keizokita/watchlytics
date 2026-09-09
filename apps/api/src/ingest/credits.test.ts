import test from "node:test";
import assert from "node:assert/strict";
import { CAST_STORED, creditsUrl, ehNaoEncontrado, mainCast } from "./credits.ts";

/**
 * Só a parte pura: sem chave do TMDB e sem Postgres, como o tmdb.test.ts.
 * O `credits.ts` só executa a passada quando é o programa, então importar aqui
 * não dispara nada.
 */

const entrada = (cast: unknown) => ({ id: 1, cast });

test("pega os principais na ordem do TMDB, não na do array", () => {
  const nomes = mainCast(
    entrada([
      { name: "Terceiro", order: 2 },
      { name: "Primeiro", order: 0 },
      { name: "Segundo", order: 1 },
    ]),
  );
  assert.deepEqual(nomes, ["Primeiro", "Segundo", "Terceiro"]);
});

test("guarda 5 por padrão — o card mostra 3, mas quem corta é o card", () => {
  const cast = Array.from({ length: 12 }, (_, i) => ({ name: `Ator ${i}`, order: i }));
  assert.equal(mainCast(entrada(cast)).length, CAST_STORED);
  assert.equal(CAST_STORED, 5);
});

test("ator com dois papéis não vira nome repetido no card", () => {
  const nomes = mainCast(
    entrada([
      { name: "Tom Hanks", order: 0 },
      { name: "Tom Hanks", order: 1 },
      { name: "Robin Wright", order: 2 },
    ]),
  );
  assert.deepEqual(nomes, ["Tom Hanks", "Robin Wright"]);
});

test("sem `order` vai para o fim, não para o começo", () => {
  const nomes = mainCast(entrada([{ name: "Sem posição" }, { name: "Protagonista", order: 0 }]));
  assert.deepEqual(nomes, ["Protagonista", "Sem posição"]);
});

test("título sem elenco devolve vazio, não quebra", () => {
  assert.deepEqual(mainCast(entrada([])), []);
  // Resposta fora do formato esperado é o caso que mais aparece na prática.
  assert.deepEqual(mainCast(entrada(undefined)), []);
  assert.deepEqual(mainCast({}), []);
  assert.deepEqual(mainCast(null), []);
});

test("entrada suja não vira nome vazio no card", () => {
  const nomes = mainCast(
    entrada([
      { name: "   ", order: 0 },
      { name: 42, order: 1 },
      { name: "  Nome Válido  ", order: 2 },
    ]),
  );
  assert.deepEqual(nomes, ["Nome Válido"]);
});

test("a url usa o tipo do título, que é o que muda entre filme e série", () => {
  assert.equal(
    creditsUrl("movie", "10112"),
    "https://api.themoviedb.org/3/movie/10112/credits",
  );
  assert.equal(creditsUrl("tv", "1429"), "https://api.themoviedb.org/3/tv/1429/credits");
});

/**
 * Este é o teste que ganha valor no dia em que alguém mexer no http.ts: o 404
 * é reconhecido pela MENSAGEM, porque aquele arquivo é ponto congelado e não
 * expõe o status. Se o texto mudar, é aqui que aparece — e não em silêncio,
 * marcando o catálogo inteiro como "sem elenco".
 */
test("404 é título que saiu do TMDB; o resto do erro tem que subir", () => {
  assert.equal(ehNaoEncontrado(new Error("TMDB 404 em https://api.themoviedb.org/3/movie/1/credits")), true);
  assert.equal(ehNaoEncontrado(new Error("TMDB 401 em https://api.themoviedb.org/3/movie/1/credits")), false);
  assert.equal(ehNaoEncontrado(new Error("429 persistente no TMDB")), false);
  assert.equal(ehNaoEncontrado(new Error("fetch failed")), false);
  assert.equal(ehNaoEncontrado("TMDB 404 em algum lugar"), false);
});
