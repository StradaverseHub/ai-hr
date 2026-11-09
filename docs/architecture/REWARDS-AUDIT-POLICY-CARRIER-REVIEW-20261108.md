# Rewards durable armed floor: carrier and PRE-frame review

Source analysis only, based on immutable prototype315467b94d49011ba367a54c46a4eaa2e90b8a8a and adoption ADR2bf430b566b3c481a93a304e90794dcb3e3664ec. No application/native SQL implementation, tests, installation or acceptance in this checkpoint. Production remains held.

## Decision needed before implementation

A durable armed receipt must protect future canonical event writers before the Rewards response succeeds. Projector-only arming and process-local `chainedTenants` cannot provide this property. However, adding a fresh committed-floor predicate to every `_domain_event_next` call is also insufficient: it can change an already captured Bank/Catalogue PRE while that command owns the original History lock. The native PRE guards would then roll back an otherwise unchanged command. Preserve their correctness checks; do not bypass or weaken them.

Root approved the narrow floor direction subject to actual carrier inventory and this race model. This document records a newly identified blocker, not an accepted implementation or a reason to abandon the durable receipt design.

## Actual carrier owners

| Carrier | Actual source | Established behavior | Limit of the evidence |
|---|---|---|---|
| Ordinary application commands | `db/client.ts`254–336 | `db.transaction` with no options; no `SET TRANSACTION` isolation override. Suspension can set READ ONLY. | Isolation inherits the physical connection/database/role default. Source does not prove installed RC. |
| Presentation snapshots | Same owner, `readOnlySnapshot:true` | BEGIN explicitly REPEATABLE READ / READ ONLY. | These are not command carriers; PostgreSQL refuses event writes. |
| Nested module transactions | `core/payroll.ts`, `movement.ts`, `movement-import.ts`, `employee-draft.ts`, `probation-cutover.ts`, other index candidates | Existing transaction's `tx.transaction` savepoints. | Savepoints do not create independent isolation/floor visibility. |
| Human Bank review | `generic-review-custody.ts` → `bank-maintenance-review-store.ts` → `bank-maintenance-source.ts` → country/native owner | Top-level `withTenant`; actual `assertAiPrincipalTx` requires RC, current native identity and Access interval. `assistant_bank_review_arm` captures PRE before canonical mutation. | Native source/epoch/receipt/PRE checks remain mandatory. |
| Human Catalogue review | Shared custody → native `assistant_catalogue_native_arm`/phase owners | Native arm in0864 explicitly requires RC/RW; first PRE stored, subsequent `_domain_event_next` exact comparisons. | A later floor can invalidate a PRE despite unchanged head. |
| Ordinary Bank import | `core/bank-import-worker.ts`, `core/bank-import-job.ts` | Commands use `withTenant`. The worker's raw `client.begin` is entitlement resolution, not its mutation carrier. | Default mode still needs installed/native qualification. |
| Owner maintenance/provisioning | e.g. `scripts/module-change-runner.ts`, `apply-dunning.ts`, `provision-runner.ts`, backfills/repairs | Explicit injected owner `db.transaction`; module-change native ownership check requires RC/RW. | Other default transactions are not silently declared RC. Owner tools remain trusted privileged operations, not a new least-privilege reader path. |
| Direct operator event writer | `scripts/operator/teras-conversation-switch.ts` | Fixed `postgres.begin` and INSERT `domain_event`; no `withTenant` or process GUC arming. | Must see the shared floor through the native trigger, rather than rely on application cache. |
| Auth/native-purpose callers | Native SQL INSERT owners; auth broker explicitly establishes RC/RW | Native `domain_event_chain_tg` remains the common event adjudication entry point. | Runtime trigger/function/inventory bindings must be verified; a lexical source index is not a complete dynamic call graph. |

The bounded source index scans all4510 tracked TS/TSX/MTS/MJS files under app/core/packs/db/lib/scripts, excluding fixture directories and test suffixes. It records229 direct event *candidate files*,787 lexical sites, and126 explicit carrier-marker files with exact source hashes/line numbers. Comments, declarations, read-only transactions and unrelated `.begin` methods can match: these are investigation candidates, not787 verified writers. Aliases, generated SQL and native triggers require native catalogue/dependency verification. No claim that the index proves every callable writer's permission/mode is made.

There is no explicit production RR/RW or SERIALIZABLE transaction acquisition in this scanned source. The only explicit application RR acquisition is the protected read-only owner. This does not authorize a new global mode restriction: PostgreSQL role/database/URL defaults and permitted raw clients remain separate evidence.

## Shared native owner and exact preservation boundary

`app._domain_event_next(uuid,boolean)` is introduced by0863. It acquires the existing `audit-chain:<tenant>` transaction advisory lock (try-lock for protected Bank/Catalogue), reads the canonical head, and derives armed from the caller's existing GUC, existing chained history or actual true tenant setting. It does not currently restrict transaction isolation.

The latest canonical trigger in this source is0864, **not** the earlier0863 trigger. It calls `_domain_event_next`, then BOTH Bank and Catalogue owner-frame guards before unchanged sequence/hash construction. Any new append must guard the actual latest trigger and both complete PRE families. `_domain_event_preimage_for` qualifies a persisted event through canonical sequence/link/hash; it does not create an independent expected PRE.

The proposed owner-only `_audit_durable_armed_floor(tenant)` would read immutable committed authenticated armed receipts through a partial tenant index. It must be callable only by the actual canonical audit owner, not PUBLIC/app/reader/projector. It cannot trust a reader GUC or caller boolean, arm an unarmed tenant by API input, take tenant hot-row/History/Access locks during receipt COMMIT, or discard the floor when projection completes. Retention/compaction must preserve the permanent floor first.

The old setting/env decision remains `chainArmingDecision`; a generated12-row native contract captures its boolean/null-setting × history × protected-installed-fallback truth table. Missing setting remains null, not the catalogue false default. Protected fallback installation provenance remains a separate gate. The pure owner and all other modules' existing fallback behavior stay unchanged.

## Concrete concurrency matrix

| Schedule | Required observation / issue |
|---|---|
| No history; settingtrue; reader finalizes and COMMITs armed receipt; settingfalse; fresh other-worker event, projector paused | New event must chain from GENESIS through the shared committed floor even when caller GUCoff; receipt then projects exactly once later. |
| Same schedule; receipt transaction rolls back | No committed floor and no successful read response; settingfalse retains original unarmed behavior. |
| Receipt COMMIT outcome uncertain | Do not return data or blindly replay. Reconcile exact immutable receipt identity through a trusted native API. A committed armed floor remains valid even when caller lost acknowledgment. |
| Writer adjudicates unarmed and holds History BEFORE first armed receipt COMMIT; writer later settles | It may serialize before the receipt. Do not manufacture an event/hash rewrite or make receipt COMMIT acquire that lock. Test actual PRE custody below. |
| Writer starts AFTER successful receipt, including a fresh RR/RW transaction | Its first snapshot must include the committed floor. Actual canonical native writer must chain or fail for its original unrelated mode/permission rule; do not label a forbidden carrier supported. |
| RR/RW writer establishes snapshot BEFORE floor COMMIT, then appends afterward | VOLATILE does not pierce RR. Existing native function has no universal RC restriction. This is an explicit compatibility gap requiring actual permitted-writer mode inventory; do not claim universal fresh-adjudication protection from source alone. |
| Existing process cache says armed but caller settingfalse | Existing behavior remains armed. Shared floor adds cross-worker durability, not a cache permission. |
| Tenant has old chained history regardless setting/env | Existing nondisarm behavior remains exact. |

## Newly identified Bank/Catalogue PRE blocker

Controlled native sequence required before selecting an interface:

1. An unarmed Bank command acquires its normal Access/business/History intervals and `assistant_bank_review_arm` persists `{armed:false,priorSeq:null,priorHash:null}` in its existing root-XID-bound custody.
2. Owner-only test synchronization pauses it after PRE capture, without changing a guard or releasing History.
3. A separate actual restricted Rewards reader observes settingtrue and COMMITs the first armed receipt. This must not wait for History/Access held by the command. Flip the settingfalse in its own canonical authorized operation when that operation is able to run; alternatively the relevant first test can use protected legacy fallback for the reader and unchanged callerGUCoff without taking the Access configuration writer barrier.
4. Resume Bank. A naive fresh-floor OR now returns `{armed:true,...}`.0863's `_bank_audit_owner_frame_guard` or parent fence detects a changed PRE and raises42501. Catalogue0864 has the same repeated comparison at native arm/frame boundaries.
5. Baseline behavior: the old audited read waited for History, so this first-floor transition could not happen before the already-adjudicated command settled. The new rollback would be introduced by the proposed interface, not a fixture expectation to relax.

A setting flip which itself requires the held Access writer barrier must not be fabricated as concurrent; use separate schedules to prove the setting-flip-after-read case and the PRE/floor race. Both races matter, but they have different legitimate synchronization boundaries.

The reviewed interface must preserve a command's trusted transaction-owned first adjudication while ensuring fresh writers see the durable floor. A plain repeated indexed EXISTS does not do that. Candidate directions for review:

- A native transaction-owned audit decision frame, established under the existing History lock, with exact root-XID/tenant/native-owner binding. Floor eligibility is stable for the frame; the actual chain head remains freshly canonical. This is durable native custody, not a caller GUC or permission cache. It needs bounded lifecycle/cleanup, whole-transaction/multiple-event behavior and complete owner/ACL/profile proof; avoid introducing an unbounded permanent row per command without a lifecycle design.
- Reuse already authenticated Bank/Catalogue PRE custody only for those frames, with an exact audited helper interface. This avoids a new generic table but couples the global audit owner to module-specific state and must not let any old/foreign/finished review suppress a floor.
- Establish the first shared armed floor in a separate authorized configuration/admission transition *before* receipt-mode activation, using original canonical serialization there while keeping every receipt COMMIT lock-free. This changes activation protocol and cannot be claimed as a pure read-facade adoption. Unarmed-first-read compatibility would need a deliberate approved lifecycle, not a hidden lock or silent refusal.

Root selected further design of the first option, scoped ONLY to the durable-floor component. No SQL implementation is accepted in this checkpoint. Do not weaken existing PRE equality to make a concurrency test pass.

## Proposed native floor-frame interface (not implemented)

Keep `_domain_event_next`'s existing History acquisition, current GUC/setting/history checks and canonical head query. Invoke a private VOLATILE owner helper after actual lock acquisition. The helper may return only the durable-floor bit; it must not cache PRE, head/hash, principal, permission, setting, GUC or the complete arming decision.

A private native frame records `(tenant_id, root_xid xid8, backend_pid, backend_started_at, observed_floor boolean, installed_profile_version)` with unique `(tenant_id,root_xid)`. All fields are native-derived. First lookup binds `pg_current_xact_id()` and exact actual backend start, reads committed authenticated armed receipts, inserts one immutable frame, then returns its bit. Repeat lookup requires the same physical/root identity and returns only that bit. Prior event appends still update the canonical head and `priorSeq/hash` on each `_domain_event_next` call. The complete existing arming expression stays fresh, with the stable floor bit added as one additional arm reason.

The helper and private table are closed to PUBLIC/app/reader/projector. Only the exact guarded canonical-owner call closure can create or consume a frame. Actual `pg_locks` History membership can be checked as additional evidence but cannot by itself distinguish a spoofed session lock from transaction ownership: closure must retain the native `_domain_event_next` transaction-lock acquisition. No temp table, caller GUC, caller identity claim or session-local cache can replace this custody. New tables/functions/ACLs require full effective privilege/definer/profile closure and additive predecessor guards.

A live frame must not be cleared by caller-controlled SQL. In particular, deferred-trigger deletion is unsafe: `SET CONSTRAINTS ALL IMMEDIATE` can fire it before the transaction ends and permit a second floor observation. Instead, owner-only cleanup may delete bounded batches of *other root-XID* frame inserts visible in its own transaction, using `FOR UPDATE SKIP LOCKED` and exact immutable profile identity. Since an insert-only frame is invisible to another transaction until original COMMIT, an independently visible row is no longer a live uncommitted frame. Own current-XID rows are always excluded. Rollback automatically removes a new frame; no manual rollback cleanup guess is needed.

Cleanup can be a bounded internal first-frame/native-projector housekeeping operation using an existing reserved connection, not another full pool. It must never wait on a live frame or delete a replay-matching current transaction. Rows are operational metadata, not receipt history; exact cleanup counts/profile checks and restart reconciliation are required. A final committed frame can remain until the next successful bounded cleanup; storage/admission limits and throughput must be measured before adoption. Do not claim a hard storage bound merely because a proposed per-call batch size exists.

Required additional controls include: actual native backend-start precision; wrong tenant/XID/PID/start/profile denial; direct app/reader/projector INSERT/UPDATE/DELETE/helper EXEC denial; rollback after first observation; frame created in a savepoint then rolled back; existing parent frame surviving a nested rollback; repeated native PRE checks; multiple events advancing the head; independent writer after receipt; cleanup overlap/skip-locked behavior; and restart cleanup without killing or guessing active backends. Original Bank/Catalogue native expected errors and source/permission checks remain exact.

This frame proposal adds one private native command write per first tenant/root observation plus bounded housekeeping. Receipt COMMIT still takes no History/Access/hot-row lock. No new global transaction-mode restriction is proposed. Actual performance and RR-old-snapshot limits remain qualification gates.

## Required proofs and remaining gates

- Independent native expected DTOs/money/IDs and all original Rewards16+pure3+legacy323 provenance retained; new policy tests are separate evidence.
- Truth-table native contract generated from unchanged canonical function; actual protected installed fallback/profile, no readerGUC influence; armed/unarmed/null-setting behavior including first empty history.
- Native real-LOGIN floor commit/rollback/ambiguous COMMIT, fresh other-worker append before projector, exact head/hash/sequence/Bank/Catalogue PRE tests, repeated/multi-event/root-XID/subtransaction behavior, RR-old-snapshot behavior honestly recorded.
- Actual role/database/client isolation and read-only defaults; no inferred RC from a missing option. Fresh application and owner/operator carrier controls. Unknown direct clients remain a gate, not an assumed caller policy.
- Native helper EXEC inventory first. Actual staging readonly catalogue shows migration role cannot grant `reward_setup_allowed` owned by the special setup reader; separate exact owner/DBA provisioning is required. Do not add broad membership, arbitrary owner changes or waive its role guard.
- All canonical audit arming/hash/native Bank/Catalogue/preimage suites and exact append guards after any global native-owner change. No historical SQL rewrites, new numbered migration, page adoption, provider calls, deployment or release claim here.
