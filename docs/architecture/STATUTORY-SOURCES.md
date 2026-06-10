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
- **Model simplifications (deliberate):** entitlements are granted once at hire at the
  0-year band; **service-band upgrades at the 2- and 5-year anniversaries and
  calendar-year resets/carry-forward are not yet automated** (ledger supports both via
  `accrual`/`adjustment` entries — future slice).

---

## Verification checklist (before production payroll)

- [ ] PCB Table 1 (M/R/B) + reliefs confirmed against the LHDN 2026 spec for the target YA.
- [ ] EPF Third Schedule low-wage band amounts confirmed (or `% + round-up` accepted as policy).
- [ ] SOCSO RM6,000-ceiling band table obtained and `MY_SOCSO_CATEGORY1` extended past RM5,000.
- [ ] EIS Act 800 Second Schedule band amounts encoded (replace rate-based calc).
- [x] Additional-remuneration (bonus) MTD implemented (difference method); EPF on bonus + SOCSO/EIS
      exclusion handled. ⚠️ Still verify the bonus-month figure against the LHDN e-PCB calculator.
- [ ] Sign-off recorded (who / date) and `MY_STATUTORY_VERSION` bumped on any change.
