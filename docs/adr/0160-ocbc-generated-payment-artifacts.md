# ADR-0160 — OCBC generated payment artifacts

- Date: 2026-10-29
- Status: Approved product direction in board item9eff8939; bank acceptance remains unverified.
- Related: migration0680; payroll history custody and country-pack boundaries.

## Decision

OCBC salary and statutory bank uploads have distinct format identifiers from government-portal files. The neutral route resolves country behavior through the registered pack. Scope, module entitlement and current database administrator authority are checked for preview and generation. No automatic bank submission is included.

Salary selects exactly one ready payroll run. Statutory files use ready saved runs for the contribution month. Imported historical or stale calculations cannot supply a new payment file. Saved payroll amounts remain authoritative; the exporter does not recalculate contributions or mark payroll paid, filed or accepted. SOCSO8A includes employee and employer SOCSO, excluding EIS/SKBBK.

Preview validates fixed-width encoding, fields, amounts, counts and dates without writing. Generation compares the source digest, allocates a tenant/value-date Tape ID atomically and stores immutable bytes, metadata and an audit event. A tenant/actor request key retains the same artifact on uncertain retries; a separate request fingerprint rejects changed-input key reuse. Counter mutation is restricted to the scoped allocator; account deletion does not erase generated history.

The owner explicitly instructed on the board to leave LHDN and Zakat Hash Total blank while reserving its exact field position and length. This is an initial layout decision and does not assert that OCBC will accept blanks. The owner also specified that a Tax Number ending in0 or1 supplies that final digit as LHDN Wife Code. Preserve the employee's stored Tax Number; formatting is a projection rather than a payroll master-data rewrite.

## Verification boundary

Use synthetic independent byte-position/count/amount assertions and isolated database security, concurrency, stale-source and retry journeys. Never commit supplied live bank samples. A generated file is not bank acceptance; payroll-owner review and an actual bank test upload remain separate before live operational use.
