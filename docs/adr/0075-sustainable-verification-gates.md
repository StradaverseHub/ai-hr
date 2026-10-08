# ADR-0075 — Sustainable verification gates

- **Status:** Accepted
- **Date:** 2026-07-20
- **Supersedes (in part):** the per-round clean-room contract in ADR-0045 (IL-4)

## Context

Round R47 shipped three items — one of them a pure-CSS change touching no `core/` or `db/` file — and spent
roughly 45 minutes in verification to do it. R46 was worse. The trend was not incidental: the gate cost had
been growing monotonically while the payload per round shrank.

Measured on the R47 tree (325 test files, 3,265 tests):

| Cost | Cause |
| --- | --- |
| Suite pinned to one core | `vitest.config.ts` set `fileParallelism: false, maxWorkers: 1`, because every file shared one Postgres database |
| ~233 migrations re-read per file | 247 of 325 test files called `migrateTestDb()` in `beforeAll`; drizzle then hashed the whole chain to conclude there was nothing to apply |
| ~100-table `TRUNCATE` per test | 236 files call `resetDb()` in `beforeEach` |
| Entire suite run **twice** per round | `cleanroom-verify.sh` ran it, then `release.ts`'s final gate ran it again on the identical commit |

Two false RED gates (R46, R47) were also traced to this design. Both were originally misdiagnosed as
"parallel worker contention", which `maxWorkers: 1` makes impossible; the real cause was *other clients* on
the shared instance — a running dev server, and sibling build agents' focused test runs. R47's first
clean-room took 59 minutes and reported three phantom failures; with the instance quiet, the same tree
passed in 13.

A separate and more serious problem: **the fresh-database migration gate cannot catch the migration bug this
project actually has.** drizzle's incremental migrator snapshots the latest applied row once, then applies
only journal entries with a greater `when`. An entry added later with a lower `when` is silently skipped —
no error. On an empty database every entry clears the watermark by construction, so a fresh migrate is green
*by definition*. That is precisely why R44's `0240` and the dev box's missing `0220/0225/0240` passed every
gate we had.

## Decision

### 1. One database per test worker, stamped from a migrated template

`test/global-setup.ts` migrates a single schema-only template database once, then issues
`CREATE DATABASE ai_hr_test_wN TEMPLATE ai_hr_test_tpl` per worker — a file-level copy, far cheaper than
replaying the chain. `test/env.ts` rewrites the connection URLs from `VITEST_POOL_ID` before any test file
imports the harness, so **`test/harness.ts` and all 247 call sites are unchanged**. `migrateTestDb()` remains
exported and becomes a no-op rather than forcing a 247-file diff.

Workers no longer share tables, so `fileParallelism` is on and `maxWorkers` scales with the machine.
Isolation is *strictly stronger* than before, not weaker: cross-file interference is now physically
impossible rather than swept up by `resetDb()`.

Two Postgres details this depends on, both easy to get wrong:
- a template must have no open connections while being copied (the migrator client is closed first);
- `TEMPLATE` copies database *contents* and their ACLs, but **not** the `pg_database` row's own ACL, so
  `GRANT CONNECT` is re-issued per copy or RLS tests fail with "permission denied for database".

### 2. Gate receipt — never run an identical suite twice

`cleanroom-verify.sh` writes `.gate-receipt.json` (`{sha, result, at}`) on success. `release.ts` runs `tsc`
always, but runs the suite only when it cannot prove the same commit already passed. A missing, stale, or
unreadable receipt falls through to running it — the safe path is the default.

> **Superseded in part by ADR-0094 (2026-10-08).** `release.ts` no longer runs the suite at all: a
> missing, stale or non-PASS receipt now REFUSES the release, because the bare full-suite run it fell
> through to is the one command this machine cannot take. Receipts also carry a `tier` (`full` /
> `affected`).

### 3. Contention guard

`cleanroom-verify.sh` refuses to start when other client connections exist on the test instance, naming
them. A gate that an unrelated process can poison is not a gate.

### 4. Migration safety moves to where the bug lives

- **Per round — `scripts/shadow-migrate.sh`:** dump the live server schema (structure only; no rows, nothing
  personal leaves the box) *including* drizzle's bookkeeping table, restore to a scratch local database,
  apply only pending migrations, then **assert the applied count equals the journal length**. That assertion
  is the point: a silent skip exits 0 and is invisible without it.
- **Nightly — `scripts/fresh-migrate.sh`:** the old 0000→latest build from empty. It still guards new-tenant
  provisioning, which is a real guarantee, just not one that needs re-proving on every deploy.

### 5. Explicitly NOT decided: blast-radius test scoping

Running only the tests a change can reach was considered and deferred. Every round still runs the full
suite. Revisit only if round time regresses; it trades a real (if small) chance of a missed cross-module
regression for speed, and that trade is not worth making while the parallel suite is fast.

## Consequences

**Good.** Verification stops scaling with repo age. The full suite still runs on every round — this buys
speed by removing waste, not by testing less. The migration gate now exercises the transition that actually
breaks, and false REDs from ambient load are refused rather than debugged.

**Costs and risks.**
- `global-setup` rebuilds the template on every run (a few seconds) rather than caching on a journal hash. A
  stale template would hand workers the wrong schema and look like a code bug, so correctness wins until the
  cost justifies the cache.
- `shadow-migrate.sh` needs the demo server reachable. When it isn't, the round falls back to clean-room
  plus the journal-ordering unit test (`test/migration-journal-ordering.test.ts`), which catches ordering
  violations inside the repo but not divergence against the live watermark.
- Worker databases persist between runs. They are dropped and recreated at the start of each run, so a
  crashed run leaves disposable garbage, never a wrong result.

## What this does not change

Deployment. `deploy/deploy.sh` already runs drizzle's **incremental** migrator and skips the seed when demo
data is present — tester data has always been preserved. The "fresh database" in the old gate was a local
throwaway fixture and never touched the server. Partial per-module deployment was considered and rejected:
the app compiles to a single Next.js artifact, deploy is ~3 minutes of a ~45-minute round, and splitting it
into separately shippable services would cost far more than it saves at this size. The lever was
verification, not deployment.
