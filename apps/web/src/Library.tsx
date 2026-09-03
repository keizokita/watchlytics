import { useCallback, useEffect, useState } from "react";
import {
  discardedResponse,
  GENRE_NAME_BY_ID,
  libraryListResponse,
  profileStats,
  sessionUser,
  STATS_MIN_WATCHED,
  type LibraryEntry,
  type LibraryStatus,
  type ProfileStats,
  type SessionUser,
  type Title,
} from "@watchlytics/contract";
import { getAccessToken } from "./Login.tsx";
import { SCREEN_CSS } from "./screenCss.ts";
import { t } from "./strings.ts";

/**
 * D2 — as três abas do catálogo.
 *
 * "Descartados" vem de outro endpoint de propósito: são swipes, não entradas de
 * catálogo, e o tipo devolvido é `Title` puro — sem status e sem nota. A tela
 * não pode fingir que as duas listas são a mesma coisa, porque não são: o
 * descartado expira em 180 dias e volta ao deck sozinho.
 */
type Tab = "interested" | "watched" | "discarded";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "interested", label: t.tabInterested },
  { id: "watched", label: t.tabWatched },
  { id: "discarded", label: t.tabDiscarded },
];

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondeu ${res.status}`);
  return res.json();
}

function Item({ item }: { item: Title }) {
  const genres = item.genreIds
    .map((id) => GENRE_NAME_BY_ID.get(id))
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="lib-item">
      <strong>{item.title}</strong>
      <span className="lib-meta">
        {item.type === "movie" ? t.movie : t.series} · {item.releaseYear} · {genres}
      </span>
    </div>
  );
}

/** Nota como cinco botões: paridade com o requisito de acessibilidade do deck. */
function Rating({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (rating: number | null) => void;
}) {
  return (
    <div className="lib-rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={t.rateHint(n)}
          aria-pressed={value !== null && n <= value}
          onClick={() => onChange(n)}
        >
          {value !== null && n <= value ? "★" : "☆"}
        </button>
      ))}
      <button
        type="button"
        className="lib-clear"
        disabled={value === null}
        onClick={() => onChange(null)}
      >
        {t.clearRating}
      </button>
    </div>
  );
}

function Stats({ stats }: { stats: ProfileStats }) {
  const missing = STATS_MIN_WATCHED - stats.watchedCount;

  return (
    <section className="lib-stats">
      <h2>{t.stats}</h2>
      {stats.aggregates === null ? (
        <p className="lib-locked">{t.statsLocked(missing, STATS_MIN_WATCHED)}</p>
      ) : (
        <dl>
          <div>
            <dt>{t.statsWatched}</dt>
            <dd>{stats.watchedCount}</dd>
          </div>
          <div>
            <dt>{t.statsTime}</dt>
            <dd>{t.statsHours(Math.round(stats.aggregates.estimatedMinutes / 60))}</dd>
          </div>
          <div>
            <dt>{t.statsDecade}</dt>
            <dd>{t.statsDecadeValue(stats.aggregates.favoriteDecade)}</dd>
          </div>
          <div>
            <dt>{t.statsGenres}</dt>
            <dd>
              {stats.aggregates.topGenres
                .map((g) => GENRE_NAME_BY_ID.get(g.genreId))
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

/**
 * C6 — exportar e apagar a conta, onde a pessoa procura os próprios dados.
 *
 * ponytail: mora aqui porque é a única tela de perfil que existe. Sai para um
 * Account.tsx no D5, que traz a tela de perfil de verdade.
 */
function Account() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** `null` até a conta responder — e enquanto isso não se oferece nada. */
  const [me, setMe] = useState<SessionUser | null>(null);

  // O deck ainda entra pelo shim do C1, mas conta é conta: se houver sessão de
  // verdade, estas duas chamadas vão nela.
  const auth = (): HeadersInit => {
    const token = getAccessToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  };

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    let live = true;
    fetch("/v1/auth/me", { headers: auth() })
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((j) => live && j && setMe(sessionUser.parse(j)))
      // Sem sessão não há o que oferecer: a seção some, não vira erro na tela.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const onVisibility = (isPublic: boolean) =>
    run(async () => {
      const res = await fetch("/v1/me", {
        method: "PATCH",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ isPublic }),
      });
      if (!res.ok) throw new Error(`PATCH /v1/me respondeu ${res.status}`);
      setMe((u) => (u ? { ...u, isPublic } : u));
    });

  const onExport = () =>
    run(async () => {
      const res = await fetch("/v1/me/export", { method: "POST", headers: auth() });
      if (!res.ok) throw new Error(`/v1/me/export respondeu ${res.status}`);

      // `fetch` não obedece content-disposition — quem salva o arquivo é a
      // página. O nome vem do cabeçalho para não existir em dois lugares.
      const name = /filename="([^"]+)"/.exec(
        res.headers.get("content-disposition") ?? "",
      )?.[1];

      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name ?? "watchlytics.json";
      link.click();
      URL.revokeObjectURL(url);
    });

  const onDelete = () => {
    // Irreversível: o confirm nativo é o diálogo que o navegador já sabe
    // apresentar, inclusive para leitor de tela. Modal próprio não somaria nada.
    if (!window.confirm(t.deleteAccountConfirm)) return;

    run(async () => {
      const res = await fetch("/v1/me", { method: "DELETE", headers: auth() });
      if (!res.ok) throw new Error(`DELETE /v1/me respondeu ${res.status}`);

      // Apagar a conta e deixar rastro local seria a mesma meia-exclusão que o
      // PLAN §8.4 proíbe no servidor — e a fila de swipes pendentes ficaria
      // tentando gravar para um usuário que não existe mais.
      localStorage.clear();
      sessionStorage.clear();
      location.reload();
    });
  };

  return (
    <section className="lib-account">
      <h2>{t.account}</h2>
      <p className="lib-locked">{t.accountHint}</p>
      {error && <p className="notice error">{t.error(error)}</p>}

      {me && (
        <>
          <label className="lib-public">
            <input
              type="checkbox"
              checked={me.isPublic}
              disabled={busy}
              onChange={(e) => onVisibility(e.target.checked)}
            />
            {t.publicProfile}
          </label>
          {/* O link só aparece quando existe de verdade: perfil privado
              responde 404, e link que não abre é pior que link nenhum. */}
          {me.isPublic ? (
            <p className="lib-locked">
              <a href={`/u/${me.handle}`}>{`${location.origin}/u/${me.handle}`}</a>
            </p>
          ) : (
            <p className="lib-locked">{t.publicProfileHint}</p>
          )}
        </>
      )}

      <div className="lib-account-actions">
        <button type="button" className="lib-move" disabled={busy} onClick={onExport}>
          {t.exportData}
        </button>
        <button type="button" className="lib-danger" disabled={busy} onClick={onDelete}>
          {t.deleteAccount}
        </button>
      </div>
    </section>
  );
}

export function Library() {
  const [tab, setTab] = useState<Tab>("interested");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [discards, setDiscards] = useState<Title[]>([]);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      if (tab === "discarded") {
        setDiscards(discardedResponse.parse(await getJson("/v1/library/discarded")).items);
      } else {
        setEntries(
          libraryListResponse.parse(await getJson(`/v1/library?status=${tab}`)).items,
        );
      }
      setStats(profileStats.parse(await getJson("/v1/me/stats")));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReady(true);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * PUT é substituição (contrato): status e nota vão sempre juntos, senão
   * mudar o status apagaria a nota sem o usuário pedir.
   */
  const save = useCallback(
    async (titleId: string, status: LibraryStatus, rating: number | null) => {
      const res = await fetch(`/v1/library/${titleId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, rating }),
      });
      if (!res.ok) {
        setError(`PUT /v1/library respondeu ${res.status}`);
        return;
      }
      // Sem mutação otimista: aqui não há gesto esperando a tela, e o item
      // muda de aba — recarregar é mais barato que reconciliar duas listas.
      await load();
    },
    [load],
  );

  const count = tab === "discarded" ? discards.length : entries.length;
  const empty =
    tab === "interested"
      ? t.emptyInterested
      : tab === "watched"
        ? t.emptyWatched
        : t.emptyDiscarded;

  return (
    <div className="lib">
      <style>{CSS}</style>

      <div className="lib-tabs" role="tablist">
        {TABS.map((it) => (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={tab === it.id}
            onClick={() => {
              setReady(false);
              setTab(it.id);
            }}
          >
            {it.label}
          </button>
        ))}
      </div>

      {stats && <Stats stats={stats} />}

      {error && <p className="notice error">{t.error(error)}</p>}
      {!ready && <p className="notice">{t.loading}</p>}

      {ready && !error && (
        <>
          {tab === "discarded" && count > 0 && (
            <p className="lib-hint">{t.discardedHint}</p>
          )}
          {count === 0 ? (
            <p className="notice">{empty}</p>
          ) : (
            <ul className="lib-list">
              {tab === "discarded"
                ? discards.map((item) => (
                    <li key={item.id}>
                      <Item item={item} />
                    </li>
                  ))
                : entries.map((entry) => (
                    <li key={entry.title.id}>
                      <Item item={entry.title} />
                      <div className="lib-actions">
                        <Rating
                          value={entry.rating}
                          onChange={(rating) =>
                            void save(entry.title.id, entry.status, rating)
                          }
                        />
                        <button
                          type="button"
                          className="lib-move"
                          onClick={() =>
                            void save(
                              entry.title.id,
                              entry.status === "watched" ? "interested" : "watched",
                              entry.rating,
                            )
                          }
                        >
                          {entry.status === "watched" ? t.markInterested : t.markWatched}
                        </button>
                      </div>
                    </li>
                  ))}
            </ul>
          )}
        </>
      )}

      <Account />
    </div>
  );
}

/**
 * Só o que é do catálogo. O que as telas de conteúdo dividem mora em
 * screenCss.ts — a tela de amigos usa as mesmas classes e montava sem elas.
 */
const CSS = SCREEN_CSS + `
.lib-stats { border: 1px solid rgb(255 255 255 / 0.12); border-radius: 14px; padding: 1rem; }
.lib-stats h2 { margin: 0 0 0.75rem; font-size: 0.8rem; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); }
.lib-stats dl { margin: 0; display: grid; gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); }
.lib-stats dt { font-size: 0.75rem; color: var(--muted); }
.lib-stats dd { margin: 0.15rem 0 0; font-size: 1.1rem; font-weight: 600; }
.lib-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
  justify-content: space-between; }
.lib-rating { display: flex; gap: 0.15rem; align-items: center; }
.lib-rating button { border: none; background: none; color: var(--fg);
  font: inherit; font-size: 1.1rem; line-height: 1; padding: 0.2rem; cursor: pointer; }
.lib-rating .lib-clear { font-size: 0.75rem; color: var(--muted); padding-left: 0.5rem; }
.lib-rating .lib-clear:disabled { opacity: 0.35; cursor: default; }

.lib-account { border: 1px solid rgb(255 255 255 / 0.12); border-radius: 14px;
  padding: 1rem; display: grid; gap: 0.75rem; }
.lib-account h2 { margin: 0; font-size: 0.8rem; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); }
.lib-account-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.lib-account button:disabled { opacity: 0.4; cursor: default; }
/* A cor do botão destrutivo é a do pass, e só ele é vermelho na tela. */
.lib-danger { padding: 0.45rem 0.9rem; border-radius: 999px;
  border: 1px solid var(--pass); background: none; color: var(--pass);
  font: inherit; font-size: 0.85rem; cursor: pointer; }
`;
