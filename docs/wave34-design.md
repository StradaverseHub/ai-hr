# Wave 3 & 4 — design brief & decision register

Covers consultant items **#9 typed pay components**, **#6 per-statutory-body versioning** (Wave 3) and
**#3 HR analytics & master-data reporting** (Wave 4). Architecture mapped against the real codebase;
the MY statutory facts for #9 are sourced + verified in
[`MY-pay-component-treatment-matrix.md`](architecture/MY-pay-component-treatment-matrix.md).

Status: **owner decisions recorded (2026-06-17) — building Wave 4 first.** Order: **Wave 4 analytics (+ data-gap
fixes) → Wave 3 #9 typed components → #6 DEFERRED.**

---

## #9 — Typed pay components  ·  *high value; the treatment matrix makes it buildable*

Today: `compensation.basicSalary` + a single `monthlyAllowance`, plus per-batch `overtimeAmount` /
`bonusAmount` / `claimAllowance` on `payroll_input`. One catch-all allowance; no way to list components
separately or carry per-component statutory treatment.

**Proposed model (3 tables + treatment flags):**
- `pay_component` — tenant catalog: `code`, `name`, `kind` (Allowance / Deduction / Contribution /
  Non-Payable), and **treatment flags** `includedInEpf` / `includedInSocsoEis` / `includedInPcb` /
  `includedInHrdfBase` / `isNonPayable` / `prorates`. Defaults seeded from the verified treatment matrix.
- `employment_pay_component` — recurring per-employee components (effective-dated like `compensation`).
- `payroll_batch_component` — one-off per-batch components (replaces the fixed `payroll_input` fields).

**Kernel:** roll up each employee's components, then derive the statutory bases *from the flags* —
`wagesExOt = Σ(includedInSocsoEis)`, `hrdfBase = Σ(includedInHrdfBase)`, etc. — preserving the exact
agency-base split (EPF excl OT, SOCSO incl OT) and the Wave 2A HRDF base. **Gated** behind
`TYPED_PAY_COMPONENTS_ENABLED`, with a **byte-identical** backfill (seed BASIC + ALLOWANCE components
from `compensation`; existing payslips reproduce exactly) proven by a compat test before enabling.

**Why the matrix matters:** four distinct "wages" definitions (EPF s.2, PERKESO Act 4, LHDN s.13, HRDF
Circular 5/2018) mean a component can be liable under one and exempt under another — e.g. *overtime*
(EPF no / SOCSO yes), *commission* (SOCSO yes / HRDF no), *BIK* (EPF+SOCSO no / PCB yes). The verified
matrix gives every seeded component a defensible, sourced default flag set.

**Risks:** more surface area (3 tables × 6 flags); statutory-interpretation lock-in (mitigated by citing
the source per flag); admin UX complexity. All manageable behind the flag + compat test.

---

## #6 — Per-statutory-body versioning  ·  *most invasive, least urgent — recommend defer*

Today EPF/SOCSO/EIS/PCB/OT are one `StatutoryRuleset` blob with a single version + effective date;
signed packs (ADR-0020) sign the whole blob. The consultant wants per-body versioning (an EPF rate
change on 1 Jan shouldn't force re-publishing the SOCSO schedule).

**Options:** A (full per-body split → 10 tables, 5× payslip provenance), B (per-section effective dates
in the blob), **C (body-keyed multi-effective-date pack — recommended *if* we do this)**, D (metadata
labels only — doesn't actually solve it).

**Architect's read:** the current effective-dating already neutralises *timing*; the only real gap is
that a SOCSO-only update requires re-publishing the whole (vendor-owned, ~annually-published) pack —
a minor inconvenience, not a correctness problem. Re-architecting the signed-pack system (ADR-0020) for
that benefit is the **lowest-ROI, highest-risk** item in Waves 3–4. **Recommendation: defer #6** until
per-body change frequency justifies it; if built, use **Option C**.

---

## #3 — HR analytics & master-data reporting (Wave 4)  ·  *high visible value, low risk, independent*

We have **statutory** reports (EA/Form E/CP39…) but no **people** analytics. Data mapped; the read side
is largely ready.

**Recommended first tranche (all "ready" with today's data):**
1. **Headcount summary** — active count by company/dept/position, period-over-period.
2. **Active master-data export ± compensation** — the roster (identity + org + employment terms); comp
   columns **admin-only** (Wave 1 #5).
3. **New hires** — monthly cohort.
4. **Terminations** — monthly cohort *(shallow until we capture a termination reason — see gaps)*.
5. **Turnover rate %** — leavers ÷ average headcount.

**Data gaps that limit depth (small, backfill-safe additions):**
- **Termination reason / voluntary-vs-involuntary** — `terminated_on` exists but no reason. Add a
  `employment.terminated` event payload (or `termination_reason` + `is_voluntary` columns). Unlocks a
  real Terminations + Turnover breakdown.
- **Absence classification** — leave is typed (ANNUAL/SICK/…) but `attendance` has no absence-reason.
  Needed for a proper **absenteeism** report.
- **Salary benchmarking** — no external benchmark data exists. Internal-only (median/quartile by
  position) is feasible now; external survey integration is a later effort.

**Privacy:** analytics is **admin-only** (no manager RLS scoping inside the analytics layer; comp
columns gated to `app.is_admin()`). A manager "team reports" module is a later, RLS-scoped effort.

---

## Decision register (owner forks)

| # | Decision | Recommendation |
|---|----------|----------------|
| D1 | **Build order** across Wave 3/4 | ✅ **CHOSEN: Wave 4 analytics first → Wave 3 #9 → #6 deferred.** |
| D2 | **#9 pay-component model** | 3-table typed model gated behind `TYPED_PAY_COMPONENTS_ENABLED`, byte-identical backfill, flag defaults from the verified matrix. *(builds after Wave 4)* |
| D3 | **#6 per-body versioning** | ✅ **CHOSEN: DEFER.** If built later, Option C. |
| D4 | **Wave 4 first tranche** | ✅ **CHOSEN: the 5 reports** (Headcount, Master-data ±comp, New Hires, Terminations, Turnover %). |
| D5 | **Close the data gaps now?** | ✅ **CHOSEN: yes** — add termination-reason + absence-classification capture as part of Wave 4. |
| D6 | **Salary benchmarking** | Internal-only (median/quartile by position) now; external survey data later. *(architect default)* |

**Sourcing caveats carried** (do not encode the amounts without confirming): Schedule 6 PCB exemption
thresholds (petrol RM6,000/yr, gratuity RM1,000/yr) for the current YA; EPF Act s.2 verbatim (KWSP 403,
human to confirm on a rendered page); director's-fee / arrears need a per-case engagement-basis rule.
