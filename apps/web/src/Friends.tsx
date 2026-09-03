import { useCallback, useEffect, useState } from "react";
import {
  friendsResponse,
  HANDLE_SEARCH_MIN,
  matchesResponse,
  notificationsResponse,
  userSearchResponse,
  type FriendsResponse,
  type MatchEntry,
  type PublicUser,
} from "@watchlytics/contract";
import { getAccessToken } from "./Login.tsx";
import { SCREEN_CSS } from "./screenCss.ts";
import { t } from "./strings.ts";

/**
 * E1, E2, E5 e E6 — a tela social inteira: achar gente, pedir e aceitar
 * amizade, ver os títulos em comum e ler as notificações.
 *
 * Três abas numa tela só, e não três telas: as três leem do mesmo par de
 * rotas e ninguém procura "matches" num lugar diferente de "amigos".
 */

const auth = (): HeadersInit => {
  const token = getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
};

const vazio: FriendsResponse = { friends: [], incoming: [], outgoing: [] };

type Tab = "people" | "common" | "alerts";

const TABS: { id: Tab; label: string }[] = [
  { id: "people", label: t.friendTabPeople },
  { id: "common", label: t.friendTabCommon },
  { id: "alerts", label: t.friendTabAlerts },
];

/** Evento local: a aba de avisos marcou tudo lido, o badge da nav que se vire. */
const ZEROU = "wl:notifications";

type Aviso = {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
  readAt: string | null;
};

/**
 * O texto sai do payload, sem nenhum fetch: handle e título foram gravados
 * junto com a notificação de propósito (ver matchOnLike na api).
 */
function textoDoAviso(a: Aviso): string {
  const p = (a.payload ?? {}) as Record<string, unknown>;
  const handle = typeof p["friendHandle"] === "string" ? p["friendHandle"] : "";

  if (a.type === "friend_matches" && typeof p["count"] === "number") {
    return t.alertCommon(handle, p["count"]);
  }
  if (a.type === "match" && typeof p["title"] === "string") {
    return t.alertMatch(handle, p["title"]);
  }
  // Tipo que esta versão do cliente não conhece: mostra que chegou algo em vez
  // de sumir com a linha. App velho no celular de alguém é o caso normal.
  return t.alertUnknown;
}

function Pessoa({
  user,
  action,
}: {
  user: PublicUser;
  action?: { label: string; onClick: () => void; disabled: boolean };
}) {
  return (
    <li className="friend">
      <span>
        <strong>{user.displayName}</strong>{" "}
        <span className="lib-meta">@{user.handle}</span>
      </span>
      {action && (
        <button
          type="button"
          className="lib-move"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </li>
  );
}

/** E5 — a força vem do par de status, e é o que decide se notificou ou não. */
function Comum({ item }: { item: MatchEntry }) {
  return (
    <li className="friend">
      <span className="lib-item">
        <strong>{item.title.title}</strong>
        <span className="lib-meta">
          @{item.friend.handle} · {t.matchStrength[item.strength]}
        </span>
      </span>
    </li>
  );
}

/** `#/friends/common` → aba comum. Fora da lista, cai em People. */
const tabDoHash = (): Tab => {
  const id = location.hash.split("/")[2];
  return TABS.some((t) => t.id === id) ? (id as Tab) : "people";
};

export function Friends() {
  // A aba vive no hash: o botão voltar funciona e o link de "títulos em comum"
  // pode ser mandado para alguém — mesma navegação que a nav do shell usa.
  const [tab, setTab] = useState<Tab>(tabDoHash);

  useEffect(() => {
    const onHash = () => setTab(tabDoHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[] | null>(null);
  const [lists, setLists] = useState<FriendsResponse>(vazio);
  const [comuns, setComuns] = useState<MatchEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const pega = async (url: string) => {
    const res = await fetch(url, { headers: auth() });
    if (!res.ok) throw new Error(`${url} respondeu ${res.status}`);
    return res.json() as Promise<unknown>;
  };

  const load = useCallback(async () => {
    setLists(friendsResponse.parse(await pega("/v1/friends")));
  }, []);

  const loadComuns = useCallback(async () => {
    const page = matchesResponse.parse(await pega("/v1/matches"));
    setComuns(page.items);
    setCursor(page.nextCursor);
  }, []);

  /**
   * "Badge zera ao abrir": abrir a aba é ler. Marca antes de listar para o
   * badge cair no mesmo instante — a lista continua mostrando tudo, só sem o
   * contador em cima.
   */
  const loadAvisos = useCallback(async () => {
    await fetch("/v1/notifications/read", { method: "POST", headers: auth() });
    dispatchEvent(new Event(ZEROU));
    setAvisos(notificationsResponse.parse(await pega("/v1/notifications")).items);
  }, []);

  useEffect(() => {
    run(load);
  }, [load]);

  useEffect(() => {
    if (tab === "common") run(loadComuns);
    if (tab === "alerts") run(loadAvisos);
  }, [tab, loadComuns, loadAvisos]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const url = `/v1/users?q=${encodeURIComponent(q.trim())}`;
      setResults(userSearchResponse.parse(await pega(url)).items);
    });
  };

  const onRequest = (handle: string) =>
    run(async () => {
      const res = await fetch("/v1/friends/requests", {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      if (!res.ok) throw new Error(`POST /v1/friends/requests respondeu ${res.status}`);
      // A lista de enviados é a confirmação: sem recarregar, o botão ficaria
      // oferecendo o mesmo pedido.
      await load();
    });

  const onAccept = (userId: string) =>
    run(async () => {
      const res = await fetch(`/v1/friends/requests/${userId}/accept`, {
        method: "POST",
        headers: auth(),
      });
      if (!res.ok) throw new Error(`accept respondeu ${res.status}`);
      // O aceite cruza os catálogos (E4): há match novo e aviso novo agora.
      await Promise.all([load(), loadComuns()]);
      dispatchEvent(new Event(ZEROU));
    });

  const maisComuns = () =>
    run(async () => {
      const page = matchesResponse.parse(
        await pega(`/v1/matches?cursor=${encodeURIComponent(cursor!)}`),
      );
      setComuns((atual) => [...atual, ...page.items]);
      setCursor(page.nextCursor);
    });

  /** Já pedido ou já amigo: o botão de adicionar não faria nada de novo. */
  const known = new Set(
    [...lists.friends, ...lists.incoming, ...lists.outgoing].map((u) => u.id),
  );

  return (
    <div className="lib">
      <style>{CSS}</style>
      <h1>{t.friends}</h1>

      <div className="lib-tabs" role="tablist">
        {TABS.map((it) => (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={tab === it.id}
            onClick={() => {
              location.hash = `#/friends/${it.id}`;
            }}
          >
            {it.label}
          </button>
        ))}
      </div>

      {error && <p className="notice error">{t.error(error)}</p>}

      {tab === "people" && (
        <>
          <form className="friend-search" onSubmit={onSearch}>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t.friendSearchPlaceholder}
              aria-label={t.friendSearchLabel}
              minLength={HANDLE_SEARCH_MIN}
            />
            <button type="submit" className="lib-move" disabled={busy}>
              {t.friendSearchAction}
            </button>
          </form>

          {results !== null && (
            <section>
              <h2>{t.friendResults}</h2>
              {results.length === 0 ? (
                // Mesma mensagem para "não existe" e "termo curto demais": a
                // tela não é lugar de contar quem tem conta (PLAN §8.6).
                <p className="lib-locked">{t.friendNoResults(HANDLE_SEARCH_MIN)}</p>
              ) : (
                <ul className="lib-list">
                  {results.map((u) => (
                    <Pessoa
                      key={u.id}
                      user={u}
                      action={
                        known.has(u.id)
                          ? undefined
                          : {
                              label: t.friendAdd,
                              onClick: () => onRequest(u.handle),
                              disabled: busy,
                            }
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {lists.incoming.length > 0 && (
            <section>
              <h2>{t.friendIncoming}</h2>
              <ul className="lib-list">
                {lists.incoming.map((u) => (
                  <Pessoa
                    key={u.id}
                    user={u}
                    action={{
                      label: t.friendAccept,
                      onClick: () => onAccept(u.id),
                      disabled: busy,
                    }}
                  />
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2>{t.friendYours}</h2>
            {lists.friends.length === 0 ? (
              <p className="lib-locked">{t.friendNone}</p>
            ) : (
              <ul className="lib-list">
                {lists.friends.map((u) => (
                  <Pessoa key={u.id} user={u} />
                ))}
              </ul>
            )}
          </section>

          {lists.outgoing.length > 0 && (
            <section>
              <h2>{t.friendOutgoing}</h2>
              <ul className="lib-list">
                {lists.outgoing.map((u) => (
                  <Pessoa key={u.id} user={u} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {tab === "common" &&
        (comuns.length === 0 ? (
          <p className="lib-locked">{t.commonNone}</p>
        ) : (
          <>
            <ul className="lib-list">
              {comuns.map((item) => (
                <Comum key={`${item.friend.id}-${item.title.id}`} item={item} />
              ))}
            </ul>
            {cursor && (
              <button type="button" className="lib-move" disabled={busy} onClick={maisComuns}>
                {t.commonMore}
              </button>
            )}
          </>
        ))}

      {tab === "alerts" &&
        (avisos.length === 0 ? (
          <p className="lib-locked">{t.alertsNone}</p>
        ) : (
          <ul className="lib-list">
            {avisos.map((a) => (
              <li key={a.id} className="friend">
                <span className="lib-item">
                  <span>{textoDoAviso(a)}</span>
                  <span className="lib-meta">
                    {new Date(a.createdAt).toLocaleDateString()}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/**
 * E6 — o badge da nav. Pergunta de minuto em minuto (PLAN §7): sem websocket,
 * porque uma conexão viva por usuário custaria máquina no Fly para entregar
 * aviso de amizade, que ninguém precisa ver no mesmo segundo.
 */
export function NotificationsBadge() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let live = true;

    const check = async () => {
      try {
        const res = await fetch("/v1/notifications", { headers: auth() });
        if (!res.ok) return; // deslogado ou api fora: badge some, não vira erro
        const { unread } = notificationsResponse.parse(await res.json());
        if (live) setUnread(unread);
      } catch {
        // Badge é enfeite: falha de rede aqui não pode virar tela de erro.
      }
    };

    void check();
    const id = setInterval(check, 60_000);
    // A aba de avisos marca tudo lido; sem isto o badge só cairia no próximo
    // minuto, mostrando um número que a pessoa acabou de zerar.
    addEventListener(ZEROU, check);

    return () => {
      live = false;
      clearInterval(id);
      removeEventListener(ZEROU, check);
    };
  }, []);

  if (unread === 0) return null;
  return (
    <span className="nav-badge" aria-label={t.alertsBadge(unread)}>
      {unread > 9 ? "9+" : unread}
    </span>
  );
}

/** Só o que é da tela social; o resto vem de screenCss.ts. */
const CSS = SCREEN_CSS + `
.friend-search { display: flex; gap: 0.5rem; }
.friend-search input {
  flex: 1; padding: 0.55rem 0.9rem; border-radius: 999px; font: inherit;
  border: 1px solid rgb(255 255 255 / 0.18);
  background: rgb(255 255 255 / 0.06); color: var(--fg);
}
.friend-search input:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.friend {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
}
.nav-badge {
  display: inline-block; min-width: 1.15rem; padding: 0 0.3rem; margin-left: 0.3rem;
  /* texto escuro sobre o verde claro: branco em #35c98b dá contraste de ~2:1,
     e o badge é justamente o que precisa ser lido de relance */
  border-radius: 999px; background: var(--like, #35c98b); color: #06231a;
  font-size: 0.72rem; font-weight: 700; text-align: center; line-height: 1.15rem;
}
`;
