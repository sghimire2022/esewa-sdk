import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: React runs on Vite (5173), Express runs on 3000. Vite forwards /api to
// Express, so the browser only ever talks to one origin, same as production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
