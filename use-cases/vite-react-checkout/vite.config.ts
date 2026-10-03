import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the React app runs on Vite (5173) and the Express server on 3000.
// Vite forwards every /api request to Express, so the browser only ever talks to
// one origin, the same way it will in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
