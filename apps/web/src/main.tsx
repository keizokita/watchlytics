import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { feedResponse, type Title } from "@watchlytics/contract";
import { Deck } from "./Deck.tsx";
import { Library } from "./Library.tsx";
import { Login } from "./Login.tsx";
import { drop, enqueue, startFlushing } from "./swipeQueue.ts";
import { t } from "./strings.ts";

/** Busca mais cards quando restam estes: o swipe não pode esperar rede. */
const REFILL_AT = 5;

async function fetchFeed(): Promise<Title[]> {
  const res = await fetch("/v1/feed");
  if (!res.ok) throw new Error(`feed respondeu ${res.status}`);
  return feedResponse.parse(await res.json()).items;
}

function App() {
  const [queue, setQueue] = useState<Title[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [ready, setReady] = useState(false);
  /** B7 — só o último. Pilha maior é confusa e ninguém pediu. */
  const [undoable, setUndoable] = useState<Title | null>(null);

  /**
   * Já decididos nesta sessão. O servidor filtra pelo que está gravado, mas um
   * refill disparado antes do POST chegar traria o título de volta.
   */
  const decided = useRef(new Set<string>());
  const loading = useRef(false);

  const refill = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const fresh = (await fetchFeed()).filter(
        (i) => !decided.current.has(i.id),
      );
      setQueue((q) => {
        const have = new Set(q.map((i) => i.id));
        const added = fresh.filter((i) => !have.has(i.id));
        setExhausted(added.length === 0 && q.length === 0);
        return [...q, ...added];
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loading.current = false;
      setReady(true);
    }
  }, []);

  useEffect(() => {
    startFlushing();
    void refill();
  }, [refill]);

  const onDecide = useCallback(
    (title: Title, direction: 1 | -1) => {
      decided.current.add(title.id);
      setUndoable(title);
      setQueue((q) => {
        const rest = q.filter((i) => i.id !== title.id);
        if (rest.length <= REFILL_AT) void refill();
        return rest;
      });

      // Vai para a fila durável, não direto para a rede: o card já saiu da
      // tela e o swipe não pode depender de a requisição dar certo.
      enqueue({
        titleId: title.id,
        direction,
        clientTs: new Date().toISOString(),
      });
    },
    [refill],
  );

  const onUndo = useCallback(() => {
    const title = undoable;
    if (!title) return;

    setUndoable(null);
    decided.current.delete(title.id);
    setQueue((q) => (q.some((i) => i.id === title.id) ? q : [title, ...q]));
    setExhausted(false);

    // Se ainda estava na fila local, o undo não precisa da rede.
    if (!drop(title.id)) {
      void fetch(`/v1/swipes/${title.id}`, { method: "DELETE" }).catch(
        (e: unknown) => console.error("undo não chegou ao servidor", e),
      );
    }
  }, [undoable]);

  if (error) return <p className="notice error">{t.error(error)}</p>;
  if (!ready) return <p className="notice">{t.loading}</p>;
  if (queue.length === 0) {
    return (
      <div className="notice">
        <p>{exhausted ? t.exhausted : t.emptyCatalog}</p>
        {exhausted && <p className="notice-hint">{t.exhaustedHint}</p>}
        {undoable && (
          <button type="button" className="link" onClick={onUndo}>
            {t.undo}
          </button>
        )}
      </div>
    );
  }

  return (
    <Deck
      items={queue}
      onDecide={onDecide}
      onUndo={onUndo}
      canUndo={undoable !== null}
    />
  );
}

/**
 * Navegação pelo hash — duas telas não pagam um router.
 *
 * ponytail: vira react-router na terceira rota, ou na primeira que precisar de
 * parâmetro de caminho (o perfil público de D5 já precisa).
 */
function Root() {
  const [hash, setHash] = useState(() => location.hash);

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const inLibrary = hash.startsWith("#/library");

  return (
    <div className="shell">
      <style>{`
        .shell { display: grid; gap: 1.25rem; justify-items: center; }
        .shell nav { display: flex; gap: 0.5rem; }
        .shell nav a {
          padding: 0.4rem 0.9rem; border-radius: 999px; text-decoration: none;
          color: var(--muted); font-size: 0.9rem; font-weight: 600;
        }
        .shell nav a[aria-current="page"] {
          color: var(--fg); background: rgb(255 255 255 / 0.08);
        }
      `}</style>
      <nav>
        <a href="#/" aria-current={inLibrary ? undefined : "page"}>
          {t.navDeck}
        </a>
        <a href="#/library" aria-current={inLibrary ? "page" : undefined}>
          {t.navLibrary}
        </a>
        <Login />
      </nav>
      {inLibrary ? <Library /> : <App />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
