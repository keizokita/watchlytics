import test from "node:test";
import assert from "node:assert/strict";
import type { Title } from "@watchlytics/contract";
import { cardBackground, gradient } from "./poster.ts";

/**
 * B4 — o driver não cobre isto sozinho: qual título está no topo do deck
 * depende do ruído do feed, e um card sem `posterUrl` faz a asserção de lá
 * passar sem nunca exercitar o caminho de duas camadas.
 */

const titulo = (over: Partial<Title>): Title =>
  ({
    id: "9f1c0c2e-0000-4000-8000-000000000001",
    type: "movie",
    title: "Um",
    originalTitle: null,
    overview: "",
    posterUrl: null,
    releaseYear: 2001,
    originalLanguage: "en",
    genreIds: [],
    score: 50,
    voteAverage: 7,
    ...over,
  }) as Title;

test("com pôster, o gradiente do id fica ATRÁS — não é substituído", () => {
  const url = "https://image.tmdb.org/t/p/w500/abc.jpg";
  const css = cardBackground(titulo({ posterUrl: url }));

  const vezes = (s: string) => css.split(s).length - 1;
  assert.ok(css.includes(url), "o pôster tem que estar lá");
  assert.ok(
    css.includes(gradient(titulo({}).id)),
    "o forro é o MESMO gradiente do id, não um qualquer",
  );
  // A ordem é o que importa: em `background`, a primeira camada é a de cima.
  assert.ok(
    css.indexOf(url) < css.indexOf("linear-gradient"),
    "pôster na frente, gradiente atrás",
  );
  // Contar por vírgula não serve: o gradiente tem as suas dentro do hsl().
  assert.equal(vezes("url("), 1, "uma camada de pôster");
  assert.equal(vezes("linear-gradient("), 1, "uma camada de forro");
});

test("sem pôster, sobra só o gradiente", () => {
  const css = cardBackground(titulo({ posterUrl: null }));
  assert.equal(css, gradient(titulo({}).id));
  assert.ok(!css.includes("url("));
});

test("a url vai entre aspas: caminho com parêntese não quebra a declaração", () => {
  const css = cardBackground(titulo({ posterUrl: "https://x/a(1).jpg" }));
  assert.ok(css.includes('url("https://x/a(1).jpg")'));
});

test("o gradiente é determinístico e depende do id", () => {
  assert.equal(gradient("abc"), gradient("abc"));
  assert.notEqual(gradient("abc"), gradient("abd"));
});
