import { and, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GENRE_NAME_BY_ID,
  HANDLE_SEARCH_MIN,
  STATS_MIN_WATCHED,
  type ProfileStats,
  type PublicUser,
} from "@watchlytics/contract";
import { httpError, rateLimit, requireUserId } from "../auth.ts";
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

/** "142 titles watched · 9 days of screen time · Drama, Sci-Fi & Comedy" */
function summary(stats: ProfileStats): string {
  const plural = (n: number, palavra: string) => `${n} ${palavra}${n === 1 ? "" : "s"}`;
  const parts = [plural(stats.watchedCount, "title") + " watched"];
  if (!stats.aggregates) {
    parts.push(`stats unlock at ${STATS_MIN_WATCHED}`);
    return parts.join(" · ");
  }
  const days = Math.round(stats.aggregates.estimatedMinutes / 60 / 24);
  // Singular quando é um: este texto vai no preview que outra pessoa recebe no
  // WhatsApp, e "1 days of screen time" é a primeira coisa que ela lê do app.
  if (days > 0) parts.push(`${plural(days, "day")} of screen time`);
  const genres = stats.aggregates.topGenres
    .map((g) => GENRE_NAME_BY_ID.get(g.genreId))
    .filter((n): n is string => Boolean(n));
  if (genres.length) parts.push(genres.join(", "));
  return parts.join(" · ");
}

/**
 * O HTML que vira preview quando o link circula.
 *
 * **A arte do `og:image` é a MESMA para todo perfil** (#38), e isso é decisão de
 * privacidade, não preguiça: quem busca a imagem do preview é o servidor do
 * WhatsApp, do X ou do Slack, não o navegador de quem clicou. Um pôster da
 * biblioteca sairia mais bonito e custaria zero infra — o `poster_url` já está
 * no banco —, mas viraria "o que fulano assistiu" no cache de um terceiro.
 *
 * Havia aqui a justificativa de NÃO ter `og:image` porque não havia pôster no
 * catálogo. Aquilo venceu: são 9.769 títulos com pôster desde a I1, e a razão
 * que sobrou é a de cima, que não depende do catálogo.
 *
 * `summary_large_image` e não `summary`: com imagem de 1200×630, o `summary`
 * recorta num quadrado pequeno e joga fora a arte.
 */
function page(profile: Profile, url: string, origin: string): string {
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
${meta("og:image", `${origin}/og.png`)}
${meta("og:image:width", "1200")}
${meta("og:image:height", "630")}
${meta("og:image:alt", "Watchlytics — find what to watch next.")}
<meta name="twitter:card" content="summary_large_image">
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100dvh; background: #10131a; color: #e8eaf0 }
  main { text-align: center; padding: 2rem }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem }
  .handle, .muted { color: #98a0b3 }
  .summary { margin-top: 1.25rem; font-size: 1.1rem }
  /* O link é o único alvo da página: alvo de toque de 44px e foco visível,
     porque quem chega aqui por teclado tem UMA parada e ela precisa aparecer. */
  .entrar { display: inline-block; margin-top: 1.75rem; padding: .7rem 1.2rem;
            min-height: 44px; box-sizing: border-box; border-radius: 999px;
            border: 1px solid #2a3040; color: #e8eaf0; text-decoration: none }
  .entrar:hover { border-color: #4a5268 }
  .entrar:focus-visible { outline: 2px solid #e8eaf0; outline-offset: 3px }
</style>
<main>
  <h1>${escape(profile.displayName)}</h1>
  <p class="handle">@${escape(profile.handle)}</p>
  <p class="summary">${escape(desc)}</p>
  <a class="entrar" href="${escape(origin)}/">Open Watchlytics</a>
</main>
`;
}

/** Quem procura amigo procura poucas vezes; quem varre handle procura muito. */
const SEARCH_PER_MIN = 30;

/**
 * `%` e `_` dentro do termo são curinga do LIKE — sem escapar, buscar por `%`
 * lista o banco inteiro, que é exatamente a enumeração que o piso de 3
 * caracteres existe para impedir.
 */
const likePrefix = (q: string) => `${q.replace(/[\\%_]/g, "\\$&")}%`;

export function profileRoutes(app: FastifyInstance): void {
  /**
   * E1 — busca por handle, e SÓ por handle. O email nem entra na query: a
   * coluna existe para contato, nunca para achar gente (PLAN §8.6).
   *
   * Devolve lista vazia, nunca 404: "não achei" e "existe mas não te mostro"
   * têm que ser indistinguíveis de fora.
   */
  app.get<{ Querystring: { q?: string } }>("/v1/users", async (req) => {
    const userId = await requireUserId(req);
    if (!rateLimit(`search:${userId}`, SEARCH_PER_MIN)) {
      throw httpError(429, "muitas buscas");
    }

    const q = (req.query.q ?? "").trim();
    if (q.length < HANDLE_SEARCH_MIN) return { items: [] };

    const items: PublicUser[] = await db
      .select({
        id: users.id,
        handle: users.handle,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(
        and(
          sql`lower(${users.handle}) like lower(${likePrefix(q)})`,
          // Achar a si mesmo não ajuda ninguém e ainda ocupa um resultado.
          ne(users.id, userId),
        ),
      )
      .orderBy(users.handle)
      .limit(10);

    return { items };
  });

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

    // PUBLIC_ORIGIN e não o header Host: o `og:url` vai dentro do preview que
    // outra pessoa vê, e Host é do cliente. Em dev não há proxy nem CDN, então
    // o header serve de fallback.
    const origin =
      process.env["PUBLIC_ORIGIN"] ?? `http://${req.headers.host ?? "localhost"}`;

    reply.type("text/html; charset=utf-8");
    if (!profile) {
      reply.code(404);
      // O 404 leva o mesmo caminho de volta que a página cheia: quem recebeu um
      // link que morreu é justamente quem não tem outra porta de entrada.
      return `<!doctype html><meta charset=utf-8><title>Not found</title>
<p>No public profile here. <a href="${escape(origin)}/">Open Watchlytics</a>`;
    }

    return page(profile, `${origin}/u/${profile.handle}`, origin);
  });
}
