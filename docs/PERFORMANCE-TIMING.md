# Finding slow screens, actions and jobs

Goal: a measured list of everything that takes a second or more, with where the time goes, before deciding how to
make any of it faster. Owner request 23 November 2026 ("measure first", screens and actions such as processing payroll
and reprocessing the tax calculation). Decision record: [ADR](adr/2026-11-23-live-request-and-job-timing.md).

## What is measured

| What | Where it is recorded | Source |
|---|---|---|
| Screens: full page loads and in-app navigations | web log, `[aihr-timing]` lines | `lib/request-timing.ts` |
| Actions: every button or form that calls a server action, named `file#export` | web log | same |
| API calls and downloads | web log | same |
| Background jobs (payroll processing and reprocessing, tax basis groups, draft tax readiness, imports, leave and attendance recalculation) | `bulk_job.created_at`, `finished_at` and `metrics` (`queuedMs`, `workMs`, `units`, plus the existing chunk metrics) | `core/bulk-job-worker.ts`, `lib/bulk-job-timing.ts` |

For each request the total is split into three parts that add up to it: **database** (at least one transaction held),
**waiting for a database slot** (admission wait while nothing is held) and **app code** (rendering, application code,
streaming). Database time includes the application code that runs between statements inside a transaction, so it is an
upper bound on Postgres time. Prefetches, static files and `/health` are not counted.

A payroll processing or reprocessing request returns quickly and hands the work to a job, so the person's real wait
is the job's total time (creation to finish), which the report shows separately from the button's own request time.

## Privacy and cost

Only closed labels are written: route shapes with ids, numbers, dates and tokens replaced, no query strings, action
names from the build manifest, job kinds, status codes and durations. No tenant, user, person, header value, SQL text
or business value is read or written. The cost is a few clock reads per request; nothing is written to the database
by the web process. A line is logged for each request at or over the threshold, plus one summary line per route seen
every five minutes.

Switches (web process environment): `AIHR_TIMING=off`, `AIHR_TIMING_SLOW_MS` (default 1000),
`AIHR_TIMING_WINDOW_S` (default 300).

## Producing the report

On an installation, as the operator (see [operator access](../deploy/OPERATOR-ACCESS.md)); the web unit is `aihr` on
staging:

```sh
journalctl -u aihr --since "7 days ago" -o cat | node scripts/performance/slow-work-report.mjs > slow-work.md
```

Add background jobs by giving the script a read-only owner connection (it opens a `read only` transaction and reads
only aggregates of `bulk_job`):

```sh
JOBS_DATABASE_URL=... node scripts/performance/slow-work-report.mjs --logs web.log --jobs-since "14 days"
```

Jobs finished before this change have totals but no `queuedMs`/`workMs`; the report says "not recorded yet".

## Reading it

Each slow row carries a likely cause from its time split:

- mostly **database**: query count, indexes, row-security plans or JIT (see
  [scale and release rules](SCALE-AND-RELEASE-RULES.md)). A faster language does not change this.
- mostly **waiting for a database slot**: capacity, or another job holding connections.
- mostly **app code**: profile that one route or action. Only here can caching or moving a hot loop to Rust (for
  example with rust-anything's single-function mode) help.

Measure on real use or a populated fictional fixture: an empty tenant hides the slow paths. Numbers from one
installation are evidence for that installation and period only.
