# Original18 acceptance browser coordinator

Source-only infrastructure; no acceptance outcome follows from preparing or stopping a server.
Parent owns provisioning, semantic checks, actual application journeys and release.

Run from the candidate's own root with its private local environment, after parent provisions real
`node_modules` and a regular owned `.env.local` with mode0600. The runner never installs dependencies,
copies credentials, takes an arbitrary target override, resets a database or retries setup.

```sh
node --env-file=.env.local --import tsx scripts/dev-browser-original18.mjs --scenario=schedules
```

The entry acquires both test slots and the shared dev DB lock itself. Do not add an outer lock wrapper.
The held worker proves all three named holders are live ancestors, then requires a clean exact HEAD.
Every setup child and the Next server has its own tracked process group. Logs and receipts are bound
to that candidate and a unique run ID. The lifetime is45minutes from held-worker startup, including
setup. Touch `browser.stop` in the selected scratchpad to stop. Signals request the same owned cleanup;
other PIDs/ports are never killed. Locks are released only after owned groups disappear and DB handles
close. Cleanup failure cannot publish a successful stop receipt.

| Scenario | Database | Port | Namespace | Scratchpad |
| --- | --- | --- | --- | --- |
| schedules | ai_hr_board15schedules_browser |3192| board15schedules | scratchpad/board18-browser-schedules |
| holidays | ai_hr_board15holiday_browser |3193| board15holidays | scratchpad/board18-browser-holidays |
| approval | ai_hr_board15_approval_browser |3195| board15approval | scratchpad/board18-browser-approval |
| inquiry | ai_hr_board15_inquiry_browser |3196| board15inquiry | scratchpad/board18-browser-inquiry |
| personnel | ai_hr_board15_personnel_browser |3203| board15personnelregisters | scratchpad/board15-personnel-registers |

Only plain local5433 PostgreSQL URLs are retargeted. The application must actually be `ai_hr_app`,
NOSUPER/NOBYPASS, without owner/schema/membership privileges; migration credentials must be distinct
and have full visibility to prove absence. A filtered empty query is insufficient. The fixtures'
existing named-DB guards remain unchanged. Their URL targets match the allocation; these four legacy
fixtures do not impose a different namespace guard.

New preparation is permitted only for the first four scenarios. Any earlier attempt/manifest/PID
receipt or any existing user relation refuses preparation. On the pristine target the runner applies
the current journal, confirms only the exact reserved System tenant and no business population, then
seeds once. It runs the exact existing fixture twice under per-child watchdogs, requiring exit0 without
cancellation and identical declared business facts. Only `reused` and holiday sweep diagnostics are
excluded from that comparison; business records/configuration/IDs are retained. A KL date rollover
refuses the clean-twice claim. Exact Demo/System names, declared company IDs/labels/names, principal
person/employment bindings and grants are checked before startup. No authority is repaired by the runner.
A partial attempt remains preserved and blocks setup rather than guessing a safe reset.

For a prepared journey use explicit `--resume` with the same scenario. It requires original fixture and
browser receipts, the latest owned stop, a bounded recursive resume chain with no orphaned newer run,
a matching prior PID file, both prior PID and process group absent, and a free port. Candidate commits
must exist and have unchanged `db/migrations` (including SQL/journal), `db/schema.ts` and `packs/catalog.ts`
relative to preparation and the previous run. Resume checks live role/tenant/principal bindings and
runs zero migrations, seeds or fixtures. Original manifests are never rewritten to claim clean-twice
preparation for a later candidate. Prior cleanup bytes, unique logs and each new truthful stop are
preserved; the latest stop pointer is published atomically only after cleanup, with a stopped/failed
outcome rather than PASS.

Personnel is resume-only, intended after merging this source into the original prepared worktree.
The exact reviewed preparation is299ccd2d6891de62149f5205cac81522b1076dea; its original fixture/browser
receipt bytes and historical runner source are pinned. Its old stop had exactly candidate/database/
port/ownedServerStopped/stoppedAt, stopped2026-10-16T06:47:37.642Z and PID85618. The adapter accepts only
that specific old shape and separately proves live absence/free port and current identities; it does
not add fictional historical cleanup fields. The old stop survives inside new resume provenance.
Current Grade/Qualification UI changes are not compared to original business values and are never
reseeded or overwritten. New stops use the stronger current schema. Example:

```sh
node --env-file=.env.local --import tsx scripts/dev-browser-original18.mjs --scenario=personnel --resume
```

Required evidence remains: parent focused selector/receipt tests and full types, pristine migration/
seed/twice-fixture execution for each new target, occupied-port/role/unknown-tenant refusals, real
stop/watchdog/failed-stop and resumed-chain cleanup, preserved Personnel identities/changed records,
actual browser outcomes and runtime logs. Node syntax parsing alone establishes none of those claims.
