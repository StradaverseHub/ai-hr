# Fictional walkthrough migration prerequisites

## Confirmed failure

Unchanged source `50ea247177a9fe1373d3e79d9c742f0fc399ebb7` failed in walkthrough run 41382858043; control run 41381655480 failed at the same prerequisite. Both retained PostgreSQL server logs report `draft-discard: operator role prerequisite missing` from migration 0859. The client log's last migration notices are not the failing statement. The original migration phase ended after about six seconds, before its existing 300-second timeout. Both containers were healthy, with zero OOM events. The production builds succeeded. Original failure artifacts remain authoritative failures.

## Repair boundary

```text
fresh owned fictional database
  strict hosted walkthrough/source/controller/container admission
  existing reviewed role-catalog validator and minimal role graph
  repeat bootstrap; require identical catalog
  ordinary db:migrate (unchanged SQL and timeout)
  verify every applied migration hash and timestamp
  seed and exercise the actual production renderer
```

The bootstrap admits only the named GitHub-hosted Linux walkthrough job, its checked-out source/controller, repository dispatch envelope, exact loopback database URLs, exact evidence directory, run-owned pinned PostgreSQL 16 container and unchanged memory/JIT configuration. Admission completes before a database connection. It reuses the existing fixture's transaction, advisory lock, PostgreSQL/session validation, exact role attributes/memberships and refusal of partial or conflicting catalogs. Existing focused/full admission and ordinary migration behavior remain unchanged. No existing roles or memberships are repaired.

This is development infrastructure only. It changes no applied SQL, migration journal, package pins, build heap, staging configuration, provider approvals or release authority. The Entra visibility release candidate remains separate. A hosted walkthrough pass establishes fictional renderer evidence, not staging acceptance or release qualification.

## Verification plan

Run admission and existing renderer controller regressions on a standard hosted runner, then the unchanged production build and complete migration/seed/rendered journey at the frozen repair head. Separately run focused/full prerequisite regressions and whole-repository type checking on hosted Actions. Preserve terminal failures before further repairs; report each run's exact candidate/controller. No local tests, build or database reset.
