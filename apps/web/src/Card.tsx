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

  /** Ano e gênero são a mesma classe de informação: uma linha, um separador. */
  const meta = [String(item.releaseYear), genres].filter(Boolean).join(" · ");

  return (
    <article className="card">
      {/* Tipo e nota sobem para o topo: são o filtro rápido de quem decide em
          um segundo, e no rodapé viravam mais uma linha cinza antes do título. */}
      <div className="card-top">
        <span className="card-kind">
          {item.type === "movie" ? t.movie : t.series}
        </span>
        <span className="card-score" aria-label={t.voteHint(item.voteAverage)}>
          {item.voteAverage.toFixed(1)}
        </span>
      </div>

      <div className="card-body">
        <h2 className="card-title">{item.title}</h2>
        {item.originalTitle && item.originalTitle !== item.title && (
          <p className="card-original">{item.originalTitle}</p>
        )}
        <p className="card-meta">{meta}</p>
        <p className="card-overview">{item.overview}</p>
      </div>
    </article>
  );
}
