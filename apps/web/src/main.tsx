import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  feedResponse,
  type FeedResponse,
  type Title,
} from "@watchlytics/contract";
import { Deck } from "./Deck.tsx";
import { Filters, toParams, type FeedFilters } from "./Filters.tsx";
import { Library } from "./Library.tsx";
import { Login } from "./Login.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { drop, enqueue, startFlushing } from "./swipeQueue.ts";
import { t } from "./strings.ts";

/** Busca mais cards quando restam estes: o swipe não pode esperar rede. */
const REFILL_AT = 5;

/**
 * Espera antes de reabrir o feed quando a resposta veio velha. Casa com o
 * FLUSH_MS de swipeQueue.ts: é o tempo que os últimos swipes levam para sair
 * da fila local e chegar ao servidor.
 */
const STALE_RETRY_MS = 3500;

async function fetchFeed(
  filters: FeedFilters,
  cursor: string | null,
  recycle: boolean,
): Promise<FeedResponse> {
  const p = toParams(filters);
  if (cursor) p.set("cursor", cursor);
  // `recycle` é z.stringbool no contrato — vai como string, não como boolean.
  if (recycle) p.set("recycle", "true");
  const res = await fetch(`/v1/feed?${p}`);
  if (!res.ok) throw new Error(`feed respondeu ${res.status}`);
  return feedResponse.parse(await res.json());
}

function App() {
  const [filters, setFilters] = useState<FeedFilters>({});
  /** Degrau 2 da escada: o usuário aceitou rever o que já descartou. */
  const [recycle, setRecycle] = useState(false);
  const [queue, setQueue] = useState<Title[]>([]);
  /** O que o servidor afrouxou para não devolver deck vazio (A5). */
  const [relaxed, setRelaxed] = useState<string[]>([]);
  /** Sobe quando uma página volta com tudo que esta sessão já decidiu. */
  const [stale, setStale] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** B7 — só o último. Pilha maior é confusa e ninguém pediu. */
  const [undoable, setUndoable] = useState<Title | null>(null);

  /**
   * Já decididos nesta sessão. O servidor filtra pelo que está gravado, mas a
   * primeira página de um recorte novo pode sair antes de o POST chegar.
   */
  const decided = useRef(new Set<string>());
  const loading = useRef(false);
  /** Próxima página. `null` depois de uma resposta = o servidor não tem mais. */
  const cursor = useRef<string | null>(null);
  const end = useRef(false);
  /** Sobe a cada recorte novo: descarta resposta de filtro antigo ainda em voo. */
  const gen = useRef(0);

  const more = useCallback(async () => {
    if (loading.current || end.current) return;
    loading.current = true;
    const mine = gen.current;
    try {
      const page = await fetchFeed(filters, cursor.current, recycle);
      if (mine !== gen.current) return; // o recorte mudou; esta página é lixo
      cursor.current = page.nextCursor;
      end.current = page.nextCursor === null;
      const fresh = page.items.filter((i) => !decided.current.has(i.id));
      setRelaxed(page.relaxed ?? []);
      setQueue((q) => [...q, ...fresh]);
      // Página inteira já decidida nesta sessão: o servidor ainda não recebeu
      // os últimos swipes. A resposta não vale como fim de feed — marca para
      // reabrir depois do flush, senão a tela para no degrau errado.
      if (page.items.length > 0 && fresh.length === 0) setStale((n) => n + 1);
      setError(null);
    } catch (e) {
      if (mine === gen.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mine === gen.current) {
        loading.current = false;
        setReady(true);
      }
    }
  }, [filters, recycle]);

  useEffect(() => {
    startFlushing();
  }, []);

  /**
   * Recorte novo é feed novo: cursor e fila do anterior não valem mais. A
   * semente do ruído viaja dentro do cursor, então reaproveitá-lo depois de
   * mudar o filtro traria a página seguinte do recorte antigo.
   *
   * ponytail: sem debounce — digitar um ano dispara uma busca por tecla. Vira
   * problema quando o cálculo de peso por gênero doer, não antes.
   */
  useEffect(() => {
    gen.current++;
    cursor.current = null;
    end.current = false;
    loading.current = false;
    // Reciclar é pedir de volta o que esta sessão já decidiu — a memória local
    // que evita o título reaparecer é justamente o que atrapalha aqui.
    if (recycle) decided.current.clear();
    setQueue([]);
    setRelaxed([]);
    setReady(false);
    void more();
  }, [more, recycle]);

  /**
   * Fim da paginação com a fila vazia: reabre o feed.
   *
   * A escada de degradação só responde a uma requisição que volta vazia, e a
   * última ainda trouxe itens — sem reabrir, a tela para no aviso da página
   * anterior e o degrau ("rever os descartados", "acabou") nunca chega.
   *
   * Para sozinho: a resposta vazia é a definitiva, não mexe em `stale` nem em
   * `queue.length`, e sem dependência nova o efeito não reentra. Só rearma
   * enquanto o servidor estiver atrasado em relação à fila de swipes.
   */
  useEffect(() => {
    if (!ready || error || queue.length > 0 || !end.current) return;
    const id = setTimeout(
      () => {
        cursor.current = null;
        end.current = false;
        void more();
      },
      stale ? STALE_RETRY_MS : 0,
    );
    return () => clearTimeout(id);
  }, [ready, error, queue.length, stale, more]);

  const onDecide = useCallback(
    (title: Title, direction: 1 | -1) => {
      decided.current.add(title.id);
      setUndoable(title);
      setQueue((q) => {
        const rest = q.filter((i) => i.id !== title.id);
        if (rest.length <= REFILL_AT) void more();
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
    [more],
  );

  const onUndo = useCallback(() => {
    const title = undoable;
    if (!title) return;

    setUndoable(null);
    decided.current.delete(title.id);
    setQueue((q) => (q.some((i) => i.id === title.id) ? q : [title, ...q]));
    setRelaxed([]);

    // Se ainda estava na fila local, o undo não precisa da rede.
    if (!drop(title.id)) {
      void fetch(`/v1/swipes/${title.id}`, { method: "DELETE" }).catch(
        (e: unknown) => console.error("undo não chegou ao servidor", e),
      );
    }
  }, [undoable]);

  /** Só os degraus que nomeiam um filtro; os outros têm mensagem própria. */
  const loosened = relaxed.flatMap((r) => t.relaxedNames[r] ?? []);
  const offer = relaxed.includes("recycle-offer");

  return (
    <>
      <Filters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          // A oferta de reciclagem valia para o recorte anterior.
          setRecycle(false);
        }}
      />

      {loosened.length > 0 && (
        <p className="notice">{t.relaxedBanner(loosened)}</p>
      )}
      {relaxed.includes("dislikes") && <p className="notice">{t.recycled}</p>}

      {error ? (
        <p className="notice deck-slot error">{t.error(error)}</p>
      ) : !ready ? (
        <p className="notice deck-slot loading">{t.loading}</p>
      ) : queue.length === 0 ? (
        <div className="notice deck-slot empty">
          <p>{offer ? t.recycleOffer : t.exhausted}</p>
          {offer ? (
            <button
              type="button"
              className="link"
              onClick={() => setRecycle(true)}
            >
              {t.recycleAction}
            </button>
          ) : (
            <p className="notice-hint">{t.exhaustedHint}</p>
          )}
          {undoable && (
            <button type="button" className="link" onClick={onUndo}>
              {t.undo}
            </button>
          )}
        </div>
      ) : (
        <Deck
          items={queue}
          onDecide={onDecide}
          onUndo={onUndo}
          canUndo={undoable !== null}
        />
      )}
    </>
  );
}

/**
 * D4 — o deck só abre depois do onboarding, e é o `Onboarding` que decide:
 * ele consulta a rota na montagem e chama `onDone` na hora se já cumpriu. Um
 * componente só, uma requisição só — o App nem monta antes disso, então o
 * feed não é buscado durante os 20 swipes de entrada.
 *
 * ponytail: o portão é do deck, não do shell. As outras telas continuam
 * alcançáveis pela nav durante o onboarding; travar a navegação inteira é
 * decisão de produto, não de código.
 */
function Home() {
  const [onboarded, setOnboarded] = useState(false);
  return onboarded ? (
    <App />
  ) : (
    <Onboarding onDone={() => setOnboarded(true)} />
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
      {inLibrary ? <Library /> : <Home />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
