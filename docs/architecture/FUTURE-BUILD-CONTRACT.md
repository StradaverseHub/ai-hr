# Architecture contract for subsequent builds

The foundation remains the existing modular application, PostgreSQL fact owners, pack service interfaces and separately budgeted workers. ADR-0080 owns pack boundaries. The Personnel snapshot, notification receipt, database admission and restore-authority ADRs refine specific boundaries; they do not replace payroll, employment, approval or access rules.

## Before implementing a module or changing a contract

Name each fact's owner and its public service. Keep person, user, employment, tenant and company separate. Record effective dates, allowed state transitions, actors, scoped capabilities, field disclosure, audit events and failure outcomes. Use the current native owner from web, mobile, imports, workers and AI. A facade is an interface, not authority to bypass the owner's checks.

Every registered business module must appear in `module-contracts.json` with its real service path, import-boundary test and behavioral proofs. `test/module-architecture-contracts.test.ts` checks registry coverage and duplicate declared table ownership. It does not establish that declarations describe every SQL write or that tests passed. The named behavioral suites and all affected owner tests remain required in hosted verification. Existing import debt can only shrink; new exceptions are not an implementation technique.

A command owns its protected current authorization, state transition, domain changes, audit and required delivery intent in one transaction. Internal composition passes the existing transaction explicitly. External I/O and long computation do not belong under a business lock. A successful response means a durable accepted outcome; a lost response requires receipt/state reconciliation. Retry identities bind tenant, actor, intent and payload. Never turn a timeout into an empty successful read or silently replay an uncertain external effect.

A query declares allowed fields, scope, ordering, bounded rows, exact-count semantics, maximum representative cost and its authorization linearization point. Filter before costly detail projection. Count/facet contracts must agree with the displayed population. A permission change committed before Personnel snapshot admission affects that read; an admitted coherent snapshot may finish. Command authorization retains the protected write boundary. Do not copy the read protocol into writes.

Work enters the common pool admission owner before checkout. Classify heavy units explicitly; keep aggregate web/worker/maintenance demand within the database budget. Cancellation removes abandoned queued reads. Durable imports retain checkpoints on capacity deferral. A new queue must name its active, pending, attempt and time bounds, fairness, cancellation, failure and recovery behavior. A page-level Busy fallback is not an accepted capacity control.

## Reference workflow proofs

Attendance approval uses the Attendance service from the Approvals adapter. The workflow owner still enforces current stage/participant, delegated authority, rejection reasons, no self-approval and final-effect uniqueness. Corrected punches and deferred overtime preserve their original semantics. `attendance-workflow-v4-owner`, `attendance-workflow`, `attendance-pack` and the actual browser correction/approval/punch witness test these distinct claims.

Claims-to-Payroll continues through the existing `PayrollInputContributor` kernel contract. Approved taxable claims are reserved only to an authorized draft batch, with existing cutoff and scope rules. Only claims with an actual payslip are marked paid; excluded claims are released for a later batch. `claims-pack` checks the public contract against the native owner; `payroll-claims-scope` checks persisted cross-pack outcomes. Attendance allowance transfer also uses its existing published Attendance facade without changing its calculations or transaction.

## Evolution and verification

Append schema changes; preserve applied SQL and installed watermark ordering. For each schema or event change, declare the old/new web and worker compatibility window, readable/writable payload versions, startup prerequisites and rollback limits. This application currently ships coordinated code artifacts; the contract coverage file is not a runtime schema-version handshake. Independently versioned services need a real compatibility handshake before extraction.

Notification migration 2504 specifically preserves legacy cursor coexistence while new consumers use per-event receipts. Its mixed-consumer, late-commit, rollback, duplicate and populated-upgrade tests must remain. Historical missed delivery needs an explicitly reviewed reconciliation; it is not automatically replayed during deployment.

Retain frozen source/controller identities, original failures and successful evidence. Check syntax/types, real database invariants, migrations, restored service behavior and production-rendered browser journeys separately. Browser preflight must pass before load; load must count committed business outcomes and failures, not merely HTTP responses. The 2/4/8 comparison keeps aggregate resources fixed. CI is not production-equivalent hardware.

A new module's review includes tenant/company/revocation adversarial cases, immutable history and calculations, privacy and file boundaries where applicable, accessibility/error states, upgrade/version overlap, durable-work recovery and operational ownership. An unresolved applicable requirement is a release gate. Documentation coverage is not permission to mark it implemented.

Production deployment is held. Production maintenance testing additionally requires the previously requested review of concrete isolation, stop thresholds, watchdog and cleanup safeguards. No manifest or CI pass overrides that authority boundary.
