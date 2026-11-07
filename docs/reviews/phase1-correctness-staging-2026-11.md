# Phase 1 correctness staging release

The owner requested Phase 1 on staging before Phase 2 on 7 November 2026, superseding
this chat's earlier requirement to wait for all six phases. Production remains on hold.
The integration predecessor is the independently observed healthy staging source
`a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac`; main and alpha were fetched before selection.
This release preserves that predecessor and isolates the following correctness fixes.

| Requirement | Phase 1 disposition | Required observations |
| --- | --- | --- |
| Notification consumption follows committed events, not serial allocation order | Atomically enqueue one receipt per source event/consumer; acknowledge with native projection in the same transaction | Real interleaved commit/rollback, both audit-chain modes, acknowledgement rollback, bounded draining, old/new overlap, scoped reminders and privileged sweeps |
| Preserve historical effects and data ownership | Append migration 2702 above existing claims; retain all 703 predecessor tuples/SQL; mark historical cursor coverage without replay; retain notification history on source retention | Ordinary populated predecessor upgrade, exact ordered hashes, rerun idempotence, trigger atomicity, least privileges and tenant/actor denial |
| Distinguish deterministic row rejection from infrastructure failure | Only the canonical typed validation rejection may consume a row as failed; unexpected faults stop the job without changing atomic row checkpoints | Real SQL fault, unchanged HR values/history/checkpoints, bounded public error, authorized revalidated retry, existing permission and restart regressions |
| Hydration correctness | Keep the predecessor's synchronous approval shell. The delayed streamed-consumer defect exists only in the unreleased broader architecture; keep its stream and fix together for that later release | Existing rendered shell/notification/browser checks and authenticated staging journey; do not claim the streamed architecture was released |

Personnel typed reads, all-module read tuning, worker-count changes, admission/connection
budgets, Home's new stream, backup/recovery redesign and architecture CI policy v18 are
outside this release. Phase 2 implementation is held while this release is prepared.
This does not claim zero page Busy or system-wide performance qualification is complete.

The notification SQL includes retention and explicit grant revocation from the start;
it does not reuse or rewrite any applied architecture migration. Historical cursor
markers do not prove delivery completeness: suspected pre-cutover omissions need a
separately reviewed reconciliation, without resending external effects.

Release checks must bind the exact isolated source. Earlier combined-architecture
passes are not Phase 1 evidence. Focused Actions checks are development evidence; the
authenticated operator witness, matching protected import worker bytes, shared staging
lease, actual ledger/build arrival and changed rendered journeys remain required.
Preserve any foreign lease. The first-install-only worker installer must not be used
to overwrite the installed worker. Human staging acceptance remains a later decision.

## Provider source reassessment

The exact static provider closure has 1458 files, digest
`c21e3c049f982ddf6c3c03ce86c03d2b83ea6e8f3d53c510dd1291513ef8a3a9`. Its changed covered files are:

- `core/notice-projection.ts`
- `core/notifications.ts`
- `db/schema.ts`

These are native notification/import/schema correctness changes only. No provider
contract, data category, transform, prompt, model, transport, purpose or configuration
is expanded. The repository owner explicitly answered “Approve fictional Phase 1 staging binding”
to the exact full digest above on 7 November 2026 in this chat, after automatic
approval review required a separate decision from the broader architecture binding.
This binding is limited to fictional-data staging verification.
The owner's exact `75acbc2b...` approval remains evidence for that broader source,
not a claim that the owner inspected this new subset digest. All 28 pre-existing
approvals retain their original human metadata; both pending contracts stay pending.
No real HR-data provider call, evaluation, promotion or production action is approved
by this reassessment. Generate the agent manifest last; hosted checks remain required.

Independent spec review found that source-event visibility alone was insufficient
for company-scoped assessment receipt authority. The unapplied migration now checks
the native recipient/run linkage and `app.onehr_cycle_admin` before receipt reads,
completion or overlap-projection probes. A two-company PostgreSQL regression must
prove a foreign-company administrator cannot read, acknowledge or drain the receipt.
This SQL/test repair changes no provider-covered file or approved provider digest.
