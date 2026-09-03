import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Proxy em vez de CORS: mesma origem em dev e em produção.
  // `/u` é a rota SSR do perfil público (D5): HTML, não JSON, mesma api.
  server: { proxy: { "/v1": "http://localhost:3000", "/u": "http://localhost:3000" } },
});
