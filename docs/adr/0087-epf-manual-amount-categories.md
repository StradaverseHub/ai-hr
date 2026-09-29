# ADR-0087 — Manual EPF contribution categories: a standing per-employee ringgit amount

Status: **Accepted** (item 70b14723, round r365, migration 0491)

Supersedes the **"Manual (By Fixed Amount) — DEFERRED"** section of
[ADR-0046](0046-epf-five-category-ui-labels.md) and the fixed-amount half of
[ADR-0035](0035-payroll-config-pay-component-completion.md) §4. Everything else in both ADRs stands,
including ADR-0046's five-category naming, its `voluntary_excess` mapping, and its statement that KWSP
recognises no **below-statutory RATE** election.

## Context

The request arrived three times. It asks, in the reporter's own words, for three new EPF Categories at
Personnel Management → Bank & Statutory — *Manual (Employee by Amount)*, *Manual (Employer by Amount)*,
*Manual (Employee and Employer by Amount)* — where an administrator types the contribution in ringgit and
**"the manually entered amount must be used during Payroll Process / Reprocess"**.

**A supported way to force an exact EPF figure already ships, and it is not this.** Payroll → Statutory
Adjustment (item 2961a7ae) lets an operator set the employee and employer EPF to exact amounts for **one
employee on one run**, with a mandatory reason, and the figure survives every reprocess of that run because
it is stored as an **input** the generator reads rather than a result stamped on the payslip. What it will
not do is **remember**: its window is `batch.status === 'processed'`, so the order is process-then-adjust and
the figure is re-keyed every month. The gap is not "the system cannot use a typed EPF amount". It is "the
system cannot be told once, on the employee, that this is how their EPF is always worked out".

## The two objections ADR-0046 raised, and why they are answered by placement

ADR-0046 refused a fixed amount on a legal point and two engineering ones.

**The legal point does not survive contact with the Act.** "KWSP has no fixed-amount election" is true of
what KWSP's **forms** offer and was read as a statement about what a lawful contribution can **be**.

The case it cannot survive is quoted verbatim from this repo's own sources document
(`docs/architecture/STATUTORY-SOURCES.md` §2, EPF sign-off):

> pre-1998 legacy (5.5% / 6–6.5%) is **not** auto-applied (rare — flag if any such grandfathered member
> exists).

A member on those legacy rates lawfully contributes **below today's Third Schedule**. Note the precise
shape of the gap, because it matters: the legacy figures **are** rates, so one might expect the existing
rate election to carry them. It cannot. `voluntary_excess` is `max(elected, statutory)` by design — i-Topup
can only **raise** a rate, which is correct and stays correct — so no election in the system can express
5.5%, no table produces it, and the sources document's own instruction ("flag if any such member exists") is
an admission that the case is unhandled. A typed **amount** is the only affordance the system has for it.

The product also already contradicts the old position on the identical figure — `saveStatutoryAdjustment`
accepts any EPF amount and refuses only a **negative** — so a floor here and none there would be incoherent
about the same money on the same payslip.

**Objection 1 — "`employeeOnBonus` is rate × bonus in every branch … a fixed amount has no rate, so that
term is undefined."** Kₜ is not defined from a rate and has not been since item bdf7d248: `epfContribution`
computes it as *the month's Third Schedule lookup* **minus** *the same lookup on the normal wage alone*. For
a constant *M* those two are the same number, through the same function, so **Kₜ = 0 by subtraction** and
K₁ = *M*. `K₁ + Kₜ` still equals the employee EPF exactly, and the whole typed amount is claimed once as the
month's EPF relief in PCB, under the same annual cap as any other EPF figure.

**Objection 2 — "the additional-run / off-cycle multicycle paths would mis-apply the monthly amount."**
Correct, and it is answered **only** by where the substitution sits. The amount is applied **inside the
pack's EPF computation** (`localization/my/payroll.ts` `epf` / `epfContribution`), not after the kernel's
`stComputed`. `deltaStat` (`core/payroll.ts`) charges each run the month **with** its additional remuneration
minus the month **without** it, so for a constant *M*:

| run | now | before | charged |
| --- | --- | --- | --- |
| first regular run | *M* | 0 | *M* |
| additional (bonus) run | *M* | *M* | `max(0, M − M)` = **0** |
| regular run restating a month a bonus opened | *M* | *M* − *M* = 0 | *M* |

Charged **once**, in any order, with no `isAdditionalRun` special case anywhere. Applying it after `stCore`
— the obvious placement, and the one `applyStatutoryAdjustment` uses — would put the **whole monthly amount
on the bonus run as well**, which is precisely the mis-application ADR-0046 predicted.

The placement also removes two defects for free. Same-month **PCB** is computed from the real EPF (an
after-the-fact substitution leaves month *N*'s tax on the schedule figure while month *N+1*'s accumulator
replay folds the typed one — an inconsistency nobody would ever see), and the **PCB 2(II)** cross-employer
report, which re-runs MTD off the stored EPF and compares it to the filed PCB, does not manufacture a
divergence.

## Decision

1. **One new `epf_mode` label, `manual_amount`** (migration 0491, a 0448-style **type swap** — see that
   file's header for the measured `55P04` reason `ALTER TYPE … ADD VALUE` cannot be used here).
2. **Three nullable columns** on `employee_statutory_my`: `epf_employee_amount numeric(12,2)`,
   `epf_employer_amount numeric(12,2)`, `epf_manual_reason text`. No CREATE TABLE, so no GRANT; no RLS
   change (`app.can_see_person(person_id)` is column-blind).
3. **The three UI categories are DERIVED, never stored** — they are exactly the three combinations of
   (employee amount set, employer amount set). This is the rule ADR-0046 set for Semi-Auto: a
   `voluntary_excess` row with a null employer rate *is* Semi-Auto and nothing persists the word. It means no
   stored row can carry a category that disagrees with its own figures.
4. **A null side keeps the rule.** "A blank side stays statutory", applied to amounts.
5. **The amount is substituted inside the pack's EPF computation**, per side, across **every** rule branch —
   Part A, Part E (60–<75), the non-citizen flat 2%/2%, and the age ≥ 75 no-contribution short-circuit. The
   last is deliberate: the mode requires a category, a figure and a written reason, so an admin who typed one
   for a 76-year-old meant it, and paying 0 against a typed 500 would be the half-built-feature failure.
6. **No round-up to the ringgit.** Computed EPF is `ceil`'d because the Third Schedule prescribes it; a typed
   figure is not a schedule reading and 500.50 stays 500.50.
7. **A reason is mandatory** for the mode, for the same purpose it is mandatory on the per-run override.
8. **Refused at save time:** a manual category with **no** amount on either side (it elects nothing, and the
   row would compute exactly as Auto while every screen said a person had decided the figure); a **negative**;
   a non-finite figure; a blank reason. The negative is refused **at entry** because
   `lib/kwsp-borang-a-file.ts`'s `cents()` only throws on one when the KWSP upload file is being written,
   which is far too late to tell anybody.
9. **NOT refused: an amount below the statutory schedule.** See the Context. The consequence is real and is
   the operator's: the KWSP submission file carries the employee's **true wage** in the Upah column against
   the typed contribution, and if the two disagree with the schedule the agency is the one who notices. We
   have not tested KWSP's own validation and do not guess at it.
10. **No sanity ceiling** on the amount either. Nothing in the system caps EPF today and adding one is its
    own piece of work; a mistyped RM50,000 will be paid.
11. **No spreadsheet-import column** (`test/employee-import-field-parity.test.ts`'s excluded block). Like
    every per-employee statutory override it changes what somebody is paid and should be an explicit decision
    on their record. Known gap, stated: an employer onboarding a hundred grandfathered members keys them one
    at a time.
12. **Not offered on the Create-Employee draft.** A **deviation from the approved plan's build notes**, which
    said to offer the three categories there with no amount boxes. That combination cannot be honoured:
    `resolveEpfElection` refuses a manual category with no amount, and it runs inside `pack.statutory.set`,
    which `completeEmployeeDraft` can only reach **after** `hireEmployee` has committed — so the choice would
    either fail an activation that had already created the employee or be silently downgraded to Auto, which
    on a money field is a wrong payslip. `core/employee-draft.ts` performs that downgrade **explicitly** for a
    stale draft, and the wizard names the card that has the boxes. It is faithful to the ticket, which asks
    for the categories at Bank & Statutory and says nothing about the wizard.

## Provenance — one seam, extended rather than duplicated

Round r364 (`208beb8b`) put **one** answer to "where did this figure come from?" in
`core/statutory-explain.ts`: `statutoryProvenance(statutory, key)`, the `StatutoryProvenanceSource` union,
`isSetByHand`, and the `provenance` / `setByHand` members the Statutory Detail screen, its amber banner and
the Excel export are the only readers of. Its header named this item as the extender.

The whole extension was: **one member** of the union (`'epfManualAmount'`), **one arm** of that function
reading the kernel's new `statutory.epfManual` stamp, and **per-source wording** on the one banner. No second
banner, no second rule label (`ruleKind: 'manual'` is equally true of both sources — "no rule produced this
amount"), no second suppression rule. `StatutorySetByHand.reason` became `notes` — one entry per source —
because two sources can sit on one payslip and a single reason string silently attaches one decision's
justification to the other. **Where both exist, the per-run adjustment wins the report**, because it is
applied after `stComputed` and therefore *is* the figure on the payslip; its own `system` leg records the
standing amount it replaced.

## Consequences

- **The amount is read LIVE on every run — there is no snapshot, so it survives reprocess by construction.**
  The hazard is the mirror image and the reporter is told it: editing an employee's amount and reprocessing a
  run somebody has already reviewed **will move that run's figures**. Only a **closed** run is protected, by
  trigger.
- **The Multi-Cycle Worksheet gains a fifth verdict, `manual_epf_amount`.** `localization/my/multicycle.ts`
  re-derives every figure from wages and never reads a payslip, so without the amount in its option bag every
  manual employee-month matched neither reading and printed a fabricated ringgit difference as `unexplained`
  — on a document that file's own header calls one an accountant signs. The verdict replaces only the two
  **reconciling** outcomes and never masks `would_change` or `unexplained`, because "nothing would change" and
  "the contribution schedule produced this" are different claims and only the first is true here.
- **The `statutory.my` event now carries the EPF election before AND after.** It used to record only where an
  employee ended up, so "was auto, now voluntary_excess at 15%" could not be reconstructed from the log. The
  three after-only keys are **kept** beside the new block for any existing reader.
- **The retired prose is quoted, not deleted**, in `lib/epf-mode-map.ts`, `components/epf-election.tsx`,
  `db/schema.ts`, `localization/my/payroll.ts` and the two guard tests that pinned the coercion
  (`test/epf-modes.test.ts`, `test/epf-info-card.test.ts`). The message key
  `people.detail.epfModeManualFixed` is retired with its wording changed, never removed.
- **Employer EPF never appears on Form EA.** The form carries the employee share only (Part E item 1), so a
  typed employer amount reaches the payslip, the reports and the KWSP file but not the EA — which is the
  form's rule, not an omission here.
