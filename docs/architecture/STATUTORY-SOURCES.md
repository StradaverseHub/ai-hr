# Malaysia Statutory Figures — Sources & Verification

**Statutory-table version:** `2026.6` (see `MY_STATUTORY_VERSION`)
**Retrieved:** 2026-06-06 (PCB/EPF) · 2026-06-11 (SOCSO/EIS exact schedules) · 2026-06-19 (EPF Third Schedule Part A #95; SOCSO Lindung-24-Jam/SKBBK #155)
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
- **What we encoded (2026-06-11 — full computerised method with accumulators):**
  - `MY_PCB_BANDS` = the spec's **Table 1 (Value of P, M, R, B)** verbatim, including the
    category-specific B values (negative B encodes the RM400 / RM800 rebate for chargeable
    income ≤ RM35,000).
  - `MY_RELIEFS` = individual **RM9,000**, non-working spouse **RM4,000**, per child **RM2,000**,
    mandatory-EPF relief cap **RM4,000/yr** (enforced CUMULATIVELY across K, K₁, K₂, Kₜ per the
    spec's footnote).
  - Formula (spec §D.1, verbatim): `MTD = [(P − M)·R + B − (Z + X)] / (n + 1)` with
    `P = ∑(Y−K) + (Y₁−K₁) + (Y₂−K₂)·n [+ (Yₜ−Kₜ)] − [D + S + QC + (∑LP + LP₁)]`, where
    `Y₂ = Y₁` and `K₂ = min((cap − K − K₁ [− Kₜ]) / n, K₁)` truncated to 2 dp. Implemented in
    `pcbMonth()` (`localization/my/payroll.ts`).
  - **Accumulators (ADR-0014):** ∑(Y−K), K (EPF claimed), X (MTD paid) are **derived by replaying
    the tax year's prior payslips** per employment in `generatePayslips`, seeded from **TP3 /
    opening balances** on the statutory profile (spec §E.10: TP3 amounts enter the formula as
    (Y−K), X, Z and never appear on payslips or the EA). Each payslip stamps its `pcbMeta`
    snapshot for reproducibility.
  - **Rounding (spec §E.1–4, verbatim):** intermediate values truncate to 2 dp; the MTD rounds
    **up** to the next 5 sen (287.02→287.05, 152.06→152.10); an MTD below **RM10** is not
    deducted (applied separately to normal and additional).
- **Additional remuneration (bonus) — ✅ spec §D.2 Steps 1–5 with accumulators.** Step 1 computes
  the normal-remuneration MTD and the year total `X + [C]×(n+1)`; Steps 2–3 recompute P and the
  annual tax **including** (Yₜ−Kₜ) with K₂ re-projected; Step 4's difference is the bonus MTD;
  Step 5 sums. The bonus carries its own 11% EPF relief, pooled under the cumulative RM4,000 cap.
  - **EPF:** bonus **is** subject. ⚠️ **CORRECTED IN r210 (item bdf7d248).** This entry previously
    recorded that KWSP fixes the employer rate by the *normal* wage — a ≤RM5,000 earner staying at 13%
    even once the bonus pushed the month over RM5,000. The customer rejected that reading twice, with
    figures, and the approved rule is now: the month's normal wage and additional remuneration are
    ADDED and the Third Schedule is read ONCE on that total, so the 13%/12% employer step follows the
    whole month. On the reporter's own case (RM7,413.00 + RM1,650.71) that is 1,001/1,092 for the month
    against the old 1,007/1,099, and the bonus run contributes 176/192. **This line has not been
    re-verified against an LHDN/KWSP source document since the change — it records the customer's
    approved reading, and the ✅ below refers to the MTD exhibits, not to this bullet.**
  - **SOCSO + EIS:** annual bonus is **excluded** (not "wages" for PERKESO).
- **✅ Verified against the spec's own Exhibit 5 worked example** (golden tests): Jan RM110.00 →
  Feb RM110.00 (accumulated) → Mar RM108.20 (TP1 RM300) → Apr bonus RM8,250: normal 106.20 +
  additional 727.50 = **RM833.70**, with P₁/P₂ intermediate values matched to the sen.
- **TP1 deductions + zakat — ✅ captured per employee per batch** (2026-06-11): LP₁ and zakat
  inputs on the draft batch; zakat offsets the MTD per the §E.5 tables verbatim (normal first,
  remainder offsets additional; the FULL zakat accrues to Z) — golden-tested against all nine
  table rows; ∑LP and Z accumulate through the payslip replay.
- **Non-resident — ✅ implemented**: flat **30%** of taxable remuneration (spec §D.a, golden:
  RM3,000 → RM900), toggled by the statutory profile's residency flag; §E rounding applies.
- **Disabled individual (OKU) further deduction — ⚠️ RATE-ONLY, NOT VERIFIED. NEEDS SIGN-OFF.**
  `MY_RELIEFS.disabledIndividual` = **RM7,000**, the further deduction under **s.46(1)(g) ITA 1967**
  on top of the RM9,000 individual deduction, raised from RM6,000 by Budget 2025 with effect from
  **YA2025** (item `d64d0df4`, statutory-table version **2026.6**).
  - **Source (secondary):** PwC _Worldwide Tax Summaries_ — Malaysia · Individual · Deductions
    (YA2026 personal reliefs: self disabled **MYR 7,000** further relief).
    <https://taxsummaries.pwc.com/malaysia/individual/deductions>
  - **Why it is not ✅ Verified:** every other figure in `MY_RELIEFS` was transcribed from the LHDN MTD
    computerised-calculation spec PDF itself. That URL now returns **HTTP 404**, so this figure could
    only be sourced from a high-trust secondary reference. A secondary source is not the primary one.
  - **Blast radius if wrong:** bounded and opt-in. The deduction is applied **only** to an employee an
    admin has explicitly flagged as a disabled individual on the Tax Information card, so no existing
    employee's PCB moves until someone makes that claim. Nothing else in the ruleset changed.
  - **Action before a real filing:** confirm RM7,000 (and whether the MTD spec expresses it inside `D`
    or as a separate deduction) against the current LHDN publication, then either record the sign-off
    below or correct the figure and rebuild the bundled pack
    (`node --import tsx scripts/statutory-pack-build-my.ts`).
- **Disabled spouse further deduction — ⚠️ RATE-ONLY, NOT VERIFIED. NEEDS SIGN-OFF.**
  `MY_RELIEFS.disabledSpouse` = **RM5,000**, the further deduction under **s.47(1)(b) ITA 1967** on top
  of the RM4,000 spouse deduction (item `d64d0df4`, statutory-table version **2026.7**).
  - **Source (secondary):** PwC _Worldwide Tax Summaries_ — Malaysia · Individual · Deductions
    (YA2026 personal reliefs: disabled spouse **MYR 5,000** further relief).
    <https://taxsummaries.pwc.com/malaysia/individual/deductions>
  - **Why it is not ✅ Verified:** identical reason to the OKU figure above — the LHDN MTD spec PDF URL
    returns HTTP 404, so only a high-trust secondary reference was available.
  - **Blast radius if wrong:** bounded and opt-in, and narrower still than the OKU figure. It is applied
    only to an employee an admin has flagged as having a disabled spouse **AND** whose tax category is
    **2** (married, spouse not working) — the same gate the RM4,000 spouse deduction sits behind.
    Categories 1 and 3 store and display the flag but their PCB is untouched.
  - **Action before a real filing:** confirm RM5,000 against the current LHDN publication, then record
    the sign-off below or correct the figure and rebuild the bundled pack.
- **Per-category child deductions (LHDN s.48) — ⚠️ RATE-ONLY, NOT VERIFIED. NEEDS SIGN-OFF (5 figures).**
  `MY_RELIEFS.childByCategory` (item `d64d0df4`, statutory-table version **2026.7**):

  | Category | Amount | s.48 case |
  | --- | --- | --- |
  | `under_18` | RM2,000 | child under 18 |
  | `study_preu` | RM2,000 | 18+, unmarried, full-time pre-university study |
  | `study_tertiary` | RM8,000 | 18+, unmarried, full-time diploma/degree study and above |
  | `disabled` | RM6,000 | disabled child (OKU) |
  | `disabled_study` | RM14,000 | disabled child in full-time higher education (RM6,000 + RM8,000) |

  - **Source (secondary):** PwC _Worldwide Tax Summaries_ — Malaysia · Individual · Deductions (YA2026
    child reliefs). <https://taxsummaries.pwc.com/malaysia/individual/deductions>
  - **Why it is not ✅ Verified:** same 404 as above. Note the flat `MY_RELIEFS.perChild` = RM2,000 that
    the projection has always used is itself the `under_18` figure, so this table does not contradict any
    previously verified number — it breaks one number out into five.
  - **Blast radius if wrong:** bounded and opt-in. These amounts are read **only** for an employee whose
    child-relief mode is `auto_table` and against whom a category grid has been keyed. Every employee on
    `manual` or `auto` keeps `children × perChild` to the cent, which is exactly today's arithmetic.
    A child recorded at the **50%** share contributes exactly half the amount above.
  - **Action before a real filing:** confirm all five against the current LHDN publication, then record
    the sign-off below or correct the figures and rebuild the bundled pack.
- **Where the seven pending figures are visible in the running system:** Payroll → Configuration → PCB
  renders all of them (`disabledIndividual`, `disabledSpouse`, and the five `childByCategory` amounts)
  under **"Reliefs awaiting sign-off"**, each carrying an *Awaiting sign-off* badge, resolved through the
  same optional-with-fallback path `pcbMonth` uses — so the screen shows the number the kernel actually
  applies rather than a second copy that can drift.
- **Known limitations (documented, not bugs):**
  - **Disabled spouse** is now implemented (item `d64d0df4`, above) — gated to tax category 2.
  - **Category-weighted child relief** is implemented for the `auto_table` child-relief mode ONLY.
    An employee on `manual` or `auto` still gets the flat `perChild × numChildren`. The five LHDN
    s.48 CATEGORIES captured per child on the Family tab (item `6c635212`) are still **not** used to
    weight the deduction automatically — deriving the two DISABLED categories is impossible from the
    Family register today (it has `dateOfBirth`, `isStudent`, `studyLevel`, `studyCountry`, but no
    independent child-disability flag), so `auto` remains head-count-weighted. This deferral is
    recorded in `d64d0df4`'s approved plan.
  - **Arrears / ESOS** other additional-remuneration types reuse the bonus steps; only bonus is
    surfaced in the UI so far.
  - **REP / knowledge-worker / C-suite** special categories are not implemented.
  - **Cross-employer concurrent employment** (ADR-0009) accumulates per employment, not per
    person — the ADR-0010 flagged gap stands.

## 2. EPF / KWSP — ✅ Part A/E/F implemented + accountant-signed (#95)

- **Source:** EPF Act 1991 **Third Schedule** (Part A — citizen/PR < 60).
  <https://www.kwsp.gov.my/en/epf-act-1991-third-schedule> ·
  <https://www.kwsp.gov.my/documents/d/guest/jadual-ketiga-bi-pdf-1> _(direct fetch returns HTTP 403;
  transcribed via Internet Archive mirror of the official "Jadual Ketiga BI" PDF.)_
- **What we encoded (2026.2):** the **exact Part A band table** — `MY_EPF_THIRD_SCHEDULE_PART_A` in
  `localization/my/statutory-tables.ts`. The contribution on the **normal monthly wage** is the band
  amount, **not** a flat percentage of the exact wage: band amount = `ceil(rate × band-upper-limit)`,
  bands **RM20-wide** for wages 0.01–5,000 then **RM100-wide** for 5,000.01–20,000; employee **11%**,
  employer **13%** (≤RM5,000) stepping to **12%** (>RM5,000); first band RM0.01–10 is **NIL/NIL**. Above
  RM20,000 the schedule ends and the exact percentage applies (employee 11%, employer 12%), still rounded
  up to RM1. This **replaces** the prior `% on exact wage` approximation, which under/over-stated by
  ≤RM1/side inside a band (e.g. wage RM2,990 → approximation 329/389, schedule **330/390**). Golden test:
  `test/epf-third-schedule.test.ts`.
- **✅ Accountant sign-off — OBTAINED (owner-confirmed 2026-06-19).** EPF Part A/E/F rates + the
  Third-Schedule banding are signed off against YiWei Law's statutory deck (10 Jun 2026). _Audit:_ fill the
  reviewer name + date below for the formal worksheet record.
  - Reviewer: __________________  Date: 2026-06-19  KWSP doc version: Jadual Ketiga (eff 1 Oct 2025)
  - [x] Part A in force: bands/rates above (signed). Spot-check vs the live KWSP calculator at go-live.
  - [x] **Part F — non-citizen 2% / 2% (eff 1 Oct 2025)** — IMPLEMENTED (flat 2%/2%, round up to RM1),
        gated by the new `employee_statutory_my.epf_citizenship = 'non_citizen'`. Sourced from KWSP Jadual
        Ketiga (1 Oct 2025) + YiWei Law deck (slide 9). _Sign-off:_ confirm the effective date for the
        tenant's periods, flat-vs-banded, and the wage base; pre-1998 legacy (5.5% / 6–6.5%) is **not**
        auto-applied (rare — flag if any such grandfathered member exists).
  - [x] **Part E — Malaysian citizen 60–<75** (employee 0% / employer 4% banded) + **age ≥ 75 → no EPF**
        — IMPLEMENTED (`MY_EPF_THIRD_SCHEDULE_PART_E`), age derived from `date_of_birth` (same basis as
        SOCSO Category 2). Sourced from the deck (slides 7–8). _Sign-off:_ confirm the 4% employer rate +
        the age-75 cutoff; PR 60+ is treated as non-citizen 2%/2% pending the Parts C/D variants.
  - [ ] Bonus/additional combination rule (band on the base wage + percentage on the excess) matches KWSP
        guidance; >RM20,000 percentage tail confirmed; round-up direction (up to RM1) confirmed.
  - Reviewer: __________________  Date: __________  KWSP doc version verified: __________

## 3. SOCSO / PERKESO (Act 4) — ✅ Verified to RM6,000 + SKBBK / Lindung 24 Jam (2026.3, #155)

- **🆕 Lindung 24 Jam / SKBBK (Akta A1788) — MANDATORY from 1 Jun 2026.** A new **employee-paid** leg
  (Phase 1 = **0.75%**, gazetted per band) added **on top of** the existing SOCSO — the employer and
  employee (Invalidity) columns are **unchanged**. 60+ and **foreign** workers (Category 2) pay it too.
  Encoded as `MY_SOCSO_SKBBK_PHASE1` (64 values) overlaid onto both categories
  (`MY_SOCSO_CATEGORY1_SKBBK` / `..._2_SKBBK`); `socso()` returns `{ employer, employee, skbbk }` and the
  kernel deducts SKBBK from net pay. Golden test: `test/socso-skbbk.test.ts`.
  Sources (sourced 2026-06-19, cross-checked across 3 PDFs): PERKESO
  <https://www.perkeso.gov.my/images/lindung/lindung-24-jam/NewContributionRateIncludingSKBBK.pdf> ·
  Pekeliling Majikan Bil. 02/2026 · Lindung-24-Jam FAQ.
  **🔴 Sign-off before go-live:** (1) Phase-1 0.75% still current / no Phase-2 date inside the first run;
  (2) category by **entry age** (Cat 1 entered <55; Cat 2 entered 55+ / reached 60) — we currently select
  by *current* age ≥60 + non-citizen (approximation; confirm against Chin Hin's records); (3) payslip
  shows the SKBBK line (circular 5.8) — **display line still TODO**; (4) new combined SOCSO+EIS textfile
  (mandatory 1 Oct 2026) — Phase P (#73).
  - **(4) as built (r296).** The cutover is encoded ONCE, as `PERKESO_SKBBK_MANDATORY_FROM` in
    `lib/perkeso-socso-file.ts`, and `perkesoLayoutForPeriod()` is the only thing that applies it: a
    contribution month before 10/2026 is written to the layout of the customer's own **accepted**
    BRG8A.txt (`test/fixtures/perkeso-brg8a.txt`, v1.0 of 22 Jul 2022, space-padded, **no SKBBK box**);
    10/2026 onward to v2.0 of 13 Feb 2026 (zero-padded, SKBBK at positions 239-244, Filler 1 shortened to
    245-258). Both download screens now go through that one writer — before r296 they went through two
    that disagreed. Source for the v2.0 table, sourced 2026-06-20 and unchanged by r296:
    <https://www.perkeso.gov.my/images/borang/lindung24jam/formatteksfail.pdf>.
  - **🔴 STILL OPEN, and it cannot be closed from inside this repository:** (a) **which layout ASSIST
    accepts today is UNKNOWN** — v1.0 is byte-for-byte a file PERKESO accepted in January 2026, v2.0 has
    never been uploaded from this system and its pad character, SKBBK box and shortened Filler 1 are
    transcribed from a specification, not read off an accepted file; (b) whether the 1 Oct 2026 cutover is
    measured against the **contribution month** (what we assume, and say so in code) or against the
    **upload date** — they differ only for a late or amended return; (c) SKBBK has been deducted since
    1 Jun 2026 and the accepted layout has **no box for it**, so a Jun–Sep 2026 upload does not pay it —
    the amount is named in the file's validation report and recorded on the artefact as
    `skbbkNotCarriedCents`, and how PERKESO wants it settled during the transition is **UNKNOWN**.
    Each needs a real submission or the current specification. See
    `docs/CUSTOMER-DEPLOYMENT-READINESS.md` §3.1.
- **Source (base table):** PERKESO _Rate of contribution for Employees' Social Security Act 1969 (Act 4)_ —
  the post-Oct-2024-ceiling PDF (file dated 15 Nov 2024), retrieved **2026-06-11**:
  <https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%204.pdf>
- **What we encoded:** `MY_SOCSO_CATEGORY1` = the official First Category band table **verbatim,
  all 64 bands to RM6,000** (rows 1–64). Row 65 (wages exceeding RM6,000 contribute at the top
  band, RM104.15 / RM29.75) is implemented by applying the last band above the table. The pre-raise
  rows were cross-checked unchanged against this newer PDF.
- **History:** 2026.0 had bands only to RM5,000 (the then-retrieved PDF predated the ceiling raise)
  with a rate fallback for (5,000, 6,000] — replaced in 2026.1 by the published amounts.
- **Second Category — ✅ implemented** (2026-06-11): the same PDF's "Contribution By Employer
  Only" column encoded verbatim (`MY_SOCSO_CATEGORY2`, 64 bands + top-band rule). The engine
  selects Category 2 at **age ≥ 60** (from `person.date_of_birth` at period end; missing DOB →
  Category 1). EIS additionally **stops at 60** (Act 800 covers 18–60; the 57+-no-prior-
  contribution exemption maps to the `eisEligible` flag, now honored by the engine — sources:
  PERKESO contributions page + Act 800 PDF, perkeso.gov.my, retrieved 2026-06-11).

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

## 7. LHDN TP1 (1/2026) — deduction & rebate catalogue — ⚠️ Transcribed from the reporter's uploaded form

- **Source:** _PCB FORM /TP1 (1/2026)_ — "Individual Tax Deduction and Rebate Claim Form for Monthly
  Tax Deduction Purposes (PCB)", Income Tax (Deductions from Remuneration) Regulations 1994, prescribed
  under s.152 ITA 1967. **Supplied as an attachment on board item `7ad37961`**, not retrieved from
  hasil.gov.my. Two A4 pages, producer metadata `Microsoft Word 2019`.
- **Encoded in:** `localization/my/statutory-tables.ts` → `MY_TP1_2026`, surfaced on the pack contract
  as `payroll.taxReliefCatalogue` and consumed by `core/tax-relief.ts`.
- **What we encoded** — the ANNUAL LIMIT (RM) column, item by item, exactly as the form prints it:

  | Item | Annual limit | Printed sub-limits |
  | --- | --- | --- |
  | C1 Parents/grandparents | 8,000 | (c) full medical check-up incl. vaccination 1,000 |
  | C2 Basic support equipment | 6,000 | — |
  | C3 Study fees (self) | 7,000 | (c) skills / personal development 2,000 |
  | C4 Medical expenses | 10,000 | (c) 1,000 · (d) 1,000 · (e) 1,000 · (f) 10,000 |
  | C5 Lifestyle | 2,500 | — |
  | C6 Lifestyle — sport | 1,000 | — |
  | C7 Breastfeeding equipment | 1,000 | once every 2 years of assessment |
  | C8 Childcare / kindergarten | 3,000 | — |
  | C9 National Education Savings Scheme | 8,000 | — |
  | C10 Alimony | 4,000 | — |
  | C11 Voluntary EPF / life insurance | **7,000 (group)** | (a) 4,000 incl. mandatory EPF · (b) 3,000 |
  | C12 Private retirement / deferred annuity | 3,000 | — |
  | C13 Education & medical insurance | 4,000 | — |
  | C14 PERKESO contributions | 350 | — |
  | C15 EV charging / food-waste / CCTV | **2,500** | composting once/3 years; shredder + CCTV once/2 years |
  | C16 First home loan interest | *(none — per band)* | (a) ≤RM500,000 → 7,000 · (b) >RM500,000–750,000 → 5,000 |
  | C17 Domestic tourism / cultural & arts | 1,000 | — |
  | D1 Rebate | *(none printed)* | (b) Umrah / religious travel: 2 claims in a lifetime |

- **Two figures the approved plan did not carry, and the form does:** **C11's RM7,000 group limit**
  (the item description recorded only its 4,000/3,000 sub-limits) and **C15's RM2,500** (the plan
  expected it to be unsourced and to ship as `limit: null`). Both are printed in the form's own Annual
  Limit column and are encoded. Pinned in `test/tp1-2026-form.test.ts`.
- **What ships as `null`, deliberately (ADR-0008):** C16's group limit — the form gives its two bands
  their own limits and their own Current/Accumulated rows, so there is no group figure to encode — and
  both Section D rebate lines, against which the form prints no limit at all. A `null` is captured,
  summed and printed; nothing blocks on it.
- **Frequency rules are CAPTURED AND PRINTED, NEVER ENFORCED.** "Once every 2 years of assessment"
  needs the employee's claim history at LHDN, which this system does not hold. A wrong refusal on a
  valid claim is worse than no check.
- **⚠️ Verify before production:** the attached PDF is an office document, not a file retrieved from
  hasil.gov.my by us. Re-download TP1 (1/2026) from the LHDN forms page and diff the Annual Limit
  column against the table above before a real filing relies on it. Until then this section is
  **transcribed, not verified**, on the same footing as the RATE-ONLY entries in §1.

---

## Verification checklist (before production payroll)

- [x] PCB Table 1 (M/R/B) + reliefs confirmed against the LHDN 2026 spec; full computerised
      method (accumulators + §E rounding) verified against the spec's Exhibit 5 worked example
      _(2026-06-11; golden tests in `test/slice0.test.ts`)_.
- [x] EPF Third Schedule **Part A** band table implemented exactly (#95) — `MY_EPF_THIRD_SCHEDULE_PART_A`,
      golden test `test/epf-third-schedule.test.ts` _(2026.2; transcribed via IA mirror)_.
- [ ] **EPF Part A accountant sign-off** + **Part F non-citizen 2%/2%** + **Part E age-60** — see §2.
      🔴 Go-live gate (G1) before any real Chin Hin pay run.
- [x] SOCSO RM6,000-ceiling band table obtained and `MY_SOCSO_CATEGORY1` extended past RM5,000
      _(2026.1, official Nov-2024 PDF — see §3)_.
- [x] EIS Act 800 Second Schedule band amounts encoded (replace rate-based calc)
      _(2026.1, official Nov-2024 PDF — see §4)_.
- [x] Additional-remuneration (bonus) MTD implemented (spec §D.2 Steps 1–5 with accumulators);
      EPF on bonus + SOCSO/EIS exclusion handled. Bonus month verified against Exhibit 5
      (RM727.50 / RM833.70 total).
- [ ] Sign-off recorded (who / date) and `MY_STATUTORY_VERSION` bumped on any change.
- [ ] **TP1 (1/2026) catalogue re-checked against the LHDN forms page** — see §7. The figures came from
      an attachment on a board item, not from the agency's own site.
