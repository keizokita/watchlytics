import { and, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MATCH_NOTIFY_STRENGTH,
  type FriendsResponse,
  type MatchEntry,
  type PublicUser,
} from "@watchlytics/contract";
import { httpError, requireUserId } from "../auth.ts";
import { db } from "../db/client.ts";
import {
  friendships,
  matches,
  notifications,
  titles,
  users,
} from "../db/schema.ts";
import { toTitle } from "./feed.ts";

/** Uma página de matches. Mesmo lote do feed: cabe numa tela e num swipe. */
const PAGE = 20;

/** O que `db.transaction` entrega — e o próprio `db`, que serve nos dois. */
type Tx = { execute: (q: SQL) => Promise<unknown> };
type TxCompleta = Tx & Pick<typeof db, "insert">;

/**
 * E2 — pedido e aceite de amizade.
 *
 * O par é normalizado (`user_a < user_b`) e o banco tem CHECK para isso: sem
 * a normalização, (ana, bruno) e (bruno, ana) são duas linhas e as duas
 * "existem", então a amizade fica dependendo de quem perguntou primeiro. Quem
 * pediu vive em `requested_by`, não na ordem das colunas.
 */

/** Teto de pedidos pendentes por conta (PLAN §10, spam de amizade). */
const MAX_PENDING_OUT = 50;

const pair = (x: string, y: string) => (x < y ? { userA: x, userB: y } : { userA: y, userB: x });

const publicColumns = {
  id: users.id,
  handle: users.handle,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
};

const byId = async (ids: string[]): Promise<Map<string, PublicUser>> => {
  if (ids.length === 0) return new Map();
  const rows = await db.select(publicColumns).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
};

/**
 * A consulta de match, uma só (E3 e E4 só discordam do recorte).
 *
 * A força sai do par de status (PLAN §5.3), não do swipe:
 *   ambos interested → 3, um assistiu → 2, ambos já assistiram → 1.
 *
 * `ON CONFLICT DO NOTHING`: o match é do PAR e do título, não do momento.
 * Reenvio do buffer offline não duplica nem reescreve a força — quando alguém
 * marca `watched` depois, quem atualiza é o PUT /v1/library, não este caminho.
 */
type LinhaInserida = { user_a: string; user_b: string; title_id: string; strength: number };

async function insertMatches(tx: Tx, recorte: SQL): Promise<LinhaInserida[]> {
  const inseridas = await tx.execute(sql`
    insert into matches (user_a, user_b, title_id, strength)
    select
      least(eu.user_id, amigo.user_id),
      greatest(eu.user_id, amigo.user_id),
      eu.title_id,
      case
        when eu.status = 'interested' and amigo.status = 'interested' then 3
        when eu.status = 'watched'    and amigo.status = 'watched'    then 1
        else 2
      end
    from library_entries eu
    join library_entries amigo
      on amigo.title_id = eu.title_id
     and amigo.user_id <> eu.user_id
    join friendships f
      on f.status = 'accepted'
     and f.user_a = least(eu.user_id, amigo.user_id)
     and f.user_b = greatest(eu.user_id, amigo.user_id)
    where ${recorte}
    on conflict do nothing
    returning user_a, user_b, title_id, strength
  `);
  // `on conflict do nothing` faz o returning trazer só o que entrou agora —
  // é isso que impede o E5 de notificar de novo um match que já existia.
  return inseridas as LinhaInserida[];
}

/**
 * E3 — match no like, na MESMA transação do swipe (PLAN §5.3).
 *
 * Não é otimização: a graça do produto é o match aparecer na hora, e fila
 * assíncrona custaria latência sem comprar nada nesta escala.
 */
export async function matchOnLike(
  tx: TxCompleta,
  userId: string,
  titleIds: string[],
): Promise<void> {
  const novos = await insertMatches(
    tx,
    sql`eu.user_id = ${userId} and eu.title_id in (${sql.join(
      titleIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );

  // E5 — só o match FORTE notifica (PLAN §5.3): os dois querem ver, é o
  // gancho "vamos assistir isso". Médio e fraco aparecem na aba e pronto —
  // notificar "vocês dois já assistiram" é aviso que ninguém pediu.
  //
  // Uma linha por pessoa e por match, sem agregar: aqui é um evento só. Quem
  // agrega é o aceite (E4), onde um clique pode render centenas.
  const fortes = novos.filter((m) => m.strength === MATCH_NOTIFY_STRENGTH);
  if (fortes.length === 0) return;

  await tx.insert(notifications).values(
    fortes.flatMap((m) => [
      {
        userId: m.user_a,
        type: "match",
        payload: { friendId: m.user_b, titleId: m.title_id },
      },
      {
        userId: m.user_b,
        type: "match",
        payload: { friendId: m.user_a, titleId: m.title_id },
      },
    ]),
  );
}

export function friendRoutes(app: FastifyInstance): void {
  /** As três listas de uma vez: a tela mostra as três juntas. */
  app.get("/v1/friends", async (req): Promise<FriendsResponse> => {
    const userId = requireUserId(req);

    const rows = await db
      .select()
      .from(friendships)
      .where(or(eq(friendships.userA, userId), eq(friendships.userB, userId)));

    const outro = (r: typeof rows[number]) => (r.userA === userId ? r.userB : r.userA);
    const found = await byId(rows.map(outro));
    const pick = (keep: (r: typeof rows[number]) => boolean) =>
      rows.filter(keep).flatMap((r) => found.get(outro(r)) ?? []);

    return {
      friends: pick((r) => r.status === "accepted"),
      incoming: pick((r) => r.status === "pending" && r.requestedBy !== userId),
      outgoing: pick((r) => r.status === "pending" && r.requestedBy === userId),
    };
  });

  /**
   * E5 — os títulos em comum, do mais recente para o mais antigo.
   *
   * Keyset pelo par (created_at, title_id), não OFFSET: a lista cresce
   * enquanto a pessoa rola, e OFFSET repetiria ou pularia linha. O par
   * desempata porque um aceite retroativo grava dezenas de matches com o
   * mesmo timestamp.
   */
  app.get<{ Querystring: { cursor?: string } }>("/v1/matches", async (req, reply) => {
    const userId = requireUserId(req);

    const cursor = req.query.cursor?.split("|");
    if (cursor && (cursor.length !== 2 || Number.isNaN(Date.parse(cursor[0]!)))) {
      reply.code(400);
      return { error: "cursor inválido" };
    }

    const amigo = sql`case when ${matches.userA} = ${userId} then ${matches.userB} else ${matches.userA} end`;

    const rows = await db
      .select({
        friend: publicColumns,
        title: titles,
        strength: matches.strength,
        createdAt: matches.createdAt,
      })
      .from(matches)
      .innerJoin(titles, eq(titles.id, matches.titleId))
      .innerJoin(users, sql`${users.id} = ${amigo}`)
      .where(
        and(
          or(eq(matches.userA, userId), eq(matches.userB, userId)),
          cursor
            ? sql`(${matches.createdAt}, ${matches.titleId}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(matches.createdAt), desc(matches.titleId))
      .limit(PAGE);

    const items: MatchEntry[] = rows.map((r) => ({
      friend: r.friend,
      title: toTitle(r.title),
      strength: r.strength as MatchEntry["strength"],
      createdAt: r.createdAt.toISOString(),
    }));

    const ultimo = rows.at(-1);
    return {
      items,
      // Cursor só quando a página encheu: página curta é fim de lista.
      nextCursor:
        rows.length === PAGE && ultimo
          ? `${ultimo.createdAt.toISOString()}|${ultimo.title.id}`
          : null,
    };
  });

  /**
   * Pedido por handle, não por id: é o handle que a pessoa digita e o único
   * identificador que a busca do E1 devolve para ser copiado.
   *
   * Reenviar o mesmo pedido não é erro nem linha nova — devolve o estado atual.
   * Cliente offline reenvia, e 409 aqui só faria a tela inventar tratamento.
   */
  app.post("/v1/friends/requests", async (req, reply) => {
    const userId = requireUserId(req);

    const parsed = z.object({ handle: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "requisição inválida" };
    }

    const [alvo] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.handle}) = lower(${parsed.data.handle})`);

    if (!alvo || alvo.id === userId) {
      reply.code(404);
      return { error: "usuário não encontrado" };
    }

    const chave = pair(userId, alvo.id);
    const [existente] = await db
      .select({ status: friendships.status })
      .from(friendships)
      .where(and(eq(friendships.userA, chave.userA), eq(friendships.userB, chave.userB)));

    if (existente) return { status: existente.status };

    const [contagem] = await db
      .select({ pendentes: sql<number>`count(*)::int` })
      .from(friendships)
      .where(and(eq(friendships.requestedBy, userId), eq(friendships.status, "pending")));

    if ((contagem?.pendentes ?? 0) >= MAX_PENDING_OUT) {
      throw httpError(429, "pedidos pendentes demais");
    }

    await db
      .insert(friendships)
      .values({ ...chave, requestedBy: userId, status: "pending" })
      // Dois pedidos simultâneos: a PK recusa o segundo, e o estado final é o
      // mesmo pending de qualquer jeito.
      .onConflictDoNothing();

    reply.code(201);
    return { status: "pending" };
  });

  /**
   * Aceitar é do RECEPTOR. `requested_by <> quem aceita` é o que impede a
   * pessoa de aceitar o próprio pedido e virar amiga de quem nunca respondeu.
   */
  app.post<{ Params: { userId: string } }>(
    "/v1/friends/requests/:userId/accept",
    async (req, reply) => {
      const userId = requireUserId(req);

      const parsed = z.uuid().safeParse(req.params.userId);
      if (!parsed.success) {
        reply.code(404);
        return { error: "pedido não encontrado" };
      }

      const outro = parsed.data;
      const chave = pair(userId, outro);

      const comuns = await db.transaction(async (tx) => {
        const aceitos = await tx
          .update(friendships)
          .set({ status: "accepted", respondedAt: new Date() })
          .where(
            and(
              eq(friendships.userA, chave.userA),
              eq(friendships.userB, chave.userB),
              eq(friendships.status, "pending"),
              sql`${friendships.requestedBy} <> ${userId}`,
            ),
          )
          .returning({ status: friendships.status });

        if (aceitos.length === 0) return null;

        // E4 — a varredura retroativa é o ÚNICO caso batch do sistema (PLAN
        // §5.3): os dois catálogos inteiros se cruzam uma vez, aqui, e nunca
        // mais. O `insertMatches` é o mesmo do like, só com outro recorte.
        await insertMatches(
          tx,
          sql`eu.user_id = ${userId} and amigo.user_id = ${outro}`,
        );

        const [total] = await tx
          .select({ n: count() })
          .from(matches)
          .where(
            and(eq(matches.userA, chave.userA), eq(matches.userB, chave.userB)),
          );

        const comuns = total?.n ?? 0;

        // UMA notificação por pessoa, com o total — nunca uma por título. 37
        // títulos em comum viram "vocês têm 37 em comum", que é o que alguém
        // consegue ler; 37 avisos são 37 motivos para desligar a notificação.
        //
        // Dentro da transação: aceite gravado sem o aviso é um match que
        // ninguém descobre, e é justamente o gancho do produto.
        if (comuns > 0) {
          await tx.insert(notifications).values([
            { userId, type: "friend_matches", payload: { friendId: outro, count: comuns } },
            { userId: outro, type: "friend_matches", payload: { friendId: userId, count: comuns } },
          ]);
        }

        return comuns;
      });

      if (comuns === null) {
        reply.code(404);
        return { error: "pedido não encontrado" };
      }

      return { status: "accepted", commonTitles: comuns };
    },
  );
}
