import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Alvo do proxy. Literal em dev; variável por causa do tools/a11y, que sobe um
 * par api+vite em portas próprias para não brigar com o run-watchlytics — e com
 * o alvo fixo o vite dele continuava falando com a api da OUTRA sessão, o que
 * dá uma medição limpa descrevendo a branch errada.
 */
const API = process.env["API_ORIGIN"] ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  // Proxy em vez de CORS: mesma origem em dev e em produção.
  // `/u` é a rota SSR do perfil público (D5): HTML, não JSON, mesma api.
  server: { proxy: { "/v1": API, "/u": API } },
});
