# ADR-0035 — Payroll Configuration & Pay-Component Completion (Wave 1)

- **Status:** Proposed (design only — no code yet). Each slice ships behind the existing `TYPED_PAY_COMPONENTS_ENABLED` flag where it touches the typed-component path; pure-UI/config slices need no new flag.
- **Date:** 2026-06-22
- **Builds on:** ADR-0025 (typed pay-components — the catalog + kernel integration we extend), ADR-0028 (EPF contribution modes), ADR-0024 (multi-cycle / `pay_period`), Wave 2A (HRDF levy), ADR-0020 (statutory pack distribution), the existing `/payroll/configuration` page.
- **Pull-through from:** consultant feedback Wave 1 cluster — items **#2, #6, #7, #9, #12, #14, #15, #17, #21, #22, #23** (see `docs/REVIEW-2026-06-consultant-feedback.md`).

## 1. Context

The consultant cluster reads as "the payroll engine is strong but its *configuration surface* is thin." A ground-truth map of the codebase (2026-06-22) shows that's largely accurate **but most of the substrate already exists** — the gap is surfacing + finishing, not greenfield:

| # | Ask | Reality today | True gap |
|---|-----|---------------|----------|
| 9 | Payment-item classes (Allowance/Deduction/Contribution/Non-Payable) | `payComponentKindEnum` has exactly these 4 kinds; admin catalog edits them (`app/admin/pay-components`) | **Mostly DONE** — already enabled on the demo. Polish only. |
| 14 | EA-form line on PCB-subject components | No `eaFormLine` column; the EA form generator (`localization/my/reports.ts`) already defines the line taxonomy | Add a component→EA-line attribute, reusing the generator's taxonomy |
| 15 | Rounding method (Up/Down/Nearest) | No column; component amounts use fixed `Math.round` (`core/payroll.ts:51`) | Add a per-component rounding attribute (NON-statutory amounts only) |
| 21 | Edit/Delete a pay component (guard historical use) | `upsertPayComponent` + `archivePayComponent` exist; **no guard** against archiving a component already used in a closed batch | Add a usage guard mirroring closed-batch immutability |
| 17 | Payroll Config tab (cut-offs, payment basis) | `/payroll/configuration` shows the *statutory ruleset*; company payroll settings (cut-off, pay day) are **not stored or editable** | New company payroll-config record + admin surface |
| 7 | HRDF in config | `companyStatutoryMy.hrdfStatus` enum + kernel computation exist; **no UI** | Surface it in the new payroll-config surface (folds into 1B) |
| 2 | EPF mode selector (5 modes + manual rate) | `epfModeEnum` = auto / voluntary_excess / exempt, per-employee, with rate columns; **manual-rate UI unconfirmed** | Surface the existing modes + manual rate; reconcile the "5-mode" ask with statute (§4) |
| 12 | Manual payroll input + import | Per-employee form (OT/bonus/TP1/zakat) + prefill helpers exist; **no CSV import, no ad-hoc line UI** | CSV import + per-batch ad-hoc component entry |
| 23 | Batch payroll by selection | Batch is company-wide for a month; **no dept/individual subset** | Subset selection at batch creation |
| 22 | Payslip template + PDF + email + password | HTML payslip + browser print only; **no PDF/email/encryption deps at all** | A genuinely new subsystem → **own ADR** (§5) |
| 6 | Per-statutory-body independent versioning | One unified `version` per `statutoryRuleset` across all bodies | Architectural change → **own ADR** (§5) |

**The disciplined read:** ~6 of these (9, 14, 15, 21, 7, 2) are "finish the thing that's 80% built." Two (17, 12, 23) are net-new but contained admin surfaces. Two (22, 6) are large enough that bolting them onto this ADR would blur it — they get their own.

## 2. Decision

Deliver Wave 1 as **five contained vertical slices (1A–1E)** over the existing payroll substrate, and **split the two heavy items into their own ADRs** rather than overload this one:

- **1A — Pay-component completion** (#14 EA-line, #15 rounding, #21 delete-guard; #9 polish)
- **1B — Company payroll-config surface** (#17 cut-off/pay-day/payment-basis + #7 HRDF surfacing + registration numbers)
- **1C — EPF mode UI completion** (#2 — surface existing modes + manual rate, statute-reconciled)
- **1D — Manual payroll input depth** (#12 — CSV import + ad-hoc per-batch component entry)
- **1E — Batch payroll selection** (#23 — dept/individual subset at batch creation)
- **Deferred to own ADRs:** ADR-0036 *Payslip rendering & delivery* (#22), ADR-0037 *Per-body statutory versioning* (#6).

Every slice keeps the substrate discipline (a `DomainEvent` after each state-changing write) and i18n discipline (en + 5 locales). Slices that alter the payroll computation path stay behind `TYPED_PAY_COMPONENTS_ENABLED` and carry a byte-identical-when-off compatibility test.

## 3. The slices

### 1A — Pay-component completion (highest leverage; finishes gated work)
- **Schema** (migration, additive): on `pay_component` add
  - `ea_form_line text` (nullable) — maps the component to a line in the annual EA form. Values come from a fixed list **derived from `localization/my/reports.ts`** (gross salary/wages, bonus/gratuity, director fees, commission, taxable allowances, BIK/perquisites, VOLA, ESOS, retirement/compensation). Not free-text — a constrained app-level enum sourced from the existing EA generator so EA totals stay reconcilable.
  - `rounding_method text default 'none'` — `none | up | down | nearest`. Applies **only to the component's own payable amount** before it enters gross. **Statutory contributions (EPF/SOCSO/EIS/PCB) keep their own legislated rounding** — this attribute never touches them.
- **Service** (`core/pay-components.ts`): extend `upsertPayComponent` to persist the two attributes; add a delete/archive **guard** — refuse to archive a component referenced by a `payroll_batch_component` or `employment_pay_component` tied to a **closed** batch (mirror the closed-batch immutability already enforced on payslips). Append `pay-component.archived` / `.updated` events.
- **Kernel** (`core/payroll.ts`): when typed components are on, apply `rounding_method` to each component amount as it's summed into gross (behind the existing flag; off ⇒ unchanged).
- **UI** (`app/admin/pay-components`): add EA-line select + rounding select to the editor; wire Edit + Delete with the guard surfaced as a friendly error.
- **Tests:** rounding math per method; archive-guard blocks a closed-batch component, allows an unused one; byte-identical payslip when the flag is off; EA-line persists + round-trips.

### 1B — Company payroll-config surface (#17 + #7)
- **Schema:** new `company_payroll_config` (one row per company): `cut_off_day smallint`, `pay_day smallint`, `payment_basis text` (`monthly` default), plus a pointer to surface the existing `company_statutory_my.hrdf_status` + employer registration numbers. Additive, backfill-safe (absent row ⇒ today's month-end defaults).
- **Service:** `getPayrollConfig` / `setPayrollConfig`; events on write. HRDF status edit routes through the existing `company_statutory_my` write path (event-logged).
- **UI:** a **Payroll Config** section on `/payroll/configuration` (or a new `/admin/payroll-config`) — cut-off/pay-day/payment-basis + HRDF registration band + EPF/SOCSO/LHDN employer numbers, all editable by payroll admins, company-scoped.
- **Note:** cut-off/pay-day are **informational/scheduling metadata** in Wave 1 (drive display + future automation), not a change to how the period is computed — keeps payroll math untouched.

### 1C — EPF mode UI completion (#2 — statute-reconciled, §4)
- Surface the **existing** three modes on the employee statutory card with an explicit selector + **manual employee/employer rate inputs** for `voluntary_excess` (validated **≥ statutory**, per KWSP i-Topup). Map the consultant's "5-mode" wording onto the legislated reality (§4) rather than inventing below-statutory modes. No schema change expected (columns exist); UI + validation only.

### 1D — Manual payroll input depth (#12)
- **CSV import** of payroll inputs (OT/bonus/allowance/deduction) for a draft batch, reusing the validating-importer pattern from the employee CSV importer (dry-run → commit, event-logged).
- **Ad-hoc per-batch component entry** UI over the existing `payroll_batch_component` table (currently only prefilled from OT/claims/shift).

### 1E — Batch payroll selection (#23)
- At batch creation, allow **subset selection** by department / cost-center / individual (default = whole company, today's behaviour). Generation already queries active employments for the period — narrow that set by the selection. Company-scoped; multi-company batching stays out of scope.

## 4. Statutory-sensitive decision: EPF "5 modes" (#2)

The consultant asked for *Auto / Manual-% / Manual-fixed / Semi-Auto / None*. EPF is **not** freely configurable — contributions are governed by the EPF Act Third Schedule and KWSP rules. We map intent onto what is lawful, **sourced not guessed**:

- **Auto** → `auto` (Third Schedule Part A / Part E / non-citizen banding by `epfCitizenship`). ✔ exists.
- **Manual-% / Manual-fixed (above statutory)** → `voluntary_excess` (KWSP **i-Topup**, Forms 17A/18A). Manual rate **must be ≥ statutory**; a fixed RM amount is expressible as the excess. ✔ columns exist; add UI + the ≥-statutory guard.
- **None** → `exempt` — **only** for legitimately exempt persons (e.g. certain non-residents/pensioners). Surfaced with a warning; not a general opt-out.
- **"Semi-Auto"** has no statutory meaning. We will **not** add a mode that permits *below-statutory* employee/employer rates — that would silently create non-compliance (the same safety stance as ADR-0033 TOIL). If the consultant means "auto statutory + voluntary top-up," `voluntary_excess` already is that.

Decision: **3 lawful modes, fully surfaced**, with manual-rate input on `voluntary_excess`. Document the mapping in the UI so the consultant sees their 5 intents covered without an unlawful 4th/5th mode. Any genuine new requirement here gets sourced against the EPF Act before code.

## 5. Explicitly deferred (own ADRs)

- **ADR-0036 — Payslip rendering & delivery (#22).** Server-side PDF (template), email delivery, and password/encryption are a new subsystem with **zero current deps**. It also shares the **email adapter** with the notification engine (ADR-0034 §34-5) — building them together avoids two mail integrations. Sizable; sourced separately (PDPA implications of emailing payslips, password scheme). Not Wave 1.
- **ADR-0037 — Per-body statutory versioning (#6).** Today one `version` covers all bodies. Independent per-body effective-dating touches the statutory pack/ruleset loader, the snapshot-on-payslip immutability, and every reader. Architectural; deserves its own decision rather than a slice.

## 6. Sequencing

`1A → 1B → 1C → 1D → 1E`, ADR-first per slice where it adds schema. **Start with 1A** — it finishes the most-requested, already-gated pay-component work, is low-risk (additive schema, flag-guarded math), and directly closes #14/#15/#21 (and confirms #9). 1B is the next-biggest perceived gap (a visible "Payroll Config" surface). 1C/1D/1E are smaller and can interleave with the consultant's second-round re-test.

## 7. Non-goals / risks

- **Non-goals (Wave 1):** payslip PDF/email (#22 → ADR-0036), per-body versioning (#6 → ADR-0037), multi-company batching, below-statutory EPF, changing how the pay period itself is computed.
- **Risk — statutory drift:** the rounding attribute (1A) must never reach statutory contribution math. Mitigation: apply rounding only to component payable amounts pre-gross; golden payslip tests assert statutory lines are unchanged with the flag off.
- **Risk — closed-batch integrity:** the delete-guard (1A) must use the same "closed" definition as payslip immutability. Mitigation: reuse the existing closed-batch check, with a test for both branches.
- **Risk — scope creep:** Wave 1 is a cluster, not a single feature. Mitigation: five named slices + two carved-out ADRs; each slice ships, tests green, behind its flag.
