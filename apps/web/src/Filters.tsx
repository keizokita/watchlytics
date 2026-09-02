import { GENRES, type TitleType } from "@watchlytics/contract";
import { t } from "./strings.ts";

/**
 * A1 na tela — tipo, gênero, ano e idioma.
 *
 * Um valor por filtro, não uma lista. O contrato aceita `types[]` e `genres[]`,
 * e a query também; o que não existe é lugar na tela para multi-seleção sem
 * virar formulário. Quando pedirem, troca-se o <select> por chips e só o
 * `toParams` muda.
 */
export type FeedFilters = {
  type?: TitleType;
  genre?: number;
  yearFrom?: number;
  yearTo?: number;
  language?: string;
};

/**
 * ponytail: lista fixa porque a fixture tem quatro idiomas (PLAN §5.1). Com
 * fornecedor de catálogo isto vira um GET dos idiomas presentes.
 */
const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "fr", name: "French" },
] as const;

/** Os nomes são os do contrato: `types`, `genres`, `yearFrom`, … */
export function toParams(f: FeedFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.type) p.set("types", f.type);
  if (f.genre) p.set("genres", String(f.genre));
  if (f.yearFrom !== undefined) p.set("yearFrom", String(f.yearFrom));
  if (f.yearTo !== undefined) p.set("yearTo", String(f.yearTo));
  if (f.language) p.set("languages", f.language);
  return p;
}

/** Campo numérico vazio é "sem filtro", não zero. */
const year = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v);

export function Filters({
  value,
  onChange,
}: {
  value: FeedFilters;
  onChange: (next: FeedFilters) => void;
}) {
  const set = (patch: Partial<FeedFilters>) => onChange({ ...value, ...patch });

  return (
    <div className="filters" role="group" aria-label={t.filters}>
      <select
        aria-label={t.filterType}
        value={value.type ?? ""}
        onChange={(e) =>
          set({ type: (e.target.value || undefined) as TitleType | undefined })
        }
      >
        <option value="">{t.anyType}</option>
        <option value="movie">{t.movie}</option>
        <option value="tv">{t.series}</option>
      </select>

      <select
        aria-label={t.filterGenre}
        value={value.genre ?? ""}
        onChange={(e) =>
          set({ genre: e.target.value ? Number(e.target.value) : undefined })
        }
      >
        <option value="">{t.anyGenre}</option>
        {GENRES.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>

      <select
        aria-label={t.filterLanguage}
        value={value.language ?? ""}
        onChange={(e) => set({ language: e.target.value || undefined })}
      >
        <option value="">{t.anyLanguage}</option>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>

      <input
        type="number"
        inputMode="numeric"
        aria-label={t.filterYearFrom}
        placeholder={t.yearFrom}
        value={value.yearFrom ?? ""}
        onChange={(e) => set({ yearFrom: year(e.target.value) })}
      />
      <input
        type="number"
        inputMode="numeric"
        aria-label={t.filterYearTo}
        placeholder={t.yearTo}
        value={value.yearTo ?? ""}
        onChange={(e) => set({ yearTo: year(e.target.value) })}
      />
    </div>
  );
}
