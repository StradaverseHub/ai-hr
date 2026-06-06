# Malaysia Statutory Figures — Sources & Verification

**Statutory-table version:** `2026.0` (see `MY_STATUTORY_VERSION`)
**Retrieved:** 2026-06-06
**Encoded in:** `localization/my/statutory-tables.ts`, applied by `localization/my/payroll.ts`

> ⚠️ **These figures are encoded from official sources to the best of our ability, but they are
> NOT a substitute for professional sign-off.** Before running real payroll, an accountant /
> payroll officer must verify every row marked _Unverified_ or _Rate-only_ below against the
> current official publication. Payroll miscalculation is a legal and financial liability.

Each payslip stores the `version` string above in its `statutory` JSON, so any future correction
to these tables is traceable to the exact runs it affects.

---

## 1. PCB / MTD (income tax) — ✅ Verified

- **Source:** LHDN — _Specification for MTD Calculations Using Computerized Calculation for 2026_
  (cover states **"Updated: 01 January 2026"**).
  <https://www.hasil.gov.my/media/arvlrzh5/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf>
- **Cross-check (brackets):** LHDN Tax Rate page (AY2023–2025; unchanged for AY2026).
  <https://www.hasil.gov.my/en/individual/individual-life-cycle/income-declaration/tax-rate/>
- **What we encoded:**
  - `MY_PCB_BANDS` = the spec's **Table 1 (Value of P, M, R, B)** verbatim, including the
    category-specific B values (negative B encodes the RM400 / RM800 rebate for chargeable
    income ≤ RM35,000).
  - `MY_RELIEFS` = individual **RM9,000**, non-working spouse **RM4,000**, per child **RM2,000**,
    mandatory-EPF relief cap **RM4,000/yr**.
  - Formula: `MTD = [(P − M)·R + B − (Z + X)] / (n + 1)`. We implement the **resident, normal
    remuneration** case for **constant monthly income**, which reduces to `annualTax / 12`.
- **Known limitations (documented, not bugs):**
  - **Additional remuneration** (bonus, arrears, ESOS) uses a different spec formula — not yet
    implemented. Current code treats all pay as normal remuneration.
  - **Z** (zakat) and **X** (prior-month accumulated MTD) are assumed 0 — correct only when there
    is no YTD accumulation. Needs per-employee YTD wiring for mid-year hires / variable pay.
  - **Non-resident** employees (flat 30%) and the REP / knowledge-worker / C-suite categories are
    not implemented.
  - Employee **tax category** (1/2/3) and **child count** default to Category 1 / 0 children until
    the employee tax profile is captured (follow-up task).

## 2. EPF / KWSP — ✅ Rates verified, ⚠️ low-wage banding approximated

- **Source:** KWSP Mandatory Contribution + Third Schedule, EPF Act 1991 (rates **eff. Oct 2025**).
  <https://www.kwsp.gov.my/en/employer/responsibilities/mandatory-contribution>
  <https://www.kwsp.gov.my/documents/d/guest/jadual-ketiga-bi-pdf-1> _(returned HTTP 403 on fetch;
  rates below are the long-standing standard statutory percentages — confirm the PDF directly.)_
- **What we encoded:** employee **11%**; employer **13%** for wage ≤ RM5,000, else **12%**; each
  contribution **rounded up to the next ringgit**.
- **⚠️ Verify:** for wages ≤ RM5,000 the Third Schedule prescribes fixed amounts per **RM20 wage
  band**. Our `% + round-up` matches at most salary points but may differ by a few sen in some
  bands. Non-citizen rate (2% / 2%) and the age-60+ reduced rates are not implemented.

## 3. SOCSO / PERKESO (Act 4) — ⚠️ Verified ≤ RM5,000, ceiling band UNVERIFIED

- **Source:** PERKESO _Rate of Contribution, Act 4_ (First Category — Employment Injury + Invalidity).
  <https://www.perkeso.gov.my/images/dokumen/Rate_of_Contribution_ACT_4.pdf>
- **What we encoded:** `MY_SOCSO_CATEGORY1` = the official band table **verbatim up to RM5,000**
  (employer/employee amounts per wage band).
- **🔴 Verify (important):** the **wage ceiling was raised RM5,000 → RM6,000 effective 1 Oct 2024**,
  but the official PDF we retrieved **still caps at RM5,000**. For wages in **(RM5,000, RM6,000]**
  the calculator falls back to the statutory **% (1.75% employer / 0.5% employee)** on the capped
  wage — these band amounts are **NOT from the official schedule** and must be replaced with the
  current PERKESO _Jadual Caruman_ (RM6,000 version). Second Category (age 60+) is not implemented.

## 4. EIS / SIP (Act 800) — ⚠️ Rate-only

- **Source:** PERKESO EIS, rate **0.2% employer / 0.2% employee**, RM6,000 ceiling.
  <https://perkeso.gov.my/en/rate-of-contribution.html>
- **What we encoded:** the **rate** on the capped wage (`MY_EIS_RATES`, `MY_CONTRIB_CEILING`).
- **⚠️ Verify:** the exact **Act 800 Second Schedule band amounts** are not yet encoded; rate-based
  values may differ from the published per-band figures by a few sen.

---

## Verification checklist (before production payroll)

- [ ] PCB Table 1 (M/R/B) + reliefs confirmed against the LHDN 2026 spec for the target YA.
- [ ] EPF Third Schedule low-wage band amounts confirmed (or `% + round-up` accepted as policy).
- [ ] SOCSO RM6,000-ceiling band table obtained and `MY_SOCSO_CATEGORY1` extended past RM5,000.
- [ ] EIS Act 800 Second Schedule band amounts encoded (replace rate-based calc).
- [ ] Additional-remuneration (bonus) MTD formula implemented, or bonuses excluded from auto-PCB.
- [ ] Sign-off recorded (who / date) and `MY_STATUTORY_VERSION` bumped on any change.
