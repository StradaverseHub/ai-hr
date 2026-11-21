# Architecture contract for subsequent builds

The foundation remains the existing modular application, PostgreSQL fact owners, pack service interfaces and separately budgeted workers. ADR-0080 owns pack boundaries. The Personnel snapshot, notification receipt, database admission and restore-authority ADRs refine specific boundaries; they do not replace payroll, employment, approval or access rules.

## Before implementing a module or changing a contract

Name each fact's owner and its public service. Keep person, user, employment, tenant and company separate. Record effective dates, allowed state transitions, actors, scoped capabilities, field disclosure, audit events and failure outcomes. Use the current native owner from web, mobile, imports, workers and AI. A facade is an interface, not authority to bypass the owner's checks.

Every registered business module must appear in `module-contracts.json` with its real service path, import-boundary test and behavioral proofs. `test/module-architecture-contracts.test.ts` checks registry coverage and duplicate declared table ownership. It does not establish that declarations describe every SQL write or that tests passed. The named behavioral suites and all affected owner tests remain required in hosted verification. Existing import debt can only shrink; new exceptions are not an implementation technique.

A command owns its protected current authorization, state transition, domain changes, audit and required delivery intent in one transaction. Internal composition passes the existing transaction explicitly. External I/O and long computation do not belong under a business lock. A successful response means a durable accepted outcome; a lost response requires receipt/state reconciliation. Retry identities bind tenant, actor, intent and payload. Never turn a timeout into an empty successful read or silently replay an uncertain external effect.

A query declares allowed fields, scope, ordering, bounded rows, exact-count semantics, maximum representative cost and its authorization linearization point. Filter before costly detail projection. Count/facet contracts must agree with the displayed population. A permission change committed before Personnel snapshot admission affects that read; an admitted coherent snapshot may finish. Command authorization retains the protected write boundary. Do not copy the read protocol into writes.

Work enters the common pool admission owner before checkout. Classify heavy units explicitly; keep aggregate web/worker/maintenance demand within the database budget. Cancellation removes abandoned queued reads. Durable imports retain checkpoints on capacity deferral. A new queue must name its active, pending, attempt and time bounds, fairness, cancellation, failure and recovery behavior. A page-level Busy fallback is not an accepted capacity control.

Existing-draft saves and standalone discards use the pool-owned tenant-write admission owner: one active scheduled command per tenant, at most half the pool size across tenants (minimum one), at most 2,048 waiting divided by declared workers, and 30 seconds waiting. It keeps per-tenant FIFO and the common least-active-tenant fairness. Optional cancellation removes only unstarted work; admitted commands finish under native authority and locks. Admission refusal starts no transaction. There is one command invocation and no automatic uncertain-outcome replay; the existing discard-only known-lock retry remains separately bounded. Failure releases admission so later commands can recover. Waiting holds no connection. Creation retains its existing direct physical-pool admission and native database locks. Caller-owned transactions bypass this outer scheduler and retain their existing composition and database ordering.

Passive read operations that fan out use `withBackgroundReadWork` before opening any transaction. This bounds whole logical reads without holding a connection while they wait. Their children still use the physical pool gate, whose background pending allowance preserves room for interactive work. Await all children before returning. Same-tenant nested composition shares the logical admission, and each child retains its native authorization and transaction. An owned Home response carries its cancellation through nested readers. Cancellation prevents later checkouts and does not revoke an executing transaction or replay an uncertain command.

## Structural changes and read models

Fix a table, relation, index or model when actual plans or correctness evidence
show a structural cause. First name the authoritative business fact, every writer
(web, import, worker, pack and native SQL), effective-date rules and the existing
permission owner. Preserve internal IDs and history. A presentation requirement
must not redefine employment, organisation, payroll or access truth.

Treat each independently owned nullable field as its own state contract. For
example, settling a notifications cursor must preserve an unrelated assessment
cursor, including NULL. Initializing an unrelated field to zero is a business
state change unless its owner explicitly defines that equivalence.

Authorize and narrow the native population before costly detail projection.
Bounded pages do not permit full-list client filtering. Counts, represented
facets and independent selected-item hydration may have different populations;
state those contracts explicitly instead of narrowing one to make another fast.
Review native RLS plans as well as the visible SQL: a precise-looking predicate
can still execute tens of thousands of correlated index probes. Compare complete
native calls on the same backend, data, statistics, resources and settings, with
actual rows, loops, rows removed, buffers, spills, planning and JIT time. Include
dense, sparse, empty and forbidden scopes. A better query shape or complexity
bound is not a latency pass.

An index must match the actual tenant/scope/effective-state predicate and ordering;
verify its write cost and selectivity before allocating it. Do not weaken a
constraint, erase NULL state, increase timeouts or lift memory limits to obtain a
passing fixture. A planning setting is a separately measured execution policy:
keep it local to its proven purpose, preserve security and resource bounds, and
prove restoration and isolation from concurrently composed readers. Never hide a
changed planning policy in an otherwise identical comparison.

Use a read projection when repeated joins are the demonstrated bottleneck and its
maintenance has a clear owner. Declare the source facts, minimal disclosed fields,
unique identity, tenant/company isolation, freshness contract and repair protocol.
For immediate-truth screens, every canonical writer must update the projection
atomically or readers must verify the source revision; an unchecked asynchronous
copy is insufficient. Delayed projections need a documented watermark and visible
freshness semantics appropriate to the feature. Financial and permission decisions
continue to use their authoritative current owners. A projection is not a new grant.

Append guarded migrations after inspecting the current global allocation and
watermarks. Review all writers, new RLS and grants, populated backfill, duplicate
and orphan handling, interruption, rerun and rollback limits. Rehearse the complete
populated prefix with exact SQL hashes and an adversarial predecessor refusal;
verify facts, constraints, privileges and history before and after. Shipping source
or applying a migration does not establish a valid backfill or an installed ready
projection. Startup and release admission must verify required schema/read-model
versions before admitting traffic.

## Reference workflow proofs

Attendance approval uses the Attendance service from the Approvals adapter. The workflow owner still enforces current stage/participant, delegated authority, rejection reasons, no self-approval and final-effect uniqueness. Corrected punches and deferred overtime preserve their original semantics. `attendance-workflow-v4-owner`, `attendance-workflow`, `attendance-pack` and the actual browser correction/approval/punch witness test these distinct claims.

Claims-to-Payroll continues through the existing `PayrollInputContributor` kernel contract. Approved taxable claims are reserved only to an authorized draft batch, with existing cutoff and scope rules. Only claims with an actual payslip are marked paid; excluded claims are released for a later batch. `claims-pack` checks the public contract against the native owner; `payroll-claims-scope` checks persisted cross-pack outcomes. Attendance allowance transfer also uses its existing published Attendance facade without changing its calculations or transaction.

## Evolution and verification

Append schema changes; preserve applied SQL and installed watermark ordering. For each schema or event change, declare the old/new web and worker compatibility window, readable/writable payload versions, startup prerequisites and rollback limits. This application currently ships coordinated code artifacts; the contract coverage file is not a runtime schema-version handshake. Independently versioned services need a real compatibility handshake before extraction.

Notification migration 2504 specifically preserves legacy cursor coexistence while new consumers use per-event receipts. Its mixed-consumer, late-commit, rollback, duplicate and populated-upgrade tests must remain. Historical missed delivery needs an explicitly reviewed reconciliation; it is not automatically replayed during deployment.

Retain frozen source/controller identities, original failures and successful evidence. Check syntax/types, real database invariants, migrations, restored service behavior and production-rendered browser journeys separately. Browser preflight must pass before load; load must count committed business outcomes and failures, not merely HTTP responses. The 2/4/8 comparison keeps aggregate resources fixed. CI is not production-equivalent hardware.

A new module's review includes tenant/company/revocation adversarial cases, immutable history and calculations, privacy and file boundaries where applicable, accessibility/error states, upgrade/version overlap, durable-work recovery and operational ownership. An unresolved applicable requirement is a release gate. Documentation coverage is not permission to mark it implemented.

Production deployment is held. Production maintenance testing additionally requires the previously requested review of concrete isolation, stop thresholds, watchdog and cleanup safeguards. No manifest or CI pass overrides that authority boundary.
