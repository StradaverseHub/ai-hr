# Local resource admission

A real circular wait was observed on 25 October 2026 after Board 3's complete verification ended. Two unrelated outer testlock wrappers each acquired one of the two memory slots; each then launched an inner wrapper waiting for the other slot. Neither job had started its intended test/measurement command. Board 3 retained ownership of permission to cancel those idle waiters. This change does not signal them or modify the running shared lock scripts.

## Complete requests

`scripts/local-resource-lock.py` reserves the entire requested set before starting the command. It can request zero, one or both of the existing two memory slots, plus the one shared database slot. It never raises capacity above those existing limits. While any required member is unavailable, it holds none of them. A local advisory admission lock serializes reservation attempts; it is not held while waiting or running the job.

For an exclusive gate that rebuilds the shared test cluster:

```bash
python3 scripts/local-resource-lock.py --test-slots 2 --database final-gate -- bash scripts/gate.sh --full BASE
```

For a focused isolated-worker check that does not rebuild or seed the shared cluster:

```bash
python3 scripts/local-resource-lock.py --test-slots 1 focused-check -- pnpm exec vitest run test/CHANGED.test.ts
```

The command inherits `AIHR_LOCK_DIR` for the selected state root. Both memory-slot directories carry the launcher PID, so the existing gate helper recognizes both ancestor leases and does not acquire another nested slot. Request the full set at the outer boundary; do not wrap this launcher in another slot holder or add `devdb-lock.sh` inside it. A detected ancestor lease refuses promptly instead of upgrading while holding resources. Database rebuild/seed/render jobs must request the shared database slot across their entire lifetime.

## Ownership and cancellation

Existing legacy slot directories block admission and are preserved, including incomplete metadata or apparently dead owners. Extra legacy reservations outside the fixed capacity (for example `locks/slot.3` or `devdb-locks/slot.2`) also block admission without acquiring any new leases. An environment override used by another caller does not increase this launcher’s resource budget. This tool never automatically reaps them, kills another job or deletes foreign files. Unknown ownership requires the coordinating owner's existing recovery procedure.

Each new reservation has a private token and directory identity. PID publication is atomic, avoiding the empty-file window in legacy stale-owner checks. Cleanup verifies ownership and uses individual unlink/rmdir operations. A changed token/PID or unexpected directory content refuses cleanup and cannot become a successful result.

The spawned command runs in its own process group. Cancellation is forwarded to that owned group; leases remain held during its cleanup grace period. Nonzero exits propagate. A command leaving live children in that group triggers cleanup and refuses a successful result. Jobs remain responsible for shutting down detached daemons they create, such as their owned PostgreSQL server, before returning. This launcher never stops a foreign database.

## Validation and adoption

The subprocess tests use only private temporary state roots and tiny owned fixture processes. They cover competing exclusive requests, allowed single-slot overlap, database contention while holding no memory slots, preserved legacy/unknown leases, rejected nested upgrades, exit-code propagation, cancellation through cleanup, changed ownership, nonexistent commands, symlink refusal and recognition by the actual gate helper. They run no application tests, builds or databases.

This is prepared in the isolated performance branch. It is not installed in the shared runtime or enabled in Board 3's frozen release. It cannot resolve a cycle between already-running legacy nested wrappers. After the release owner hands back resources, migrate outer entry points to complete requests and validate their real integration before replacing shared host scripts. Preserve all active/queued ownership during that handoff; do not silently substitute this tool into another chat's frozen command.

The admission fix removes a demonstrated queue failure. It does not establish a ten-minute release or guarantee fairness against an unlimited stream of legacy callers; queue and execution time still count toward the performance target.
