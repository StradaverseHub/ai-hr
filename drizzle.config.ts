import { defineConfig } from 'drizzle-kit';

// Load .env.local for drizzle-kit (Node 21+ built-in; no dotenv dependency).
try {
  process.loadEnvFile('.env.local');
} catch {
  // ignore when absent (e.g. CI provides env directly)
}

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  // Generated table DDL is committed alongside hand-written RLS / grant / constraint
  // migrations (drizzle-kit does not generate those).
  verbose: true,
  strict: true,
});
