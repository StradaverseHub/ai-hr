# Scale and release rules

These rules come from defects found while shipping the combined optimisation release (10–11 Nov 2026). Each one
reached staging or a release gate before it was caught. Follow them for any change to request paths, database code,
migrations, tests or deployment.

The owner's bar: the product is for millions of users. There are no timeouts, Busy responses or error pages under
load, and one bulk operation never slows other work. A timeout or admission limit is acceptable only as an invisible
last-resort guard with automatic retry.

## Request paths and the database

1. **A read never takes the exclusive Access lock.** Pages, GET routes, reports, exports, renderers and the shell
   (notification bell, approval facts) use the shared mode (`lockAccessConfigurationReadTx`, `app.access_workforce_write_lock()`).
   Only access-configuration editors take exclusive, and no exclusive hold may exceed about 1 s.
   The shell's bell took exclusive on every signed-in page and froze the tenant for about 45 s after a restart.
   See `test/access-lock-rewards-view-shared.test.ts` and docs/adr for the reader/writer Access lock.
2. **No per-company or per-employee loops in a request.** "All companies" means 70 or more companies and thousands of
   people. Resolve subjects, visibility and status as one set-based statement per concern, and page and count in SQL.
   Never load every row and page in memory. Three such loops reached staging: the AI Centre payroll cycle page ran
   about 20 statements per company and held 6 of 7 pool connections for an hour; Personnel search ran a mapping
   function per row; the Approvals claim queue ran a SECURITY DEFINER subject function per claim.
3. **Test reads at the shape of a real group.** A read-path change needs a fixture with at least 70 companies and
   1,000 employments, run under "All companies" and under one company, and an equivalence test against the previous
   reader (same rows, same order, same counts, every role).
4. **Long or bulk work runs on the bulk-job kernel**, not in the web request (`core/bulk-job*.ts`,
   deploy/systemd/EMPLOYEE-IMPORT.md). The worker (`aihr-bank-import.service`) must be running for those jobs to finish;
   set `AIHR_IMPORT_WORKER_REQUIRED=1` wherever it is installed so a deploy fails without it.
5. **Admission and pooling.** Web transactions keep all tenant settings transaction-local (PgBouncer runs in
   transaction mode). Every non-web process (timers, cron jobs, workers) sets `AIHR_DB_PROCESS_ROLE=worker` so it
   connects directly, with `AIHR_DB_POOL_MAX` at most 8 (cron: set it in the crontab, deploy/DEPLOY.md). Measured on 4-vCPU runners: about one web worker per 2 vCPU and a shared pool of about
   16 connections; more workers added stalls, not throughput (8 workers ran out of memory on `/assistant`).
6. **Row-secured reads run with PostgreSQL JIT off.** JIT compilation cost 1.3 s on an audit count that runs in 11 ms,
   680 ms on every Approvals leave list and 18.8 s on one Home statement. Web and worker tenant transactions set
   `jit=off` transaction-locally in their setup (`db/client.ts`); never re-enable it in a request path.
7. **Server module graphs stay free of UI libraries.** Code loaded under `--conditions=react-server` (email sweep,
   probation runtime, payroll service, workers) must not import client UI packages such as lucide-react. Keep shared
   constants in dependency-free modules (`lib/leave-visual-keys.ts`). `test/react-server-entry-graphs.test.ts` guards it.

## Migrations

8. **Migrations must apply as the restricted `ai_hr_owner`, not as a superuser.** CI applies migrations as a superuser
   and hid a staging failure. `test/restricted-owner-release-upgrade.test.ts` applies every migration above main as the
   literal `ai_hr_owner` with production ownership. Keep it green.
9. **Never replace or alter an object owned by a purpose role** (for example `ai_hr_reward_setup_reader`,
   `ai_hr_reward_upload_reader`). The migration owner is NOCREATEROLE and cannot become them. Rely on row security, or
   restructure so the object does not need replacing. This includes statements built at run time in loops.
10. **A new column on a populated table** must be nullable or defaulted, and the populated upgrade tests must prove it
   is present and null (see `test/helpers/approved-upgrade.ts` and `test/helpers/prefix-seed.ts`). Upgrade fixtures
   seed only the columns that exist at their prefix.
11. **A new migration's journal `when` must be above every installation's applied watermark.** Drizzle silently skips
    an entry whose `when` is below the last applied one, so a migration numbered into a gap below an already-installed
    one never runs there. Check staging's and production's ledger maximum before allocating.
12. **Diagnosing on staging:** as `ai_hr_owner`, `pg_stat_activity` shows application rows as
    "&lt;insufficient privilege&gt;" with NULL state, so a `state<>'idle'` filter hides them. Use `ps` (backend state
    and CPU) and `pg_locks` instead.

## The v17 release gate

13. **Every `test/**/*.test.ts` and `*.dom.test.tsx` file runs in the gate, and a skipped test fails `verify`.** Never use
    `skipIf`, `skip` or `todo` for hosted-only measurements. Name them `*.hosted-diagnostic.ts`
    (see `test/performance/HOSTED-DIAGNOSTICS.md`).
14. **Unit artifacts are flat JSON.** The operator extractor refuses subfolders and binary files under
    `$RUNNER_TEMP/aihr-ci`. Write extra evidence bundles beside it.
15. **Give slow cases headroom.** A case that runs 15 s or more needs an explicit timeout of about 3× its worst gate
    duration, with a comment naming the measurement. The global limit is 30 s.
16. **Do not edit files pinned by `.github/ci/*.test.mjs`** (for example `test/r395-org.ts`). Put new setup in a
    new helper.
17. **Focused runs:** dispatch `alpha-focused-checks.yml` from main. A job is cancelled at 20 minutes, so keep each run to
    about 25 database files. Runs on the same `candidate_ref` queue, and a newer pending run cancels the older one.
    Use alias branches for parallel runs, and never push to a branch with a run pending. The split typecheck
    (test files included) only runs when dispatched from the candidate branch itself.
18. **Never `gh run rerun` a gate.** A database-unit failure needs a fresh full gate; only no-database failures can use
    focused recovery.

## AI approvals

19. Any change to covered AI source (check `node scripts/ai-provider-data-source-manifest.mjs --check --list`) needs
    both manifests regenerated and the provider approvals re-bound in `lib/ai/provider-data-approvals.ts`. Only the
    release coordinator re-binds, under a recorded owner approval, with a dated note in
    `docs/reviews/ai-functions-board-source-binding-2026-11.md`.

## Staging

20. Follow docs/STAGING-RELEASE-QUEUE.md. The staging box is small (2 CPUs, 3.9 GB). Staging runs PgBouncer
    (`DATABASE_POOLED_URL`) and the bulk-job worker. A worker that predates managed install receipts is taken over with
    the reviewed `adopt-stopped` mode of `bank_import_worker_upgrade_v1.py` (deploy/systemd/BANK-IMPORT.md).
