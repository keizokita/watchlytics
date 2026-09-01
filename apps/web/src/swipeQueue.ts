import { swipeBatch, type SwipeInput } from "@watchlytics/contract";

/**
 * B6 — fila durável de swipes.
 *
 * O card sai da tela antes da rede responder, então o swipe não pode depender
 * dela para existir. Aqui ele vive em localStorage até o servidor confirmar.
 *
 * A idempotência do lote vem do servidor (PK composta, A0): reenviar o mesmo
 * swipe é upsert. Isso é o que permite retentar sem medo.
 */
const KEY = "watchlytics.pending-swipes";
const FLUSH_AT = 5;
const FLUSH_MS = 3000;
/** Teto do contrato. */
const MAX_BATCH = 50;

let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function read(): SwipeInput[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = swipeBatch.safeParse(JSON.parse(raw));
    // Fila corrompida ou de um contrato antigo é descartada, não propagada.
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function write(list: SwipeInput[]) {
  try {
    if (list.length) globalThis.localStorage?.setItem(KEY, JSON.stringify(list));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // storage cheio ou bloqueado: seguimos em memória, sem derrubar o swipe
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), FLUSH_MS);
}

export function pendingCount() {
  return read().length;
}

export function enqueue(swipe: SwipeInput) {
  // Mesma regra do servidor: a última decisão sobre o título vence.
  const next = [...read().filter((p) => p.titleId !== swipe.titleId), swipe];
  write(next);
  if (next.length >= FLUSH_AT) void flush();
  else schedule();
}

/**
 * B7 — tira o swipe da fila. Devolve true se ele ainda não tinha ido para a
 * rede, caso em que o undo não precisa falar com o servidor.
 */
export function drop(titleId: string): boolean {
  const before = read();
  const after = before.filter((p) => p.titleId !== titleId);
  write(after);
  return after.length !== before.length;
}

export async function flush(): Promise<void> {
  if (flushing) return;
  const batch = read().slice(0, MAX_BATCH);
  if (!batch.length) return;

  flushing = true;
  try {
    const res = await fetch("/v1/swipes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`/v1/swipes respondeu ${res.status}`);

    // Remove por (titleId, clientTs), não só por titleId: durante o voo o
    // usuário pode ter desfeito e reavaliado o mesmo título, e essa decisão
    // mais nova não pode ser apagada junto.
    const sent = new Set(batch.map((b) => b.titleId + b.clientTs));
    write(read().filter((p) => !sent.has(p.titleId + p.clientTs)));

    if (read().length) schedule();
  } catch (e) {
    console.warn("swipes seguem na fila, tentando de novo", e);
    schedule();
  } finally {
    flushing = false;
  }
}

/** Chamado uma vez pelo browser: esvazia o que sobrou de sessões anteriores. */
export function startFlushing() {
  void flush();
  globalThis.addEventListener?.("online", () => void flush());
  globalThis.document?.addEventListener?.("visibilitychange", () => {
    // Em celular a aba é congelada ao trocar de app: esta é a última chance.
    if (document.visibilityState === "hidden") void flush();
  });
}
