import { GENRE_NAME_BY_ID, type Title } from "@watchlytics/contract";
import { t } from "./strings.ts";

export function Card({ title: item }: { title: Title }) {
  const genres = item.genreIds
    .map((id) => GENRE_NAME_BY_ID.get(id))
    .filter(Boolean)
    .join(" · ");

  /** Ano e gênero são a mesma classe de informação: uma linha, um separador. */
  const meta = [String(item.releaseYear), genres].filter(Boolean).join(" · ");

  /* O contrato traz até 5 nomes e quem corta é o card. Três é o que cabe em
     uma linha; o quarto entraria só como reticência. */
  const cast = item.castNames.slice(0, 3).join(" · ");

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
        {/* Última linha de propósito: título sem elenco perde a linha e nada
            acima dele muda de lugar de um card para o outro. */}
        {cast && <p className="card-cast">{cast}</p>}
      </div>
    </article>
  );
}
