# Malaysia Statutory Figures — Sources & Verification

**Statutory-table version:** `2026.1` (see `MY_STATUTORY_VERSION`)
**Retrieved:** 2026-06-06 (PCB/EPF) · 2026-06-11 (SOCSO/EIS exact schedules)
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
- **Additional remuneration (bonus) — ✅ implemented (difference method).** A bonus's MTD is the
  extra **annual** tax it creates: `pcbAdditional = annualTax(P incl. bonus) − annualTax(P excl. bonus)`,
  taken in the bonus month (`pcb()` / `pcbAdditional()` in `localization/my/payroll.ts`). The bonus
  carries its own 11% EPF relief, pooled under the RM4,000 cap. This is the spec's additional-
  remuneration approach in the same simplified (no Z/X accumulator) model as normal MTD.
  - **EPF:** bonus **is** subject; KWSP fixes the employer rate by the *normal* wage (a ≤RM5,000
    earner stays 13% even if the bonus pushes the month over RM5,000), applied to wage+bonus.
  - **SOCSO + EIS:** annual bonus is **excluded** (not "wages" for PERKESO).
  - Sources: LHDN MTD computerised-calc spec; actpayroll & Talenox bonus-PCB guides;
    foundingbird / ajobthing on EPF-vs-SOCSO/EIS bonus treatment.
- **Known limitations (documented, not bugs):**
  - **Arrears / ESOS** other additional-remuneration types reuse the bonus difference method; only
    bonus is surfaced in the UI so far.
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

## 3. SOCSO / PERKESO (Act 4) — ✅ Verified to the RM6,000 ceiling (2026.1)

- **Source:** PERKESO _Rate of contribution for Employees' Social Security Act 1969 (Act 4)_ —
  the post-Oct-2024-ceiling PDF (file dated 15 Nov 2024), retrieved **2026-06-11**:
  <https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%204.pdf>
- **What we encoded:** `MY_SOCSO_CATEGORY1` = the official First Category band table **verbatim,
  all 64 bands to RM6,000** (rows 1–64). Row 65 (wages exceeding RM6,000 contribute at the top
  band, RM104.15 / RM29.75) is implemented by applying the last band above the table. The pre-raise
  rows were cross-checked unchanged against this newer PDF.
- **History:** 2026.0 had bands only to RM5,000 (the then-retrieved PDF predated the ceiling raise)
  with a rate fallback for (5,000, 6,000] — replaced in 2026.1 by the published amounts.
- **Still not implemented:** Second Category (employer-only, age 60+ / post-invalidity-pension) —
  the published column exists in the same PDF; encode when age-based category selection lands.

## 4. EIS / SIP (Act 800) — ✅ Second Schedule verified (2026.1)

- **Source:** PERKESO _Rate of Contribution Employment Insurance System (Act 800)_ — post-ceiling
  PDF (file dated 15 Nov 2024), retrieved **2026-06-11**:
  <https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%20800.pdf>
- **What we encoded:** `MY_EIS_BANDS` = the official Second Schedule **verbatim, all 64 bands to
  RM6,000** (employer = employee in every band). Row 65 (wages exceeding RM6,000 → RM11.90 each)
  via the same last-band rule. The fixed band amounts ≈ 0.2% of the band midpoint — so they
  **differ from the old 0.2%-of-wage calc** (e.g. RM5,780 → RM11.50 banded vs RM11.56 rated;
  capped wages → RM11.90, not RM12.00).
- **History:** 2026.0 used `MY_EIS_RATES` (0.2%) on the capped wage — replaced in 2026.1.

---

## 5. Leave entitlements — EA 1955 s.60E / s.60F — ✅ Verified (2026-06-10)

- **Encoded in:** `localization/my/leave.ts` (`annualEntitlement`, `sickEntitlement`,
  `entitlement`); granted on hire by `core/org.ts` (`grantLeaveTypes`).
- **Annual (s.60E):** 8 / 12 / 16 days per calendar year for <2 / 2–5 / >5 years of
  service. Granted pro-rated by months remaining in the hire year (common practice;
  s.60E(2) ordinary-rate proportion for incomplete years).
- **Sick, outpatient (s.60F(1)(aa)–(cc)):** **14 / 18 / 22** days per calendar year for
  <2 / 2–<5 / 5+ years of service.
- **Hospitalization (s.60F):** **60 days per calendar year**, and since the
  **Employment (Amendment) Act 2022 (in force 1 Jan 2023)** this is **separate from /
  in addition to** outpatient sick leave — the amendment **deleted the proviso** that
  previously capped both at 60 days in aggregate. (Several older articles still quote
  the pre-2023 aggregate rule; do not reintroduce it.)
- **No proration for sick/hospitalization:** these are per-calendar-year entitlements
  from day one of employment; prorating them for mid-year joiners is a compliance risk.
- **Sources:**
  - Act 265 official text (JTKSM reprint, post-amendment):
    <https://jtksm.mohr.gov.my/sites/default/files/2023-11/Akta%20Kerja%201955%20(Akta%20265).pdf>
  - Lexology — _Employment (Amendment) Act 2022 comes into force on 1 January 2023_
    (proviso deletion → separate hospitalization entitlement).
  - Lexology — _Stop prorating sick leave: the hidden legal risks under section 60F_.
  - Cross-checks: CentralHR sick-leave guide; PayrollPanda leave entitlements.
- **Floor vs. company policy:** these figures are the **non-configurable statutory
  floor**. Admin-configured `leave_policy` rows may be more generous; grants apply
  **max(floor, policy)** per type, and a policy below the minimum is recorded but
  never applied (clamped, flagged in the Leave-config UI). Enforced in
  `core/org.ts`; covered by integration tests.
- **Year boundaries (automated):** `openLeaveYear` (admin → Leave config) posts each
  active employee's new-year entitlements at their **current** service band — the 2y/5y
  band upgrades land there — resolved as max(floor, policy). Unused ANNUAL carries up
  to the policy's `carryForwardMax` (default 0 = forfeit, per s.60E's take-within-the-
  year expectation) via a negative adjustment; SICK/HOSPITALIZATION reset. Idempotent;
  in-year hires are covered by their hire grant. Remaining simplification (deliberate):
  an anniversary that falls mid-year upgrades the band at the **next** year-open, not
  on the anniversary date itself.

---

## 6. Overtime monetization — EA 1955 ss.60A(3)/60(3)/60D(3)/60I — ✅ Verified (2026-06-10)

- **Encoded in:** `localization/my/payroll.ts` (`overtimePay`, `MY_OT_WAGE_CEILING`);
  applied by `core/payroll.ts` (`prefillOvertimeFromAttendance`) from classified
  attendance (ADR-0011). The derivation (ORP, hourly, per-class amounts) is carried on
  each `payroll-batch.input-set` event — every ringgit traces to hours and rates.
- **ORP:** ordinary rate of pay = monthly wages / 26 (s.60I(1A)); hourly = ORP / 8.
  "Wages" basis = basic + fixed allowance (s.2), ex-OT/bonus.
- **Rates:** normal workday OT **1.5×** hourly (s.60A(3)(a)). Rest day (monthly-rated):
  work ≤ half normal hours = **½ day ORP**, more = **1 day ORP** (s.60(3)(b)); beyond
  normal hours = **2×** hourly (s.60(3)(c)). Public holiday: working it earns **2 extra
  days' ORP** (s.60D(3)(a)) and **3×** hourly beyond normal hours (s.60D(3)(aa)). The
  per-day ½/1-day rule is computed per day, never from monthly aggregates.
- **Eligibility:** Employment (Amendment of First Schedule) Order 2022 — employees with
  wages > **RM4,000/month** are outside ss.60/60A(3)/60D(3); the prefill skips them
  (left for a manual/ex-gratia entry). ⚠️ The **manual-worker exception** (entitled
  regardless of wages) is NOT modelled — handle such employees manually.
- **Agency bases (the split that made this slice necessary):**
  | Base | EPF | SOCSO | EIS | PCB |
  | --- | --- | --- | --- | --- |
  | Overtime pay | **Excluded** (KWSP non-liable list) | **Included** | **Included** | **Included** |
  `statutory(wage, profile, additional, overtime)` now takes wages ex-OT plus OT
  separately; previously OT was (incorrectly) in the EPF base.
- **Sources:** Act 265 official text (JTKSM PDF, §5 link); The Malaysian Lawyer —
  _Employees earning up to RM4,000/month will be entitled to overtime payments_ and
  _EA to apply to all employees… RM4,000 threshold_; KWSP — _Employer Mandatory
  Contribution_ (OT in the not-liable list); PERKESO — _Contributions_ (wages include
  overtime payments); AJobThing OT calculation guide (rates cross-check).
- **⚠️ Verify before production:** cross-check a sample month against the JTKSM/MOHR
  overtime calculator; confirm the employer's "wages" composition for ORP (which fixed
  allowances count) with the accountant.

---

## Verification checklist (before production payroll)

- [ ] PCB Table 1 (M/R/B) + reliefs confirmed against the LHDN 2026 spec for the target YA.
- [ ] EPF Third Schedule low-wage band amounts confirmed (or `% + round-up` accepted as policy).
      _(KWSP PDF returns HTTP 403 to programmatic fetch — needs a manual download.)_
- [x] SOCSO RM6,000-ceiling band table obtained and `MY_SOCSO_CATEGORY1` extended past RM5,000
      _(2026.1, official Nov-2024 PDF — see §3)_.
- [x] EIS Act 800 Second Schedule band amounts encoded (replace rate-based calc)
      _(2026.1, official Nov-2024 PDF — see §4)_.
- [x] Additional-remuneration (bonus) MTD implemented (difference method); EPF on bonus + SOCSO/EIS
      exclusion handled. ⚠️ Still verify the bonus-month figure against the LHDN e-PCB calculator.
- [ ] Sign-off recorded (who / date) and `MY_STATUTORY_VERSION` bumped on any change.
