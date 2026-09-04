import { useCallback, useEffect, useState } from "react";
import {
  GENRES,
  ONBOARDING_SWIPES,
  onboardingDeck,
  type OnboardingDeck,
  type Title,
} from "@watchlytics/contract";
import { Deck } from "./Deck.tsx";
import { t } from "./strings.ts";
import { enqueue } from "./swipeQueue.ts";
import { auth } from "./session.ts";

/**
 * D4 — a porta de entrada: escolher gêneros, swipar 20, cair no feed calibrado.
 *
 * Os 20 swipes são obrigatórios por decisão de produto (PLAN §1.10), e o atrito
 * disso é risco declarado (§11): a mitigação é o contador sempre visível e um
 * deck que a pessoa reconhece — não um questionário.
 *
 * Não calibra nada por conta própria. Os swipes vão pela MESMA fila durável do
 * deck normal (B6) e o `taste_vector` é recalculado pelo feed na primeira
 * página (A4). "Feed sai calibrado" é consequência, não código novo.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<OnboardingDeck | null>(null);
  /** Swipes contados nesta tela. O servidor dá o ponto de partida. */
  const [done, setDone] = useState(0);
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/v1/onboarding/deck", { headers: auth() });
      if (!res.ok) throw new Error(`onboarding respondeu ${res.status}`);
      const data = onboardingDeck.parse(await res.json());
      setError(null);
      // Já cumpriu: sai antes de pintar qualquer coisa. É o caminho de toda
      // abertura de app depois do primeiro dia.
      if (data.remaining === 0) {
        onDone();
        return;
      }
      setState(data);
      setDone(ONBOARDING_SWIPES - data.remaining);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onDone]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state && done >= ONBOARDING_SWIPES) onDone();
  }, [state, done, onDone]);

  const save = async () => {
    try {
      const res = await fetch("/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...auth() },
        body: JSON.stringify({ preferredGenres: picked }),
      });
      if (!res.ok) throw new Error(`/v1/me respondeu ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * ponytail: sem undo aqui. O gesto errado custa 1 dos 20 e o botão fica
   * desabilitado, que é honesto. Reusar o `onUndo` do App custa duplicar a
   * volta do card e a recontagem — vale quando alguém reclamar.
   */
  const onDecide = (title: Title, direction: 1 | -1) => {
    enqueue({
      titleId: title.id,
      direction,
      clientTs: new Date().toISOString(),
    });
    setState((s) =>
      s ? { ...s, items: s.items.filter((i) => i.id !== title.id) } : s,
    );
    setDone((n) => n + 1);
  };

  if (error) return <p className="notice deck-slot error">{t.error(error)}</p>;
  if (!state) return <p className="notice deck-slot loading">{t.loading}</p>;

  // Escolher ao menos um gênero é obrigatório: é o que distingue "ainda não
  // escolheu" de "escolheu" sem uma segunda coluna no banco para dizer isso.
  if (state.genres.length === 0) {
    return (
      <div className="onboarding">
        <h1>{t.onboardingTitle}</h1>
        <p className="notice">{t.onboardingGenresHint}</p>
        <div className="genre-pick">
          {GENRES.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={picked.includes(g.id)}
              onClick={() =>
                setPicked((p) =>
                  p.includes(g.id) ? p.filter((x) => x !== g.id) : [...p, g.id],
                )
              }
            >
              {g.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="onboarding-go"
          disabled={picked.length === 0}
          onClick={() => void save()}
        >
          {t.onboardingStart}
        </button>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <p className="onboarding-count">
        {/* aria-live no contador, não no deck: quem usa leitor de tela precisa
            saber que o swipe entrou e quantos faltam. */}
        <span aria-live="polite">
          {t.onboardingCount(done, ONBOARDING_SWIPES)}
        </span>
        <progress max={ONBOARDING_SWIPES} value={done} />
      </p>
      <Deck
        items={state.items}
        onDecide={onDecide}
        onUndo={() => {}}
        canUndo={false}
      />
    </div>
  );
}
