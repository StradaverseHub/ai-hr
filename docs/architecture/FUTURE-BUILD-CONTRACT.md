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

## Database read cost (ADR 0181 standard)

On 25 November 2026 the owner made the read patterns of ADR 0181 (`docs/adr/0181-database-read-cost-architecture.md`)
the standard for all new work. Existing screens move over area by area. These rules stop the old patterns from
growing back in the meantime. Each rule names the check that enforces it. The checks only tighten: their
allowlists in `test/read-cost-ratchets/` were seeded from `alpha` at release 9 and may only shrink. A false
positive is fixed by restructuring the code, never by adding an entry. `test/read-cost-ratchets/README.md` explains
how to shrink each list.

1. **Access rules use precomputed access.** A new or rewritten access rule (row-security policy) reads a stored
   answer once per statement, in the form `= any ((select app.<answer>(…)))`. Follow 7210 (company access), 7240
   (employment visibility) and 7280 (leave delegation). The answer is stored in an owner-only table that every
   writer maintains in its own transaction. Each tenant has an access version. A mode switch runs
   legacy → shadow → precomputed. A nightly rebuild-and-compare falls back, closed, to the legacy answer for any
   tenant that differs. A rule never calls a `SECURITY DEFINER` or plpgsql function with a row's columns, because
   that runs the whole authority chain once per row. Check: `test/read-cost-policy-authority.test.ts` reads the
   installed policies and holds `policy-authority.json`.
2. **A change to access-rule text needs a timing comparison at scale.** This applies to any migration that creates
   or alters a policy, or redefines a function a policy calls. It times the old and new rule text with
   `EXPLAIN (ANALYZE)` on the 70-company / 1,000-employment fixture (`test/helpers/ai-centre-scale-fixture.ts`, or
   the access pilot fixture for that family). It runs under "All companies" and under one company, using the
   screens' real statements, including the joins whose row estimates move the plan: payslip, employment and person.
   An equivalence test alone is not enough. Releases 6 (7240) and 8 (7280) returned the right rows and still
   regressed, because the new rule text changed the planner's join order. The planner estimates a bare
   `= any(<initplan array>)` at about 1% of the table, whatever the array holds, so compare plan shapes as well as
   totals. Check: `test/read-cost-ratchets.test.ts` requires the migration to be listed in
   `policy-rewrite-evidence.json` with a test that names it, uses a scale fixture and runs `EXPLAIN ANALYZE`.
3. **Lists page by key and cap their counts.** Use `parseKeysetPageQuery`, `keysetSlice`, `keysetPageState` and
   `cappedTotal` (`lib/pagination.ts`) with the Pager's keyset mode. A total above 1,000 shows as "1,000+", with a
   "Count exactly" option (`count=exact`). Exports, payroll, statutory and report totals stay exact. New lists use
   no `OFFSET`, no numbered pages, and never read every row to page in memory. Company lists have one query shape:
   one `uuid[]` parameter (`anyUuid`, `db/sql-arrays.ts`), whatever the number of companies. Other id lists, such
   as a page's row ids, take the parameter shape a scale test chooses. A single array parameter hides the list
   length from a prepared statement's generic plan, and Phase 4 kept page-id lists expanded for that reason. Check:
   the page-by-number ratchet (`page-by-number.json`).
4. **Saves keep the frame.** A new save form uses the shared save helper (`lib/action-navigation.ts` with
   `components/action-navigate-form.tsx`). The action writes, returns its result and the next address, and the
   client navigates in-app. It calls no `revalidatePath`, `refresh()` or `redirect()`: from a server action, any of
   these redraws the whole tree, including the frame. Writes for many rows are set-based, as the import groups are
   (`core/import-set-group.ts`). Check: the layout-wide `revalidatePath` ratchet (`layout-revalidate.json`). Page-level
   `revalidatePath` calls are not counted yet.
5. **Every background job kind declares a worker lane.** Place the kind in `core/bulk-job-lanes.ts` when its handler
   is added. Long or bulk work runs on the bulk-job kernel, not in the request (scale rule 4). Check:
   `test/bulk-job-lanes.test.ts`, which already fails a handler kind that is in no lane or in two.
6. **Every new page route and server action has a read budget.** Register it in
   `test/read-cost-ratchets/read-budget-registry.json` under its `page.tsx` path or `file#action`. The entry names
   the test that counts its transactions and statements (`observeStatements`, `test/helpers/statement-observer.ts`)
   on the scale fixture and asserts recorded numbers, as `test/route-read-budget.test.ts` does. Budgets only go
   down. Raising one needs an ADR note, in ADR 0181 or the area's ADR, in the same PR. Check: the unbudgeted
   ratchet (`unbudgeted-routes.json`).
7. **No per-company or per-row loop in a request** (scale rule 2). Read the set in one statement per concern and
   group it in memory. Never call a reader once per company or once per row, whether in a loop or through
   `Promise.all(rows.map(…))`. Check: the request-loop ratchet (`request-loops.json`). It scans `app/`,
   `components/` and the mobile API for loops and array callbacks that make a data call for each element.

The checks are static or read the installed schema. They prove that no new use of an old pattern appeared in the
places they scan. They do not prove a screen is fast. `core/` readers are also run by workers, so they are not in
the loop scan. Route budgets and scale tests cover them, and the rules above still apply to them.

## Reference workflow proofs

Attendance approval uses the Attendance service from the Approvals adapter. The workflow owner still enforces current stage/participant, delegated authority, rejection reasons, no self-approval and final-effect uniqueness. Corrected punches and deferred overtime preserve their original semantics. `attendance-workflow-v4-owner`, `attendance-workflow`, `attendance-pack` and the actual browser correction/approval/punch witness test these distinct claims.

Claims-to-Payroll continues through the existing `PayrollInputContributor` kernel contract. Approved taxable claims are reserved only to an authorized draft batch, with existing cutoff and scope rules. Only claims with an actual payslip are marked paid; excluded claims are released for a later batch. `claims-pack` checks the public contract against the native owner; `payroll-claims-scope` checks persisted cross-pack outcomes. Attendance allowance transfer also uses its existing published Attendance facade without changing its calculations or transaction.

## Evolution and verification

Append schema changes; preserve applied SQL and installed watermark ordering. For each schema or event change, declare the old/new web and worker compatibility window, readable/writable payload versions, startup prerequisites and rollback limits. This application currently ships coordinated code artifacts; the contract coverage file is not a runtime schema-version handshake. Independently versioned services need a real compatibility handshake before extraction.

Notification migration 2504 specifically preserves legacy cursor coexistence while new consumers use per-event receipts. Its mixed-consumer, late-commit, rollback, duplicate and populated-upgrade tests must remain. Historical missed delivery needs an explicitly reviewed reconciliation; it is not automatically replayed during deployment.

Retain frozen source/controller identities, original failures and successful evidence. Check syntax/types, real database invariants, migrations, restored service behavior and production-rendered browser journeys separately. Browser preflight must pass before load; load must count committed business outcomes and failures, not merely HTTP responses. The 2/4/8 comparison keeps aggregate resources fixed. CI is not production-equivalent hardware.

A new module's review includes tenant/company/revocation adversarial cases, immutable history and calculations, privacy and file boundaries where applicable, accessibility/error states, upgrade/version overlap, durable-work recovery and operational ownership. An unresolved applicable requirement is a release gate. Documentation coverage is not permission to mark it implemented.

Production deployment is held. Production maintenance testing additionally requires the previously requested review of concrete isolation, stop thresholds, watchdog and cleanup safeguards. No manifest or CI pass overrides that authority boundary.
