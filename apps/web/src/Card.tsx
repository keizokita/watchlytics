import { GENRE_NAME_BY_ID, type Title } from "@watchlytics/contract";
import { t } from "./strings.ts";

/**
 * Pôster determinístico a partir do id, enquanto não há fornecedor de catálogo.
 *
 * ponytail: gradiente valida o gesto, não o apelo visual do card. A fase 1 não
 * fecha sem ter visto a mecânica com imagem de verdade.
 */
export function gradient(id: string) {
  const h = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `linear-gradient(160deg, hsl(${h} 52% 30%), hsl(${(h + 45) % 360} 58% 12%))`;
}

export function Card({ title: item }: { title: Title }) {
  const genres = item.genreIds
    .map((id) => GENRE_NAME_BY_ID.get(id))
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="card">
      <div className="card-meta">
        {item.type === "movie" ? t.movie : t.series} · {item.releaseYear} ·{" "}
        {item.voteAverage.toFixed(1)}
      </div>
      <h2 className="card-title">{item.title}</h2>
      {item.originalTitle && item.originalTitle !== item.title && (
        <div className="card-original">{item.originalTitle}</div>
      )}
      <div className="card-genres">{genres}</div>
      <p className="card-overview">{item.overview}</p>
    </article>
  );
}
