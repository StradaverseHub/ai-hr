/**
 * Board 8edeef41 — owner decision 2026-11-25 (amends ADR-0090): a taxable BIK/VOLA pay item may be Normal (Y1, the
 * default and today's behaviour) or Additional (Yt through the existing section D.2 path, Kt = 0, no EPF/SOCSO/EIS).
 *
 * THE WORKED EXAMPLE IS COMPUTED BY HAND from docs/forms/pcb-spec-2026-computerised-calculation.pdf, never from the code
 * under test. Every figure below is written out with its arithmetic; the engine is then asserted against it, so a
 * disagreement is a defect in one of the two and the test says which figure.
 *
 * Fictional employee: resident, category 1 (single), no children, no TP1, no zakat, no prior months this year
 * (ΣY−K = 0, K = 0, X = 0, Z = 0), EPF Part A citizen under 60. Month: July 2026, so n = 12 − 7 = 5 and n + 1 = 6.
 * Cash: basic RM9,000.00 (no bonus). Benefit: BKBOP (BIK) RM4,111.00, fully taxable (PCB_TAXABLE, no exemption).
 *
 * Spec values used: individual deduction D = RM9,000; EPF relief total qualifying amount RM4,000 a year; Table 1
 * (category 1): 35,001–50,000 → M 35,000, R 6 %, B 600; 50,001–70,000 → M 50,000, R 11 %, B 1,500.
 * EPF Third Schedule (wages above RM5,000, RM100 bands): wage RM9,000 → employee share 11 % × 9,000 = RM990.00.
 *
 * Rules applied at the end of each MTD (spec section E): truncate to two decimals; round UP to the next 5 sen; an MTD
 * below RM10 is not deducted (RM10 floor), applied to the normal and the additional MTD separately.
 */
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { statutory, foldPriorSlipIntoAccumulators, type PcbAccumulators } from '../localization/my/payroll';
import { computeMonthlyRuns } from '../localization/my/multicycle';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import {
  createNonCashOwnershipReplay, nonCashComparisonInputs, pcbNonCashStreams, readPcbNonCash, taxableNonCash, totalNonCash,
  versionedPcbNonCash, type NonCashEaEntry, type NonCashEntry, type PcbNonCashSnapshot,
} from '../localization/noncash-benefits';
import { replayMyTaxBasis, type TaxBasisItemSetting, type TaxBasisReplayInput } from '../localization/my/tax-basis-replay';
import { projectImportedTaxBasis } from '../core/payroll-import-tax-source';
import { SYSTEM_BASIC_TAX_SETTING, type ImportedTaxSetting } from '../lib/payroll-import-tax-input';
import type { ImportCodeEntry } from '../lib/payroll-history-import-schema';
import { explainPcb, pcbClosingSections, pcbSlipSections, pcbWorksheet } from '../core/pcb-explain';
import { accumulatedEaNonCash, eaNonCashExemption } from '../localization/my/ea-noncash';
import { PcbDetailView } from '../app/payroll/pcb-detail/pcb-detail-view';

const state = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl'); const fs = await import('node:fs');
  return { getTranslations: async (arg: any) => { const locale = typeof arg === 'string' ? state.locale : arg.locale ?? state.locale;
    return createTranslator({ locale, messages: JSON.parse(fs.readFileSync(`messages/${locale}.json`, 'utf8')), namespace: typeof arg === 'string' ? arg : arg.namespace }); } };
});

const profile = { category: 1 as const, children: 0 };
const july = { month: 7 };
const BASIC = 9000, BKBOP = 4111;
const AGENCY = ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer'] as const;

// ── THE HAND CALCULATION ────────────────────────────────────────────────────────────────────────────────────────
// Common to both routes:
//   K1 = EPF on Y1's cash wage = 11 % × 9,000 = 990.00 (a benefit carries no EPF, so K1 is the same either way).
//   K  = 0 (no earlier month). K1 within the RM4,000 cap: min(990, 4,000 − 0) = 990.
//   K2 = [4,000 − (K + K1 + Kt)] / n or K1, whichever is lower = (4,000 − 0 − 990 − 0) / 5 = 3,010 / 5 = 602.00 < 990 → 602.00.
//
// (1) BKBOP as NORMAL (Y1 includes the benefit; Y2 = Y1):
//   Y1 = 9,000 + 4,111 = 13,111.00
//   P1 = ΣY−K + (Y1 − K1) + (Y2 − K2) × n − D
//      = 0 + (13,111 − 990) + (13,111 − 602) × 5 − 9,000
//      = 12,121 + 12,509 × 5 − 9,000 = 12,121 + 62,545 − 9,000 = 65,666.00
//   Table 1: 50,001–70,000 → tax = (65,666 − 50,000) × 11 % + 1,500 = 15,666 × 0.11 + 1,500 = 1,723.26 + 1,500 = 3,223.26
//   MTD = (tax − (Z + X)) / (n + 1) = (3,223.26 − 0) / 6 = 537.21 exactly → truncated 537.21
//   5-sen rule: 537.21 → 537.25.   RM10 floor: 537.25 ≥ 10, kept.   No additional remuneration → total MTD 537.25.
//
// (2) BKBOP as ADDITIONAL (Yt = 4,111, Kt = 0 because a benefit has no EPF):
//   Step 1  Y1 = 9,000.00 (cash only)
//           P1 = 0 + (9,000 − 990) + (9,000 − 602) × 5 − 9,000 = 8,010 + 41,990 − 9,000 = 41,000.00
//           tax on P1 (35,001–50,000) = (41,000 − 35,000) × 6 % + 600 = 360 + 600 = 960.00
//           normal MTD = 960.00 / 6 = 160.00 → truncated 160.00 → 5-sen 160.00 → RM10 floor kept: 160.00
//           Step 1[E] total MTD for the year = X + 160.00 × (n + 1) = 0 + 960.00 = 960.00
//   Step 2  K2 with Kt: [4,000 − (0 + 990 + 0)] / 5 = 602.00 (unchanged because Kt = 0)
//           P2 = 0 + (9,000 − 990) + (9,000 − 602) × 5 + (Yt − Kt) − 9,000 = 41,000 + (4,111 − 0) = 45,111.00
//   Step 3  tax on P2 (35,001–50,000) = (45,111 − 35,000) × 6 % + 600 = 10,111 × 0.06 + 600 = 606.66 + 600 = 1,206.66
//   Step 4  additional MTD = 1,206.66 − 960.00 + 0 (zakat) = 246.66 → truncated 246.66 → 5-sen 246.70 → RM10 floor kept
//   Step 5  MTD for the month = 160.00 + 246.70 = 406.70
//
// RM10 FLOOR CASE: a BKBOP of RM100.00 instead of RM4,111.00.
//   As Normal:     Y1 = 9,100; P1 = (9,100 − 990) + (9,100 − 602) × 5 − 9,000 = 8,110 + 42,490 − 9,000 = 41,600.00
//                  tax = (41,600 − 35,000) × 6 % + 600 = 396 + 600 = 996.00; MTD = 996.00 / 6 = 166.00 → 166.00.
//   As Additional: P1 = 41,000.00 → normal MTD 160.00 (as above); P2 = 41,000 + 100 = 41,100.00
//                  tax on P2 = (41,100 − 35,000) × 6 % + 600 = 366 + 600 = 966.00
//                  additional MTD = 966.00 − 960.00 = 6.00 → 5-sen 6.00 → below RM10, NOT deducted → 0.00
//                  MTD for the month = 160.00 + 0.00 = 160.00
const HAND = {
  epfEmployee: 990, K2: 602,
  normal: { Y1: 13111, P1: 65666, taxOnP1: 3223.26, mtdTruncated: 537.21, mtd: 537.25 },
  additional: { Y1: 9000, P1: 41000, taxOnP1: 960, mtdNormal: 160, totalMtdYear: 960, Yt: 4111, Kt: 0, K2t: 602,
    P2: 45111, totalTaxYear: 1206.66, additionalTruncated: 246.66, additionalMtd: 246.7, mtd: 406.7 },
  floor: { normalMtd: 166, additionalCalc: 6, additionalFloored: 0, additionalMtd: 160 },
};

describe('8edeef41 worked PCB example: BKBOP as Normal, as Additional, and by hand', () => {
  it('the hand arithmetic is self-consistent (no code under test involved)', () => {
    const cents = (n: number) => Math.round(n * 100);
    expect(cents((13111 - 990) + (13111 - 602) * 5 - 9000)).toBe(cents(HAND.normal.P1));
    expect(cents((65666 - 50000) * 0.11 + 1500)).toBe(cents(HAND.normal.taxOnP1));
    expect(cents(3223.26 / 6)).toBe(cents(HAND.normal.mtdTruncated));
    expect(cents((9000 - 990) + (9000 - 602) * 5 - 9000)).toBe(cents(HAND.additional.P1));
    expect(cents(HAND.additional.P1 + 4111)).toBe(cents(HAND.additional.P2));
    expect(cents((45111 - 35000) * 0.06 + 600)).toBe(cents(HAND.additional.totalTaxYear));
    expect(cents(1206.66 - 960)).toBe(cents(HAND.additional.additionalTruncated));
    expect(cents(HAND.additional.mtdNormal + HAND.additional.additionalMtd)).toBe(cents(HAND.additional.mtd));
    expect(cents((4000 - 990) / 5)).toBe(cents(HAND.K2));
  });

  it('Normal: the engine matches the hand calculation to the sen', () => {
    const s = statutory(BASIC, profile, 0, 0, july, { pcbNonCashNormal: { bik: BKBOP, vola: 0 } });
    const meta = s.pcbMeta as any;
    expect(s.epfEmployee).toBe(HAND.epfEmployee);
    expect(meta.trace.Y1).toBe(HAND.normal.Y1); expect(meta.trace.K1).toBe(HAND.epfEmployee); expect(meta.trace.K2).toBe(HAND.K2);
    expect(meta.trace.Yt).toBe(0); expect(meta).not.toHaveProperty('P2');
    expect(meta.P1).toBe(HAND.normal.P1);
    expect(meta.trace.taxOnP1).toBe(HAND.normal.taxOnP1);
    expect(meta.trace.mtdNormalCalc).toBe(HAND.normal.mtd); // 537.21 truncated, then up to the next 5 sen
    expect(meta.trace.mtdNormalFloored).toBe(HAND.normal.mtd); // RM10 floor does not apply
    expect(s.pcb).toBe(HAND.normal.mtd); expect(s.pcbBonus).toBe(0);
  });

  it('Additional: the engine uses the existing D.2 path with Kt 0 and matches the hand calculation to the sen', () => {
    const s = statutory(BASIC, profile, 0, 0, july, { pcbNonCashAdditional: { bik: BKBOP, vola: 0 } });
    const meta = s.pcbMeta as any;
    expect(s.epfEmployee).toBe(HAND.epfEmployee);
    expect(meta.trace.Y1).toBe(HAND.additional.Y1); expect(meta.trace.K1).toBe(HAND.epfEmployee); expect(meta.trace.K2).toBe(HAND.K2);
    expect(meta.P1).toBe(HAND.additional.P1);
    expect(meta.trace.taxOnP1).toBe(HAND.additional.taxOnP1);
    expect(meta.trace.mtdNormalCalc).toBe(HAND.additional.mtdNormal);
    expect(meta.trace.totalMtdYear).toBe(HAND.additional.totalMtdYear);
    expect(meta.trace.Yt).toBe(HAND.additional.Yt); expect(meta.trace.Kt).toBe(HAND.additional.Kt); expect(meta.trace.K2t).toBe(HAND.additional.K2t);
    expect(meta.P2).toBe(HAND.additional.P2);
    expect(meta.trace.totalTaxYear).toBe(HAND.additional.totalTaxYear);
    expect(meta.trace.mtdAdditionalCalc).toBe(HAND.additional.additionalMtd); // 246.66 truncated, then up to 246.70
    expect(meta.trace.mtdAdditionalFloored).toBe(HAND.additional.additionalMtd);
    expect(s.pcbBonus).toBe(HAND.additional.additionalMtd);
    expect(s.pcb).toBe(HAND.additional.mtd);
  });

  it('Normal and Additional differ only in PCB: EPF, SOCSO, SKBBK and EIS equal the month without the benefit', () => {
    const none = statutory(BASIC, profile, 0, 0, july);
    const normal = statutory(BASIC, profile, 0, 0, july, { pcbNonCashNormal: { bik: BKBOP, vola: 0 } });
    const additional = statutory(BASIC, profile, 0, 0, july, { pcbNonCashAdditional: { bik: BKBOP, vola: 0 } });
    for (const key of AGENCY) { expect(normal[key]).toBe(none[key]); expect(additional[key]).toBe(none[key]); }
    // Normal 537.25 versus Additional 406.70 for this fixture.
    expect([normal.pcb, additional.pcb]).toEqual([HAND.normal.mtd, HAND.additional.mtd]);
  });

  it('RM10 floor: a small Additional benefit whose additional MTD is below RM10 is not deducted', () => {
    const normal = statutory(BASIC, profile, 0, 0, july, { pcbNonCashNormal: { bik: 100, vola: 0 } });
    const additional = statutory(BASIC, profile, 0, 0, july, { pcbNonCashAdditional: { bik: 100, vola: 0 } });
    expect(normal.pcb).toBe(HAND.floor.normalMtd);
    expect((additional.pcbMeta as any).P2).toBe(41100);
    expect((additional.pcbMeta as any).trace.mtdAdditionalCalc).toBe(HAND.floor.additionalCalc);
    expect((additional.pcbMeta as any).trace.mtdAdditionalFloored).toBe(HAND.floor.additionalFloored);
    expect(additional.pcbBonus).toBe(0); expect(additional.pcb).toBe(HAND.floor.additionalMtd);
  });

  it('with a cash bonus, Kt stays the EPF on the cash bonus alone and the benefit only raises Yt', () => {
    const cash = statutory(BASIC, profile, 2000, 0, july);
    const both = statutory(BASIC, profile, 2000, 0, july, { pcbNonCashAdditional: { bik: BKBOP, vola: 0 } });
    for (const key of AGENCY) expect(both[key]).toBe(cash[key]);
    expect((both.pcbMeta as any).trace.Kt).toBe((cash.pcbMeta as any).trace.Kt);
    expect((both.pcbMeta as any).trace.Yt).toBe(2000 + BKBOP);
    expect((both.pcbMeta as any).trace.Y1).toBe((cash.pcbMeta as any).trace.Y1);
  });

  it('non-resident flat rate: the benefit is in the additional figure; 30 % of (9,000 + 4,111) = 3,933.30 either way', () => {
    // Hand: 13,111 × 0.30 = 3,933.30 (no truncation or 5-sen movement); additional part 4,111 × 0.30 = 1,233.30.
    const normal = statutory(BASIC, undefined, 0, 0, july, { resident: false, pcbNonCashNormal: { bik: BKBOP, vola: 0 } });
    const additional = statutory(BASIC, undefined, 0, 0, july, { resident: false, pcbNonCashAdditional: { bik: BKBOP, vola: 0 } });
    expect(normal.pcb).toBe(3933.3); expect(normal.pcbBonus).toBe(0);
    expect(additional.pcb).toBe(3933.3); expect(additional.pcbBonus).toBe(1233.3);
    expect((additional.pcbMeta as any).trace).toEqual({ remuneration: BASIC, additional: BKBOP, rate: 0.3 });
  });

  it('without the new option the engine is byte-identical (Normal stays today\'s behaviour)', () => {
    const before = statutory(BASIC, profile, 3000, 0, july, { pcbNonCashNormal: { bik: BKBOP, vola: 0 } });
    const explicitZero = statutory(BASIC, profile, 3000, 0, july, { pcbNonCashNormal: { bik: BKBOP, vola: 0 }, pcbNonCashAdditional: { bik: 0, vola: 0 } });
    expect(JSON.stringify(explicitZero)).toBe(JSON.stringify(before));
  });
});

// ── Saved snapshot: version 1 is read exactly as before; version 2 records each entry's stream ──────────────────
const zero = { entered: 0, exempt: 0, taxable: 0 };
const normalEntry: NonCashEntry = { kind: 'bik', code: 'CAR', source: 'recurring', entered: 800, exempt: 200, taxable: 600, exemptionCode: 'PCB_CHILD_CARE' };
const normalEa: NonCashEaEntry = { kind: 'bik', code: 'CAR', source: 'recurring', entered: 800, reportableAmount: 600, exemptAmount: 200, eaFormLine: 'EA_B3', subjectPCB: true, exemptionCode: 'PCB_CHILD_CARE' };
const bkbop: NonCashEntry = { kind: 'bik', code: 'BKBOP', source: 'one_off', sourceId: 'txn-1', entered: BKBOP, exempt: 0, taxable: BKBOP, exemptionCode: 'PCB_TAXABLE', stream: 'additional' };
const bkbopEa: NonCashEaEntry = { kind: 'bik', code: 'BKBOP', source: 'one_off', sourceId: 'txn-1', entered: BKBOP, reportableAmount: BKBOP, exemptAmount: 0, eaFormLine: 'EA_B3', subjectPCB: true, exemptionCode: 'PCB_TAXABLE' };
/** The version 1 literal exactly as the kernel wrote it before the amendment. */
const v1: PcbNonCashSnapshot = { version: 1, current: { bik: { entered: 800, exempt: 200, taxable: 600 }, vola: zero }, ownedCurrent: { bik: { entered: 800, exempt: 200, taxable: 600 }, vola: zero },
  owned: { bik: 600, vola: 0 }, cumulative: { bik: 600, vola: 0 }, before: { bik: 0, vola: 0 }, accumulated: { bik: 0, vola: 0, complete: true }, cashNormal: 9000,
  entries: [normalEntry], ownedEntries: [normalEntry], eaEntries: [normalEa], ownedEaEntries: [normalEa] };
function snapshot(entries: NonCashEntry[], ea: NonCashEaEntry[], cashNormal = BASIC) {
  return versionedPcbNonCash({ current: totalNonCash(entries), ownedCurrent: totalNonCash(entries), owned: taxableNonCash(entries), cumulative: taxableNonCash(entries),
    before: { bik: 0, vola: 0 }, accumulated: { bik: 0, vola: 0, complete: true }, cashNormal, entries, ownedEntries: entries, eaEntries: ea, ownedEaEntries: ea });
}

describe('8edeef41 versioned PCB noncash snapshot', () => {
  it('a version 1 snapshot is read unchanged and is all Normal', () => {
    const copy = structuredClone(v1);
    expect(readPcbNonCash(copy)).toBe(copy); expect(copy).toEqual(v1);
    const streams = pcbNonCashStreams(copy);
    expect(streams.owned).toEqual({ normal: { bik: 600, vola: 0 }, additional: { bik: 0, vola: 0 } });
    expect(streams.current.normal).toEqual(v1.current);
  });

  it('the writer keeps an all-Normal month at version 1 byte for byte, with no stream key', () => {
    const written = snapshot([{ ...normalEntry, stream: 'normal' }], [normalEa]);
    expect(JSON.stringify(written)).toBe(JSON.stringify(v1));
  });

  it('an Additional entry makes version 2 with every PCB entry\'s stream explicit; totals stay across both streams', () => {
    const written = snapshot([normalEntry, bkbop], [normalEa, bkbopEa]);
    expect(written.version).toBe(2);
    expect(written.entries.map(e => e.stream)).toEqual(['normal', 'additional']);
    expect(written.eaEntries).toEqual([normalEa, bkbopEa]); // EA entries carry no stream
    expect(readPcbNonCash(written)).toBe(written);
    expect(written.owned).toEqual({ bik: 600 + BKBOP, vola: 0 });
    expect(pcbNonCashStreams(written).owned).toEqual({ normal: { bik: 600, vola: 0 }, additional: { bik: BKBOP, vola: 0 } });
  });

  it('refuses mixed or missing stream evidence instead of guessing', () => {
    expect(readPcbNonCash({ ...v1, entries: [{ ...normalEntry, stream: 'normal' }], ownedEntries: [{ ...normalEntry, stream: 'normal' }] })).toBeNull();
    const v2 = snapshot([normalEntry, bkbop], [normalEa, bkbopEa]);
    expect(readPcbNonCash({ ...v2, entries: v2.entries.map(({ stream: _s, ...e }) => e) })).toBeNull();
    expect(readPcbNonCash({ ...v2, ownedEntries: v2.ownedEntries.map(e => ({ ...e, stream: 'normal' })) })).toBeNull();
    expect(readPcbNonCash({ ...v2, entries: v2.entries.map(e => ({ ...e, stream: 'bonus' })) })).toBeNull();
    expect(readPcbNonCash({ ...v2, version: 3 })).toBeNull();
  });

  it('EA B3/B4 output is byte-identical whether the benefit was Normal or Additional', () => {
    const asNormal = snapshot([{ ...bkbop, stream: 'normal' }], [bkbopEa]);
    const asAdditional = snapshot([bkbop], [bkbopEa]);
    expect([asNormal.version, asAdditional.version]).toEqual([1, 2]);
    const slip = (pcbNonCash: PcbNonCashSnapshot) => ({ payPeriod: '2026-07', statutory: { pcbNonCash, exemptionUsed: {} } });
    expect(JSON.stringify(accumulatedEaNonCash([slip(asAdditional)]))).toBe(JSON.stringify(accumulatedEaNonCash([slip(asNormal)])));
    expect(accumulatedEaNonCash([slip(asAdditional)])).toEqual({ complete: true, benefitsInKind: BKBOP, livingAccommodation: 0, unmapped: [] });
    expect(eaNonCashExemption(slip(asAdditional).statutory)).toBe(eaNonCashExemption(slip(asNormal).statutory));
  });

  it('the tax-basis comparison of an all-Normal snapshot is unchanged; an Additional one is a distinct comparison form', () => {
    expect(nonCashComparisonInputs(v1)).toEqual({ owned: { bik: 600, vola: 0 }, entries: [{ kind: 'bik', code: 'CAR', entered: 800, exempt: 200, taxable: 600, exemptionCode: 'PCB_CHILD_CARE' }],
      ea: [{ kind: 'bik', code: 'CAR', entered: 800, reportableAmount: 600, exemptAmount: 200, eaFormLine: 'EA_B3', subjectPCB: true, exemptionCode: 'PCB_CHILD_CARE' }] });
    const asNormal = snapshot([{ ...bkbop, stream: 'normal' }], [bkbopEa]), asAdditional = snapshot([bkbop], [bkbopEa]);
    expect(JSON.stringify(nonCashComparisonInputs(asNormal))).not.toContain('stream');
    expect(nonCashComparisonInputs(asAdditional)).toMatchObject({ comparisonVersion: 2, entries: [expect.objectContaining({ code: 'BKBOP', stream: 'additional' })] });
    expect(JSON.stringify(nonCashComparisonInputs(asAdditional))).not.toBe(JSON.stringify(nonCashComparisonInputs(asNormal)));
  });

  it('the ownership replay carries each entry\'s stream and stays version 1 for Normal-only history', () => {
    const replay = createNonCashOwnershipReplay();
    const normalOnly = replay({ period: '2026-06', cashNormal: BASIC, owned: [normalEntry], ownedEa: [normalEa], original: null, completeSource: true });
    expect(JSON.stringify(normalOnly)).not.toContain('stream'); expect(normalOnly.version).toBe(1);
    const july = replay({ period: '2026-07', cashNormal: BASIC, owned: [normalEntry, bkbop], ownedEa: [normalEa, bkbopEa], original: null, completeSource: true });
    expect(july.version).toBe(2); expect(july.ownedEntries.map(e => e.stream)).toEqual(['normal', 'additional']);
    expect(july.accumulated).toEqual({ bik: 600, vola: 0, complete: true });
  });
});

describe('8edeef41 accumulated Σ(Y − K): foldPriorSlipIntoAccumulators is unchanged by the stream', () => {
  const fresh = (): PcbAccumulators => ({ netRemuneration: 0, epfClaimed: 0, pcbPaid: 0, zakatPaid: 0, lpAccumulated: 0 });
  it('a regular month with an Additional benefit accumulates its whole charged base once', () => {
    // bases.pcb = cash 9,000 + benefit 4,111 = 13,111 (the kernel stamps Y1 + Yt). Y − K = 13,111 − 990 = 12,121.
    const asAdditional = snapshot([bkbop], [bkbopEa]), asNormal = snapshot([{ ...bkbop, stream: 'normal' }], [bkbopEa]);
    const a = fresh(), n = fresh();
    foldPriorSlipIntoAccumulators(a, { gross: BASIC, statutory: { bases: { pcb: 13111 }, epfEmployee: 990, pcb: HAND.additional.mtd, pcbNonCash: asAdditional } }, 4000);
    foldPriorSlipIntoAccumulators(n, { gross: BASIC, statutory: { bases: { pcb: 13111 }, epfEmployee: 990, pcb: HAND.additional.mtd, pcbNonCash: asNormal } }, 4000);
    expect(a).toEqual(n);
    expect(a).toMatchObject({ grossRemuneration: 13111, netRemuneration: 12121, epfClaimed: 990, pcbPaid: 406.7 });
  });
  it('a later run of the month counts only its own benefit, never the earlier run\'s Additional benefit twice', () => {
    // Bonus run: cumulative benefit 4,111 owned by the regular run, this run owns none; bases.pcb = 9,000 + 2,000 + 4,111.
    const regular = snapshot([bkbop], [bkbopEa]);
    const later = versionedPcbNonCash({ ...regular, ownedCurrent: { bik: zero, vola: zero }, owned: { bik: 0, vola: 0 }, before: { bik: BKBOP, vola: 0 }, ownedEntries: [], ownedEaEntries: [] });
    expect(later.version).toBe(2); expect(readPcbNonCash(later)).not.toBeNull();
    const acc = fresh();
    foldPriorSlipIntoAccumulators(acc, { gross: 2000, statutory: { bases: { pcb: 15111 }, epfEmployee: 220, pcb: 100, pcbNonCash: later } }, 4000);
    expect(acc.grossRemuneration).toBe(11000); // 15,111 − (4,111 cumulative − 0 owned)
  });
  it('a malformed version 2 snapshot stops the replay', () => {
    const broken = { ...snapshot([bkbop], [bkbopEa]), entries: [{ ...bkbop, stream: undefined }] };
    expect(() => foldPriorSlipIntoAccumulators(fresh(), { gross: 1, statutory: { bases: { pcb: 1 }, pcbNonCash: broken } }, 4000)).toThrow();
  });
});

describe('8edeef41 multi-cycle month: an Additional benefit is charged once, on its own run, through Yt', () => {
  it('regular run then a bonus run carrying BKBOP: the runs sum to the month computed as one', () => {
    const month = computeMonthlyRuns({ month: 7, profile, runs: [
      { runType: 'regular', payment: BASIC, pcbNonCashNormal: { bik: 0, vola: 0 } },
      { runType: 'bonus', payment: 0, pcbNonCashNormal: { bik: 0, vola: 0 }, pcbNonCashAdditional: { bik: BKBOP, vola: 0 } },
    ] });
    // Regular alone: 160.00 (hand step 1). With BKBOP as Additional the month is 406.70, so the bonus run charges 246.70.
    expect(month.monthly.pcb).toBe(HAND.additional.mtd);
    expect(month.runs.map(r => r.pcb)).toEqual([HAND.additional.mtdNormal, HAND.additional.additionalMtd]);
    for (const key of ['epfEmployee', 'socsoEmployee', 'eisEmployee'] as const) expect(month.runs[1][key]).toBe(0);
  });
  it('Normal-only runs pass no additional option, exactly as before', () => {
    const runs = computeMonthlyRuns({ month: 7, profile, runs: [{ runType: 'regular', payment: BASIC, pcbNonCashNormal: { bik: BKBOP, vola: 0 } }] });
    expect(runs.monthly.pcb).toBe(HAND.normal.mtd);
  });
});

// ── Historical replay, TP3 recalculation and payroll history import follow the latest Pay Item classification ────
const basicSetting: TaxBasisItemSetting = { id: 'basic', code: 'BASIC', name: 'Basic salary', kind: 'earning', includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: null, isNonPayable: false, epfBonus2012: false };
const travel: TaxBasisItemSetting = { ...basicSetting, id: 'travel', code: 'TRAVEL', name: 'Travel', pcbExemptionCode: 'PCB_TRA_BUSINESS' };
const bkbopSetting = (stream: 'normal' | 'additional'): TaxBasisItemSetting => ({ id: 'bkbop', code: 'BKBOP', name: 'BIK-Buyout Payment', kind: 'non_payable', includedInPcb: true,
  pcbRemunerationType: stream, pcbExemptionCode: 'PCB_TAXABLE', isNonPayable: true, epfBonus2012: false, displayCategory: 'bik', eaFormLine: 'EA_B3' });
function replayInput(stream: 'normal' | 'additional', opening: Record<string, number> = {}): TaxBasisReplayInput {
  return { year: 2026, upToMonth: 7, settings: [basicSetting, travel, bkbopSetting(stream)], openingExemptionUsed: opening, ledger: true,
    rulesByPeriod: { '2026-07': { rules: DEFAULT_MY_STATUTORY, hash: 'verified-07' } },
    slips: [{ id: 'slip-07', period: '2026-07', runOrder: 1, sourceKind: 'native', statutory: { pcb: 0, epfEmployee: 990, lp: 0 }, expectedGross: 9500, expectedOtherDeductions: 0,
      sourceLines: [{ code: 'BASIC', amount: BASIC, direction: 'earning' }, { code: 'TRAVEL', amount: 500, direction: 'earning' },
        { code: 'BKBOP', amount: BKBOP, direction: 'noncash', settingId: 'bkbop', rowNum: 1000000, nonCashSource: { source: 'one_off', sourceId: 'txn-1' } }] }] };
}

describe('8edeef41 replay, TP3 opening and import', () => {
  it('replay routes BKBOP by its latest setting; cash and the TP3-opened exemption ledger do not move', () => {
    // Accepted TP3 opening (ADR-0167, 2026-11-23): RM6,000 of PCB_TRA_BUSINESS already used elsewhere this year.
    const [asNormal] = replayMyTaxBasis(replayInput('normal', { PCB_TRA_BUSINESS: 6000 }));
    const [asAdditional] = replayMyTaxBasis(replayInput('additional', { PCB_TRA_BUSINESS: 6000 }));
    for (const row of [asNormal, asAdditional]) expect(row.basis).toMatchObject({ pcb: BASIC + 500 - Number(row.basis.exempt), normal: BASIC + 500 - Number(row.basis.exempt), additional: 0 });
    expect(asAdditional.basis.exemptionUsed).toEqual(asNormal.basis.exemptionUsed);
    expect(asAdditional.basis.exemptionLedger).toEqual(asNormal.basis.exemptionLedger);
    const n = readPcbNonCash(asNormal.basis.pcbNonCash)!, a = readPcbNonCash(asAdditional.basis.pcbNonCash)!;
    expect(n.version).toBe(1); expect(JSON.stringify(n)).not.toContain('stream');
    expect(a.version).toBe(2); expect(a.ownedEntries).toEqual([expect.objectContaining({ code: 'BKBOP', taxable: BKBOP, stream: 'additional' })]);
    expect(a.eaEntries).toEqual(n.eaEntries);
    expect(asAdditional.basis.items.find(i => i.code === 'BKBOP')!.latestTreatment).toBe('Non-cash BIK · Taxable · additional');
    expect(asNormal.basis.items.find(i => i.code === 'BKBOP')!.latestTreatment).toBe('Non-cash BIK · Taxable');
  });

  it('payroll history import projects an Additional BKBOP row as an Additional noncash source', () => {
    const settings: ImportedTaxSetting[] = [SYSTEM_BASIC_TAX_SETTING, { ...SYSTEM_BASIC_TAX_SETTING, id: 'bkbop', code: 'BKBOP', name: 'BIK-Buyout Payment', kind: 'non_payable', isNonPayable: true,
      pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE', displayCategory: 'bik', eaFormLine: 'EA_B3' }];
    const codes = new Map<string, ImportCodeEntry>([['BASIC', { code: 'BASIC', destination: 'basic', direction: 'earning', label: 'Basic', source: 'statutory', basicSalaryOwner: true }],
      ['BKBOP', { code: 'BKBOP', label: 'BIK-Buyout Payment', destination: 'noncash', direction: 'earning', source: 'component', targetCode: 'BKBOP' }]]);
    const project = (stream: 'normal' | 'additional') => projectImportedTaxBasis({ ownerKey: 'fixture-owner:BK', replay: replayMyTaxBasis, period: '2026-07',
      rows: [{ rowNum: 2, code: 'BASIC', amount: BASIC }, { rowNum: 3, code: 'BKBOP', amount: BKBOP }], codes,
      settings: settings.map(s => s.id === 'bkbop' ? { ...s, pcbRemunerationType: stream } : s), rules: DEFAULT_MY_STATUTORY, rulesHash: 'verified-2026',
      gross: BASIC, deductions: 0, statutory: { pcb: 406.7, epfEmployee: 990, lp: 0 } });
    const additional = project('additional'), normal = project('normal');
    expect(additional.state).toBe('ready'); expect(normal.state).toBe('ready');
    expect(additional.basis?.pcb).toBe(BASIC); expect(normal.basis?.pcb).toBe(BASIC);
    expect(readPcbNonCash(additional.basis?.pcbNonCash)).toMatchObject({ version: 2, owned: { bik: BKBOP, vola: 0 }, cashNormal: BASIC });
    expect(readPcbNonCash(normal.basis?.pcbNonCash)).toMatchObject({ version: 1, owned: { bik: BKBOP, vola: 0 }, cashNormal: BASIC });
  });
});

// ── PCB detail: an Additional benefit is shown under Additional remuneration ────────────────────────────────────
const sides = { profile: null, catalogue: [], rebateCatalogue: [], currentDeduction: null, accumulatedDeduction: null, previousDeduction: null, currentRebate: null, accumulatedRebate: null };
describe('8edeef41 pcb-explain additional noncash row', () => {
  const generated = statutory(BASIC, profile, 0, 0, july, { pcbNonCashAdditional: { bik: BKBOP, vola: 0 } });
  const saved = snapshot([bkbop], [bkbopEa]);
  it('accepts the saved snapshot (Y1 holds only Normal benefits) and lists BKBOP under Additional remuneration', () => {
    const x = explainPcb({ ...generated, pcbNonCash: saved }, null);
    expect(x.kind).toBe('mtd'); expect(x.nonCash).toBe(saved);
    const slip = pcbSlipSections(x, sides);
    const current = slip.find(s => s.heading === 'slipCurrentHeading')!, additional = slip.find(s => s.heading === 'slipAdditionalRemHeading')!;
    const row = (section: typeof current, caption: string) => section.rows.find(r => r.caption === caption)?.first;
    expect(row(additional, 'slipAddBenefitsInKind')).toEqual({ kind: 'money', amount: BKBOP });
    expect(row(additional, 'slipBikEntered')).toEqual({ kind: 'money', amount: BKBOP });
    expect(row(current, 'slipCompBenefitsInKind')).toEqual({ kind: 'money', amount: 0 });
    // The same figures saved as Normal no longer reconcile with this Y1 and are therefore not shown as Y1 benefits.
    expect(explainPcb({ ...generated, pcbNonCash: snapshot([{ ...bkbop, stream: 'normal' }], [bkbopEa]) }, null).nonCash).toBeNull();
  });
  it('a Normal-only payslip keeps its breakdown exactly: no additional benefit rows', () => {
    const normal = statutory(BASIC, profile, 0, 0, july, { pcbNonCashNormal: { bik: 600, vola: 0 } });
    const x = explainPcb({ ...normal, pcbNonCash: v1 }, null);
    expect(x.nonCash).toBe(v1);
    const additional = pcbSlipSections(x, sides).find(s => s.heading === 'slipAdditionalRemHeading')!;
    expect(additional.rows.map(r => r.caption)).not.toContain('slipAddBenefitsInKind');
  });
  it.each(['en', 'ms', 'zh', 'ta', 'th', 'vi'])('renders the Additional benefit rows with real %s captions', async locale => {
    state.locale = locale;
    const x = explainPcb({ ...generated, pcbNonCash: saved }, null);
    const html = renderToStaticMarkup(await PcbDetailView({ ctx: { employeeCode: 'SYNTH', employeeName: 'Synthetic Additional Benefit', company: 'Synthetic Company', periodLabel: 'July 2026', payPeriod: '2026-07', runType: 'regular', runSeq: 1, currency: 'MYR', rulesetVersion: null, identityNumber: null, identityIsPassport: false, taxNumber: null, taxCategory: 1 },
      explanation: x, worksheet: pcbWorksheet(x, null), slip: pcbSlipSections(x, sides), closing: pcbClosingSections(x) }));
    const captions = JSON.parse(fs.readFileSync(`messages/${locale}.json`, 'utf8')).payroll.pcbDetail;
    expect(html).toContain(captions.slipAddBenefitsInKind); expect(html).toContain('4,111.00'); expect(html).toContain('406.70');
    expect(html).not.toContain('slipAddBenefitsInKind'); expect(html).not.toContain('MISSING_MESSAGE');
  });
});
