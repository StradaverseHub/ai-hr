# ADR-0181 — Zero-downtime web releases

Status: accepted by the owner on 15 November 2026 (decisions 1–3 below). Implementation: `deploy/zero-downtime/`, `scripts/releases/migration-release-mode.mjs`, `lib/next-deployment-identity.ts`. Not yet installed on staging or production; see *Rollout*.

## Context

Every production update so far stopped the web service. The recorded windows were about two minutes (28 October), 14 seconds (29 October) and 214 seconds (14 November, `prod-2026-11-14.1`). On 14 November the 13 migrations took 2.3 seconds. The rest of the window was the stopped-service backup, data verification, an in-place `rsync` over `/opt/ai-hr` and a cold start. The service had to be stopped because:

1. the code was replaced in place, so old and new could not run side by side;
2. one `next start` on one port meant no second process could take traffic first;
3. the database backup was made *lossless* by guaranteeing nothing wrote after it, so code rollback and database restore were interchangeable;
4. nothing established whether the old code could keep running on the new schema.

## Decisions (owner, 15 November 2026)

1. **Rollback is a code rollback, then fix forward.** A zero-downtime release keeps its migrations compatible with the previous release's code. Rollback moves traffic back to the retained previous release in seconds. The database is not restored in place after users have written to it. Backups and WAL archiving remain for disaster recovery.
2. **A release whose migrations break the running code may take an announced window.** It uses the existing stopped-service runbook. Expand/contract splitting is encouraged but not mandatory.
3. **Web first, worker next.** This ADR removes web downtime. The bulk-job worker drain (about 16 minutes on 14 November, during which queued jobs waited but the web stayed up) is a follow-up.

## Design

### Two slots behind Nginx

- Each release is extracted once into its own immutable directory, `/opt/aihr-web/releases/<BUILD_ID>`.
- Two systemd instances of `aihr-web@.service`, `blue` (port 3101) and `green` (port 3102), run whichever release their `slots/<slot>` symlink names. The unit is the customer unit with the same hardening, credential exclusions and environment check; a test keeps the two aligned.
- Nginx proxies to `upstream aihr_web`, defined in one file that only `release-web.sh` writes.
- A switch:
  1. rewrites the upstream file;
  2. runs `nginx -t`;
  3. runs `nginx -s reload`. New workers take new connections and old workers finish their in-flight requests.
- The controller then verifies through Nginx that rendered pages name the new build. After a drain period it stops the old slot with SIGTERM, which Next answers by finishing in-flight requests.
- Only the active slot is enabled, so a reboot brings back the slot Nginx points at.

### Database: classified, bounded, online

`migration-release-mode.mjs` compares the running release's migration journal with the candidate's and classifies the pending statements.

**Blocking (the release takes a window):**
- removing, renaming or retyping something on an existing object;
- `SET NOT NULL`;
- a `NOT NULL` column without a default;
- table rewrites;
- validated constraints over existing columns.

**Online:**
- new tables;
- additive columns;
- NULL-safe constraints on new columns;
- rename-and-wrap of functions;
- CHECK lists that only widen the running release's own definition.

A reviewed exception is recorded either as a `-- zero-downtime: compatible -- <reason>` annotation, or (for migrations already applied on staging, whose bytes are immutable) in a release acceptance file. That file must match each finding exactly.

Calibrated on the 13 consecutive pairs of past production releases: 9 would have been online, including every release since 12 November. The four that need a window were the large batches of 11–121 migrations.

`migrate-online.sh` ships inside the release and runs deploy.sh's database sequence while the previous release serves. Rules:
- It refuses unless the classifier says `online`.
- The migration connection carries `lock_timeout` (default 3 s). An `ALTER` that waits behind a long reader fails its whole transaction instead of queueing every later query on that table, and is retried with backoff.
- Post-migration steps are idempotent. A failure there is repaired forward while the previous release keeps serving.

**Backups.** The pre-release backup is taken online, before the migration, and must finish first. `pg_dump` holds `ACCESS SHARE` on every table it dumps, so a concurrent migration would fail its lock wait and retry.

Because of decision 1, that backup is a disaster-recovery point, no longer the rollback mechanism. Restoring it would discard writes made after it. Point-in-time recovery from WAL archiving is the disaster path.

### Browsers holding the previous build

`next.config.ts` sets `deploymentId` equal to the BUILD_ID, chosen per build. This keeps the BUILD_ID unique per build, which staging acceptance and production packages pin. `next start` reads the id back from the build it serves, via `routes-manifest.json`. Next then reloads instead of client-navigating when a response comes from another build.

Nginx serves `/_next/static/` from the union of every kept release's static files, falling back to the active slot. A tab opened before a switch can still lazy-load the old build's chunks after the old process has stopped.

### Unchanged in this phase

- `/opt/ai-hr` stays for timers, cron and the bulk-job worker. It is updated after the switch with the timers paused, as today.
- The worker keeps its reviewed drain/activate procedure (decision 3).
- Maintenance releases keep the stopped-service runbook.
- Staging and its publisher still use the in-place layout until they are adopted.

## Evidence

`.github/workflows/zero-downtime-rehearsal.yml` runs on GitHub-hosted runners and touches no staging or production host:

- **Mechanism:** real systemd and Nginx, the real controller and unit, stand-in releases. A continuous probe runs through adopt → switch → refused breaking release → rollback → switch. It must record zero failed requests and see both builds, and its long requests in flight across the switches must complete.
- **Lock bound:** real PostgreSQL. A migration behind a 40-second reader must fail within the bound and apply afterwards.
- **Skew:** a real `pnpm build` must record `deploymentId === BUILD_ID`, and `next start` must serve it, even with a stray inherited `NEXT_DEPLOYMENT_ID`.

Gate tests: `test/zero-downtime-*.test.ts`.

## Rollout

Each step is separately authorized. Staging acceptance precedes production, and package publication grants no deployment authority.

1. Rehearsal workflow green on the branch; merge through the normal gate.
2. Rehearse adoption and one online release on an isolated production-shaped target (populated copy, production Nginx site), with the probe running.
3. Adopt on staging. This needs the publisher (`approve_staging.py`) to capture from `/opt/aihr-web/current` and to check `aihr-web@<active>` instead of `aihr`. That is a reviewed change of its own.
4. Production adoption (`release-web.sh adopt 3000`) on explicit owner permission, then the first online release.

## Limits

- **Compatibility is classified, not proven.** A finding accepted by a reviewer, or a data step that changes meaning for old code, can still break the previous release. The populated upgrade rehearsal remains required.
- **Requests longer than the drain period** (default 45 s) are cut when the old slot stops. Long work belongs on the bulk-job kernel (scale rule 4).
- **Keep-alive connections** held by old Nginx workers close after their current response. Browsers retry idempotent requests on such a close; the probe measures this and does not retry.
- **Rollback after a migration** runs the previous code on the new schema. That is exactly what the classifier protects, and it is no longer protected once a reviewer accepts a finding.
