// Vitest setup — point the app singleton at the TEST database before anything imports it.
import process from 'node:process';

try {
  process.loadEnvFile('.env.local');
} catch {
  // env provided directly (CI)
}

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_MIGRATION_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL / TEST_MIGRATION_DATABASE_URL must be set for tests');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
