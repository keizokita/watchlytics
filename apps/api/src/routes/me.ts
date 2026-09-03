import { desc, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUserId } from "../auth.ts";
import { db } from "../db/client.ts";
import {
  consents,
  friendships,
  identities,
  libraryEntries,
  matches,
  notifications,
  swipes,
  users,
} from "../db/schema.ts";

/**
 * C6 — os dois direitos que a lei dá sobre a própria conta (PLAN §8.4 e §8.5).
 *
 * Não há schema no contrato para o export: ele não é consumido pela tela, é um
 * arquivo que a pessoa baixa e abre. Congelar o formato num zod só criaria uma
 * segunda definição para manter — a forma é "o que está no banco".
 */
export function meRoutes(app: FastifyInstance): void {
  /**
   * Portabilidade. POST porque escreve nada mas também não é cacheável, e é o
   * que o PLAN §7 registra.
   *
   * `sessions` fica de fora de propósito: hash de refresh é credencial, não
   * dado pessoal — exportá-lo entregaria num arquivo a chave que o banco
   * guarda justamente para não entregar.
   *
   * ponytail: carrega tudo em memória. O teto é o tamanho do catálogo por
   * pessoa (milhares de linhas, não milhões); vira streaming NDJSON no dia em
   * que uma conta não couber numa resposta.
   */
  app.post("/v1/me/export", async (req, reply) => {
    const userId = requireUserId(req);

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      reply.code(404);
      return { error: "conta não encontrada" };
    }

    // O par de amizade é normalizado (user_a < user_b), então "meus amigos"
    // são as linhas em que eu apareço de qualquer um dos lados.
    const meNoPar = (t: typeof friendships | typeof matches) =>
      or(eq(t.userA, userId), eq(t.userB, userId));

    const data = {
      exportedAt: new Date().toISOString(),
      user,
      identities: await db
        .select({
          provider: identities.provider,
          emailAtProvider: identities.emailAtProvider,
          linkedAt: identities.linkedAt,
        })
        .from(identities)
        .where(eq(identities.userId, userId)),
      consents: await db
        .select()
        .from(consents)
        .where(eq(consents.userId, userId)),
      swipes: await db
        .select()
        .from(swipes)
        .where(eq(swipes.userId, userId))
        .orderBy(desc(swipes.updatedAt)),
      library: await db
        .select()
        .from(libraryEntries)
        .where(eq(libraryEntries.userId, userId))
        .orderBy(desc(libraryEntries.addedAt)),
      friends: await db.select().from(friendships).where(meNoPar(friendships)),
      matches: await db.select().from(matches).where(meNoPar(matches)),
      notifications: await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt)),
    };

    // Arquivo, não corpo de API: é isso que faz o direito de portabilidade
    // valer alguma coisa para quem não usa curl.
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="watchlytics-${user.handle.replace(/[^a-z0-9-]/gi, "")}.json"`,
    );
    return data;
  });

  /**
   * D5 — o perfil nasce privado (PLAN §8.2) e só o dono torna público. Um
   * campo só: o resto do perfil vem do provedor OAuth e não se edita aqui.
   */
  app.patch("/v1/me", async (req, reply) => {
    const userId = requireUserId(req);

    const parsed = z.object({ isPublic: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "requisição inválida" };
    }

    const [row] = await db
      .update(users)
      .set({ isPublic: parsed.data.isPublic })
      .where(eq(users.id, userId))
      .returning({ isPublic: users.isPublic });

    if (!row) {
      reply.code(404);
      return { error: "conta não encontrada" };
    }
    return row;
  });

  /**
   * Exclusão real, não `deleted_at`: PLAN §8.4 proíbe soft-delete de PII
   * fingindo ser exclusão. Uma linha só porque as oito tabelas que apontam para
   * `users` são todas `ON DELETE CASCADE` — o teste é quem prova isso, e é por
   * isso que ele conta tabela por tabela em vez de confiar no schema.
   *
   * O §8.4 também pede revogar o token do provedor. Não há o que revogar: o
   * OAuth troca o código por identidade e descarta os tokens do Google na hora
   * (`identities` não tem coluna para eles).
   */
  app.delete("/v1/me", async (req, reply) => {
    const userId = requireUserId(req);

    const gone = await db
      .delete(users)
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (gone.length === 0) {
      reply.code(404);
      return { error: "conta não encontrada" };
    }

    // A cascata já matou a sessão; isto tira do navegador a credencial morta.
    // Espelha o cookie de routes/auth.ts — mesmo nome e mesmo Path, senão o
    // navegador guarda um segundo cookie em vez de apagar o que existe.
    reply.header(
      "set-cookie",
      "wl_refresh=; Path=/v1/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
    reply.code(204);
    return null;
  });
}
