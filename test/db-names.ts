/**
 * The names of the databases the test suite creates and connects to — ONE source of truth.
 *
 * WHY THIS FILE EXISTS. The names used to be two hardcoded constants in test/global-setup.ts, and
 * test/env.ts independently spelled the worker name as a third literal (`ai_hr_test_w${poolId}`). Two
 * problems came out of that:
 *
 *   1. `global-setup` DROPs and RECREATEs the template and every worker database on EVERY vitest
 *      invocation. With fixed names the collision is SERVER-WIDE, not per-checkout: two `pnpm vitest`
 *      runs anywhere on the machine — different git worktrees included — destroy each other's
 *      databases mid-run, and both produce failures that look exactly like real ones. This has already
 *      cost real time: see the contention guard in cleanroom-verify.sh, added after R46 and R47 both
 *      produced red gates caused by an unrelated process (R47's first run took 59 minutes and reported
 *      3 phantom failures). That guard refuses to start when anything else is connected — a blunt
 *      workaround for exactly this, which namespacing addresses at the root.
 *   2. The creator and the connector derived the name separately, so they could drift apart silently.
 *
 * WHY FUNCTIONS AND NOT CONSTANTS — this is load-bearing, not style. Both consumers call
 * `process.loadEnvFile('.env.local')` inside their own bodies (test/env.ts at module scope,
 * global-setup inside `setup()`). ES imports are hoisted and evaluated BEFORE either of those runs, so
 * a module-level `const` here would capture TEST_DB_NAMESPACE before `.env.local` had been read — and
 * would capture it at a DIFFERENT moment in each consumer. The failure mode is the worst kind:
 * global-setup stamps `ai_hr_test_w1_x` while the worker connects to `ai_hr_test_w1`, and the error
 * surfaces as a confusing missing-relation failure rather than a naming bug. Evaluating per call means
 * both always read the same value at the same point in their lifecycle.
 */

const TEMPLATE_BASE = 'ai_hr_test_tpl';
const WORKER_BASE = 'ai_hr_test_w';

/**
 * The validated, normalised suffix. Empty (the default) reproduces the historical names exactly, so a
 * plain `pnpm vitest run` is unchanged and no existing invocation has to learn a new variable.
 *
 * VALIDATED, not interpolated blindly: these names reach Postgres through
 * `sql.unsafe(`CREATE DATABASE "${name}"`)`, so an unchecked value is a SQL-injection surface. It is a
 * developer-set variable rather than user input, so the risk is low — but the check is three lines and
 * it also catches the likelier everyday mistake, a typo like `TEST_DB_NAMESPACE="my run"`, at the point
 * of use instead of as a syntax error from Postgres.
 */
function namespaceSuffix(): string {
  const raw = process.env.TEST_DB_NAMESPACE ?? '';
  if (raw === '') return '';
  if (!/^_?[a-z0-9][a-z0-9_]*$/.test(raw) || raw.length > 20) {
    throw new Error(
      `TEST_DB_NAMESPACE='${raw}' is not a usable database-name suffix. Use lowercase letters, digits ` +
        `and underscores only (max 20 chars) — it is appended to '${TEMPLATE_BASE}' / '${WORKER_BASE}' ` +
        `and must be a legal Postgres identifier.`,
    );
  }
  // Normalised so `TEST_DB_NAMESPACE=alice` reads as ai_hr_test_tpl_alice rather than ai_hr_test_tplalice.
  return raw.startsWith('_') ? raw : `_${raw}`;
}

/** The schema-only template database every worker database is stamped from. */
export function templateDb(): string {
  return `${TEMPLATE_BASE}${namespaceSuffix()}`;
}

/** The prefix worker databases are named with; the pool id is appended. */
export function workerDbPrefix(): string {
  return `${WORKER_BASE}${namespaceSuffix()}`;
}

/**
 * The database for one vitest worker. Both the creator (global-setup) and the connector (test/env.ts)
 * go through this, so the two can no longer disagree about the name — which is the drift that made the
 * third hardcoded literal in test/env.ts dangerous rather than merely redundant.
 */
export function workerDb(poolId: string | number): string {
  return `${workerDbPrefix()}${poolId}`;
}
