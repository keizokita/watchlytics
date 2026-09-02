import { useEffect, useState } from "react";
import {
  authResponse,
  authTokens,
  sessionUser,
  type SessionUser,
} from "@watchlytics/contract";
import { t } from "./strings.ts";

/**
 * C2 — login com Google via PKCE.
 *
 * O browser só faz duas coisas: gera o `code_verifier` e devolve o `code` para
 * a nossa API. A troca pelo token acontece no backend, com o client_secret que
 * nunca sai de lá — é o que faz o app da fase 4 reusar o mesmo endpoint.
 *
 * O refresh vive num cookie httpOnly que este arquivo não consegue ler, de
 * propósito: XSS aqui não leva a sessão embora, só o access de 15 minutos.
 */

const CLIENT_ID = import.meta.env["VITE_GOOGLE_CLIENT_ID"] as string | undefined;

/** Volta para a MESMA página: nenhuma rota de callback, nenhum router. */
const REDIRECT_URI = `${window.location.origin}/`;

const VERIFIER_KEY = "wl.pkce.verifier";
const STATE_KEY = "wl.pkce.state";

let accessToken: string | null = null;

/**
 * ponytail: o deck ainda entra pelo shim do C1. Quando ele sair, o fetch do
 * feed e o do buffer de swipes passam a mandar `Bearer ${getAccessToken()}`.
 */
export const getAccessToken = () => accessToken;

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** 32 bytes → 43 caracteres, o mínimo do RFC 7636. */
const randomSecret = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

const challengeOf = async (verifier: string) =>
  b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

async function signIn() {
  if (!CLIENT_ID) throw new Error(t.authNotConfigured);

  const verifier = randomSecret();
  const state = randomSecret();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    code_challenge: await challengeOf(verifier),
    code_challenge_method: "S256",
    state,
  }).toString();

  window.location.assign(url.toString());
}

async function exchange(code: string, state: string): Promise<SessionUser> {
  const expected = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  // O código é de uso único e não pode ficar na barra de endereço nem no
  // histórico — tira antes de qualquer await que possa falhar.
  window.history.replaceState(null, "", window.location.pathname);

  // `state` é a defesa contra CSRF de login: sem isso, um terceiro pode induzir
  // o navegador a trocar UM CÓDIGO DELE e amarrar a sessão à conta do atacante.
  if (!verifier || !expected || state !== expected) {
    throw new Error(t.authStateMismatch);
  }

  const res = await fetch("/v1/auth/oauth/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: REDIRECT_URI }),
  });
  if (!res.ok) throw new Error(`${res.status}`);

  const body = authResponse.parse(await res.json());
  accessToken = body.access;
  return body.user;
}

/** Sessão anterior: o refresh está no cookie, que o servidor lê e rotaciona. */
async function resume(): Promise<SessionUser | null> {
  const res = await fetch("/v1/auth/refresh", { method: "POST" });
  if (!res.ok) return null;
  accessToken = authTokens.parse(await res.json()).access;

  const me = await fetch("/v1/auth/me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return me.ok ? sessionUser.parse(await me.json()) : null;
}

/**
 * Fora do componente porque o efeito do StrictMode roda duas vezes em dev: dois
 * refresh simultâneos com o mesmo token seriam um replay, e o servidor derruba
 * a sessão — corretamente. Uma promessa só, compartilhada.
 */
let started: Promise<SessionUser | null> | null = null;

function boot() {
  started ??= (async () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    return code ? exchange(code, state ?? "") : resume();
  })();
  return started;
}

export function Login() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    boot()
      .then((u) => live && setUser(u))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, []);

  const onSignOut = async () => {
    await fetch("/v1/auth/logout", { method: "POST" });
    accessToken = null;
    started = Promise.resolve(null);
    setUser(null);
  };

  if (busy) return null;

  return (
    <p className="notice">
      {error && <span className="error">{t.error(error)} </span>}
      {user ? (
        <>
          {t.signedInAs(user.handle)}{" "}
          <button type="button" className="link" onClick={() => void onSignOut()}>
            {t.signOut}
          </button>
        </>
      ) : CLIENT_ID ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            setError(null);
            signIn().catch((e: unknown) => setError(String(e)));
          }}
        >
          {t.signIn}
        </button>
      ) : (
        t.authNotConfigured
      )}
    </p>
  );
}
