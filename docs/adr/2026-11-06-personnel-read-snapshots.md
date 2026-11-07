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

## Shared employee navigation choices

The opt-in `readEmployeeChoices` port serves Attendance and Payroll rails without
shipping the entire employee population to the browser. It retains the legacy
valid-to-NULL, not-superseded assignment population and ordinary table RLS, including
employee and manager actors. It is not the HR-only Workforce projection. Trusted
empty company scope keeps the legacy RLS-only meaning; clients cannot post scope.
The native principal, company narrowing, minimal rows, selected employment, total
and organisation options share one enforced read-only snapshot. Selection is
authorized independently of search/page filters so deep links remain reachable.
Label descriptions require the same current administrator prerequisite as Payroll;
Attendance retains its original name/code choice labels. Consumers still authorize
their own module and detail/command purpose.

Blank searches use native count and page limits. Nonempty searches retain exact
ECMAScript trim/lower/includes matching: ASCII SQL candidates plus all non-ASCII
name/code candidates are streamed in 512-row cursor batches and checked by the
canonical JavaScript operation. The page retains only its requested rows and exact
total; there is no population or match-ID ceiling. With no organisation filter,
search streams only authorized name/code identities and projects assignment labels
for the retained page in the same snapshot. The immediate native no-overlap
constraint preserves the legacy joined-row cardinality. Distinct organisation options
remain complete rather than silently clipped. Represented company, department and
business-unit options use native catalogue existence reads, rather than a DISTINCT
employee-population join. Current-assignment reads retain an indexed lateral
subquery boundary: native RLS selectivity can otherwise underestimate assignments
and choose a quadratic materialized join. No assignment is clipped. Blank pages
share their exact window count with the same native population walk; an empty or
out-of-range page obtains its exact count independently. The Unicode search fallback bounds resident
employee DTOs, not total scan work; Unicode-heavy search cost must be measured.

The side-effect-free, same-origin POST transport keeps new raw search text out of
URLs and access logs. Only the existing explicit `preservePicker` URL contract
persists picker input. Debouncing, request abort and response identity checks avoid
stale answers; executing database work finishes before its transaction rolls back
or releases admission. Failures show retry, never a false empty population.
Legacy local picker consumers and full batch/export populations stay unchanged
until their owning pages explicitly adopt the bounded port.
