import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  GENRE_NAME_BY_ID,
  feedResponse,
  type Title,
} from "@watchlytics/contract";

/**
 * Pôster determinístico a partir do id, enquanto não há fornecedor de catálogo.
 *
 * ponytail: gradiente valida o gesto, não o apelo visual do card. A fase 1 não
 * fecha sem ter visto a mecânica com imagem de verdade.
 */
function gradient(id: string) {
  const h = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `linear-gradient(160deg, hsl(${h} 52% 30%), hsl(${(h + 45) % 360} 58% 12%))`;
}

function Card({ t }: { t: Title }) {
  const genres = t.genreIds
    .map((id) => GENRE_NAME_BY_ID.get(id))
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      style={{
        width: "min(22rem, 100%)",
        aspectRatio: "2 / 3",
        borderRadius: 20,
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        background: t.posterUrl
          ? `center / cover url(${t.posterUrl})`
          : gradient(t.id),
        boxShadow: "0 12px 40px rgb(0 0 0 / 0.5)",
        userSelect: "none",
      }}
    >
      <div
        style={{
          fontSize: "0.75rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--muted)",
        }}
      >
        {t.type === "movie" ? "Movie" : "Series"} · {t.releaseYear} ·{" "}
        {t.voteAverage.toFixed(1)}
      </div>
      <h1 style={{ margin: "0.35rem 0", fontSize: "1.6rem", lineHeight: 1.15 }}>
        {t.title}
      </h1>
      {t.originalTitle && t.originalTitle !== t.title && (
        <div style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
          {t.originalTitle}
        </div>
      )}
      <div
        style={{ margin: "0.5rem 0", fontSize: "0.8rem", color: "var(--muted)" }}
      >
        {genres}
      </div>
      <p style={{ margin: 0, fontSize: "0.95rem" }}>{t.overview}</p>
    </article>
  );
}

function App() {
  const [state, setState] = useState<
    { s: "loading" } | { s: "error"; m: string } | { s: "ok"; items: Title[] }
  >({ s: "loading" });

  useEffect(() => {
    fetch("/v1/feed")
      .then(async (r) => {
        if (!r.ok) throw new Error(`feed respondeu ${r.status}`);
        return feedResponse.parse(await r.json());
      })
      .then((f) => setState({ s: "ok", items: f.items }))
      .catch((e: unknown) =>
        setState({ s: "error", m: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  if (state.s === "loading") return <p>carregando…</p>;
  if (state.s === "error")
    return <p style={{ color: "#ff8080" }}>erro: {state.m}</p>;
  if (!state.items.length) return <p>catálogo vazio — rodou o seed?</p>;

  return <Card t={state.items[0]!} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
