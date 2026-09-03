import assert from "node:assert/strict";
import test from "node:test";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  friendsResponse,
  HANDLE_SEARCH_MIN,
  matchesResponse,
  notificationsResponse,
  userSearchResponse,
} from "@watchlytics/contract";
import { signAccess } from "../auth.ts";
import { db, pg } from "../db/client.ts";
import {
  friendships,
  libraryEntries,
  matches,
  notifications,
  swipes,
  titles,
  users,
} from "../db/schema.ts";
import { buildServer } from "../server.ts";

/**
 * E1 e E2. O que este arquivo guarda:
 *   1. a busca é por handle e SÓ por handle — email não acha ninguém
 *   2. curinga de LIKE no termo não lista o banco (enumeração)
 *   3. o par sai normalizado (user_a < user_b) pedindo dos DOIS lados
 *   4. quem pediu não aceita o próprio pedido
 *
 * Usuários próprios com Bearer real: aqui preciso de três identidades
 * diferentes na mesma suíte, e o shim do DEV_USER_ID só tem uma.
 */
process.env["AUTH_SECRET"] ??= "chave-de-teste-com-mais-de-32-caracteres";

const ANA = "00000000-0000-4000-8000-0000000000e1";
const BRUNO = "00000000-0000-4000-8000-0000000000e2";
const CARLA = "00000000-0000-4000-8000-0000000000e3";

await db
  .insert(users)
  .values([
    { id: ANA, handle: "ana-teste-e1", displayName: "Ana", email: "ana@example.com" },
    { id: BRUNO, handle: "bruno-teste-e1", displayName: "Bruno" },
    { id: CARLA, handle: "carla-teste-e1", displayName: "Carla" },
  ])
  .onConflictDoNothing();

const app = buildServer();

test.after(async () => {
  await db.delete(users).where(inArray(users.id, [ANA, BRUNO, CARLA]));
  await app.close();
  await pg.end();
});

/** Bearer de verdade: é o único jeito de ser três pessoas no mesmo processo. */
const como = (userId: string) => ({ authorization: `Bearer ${signAccess(userId)}` });

const busca = async (q: string, quem = ANA) => {
  const res = await app.inject({
    method: "GET",
    url: `/v1/users?q=${encodeURIComponent(q)}`,
    headers: como(quem),
  });
  assert.equal(res.statusCode, 200, res.body);
  return userSearchResponse.parse(res.json()).items;
};

const pedir = (handle: string, quem: string) =>
  app.inject({
    method: "POST",
    url: "/v1/friends/requests",
    headers: como(quem),
    payload: { handle },
  });

const aceitar = (outro: string, quem: string) =>
  app.inject({
    method: "POST",
    url: `/v1/friends/requests/${outro}/accept`,
    headers: como(quem),
  });

const listar = async (quem: string) => {
  const res = await app.inject({ method: "GET", url: "/v1/friends", headers: como(quem) });
  assert.equal(res.statusCode, 200, res.body);
  return friendsResponse.parse(res.json());
};

const limpar = () =>
  db.delete(friendships).where(inArray(friendships.userA, [ANA, BRUNO, CARLA]));

test("E1 — abaixo do piso a busca não consulta nada", async () => {
  assert.equal(HANDLE_SEARCH_MIN, 3);
  assert.deepEqual(await busca("an"), []);
  assert.deepEqual(await busca("  a  "), [], "espaço não conta como caractere");
});

test("E1 — acha por prefixo do handle e não devolve a si mesmo", async () => {
  const items = await busca("bruno-teste");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.handle, "bruno-teste-e1");

  const eu = await busca("ana-teste");
  assert.deepEqual(eu, [], "quem busca não aparece na própria busca");
});

test("E1 — email não é chave de busca, nem quando é o email exato", async () => {
  assert.deepEqual(await busca("ana@example.com"), []);
  assert.deepEqual(await busca("example.com"), []);
});

test("E1 — curinga de LIKE no termo não lista o banco", async () => {
  // Sem escapar, `%` e `___` casariam com todo mundo — a enumeração que o
  // piso de 3 caracteres existe para impedir, entrando pela porta dos fundos.
  assert.deepEqual(await busca("%"), []);
  assert.deepEqual(await busca("%%%"), []);
  assert.deepEqual(await busca("___"), []);
});

test("E1 — o resultado não carrega email nem estado de perfil", async () => {
  const [bruno] = await busca("bruno-teste");
  assert.deepEqual(Object.keys(bruno ?? {}).sort(), [
    "avatarUrl",
    "displayName",
    "handle",
    "id",
  ]);
});

test("E2 — o par sai normalizado pedindo de qualquer um dos lados", async () => {
  await limpar();

  // ANA < BRUNO e CARLA > BRUNO nos uuids acima: um pedido em cada direção.
  assert.equal((await pedir("bruno-teste-e1", ANA)).statusCode, 201);
  assert.equal((await pedir("bruno-teste-e1", CARLA)).statusCode, 201);

  const rows = await db
    .select()
    .from(friendships)
    .where(inArray(friendships.userA, [ANA, BRUNO, CARLA]));

  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.userA < r.userB, "user_a < user_b, sempre");
  }
  // Quem pediu vive em requested_by, não na ordem das colunas.
  assert.equal(rows.find((r) => r.userB === BRUNO)?.requestedBy, ANA);
  assert.equal(rows.find((r) => r.userA === BRUNO)?.requestedBy, CARLA);
});

test("E2 — reenviar o mesmo pedido não duplica nem falha", async () => {
  await limpar();
  assert.equal((await pedir("bruno-teste-e1", ANA)).statusCode, 201);

  const repetido = await pedir("bruno-teste-e1", ANA);
  assert.equal(repetido.statusCode, 200);
  assert.equal(repetido.json().status, "pending");

  const rows = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userA, ANA), eq(friendships.userB, BRUNO)));
  assert.equal(rows.length, 1);
});

test("E2 — quem pediu não aceita o próprio pedido; o receptor aceita", async () => {
  await limpar();
  await pedir("bruno-teste-e1", ANA);

  assert.equal((await aceitar(BRUNO, ANA)).statusCode, 404, "quem pediu não aceita");

  const [pendente] = await db
    .select({ status: friendships.status })
    .from(friendships)
    .where(and(eq(friendships.userA, ANA), eq(friendships.userB, BRUNO)));
  assert.equal(pendente?.status, "pending", "a tentativa não mexeu na linha");

  assert.equal((await aceitar(ANA, BRUNO)).statusCode, 200);

  const [aceito] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userA, ANA), eq(friendships.userB, BRUNO)));
  assert.equal(aceito?.status, "accepted");
  assert.ok(aceito?.respondedAt instanceof Date);
});

test("E2 — as três listas separam amigo, recebido e enviado", async () => {
  await limpar();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);
  await pedir("carla-teste-e1", ANA);

  const ana = await listar(ANA);
  assert.deepEqual(ana.friends.map((u) => u.handle), ["bruno-teste-e1"]);
  assert.deepEqual(ana.outgoing.map((u) => u.handle), ["carla-teste-e1"]);
  assert.deepEqual(ana.incoming, []);

  const carla = await listar(CARLA);
  assert.deepEqual(carla.incoming.map((u) => u.handle), ["ana-teste-e1"]);
  assert.deepEqual(carla.friends, []);
});

test("E2 — pedir para handle inexistente e para si mesmo é o mesmo 404", async () => {
  const inexistente = await pedir("ninguem-aqui", ANA);
  const euMesmo = await pedir("ana-teste-e1", ANA);

  assert.equal(inexistente.statusCode, 404);
  assert.equal(euMesmo.statusCode, 404);
  assert.equal(inexistente.body, euMesmo.body);
});

/**
 * E3 — o match nasce no like, dentro da transação do swipe.
 *
 * Passa pelo POST /v1/swipes de verdade, não chamando matchOnLike direto: o
 * que este teste guarda é justamente o acoplamento — like gravado sem match
 * gravado junto é o bug que a "mesma transação" existe para impedir.
 */
const curtir = async (titleId: string, quem: string) => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/swipes",
    headers: como(quem),
    payload: [{ titleId, direction: 1, clientTs: new Date().toISOString() }],
  });
  // Sem este assert, um 500 no match viraria "nenhum match encontrado" — a
  // transação inteira volta atrás e o teste acusa o sintoma errado.
  assert.equal(res.statusCode, 200, res.body);
  return res;
};

const matchesDe = (quem: string) =>
  db
    .select()
    .from(matches)
    .where(or(eq(matches.userA, quem), eq(matches.userB, quem)));

const limparSocial = async () => {
  await db.delete(notifications).where(inArray(notifications.userId, [ANA, BRUNO, CARLA]));
  await db.delete(matches).where(inArray(matches.userA, [ANA, BRUNO, CARLA]));
  await db.delete(matches).where(inArray(matches.userB, [ANA, BRUNO, CARLA]));
  await db.delete(libraryEntries).where(inArray(libraryEntries.userId, [ANA, BRUNO, CARLA]));
  await db.delete(swipes).where(inArray(swipes.userId, [ANA, BRUNO, CARLA]));
  await limpar();
};

const pool = await db
  .select({ id: titles.id, title: titles.title })
  .from(titles)
  .orderBy(titles.id)
  .limit(6);
const tituloDe = (id: string) => pool.find((t) => t.id === id)!.title;
assert.ok(pool.length === 6, "o banco precisa estar semeado (npm run seed)");
const [umTitulo, outroTitulo] = [pool[0]!, pool[1]!];

test("E3 — dois amigos curtem o mesmo título e a linha de match aparece", async () => {
  await limparSocial();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);

  await curtir(umTitulo.id, ANA);
  assert.deepEqual(await matchesDe(ANA), [], "um like só não é match");

  await curtir(umTitulo.id, BRUNO);

  const rows = await matchesDe(ANA);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.userA < rows[0]!.userB, "o par do match também é normalizado");
  assert.equal(rows[0]?.titleId, umTitulo.id);
  // Ambos `interested`: é o gancho "vamos assistir isso" (PLAN §5.3).
  assert.equal(rows[0]?.strength, 3);
});

test("E3 — sem amizade aceita não há match", async () => {
  await limparSocial();
  // Pedido pendente, não aceito: catálogo em comum não vira match.
  await pedir("bruno-teste-e1", ANA);

  await curtir(umTitulo.id, ANA);
  await curtir(umTitulo.id, BRUNO);

  assert.deepEqual(await matchesDe(ANA), []);
});

test("E3 — quem já assistiu entra como match médio, não forte", async () => {
  await limparSocial();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);

  await curtir(umTitulo.id, BRUNO);
  await db
    .update(libraryEntries)
    .set({ status: "watched", watchedAt: new Date() })
    .where(and(eq(libraryEntries.userId, BRUNO), eq(libraryEntries.titleId, umTitulo.id)));

  await curtir(umTitulo.id, ANA);

  const [row] = await matchesDe(ANA);
  assert.equal(row?.strength, 2, "um interested + um watched = média");
});

test("E3 — reenviar o mesmo like não duplica nem reescreve o match", async () => {
  await limparSocial();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);

  await curtir(umTitulo.id, ANA);
  await curtir(umTitulo.id, BRUNO);
  const antes = await matchesDe(ANA);

  // O buffer offline reenvia o lote inteiro; a PK do match é (par, título).
  await curtir(umTitulo.id, BRUNO);
  await curtir(umTitulo.id, ANA);

  const depois = await matchesDe(ANA);
  assert.equal(depois.length, 1);
  assert.deepEqual(depois[0]?.createdAt, antes[0]?.createdAt, "não reescreveu a linha");
});

test("E3 — título curtido só por um dos dois não vira match", async () => {
  await limparSocial();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);

  await curtir(umTitulo.id, ANA);
  await curtir(outroTitulo.id, BRUNO);

  assert.deepEqual(await matchesDe(ANA), []);
});

/**
 * E4 — a varredura retroativa no aceite, e a notificação AGREGADA.
 *
 * O gate do backlog é o número: 37 títulos em comum geram 1 notificação, não
 * 37. Aqui são 3 títulos, mas o que o teste guarda é a razão — uma linha por
 * pessoa, com o total no payload.
 */
const notificacoesDe = (quem: string) =>
  db.select().from(notifications).where(eq(notifications.userId, quem));

test("E4 — o aceite cruza os dois catálogos de uma vez", async () => {
  await limparSocial();

  // Catálogos montados ANTES de qualquer amizade: é o caso que o E3 não pega,
  // porque não haverá like novo nenhum depois do aceite.
  const comuns = pool.slice(0, 3);
  for (const titulo of comuns) {
    await curtir(titulo.id, ANA);
    await curtir(titulo.id, BRUNO);
  }
  await curtir(pool[5]!.id, ANA);
  assert.deepEqual(await matchesDe(ANA), [], "sem amizade, catálogo comum não é match");

  await pedir("bruno-teste-e1", ANA);
  const res = await aceitar(ANA, BRUNO);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().commonTitles, 3);

  const rows = await matchesDe(ANA);
  assert.equal(rows.length, 3, "só o que está nos DOIS catálogos");
  assert.deepEqual(
    rows.map((r) => r.titleId).sort(),
    comuns.map((t) => t.id).sort(),
  );
});

test("E4 — 3 títulos em comum geram 1 notificação para cada, não 3", async () => {
  await limparSocial();
  for (const titulo of pool.slice(0, 3)) {
    await curtir(titulo.id, ANA);
    await curtir(titulo.id, BRUNO);
  }
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);

  const daAna = await notificacoesDe(ANA);
  const doBruno = await notificacoesDe(BRUNO);

  assert.equal(daAna.length, 1, "uma notificação, não uma por título");
  assert.equal(doBruno.length, 1);
  assert.equal(daAna[0]?.type, "friend_matches");
  // O total vai no payload: é o que faz a mensagem ser "vocês têm 3 em comum".
  // Handle no payload: a tela escreve "vocês têm 3 em comum" sem outro fetch.
  assert.deepEqual(daAna[0]?.payload, {
    friendId: BRUNO,
    friendHandle: "bruno-teste-e1",
    count: 3,
  });
  assert.deepEqual(doBruno[0]?.payload, {
    friendId: ANA,
    friendHandle: "ana-teste-e1",
    count: 3,
  });
  assert.equal(daAna[0]?.readAt, null, "nasce não lida — é o badge do E6");
});

test("E4 — sem título em comum não há notificação nenhuma", async () => {
  await limparSocial();
  await curtir(pool[0]!.id, ANA);
  await curtir(pool[1]!.id, BRUNO);

  await pedir("bruno-teste-e1", ANA);
  const res = await aceitar(ANA, BRUNO);
  assert.equal(res.json().commonTitles, 0);

  assert.deepEqual(await notificacoesDe(ANA), []);
  assert.deepEqual(await notificacoesDe(BRUNO), []);
});

test("E4 — o que o E3 já casou não vira notificação repetida nem match duplo", async () => {
  await limparSocial();

  // Amigos primeiro: o like do BRUNO já casa em tempo real (E3).
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);
  await curtir(pool[0]!.id, ANA);
  await curtir(pool[0]!.id, BRUNO);
  assert.equal((await matchesDe(ANA)).length, 1);

  // O match forte do like já notificou uma vez (E5).
  assert.equal((await notificacoesDe(ANA)).length, 1);

  // Aceitar de novo é 404 (já não está pending), então nada roda duas vezes:
  // nem o match retroativo, nem o aviso agregado.
  assert.equal((await aceitar(ANA, BRUNO)).statusCode, 404);
  assert.equal((await matchesDe(ANA)).length, 1);
  assert.equal((await notificacoesDe(ANA)).length, 1, "nenhum aviso novo");
});

/**
 * E5 e E6 — o lado de servidor: quem notifica, o que a aba lê e como o badge
 * zera. A tela (aba de comuns, badge, polling) é da sessão que está no web.
 */
test("E5 — match forte notifica na hora; médio e fraco só aparecem", async () => {
  await limparSocial();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);

  // Forte: os dois querem ver.
  await curtir(pool[0]!.id, ANA);
  await curtir(pool[0]!.id, BRUNO);

  // Médio: o BRUNO já assistiu o segundo título.
  await curtir(pool[1]!.id, BRUNO);
  await db
    .update(libraryEntries)
    .set({ status: "watched", watchedAt: new Date() })
    .where(and(eq(libraryEntries.userId, BRUNO), eq(libraryEntries.titleId, pool[1]!.id)));
  await curtir(pool[1]!.id, ANA);

  assert.equal((await matchesDe(ANA)).length, 2, "os dois viraram match");

  const avisos = await notificacoesDe(ANA);
  assert.equal(avisos.length, 1, "só o forte notifica (PLAN §5.3)");
  assert.equal(avisos[0]?.type, "match");
  assert.deepEqual(avisos[0]?.payload, {
    friendId: BRUNO,
    friendHandle: "bruno-teste-e1",
    titleId: pool[0]!.id,
    title: tituloDe(pool[0]!.id),
  });
});

test("E5 — a aba lê título, amigo e força, e pagina sem repetir", async () => {
  await limparSocial();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);
  for (const titulo of pool.slice(0, 3)) {
    await curtir(titulo.id, ANA);
    await curtir(titulo.id, BRUNO);
  }

  const res = await app.inject({ method: "GET", url: "/v1/matches", headers: como(ANA) });
  assert.equal(res.statusCode, 200, res.body);
  const page = matchesResponse.parse(res.json());

  assert.equal(page.items.length, 3);
  assert.equal(page.nextCursor, null, "página curta é fim de lista");
  for (const item of page.items) {
    assert.equal(item.friend.handle, "bruno-teste-e1");
    assert.equal(item.strength, 3);
    assert.ok(item.title.title.length > 0, "o título vem inteiro, não só o id");
  }

  // O cursor é (created_at, title_id): o aceite retroativo grava dezenas de
  // linhas com o mesmo timestamp, e sem o desempate a página repetiria.
  const primeiro = page.items[0]!;
  const segunda = await app.inject({
    method: "GET",
    url: `/v1/matches?cursor=${encodeURIComponent(`${primeiro.createdAt}|${primeiro.title.id}`)}`,
    headers: como(ANA),
  });
  const resto = matchesResponse.parse(segunda.json());
  assert.equal(resto.items.length, 2);
  assert.ok(
    !resto.items.some((i) => i.title.id === primeiro.title.id),
    "a segunda página não repete a primeira",
  );
});

test("E6 — o badge conta as não lidas e zera ao marcar", async () => {
  await limparSocial();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);
  await curtir(pool[0]!.id, ANA);
  await curtir(pool[0]!.id, BRUNO);

  const antes = notificationsResponse.parse(
    (await app.inject({ method: "GET", url: "/v1/notifications", headers: como(ANA) })).json(),
  );
  assert.equal(antes.unread, 1);
  assert.equal(antes.items[0]?.readAt, null);

  const marcou = await app.inject({
    method: "POST",
    url: "/v1/notifications/read",
    headers: como(ANA),
  });
  assert.equal(marcou.json().unread, 0);

  const depois = notificationsResponse.parse(
    (await app.inject({ method: "GET", url: "/v1/notifications", headers: como(ANA) })).json(),
  );
  assert.equal(depois.unread, 0, "o badge zerou");
  assert.ok(depois.items[0]?.readAt, "a notificação continua na caixa, lida");
});

test("E6 — a caixa é de quem pede; ninguém lê a do outro", async () => {
  await limparSocial();
  await pedir("bruno-teste-e1", ANA);
  await aceitar(ANA, BRUNO);
  await curtir(pool[0]!.id, ANA);
  await curtir(pool[0]!.id, BRUNO);

  await app.inject({ method: "POST", url: "/v1/notifications/read", headers: como(ANA) });

  const doBruno = notificationsResponse.parse(
    (await app.inject({ method: "GET", url: "/v1/notifications", headers: como(BRUNO) })).json(),
  );
  assert.equal(doBruno.unread, 1, "marcar as minhas não mexe nas do amigo");
});
