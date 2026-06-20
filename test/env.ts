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

// Payroll feature gates are DEPLOYMENT config — they may be ON in .env.local for the dev app. Tests are
// hermetic: default them OFF here so the legacy path is exercised; the multi-cycle / typed-component /
// group-PCB tests opt in explicitly per-test.
delete process.env.MULTI_CYCLE_PAYROLL_ENABLED;
delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
delete process.env.GROUP_PCB_COORDINATION_ENABLED;
