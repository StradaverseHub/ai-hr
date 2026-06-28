# ADR-0061 — Emergency Leave: consent for the unpaid portion + paid-SICK routing

Status: Accepted (1.2.4)
Date: 2026-06-28

Addendum to ADR-0038 (Leave 2.0) and the 0106 Emergency-Leave decomposition. Phase-B audit #12.

## Context

Emergency Leave (EL) is an application type only (ADR-0038 / migration 0106): on submission `requestLeave`
decomposes it into ordinary child requests over the same dates, linked by one `parent_group_id`. The original
0106 cascade was **Annual → Unpaid**: when the employee's Annual balance fell short, the remainder was
**silently** created as an UNPAID child.

Two problems surfaced in the audit:

1. **Silent unpaid conversion.** Converting an absence to no-work-no-pay (NWNP) is lawful framing under the EA
   (it is not a s.24 deduction), but doing it **without the employee's election** is a consent/correctness gap.
   An employee who applied for Emergency Leave with no idea their Annual was exhausted would find days docked.

2. **Illness ignored paid Sick leave.** `localization/my/leave.ts` already seeds paid SICK (EA s.60F) and
   HOSPITALIZATION. An illness-driven emergency would still draw Annual and then **unpaid**, even though the
   employee had a paid SICK balance that should be used first.

## Decision

### A. Consent for the UNPAID portion (additive, throw-before-write)

`requestEmergencyLeave` takes an explicit `unpaidConsent: boolean` (threaded from the controller/UI). When the
frozen-at-submit cascade would create an UNPAID child and `unpaidConsent` is not set, it throws a typed
`UnpaidConsentRequiredError` **before any insert** — nothing is persisted, so there is no orphan pending
request. With consent, the UNPAID child is stamped with the moment of consent.

- **Schema (migration 0124, additive + nullable + backfill-safe):** `leave_request.unpaid_consent_at
  timestamptz` + `leave_request.unpaid_consent_by uuid`. Set **only** on the UNPAID child of a consented EL
  submission; NULL for every paid child (ANNUAL / SICK), every ordinary (non-EL) request, and all pre-existing
  rows. The column is reachable by the existing `leave_request` FOR ALL tenant + `can_see_employment` policies
  (same inheritance as 0106's `parent_group_id`), so it needs no new RLS policy or grant.
- **Event:** the `leave-request.emergency.submitted` command event records `unpaidConsent: true` +
  `unpaidConsentAt` when the split includes unpaid days, so the audit trail proves the election.
- **UI:** the EL request form shows the cascade notice and a required acknowledgement checkbox. The server is
  the authoritative gate (the checkbox is convenience, not the source of truth).

### B. Paid-SICK routing for illness

`requestEmergencyLeave` takes a `reasonCategory: 'illness' | 'personal' | 'other'`. For `'illness'` the cascade
becomes **SICK → ANNUAL → UNPAID(consent)**; non-illness keeps **ANNUAL → UNPAID(consent)**.

- The pure resolver `resolveEmergencyIllnessCascade(sickBalance, alBalance, workingDays)` returns
  `{ sickCovered, alCovered, alShortfall }`. With `sickBalance ≤ 0` it degrades to exactly the AL→UPL split, so
  the non-illness path and the original `resolveEmergencyCascade(alBalance, workingDays)` (kept unchanged for
  back-compat) produce identical results.
- The decomposition generalises 0106's earliest-working-days-to-paid boundary policy to an ordered list of paid
  segments (SICK then ANNUAL). Each segment carves the earliest **whole** working-days, its day count
  **floored** to ≤ its real balance (H4 — never create an unapprovable child whose floor()-of-fractional days
  exceed the balance); the fractional remainder and the shortfall fall through to the next segment or to the
  UNPAID child. The frozen-at-submit decomposition and `parent_group_id` linkage are intact; each child still
  gates its own balance at its own approval.

## Consequences

- An emergency that would create unpaid days now **requires explicit consent** or it is rejected with a typed,
  re-localizable error — no silent NWNP.
- An illness emergency uses **paid SICK first**, so an employee with sick balance is no longer silently put on
  unpaid leave.
- The consent is **stamped + audited** (`unpaid_consent_at` / `_by` on the child; on the EL event).
- Additive only: existing direct ANNUAL/UNPAID/SICK requests and the non-illness EL path are unchanged.

## Alternatives considered

- **Auto-apply SICK for any emergency.** Rejected — only an illness justifies drawing the statutory sick
  entitlement; using it for a personal errand would be incorrect. Hence the explicit `reasonCategory`.
- **Default the unpaid consent to true.** Rejected — that reproduces the silent-conversion gap the audit flagged.
- **A blocking client-side split preview requiring a balances round-trip.** Deferred — the server is the
  authoritative gate (it throws `UnpaidConsentRequiredError`), and the form surfaces the cascade + checkbox; a
  live numeric preview can be layered on later without changing the contract.
