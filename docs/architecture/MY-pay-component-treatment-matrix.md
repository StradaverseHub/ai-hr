# Malaysia pay-component statutory treatment matrix

Sourced from official `.gov.my` sources and adversarially re-verified (2026-06-17). This is the
authoritative reference for the **default treatment flags** of typed pay components (Wave 3 #9) — each
component declares whether it is liable for EPF, SOCSO/EIS, PCB, and the HRDF levy base.

> **Four distinct "wages" definitions — they are NOT interchangeable.** A component can be liable under
> one regime and exempt under another. This is the whole reason typed components need per-body flags.

| Regime | Definition | Key source |
|--------|-----------|-----------|
| **EPF** | EPF Act 1991 s.2 — all money remuneration under a contract of service; **includes** bonus/commission/allowance; **excludes** (a) service charge, (b) overtime, (c) gratuity, (d) retirement benefit, (e) retrenchment/layoff/termination benefit, (f) travelling allowance/concession, (g) Minister-exempted. **Money only.** | kwsp.gov.my (EPF Act 1991 s.2) |
| **SOCSO / EIS** | Act 4 s.2 (EIS Act 800 identical) — all money remuneration; **includes** salary, **overtime**, commission & service charge, leave pay, allowances; **excludes** statutory-fund payments, travelling claims, gratuity, **annual bonus**. Capped at RM6,000/mo (1 Oct 2024). | perkeso.gov.my SEP-2020 RISALAH "Definition of Wages" |
| **PCB** | ITA 1967 s.13(1) — gross employment income: (a) wages/fee/commission/bonus/gratuity/perquisite/allowance, (b) BIK, (c) VOLA, (d) unapproved fund, (e) compensation for loss. Taxable unless Schedule 6 / gazette exempts. | hasil.gov.my ITA s.13(1); PR 5/2019 (perquisites) |
| **HRDF** | HRD Corp Circular 5/2018 Att. A — **basic salary + FIXED allowances + paid leave + wage arrears** only; excludes all non-fixed/variable allowances, OT, bonus, commission, gratuity, reimbursements, fund contributions, non-citizens. | hrdcorp.gov.my Circular 5/2018 |

## The matrix (Y = liable, N = not, C = conditional)

| Pay component | EPF | SOCSO/EIS | PCB | HRDF | Confidence |
|---------------|:---:|:---:|:---:|:---:|---|
| Basic salary / wages | Y | Y | Y | Y | verified |
| Fixed housing allowance | Y | Y | Y | Y | verified |
| Fixed transport / travel allowance | N | N | **C** | N | verified |
| Fixed cost-of-living allowance (COLA) | Y | Y | Y | Y | verified |
| Shift allowance | Y | Y | Y | **N** | verified |
| Meal allowance | Y | Y | **C** | N | verified |
| Attendance allowance / incentive | Y | Y | Y | **N** | verified |
| Production / performance incentive | Y | Y | Y | **N** | verified |
| **Overtime** | **N** | **Y** | Y | N | verified |
| Contractual / annual bonus | **C** | **N** | Y | N | verified |
| Commission | Y | Y | Y | **N** | verified |
| Director's fee | **C** | **C** | Y | **C** | ambiguous (engagement basis) |
| Gratuity (discharge / retirement) | N | N | **C** | N | verified |
| Travel reimbursement (receipted) | N | N | N | N | verified |
| Medical reimbursement (receipted) | N | N | N | N | verified |
| Benefits-in-kind (BIK) / perquisites | **N** | **N** | **Y** | N | verified |
| Leave pay (annual/sick/maternity/PH/rest) | Y | Y | Y | Y | verified |
| Arrears of wages | Y | Y | Y | Y | ambiguous (follows underlying) |
| Service charge / tips | **N** | **Y** | Y | N | verified |

### The asymmetries the engine must encode
- **Overtime:** EPF **no**, SOCSO/EIS **yes**, PCB yes, HRDF no. (Already in the calculator.)
- **Service charge / tips:** EPF **no** (s.2(a)), SOCSO/EIS **yes**, PCB yes (taxable perquisite, PR 5/2019), HRDF no.
- **Contractual bonus:** EPF conditional-yes (s.2 includes bonus), SOCSO/EIS **no** (annual bonus excluded), PCB yes, HRDF no.
- **Commission:** EPF yes, SOCSO/EIS yes, PCB yes, **HRDF no**.
- **BIK / perquisites:** EPF **no**, SOCSO/EIS **no** (both are "money" definitions), PCB **yes**, HRDF no.

### Conditional cases (need a per-case rule, not a static flag)
- **Fixed travel allowance (PCB):** taxable, but petrol/travel for official duties is exempt up to **RM6,000/yr** (Sch 6); excess taxable.
- **Meal allowance (PCB):** exempt if provided regularly on the same terms (Sch 6); otherwise taxable.
- **Gratuity (PCB):** taxable, but Sch 6 reliefs apply (full exemption on retirement at 55 / ill-health, or RM1,000 per completed year of service).
- **Bonus (EPF):** s.2 includes "bonus" → contractual bonus is EPF-liable; ex-gratia / Minister-exempted bonuses differ — confirm the bonus type.
- **Director's fee / arrears:** turn on the engagement basis (contract of service vs office-holder) and what the underlying payment relates to.

## Verification + caveats (from the adversarial re-check)
All 19 flags are **substantively correct**. Defects found were citation-level only, not flag-level:
- HRD Corp paragraph numbering should reference Circular 5/2018 Att. A §3 sub-items (i. wages, ii. fixed
  allowances, iii. employee, iv. wages exempted) rather than "para 3(i)/3(iii)/3(iv)".
- BIK should cite **PR 11/2019** (current), not PR 3/2013.
- Reimbursement non-taxability rests on the general "repayment of expense ≠ s.13(1)(a) income" principle
  (PR 5/2019 para 3.7 is only the *definition* of reimbursement).

**Open items before go-live (do not encode the conditional amounts without confirming):**
- EPF Act 1991 s.2 verbatim was captured via the KWSP search index (kwsp.gov.my returns 403 to automated
  fetch); a human should confirm the exact paragraph on a rendered KWSP page.
- The Schedule 6 exemption **amounts** for the current YA (petrol RM6,000/yr, gratuity RM1,000/yr) must be
  confirmed against live LHDN tables before the calculator applies them.
- Director's-fee and arrears classification needs a per-case engagement-basis rule.

**Sources:** LHDN ITA s.13(1) (phl.hasil.gov.my/pdf/pdfam/3638.pdf); LHDN PR 5/2019 Perquisites
(phl.hasil.gov.my/pdf/pdfam/PR_05_2019_2.pdf); HRD Corp Employers' Circular 5/2018
(hrdcorp.gov.my); PERKESO SEP-2020 RISALAH (perkeso.gov.my); EPF Act 1991 s.2 (kwsp.gov.my).
