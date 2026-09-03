import Fastify from "fastify";
import { pg } from "./db/client.ts";
import { registerAuth } from "./routes/auth.ts";
import { feedRoutes } from "./routes/feed.ts";
import { libraryRoutes } from "./routes/library.ts";
import { meRoutes } from "./routes/me.ts";
import { onboardingRoutes } from "./routes/onboarding.ts";
import { profileRoutes } from "./routes/profile.ts";
import { swipeRoutes } from "./routes/swipes.ts";

/**
 * Raiz de composição. Uma rota por módulo em routes/ — o arquivo passou a ser
 * ponto de contenção quando mais de uma trilha começou a mexer nele ao mesmo
 * tempo, que era exatamente a condição para dividir.
 */
export function buildServer() {
  const app = Fastify();

  app.get("/health", async () => ({ ok: true }));

  registerAuth(app);
  feedRoutes(app);
  swipeRoutes(app);
  libraryRoutes(app);
  meRoutes(app);
  onboardingRoutes(app);
  profileRoutes(app);

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
