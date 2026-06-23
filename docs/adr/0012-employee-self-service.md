# ADR-0012 — Employee self-service: read-write profile with an approval gate

Status: **Accepted** (Phase 1 + 2 implemented) · Date: 2026-06-10

## Context

The employee portal (`/me`, "My workspace") already covers attendance (with missed-punch
corrections), leave (balances + apply + status), payslips, and the annual EA statement. But it
is **read-mostly**: the only things an employee can change about *themselves* are leave requests
and punches. Everything personal — contact details, bank account, tax-relevant data — is
admin-only, edited from the People detail page.

That is a real ESS gap, but "let employees edit their own record" is not a single decision.
Some of those fields change pay:

- **Bank account** decides where salary lands. An employee silently re-pointing it, with the
  next payroll run paying out there, is exactly the fraud/error surface ESS is meant to control.
- **Dependents / marital (PCB) category** drive monthly tax (MTD).

Direct, unreviewed employee writes to those fields are wrong. Contact details (phone, address,
emergency contact) carry no such risk.

## Decision — split by risk, reuse the approval substrate

**Two paths, chosen by what the field affects:**

1. **Low-risk contact fields → direct self-edit.** `phone`, `address`, `date_of_birth`,
   `emergency_contact_name`, `emergency_contact_phone` live on `person` and the employee edits
   them on `/me`, applied immediately, evented `person.self-updated`. New columns are added for
   the fields we did not yet model.
2. **Pay-affecting fields → change request.** `bank_name`, `bank_account_no`, `tax_category`,
   `num_children` (all on `employee_statutory_my`) are submitted as a *proposed* bundle that an
   admin or the employee's **administrative manager** approves before it takes effect. No
   self-approval — enforced by the shared `assertCanDecide` guard (`core/approvals.ts`) that
   already gates leave and attendance corrections. Each step is evented.

**A dedicated `profile_change_request` table**, not a generic change table — consistent with
`leave_request` and `attendance_correction`. The apply logic is typed (it writes specific
`employee_statutory_my` columns), the RLS is per-domain (tenant + `app.can_see_employment`), and
the proposed bundle is a `jsonb` patch so approval applies **only the keys the employee changed**
(it never clobbers unrelated statutory fields, and never has to re-validate the IC).

## Consequences

- ESS becomes read-**write**. The bank account it now captures is the missing input for the
  bank giro payment file (Reporting 6D, still parked) — payroll knows the amount; it never knew
  where to send it.
- Three approval flows (leave, attendance corrections, profile changes) now share one decision
  guard. The UIs are still per-page; a future generic "approvals inbox" could unify them — noted,
  not built.
- The gate is deliberately narrow: only money-touching fields are reviewed, so the common case
  (an employee fixing their phone or address) stays friction-free.

**Phase 2 (implemented).** Payslip detail + download. A `/me/payslip/[id]` route
(`payslipDetail`, RLS-scoped via `can_see_employment` so an employee sees only their own)
shows the full breakdown — earnings (basic / allowance / overtime / bonus → gross), the
employee's statutory deductions (EPF / SOCSO / EIS / PCB → net), and the employer-side
contributions shown separately as "not deducted from you". Linked from the `/me` payslips
table (the pay period is the link); "Print / Save PDF" reuses the EA statement's print path.

## Refinement — gate compliance-sensitive identity fields (#24, 2026-06-23)

The consultant (#24) flagged that an employee's self-edit of personal information applies immediately
("Updated Successfully") with no HR review — a compliance risk. The original two-path split put **date of
birth, gender, and marital status** on the direct (`updateOwnContact`) path, but those three are
compliance-sensitive: date of birth drives age-based statutory (EPF senior / SOCSO / retirement), marital
status drives the PCB category, and gender gates maternity / paternity eligibility. So they move onto the
**approval-gated** path (`requestProfileChange` → admin `decideProfileChange`), alongside bank / tax /
dependents. The genuinely low-risk contact fields (phone, address, emergency contacts) stay direct.

`ProfileChangeProposed` now also carries `dateOfBirth` / `gender` / `maritalStatus`; on approval the
person-table fields are applied to `person` (no statutory profile required) and the statutory fields to
`employee_statutory_my`, each with its own audit event recording the field *names* only. The `/me` page
shows these three as read-only current values under the approval-gated card with a "request a change"
form; legal name, email, and IC remain admin-only (never self-editable). A test pins that a DOB / marital
change is withheld until approval and then applied to `person`.
