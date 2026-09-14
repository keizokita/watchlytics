import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Alvo do proxy. Literal em dev; variável por causa do tools/a11y, que sobe um
 * par api+vite em portas próprias para não brigar com o run-watchlytics — e com
 * o alvo fixo o vite dele continuava falando com a api da OUTRA sessão, o que
 * dá uma medição limpa descrevendo a branch errada.
 */
const API = process.env["API_ORIGIN"] ?? "http://localhost:3000";

/**
 * Os cabeçalhos que o Cloudflare Pages carimba em produção, lidos do PRÓPRIO
 * `public/_headers`.
 *
 * Existe porque o `_headers` é do Pages e o vite não o lê: a CSP não valia em
 * nenhum ambiente local, e o que não vale em lugar nenhum não tem como ser
 * medido antes do deploy. Ler o arquivo em vez de repetir a política aqui
 * porque a segunda cópia diverge, e a que diverge é sempre a que ninguém está
 * medindo.
 *
 * O `_headers` tem uma regra só (`/*`), então toda linha `  Nome: valor` do
 * arquivo é dela. Se um dia houver duas regras, isto passa a misturá-las e
 * precisa aprender o que é caminho.
 */
function cabecalhosDoPages(): Record<string, string> {
  const texto = readFileSync(new URL("public/_headers", import.meta.url), "utf8");
  const linhas = [...texto.matchAll(/^ {2}([\w-]+):[ \t]*(\S.*)$/gm)];
  return Object.fromEntries(linhas.map(([, nome, valor]) => [nome!, valor!.trim()]));
}

export default defineConfig({
  plugins: [react()],
  // Proxy em vez de CORS: mesma origem em dev e em produção.
  // `/u` é a rota SSR do perfil público (D5): HTML, não JSON, mesma api.
  server: { proxy: { "/v1": API, "/u": API } },
  /**
   * Os cabeçalhos de produção valem no `preview`, e SÓ nele.
   *
   * `preview` serve o `dist/`, que é exatamente o que vai para o Pages — é a
   * única cena local em que medir a CSP quer dizer alguma coisa. Em `server` a
   * mesma política acusaria o ferramental: o vite de dev injeta script inline e
   * abre websocket de HMR, e nada disso existe no que se publica. Violação que
   * não é do app ensina a ignorar violação, que é pior do que não medir.
   *
   * `proxy` o preview herda do `server` — o `/v1` continua indo para a api.
   */
  preview: { headers: cabecalhosDoPages() },
});
