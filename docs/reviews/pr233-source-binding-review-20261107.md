# PR 233 — exact provider source binding review

## Proposed scope

PR 233 implements the four owner-approved plans: saved Formula IDs, full recorded payroll reconciliation, Group-wide approver lookup and shared Attendance workflows. Release review also restores the complete shared company assignment set when enabling routing. Current staging baseline is `109a046ef38f90514f1da458056aa09e015a47a4`; its mobile changes are preserved by a normal merge.

The proposed exact provider transform digest is `060197673eb80737b70097419f9572f413e95c58450f9cd418d636b466d0bd50` across 1459 sources. The accepted parent digest is `261d6298b853a76e91fbc494d64d14099cdbca115cafdd47932828daef8f463a`.

The covered changes are deterministic HR/payroll owners, their schema types, recorded-result report helpers and six translated message files. Saved formula evaluation keeps source permissions and immutable versions. Approver discovery separates actor visibility from candidate eligibility; every shared mutation checks all affected companies. Reconciliation reads recorded amounts and keeps unknown evidence explicit. No provider, destination, prompt, privacy projection field, contract, permission grant or AI decision authority is added.

## Proposed registry edit

Renew only the exact `sourceDigest` value of the 28 already-approved literal records in `lib/ai/provider-data-approvals.ts`. Preserve their contract IDs, status, reviewer, original evidence and original timestamps byte-for-byte apart from that value. Keep `structured_canonical_records_v1` and `attendance_trend_analysis_v1` byte-identical, pending and blocked. Regenerate the secondary module-agent manifest last. Do not change generators, source scopes or approval checks.

## Approval status

On 7 November 2026, the repository owner answered “Approve exact binding renewal” to the question explicitly naming PR 233, digest `060197673eb80737b70097419f9572f413e95c58450f9cd418d636b466d0bd50`, the 28 already-approved records and both blocked pending contracts. This authorizes only the exact proposed registry edit above. Original approval metadata is preserved; this owner renewal is not fabricated specialist certification. The owner separately requested review and staging deployment of these four completed items; no production deployment or package publication is authorized.

## Verification and installation

Earlier focused PR checks retain their original commits. The reviewed integrated candidate still requires the authenticated full hosted release gate, exact migration ledger check, shared staging lease and changed authenticated rendered journeys. This proposal authorizes no production installation or package publication.


## Follow-up after the complete release gate — 8 November 2026

Original full gate `42386361674` remains failed at exact source `04d8387cec51ad3f0b6d62b28e188d491fa010cb`. All planned units finished before repair. Four units exposed one missing read-only action inventory entry, one missing company-retention reference, the canonical company/tenant FK ordering, and a frozen-route regression when another login is added later.

Repair `f3a221ab58732cfaa2230e2eeec7d80ec14459cf` adds `searchAttendanceApproversAction` as `backlog:automatic` (not registered or executable by the AI), retains immutable workflow assignments when deciding whether a company can be deleted, uses the canonical `(company_id, tenant_id)` FK, and checks the exact saved user/person for frozen participants without reapplying selection-time login uniqueness. Saved-login archive/block/grant checks remain. Existing assertions are unchanged; only the new, unapplied migration's approved hash pin is renewed.

The corrected exact provider digest is `babb939b9b10a0292344552cd3c65d2a2740a48f11148b5236a28a0b88e0bc06` across 1459 sources. The changed inventory and company-reference metadata are in the provider closure, so the owner's earlier exact `060197673eb80737b70097419f9572f413e95c58450f9cd418d636b466d0bd50` approval does not silently renew this value. Proposed disposition remains the same 28 digest-only replacements; both pending contracts and all original approval metadata remain unchanged. No provider, destination, outgoing field, grant or autonomous action is added.

The independent immutable-source impact classifier records `tier: full`, `risk: high` because the unapplied migration SQL changed. A new complete gate is required for the corrected schema; the old successful units are not relabelled onto it. This is explicit repair invalidation rather than a default whole rerun after a failure.

On 8 November 2026 (Asia/Kuala_Lumpur), the repository owner answered “Approve corrected exact binding” to the question explicitly naming corrected digest `babb939b9b10a0292344552cd3c65d2a2740a48f11148b5236a28a0b88e0bc06`, the same 28 approved contracts, unchanged permissions and original approval metadata, and both pending contracts remaining blocked. This records actual approval for only those exact 28 fingerprint replacements. The earlier approval and failed gate remain historical evidence.
