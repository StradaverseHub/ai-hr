# UAT installation and acceptance

Requirements recorded 12 October 2026: 1,000 synthetic employees and 200 concurrent testers. These are UAT targets, separate from larger production-growth planning. This procedure is not installation or capacity sign-off. Use [customer deployment](CUSTOMER.md), [embedded authentication](internal-auth/README.md) and [repository policy](../docs/REPOSITORY-AND-ENVIRONMENTS.md) for current implementation/authority. Keycloak activation instructions in the original proposal are superseded by ADR-0117.

## Preparation

1. Confirm target, region/provider, budget, origin/DNS, network, accountable installation/UAT/database/recovery owners and alert recipient. Record included mobile, email, AI and integrations. Single-instance UAT permits planned downtime; it is not high availability.
2. Size app, PostgreSQL, build and background work from measured usage. Verify pinned supported runtimes, private networks, TLS including edge-to-origin and phone trust, renewal, service accounts, root-owned executables, secret separation and bounded job resources. Never copy disposable development database settings.
3. Create separate app, migration, backup and maintenance identities. Protect configuration and authentication/encryption keys outside the database. Choose off-host retention and recovery objectives before loading records. Original proposals were RPO ≤24h/RTO ≤4h with nightly/pre-change backups and 14-day retention for synthetic UAT; real-data targets need explicit agreement and appropriate PITR/WAL recovery. Proposals are not measured guarantees.
4. Rehearse `scripts/backup-db.sh` and `scripts/restore-rehearsal.sh` against a separate protected target. Verify dump/manifest, schema, row counts, RLS/grants, ordered migration ledger and app-role access. Restore matching keys/configuration and measure recovery through working login/HR. Logical restore does not validate physical/PITR recovery.

## Installation sequence

Freeze a clean current candidate and its dependency/migration inputs. Coordinate the complete resource set and required tests, types, Linux build, migration and browser checks. Retain authentic source-bound evidence; a file in another worktree does not establish integration.

Build once for the actual Linux architecture/runtime and use the reviewed artifact/install path. Verify target configuration before any release command: default tooling may target existing staging. Preserve the previous working artifact and data recovery path. Apply migrations once with the owner identity; compare ordered ID/hash/timestamp tuples and watermark. Seed only required catalogs, never demo business data. `deploy-customer.sh --migrate-only` historically still builds/installs/catalog-seeds: inspect current behavior rather than treating its name as a SQL-only command.

Validate the effective service unit, ownership/cache paths and fail-closed startup. Do not restart an incomplete in-place build. Verify exact source/build arrival, migration ledger, restart/health and public origin separately.

Bootstrap an exact authorized administrator under the embedded-auth procedure, preserving IDs/grants on upgrades. Enroll MFA/recovery with the owner, validate invitation/reset and actual SMTP receipt, and prove demo and forged/expired/cross-organization access refusals. Enabling SMTP does not prove recovery receipt or authorize ordinary workflow mail. Keep categories/tester consent controlled.

## Required job run tracking and failure visibility

Install each enabled job exactly once with a supported runtime, private job-specific credentials and a supervised non-overlapping invocation. A host-local lock cannot prevent duplicates across hosts. Do not run cron and timers for the same job. Verify actual installed schedules/timezones, business effects, safe retry/interruption behavior, logs and alert receipt; do not assume all jobs are idempotent.

The owner requires operator-visible scheduled-job runs/failures through the existing Scheduled Actions/history owner. The acceptance contract includes:

- Stable job identity, purpose, enabled state, schedule/timezone and accountable owner; disabled differs from never-run.
- A run record before work starts, start/finish/duration, running/success/partial/failed/interrupted states and measurable counters. Preserve business outcomes when monitoring fails.
- Safe scoped failure detail and per-job bounded/paginated history. A frequent job must not hide monthly/annual history; old success cannot mask a later failed/missing execution.
- Missed schedules and stale contact distinct from completed failure. Confirm ownership before recovery; a heartbeat alone does not prove a process stopped.
- External availability/heartbeat monitoring, deduplicated failure/interruption/missed-run alerts and recovery notification to the named recipient, with tested delivery.
- Authorized manual retries with reasons and separate attempts; no web path exposing owner credentials. Restrict installation diagnostics, secrets and tenant HR details to their proper scopes.

Demonstrate normal, partial, caught/pre-start failure, killed, missed, disabled and concurrent runs; unavailable history/alert transport; authorization refusals; and per-job history under high-frequency load. Current code must be inspected for these capabilities: this checklist does not implement them.

## Functional and load acceptance

Use normal import/provisioning paths for 1,000 fictional employees, representative companies, managers, shifts, permissions, payroll/leave histories and attachment sizes. Prepare 200 distinct accounts and a second tenant/company for negative tests. Verify opening balances/expected totals before timing. Keep email destinations and external AI controlled.

Run actual role-based journeys, login/MFA/recovery, imports, approvals, attendance, payroll calculation/report/export and permission refusals. Exercise native reachability/TLS on real devices where in scope. Observe rendered pages and logs, not HTTP status alone.

Warm up, ramp to 200 concurrent testers, sustain representative mixed traffic and scheduled work, then observe recovery. Agree latency/error/throughput and resource thresholds before running; record p50/p95/p99, failures, DB/query/lock/pool behavior, memory/CPU/swap/disk, job completion and workload inputs. Fix measured bottlenecks and rerun affected scenarios plus final mixed acceptance. Do not claim capacity from isolated requests or hide unbounded queries by adding replicas.

Open UAT only with accountable acceptance, backups/restore, monitoring/alerts, access recovery, support/incident procedures and an agreed maintenance window. Record unresolved limits explicitly.

## Rollback

Stop new work, preserve failed evidence and coordinate the installation owner. A previous app artifact is safe only against a compatible schema. Restore database, keys and configuration together when needed; never undo applied SQL by editing history. Verify restored access, isolation, balances, jobs, source/build and health before reopening. Production remains a separate explicitly requested deployment.
