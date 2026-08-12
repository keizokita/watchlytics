import { desc } from "drizzle-orm";
import Fastify from "fastify";
import type { Title } from "@watchlytics/contract";
import { db, pg } from "./db/client.ts";
import { titles } from "./db/schema.ts";

type Row = typeof titles.$inferSelect;

/** numeric volta como string do postgres.js; o contrato pede número. */
const toTitle = (r: Row): Title => ({
  id: r.id,
  type: r.type as Title["type"],
  title: r.title,
  originalTitle: r.originalTitle,
  overview: r.overview,
  posterUrl: r.posterUrl,
  backdropUrl: r.backdropUrl,
  releaseYear: r.releaseYear,
  runtimeMinutes: r.runtimeMinutes,
  originalLanguage: r.originalLanguage,
  genreIds: r.genreIds,
  score: r.score,
  voteAverage: Number(r.voteAverage ?? 0),
});

export function buildServer() {
  const app = Fastify();

  app.get("/health", async () => ({ ok: true }));

  /**
   * Lote de 20, ordenado por score. Sem filtro, sem auth, sem exclusão de
   * já-avaliado — isso é A1/A2/C4. Aqui só se prova que o cano chega ao card.
   */
  app.get("/v1/feed", async () => {
    const rows = await db
      .select()
      .from(titles)
      .orderBy(desc(titles.score))
      .limit(20);

    return { items: rows.map(toTitle), nextCursor: null };
  });

  return app;
}

if (import.meta.main) {
  const port = Number(process.env["PORT"] ?? 3000);
  const app = buildServer();
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`api em http://localhost:${port}`);

  // Sem isso o Fly manda SIGTERM, espera, e mata com SIGKILL a cada deploy —
  // derrubando requisição em voo e deixando conexão pendurada no Postgres.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, async () => {
      await app.close();
      await pg.end();
      process.exit(0);
    });
  }
}
