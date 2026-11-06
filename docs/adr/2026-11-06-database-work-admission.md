# Database work admission before connection checkout

Status: candidate; hosted behavior, compatibility and mixed browser/load qualification pending. Production deployment is held.

## Preserved business contract

Admission controls when a transaction starts. It does not change its principal, tenant, grants, isolation, locks, SQL, calculation, audit or commit boundary. A queued operation has not been accepted as a business outcome. A cancelled queued read never starts a transaction. Once admitted, cancellation does not falsely declare a committed command rolled back. Callers must retain existing durable receipts and uncertain-outcome handling.

`db/client.ts` shares one admission owner per physical postgres-js pool, including hot reload and multiple `createDb` handles. All `withTenant` calls enter it before checkout. Raw owner maintenance connections and deliberate raw client transactions are separate budgets; this change does not claim to govern them.

The active ceiling equals the existing physical pool size. Background transactions use at most one quarter of it (minimum one); interactive transactions may use all idle capacity. Bank import phases, clocking import writes and report-spec execution explicitly inherit the background classification. The gate changes neither job authorization nor report disclosure. Direct exports and other existing workers still require an inventory before claiming complete workload classification.

The pending ceiling is 2,048 divided among declared application workers, with a 30-second admission deadline. Pending reads remove themselves promptly on their existing AbortSignal. Work already in a transaction is never evicted by this admission timer. Interactive work is preferred, with a background turn after three interactive admissions when its lane has space. Within a lane, the tenant with least active work is preferred; equal counts retain FIFO order. Queue telemetry must not expose tenant identifiers or HR payloads.

`AIHR_APP_WORKERS` and `AIHR_DB_TOTAL_CONNECTIONS` must be supplied together. Startup rejects a per-process pool multiplied across workers that exceeds the declared total. Existing single-process installations retain their pool default. The declaration is an operator-controlled process count, not automatic discovery or an assertion about every connection on a server. Web plus dedicated workers, maintenance and operator reserve must fit the database's measured connection/memory budget. A one-connection process cannot reserve a second connection for interactive work.

Bank import capacity deferral leaves durable job/row checkpoints intact for its normal next tick. It must not turn an unstarted row into a permanent data failure. The next phase reads checkpoints again; no blind replay of external effects is introduced.

## Qualification and remaining gates

Focused tests must prove physical connection reserve, queued cancellation, overload recovery, tenant fairness, rollback release and no context leakage. Existing Attendance, Bank import, reports, permissions and audit tests must pass. A caller holding a transaction must pass that transaction to nested owners; independent nested background transactions can exhaust a small lane, so call graphs and representative owner compositions are part of qualification.

The older per-tenant Attendance admission queues and all raw connection users remain explicit follow-up review items. Final acceptance additionally requires aggregate worker budget checks, mixed-workload outcomes and the browser preflight. Do not describe this candidate as a complete system overload guarantee merely because the semaphore tests pass.
