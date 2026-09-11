import { useState } from "react";
import { MIN_AGE, type SessionUser } from "@watchlytics/contract";
import { submitBirthYear, type AgeVerdict } from "./ageGate.ts";
import { mensagem } from "./errors.ts";
import { setUser } from "./session.ts";
import { PRIVACY_URL, t } from "./strings.ts";

/**
 * β2 — a porta de idade. Enquanto `needsAgeGate` for true, não se passa daqui.
 *
 * Pede o ANO, nunca a data: é o mínimo que responde à única pergunta que a lei
 * nos deixa fazer, e coletar o dia e o mês seria guardar dado que não usamos
 * para nada (docs/legal/privacy.md).
 */

/**
 * A recusa vale pela aba inteira, não pelo componente.
 *
 * Fora do estado do React de propósito: um remount — troca de hash, StrictMode,
 * qualquer re-render de Root — devolveria o formulário a quem já respondeu, e
 * "sem segunda chance na mesma sessão" é requisito, não detalhe de UI. Morre no
 * reload, que é quando a sessão também morre: o servidor apagou a dele na
 * recusa, então entrar de novo recomeça tudo do lado dele.
 */
let refusedMinAge: number | null = null;

export function AgeGate({ user }: { user: SessionUser }) {
  const [year, setYear] = useState("");
  const [verdict, setVerdict] = useState<AgeVerdict | null>(
    refusedMinAge === null ? null : { kind: "refused", minAge: refusedMinAge },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (verdict?.kind === "refused") {
    return (
      <div className="onboarding age-gate">
        {/* `role="alert"` porque a recusa é a resposta ao envio: quem usa leitor
            de tela precisa ouvi-la sem ir procurar onde o formulário estava. */}
        <p className="notice" role="alert">
          {t.ageGateRefused(verdict.minAge)}
        </p>
      </div>
    );
  }

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await submitBirthYear(year);
      // Passou: o shell sai daqui na hora, sem recarregar a sessão inteira — o
      // único campo que mudou é este, e a api não devolve sessionUser no gate.
      // Sai antes de mexer no estado local: este componente já desmontou.
      if (next.kind === "ok") {
        setUser({ ...user, needsAgeGate: false });
        return;
      }
      if (next.kind === "refused") refusedMinAge = next.minAge;
      setVerdict(next);
    } catch (e) {
      // Falhar não é ser recusado: o formulário fica, e a pessoa tenta de novo.
      setError(mensagem(e));
    }
    setBusy(false);
  };

  return (
    <div className="onboarding age-gate">
      <style>{`
        .age-gate input {
          min-height: var(--tap);
          padding: 0 0.85rem;
          border-radius: var(--r-pill);
          border: 1px solid var(--line);
          background: var(--surface);
          color: var(--fg);
          font: inherit;
          /* 16px no mobile: abaixo disso o iOS dá zoom ao focar o campo. */
          font-size: 1rem;
          width: 7rem;
          text-align: center;
        }
        /* O seletor nativo do número não ajuda a digitar um ano de 4 dígitos. */
        .age-gate input { appearance: textfield; -moz-appearance: textfield; }
        .age-gate input::-webkit-outer-spin-button,
        .age-gate input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .age-gate form { display: grid; gap: 1rem; justify-items: center; }
        .age-gate label { display: grid; gap: 0.5rem; justify-items: center; font-size: 0.9rem; }
        .age-gate a { color: var(--fg); }
      `}</style>
      <h1>{t.ageGateTitle}</h1>
      <p className="notice">
        {t.ageGateBody(MIN_AGE)}{" "}
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">
          {t.privacyPolicy}
        </a>
      </p>
      {/* `<form>` e não dois handlers: é o que faz o Enter do teclado virtual
          enviar, e o teclado virtual é como a maioria vai responder isto. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <label>
          {t.ageGateLabel}
          <input
            type="number"
            inputMode="numeric"
            autoComplete="off"
            min={1900}
            max={new Date().getFullYear()}
            placeholder="YYYY"
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              // O aviso de formato é sobre o que foi enviado; digitar de novo
              // já é a correção, e deixá-lo na tela acusaria o certo.
              if (verdict) setVerdict(null);
              setError(null);
            }}
          />
        </label>
        {verdict?.kind === "invalid" && (
          <p className="notice error" role="alert">
            {t.ageGateInvalid}
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="onboarding-go" disabled={busy || year === ""}>
          {t.ageGateAction}
        </button>
      </form>
    </div>
  );
}
