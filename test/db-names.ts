/**
 * The test databases' names, in ONE place, derived from an optional namespace.
 *
 * WHY THIS FILE EXISTS. `TEMPLATE_DB` and `WORKER_DB_PREFIX` used to be hardcoded constants in
 * test/global-setup.ts, and global-setup DROPs and RECREATEs every one of them on each vitest
 * invocation. Because the names were fixed, that made the collision SERVER-WIDE rather than
 * per-checkout: two `pnpm vitest` runs anywhere on the machine — different git worktrees included —
 * destroyed each other's databases mid-run, and the damage did not look like damage. It surfaced as
 * TRUNCATE deadlocks, 30-second hook timeouts and assertion failures in files that had nothing to do
 * with either change, which is the worst possible failure shape: it reads as "your code is broken".
 *
 * It has cost real time. A fan-out of parallel agents each running vitest destroyed its own results;
 * so did parallel adversarial reviewers; and deploy/cleanroom-verify.sh carries a "contention guard"
 * that REFUSES to start if any other client is connected to the instance — a blunt workaround for
 * exactly this, added after two red gates (one 59-minute run reporting three phantom failures).
 *
 * Set TEST_DB_NAMESPACE to run suites concurrently:
 *
 *     TEST_DB_NAMESPACE=_a pnpm vitest run     # uses ai_hr_test_tpl_a / ai_hr_test_w_a1..N
 *     TEST_DB_NAMESPACE=_b pnpm vitest run     # fully independent, runs at the same time
 *
 * Unset is the default and reproduces the original names exactly, so an ordinary `pnpm vitest run`,
 * CI, and the clean-room gate are byte-identical to before.
 *
 * FUNCTIONS, NOT CONSTANTS, AND THAT IS LOAD-BEARING. Both consumers call `process.loadEnvFile`
 * INSIDE their own body — test/global-setup.ts inside `setup()`, test/env.ts at the top of the
 * module. ES imports are hoisted and evaluated BEFORE any of that runs, so a module-level `const`
 * here would read the namespace before .env.local had been loaded. Worse, the two consumers load it
 * at different moments, so a constant could resolve differently in each: global-setup would create
 * one set of databases and the workers would connect to another, which fails as "database does not
 * exist" with no hint as to why. Resolving at call time removes the ordering question entirely.
 */

/** Postgres identifiers are 63 bytes; the longest generated name is prefix + 2 digits, so cap well under. */
const MAX_NAMESPACE = 24;

/**
 * The validated namespace suffix, or '' when unset.
 *
 * Validated rather than trusted because these names are interpolated into `sql.unsafe` — global-setup
 * issues `DROP DATABASE IF EXISTS "..."` and `CREATE DATABASE "..."` by string. A namespace is a
 * developer-supplied value from the environment, so the injection risk is low, but the check is one
 * line and it also catches the likelier mistake: a stray space or quote producing a database name
 * nobody can drop afterwards.
 */
function namespace(): string {
  const raw = process.env.TEST_DB_NAMESPACE ?? '';
  if (raw === '') return '';
  if (!/^[a-z0-9_]{1,24}$/.test(raw)) {
    throw new Error(
      `TEST_DB_NAMESPACE must be 1-${MAX_NAMESPACE} chars of [a-z0-9_] (got ${JSON.stringify(raw)}). ` +
        'It is appended to the test database names, which are created by name — a space, quote or ' +
        'capital would produce a database that is awkward to drop by hand.',
    );
  }
  // Exactly one leading underscore, whether or not the caller supplied it: `par1` and `_par1` both
  // yield `ai_hr_test_tpl_par1`. Without this, `TEST_DB_NAMESPACE=par1` produced `ai_hr_test_tplpar1`,
  // which still works but reads as a typo when you are staring at a `\l` listing trying to work out
  // which run owns which database — the exact moment you least want ambiguity.
  return raw.startsWith('_') ? raw : `_${raw}`;
}

/** The migrated, schema-only database every worker database is stamped from. */
export const templateDb = (): string => `ai_hr_test_tpl${namespace()}`;

/** Worker databases are `${workerDbPrefix()}${VITEST_POOL_ID}` — see test/env.ts. */
export const workerDbPrefix = (): string => `ai_hr_test_w${namespace()}`;
