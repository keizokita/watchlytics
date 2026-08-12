import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Proxy em vez de CORS: mesma origem em dev e em produção.
  server: { proxy: { "/v1": "http://localhost:3000" } },
});
