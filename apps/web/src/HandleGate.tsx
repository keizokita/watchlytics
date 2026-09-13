import { useEffect, useRef, useState } from "react";
import { HANDLE_MAX, type SessionUser } from "@watchlytics/contract";
import {
  checarDisponibilidade,
  escolherHandle,
  normalizar,
  validar,
} from "./handle.ts";
import { mensagem } from "./errors.ts";
import { setUser } from "./session.ts";
import { t } from "./strings.ts";

/**
 * β8 — a escolha do handle. Enquanto `needsHandle` for true, não se passa daqui.
 *
 * Vem DEPOIS da porta de idade e antes de qualquer tela do app: não faz sentido
 * pedir handle a quem pode ser recusado pela idade no passo seguinte.
 *
 * A tela existe porque o handle saía do e-mail — `keizokita1@gmail.com` virava
 * `@keizokita1`, publicado em `/u/keizokita1` — e quem lesse o perfil deduzia o
 * endereço. Por isso o texto diz as três coisas ANTES do campo: para que o
 * handle serve, que ele é público, e que a escolha não tem volta no v1.
 */

/**
 * Espera antes de perguntar se o handle está livre.
 *
 * Sem isto cada tecla vira uma requisição: um handle de 12 caracteres sairia em
 * 12 consultas, o rate limit da rota fecharia no meio e quem estaria trancado é
 * justamente quem está digitando. 350ms é abaixo do que se percebe como
 * travada e acima do intervalo entre teclas de quem digita rápido.
 */
const CHECK_DEBOUNCE_MS = 350;

/** O que a linha de estado diz. Um de cada vez: eles se excluem. */
type Status =
  /** Nada a dizer — vazio, no meio da palavra, ou a consulta não respondeu. */
  | { kind: "idle" }
  | { kind: "invalid" }
  | { kind: "checking" }
  | { kind: "free"; handle: string }
  /** Tomado ou reservado: a mesma frase, porque o contrato responde um booleano. */
  | { kind: "taken" };

export function HandleGate({ user }: { user: SessionUser }) {
  const [raw, setRaw] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  // Esta tela nasce no lugar da porta de idade, que sai levando o foco junto —
  // medido na auditoria do β2: sem isto o foco cai no body e quem usa teclado
  // ou leitor de tela começa no topo do documento. O campo é a única coisa a
  // fazer aqui, então o foco é dele.
  useEffect(() => {
    campo.current?.focus();
  }, []);

  /**
   * Julga a cada tecla, e só CONSULTA depois da pausa.
   *
   * O `setTimeout` com `clearTimeout` na limpeza é o debounce: cada tecla
   * remonta o efeito e cancela a consulta que ainda não saiu. O `vivo` cobre o
   * outro lado da corrida — a resposta de um handle antigo chegando depois de a
   * pessoa ter digitado mais, que pintaria "disponível" sobre o texto errado.
   */
  useEffect(() => {
    const v = validar(raw);
    if (v.kind !== "ok") {
      setStatus(
        v.kind === "invalid"
          ? { kind: "invalid" }
          : v.kind === "unavailable"
            ? { kind: "taken" }
            : { kind: "idle" },
      );
      return;
    }

    // O que estava escrito era sobre o texto ANTERIOR: sai agora, senão um
    // "@keizo is available" fica de pé enquanto se digita o resto.
    setStatus({ kind: "idle" });
    let vivo = true;
    const id = setTimeout(() => {
      setStatus({ kind: "checking" });
      void checarDisponibilidade(v.handle).then((d) => {
        if (!vivo) return;
        setStatus(
          d === "livre"
            ? { kind: "free", handle: v.handle }
            : d === "ocupado"
              ? { kind: "taken" }
              // Não respondeu — inclusive o 404 de a trilha A ainda não ter
              // chegado. Cala em vez de acusar: quem decide é o envio.
              : { kind: "idle" },
        );
      });
    }, CHECK_DEBOUNCE_MS);

    return () => {
      vivo = false;
      clearTimeout(id);
    };
  }, [raw]);

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await escolherHandle(raw);
      // Gravou: o shell sai daqui na hora. O handle novo vai junto porque a nav
      // escreve "Signed in as @handle" — deixar o gerado ali contradiria a
      // escolha que a pessoa acabou de fazer. Sai antes de mexer em estado
      // local: este componente já desmontou.
      if (r.kind === "ok") {
        setUser({ ...user, handle: r.handle, needsHandle: false });
        return;
      }
      // Recusado pela borda: alguém chegou primeiro, ou o contrato reprovou. A
      // linha de estado é `role="status"`, então a frase é anunciada; o foco
      // volta para o campo porque a correção é lá, e o botão que foi clicado
      // acabou de ficar desabilitado.
      setStatus(r.kind === "taken" ? { kind: "taken" } : { kind: "invalid" });
      campo.current?.focus();
    } catch (e) {
      // Falhar não é ter o handle recusado: o formulário fica, e a pessoa tenta
      // de novo com o MESMO handle.
      setError(mensagem(e));
    }
    setBusy(false);
  };

  const veredito = validar(raw);
  const ruim = status.kind === "invalid" || status.kind === "taken";
  /**
   * Não bloqueia em `checking`: o botão desabilitaria e reabilitaria a cada
   * pausa de digitação, e um botão que fica desabilitado embaixo do dedo perde
   * o foco de quem usa teclado. A consulta é resposta adiantada; quem decide a
   * corrida é o POST, que devolve 409.
   */
  const podeEnviar = veredito.kind === "ok" && status.kind !== "taken";

  return (
    <div className="onboarding handle-gate">
      <style>{`
        .handle-gate form { display: grid; gap: 0.75rem; justify-items: center; width: 100%; }
        .handle-gate label { font-size: 0.9rem; color: var(--muted); }
        /* A moldura é o alvo, e é ela que tem os 44px: o "@" é parte do campo,
           não um segundo controle. Sem isto o alvo seria só a caixa de texto. */
        .handle-gate .handle-field {
          display: flex; align-items: center; gap: 0.1rem;
          min-height: var(--tap);
          padding: 0 0.9rem;
          border-radius: var(--r-pill);
          border: 1px solid var(--line);
          background: var(--surface);
          width: min(18rem, 100%);
        }
        /* O anel de foco é da moldura, senão ele apareceria por dentro dela e
           deixaria o "@" de fora do que está focado. */
        .handle-gate .handle-field:focus-within {
          outline: 2px solid var(--fg); outline-offset: 2px;
        }
        .handle-gate .handle-field .at { color: var(--muted); }
        .handle-gate input {
          /* min-width: 0 porque input tem largura intrínseca (size=20): sem
             isto ele não encolhe e estoura a moldura em tela de 360px. */
          flex: 1; min-width: 0;
          border: 0; background: none; color: var(--fg);
          font: inherit;
          /* 16px no mobile: abaixo disso o iOS dá zoom ao focar o campo. */
          font-size: 1rem;
          min-height: var(--tap);
          padding: 0;
        }
        .handle-gate input:focus { outline: none; }
        /* A regra é pano de fundo, não recado: em --fg ela pesava mais que o
           parágrafo que explica para que o handle serve. */
        .handle-gate #handle-rules { color: var(--muted); margin: 0; }
        /* Altura reservada: sem ela o botão pula uma linha para baixo no
           instante em que a primeira mensagem aparece, e o alvo foge do dedo. */
        .handle-gate .handle-status { min-height: 1.4em; margin: 0; }
        /* O veredito é a única linha que fala do que FOI digitado, então é a
           única em cor cheia. Verde e vermelho são reforço: quem não distingue
           os dois continua lendo frases diferentes. */
        .handle-gate .handle-status.free { color: var(--like); }
        .handle-gate .error { color: var(--pass); }
        .handle-gate .handle-permanent { font-size: 0.85rem; }
      `}</style>
      <h1>{t.handleTitle}</h1>
      <p className="notice">{t.handleBody}</p>
      {/* `<form>` e não dois handlers: é o que faz o Enter do teclado virtual
          enviar, e o teclado virtual é como a maioria vai responder isto. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <label htmlFor="handle">{t.handleLabel}</label>
        <div className="handle-field">
          {/* `aria-hidden`: o "@" é moldura, não faz parte do valor. Quem ouve
              recebe o nome pela label e a regra pelo `aria-describedby`. */}
          <span className="at" aria-hidden="true">
            @
          </span>
          {/* `maxLength`: a regra do contrato também é do teclado — o corte em
              20 acontece antes de virar erro. */}
          <input
            id="handle"
            ref={campo}
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={HANDLE_MAX}
            placeholder={t.handlePlaceholder}
            aria-describedby="handle-rules handle-status"
            aria-invalid={ruim}
            value={raw}
            onChange={(e) => {
              setRaw(normalizar(e.target.value));
              // O erro de envio é sobre o que foi enviado; digitar de novo já é
              // a tentativa seguinte.
              setError(null);
            }}
          />
        </div>
        {/* A regra fica visível SEMPRE, e não só depois de errar: ninguém
            adivinha "começa com letra". */}
        <p id="handle-rules" className="notice-hint">
          {t.handleRules}
        </p>
        {/* Uma linha para os quatro desfechos, porque eles se excluem, e
            `role="status"` (live polite) porque dois deles chegam SOZINHOS, da
            rede, sem nenhuma ação de quem está na tela. Existe no DOM desde a
            montagem, vazia: região viva que só nasce junto com o texto não é
            anunciada. */}
        <p
          id="handle-status"
          role="status"
          className={`notice-hint handle-status${ruim ? " error" : ""}${
            status.kind === "free" ? " free" : ""
          }`}
        >
          {status.kind === "checking"
            ? t.handleChecking
            : status.kind === "free"
              ? t.handleAvailable(status.handle)
              : status.kind === "taken"
                ? t.handleTaken
                : status.kind === "invalid"
                  ? t.handleInvalid
                  : ""}
        </p>
        <p className="notice handle-permanent">{t.handlePermanent}</p>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="onboarding-go"
          disabled={busy || !podeEnviar}
        >
          {t.handleAction}
        </button>
      </form>
    </div>
  );
}
