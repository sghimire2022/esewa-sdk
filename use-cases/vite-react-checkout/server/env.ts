// Loads .env (if present) before anything reads process.env.
// Imported first in server/index.ts; ES modules evaluate imports in order.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // No .env file: fall back to defaults (eSewa test credentials).
}
