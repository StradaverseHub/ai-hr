/**
 * Malaysia statutory tables — rules-as-data (ADR-0008).
 *
 * Every figure here is transcribed from an official publication and carries its effective
 * date, source, and a `verified` flag. Full provenance + the human verification checklist
 * live in docs/architecture/STATUTORY-SOURCES.md. DO NOT change a number without updating
 * that doc and bumping MY_STATUTORY_VERSION.
 *
 * Retrieved: 2026-06-06.
 */

export const MY_STATUTORY_VERSION = '2026.4';
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

/** Annual reliefs (RM) used to project chargeable income P. Source: LHDN 2026 MTD spec. VERIFIED. */
export const MY_RELIEFS = {
  /** D — individual + dependent relatives. */
  individual: 9000,
  /** S — non-working spouse (Category 2 only). */
  spouse: 4000,
  /** Q per qualifying child C. */
  perChild: 2000,
  /** K — mandatory EPF qualifying cap per year (life insurance is a separate TP1 item). */
  epfReliefCap: 4000,
};

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
    reliefs: { individual: number; spouse: number; perChild: number; epfReliefCap: number };
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
};
