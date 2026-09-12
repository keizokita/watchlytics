import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pg } from "../db/client.ts";
import { ingestState } from "../db/schema.ts";
import {
  anoDeRetomada,
  gravarEstado,
  lerEstado,
  regua,
  type Backfill,
} from "./state.ts";

// ─── retomada (I2.3) — pura, sem banco ──────────────────────────────────────

const R = regua({
  from: 1970,
  to: 2026,
  minVotes: 800,
  minVotesAnime: 80,
  minVotesReality: 50,
});

/** O critério, literal: "morreu em 2003, recomeça em 2003 e não em 1970". */
test("morreu em 2003 recomeça em 2003, não em 1970", () => {
  // 2002 é o último ano CONCLUÍDO: 2003 morreu no meio e tem que ser refeito.
  const { ano } = anoDeRetomada({ ano: 2002, regua: R }, R, 1970, 2026);
  assert.equal(ano, 2003);
});

test("sem cursor, carga do começo", () => {
  assert.equal(anoDeRetomada(null, R, 1970, 2026).ano, 1970);
});

/**
 * O caso que o cursor sozinho erraria em silêncio: retomar em 2003 uma carga de
 * régua 300 usando o cursor de uma carga de régua 800 deixaria o catálogo com
 * duas metades de critérios diferentes, parecendo completo.
 */
test("régua diferente invalida o cursor: carga do começo", () => {
  const outra = regua({
    from: 1970,
    to: 2026,
    minVotes: 300,
    minVotesAnime: 80,
    minVotesReality: 50,
  });
  const { ano, motivo } = anoDeRetomada({ ano: 2002, regua: R }, outra, 1970, 2026);
  assert.equal(ano, 1970);
  assert.match(motivo, /régua mudou/);
});

test("intervalo de anos diferente também muda a régua", () => {
  assert.notEqual(
    R,
    regua({ from: 2015, to: 2026, minVotes: 800, minVotesAnime: 80, minVotesReality: 50 }),
  );
});

/**
 * Carga completa não pode virar comando que não faz nada: revarrer os anos é
 * como título NOVO entra no catálogo — o `/changes` da I2.1 só atualiza o que
 * já temos, por decisão explícita.
 */
test("carga anterior completa recomeça do início em vez de não fazer nada", () => {
  const { ano, motivo } = anoDeRetomada({ ano: 2026, regua: R }, R, 1970, 2026);
  assert.equal(ano, 1970);
  assert.match(motivo, /completa/);
});

test("cursor fora do intervalo pedido não escapa do FROM", () => {
  assert.equal(anoDeRetomada({ ano: 1990, regua: R }, R, 2015, 2026).ano, 2015);
});

// ─── ingest_state — precisa de banco ────────────────────────────────────────

const CHAVE = "teste_state_i2";

test.after(async () => {
  await db.delete(ingestState).where(eq(ingestState.key, CHAVE));
  // Sem fechar o pool o processo do node:test nunca sai — a conexão segura o
  // event loop e a suíte inteira pendura. É o que todo teste com banco faz aqui.
  await pg.end();
});

test("grava, relê e sobrescreve a mesma chave sem duplicar linha", async () => {
  await db.delete(ingestState).where(eq(ingestState.key, CHAVE));

  // Chave nunca gravada é null, que é diferente de gravada vazia.
  assert.equal(await lerEstado(CHAVE), null);

  await gravarEstado(CHAVE, { ano: 2002 });
  assert.deepEqual(await lerEstado<{ ano: number }>(CHAVE), { ano: 2002 });

  // A segunda gravação é a que importa: a chave é primária, e sem
  // onConflictDoUpdate o cursor nunca avançaria — ele quebraria a passada.
  await gravarEstado(CHAVE, { ano: 2003 });
  assert.deepEqual(await lerEstado<{ ano: number }>(CHAVE), { ano: 2003 });

  const linhas = await db
    .select()
    .from(ingestState)
    .where(eq(ingestState.key, CHAVE));
  assert.equal(linhas.length, 1);
});

test("o cursor da carga sobrevive à ida e volta do jsonb", async () => {
  const cursor: Backfill = { ano: 2003, regua: R };
  await gravarEstado(CHAVE, cursor);
  const lido = await lerEstado<Backfill>(CHAVE);
  assert.deepEqual(lido, cursor);
  // E o valor que volta do banco é aceito pela retomada sem tradução no meio.
  assert.equal(anoDeRetomada(lido, R, 1970, 2026).ano, 2004);
});
