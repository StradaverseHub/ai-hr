# Personnel projections use an authorized database snapshot

Status: implemented candidate; acceptance tests pending. Production deployment is on hold.

## Decision and correctness contract

A standalone Personnel/Workforce projection owns a PostgreSQL REPEATABLE READ, READ ONLY transaction. The session bootstrap pins the snapshot before authority or row queries. Every permission predicate, effective organisation resolver and projected field uses that transaction. No permission grant or row result is reused across requests.

The read linearizes at snapshot admission. A permission revocation committed before admission must deny the next read. A read that overlaps an uncommitted change can finish using the preceding committed state. A revocation does not retroactively cancel an already admitted read or withdraw bytes already delivered to a browser. This deliberately replaces the former arbitration in which a queued reader waited behind a tenant writer before deciding permission. Tests must prove the new contract explicitly, including concurrent login revocation and field changes.

Standalone reads do not acquire the tenant Access advisory mutex. The database enforces read-only execution; callbacks cannot quietly become writers. Borrowed command transactions retain the exclusive Access barrier and actual-principal check. Commands still reauthorize when executing and retain native write/policy locks. This decision does not remove policy, payroll, audit or entity-write serialization.

Private search creates an actor-bound token and therefore retains a separate bounded READ COMMITTED write transaction. The native insert trigger validates current principal, scope, permissions and exact source revisions. Consumption repeats the native permission/revision checks; the token is not a grant. Its per-actor pruning lock remains. No tenant Access read mutex is required. Concurrent source revision changes can reject token creation rather than publish an incorrect match set.

## Availability contract

Ordinary tenant writes cannot produce a Personnel page Busy response by denying read admission. Remove the corresponding page and HTTP Busy protocol with the obsolete admission/retry path. Keep the existing 20-second statement ceiling and any tighter caller ceiling. Database errors propagate as failures, never an empty successful list or a misleading Busy page. Removing that protocol is not proof of sufficient throughput: production-rendered preflight and mixed-workload tests must reject failed pages, timeouts, stale grants and excessive latency, as well as Busy responses.

This change does not promise unlimited capacity, remove expensive queries, or make the entire application lock-free. Private search projection cost, other module locks, pool admission and long exports need independent measurement. Separate snapshots across independent UI components are independently authorized; components that require a single version must share one projection transaction.

## Verification and rollout

Required evidence: real PostgreSQL reads complete while an exclusive tenant writer is held; new reads deny a committed revocation; an admitted read never mixes old permission with newly committed fields; standalone callbacks cannot write; borrowed commands retain their exclusive barrier; tenant/company/private-search isolation regressions pass. Then a production build and strict browser preflight must pass before rerunning load against the same candidate. A 200 response alone is not acceptance.

Keep deployment on hold. The combined candidate also includes the separate notification processing-ledger migration; its populated upgrade, rollback and duplicate-delivery evidence is required independently. No production data or production resources are used by these hosted development checks.
