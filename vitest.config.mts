import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// .env daje MONGODB_URI; brak pliku (np. w CI) nie jest błędem.
try {
  process.loadEnvFile(".env");
} catch {}

// Testy czyszczą i nadpisują dane, więc nigdy nie mogą trafić na wspólną bazę.
const testDb = process.env.MONGODB_DB_TEST ?? "teatr-test";
if (testDb === process.env.MONGODB_DB) {
  throw new Error(
    `MONGODB_DB_TEST (${testDb}) musi być inną bazą niż MONGODB_DB`,
  );
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Testy na Atlasie: pierwsze połączenie i transakcje trwają kilka sekund.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { MONGODB_DB: testDb },
  },
});
