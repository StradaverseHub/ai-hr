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

export const MY_STATUTORY_VERSION = '2026.1';
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

export const MY_EPF = {
  employeeRate: 0.11,
  /** Employer pays 13% when monthly wage ≤ RM5000, else 12%. */
  employerRateLow: 0.13,
  employerRateHigh: 0.12,
  employerThreshold: 5000,
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

export type ContribBand = { upTo: number; employer: number; employee: number };

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
