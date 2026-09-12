import { useCallback, useEffect, useRef, useState } from "react";
import type { Title } from "@watchlytics/contract";
import { Card } from "./Card.tsx";
import { cardBackground } from "./poster.ts";
import { t } from "./strings.ts";

/** Distância a partir da qual o swipe conta mesmo devagar. */
const COMMIT_PX = 90;
/** Velocidade (px/ms) a partir da qual conta mesmo curto — o flick. */
const COMMIT_VELOCITY = 0.5;
/** Deslocamento mínimo para não confundir tremor de toque com gesto. */
const MIN_INTENT_PX = 20;
const FLY_MS = 260;
/**
 * Teto do acompanhamento vertical. O card seguir o dedo na vertical é enfeite;
 * sem limite ele empurra a altura do documento e faz aparecer barra de rolagem.
 */
const MAX_DRIFT_Y = 40;

/** Só 3 no DOM: os de baixo existem para dar profundidade, nada mais. */
const VISIBLE = 3;

/** B4 — quantas imagens à frente entram no cache antes de virarem card. */
const PRELOAD = 5;

/**
 * Pôsteres já pedidos nesta sessão. A fila muda a cada swipe e o efeito de
 * pré-carga roda de novo; sem esta memória ele repediria as mesmas cinco.
 *
 * ponytail: Set de string, não de Image. Guardar o elemento seguraria o bitmap
 * decodificado de tudo que já passou — quem tem que lembrar da imagem é o cache
 * do navegador; aqui só se lembra de já ter pedido. Cresce com os títulos vistos
 * numa sessão, o que é ordens de grandeza menos que o catálogo.
 */
const pedidas = new Set<string>();

type Direction = 1 | -1;

export function Deck({
  items,
  onDecide,
  onUndo,
  canUndo,
}: {
  items: Title[];
  onDecide: (title: Title, direction: Direction) => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const [drag, setDrag] = useState({ dx: 0, dy: 0, active: false });
  const [flying, setFlying] = useState<Direction | null>(null);

  const origin = useRef({ x: 0, y: 0 });
  const sample = useRef({ x: 0, at: 0 });
  const velocity = useRef(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  }, []);

  /**
   * B4 — as próximas cinco entram no cache antes de existirem como card.
   *
   * Só a partir de VISIBLE: as três que estão no DOM já têm o pôster no
   * `background`, e o navegador começou a baixá-las sozinho. Sem isto o
   * download da quarta em diante só começava quando ela subia para o topo, e
   * até chegar o que aparecia era o forro (Card.tsx, cardBackground).
   */
  useEffect(() => {
    for (const item of items.slice(VISIBLE, VISIBLE + PRELOAD)) {
      if (item.posterUrl && !pedidas.has(item.posterUrl)) {
        pedidas.add(item.posterUrl);
        new Image().src = item.posterUrl;
      }
    }
  }, [items]);

  const top = items[0];

  const commit = useCallback(
    (direction: Direction) => {
      if (!top || flying) return;
      setFlying(direction);
      const ms = reduced.current ? 0 : FLY_MS;
      window.setTimeout(() => {
        setFlying(null);
        setDrag({ dx: 0, dy: 0, active: false });
        velocity.current = 0;
        onDecide(top, direction);
      }, ms);
    },
    [top, flying, onDecide],
  );

  // B3: o gesto nunca é o único caminho.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // O atalho é da página inteira, mas dentro de um campo as mesmas teclas
      // já têm dono: seta anda com o caret e Backspace apaga. Sem esta guarda o
      // `preventDefault` do undo impedia apagar um dígito do filtro de ano.
      if (
        e.target instanceof Element &&
        e.target.closest("input, select, textarea, [contenteditable]")
      ) {
        return;
      }

      if (e.key === "ArrowLeft") commit(-1);
      else if (e.key === "ArrowRight") commit(1);
      else if (e.key === "Backspace" && canUndo) {
        e.preventDefault();
        onUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, canUndo, onUndo]);

  if (!top) return null;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (flying) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    sample.current = { x: e.clientX, at: e.timeStamp };
    velocity.current = 0;
    setDrag({ dx: 0, dy: 0, active: true });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.active) return;
    const dt = e.timeStamp - sample.current.at;
    if (dt > 0) velocity.current = (e.clientX - sample.current.x) / dt;
    sample.current = { x: e.clientX, at: e.timeStamp };
    setDrag({
      dx: e.clientX - origin.current.x,
      dy: e.clientY - origin.current.y,
      active: true,
    });
  };

  const onPointerUp = () => {
    if (!drag.active) return;
    const far = Math.abs(drag.dx) > COMMIT_PX;
    // Flick curto e rápido tem que contar, senão o deck parece travado.
    const flick =
      Math.abs(velocity.current) > COMMIT_VELOCITY &&
      Math.abs(drag.dx) > MIN_INTENT_PX;

    if (far || flick) {
      const sign = flick ? Math.sign(velocity.current) : Math.sign(drag.dx);
      commit((sign >= 0 ? 1 : -1) as Direction);
    } else {
      setDrag({ dx: 0, dy: 0, active: false });
    }
  };

  const ms = reduced.current ? 0 : FLY_MS;
  const x = flying ? flying * window.innerWidth * 1.4 : drag.dx;
  const y = Math.max(
    -MAX_DRIFT_Y,
    Math.min(MAX_DRIFT_Y, drag.dy * (flying ? 1 : 0.35)),
  );

  return (
    <div className="deck-wrap">
      {/* B3: quem usa leitor de tela recebe o card sem depender do gesto. */}
      <div aria-live="polite" className="sr-only">
        {top.title}
      </div>

      <div className="deck">
        {/* de trás para frente: o card do topo é o último no DOM */}
        {items
          .slice(0, VISIBLE)
          .map((item, i) => ({ item, i }))
          .reverse()
          .map(({ item, i }) => {
            const isTop = i === 0;
            return (
              <div
                key={item.id}
                className="deck-card"
                aria-hidden={!isTop}
                style={
                  {
                    background: cardBackground(item),
                    transform: isTop
                      ? `translate3d(${x}px, ${y}px, 0) rotate(${x / 22}deg)`
                      : // Para CIMA, não para baixo: o deslocamento precisa
                        // superar o que o scale encolhe (senão o card de trás
                        // some), e por cima o que aparece é gradiente limpo —
                        // por baixo apareceria o rodapé de texto do outro card.
                        `translate3d(0, ${-i * 18}px, 0) scale(${1 - i * 0.04})`,
                    transition:
                      isTop && drag.active
                        ? "none"
                        : `transform ${ms}ms cubic-bezier(.2,.7,.3,1)`,
                    zIndex: VISIBLE - i,
                    // O CSS decide o que fazer com o progresso do gesto: -1 no
                    // limiar de pass, +1 no de like. `opacity` fora de 0–1 é
                    // clampada pelo próprio CSS, então um valor com sinal
                    // basta para os dois carimbos.
                    ...(isTop ? { "--swipe": x / COMMIT_PX } : {}),
                  } as React.CSSProperties
                }
                {...(isTop
                  ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }
                  : {})}
              >
                {isTop && (
                  // `aria-hidden`: os carimbos são o eco visual do gesto e
                  // vivem no DOM com opacidade 0 o tempo todo. Opacidade zero
                  // não esconde de leitor de tela — medido na auditoria, "LIKE"
                  // e "PASS" apareciam como texto do card em todo card.
                  <>
                    <span className="badge badge-like" aria-hidden="true">
                      {t.like}
                    </span>
                    <span className="badge badge-pass" aria-hidden="true">
                      {t.pass}
                    </span>
                  </>
                )}
                <Card title={item} />
              </div>
            );
          })}
      </div>

      {/* Classe por papel, não por posição: o CSS pintava pass/like por
          :first-child/:last-child e a ordem já mudou uma vez (B7 pôs o Undo
          no meio) — teria trocado de dono sem quebrar nada visível. */}
      <div className="actions">
        <button
          type="button"
          className="pass"
          onClick={() => commit(-1)}
          aria-label={t.passHint}
        >
          {t.pass}
        </button>
        <button
          type="button"
          className="undo"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label={t.undoHint}
        >
          {t.undo}
        </button>
        <button
          type="button"
          className="like"
          onClick={() => commit(1)}
          aria-label={t.likeHint}
        >
          {t.like}
        </button>
      </div>
    </div>
  );
}
