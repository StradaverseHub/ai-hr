# Current employment payment method — bounded MY review

Source base eabfe79736fef0c1cb1233d5977b48070ebc75a5, deliberately retained after fresh main/alpha
fetch showed265ahead/7behind. This isolated package does not merge or change either protected ref.

Native entry: Personnel setPaymentMethodAction / consolidated payment section reaches
core/org.ts#setEmploymentPaymentMethod. This package calls that same optional-outerTx owner.
The existing enum/null value and bankTransferLacksBank normalization remain canonical. Native no-op
still returns changed:false, writes no row/event and has no completed receipt. The local UI names
Already selected and disables preparation; strict human/server schema and source refuse unchanged
intent before custody. Confirmation refuses changed:false rather than forging an event.

Native readiness is a private two-input operation in core/org: only bank name and account are read,
with a private xmin revision, and no raw input leaves the owner. The locked preparation purpose DTO
returns only stored method, true binding, readiness, and opaque revisions. Exact payrollProfile
paymentMethod visibility (personnel plus compensation category), current HR/company/native Workforce
maintenance and current USER identity are checked before that private read or encrypted-body unwrap.
No bank, tax, identity or broad statutory read grant is manufactured. The existing raw native setter
retains its broader behavior; its public export remains backlog.

Initial subset: actual selected company resolves MY through the country registry; terminated or
unsupported-country records hand off to Personnel. Own-person is refused for every role; a genuine
USER without PERSON is supported, with nonnull true employment/person target. Employment grain does
not invent an all-retained-company Person write. Company-specific denials and tenant isolation remain.

Stored null means Not specified, not company default or an invented effective bank transfer. The native
UI exposes clearing. Existing consumers differ: record-readiness gapsForRecord and payroll-anomaly
missingBankProfile treat null as bank-like; paymentSummaryForBatch emits blank; MY OCBC salary source
skips cash/cheque and refuses null. Later exports read the current method even for processed/closed
payslips. The review states these consequences. No file, payment, net amount or recalculation occurs.

Source locks join current Access/Workforce/profile barriers, physical employment/company tuples and
needed bank row share ownership. Fingerprints include actual membership/company/person row revisions,
Access revision, exact field-permission rows, canonical commercial snapshot and native readiness
revision. No raw entitlement ordering or profile lock-counter fingerprint is used. No speculative
write or SAVEPOINT is needed. Native writes remain row+event within the enclosing top-level transaction.

0723 extends the one encrypted assigned ledger additively: authentic nullable actor scope from the
start, mandatory employment/company and null testing columns, true subject person, employment receipt,
per-user pending index and outcome owners. All earlier predicates/verifiers remain in exact ELSE or
delegation. Completion requires current top-level row and event xmin, exact tenant/employment/company/
person/current USER, aggregate, native before/after and persisted after including null. Historical
events, stale sources or false native outcomes cannot complete. Reopen/replay recovers the same receipt;
lost response never sends another mutation. Later terminated/unsupported subjects fail closed.

Authored UNRUN checks:
- test/assistant-payment-method-maintenance.test.ts: real native no-op/rollback, null baseline/clear,
  bank missing/partial/readiness, minimal DTO, field/category denial before read/decrypt, source/policy/
  bank/company staleness, native revocation, role/tenant/company/self/null-actor/relink custody, event
  failure rollback, old/current mismatched proof, expiry, concurrent replay/reopen.
- test/payment-method-maintenance-contract-transport.test.ts: actual strict contract, six browser
  packets, streamed response, same-origin server owner, forged/oversized packet/results.
- test/payment-method-maintenance-panel.dom.test.tsx: no-change without prepare, explicit nullable clear,
  separate confirmation, lost response, expiry and actual six-locale desktop/mobile panel fixtures.
- Shared parity executable helper gains one native role adapter and reviews group membership; existing
  action/variant partitions and route lists remain guarded.

Only static inspection/diff checks and source-manifest generation are permitted. No local tests,
collection, compiler, DB, build, server, provider, business action, CI, push, PR or deployment ran.
Static manifest: regenerate after composition; the committed digest belongs only to this owned source.
No installed Next docs exist in this checkout; new page follows the existing awaited searchParams API.
0723/idx704/when1793330000052 remains provisional, with no installation or release authority.
