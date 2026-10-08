# ADR-0094 — A tiered test gate: a faster full gate, and an affected tier for presentational diffs

- **Date:** 2026-10-08
- **Status:** Accepted. The owner approved the tiered gate on 2026-10-08 (round r417).
- **Related:** ADR-0075 (sustainable verification gates; its §2 "a missing receipt falls through to running
  the suite" is superseded here), CLAUDE.md §4 and §7, `scripts/gate-chunked.sh`, `scripts/gate-affected.sh`,
  `scripts/gate-tier.ts`, `scripts/gate-db-classify.ts`, `scripts/improve/release-gate.ts`.

## Context

Measured on 2026-10-08 on the 18 GB, 12-core development machine:

- The suite is 1,221 vitest files (node + dom; plus 6 real-browser files outside the gate). About 734 import
  the database harness or `db/client`; about 560 read source text. The computed split below puts 758 on the
  DB side and 463 on the no-DB side — the extra DB files are the conservative rules at work.
- An uncontended full gate (`scripts/gate-chunked.sh`, 20 chunks at 3 workers) takes about 25 minutes, of
  which vitest is about 20. A per-chunk cluster rebuild plus migration costs about 7 seconds.
- Every chunk rebuilt the cluster and ran its share of ALL files, including the ~460 that never open a
  connection, at the low worker count the DB files need.
- Contention is the other cost, and it is not the gate's: another project on the machine was running about
  35 vitest workers (load average ~73). A gate run then is slow for reasons its log never showed.
- `scripts/improve/release.ts` fell through to a bare `pnpm vitest run` whenever the gate receipt was
  missing or stale — the one command this machine cannot run (it writes more WAL than the RAM disk holds).
- Many rounds change only presentation: r416 (one CSS stacking fix in `app/layout.tsx` and a component)
  waited the full ~25 minutes like a migration would.

## Decision

### 1. The full gate runs in two parts (`scripts/gate-chunked.sh`)

- **(a)** Every file that does not touch the database, in ONE vitest invocation through
  `vitest.nodb.config.ts` — the same projects as `vitest.config.ts` minus `globalSetup` (which connects to
  Postgres), at `VITEST_MAX_WORKERS_NODB` workers (default 6), with no cluster rebuild. Every database URL is
  pointed at a closed port (127.0.0.1:1) on every run, so a misclassified file fails the gate instead of
  passing against a leftover cluster. `GATE_NODB_PROOF=1` runs part (a) alone.
- **(b)** The DB files, chunked exactly as before: rebuild + migrate per chunk, the same `CHUNKS` and
  `VITEST_MAX_WORKERS` handling, the same "asked for N, vitest counted M" assertion.
- The two lists must partition the suite (asserted before anything runs), and on a full run the counted
  files across (a) and (b) must equal the suite count (asserted at the end).
- A full run on a clean tree writes `.gate-receipt.json` with `tier: "full"` and `result: PASS` (green) or
  `FAIL` (red). Slices, proof runs and dirty trees write none.
- The script prints the machine load average at the start, and takes both test-lock slots itself unless its
  caller already holds them.

**The DB classifier** (`scripts/gate-db-classify.ts`, computed, never a hand list). A test file is DB when
it, or any module under `test/` it imports (followed transitively), does any of:

- imports `test/harness`, `test/global-setup`, `db/client`, `db/schema`, or `pg`, `postgres`,
  `drizzle-orm/postgres-js`, `drizzle-orm/node-postgres`, `drizzle-orm/pg-core`;
- contains `migrateTestDb(`, `resetDb(` or `withTenant(`;
- mentions `DATABASE_URL`, `inject('workerDbPrefix')` or `psql`;
- has a relative / `@/` import that does not resolve, or a dynamic `import()`/`require()` whose argument is
  not a string literal.

Imports into product code (`core/`, `lib/`, `app/` …) are not followed: importing `db/client` opens no
connection. The closed-port run in part (a) is what proves no such file actually queries.

### 2. The affected tier (`scripts/gate-affected.sh`)

**Base**: the commit production runs (`built_ref` from `deploy/deploy-state.sh status` on the box,
read-only), falling back to `main`; or an explicit argument. The diff is `git diff --no-renames BASE...HEAD`.
A tree with uncommitted or untracked changes is refused.

**Allowed only when EVERY changed file is presentational or docs** (`scripts/gate-tier.ts`, pure, unit
tested in `test/r417-gate-tier.test.ts`):

| Allowed | Condition |
|---|---|
| `components/**` | the file contains no `'use server'` at HEAD, at the base, or in its diff |
| `app/globals.css` | — |
| `messages/*.json` | top level only |
| `docs/**`, `*.md` | — (but `lib/**/*.md` is lib, so FULL) |
| `test/**` | except the vitest setup files (`test/env.ts`, `test/global-setup.ts`, `test/dom-setup.ts`, `test/browser-setup.ts`, `test/db-names.ts`), which apply to every test and are FULL |
| `public/**` | except `public/forms/**` |
| `app/**/page.tsx`, `layout.tsx`, `loading.tsx` | only when NONE of their added or removed diff lines contain `await`, `import `, `scoped`, `session`, `redirect(`, `notFound(`, `permission`, `sql`, `db.`, `withTenant`, `'use server'` (either quote), `fetch(`, `process.env`, `export async function`, `export function`, `searchParams` |

**Everything else is FULL**, with the reason printed per file. Named categories: `core/`, `packs/`,
`localization/`, `db/` and its migrations, **all of `lib/`**, `app/**/actions.ts`, `app/**/route.ts`,
`middleware`/`proxy`, `scripts/`, `deploy/`, `package.json`, the lockfile and workspace file, `next.config.*`,
`public/forms/**`, any `vitest*.config.*`, the test setup files above; and anything not on the allow-list
(other `app/` files, `i18n/`, `tsconfig.json`, …). An empty diff is FULL. Not allowed → it prints
`FULL GATE REQUIRED` with every reason and exits 3. There is no override flag.

**What it runs when allowed** (`scripts/gate-affected-plan.ts`), under both test-lock slots with a UTF-8
locale:

1. `vitest related` over the changed non-test files, via vitest's node API so the list is known before
   anything runs;
2. every test file whose source text names a changed file's repo path, its path without extension, or its
   basename without extension, as a whole word (`git grep -lwF`) — guards that read source with `fs` are
   invisible to the import graph;
3. the repo-sweeping guards: `function-access`, `i18n-coverage`, `server-client-boundary`,
   `rsc-boundary-guard`, `r394-route-loading`, `module-catalog-drift`, `topbar-overlap-guard`,
   `today-in-myt-drift`, every `*pack-drift*` file, and every test whose name ends in `-guard` or `-drift`
   (a glob, so new guards join automatically);
4. the changed test files themselves;
5. `pnpm test:browser` when any changed file is `.tsx` or `.css`.

The set is split with the DB classifier: no-DB files run on the closed port; DB files run after ONE cluster
rebuild. Green writes `.gate-receipt.json` with `tier: "affected"`, the base, the changed files, the file
list run and the counts. Red writes nothing.

### 3. The release ships only what a gate covered (`scripts/improve/release-gate.ts`)

`release.ts` never runs the suite. It prints which tier covered HEAD and:

- **no receipt, unreadable, not PASS, or for another sha** → refuses and names the gate to run;
- **`tier: "full"`** (or a pre-tier receipt, which was always the full gate) → ships;
- **`tier: "affected"`** → re-runs the tier classifier on the diff from the DEPLOYED commit to HEAD (that
  diff is what will actually change on the box). FULL, or a deployed ref that cannot be read or found in the
  repo → refuses with the reasons. It does not fall back to running vitest.

## What the affected tier can and cannot catch

**Can:** anything a test reaches through the import graph of a changed component, page markup, message
catalogue or stylesheet; any source-reading guard that names the changed file; every repo-wide sweep that is
named as a guard or drift test (permissions/SCREENS, i18n key coverage, server/client and RSC boundaries,
route loading shells, pack drift ratchets, the top-bar overlap guard); real-browser layout (`test:browser`).

**Cannot, by construction:**

- Repo-wide behaviour reached only through a changed `lib/` module — a permission table, a date helper, a
  formatter. This is excluded **by construction**, not by luck: any change to `lib/` forces FULL, as do
  `core/`, `packs/`, `localization/`, `db/`, actions, routes and config.
- A test that depends on a changed component without importing it, without naming it in its text, and
  without being a guard — e.g. a test that walks `components/` with `readdirSync` under a name not ending in
  `-guard`/`-drift`. Such a sweep should be named `-guard` so the glob finds it.
- Anything outside vitest: `tsc` (still run by `release.ts`), `next build` (still run on the box before
  `db:migrate`, which leaves production untouched on failure), render checks (CLAUDE.md §8).
- Faults that depend on WHERE a test runs rather than what changed. r400's
  `test/r400-monolith-primitives.test.ts` compared against `main:`, was green on its branch, and went red on
  main the moment r400 merged. Both tiers are equally green on the branch and equally red on the merged
  commit (the affected tier always runs a changed test file); neither tier is a substitute for gating the
  commit that ships, which is why the receipt names a sha and the release checks it.

## Consequences

- A presentational round (r416's diff classifies as allowed) is gated in minutes, not ~25.
- The full gate stops paying cluster rebuilds and low worker counts for ~460 files that need neither.
- A receipt is now the only path to a release; an operator who skips the gate is refused, not silently
  served a bare suite run that dies on this machine.
- The DB classifier's correctness is re-proven by every full gate (part (a) on a closed port). Its known
  blind spot — product code that queries without the harness — fails loudly there rather than passing.
