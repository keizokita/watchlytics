import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GENRE_NAME_BY_ID,
  STATS_MIN_WATCHED,
  type ProfileStats,
} from "@watchlytics/contract";
import { db } from "../db/client.ts";
import { users } from "../db/schema.ts";
import { statsOf } from "./library.ts";

/**
 * D5 — perfil público.
 *
 * Duas rotas sobre a MESMA consulta: `/v1/users/:handle` para cliente (o app
 * da fase 4 inclusive) e `/u/:handle` para quem cola o link no WhatsApp. A
 * segunda é a única rota do sistema que devolve HTML (PLAN §7) — crawler não
 * roda JavaScript, então preview de SPA é preview vazio.
 */

/** Mesmo formato do handle gerado no OAuth. Barra o path traversal de graça. */
const handleParam = z.object({
  handle: z.string().regex(/^[a-z0-9-]{3,32}$/i),
});

type Profile = {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  stats: ProfileStats;
};

/**
 * `null` = não existe OU não é público. A distinção não sai daqui: o 404
 * idêntico nos dois casos é o que impede varrer handles para descobrir quem
 * tem conta (PLAN §8.6).
 */
async function publicProfile(handle: string): Promise<Profile | null> {
  const [row] = await db
    .select({
      id: users.id,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(sql`lower(${users.handle}) = lower(${handle}) and ${users.isPublic}`);

  if (!row) return null;
  const { id, ...rest } = row;
  return { ...rest, stats: await statsOf(id) };
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** "142 titles watched · 9 days watched · Drama, Sci-Fi & Comedy" */
function summary(stats: ProfileStats): string {
  const parts = [`${stats.watchedCount} titles watched`];
  if (!stats.aggregates) {
    parts.push(`stats unlock at ${STATS_MIN_WATCHED}`);
    return parts.join(" · ");
  }
  const days = Math.round(stats.aggregates.estimatedMinutes / 60 / 24);
  if (days > 0) parts.push(`${days} days of screen time`);
  const genres = stats.aggregates.topGenres
    .map((g) => GENRE_NAME_BY_ID.get(g.genreId))
    .filter((n): n is string => Boolean(n));
  if (genres.length) parts.push(genres.join(", "));
  return parts.join(" · ");
}

/**
 * Sem `og:image`: não há pôster no catálogo (B4 está parada pelo mesmo motivo)
 * e og:image apontando para nada faz o WhatsApp mostrar um retângulo cinza —
 * pior que preview só de texto.
 */
function page(profile: Profile, url: string): string {
  const title = `${profile.displayName} on Watchlytics`;
  const desc = summary(profile.stats);
  const meta = (property: string, content: string) =>
    `<meta property="${property}" content="${escape(content)}">`;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(desc)}">
${meta("og:type", "profile")}
${meta("og:title", title)}
${meta("og:description", desc)}
${meta("og:url", url)}
<meta name="twitter:card" content="summary">
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100dvh; background: #10131a; color: #e8eaf0 }
  main { text-align: center; padding: 2rem }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem }
  .handle, .muted { color: #98a0b3 }
  .summary { margin-top: 1.25rem; font-size: 1.1rem }
</style>
<main>
  <h1>${escape(profile.displayName)}</h1>
  <p class="handle">@${escape(profile.handle)}</p>
  <p class="summary">${escape(desc)}</p>
  <p class="muted">Watchlytics</p>
</main>
`;
}

export function profileRoutes(app: FastifyInstance): void {
  app.get<{ Params: { handle: string } }>(
    "/v1/users/:handle",
    async (req, reply) => {
      const parsed = handleParam.safeParse(req.params);
      const profile = parsed.success
        ? await publicProfile(parsed.data.handle)
        : null;

      if (!profile) {
        reply.code(404);
        return { error: "perfil não encontrado" };
      }
      return profile;
    },
  );

  app.get<{ Params: { handle: string } }>("/u/:handle", async (req, reply) => {
    const parsed = handleParam.safeParse(req.params);
    const profile = parsed.success
      ? await publicProfile(parsed.data.handle)
      : null;

    reply.type("text/html; charset=utf-8");
    if (!profile) {
      reply.code(404);
      return "<!doctype html><meta charset=utf-8><title>Not found</title><p>No public profile here.";
    }

    // PUBLIC_ORIGIN e não o header Host: o `og:url` vai dentro do preview que
    // outra pessoa vê, e Host é do cliente. Em dev não há proxy nem CDN, então
    // o header serve de fallback.
    const origin =
      process.env["PUBLIC_ORIGIN"] ?? `http://${req.headers.host ?? "localhost"}`;
    return page(profile, `${origin}/u/${profile.handle}`);
  });
}
