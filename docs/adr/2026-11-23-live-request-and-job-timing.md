# Live request and job timing

Status: proposed, 23 November 2026.

## Context

The owner asked whether to rewrite the application in Rust, or only the parts that take more than a second. Nobody
could say which parts those are: the existing performance tooling (`scripts/performance/`, hosted diagnostics) measures
chosen journeys on fictional fixtures in CI, and installations record no request timing. A rewrite decision needs the
list, and it needs to know whether the time is spent in the database, waiting for a connection, or in our own code,
because only the last can be helped by a faster language.

## Decision

1. The web process times every user request (page load, navigation, server action, API call) through Node's HTTP
   diagnostics channels, installed from `instrumentation.ts`. No per-route wrappers.
2. Each request's wall time is split into database, waiting-for-database and app time using the existing optional
   timing hooks in `db/client.ts` and `db/background-read-admission.ts`, chained so isolated-run observers keep working.
3. Output is identity-free log lines: a line per request at or over one second and a bucketed per-route summary every
   five minutes. No database writes from the web process and no new table or migration.
4. Background jobs record time to first claim (`queuedMs`) and cumulative working time (`workMs`, `units`) on the
   existing `bulk_job.metrics`.
5. `scripts/performance/slow-work-report.mjs` turns the logs and job aggregates into a ranked report with a likely
   cause per row.
6. Timing is on by default and can be switched off with `AIHR_TIMING=off`.

## Consequences

- Slow work can be listed from real use on any installation without new infrastructure.
- The report can only see requests that reach the web process; time spent in the browser (downloading, hydrating) is
  not measured yet. A browser-side measure is a later, separate change.
- Database time is an upper bound (it includes code run inside a transaction). When a row points at app code, a
  targeted profile of that route is the next step before any rewrite.
