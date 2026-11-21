# Rewards installed adoption: source and proof plan

Exact base315467b94d49011ba367a54c46a4eaa2e90b8a8a. Design only: no SQL,
application, journal, installer or runtime implementation. Root allocates the
migration only after fresh target/predecessor inventory and design review. The
proposed installed protocol is a separate versioned artifact from uninstalled
prototypev1; its reviewed closed receipt/policy shape must not accept arbitrary
prototype rows or a caller-selected compatibility flag.

## Concrete ownership and implementation order

| Order | Proposed owned files/seam | Required completion before next adoption step |
| --- | --- | --- |
| 1 | Root-owned target inventory and migration reservation; exact native predecessor/role/capability manifest. | Full actual installed lineage, native owner, special helper grant authority, FORCE-RLS and complete reachable ACL/definer closure established. The actual migration cannot assume postgres or role-creation authority. No broad membership/owner transfer workaround. |
| 2 | `db/audit-policy.ts` and the existing `core/audit-chain-arming.ts` boundary; guarded native policy projection/resolver in a future allocated migration. | One canonical setting/default/env/history rule, protected installed runtime config binding, actual before/after legacy truth-table parity and native armed/unarmed/first-arm/flip controls. No new reader GUC authority or blanket withTenant changes. Missing native policy capability is an explicit blocker, not permission to invent a parallel default. |
| 3 | Root-allocated native receipt/pending/link/profile/coverage/run migration; `deploy/rewards-audit/` role prerequisite design. | Actual non-super owner installation and upgrade; private exact roles/ACL/RLS, immutable receipt, deferred commit completeness, indexed pending intent, homogeneous tenant claims, same-TX canonical append/link/removal, complete catalog drift refusal. Existing16 regressions ported alongside their unchanged original evidence. |
| 4 | A singleton budget-family owner in `db/` shared with `db/client.ts`; private `db/rewards-audited-read.ts`; closed `packs/rewards/` receipt query port. | Real postgres/Drizzle Tx, same canonical query owner/validation/order/money, COMMIT-before-return, no app-pool side effect from leaf imports, no generic callback/SQL broker export. Physical maxima and abortable pre-checkout admission share the real fleet reservation, not only the prototype gate. |
| 5 | Built `lib/rewards-audit/` processor/entrypoint; protected `deploy/rewards-audit/` packaging/profile/startup/shutdown. | Dedicated LOGIN-only configuration; no app/owner/provider credentials; actual immutable built entrypoint and installed native version; native run/counters; bounded claim loop and fair tenant transactions; SIGTERM drain, SIGKILL/ambiguous-commit native recovery; source/secret/profile drift refusal. No reuse of the owner-credential notification sweep or uninstalled tsx child as installed proof. |
| 6 | Native-authorized `core/audit-disclosure-coverage.ts` plus central audit coverage presentation and companion receipt export. | Actual pending/projected/legacy facts and lag/error/processor state visible before read mode enables. Existing domain-event table, columns, ordering and event-export semantics remain; pending facts have an explicitly separate representation. Complete disclosure reports include receipts once, not a pending row plus its linked event. Chain.valid alone never implies complete disclosure coverage. |
| 7 | Only `rewardLibraries`/`rewardPatInputs` facades in their existing pack owners; existing Libraries/PAT/Plans/import-preview callers. | Exact signatures/DTOs and per-invocation audit cardinality, all nonempty financial/IDs/history/scope cases, actual signed-in rendered journeys and strict healthy-load gates. Every command, legacy query port, standalone libraryVersionTx and exported audit contract remains independently owned. Unsupported exports are explicit remaining coverage, not a universal speed claim. |

Names above specify ownership seams, not permission to introduce a numbered SQL
file or execute installation. If a seam already has an approved canonical owner,
reuse/deepen that owner rather than create a competing policy or framework.
Consult installed Next docs before eventual framework changes. Keep business
logic in the pack service; templates receive minimized typed DTOs, not Tx/keys.

## Specific proof matrix

| Area | Native/installed observations required |
| --- | --- |
| Authority | Real reader/projector LOGINs and current/session identities; actual non-super migration owner, special setup-reader ownership, both helper EXEC grants only, no app USAGE/inheritance/sequence or business-write capability. Archive/block/revoke/foreign/company-only/CTRO view-versus-PAT/manage, scoped module and current-principal controls with retained contexts. |
| Data | Independent nonempty library IDs/order/revision/state/full financial matrices/usage/locks; PAT current/pending/history/company/hierarchy/order, null-versus-zero/string money; original person-independent view and person-bound commands unchanged. Complete native money/IDs/history before/after every failed operation. |
| Audit | One committed immutable receipt per successful invocation including empty; no result on read/validation/finalize/COMMIT/cancellation failure; renderer failure after committed service success retains that fact. No new receipt manufactured after an ambiguous response retry. |
| Concurrency | Actual held Access+History while the read completes; old immediate controls still block; concurrent claims; real old-cursor peer COMMIT before lock; late lower-ID receipt; cross-tenant opposing order; blocked/poisoned tenant does not erase another tenant's commits. |
| Policy | Armed/unarmed/absent/malformed/default/env truth matrix; first arming and no disarm after armed observation/history; genuine settings flip between receipt and projection; canonical hashes/sequence remain correct. Do not fake chain arming to make a fixture pass. |
| Durability | Actual built process SIGKILL before/after receipt and projection COMMIT, independent native receipt/event/pending/link facts and truthful committed counters; exact backend PID/start recovery; active/foreign/reused-PID recovery denial; repeated recovery cannot clear a new run. |
| Budget/lifetime | 2/4/8 worker budget equations use the same frozen protocol/resources; measured physical sessions across all roles stay within the common total. Interactive and background gates admit before checkout; signal cancellation, full cleanup/drain and poisoned successor refusal fit existing hooks. Unknown cleanup identity never authorizes DROP/termination. |
| Coverage/retention | Current native audit authority, no unauthorized actor/company metadata; pending+projected deduplication, no gap for late commits, stopped/failed processor visible; no receipt/link/pending pruning or forged historical backfill. Backup/restore preserves exact coverage and event chain. |
| Compatibility | Old binary/new schema; new binary/explicit old deployment mode; unexpected partial schema/profile/body/credential refuses rather than catches42501 into fallback; rollback keeps draining existing receipts; duplicate activation/stale epoch/unknown version cannot enable reads. |
| Runtime | Actual installed protected entrypoint, role-secret endpoint binding and immutable source/profile/dependency inventory; no owner/provider env leakage. Browser uses real native signed-in fixture actors on Salary Structures, Bonus Matrices, PAT and Plans plus import preview and unchanged exports. HTTP200/heading/component screenshot alone is insufficient. |

Native proof, controller/profile proof, ordinary tests/compiler/build, populated
actual-prefix rehearsal and rendered/load proof remain separate frozen chunks.
Let all planned chunks reach terminal before repairs, preserve each original
failure and unaffected receipt at its exact identity, then rerun only affected
owners. Existing16native/3ownership/323legacy success is retained at original
sources; it does not commission the new production protocol.

The actual implementation budget includes immutable receipt+link storage, a
bounded indexed pending queue, a protected native process and audit coverage.
No automatic arming/backfill/pruning or hidden new full pool is a shortcut to
release. Staging follows all correctness/release gates; production remains held.
