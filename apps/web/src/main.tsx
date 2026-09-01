import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { feedResponse, type Title } from "@watchlytics/contract";
import { Deck } from "./Deck.tsx";
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
      const fresh = (await fetchFeed()).filter((i) => !decided.current.has(i.id));
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
    void refill();
  }, [refill]);

  const onDecide = useCallback(
    (title: Title, direction: 1 | -1) => {
      decided.current.add(title.id);
      setQueue((q) => {
        const rest = q.filter((i) => i.id !== title.id);
        if (rest.length <= REFILL_AT) void refill();
        return rest;
      });

      // Fire-and-forget: o card já saiu da tela. Lote de um até B6 trazer o
      // buffer offline — o endpoint aceita array desde A0.
      void fetch("/v1/swipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { titleId: title.id, direction, clientTs: new Date().toISOString() },
        ]),
      }).catch((e: unknown) => console.error("swipe não gravado", e));
    },
    [refill],
  );

  if (error) return <p className="notice error">{t.error(error)}</p>;
  if (!ready) return <p className="notice">{t.loading}</p>;
  if (queue.length === 0) {
    return (
      <div className="notice">
        <p>{exhausted ? t.exhausted : t.emptyCatalog}</p>
        {exhausted && <p className="notice-hint">{t.exhaustedHint}</p>}
      </div>
    );
  }

  return <Deck items={queue} onDecide={onDecide} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
