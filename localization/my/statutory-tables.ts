/**
 * Malaysia statutory tables — rules-as-data (ADR-0008).
 *
 * Every figure here is transcribed from an official publication and carries its effective
 * date, source, and a `verified` flag. Full provenance + the human verification checklist
 * live in docs/architecture/STATUTORY-SOURCES.md.
 *
 * ⚠️ CHANGING A NUMBER HERE IS A THREE-STEP JOB, NOT ONE. Item 04b88724 (r339) found the third step
 * missing and the fix silently defeatable:
 *   1. bump MY_STATUTORY_VERSION (payslips and `pay_period.statutory_version` stamp it — two different
 *      tables must never share a version string), and update docs/architecture/STATUTORY-SOURCES.md;
 *   2. state the new figure INDEPENDENTLY in a test, with the page it was read on. A test that derives
 *      its expected amount from this file can never disagree with this file: `disabled` was wrong by
 *      RM2,000 for two ruleset versions with a green suite. See test/child-relief-figures-04b88724.test.ts;
 *   3. REBUILD THE BUNDLED SIGNED PACK — `node --import tsx scripts/statutory-pack-build-my.ts`.
 *      localization/statutory-pack/bundled/my-2026.01.01.pack.json embeds a COPY of DEFAULT_MY_STATUTORY,
 *      and an ingested pack OVERRIDES this file. Skip this and `pnpm statutory:sync` reinstates the old
 *      figure under the old version string. test/pcb-classification.test.ts fails if you forget.
 *
 * Retrieved: 2026-06-06.
 */

export const MY_STATUTORY_VERSION = '2026.8';
// 2026.8 (2026-09-25): TWO `childByCategory` figures CORRECTED against the primary source, and all five
//   given a page citation — item 04b88724. The reporter contested our claim that the five figures "match
//   HASiL line for line"; they were right and we were wrong.
//     · `disabled`        RM6,000  → RM8,000
//     · `disabled_study`  RM14,000 → RM16,000
//   WHY OURS WERE WRONG: 6,000 and 14,000 are the ANNUAL ASSESSMENT relief figures (RM6,000 disabled
//   child under s.48(3), +RM8,000 for higher education) — what a person claims on a yearly return. The
//   MTD computation uses a DIFFERENT expression: a qualifying-children count QC, each child worth
//   RM2,000, with the entitled child "considered with" 4 or 8 children. Malaysia has two schedules and
//   they disagree for disabled children. We compared against the wrong one.
//   THIS IS NOT A 2026 RATE CHANGE. Printed page 7 of the same specification states: "In line with the
//   Budget 2026 as above, there is no amendment to the MTD formula." The 2026 amendments (printed pages
//   4–8) are TP1/TP3 deduction items — vaccination, parents' medical, childcare fees, insurance, early
//   intervention, tourism, environmental — and none touches child relief. These two figures have been
//   wrong since they were transcribed (ruleset 2026.7), not changed this year.
//   THE VERSION BUMP IS LOAD-BEARING, not cosmetic: `pay_period.statutory_version` records the resolved
//   ruleset version (r338, item 00e28308), so a payslip computed on 6,000/14,000 and one computed on
//   8,000/16,000 must never both stamp "2026.7". 2026.7 payslips remain a truthful record of what was
//   applied at the time.
//   NO EMPLOYEE'S PCB MOVES ON DEPLOY. Measured on production 2026-09-25: the only `auto_table` employee
//   (the sole mode that reads this map) has `child_relief_table = {"under_18":{"full":1,"half":0}}`, and
//   `under_18` is unchanged. `statutory_ruleset`, `statutory_component_override` and `statutory_pack` are
//   all EMPTY, so nothing pins the old figures and the correction reaches every tenant.
// 2026.7 (2026-08-03): PCB reliefs gain TWO more optional bodies, both item d64d0df4:
//   · `disabledSpouse` — the FURTHER deduction for a disabled spouse under s.47(1)(b) ITA 1967, on top of
//     the RM4,000 `spouse` deduction and, like it, claimable ONLY by a category-2 employee (married,
//     spouse not working). Categories 1 and 3 get nothing from it, exactly as they get nothing from
//     `spouse`.
//   · `childByCategory` — the per-child deduction broken out by the five LHDN s.48 categories, so the
//     projection can stop treating every child as one flat `perChild` amount. Used ONLY by an employee
//     whose child-relief mode is 'auto_table' (the category grid on the Identity & Tax card); 'manual'
//     and 'auto' employees keep the `children × perChild` arithmetic to the cent.
//   Both are OPTIONAL on the ruleset: an override or pack predating 2026.7 omits them and `pcbMonth`
//   falls back to these built-ins, so every existing DB override stays byte-identical. Both are
//   RATE-ONLY (see §1 of docs/architecture/STATUTORY-SOURCES.md) — six figures that must be signed off
//   against the current LHDN publication before a real filing relies on them.
// 2026.6 (2026-07-31): PCB reliefs gain `disabledIndividual` — the FURTHER deduction a registered disabled
//   individual (OKU) is entitled to under s.46(1)(g) ITA 1967, on top of the RM9,000 individual deduction
//   (item d64d0df4). Optional on the ruleset: an override or pack predating 2026.6 omits it and `pcbMonth`
//   falls back to 0, and the deduction is only applied to an employee an admin has explicitly flagged — so
//   every existing DB override AND every existing employee stays byte-identical. See §1 of
//   docs/architecture/STATUTORY-SOURCES.md: this figure is RATE-ONLY (sourced, NOT yet verified against the
//   LHDN MTD spec PDF) and must be signed off before it is relied on for a real filing.
// 2026.5 (2026-07-22): PCB pay-code classification tables (feedback 09b554e9, LHDN "Spesifikasi Pengiraan
//   PCB 2026 Menggunakan Pengiraan Berkomputer"): pcbExemptions gains the PCB_* exemption codes (annual caps;
//   -1 = fully exempt, 0 = fully taxable) for Normal/Additional remuneration and the 24 LP_* optional-
//   deduction codes (TP1-style monthly-tax deductions). Optional on the ruleset — pre-2026.5 overrides omit
//   it and the kernel falls back to the built-ins, so existing DB overrides stay byte-identical.
// 2026.4 (2026-07-04): OT ruleset gains two configurable EXCESS-hours factors —
//   ot.restDayExcessMultiplier (2.0, s.60(3)(c)) and ot.holidayExcessMultiplier (3.0, s.60D(3)(aa)).
//   Both optional with EA-value fallbacks, so older DB overrides carrying only ot.wageCeiling stay
//   byte-identical. The workday 1.5× rate is deliberately NOT added (owned by payroll-policy-config).
// 2026.1 (2026-06-11): SOCSO bands extended to the RM6,000 ceiling and EIS Second Schedule
//   band amounts encoded, both verbatim from PERKESO's official Nov-2024 rate PDFs (replacing
//   the rate-based approximations above RM5,000 / for EIS). EPF unchanged.
// 2026.0 (2026-06-06): initial sourced tables (PCB, EPF rates, SOCSO ≤ RM5,000, EIS rates).

// ─────────────────────────────────────────────────────────────────────────────
// Income tax — PCB / MTD computerised calculation (LHDN)
// Source: "Specification for MTD Calculations Using Computerized Calculation for 2026",
//   Lembaga Hasil Dalam Negeri (updated 01 January 2026) — Table 1 (Value of P, M, R, B).
//   https://www.hasil.gov.my/media/arvlrzh5/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf
// Resident-individual brackets match the LHDN tax-rate page (AY2023–2025) and are unchanged
// for AY2026 (the 2026 spec states "no amendment to the MTD formula for 2026"). VERIFIED.
// ─────────────────────────────────────────────────────────────────────────────

/** A PCB band keyed by projected annual chargeable income P. */
export type PcbBand = {
  /** Upper bound of P for this band (Infinity = top band). */
  upTo: number;
  /** M — first chargeable income of the band. */
  M: number;
  /** R — marginal tax rate as a fraction (e.g. 0.06). */
  R: number;
  /** B — tax on M after rebate, Category 1 (single) & 3 (married, spouse working). */
  bCat13: number;
  /** B — tax on M after rebate, Category 2 (married, spouse not working). */
  bCat2: number;
};

/** LHDN 2026 MTD "Table 1: Value of P, M, R and B". Negative B encodes the RM400/RM800 rebate. */
export const MY_PCB_BANDS: PcbBand[] = [
  { upTo: 5000, M: 0, R: 0, bCat13: 0, bCat2: 0 },
  { upTo: 20000, M: 5000, R: 0.01, bCat13: -400, bCat2: -800 },
  { upTo: 35000, M: 20000, R: 0.03, bCat13: -250, bCat2: -650 },
  { upTo: 50000, M: 35000, R: 0.06, bCat13: 600, bCat2: 600 },
  { upTo: 70000, M: 50000, R: 0.11, bCat13: 1500, bCat2: 1500 },
  { upTo: 100000, M: 70000, R: 0.19, bCat13: 3700, bCat2: 3700 },
  { upTo: 400000, M: 100000, R: 0.25, bCat13: 9400, bCat2: 9400 },
  { upTo: 600000, M: 400000, R: 0.26, bCat13: 84400, bCat2: 84400 },
  { upTo: 2000000, M: 600000, R: 0.28, bCat13: 136400, bCat2: 136400 },
  { upTo: Infinity, M: 2000000, R: 0.3, bCat13: 528400, bCat2: 528400 },
];

/** Annual reliefs (RM) used to project chargeable income P. Source: LHDN 2026 MTD spec. VERIFIED,
 *  EXCEPT `disabledIndividual` — see its own note. */
export const MY_RELIEFS = {
  /** D — individual + dependent relatives. */
  individual: 9000,
  /** S — non-working spouse (Category 2 only). */
  spouse: 4000,
  /** Q per qualifying child C. */
  perChild: 2000,
  /** K — mandatory EPF qualifying cap per year (life insurance is a separate TP1 item). */
  epfReliefCap: 4000,
  /**
   * FURTHER deduction for a registered disabled individual (OKU), on top of `individual` — s.46(1)(g)
   * ITA 1967, raised from RM6,000 to RM7,000 by Budget 2025 with effect from YA2025 (item d64d0df4).
   *
   * ⚠️ RATE-ONLY, NOT YET VERIFIED. Every other figure in this object was transcribed from the LHDN
   * MTD computerised-calculation spec PDF itself. This one is sourced from PwC Worldwide Tax Summaries
   * (Malaysia — Individual — Deductions, YA2026) because the LHDN spec URL recorded above now 404s, and
   * a secondary source is not the same thing as the primary one. It is listed as RATE-ONLY in
   * docs/architecture/STATUTORY-SOURCES.md §1 and MUST be signed off against the current LHDN
   * publication before a real filing relies on it.
   *
   * The exposure is bounded and opt-in by construction: it is applied ONLY to an employee an admin has
   * explicitly flagged as a disabled individual, so no existing employee's PCB moves until someone
   * makes that claim. That is why it ships as a wrong-figure RISK on flagged employees rather than as
   * a guaranteed over-deduction on every entitled one, which is what leaving it out means.
   */
  disabledIndividual: 7000,
  /**
   * FURTHER deduction for a DISABLED SPOUSE, on top of `spouse` — s.47(1)(b) ITA 1967 (RM5,000).
   *
   * ⚠️⚠️ THIS FIGURE DISAGREES WITH THE PRIMARY SOURCE AND IS LEFT UNCHANGED ON PURPOSE (item 04b88724).
   * While reading the MTD spec to correct the two child figures below, the SAME Reliefs table was found to
   * carry this deduction on printed page 28 (PDF page 29), item f:
   *     "f.  Disabled Husband / Wife                                          6,000.00
   *          An further deduction of RM6,000 is given in respect of a disabled husband / wife."  [sic]
   * We hold RM5,000. RM5,000 is the ANNUAL ASSESSMENT figure under s.47(1)(b) ITA 1967 — the identical
   * class of error as the child figures: the annual-return schedule quoted where the MTD schedule governs.
   * So this is very probably wrong by RM1,000, in the same direction (under-relief ⇒ over-deduction).
   *
   * IT IS NOT CORRECTED HERE because item 04b88724 is scoped to `childByCategory`, and a second relief on
   * the money path is the reporter's to own with its own exposure measurement — not something to slip into
   * a round about child relief. Exposure measured on production 2026-09-25: ZERO employees have
   * `employee_statutory_my.disabled_spouse` set, and zero have `disabled_individual` set, so nothing is
   * mis-deducted today and there is no urgency that would justify widening the scope.
   * → RAISE THIS AS ITS OWN BOARD ITEM. Do not "fix it while you are in here".
   *
   * `disabledIndividual` above (RM7,000) was checked on the same page at the same time and MATCHES the
   * spec: printed page 28 item e, "A further deduction of RM7,000 is allowed if the individual is a
   * disabled person." Its own note is left as-is because upgrading it is likewise out of scope.
   *
   * ⚠️ RATE-ONLY, NOT YET VERIFIED — same footing as `disabledIndividual` above: transcribed from PwC
   * Worldwide Tax Summaries (Malaysia — Individual — Deductions, YA2026) because the LHDN MTD spec URL
   * recorded above now 404s. Listed as RATE-ONLY in docs/architecture/STATUTORY-SOURCES.md §1 and
   * shown as "pending sign-off" on the PCB configuration screen.
   *
   * GATED TO CATEGORY 2 exactly like `spouse`. A category-1 (single) or category-3 (spouse working /
   * divorced / widowed) employee has no spouse deduction to add to, so this adds nothing to their P.
   * The Identity & Tax card says so rather than letting the setting look ignored.
   */
  disabledSpouse: 5000,
  /**
   * PER-CHILD deduction broken out by the five LHDN s.48 categories (item d64d0df4). `perChild` above is
   * the flat RM2,000 figure the projection uses for every child today; this map is what the projection
   * uses INSTEAD when an employee's child-relief mode is 'auto_table' and a category grid has been keyed
   * against them. A 50%-shared child counts HALF the amount below (LHDN: 100% one parent, or 50% each).
   *
   * ═══ PROVENANCE — READ THIS BEFORE CHANGING A FIGURE (item 04b88724) ═══
   *
   * These five figures previously carried the note "⚠️ RATE-ONLY, NOT YET VERIFIED — all five". That note
   * was TRUE, and we quoted the figures to the reporter as if verified anyway; two of them were wrong.
   * The note is replaced PER VALUE with the page it was read on, so the next reader can check us instead
   * of trusting us.
   *
   * SOURCE, read directly 2026-09-25 (not a secondary summary): LHDN, "Specification for MTD Calculations
   * Using Computerized Calculation for 2026", cover "Updated: 01 January 2026". Retrieved from
   * https://www.hasil.gov.my/wp-content/uploads/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf
   * (the /media/arvlrzh5/ URL in this file's PCB header now fails to resolve; this one served the PDF).
   * The Reliefs table, item c. "Child", runs across PRINTED pages 26–27 (PDF pages 27–28). Printed page 26
   * gives the RM2,000 per-child amounts in prose; printed page 27 gives the qualifying-children table and
   * the footnote that prices each category. Page numbers below are the specification's own PRINTED ones.
   *
   * The spec expresses this as QC — a count of qualifying children, each worth RM2,000 — and multiplies
   * inside the P formula's deduction block `[D + S + DU + SU + QC + (∑LP + LP1)]` (printed page 24).
   * `childReliefAmountFor` returns the RINGGIT directly. The two are arithmetically identical for every
   * category below, which is why no QC integer is carried: the equivalence is asserted by test instead
   * (test/child-relief-figures-04b88724.test.ts) so a future edit that breaks it fails loudly.
   *
   *   KEY             RM      QC  CITATION (printed page · exact words)
   *   under_18        2,000    1  p.26 "A relief of RM2,000 per child is allowed if the child is
   *                               unmarried and below the age 18 years in the current year."
   *                               p.27 footnote "*1 child below the age of 18 or a child who is
   *                               studying = RM2,000".
   *   study_preu      2,000    1  p.26 "A relief of RM2,000 per child is allowed if the child is
   *                               unmarried, 18 years of age and above, and is receiving full-time
   *                               education". Same p.27 footnote line as under_18 ("or a child who is
   *                               studying"). NB: this category is PRE-university study — the spec
   *                               reserves the 4-children uplift for diploma level onwards, so 18+
   *                               full-time study BELOW that threshold stays at one child / RM2,000.
   *   study_tertiary  8,000    4  p.27 table "Child over the age of 18 years and receiving full-time
   *                               instruction at diploma level onwards in an institution of higher
   *                               education in Malaysia." → 4; and the degree-level-onwards-OUTSIDE-
   *                               Malaysia row → 4. p.27 footnote "*Child - 18 years and above and
   *                               studying (diploma or higher) = RM8,000 (considered with 4 children)".
   *   disabled        8,000    4  p.27 table "Disabled child as certified by the Department of Social
   *                               Welfare." → 4. p.27 footnote "*Disabled child = RM8,000 (considered
   *                               with 4 children)".  ⚠️ CORRECTED from RM6,000 by item 04b88724.
   *   disabled_study 16,000    8  p.27 table "Disabled child receiving further instruction at diploma
   *                               level onwards in an institution of higher education in Malaysia or at
   *                               degree level onwards in an institution of higher education outside
   *                               Malaysia." → 8. p.27 footnote "*Disabled child - 18 years and above and
   *                               studying (diploma or higher) = RM16,000 (considered with 8 children)".
   *                               ⚠️ CORRECTED from RM14,000 by item 04b88724.
   *
   * WHAT "VERIFIED" DOES AND DOES NOT MEAN HERE. All five amounts are now transcribed from the PRIMARY
   * publication, on the page named above — that is a checkable claim and it replaces the secondary-source
   * footing these had. It is NOT the human sign-off the file header and STATUTORY-SOURCES.md require
   * before a real filing: that is an accountant's act, not an agent's, so the PCB configuration screen
   * still shows these rows as awaiting sign-off. The two things are deliberately separate.
   *
   * ⚠️ `disabledIndividual` and `disabledSpouse` ABOVE ARE STILL SECONDARY-SOURCED AND ONE IS WRONG — see
   * the note on `disabledSpouse`. Out of scope for item 04b88724; do not read this block as covering them.
   */
  childByCategory: {
    // NB: keyed by CHILD_RELIEF_CATEGORY_KEYS below — the SAME five keys the Family register stores per
    // child (core/dependents.ts CHILD_RELIEF_CATEGORIES). A test pins the two lists equal.
    // Every value below is the spec's qualifying-children count × the RM2,000 per-child relief. The
    // equivalence is asserted, not just the totals — see test/child-relief-figures-04b88724.test.ts.
    under_18: 2000, // QC 1 — printed p.26 + p.27 footnote
    study_preu: 2000, // QC 1 — printed p.26 + p.27 footnote
    study_tertiary: 8000, // QC 4 — printed p.27 table rows 1-2 + footnote
    disabled: 8000, // QC 4 — printed p.27 table row 3 + footnote (was 6000: the annual-assessment figure)
    disabled_study: 16000, // QC 8 — printed p.27 table row 4 + footnote (was 14000: annual-assessment)
  } as Record<string, number>,
};

/**
 * Item d64d0df4 — the five LHDN s.48 child-relief categories, in the canonical order the grid and the
 * PCB configuration screen render them. This is the SINGLE list every consumer keys off: the ruleset's
 * `childByCategory` amounts, the validator's unknown-key rejection, the per-employee grid's normaliser,
 * and the sign-off rows on the PCB screen. It is deliberately equal to core/dependents.ts
 * CHILD_RELIEF_CATEGORIES (the per-child value on the Family register) — pinned by a test rather than by
 * an import, because a country pack must not depend on a core service module.
 */
export const CHILD_RELIEF_CATEGORY_KEYS = [
  'under_18',
  'study_preu',
  'study_tertiary',
  'disabled',
  'disabled_study',
] as const;
export type ChildReliefCategoryKey = (typeof CHILD_RELIEF_CATEGORY_KEYS)[number];

/** PCB tax categories (LHDN). */
export type TaxCategory = 1 | 2 | 3;
//  1 = single; 2 = married, spouse not working; 3 = married+spouse working / divorced / widowed.

// ─────────────────────────────────────────────────────────────────────────────
// EPF / KWSP — Third Schedule, EPF Act 1991 (standard rates, effective October 2025)
// Source: https://www.kwsp.gov.my/en/employer/responsibilities/mandatory-contribution
//   Third Schedule: https://www.kwsp.gov.my/documents/d/guest/jadual-ketiga-bi-pdf-1
// Malaysian-citizen rates. ⚠️ For wages ≤ RM5000 the Third Schedule uses RM20 wage-bands with
// fixed per-band amounts; we apply the statutory % with round-up to the next ringgit, which
// matches at typical salary levels. Low-wage band exactness is flagged in STATUTORY-SOURCES.md.
// ─────────────────────────────────────────────────────────────────────────────

export type ContribBand = { upTo: number; employer: number; employee: number };

// EPF Act 1991 THIRD SCHEDULE (Part A — Malaysian citizen / PR, under age 60). #95.
// For monthly wages ≤ RM20,000 the contribution is NOT a flat percentage of the exact wage — it is a
// table of wage BANDS, each band's amount = the rate applied to the band's UPPER LIMIT, rounded UP to
// the next whole ringgit. Band widths: RM20 for wages 0.01–5,000, then RM100 for 5,000.01–20,000. The
// employee rate is 11% throughout; the employer rate steps from 13% (≤RM5,000) to 12% (>RM5,000). The
// first band (RM0.01–10) is a statutory NIL/NIL exception. Above RM20,000 the schedule ends and the
// exact percentage applies (employee 11%, employer 12%), still rounded up to the next ringgit.
//
// This REPLACES the prior rate-on-exact-wage approximation, which under/over-stated by ≤RM1/side inside a
// band (e.g. wage RM2,990 → approximation 329/389, schedule 330/390). At Chin Hin's scale that is a real
// LHDN/KWSP filing mismatch across thousands of payslips. The amounts here are the published derivation
// rule, cross-checked against the official KWSP "Jadual Ketiga" PDF anchors (RM1,000→110/130,
// RM3,000→330/390, RM5,000→550/650, RM5,100→561/612, RM10,000→1,100/1,200, RM20,000→2,200/2,400).
// Source: EPF Act 1991 Third Schedule, https://www.kwsp.gov.my/en/epf-act-1991-third-schedule
// (KWSP "Jadual Ketiga BI" PDF; direct fetch returns HTTP 403, transcribed via Internet Archive mirror).
// Sign-off (Part A + the age-60 Part E and non-citizen 2%/2% Part F gaps): see STATUTORY-SOURCES.md §2.
export const EPF_SCHEDULE_MAX = 20000;

function buildEpfThirdSchedulePartA(): ContribBand[] {
  const ceil = (x: number) => Math.ceil(x);
  const bands: ContribBand[] = [{ upTo: 10, employer: 0, employee: 0 }]; // statutory NIL first band
  for (let upper = 20; upper <= 5000; upper += 20) {
    bands.push({ upTo: upper, employee: ceil(0.11 * upper), employer: ceil(0.13 * upper) });
  }
  for (let upper = 5100; upper <= EPF_SCHEDULE_MAX; upper += 100) {
    bands.push({ upTo: upper, employee: ceil(0.11 * upper), employer: ceil(0.12 * upper) }); // employer steps to 12%
  }
  return bands;
}

/** EPF Third Schedule Part A — citizen/PR < 60, wages ≤ RM20,000 (verified band table; #95). */
export const MY_EPF_THIRD_SCHEDULE_PART_A: ContribBand[] = buildEpfThirdSchedulePartA();

// EPF age cutovers: a Malaysian citizen aged 60–<75 contributes on the reduced Part E schedule
// (employee 0%, employer 4%); from age 75 there is no mandatory EPF. Source: KWSP Jadual Ketiga
// (1 Oct 2025) + YiWei Law statutory deck (10 Jun 2026, slides 7–9).
export const EPF_SENIOR_AGE = 60;
export const EPF_NO_CONTRIB_AGE = 75;

// EPF Third Schedule PART E (Malaysian citizen, age 60–<75): employee 0%, employer 4% — same band
// structure as Part A (amount = ceil(4% × band-upper), RM20 then RM100 bands; NIL first band; exact
// 4% above RM20,000). Verified against the deck's banded sample (22,300.80 × 4% = 892.032 → RM893).
function buildEpfThirdSchedulePartE(): ContribBand[] {
  const ceil = (x: number) => Math.ceil(x);
  const bands: ContribBand[] = [{ upTo: 10, employer: 0, employee: 0 }];
  for (let upper = 20; upper <= 5000; upper += 20) bands.push({ upTo: upper, employee: 0, employer: ceil(0.04 * upper) });
  for (let upper = 5100; upper <= EPF_SCHEDULE_MAX; upper += 100) bands.push({ upTo: upper, employee: 0, employer: ceil(0.04 * upper) });
  return bands;
}

/** EPF Third Schedule Part E — Malaysian citizen 60–<75 (employee 0% / employer 4% banded). */
export const MY_EPF_THIRD_SCHEDULE_PART_E: ContribBand[] = buildEpfThirdSchedulePartE();

export const MY_EPF = {
  employeeRate: 0.11,
  /** Employer pays 13% when monthly wage ≤ RM5000, else 12%. */
  employerRateLow: 0.13,
  employerRateHigh: 0.12,
  employerThreshold: 5000,
  /** Exact Third Schedule Part A band table (the statutory floor on the normal monthly wage). */
  partA: MY_EPF_THIRD_SCHEDULE_PART_A,
  /** Last wage (RM) the band table covers; above this the exact percentage applies. */
  scheduleMax: EPF_SCHEDULE_MAX,
  /** Part E — Malaysian citizen 60–<75: employee 0%, employer 4% (banded). */
  partE: MY_EPF_THIRD_SCHEDULE_PART_E,
  /** Employer flat rate for the Part E senior schedule (4%) — used for the >RM20,000 tail. */
  seniorEmployerRate: 0.04,
  /** Non-citizen mandatory EPF (post-1998 / new rule, eff 1 Oct 2025): employee 2% / employer 2%,
   *  flat on the wage, round up to RM1. (Pre-1998 legacy 5.5%/6–6.5% is rare — see STATUTORY-SOURCES §2.) */
  nonCitizenEmployeeRate: 0.02,
  nonCitizenEmployerRate: 0.02,
};

// ─────────────────────────────────────────────────────────────────────────────
// SOCSO / PERKESO & EIS — wage ceiling
// The contribution wage ceiling was raised from RM5000 to RM6000 effective 1 October 2024.
// Source (ceiling): https://perkeso.gov.my/en/rate-of-contribution.html
// ─────────────────────────────────────────────────────────────────────────────

export const MY_CONTRIB_CEILING = 6000;

// SOCSO — First Category (Employment Injury + Invalidity, employee < 60), Act 4 Third Schedule.
// Source: "Rate of contribution for Employees' Social Security Act 1969 (Act 4)" — PERKESO
//   official PDF (post-Oct-2024 ceiling, file dated 15 Nov 2024), retrieved 2026-06-11:
//   https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%204.pdf
// All 64 bands below are VERIFIED verbatim from that PDF (rows 1–64); its row 65 prescribes
// that wages exceeding RM6,000 contribute at the top band — the calculator applies the last
// band for any wage above the table.

/** Last wage (RM) for which SOCSO band amounts are officially verified. */
export const MY_SOCSO_VERIFIED_UP_TO = 6000;

export const MY_SOCSO_CATEGORY1: ContribBand[] = [
  { upTo: 30, employer: 0.4, employee: 0.1 },
  { upTo: 50, employer: 0.7, employee: 0.2 },
  { upTo: 70, employer: 1.1, employee: 0.3 },
  { upTo: 100, employer: 1.5, employee: 0.4 },
  { upTo: 140, employer: 2.1, employee: 0.6 },
  { upTo: 200, employer: 2.95, employee: 0.85 },
  { upTo: 300, employer: 4.35, employee: 1.25 },
  { upTo: 400, employer: 6.15, employee: 1.75 },
  { upTo: 500, employer: 7.85, employee: 2.25 },
  { upTo: 600, employer: 9.65, employee: 2.75 },
  { upTo: 700, employer: 11.35, employee: 3.25 },
  { upTo: 800, employer: 13.15, employee: 3.75 },
  { upTo: 900, employer: 14.85, employee: 4.25 },
  { upTo: 1000, employer: 16.65, employee: 4.75 },
  { upTo: 1100, employer: 18.35, employee: 5.25 },
  { upTo: 1200, employer: 20.15, employee: 5.75 },
  { upTo: 1300, employer: 21.85, employee: 6.25 },
  { upTo: 1400, employer: 23.65, employee: 6.75 },
  { upTo: 1500, employer: 25.35, employee: 7.25 },
  { upTo: 1600, employer: 27.15, employee: 7.75 },
  { upTo: 1700, employer: 28.85, employee: 8.25 },
  { upTo: 1800, employer: 30.65, employee: 8.75 },
  { upTo: 1900, employer: 32.35, employee: 9.25 },
  { upTo: 2000, employer: 34.15, employee: 9.75 },
  { upTo: 2100, employer: 35.85, employee: 10.25 },
  { upTo: 2200, employer: 37.65, employee: 10.75 },
  { upTo: 2300, employer: 39.35, employee: 11.25 },
  { upTo: 2400, employer: 41.15, employee: 11.75 },
  { upTo: 2500, employer: 42.85, employee: 12.25 },
  { upTo: 2600, employer: 44.65, employee: 12.75 },
  { upTo: 2700, employer: 46.35, employee: 13.25 },
  { upTo: 2800, employer: 48.15, employee: 13.75 },
  { upTo: 2900, employer: 49.85, employee: 14.25 },
  { upTo: 3000, employer: 51.65, employee: 14.75 },
  { upTo: 3100, employer: 53.35, employee: 15.25 },
  { upTo: 3200, employer: 55.15, employee: 15.75 },
  { upTo: 3300, employer: 56.85, employee: 16.25 },
  { upTo: 3400, employer: 58.65, employee: 16.75 },
  { upTo: 3500, employer: 60.35, employee: 17.25 },
  { upTo: 3600, employer: 62.15, employee: 17.75 },
  { upTo: 3700, employer: 63.85, employee: 18.25 },
  { upTo: 3800, employer: 65.65, employee: 18.75 },
  { upTo: 3900, employer: 67.35, employee: 19.25 },
  { upTo: 4000, employer: 69.15, employee: 19.75 },
  { upTo: 4100, employer: 70.85, employee: 20.25 },
  { upTo: 4200, employer: 72.65, employee: 20.75 },
  { upTo: 4300, employer: 74.35, employee: 21.25 },
  { upTo: 4400, employer: 76.15, employee: 21.75 },
  { upTo: 4500, employer: 77.85, employee: 22.25 },
  { upTo: 4600, employer: 79.65, employee: 22.75 },
  { upTo: 4700, employer: 81.35, employee: 23.25 },
  { upTo: 4800, employer: 83.15, employee: 23.75 },
  { upTo: 4900, employer: 84.85, employee: 24.25 },
  { upTo: 5000, employer: 86.65, employee: 24.75 },
  { upTo: 5100, employer: 88.35, employee: 25.25 },
  { upTo: 5200, employer: 90.15, employee: 25.75 },
  { upTo: 5300, employer: 91.85, employee: 26.25 },
  { upTo: 5400, employer: 93.65, employee: 26.75 },
  { upTo: 5500, employer: 95.35, employee: 27.25 },
  { upTo: 5600, employer: 97.15, employee: 27.75 },
  { upTo: 5700, employer: 98.85, employee: 28.25 },
  { upTo: 5800, employer: 100.65, employee: 28.75 },
  { upTo: 5900, employer: 102.35, employee: 29.25 },
  { upTo: 6000, employer: 104.15, employee: 29.75 },
];

/** SOCSO statutory rates — cross-check only (≈1.75% / 0.5% of the band midpoint); the
 *  calculator uses the exact band table above. */
export const MY_SOCSO_RATES = { employer: 0.0175, employee: 0.005 };

// SOCSO — Second Category (Employment Injury Scheme only, employer-only): employees aged 60+
// (and new entrants 55+/post-invalidity-pension per PERKESO rules). Same source PDF as Category
// 1 ("Contribution By Employer Only" column, rows 1–64 verbatim; row 65 = top band above
// RM6,000). Employee share is nil by definition.
export const MY_SOCSO_CATEGORY2: ContribBand[] = [
  { upTo: 30, employer: 0.3, employee: 0 },
  { upTo: 50, employer: 0.5, employee: 0 },
  { upTo: 70, employer: 0.8, employee: 0 },
  { upTo: 100, employer: 1.1, employee: 0 },
  { upTo: 140, employer: 1.5, employee: 0 },
  { upTo: 200, employer: 2.1, employee: 0 },
  { upTo: 300, employer: 3.1, employee: 0 },
  { upTo: 400, employer: 4.4, employee: 0 },
  { upTo: 500, employer: 5.6, employee: 0 },
  { upTo: 600, employer: 6.9, employee: 0 },
  { upTo: 700, employer: 8.1, employee: 0 },
  { upTo: 800, employer: 9.4, employee: 0 },
  { upTo: 900, employer: 10.6, employee: 0 },
  { upTo: 1000, employer: 11.9, employee: 0 },
  { upTo: 1100, employer: 13.1, employee: 0 },
  { upTo: 1200, employer: 14.4, employee: 0 },
  { upTo: 1300, employer: 15.6, employee: 0 },
  { upTo: 1400, employer: 16.9, employee: 0 },
  { upTo: 1500, employer: 18.1, employee: 0 },
  { upTo: 1600, employer: 19.4, employee: 0 },
  { upTo: 1700, employer: 20.6, employee: 0 },
  { upTo: 1800, employer: 21.9, employee: 0 },
  { upTo: 1900, employer: 23.1, employee: 0 },
  { upTo: 2000, employer: 24.4, employee: 0 },
  { upTo: 2100, employer: 25.6, employee: 0 },
  { upTo: 2200, employer: 26.9, employee: 0 },
  { upTo: 2300, employer: 28.1, employee: 0 },
  { upTo: 2400, employer: 29.4, employee: 0 },
  { upTo: 2500, employer: 30.6, employee: 0 },
  { upTo: 2600, employer: 31.9, employee: 0 },
  { upTo: 2700, employer: 33.1, employee: 0 },
  { upTo: 2800, employer: 34.4, employee: 0 },
  { upTo: 2900, employer: 35.6, employee: 0 },
  { upTo: 3000, employer: 36.9, employee: 0 },
  { upTo: 3100, employer: 38.1, employee: 0 },
  { upTo: 3200, employer: 39.4, employee: 0 },
  { upTo: 3300, employer: 40.6, employee: 0 },
  { upTo: 3400, employer: 41.9, employee: 0 },
  { upTo: 3500, employer: 43.1, employee: 0 },
  { upTo: 3600, employer: 44.4, employee: 0 },
  { upTo: 3700, employer: 45.6, employee: 0 },
  { upTo: 3800, employer: 46.9, employee: 0 },
  { upTo: 3900, employer: 48.1, employee: 0 },
  { upTo: 4000, employer: 49.4, employee: 0 },
  { upTo: 4100, employer: 50.6, employee: 0 },
  { upTo: 4200, employer: 51.9, employee: 0 },
  { upTo: 4300, employer: 53.1, employee: 0 },
  { upTo: 4400, employer: 54.4, employee: 0 },
  { upTo: 4500, employer: 55.6, employee: 0 },
  { upTo: 4600, employer: 56.9, employee: 0 },
  { upTo: 4700, employer: 58.1, employee: 0 },
  { upTo: 4800, employer: 59.4, employee: 0 },
  { upTo: 4900, employer: 60.6, employee: 0 },
  { upTo: 5000, employer: 61.9, employee: 0 },
  { upTo: 5100, employer: 63.1, employee: 0 },
  { upTo: 5200, employer: 64.4, employee: 0 },
  { upTo: 5300, employer: 65.6, employee: 0 },
  { upTo: 5400, employer: 66.9, employee: 0 },
  { upTo: 5500, employer: 68.1, employee: 0 },
  { upTo: 5600, employer: 69.4, employee: 0 },
  { upTo: 5700, employer: 70.6, employee: 0 },
  { upTo: 5800, employer: 71.9, employee: 0 },
  { upTo: 5900, employer: 73.1, employee: 0 },
  { upTo: 6000, employer: 74.4, employee: 0 },
];

// ─────────────────────────────────────────────────────────────────────────────
// SKBBK — "Skim Bukan Bencana Kerja" / Lindung 24 Jam (Act 4, Akta A1788), MANDATORY from 1 Jun 2026.
// A new, employee-paid leg (Phase 1 = 0.75%) added ON TOP of the existing SOCSO contribution; the
// employer and employee (Invalidity) columns above are UNCHANGED. SKBBK is identical for Category 1 and
// Category 2 (employees aged 60+ and foreign workers pay it too). The amounts are gazetted per wage band
// (NOT % × wage — use the band lookup). Source: PERKESO NewContributionRateIncludingSKBBK.pdf + Pekeliling
// Majikan 02/2026 + Lindung-24-Jam FAQ, cross-checked across all three (sourced 2026-06-19, HIGH conf.).
// Phase 1 only — SKBBK rises to 1.00% then 1.25% on dates PERKESO will announce (re-version then).
// ─────────────────────────────────────────────────────────────────────────────
export type SocsoBand = ContribBand & { skbbk: number };

/** Employee-side SKBBK amount per wage band (Phase 1, 0.75%), in MY_SOCSO_CATEGORY1/2 band order. */
export const MY_SOCSO_SKBBK_PHASE1: number[] = [
  0.2, 0.3, 0.5, 0.65, 0.9, 1.25, 1.85, 2.65, 3.35, 4.15, 4.85, 5.65, 6.35, 7.15, 7.85, 8.65, 9.35, 10.15,
  10.85, 11.65, 12.35, 13.15, 13.85, 14.65, 15.35, 16.15, 16.85, 17.65, 18.35, 19.15, 19.85, 20.65, 21.35,
  22.15, 22.85, 23.65, 24.35, 25.15, 25.85, 26.65, 27.35, 28.15, 28.85, 29.65, 30.35, 31.15, 31.85, 32.65,
  33.35, 34.15, 34.85, 35.65, 36.35, 37.15, 37.85, 38.65, 39.35, 40.15, 40.85, 41.65, 42.35, 43.15, 43.85, 44.65,
];

/** Attach the SKBBK employee leg to a SOCSO band table (employer/employee columns untouched). */
function withSkbbk(bands: ContribBand[], skbbk: number[]): SocsoBand[] {
  if (bands.length !== skbbk.length) {
    throw new Error(`SKBBK column (${skbbk.length}) must align with the SOCSO band table (${bands.length})`);
  }
  return bands.map((b, i) => ({ ...b, skbbk: skbbk[i] }));
}

/** SOCSO Category 1 (Malaysian 18–<60) WITH the mandatory SKBBK leg (eff 1 Jun 2026). */
export const MY_SOCSO_CATEGORY1_SKBBK: SocsoBand[] = withSkbbk(MY_SOCSO_CATEGORY1, MY_SOCSO_SKBBK_PHASE1);
/** SOCSO Category 2 (age 60+ / foreign — employer Injury-only) WITH the same SKBBK employee leg. */
export const MY_SOCSO_CATEGORY2_SKBBK: SocsoBand[] = withSkbbk(MY_SOCSO_CATEGORY2, MY_SOCSO_SKBBK_PHASE1);

// EIS / SIP — Employment Insurance System, Act 800, Second Schedule.
// Source: "Rate of Contribution Employment Insurance System (Act 800)" — PERKESO official PDF
//   (post-Oct-2024 ceiling, file dated 15 Nov 2024), retrieved 2026-06-11:
//   https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%20800.pdf
// All 64 bands VERIFIED verbatim (rows 1–64); its row 65 prescribes that wages exceeding
// RM6,000 contribute at the top band (RM11.90 each). Employer and employee amounts are equal
// in every band — both columns are kept to mirror the published table exactly.
export const MY_EIS_BANDS: ContribBand[] = [
  { upTo: 30, employer: 0.05, employee: 0.05 },
  { upTo: 50, employer: 0.1, employee: 0.1 },
  { upTo: 70, employer: 0.15, employee: 0.15 },
  { upTo: 100, employer: 0.2, employee: 0.2 },
  { upTo: 140, employer: 0.25, employee: 0.25 },
  { upTo: 200, employer: 0.35, employee: 0.35 },
  { upTo: 300, employer: 0.5, employee: 0.5 },
  { upTo: 400, employer: 0.7, employee: 0.7 },
  { upTo: 500, employer: 0.9, employee: 0.9 },
  { upTo: 600, employer: 1.1, employee: 1.1 },
  { upTo: 700, employer: 1.3, employee: 1.3 },
  { upTo: 800, employer: 1.5, employee: 1.5 },
  { upTo: 900, employer: 1.7, employee: 1.7 },
  { upTo: 1000, employer: 1.9, employee: 1.9 },
  { upTo: 1100, employer: 2.1, employee: 2.1 },
  { upTo: 1200, employer: 2.3, employee: 2.3 },
  { upTo: 1300, employer: 2.5, employee: 2.5 },
  { upTo: 1400, employer: 2.7, employee: 2.7 },
  { upTo: 1500, employer: 2.9, employee: 2.9 },
  { upTo: 1600, employer: 3.1, employee: 3.1 },
  { upTo: 1700, employer: 3.3, employee: 3.3 },
  { upTo: 1800, employer: 3.5, employee: 3.5 },
  { upTo: 1900, employer: 3.7, employee: 3.7 },
  { upTo: 2000, employer: 3.9, employee: 3.9 },
  { upTo: 2100, employer: 4.1, employee: 4.1 },
  { upTo: 2200, employer: 4.3, employee: 4.3 },
  { upTo: 2300, employer: 4.5, employee: 4.5 },
  { upTo: 2400, employer: 4.7, employee: 4.7 },
  { upTo: 2500, employer: 4.9, employee: 4.9 },
  { upTo: 2600, employer: 5.1, employee: 5.1 },
  { upTo: 2700, employer: 5.3, employee: 5.3 },
  { upTo: 2800, employer: 5.5, employee: 5.5 },
  { upTo: 2900, employer: 5.7, employee: 5.7 },
  { upTo: 3000, employer: 5.9, employee: 5.9 },
  { upTo: 3100, employer: 6.1, employee: 6.1 },
  { upTo: 3200, employer: 6.3, employee: 6.3 },
  { upTo: 3300, employer: 6.5, employee: 6.5 },
  { upTo: 3400, employer: 6.7, employee: 6.7 },
  { upTo: 3500, employer: 6.9, employee: 6.9 },
  { upTo: 3600, employer: 7.1, employee: 7.1 },
  { upTo: 3700, employer: 7.3, employee: 7.3 },
  { upTo: 3800, employer: 7.5, employee: 7.5 },
  { upTo: 3900, employer: 7.7, employee: 7.7 },
  { upTo: 4000, employer: 7.9, employee: 7.9 },
  { upTo: 4100, employer: 8.1, employee: 8.1 },
  { upTo: 4200, employer: 8.3, employee: 8.3 },
  { upTo: 4300, employer: 8.5, employee: 8.5 },
  { upTo: 4400, employer: 8.7, employee: 8.7 },
  { upTo: 4500, employer: 8.9, employee: 8.9 },
  { upTo: 4600, employer: 9.1, employee: 9.1 },
  { upTo: 4700, employer: 9.3, employee: 9.3 },
  { upTo: 4800, employer: 9.5, employee: 9.5 },
  { upTo: 4900, employer: 9.7, employee: 9.7 },
  { upTo: 5000, employer: 9.9, employee: 9.9 },
  { upTo: 5100, employer: 10.1, employee: 10.1 },
  { upTo: 5200, employer: 10.3, employee: 10.3 },
  { upTo: 5300, employer: 10.5, employee: 10.5 },
  { upTo: 5400, employer: 10.7, employee: 10.7 },
  { upTo: 5500, employer: 10.9, employee: 10.9 },
  { upTo: 5600, employer: 11.1, employee: 11.1 },
  { upTo: 5700, employer: 11.3, employee: 11.3 },
  { upTo: 5800, employer: 11.5, employee: 11.5 },
  { upTo: 5900, employer: 11.7, employee: 11.7 },
  { upTo: 6000, employer: 11.9, employee: 11.9 },
];

/** EIS statutory rates — cross-check only (≈0.2% of the band midpoint); the calculator uses
 *  the exact band table above. */
export const MY_EIS_RATES = { employer: 0.002, employee: 0.002 };

// ─────────────────────────────────────────────────────────────────────────────
// Overtime (Employment Act 1955, First Schedule Amendment Order 2022)
// Employees with monthly wages > RM4,000 are outside the statutory OT entitlement
// (ss.60/60A(3)/60D(3)). The OT multipliers themselves live in payroll.ts (overtimePay).
//
// The workday OT rate (s.60A(3)(a), 1.5×) is NOT here — it is already HR-configurable per employment via
// core/payroll-policy-config.ts (PayrollPolicyConfig.overtime.multiplier, floored at s.60A). Exposing it a
// second time on the ruleset would double-scale the workday leg (once in overtimePay, once in
// applyOvertimeCaps), so only the genuinely un-configurable EXCESS-hours factors are made editable here:
//   - rest-day hours beyond normal ⇒ 2× hourly (s.60(3)(c))
//   - public-holiday hours beyond normal ⇒ 3× hourly (s.60D(3)(aa))
// The base-day compensation legs (rest-day ½/1-day ORP under s.60(3)(b); the 2-days' ORP for working a
// public holiday under s.60D(3)(a)) are EA-fixed base-day pay, NOT OT multipliers, and stay hardcoded.
export const MY_OT_WAGE_CEILING = 4000;
/** Rest-day OVERTIME (hours beyond normal) factor on the hourly rate — EA s.60(3)(c). */
export const MY_OT_RESTDAY_EXCESS = 2.0;
/** Public-holiday OVERTIME (hours beyond normal) factor on the hourly rate — EA s.60D(3)(aa). */
export const MY_OT_HOLIDAY_EXCESS = 3.0;

// ─────────────────────────── HRD Corp levy (PSMB Act 2001) ───────────────────────────
// Mandatory 1% of HRDF wages for employers with 10+ Malaysian employees (s.14); optional 0.5%
// for 5–9 who opt to register (s.15). Employer-only — no employee deduction — and no wage cap.
// The HRDF wage base is basic salary + fixed allowances ONLY; it is NOT the EPF/SOCSO base —
// it excludes bonus, commission, overtime and non-fixed allowances (the caller builds the base).
// Sourced + re-verified against hrdcorp.gov.my / PSMB Act 2001 in docs/wave2-payroll-design.md.
// The 1%/0.5% rates are the built-in baseline; per-company registration lives on
// company_statutory_my.hrdf_status. As of #6 (ADR-0037) HRDF is a first-class versioned body — an admin
// can publish an effective-dated `hrdf` override via the per-body overlay, and the kernel reads it.
export type HrdfStatus = 'not_registered' | 'mandatory' | 'optional';
export const MY_HRDF = { mandatoryRate: 0.01, optionalRate: 0.005 } as const;

// ──────────────── PCB pay-code classification (feedback 09b554e9, LHDN PCB 2026) ────────────────
// Source: LHDN "Spesifikasi Pengiraan PCB 2026 Menggunakan Pengiraan Berkomputer" — the exemption
// categories for Normal/Additional remuneration and the optional-deduction (LP) list, each with its
// yearly limit (RM). Transcribed verbatim from the feedback's LHDN-derived lists (2026-07-22).
// Cap semantics: -1 = fully exempt (no cap); 0 = fully taxable (no exemption); 9999999 = the LHDN
// uncapped sentinel (practically unlimited). Caps are ANNUAL, tracked per employee per code via the
// payslip-ledger replay in core/payroll.ts (like the PCB accumulators).

/** How a pay code is treated in the PCB computerised calculation (drives the exemption-code list). */
export const PCB_REMUNERATION_TYPES = ['normal', 'additional', 'optional_deduction'] as const;
export type PcbRemunerationType = (typeof PCB_REMUNERATION_TYPES)[number];

/** Exemption / optional-deduction code → annual cap (RM). */
export type PcbExemptionTable = Record<string, number>;

/** PCB exemption codes available for Normal AND Additional remuneration (same list for both). */
export const MY_PCB_EXEMPTION_CODES: PcbExemptionTable = {
  PCB_CHILD_CARE: 3000,
  PCB_COMPANY_PROD: 1000,
  'PCB_NON-TAXABLE': -1,
  PCB_PERQUISITE: 2000,
  PCB_TAXABLE: 0,
  PCB_TRA_BUSINESS: 6000,
  PCB_TRA_HOLIDAY: 3000,
};

/** LHDN optional-deduction (LP) codes — Remuneration Type = Optional Deduction only. */
export const MY_LP_OPTIONAL_DEDUCTION_CODES: PcbExemptionTable = {
  LP_ALIMONY: 4000,
  LP_ANNUITY: 3000,
  LP_BREASTFEEDING_EQUIPMENT: 1000,
  LP_CHILD_CARE_KINDERGARDEN: 3000,
  LP_DENTAL: 1000,
  LP_DOMESTIC_TOURISM: 1000,
  LP_EDU_SSPN: 8000,
  LP_ELECTRIC_VEHICLE: 2500,
  LP_FIRSTHOUSE_LOAN1: 7000,
  LP_FIRSTHOUSE_LOAN2: 5000,
  LP_LEARNING_DISABILITY: 10000,
  LP_LIFESTYLE: 2500,
  LP_MED_CHECKUP: 1000,
  LP_MED_CHECKUP_PARENT: 1000,
  LP_MED_CRITICAL_ILL: 10000,
  LP_MED_OWN_PARENT: 8000,
  LP_OPTIONAL_REBATE: 9999999,
  LP_SELF_HIGH_EDU: 7000,
  LP_SOCSO: 350,
  LP_SPORT_EQUIPMENT: 1000,
  LP_SUPP_EDQUIPMENT: 6000,
  LP_UPSKILL: 2000,
  LP_VACCINATION: 1000,
  LP_VOLUNTARY_EPF: 7000,
};

/** The exemption-code list valid for a remuneration type (Normal/Additional share the PCB_* list;
 *  Optional Deduction uses the LP_* list). Pure — shared by the form island, the service validator
 *  and the kernel. `tables` lets the kernel pass the pack-resolved ruleset tables. */
export function pcbExemptionCodesFor(
  type: PcbRemunerationType,
  tables: { pcb: PcbExemptionTable; lp: PcbExemptionTable } = { pcb: MY_PCB_EXEMPTION_CODES, lp: MY_LP_OPTIONAL_DEDUCTION_CODES },
): PcbExemptionTable {
  return type === 'optional_deduction' ? tables.lp : tables.pcb;
}

// ─────────────────────────── Aggregate ruleset (ADR-0019) ───────────────────────────
// All figures above, gathered into one injectable object. The calculators take this as a
// parameter that defaults to DEFAULT_MY_STATUTORY, so a DB override (statutory_ruleset) can
// replace it per company/period while the verified built-in set remains the canonical fallback.

export type StatutoryRuleset = {
  version: string;
  epf: {
    employeeRate: number;
    employerRateLow: number;
    employerRateHigh: number;
    employerThreshold: number;
    /** EPF Third Schedule Part A band table (#95). Optional: DB overrides predating 2026.2 omit it,
     *  and the calculator falls back to the built-in MY_EPF_THIRD_SCHEDULE_PART_A. */
    partA?: ContribBand[];
    /** Last wage (RM) the band table covers; above it the exact percentage applies. Default 20,000. */
    scheduleMax?: number;
    /** Part E band table — Malaysian citizen 60–<75 (employee 0% / employer 4%). Optional fallback. */
    partE?: ContribBand[];
    /** Employer rate for the Part E senior schedule (>RM20,000 tail). Default 0.04. */
    seniorEmployerRate?: number;
    /** Non-citizen mandatory EPF rates (post-1998, eff 1 Oct 2025). Default 0.02 / 0.02. */
    nonCitizenEmployeeRate?: number;
    nonCitizenEmployerRate?: number;
  };
  /** Display: the SOCSO/EIS contribution wage ceiling (the band tables already encode it). */
  contribCeiling: number;
  socso: {
    category1: SocsoBand[];
    category2: SocsoBand[];
    /** Display/cross-check only — the calculator uses the exact band tables. */
    rates: { employer: number; employee: number };
    verifiedUpTo: number;
  };
  eis: { bands: ContribBand[]; rates: { employer: number; employee: number } };
  pcb: {
    bands: PcbBand[];
    reliefs: {
      individual: number;
      spouse: number;
      perChild: number;
      epfReliefCap: number;
      /** d64d0df4 — the further deduction for a registered disabled individual (OKU). OPTIONAL: an
       *  override or pack predating 2026.6 omits it and `pcbMonth` falls back to the built-in
       *  MY_RELIEFS value, exactly as `hrdfLevy` falls back to MY_HRDF. */
      disabledIndividual?: number;
      /** d64d0df4 — the further deduction for a DISABLED SPOUSE, on top of `spouse` and gated to
       *  category 2 exactly as `spouse` is. OPTIONAL: an override or pack predating 2026.7 omits it
       *  and `pcbMonth` falls back to the built-in MY_RELIEFS value. */
      disabledSpouse?: number;
      /** d64d0df4 — the per-child deduction broken out by the five LHDN s.48 categories, keyed by the
       *  ChildReliefCategory keys (under_18 / study_preu / study_tertiary / disabled / disabled_study).
       *  OPTIONAL: an override or pack predating 2026.7 omits it and `pcbMonth` falls back to the
       *  built-in map. Read ONLY for an employee in 'auto_table' child-relief mode; every other
       *  employee keeps `children × perChild`. */
      childByCategory?: Record<string, number>;
    };
  };
  ot: {
    wageCeiling: number;
    /** Rest-day excess-hours factor (s.60(3)(c)). Optional: overrides predating 2026.4 omit it and
     *  overtimePay falls back to the EA built-in MY_OT_RESTDAY_EXCESS (2.0). */
    restDayExcessMultiplier?: number;
    /** Public-holiday excess-hours factor (s.60D(3)(aa)). Optional fallback to MY_OT_HOLIDAY_EXCESS (3.0). */
    holidayExcessMultiplier?: number;
  };
  /** HRD Corp levy rates (#6, ADR-0037). Optional: overrides/packs predating 2026.4 omit it and
   *  `hrdfLevy` falls back to the built-in MY_HRDF. A first-class versioned body via the overlay. */
  hrdf?: { mandatoryRate: number; optionalRate: number };
  /** PCB pay-code exemption tables (feedback 09b554e9, LHDN PCB 2026): the PCB_* exemption codes
   *  (normal/additional remuneration) + the LP_* optional-deduction codes, each with its annual cap (RM).
   *  Optional: overrides/packs predating 2026.5 omit it and the kernel falls back to the built-ins. */
  pcbExemptions?: { pcb: PcbExemptionTable; lp: PcbExemptionTable };
};

/** The statutory bodies that version independently via the per-body overlay (ADR-0037). */
export const STATUTORY_BODIES = ['epf', 'socso', 'eis', 'pcb', 'ot', 'hrdf'] as const;
export type StatutoryBody = (typeof STATUTORY_BODIES)[number];

/** The verified, sourced 2026.1 ruleset — the canonical default + fallback (ADR-0019). */
export const DEFAULT_MY_STATUTORY: StatutoryRuleset = {
  version: MY_STATUTORY_VERSION,
  epf: MY_EPF,
  contribCeiling: MY_CONTRIB_CEILING,
  socso: {
    category1: MY_SOCSO_CATEGORY1_SKBBK,
    category2: MY_SOCSO_CATEGORY2_SKBBK,
    rates: MY_SOCSO_RATES,
    verifiedUpTo: MY_SOCSO_VERIFIED_UP_TO,
  },
  eis: { bands: MY_EIS_BANDS, rates: MY_EIS_RATES },
  pcb: { bands: MY_PCB_BANDS, reliefs: MY_RELIEFS },
  ot: {
    wageCeiling: MY_OT_WAGE_CEILING,
    restDayExcessMultiplier: MY_OT_RESTDAY_EXCESS,
    holidayExcessMultiplier: MY_OT_HOLIDAY_EXCESS,
  },
  hrdf: MY_HRDF,
  pcbExemptions: { pcb: MY_PCB_EXEMPTION_CODES, lp: MY_LP_OPTIONAL_DEDUCTION_CODES },
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LHDN TP1 (1/2026) — the deduction/rebate CATALOGUE (item 7ad37961, ADR-0081)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// The seventeen numbered deduction items (C1–C17) and the Section D rebate lines of PCB FORM /TP1
// (1/2026) — "Individual Tax Deduction and Rebate Claim Form for Monthly Tax Deduction Purposes (PCB)",
// prescribed under s.152 ITA 1967, Income Tax (Deductions from Remuneration) Regulations 1994.
//
// WHY THE CATALOGUE LIVES HERE AND NOT IN THE FORM. Every ringgit figure below is a STATUTORY number and
// belongs to the country pack (ADR-0080 D6), the same place `MY_RELIEFS` lives. The screen renders these
// limits, it does not restate them — `messages/*.json` embedding "RM 9,000" in prose (as the legacy
// taxRelief.categories help strings do) is exactly the second source this replaces. One figure moves,
// one file changes, six locales stay correct.
//
// ── WHAT "LIMIT" MEANS, AND WHAT NULL MEANS (ADR-0008: no unsourced statutory number) ───────────────
// `limit` is the ANNUAL LIMIT (RM) the form itself prints in its own "ANNUAL LIMIT (RM)" column against
// that item. `null` means the form prints NO figure there — the item is still captured, still summed
// into `tp1_amount` and still printed on the generated form, but nothing blocks on a cap we cannot cite.
// A guessed cap on a live payroll is a wrong-figure defect; a null is a missing check. We take the null.
//
// `frequency` is a restriction the form states IN WORDS ("Limited to once every 2 years of assessment").
// It is CAPTURED AND PRINTED, never enforced: enforcing it needs a claim history this system does not
// hold (the employee's assessment-year record at LHDN, not ours), and a wrong refusal on a valid claim is
// worse than no check. It is surfaced to the employee as the note the paper form carries.
//
// ── SUB-ITEMS ──────────────────────────────────────────────────────────────────────────────────────
// An item with `subItems` has a separate amount box PER SUB-ITEM on the paper form and ONE shared
// Current/Accumulated pair; the item's amount is the sum of its sub-items and the group `limit` caps
// that sum. A sub-item `limit` is the "(Limited RM…)" the form prints against that line, and it caps the
// sub-item on its own, INSIDE the group limit.
//
// C16 IS THE ONE EXCEPTION (`perSubLimit`): the form gives its two house-price bands their OWN annual
// limit AND their own Current/Accumulated row, so they are two independent claims, not a group.
//
// SOURCE: the LHDN TP1 (1/2026) document attached to item 7ad37961, transcribed field by field.
// Recorded in docs/architecture/STATUTORY-SOURCES.md §9.

/** One lettered sub-line of a TP1 item — a box on the paper form. */
export type Tp1CatalogueSubItem = {
  /** The letter the form prints ('a', 'b', …). Stable: it is the persisted JSONB key. */
  readonly code: string;
  /** The "(Limited RM…)" figure the form prints against this line, or null when it prints none. */
  readonly limit: number | null;
  /** A frequency restriction stated in words on the form. Captured and printed, never enforced. */
  readonly frequency?: string;
};

/** One numbered TP1 deduction item (C1–C17) or Section D rebate line. */
export type Tp1CatalogueItem = {
  /** 'c1'…'c17' / 'd1'. Stable: it is the persisted JSONB key and the i18n key. */
  readonly code: string;
  /** The ANNUAL LIMIT (RM) column on the form; null when the form prints no figure (ADR-0008). */
  readonly limit: number | null;
  /** Lettered sub-lines with their own box. Empty when the item is a single line on the form. */
  readonly subItems: readonly Tp1CatalogueSubItem[];
  /** C16 only: each sub-item is its OWN claim with its own limit and its own Current/Accumulated row. */
  readonly perSubLimit?: boolean;
  /** A frequency restriction stated in words on the form. Captured and printed, never enforced. */
  readonly frequency?: string;
};

/** The C1–C17 deduction items of TP1 (1/2026), in the form's own order. */
export const MY_TP1_2026_ITEMS: readonly Tp1CatalogueItem[] = [
  // C1 — expenditure for parents/grandparents. Group limit 8,000; (c) carries its own RM1,000.
  {
    code: 'c1',
    limit: 8000,
    subItems: [
      { code: 'a', limit: null }, // medical treatment, special needs and caregivers
      { code: 'b', limit: null }, // dental treatment
      { code: 'c', limit: 1000 }, // full medical check-up including vaccinations
    ],
  },
  // C2 — basic support equipment for oneself / spouse / child / parents with disabilities.
  { code: 'c2', limit: 6000, subItems: [] },
  // C3 — study fees (oneself). Group 7,000; (c) skills/personal development carries RM2,000.
  {
    code: 'c3',
    limit: 7000,
    subItems: [
      { code: 'a', limit: null }, // levels other than Master's/PhD in the listed fields
      { code: 'b', limit: null }, // Master's or Doctorate in any field
      { code: 'c', limit: 2000 }, // skills enhancement / personal development courses
    ],
  },
  // C4 — medical expenses. Group 10,000; four of the six sub-lines carry their own printed sub-limit.
  {
    code: 'c4',
    limit: 10000,
    subItems: [
      { code: 'a', limit: null }, // serious illness — self / spouse / child
      { code: 'b', limit: null }, // fertility treatment — self / spouse
      { code: 'c', limit: 1000 }, // vaccination — self / spouse / child
      { code: 'd', limit: 1000 }, // dental check-up or treatment
      { code: 'e', limit: 1000 }, // full medical checkup, mental health, screening, self-monitoring
      { code: 'f', limit: 10000 }, // diagnostic / early intervention / rehabilitation, ≤18 learning disabilities
    ],
  },
  // C5 — lifestyle. Group 2,500, no printed sub-limits.
  {
    code: 'c5',
    limit: 2500,
    subItems: [
      { code: 'a', limit: null }, // books, journals, magazines, newspapers, other publications
      { code: 'b', limit: null }, // personal computers / smartphones / tablets (not for business use)
      { code: 'c', limit: null }, // monthly internet subscription (in your own name)
      { code: 'd', limit: null }, // skill improvement or self-development course
    ],
  },
  // C6 — lifestyle, sport-related, for self / spouse / children / parents. Group 1,000.
  {
    code: 'c6',
    limit: 1000,
    subItems: [
      { code: 'a', limit: null }, // sports equipment (Sports Development Act 1997)
      { code: 'b', limit: null }, // rental or entry fees for sports facilities
      { code: 'c', limit: null }, // sports competition registration fees
      { code: 'd', limit: null }, // gym membership or sports training fees
    ],
  },
  // C7 — breastfeeding equipment, child aged 2 and below. The frequency rule IS printed on the form.
  { code: 'c7', limit: 1000, subItems: [], frequency: 'onceEveryTwoYears' },
  // C8 — childcare / kindergarten / day-care / transit centre fees, children aged 12 and below.
  { code: 'c8', limit: 3000, subItems: [] },
  // C9 — net savings in the National Education Savings Scheme (SSPN).
  { code: 'c9', limit: 8000, subItems: [] },
  // C10 — alimony payment to the ex-wife.
  { code: 'c10', limit: 4000, subItems: [] },
  // C11 — voluntary EPF / life insurance. THE GROUP LIMIT IS 7,000 — printed against the brace joining
  // the two lines — with (a) limited to RM4,000 INCLUDING mandatory EPF contributions and (b) to
  // RM3,000. The item description on the board recorded only the two sub-limits; the form's own annual
  // limit column says 7,000, so the group cap is carried too.
  {
    code: 'c11',
    limit: 7000,
    subItems: [
      { code: 'a', limit: 4000 }, // voluntary EPF (limited RM4,000 including mandatory EPF contributions)
      { code: 'b', limit: 3000 }, // life insurance / voluntary EPF
    ],
  },
  // C12 — private retirement schemes and deferred annuities.
  { code: 'c12', limit: 3000, subItems: [] },
  // C13 — education and medical insurance.
  { code: 'c13', limit: 4000, subItems: [] },
  // C14 — PERKESO contributions (Employees' Social Security Act 1969 / Employment Insurance System
  // Act 2017).
  { code: 'c14', limit: 350, subItems: [] },
  // C15 — EV charging facilities / food-waste composting machine / food-waste shredder / CCTV. ONE line
  // with ONE amount box on the form (not four), annual limit 2,500, and TWO different frequency rules
  // inside the same sentence — hence the compound key, rendered as the note the form prints.
  { code: 'c15', limit: 2500, subItems: [], frequency: 'compostingThreeYearsShredderCctvTwoYears' },
  // C16 — first home loan interest. TWO INDEPENDENT CLAIMS: the form gives each house-price band its own
  // annual limit AND its own Current/Accumulated row, so this is `perSubLimit`, not a group.
  {
    code: 'c16',
    limit: null,
    perSubLimit: true,
    subItems: [
      { code: 'a', limit: 7000 }, // house price up to RM500,000
      { code: 'b', limit: 5000 }, // house price above RM500,000 up to RM750,000
    ],
  },
  // C17 — entrance fees to tourist centres and cultural/arts programmes for domestic tourism.
  { code: 'c17', limit: 1000, subItems: [] },
] as const;

/**
 * Section D — REBATE. Not a deduction: a rebate reduces the tax, it does not reduce chargeable income,
 * so these amounts are NOT part of the `tp1_amount` roll-up the PCB kernel consumes. They are captured,
 * stored and printed on the form. The paper form prints NO annual-limit figure against either line.
 *
 * D1(a) is zakat OTHER THAN that paid through monthly salary deductions — the exclusion is the whole
 * point of the line, and it is what stops the same zakat being counted twice against a person who also
 * has a payroll zakat deduction (core/tax-relief.ts states the rule; test/tp1-zakat-screens.test.ts and
 * the new case in test/tp1-relief-redesign.test.ts hold it).
 */
export const MY_TP1_2026_REBATES: readonly Tp1CatalogueItem[] = [
  {
    code: 'd1',
    limit: null,
    subItems: [
      { code: 'a', limit: null }, // zakat other than that paid through monthly salary deductions
      { code: 'b', limit: null, frequency: 'twoClaimsLifetime' }, // Umrah / religious travel exemption levy
    ],
  },
] as const;

/** The whole TP1 (1/2026) catalogue as the pack exposes it. */
export const MY_TP1_2026 = {
  /** The form revision this catalogue transcribes — printed on the generated form. */
  formCode: 'PCB FORM /TP1 (1/2026)',
  items: MY_TP1_2026_ITEMS,
  rebates: MY_TP1_2026_REBATES,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LHDN TP3 (1/2026) — PREVIOUS EMPLOYMENT (item df35d60d, stage 1)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// PCB FORM /TP3 (1/2026) — "Individual Tax Deduction and Rebate Claim Form for Monthly Tax Deduction
// Purposes (PCB)", prescribed under s.152 ITA 1967, Income Tax (Deductions from Remuneration)
// Regulations 1994. Transcribed field by field from the reporter's own attachment (feedback_attachment
// 696af02f-2a08-4c60-8fbc-670fb90c2ebd, 3 pages, read 2026-09-22).
//
// ── ⚠️ SECTION D IS NOT A NEW TABLE. IT IS `MY_TP1_2026_ITEMS`, THE SAME ARRAY OBJECT ───────────────
//
// The TP3's Section D asks for the SAME seventeen reliefs, in the SAME order, with the SAME annual
// limits, the SAME lettered sub-lines and the SAME "(Limited RM…)" sub-limits as the TP1's Section C.
// Every figure was re-read off the TP3 PDF against the TP1 catalogue above and every one of them
// matches. They are not the same DATA — a TP1 is claimed through THIS employer and a TP3's Section D
// through the PREVIOUS one, and both count toward the same annual limit — but they are one TAXONOMY.
//
// So `sectionD` below is `MY_TP1_2026_ITEMS` BY REFERENCE, not a copy of it. A second transcription of
// a statutory limit table is exactly the competing source of truth CLAUDE.md §1 forbids: a cap that
// moved in one list and not the other would be a wrong tax figure with nothing to report it, and the
// two lists would agree only for as long as somebody kept them agreeing. `test/df35d60d-tp3-form.test.ts`
// asserts the IDENTITY (`toBe`, not `toEqual`), so replacing the reference with a copy fails the suite
// rather than passing it.
//
// THE NUMBERING DIFFERS AND THE CODES DELIBERATELY DO NOT. TP1 prints these as C1–C17, TP3 as D1–D17,
// one-for-one in the same order. The item CODE stays `c1`…`c17` because it is the persisted JSONB key
// on `tp1_relief.categories` and the i18n key in `messages/*.json`; renaming it would rewrite live tax
// records to change a letter on a printout. `tp3LineNumber` is the whole of the difference, and the
// test pins the 1:1 correspondence so a future divergence cannot arrive silently.
//
// ── SECTION C IS TP3'S OWN, AND IT IS THE REASON THIS ITEM EXISTS ──────────────────────────────────
//
// The five Section C lines have no TP1 counterpart: they are the previous employment's accumulated
// money. `employee_statutory_my` already holds a `tp3_net_remuneration`, but that column is
// (C1 − ΣC2) − C3 already combined, and that combination is NOT INVERTIBLE — which is precisely why the
// form could not be rendered from what was stored. These are the form's own separate boxes.
//
// NO `limit` ON ANY SECTION C LINE, and that is the form's own answer: its Section C prints a single
// "ACCUMULATED DEDUCTION (RM)" column and no annual-limit column at all. C4(ii) carries the only
// restriction the form states, and it states it in words, so it rides `frequency` exactly as the
// Section D frequency rules do — captured and printed, never enforced (ADR-0008 / the TP1 catalogue's
// own reasoning above).

/** One lettered sub-line of a TP3 Section C money line — a box on the paper form. */
export type Tp3MoneyLineSubItem = {
  /** The numeral the form prints ('i', 'ii', …). Stable: it is the persisted JSONB key. */
  readonly code: string;
  /** A restriction the form states in words. Captured and printed, never enforced. */
  readonly frequency?: string;
  /**
   * The STATUTORY EXEMPTION LIMIT for this line, per year, in ringgit — or absent when none is sourced.
   *
   * ⚠️ READ OFF THE SPECIFICATION, NOT OFF THIS FORM, AND THEREFORE SHOWN AND NEVER ENFORCED.
   * `MY_TP3_2026_SECTION_C`'s header records the whole reasoning; the short version is that the TP3's
   * Section C prints ONE column (`AMAUN TERKUMPUL (RM)`) and no limit column at all, so under ADR-0008
   * there is no cap on this form to block against. The figure here is guidance for the operator and the
   * input to a non-blocking over-limit warning; it never reduces a stored box and never refuses a save.
   */
  readonly exemptionLimit?: number | null;
};

/** One numbered TP3 Section C line (C1–C5). */
export type Tp3MoneyLine = {
  /** 'c1'…'c5'. Stable: it is the persisted JSONB key and the i18n key. */
  readonly code: string;
  /** Roman-numeral sub-lines with their own box. Empty when the line is a single box on the form. */
  readonly subItems: readonly Tp3MoneyLineSubItem[];
};

/**
 * TP3 Section C — REMUNERATION INFORMATION / EPF / ZAKAT / PCB, in the form's own order.
 *
 * The form's own caption over this section: "Please state the total amount from previous employment(s)
 * during the current year."
 *
 * ══ WHY THE EXEMPTION LIMITS ARE SHOWN AND NEVER ENFORCED (item 20837372) ═══════════════════════════
 *
 * THE FORM PRINTS NO LIMIT COLUMN ON SECTION C. Read on the agency's own PDFs, both of them: Exhibit 2
 * of `spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf` (printed page 39) and the standalone
 * `bm-borang-tp3-2026.pdf` (page 1) each give Bahagian C exactly ONE money column, `AMAUN TERKUMPUL
 * (RM)`. Bahagian D on the very next page gives TWO — `HAD TAHUNAN (RM)` and `POTONGAN TERKUMPUL (RM)`.
 * The agency put a limit column on the section that has limits and left it off the section that does
 * not, so ADR-0008's rule ("an item with no printed cap is captured and never blocked") is decided here
 * by the form itself: Section C is captured, never blocked.
 *
 * THE LIMITS STILL EXIST — they are just somewhere else, and they bind a DIFFERENT step. Specification
 * printed page 20, item 9: "MTD is to be deducted from the employee's taxable remuneration only. All
 * the tax exemption on allowances, benefit-in-kind and perquisites shall be excluded from the
 * remuneration for MTD purposes. ANY AMOUNT EXCEED THE RESTRICTED AMOUNT SHALL BE TAXABLE." That
 * sentence is addressed to the employer working out the payroll in the first place, which for a TP3 is
 * the PREVIOUS employer. By the time a figure reaches this form the over-limit part has already been
 * moved into the taxable side — so capping C2 here a second time would tax the same ringgit twice.
 * Hence: print the limit beside the box, WARN when the keyed figure exceeds it (which means the form was
 * filled wrong and the operator should fix the form), and never silently move the money.
 *
 * ⚠️ UNKNOWN, AND DELIBERATELY NOT RESOLVED HERE — DOES C1 ALREADY EXCLUDE C2? The Malay caption on C1
 * is "Jumlah saraan kasar bulanan dan saraan tambahan termasuk elaun / perkuisit / pemberian / Manfaat
 * YANG DIKENAKAN CUKAI" ("…including allowances / perquisites / gifts / benefits THAT ARE SUBJECT TO
 * TAX"), which reads as though the exempt amounts were never in C1; C2's caption is the mirror image,
 * "…YANG DIKECUALIKAN CUKAI". On that reading `C1 − ΣC2` double-subtracts. `core/tp3.ts`'s
 * `deriveAccumulatorSeed` has subtracted ΣC2 since item 1bb09a73 and this round does NOT change it: the
 * question is a live UNKNOWN that only `Nota Penerangan Borang TP3 (2026)` can settle, and that document
 * was not reachable (both of the agency's published URLs for it return 404). Moving a statutory figure
 * on an unresolved reading is the one thing that must not happen quietly, so it is written down instead.
 */
export const MY_TP3_2026_SECTION_C: readonly Tp3MoneyLine[] = [
  // C1 — total monthly gross remuneration AND additional remuneration, including allowances /
  // perquisites / gifts / benefits. This is LHDN's Y before anything is taken off it.
  { code: 'c1', subItems: [] },
  // C2 — the tax-exempt allowances / perquisites / gifts / benefits, in five separate boxes.
  //
  // ⚠️ THE LIMITS BELOW ARE NOT PRINTED ON THIS FORM. See the file-level note on `exemptionLimit` and
  // the section header above: TP3 Section C has ONE column and no limit column. Each figure is
  // transcribed from the MTD specification's own table, "List of tax exempt allowances / perquisites /
  // gifts / benefits which are required to declare" — SPECIFICATION PRINTED PAGE 21 (PDF page 22 of
  // `spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf`) — whose roman numerals are the
  // specification's own and do NOT line up with the form's, so each mapping is named individually.
  {
    code: 'c2',
    subItems: [
      // C2(i) travel allowance, petrol card or petrol allowance, and toll fees, for official duties.
      // Specification printed page 21, item i: "Petrol card, petrol allowance, travelling allowance or
      // toll payment or any of its combination for official duties." EXEMPTION LIMIT (PER YEAR)
      // RM6,000.00. The same entry adds that an amount above RM6,000 may still be deducted for what was
      // actually spent on official duties, which is a second reason this is a warning and not a cap.
      { code: 'i', exemptionLimit: 6_000 },
      // C2(ii) child-care allowance. Specification printed page 21, item ii: "Child care allowance in
      // respect of children up to 12 years of age." EXEMPTION LIMIT (PER YEAR) RM3,000.00.
      { code: 'ii', exemptionLimit: 3_000 },
      // C2(iii) products of the employer's own business given free or at a discount.
      // ⚠️ NO LIMIT IS SOURCED. This line has NO counterpart in the specification's printed-page-21
      // table, and the form prints none. ADR-0008: captured, shown without a limit, never blocked. A
      // plausible figure is not put here to have something to check against.
      { code: 'iii', exemptionLimit: null },
      // C2(iv) past-service achievement / excellent-service / innovation / productivity awards and
      // long-service awards (more than 10 years with the same employer). Specification printed page 21,
      // item v — the specification's fifth entry, this form's fourth line; the wording is the same three
      // clauses in the same order. EXEMPTION LIMIT (PER YEAR) RM2,000.00.
      { code: 'iv', exemptionLimit: 2_000 },
      // C2(v) other tax-exempt allowances — the form itself points at the Form BE explanatory notes.
      // ⚠️ NO SINGLE LIMIT EXISTS, BY CONSTRUCTION: this box is a remainder covering the rest of the
      // specification's table, whose entries carry different limits (one unit per asset category, the
      // actual amount expended, a loan-interest formula). One number cannot stand for all of them.
      { code: 'v', exemptionLimit: null },
    ],
  },
  // C3 — total approved EPF or other approved fund contributions on ALL remuneration (monthly salary
  // AND additional remuneration). This is LHDN's K.
  { code: 'c3', subItems: [] },
  // C4 — zakat and the Umrah / religious-travel departure levy relief.
  //
  // ⚠️ C4(i) IS NOT THE TP1'S REBATE LINE D1(a). The TP1 rebate is zakat OTHER THAN that paid through
  // monthly salary deductions — the exclusion is the whole point of that line. This is the previous
  // employment's TOTAL zakat, salary deductions included, because the employer it is accumulated from
  // is not this one. They share no label and no key, deliberately.
  {
    code: 'c4',
    subItems: [
      { code: 'i' }, // Total Zakat
      // The form prints "(Limited to 2 claims in a lifetime)" — the same restriction, and the same
      // MESSAGE KEY, as the TP1's own Umrah rebate line. One statutory rule, one string.
      { code: 'ii', frequency: 'twoClaimsLifetime' },
    ],
  },
  // C5 — total PCB, EXCLUDING CP38. This is LHDN's X. CP38 is a separate instalment direction and the
  // form excludes it in its own words; nothing here infers or nets it.
  { code: 'c5', subItems: [] },
] as const;

/**
 * The maximum number of previous employers the form is RULED FOR — two (A1/A2 and A3/A4).
 *
 * A NUMBER, NOT A GUESS. The form's own footnote under A4 reads "*Please use additional attachment for
 * the next employment", so two is what the printed form can carry and a third is an attachment rather
 * than a third pair of boxes. The service refuses a third rather than silently dropping it; the screen
 * says why and points at the attachment, which is the form's own answer.
 */
export const MY_TP3_2026_MAX_EMPLOYERS = 2;

/**
 * TP3 line number for a shared-taxonomy item code — `c1` → 1, printed as "D1" on the TP3.
 *
 * THE ONE PLACE THE TWO FORMS' NUMBERING IS RECONCILED. It is derived from the item's POSITION in the
 * shared schedule rather than from parsing its code, so an item inserted into the schedule renumbers
 * both forms together instead of only the one whose renderer someone remembered to edit. Returns null
 * for a code that is not in the schedule, which is what a Section D renderer must refuse to print.
 */
export function tp3LineNumber(code: string): number | null {
  const i = MY_TP1_2026_ITEMS.findIndex((x) => x.code === code);
  return i < 0 ? null : i + 1;
}

/** The whole TP3 (1/2026) form definition as the pack exposes it. */
export const MY_TP3_2026 = {
  /** The agency's own revision string — printed on the generated form. */
  formCode: 'PCB FORM /TP3 (1/2026)',
  sectionC: MY_TP3_2026_SECTION_C,
  /** ⚠️ THE SAME ARRAY OBJECT as `MY_TP1_2026.items`. See the header. Never a copy. */
  sectionD: MY_TP1_2026_ITEMS,
  maxEmployers: MY_TP3_2026_MAX_EMPLOYERS,
} as const;
