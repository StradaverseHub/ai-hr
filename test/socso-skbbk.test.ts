/**
 * #155/#156 — SOCSO Lindung 24 Jam / SKBBK (Akta A1788, mandatory from 1 Jun 2026).
 * Verifies the new employee-paid SKBBK leg (Phase 1, 0.75%) added on top of the unchanged Act-4 SOCSO,
 * and that 60+/foreign workers (Category 2) still pay it. Sourced from PERKESO
 * NewContributionRateIncludingSKBBK.pdf + Pekeliling Majikan 02/2026 (2026-06-19, HIGH confidence).
 */
import { describe, expect, it } from 'vitest';
import { socso } from '../localization/my/payroll';
import {
  MY_SOCSO_CATEGORY1,
  MY_SOCSO_CATEGORY1_SKBBK,
  MY_SOCSO_CATEGORY2_SKBBK,
  MY_SOCSO_SKBBK_PHASE1,
} from '../localization/my/statutory-tables';

describe('SOCSO SKBBK (#155)', () => {
  it('adds the employee SKBBK leg without changing employer/employee amounts', () => {
    // employer + employee are the verbatim Nov-2024 Act 4 values; skbbk is the new third leg.
    expect(socso(30)).toEqual({ employer: 0.4, employee: 0.1, skbbk: 0.2 });
    expect(socso(3000)).toEqual({ employer: 51.65, employee: 14.75, skbbk: 22.15 });
    expect(socso(6000)).toEqual({ employer: 104.15, employee: 29.75, skbbk: 44.65 });
    // Above the RM6,000 ceiling → top band (row 65).
    expect(socso(12000).skbbk).toBe(44.65);
  });

  it('Category 2 (60+ / foreign) pays the SAME SKBBK as Category 1', () => {
    expect(socso(3000, 2)).toEqual({ employer: 36.9, employee: 0, skbbk: 22.15 });
    expect(socso(6000, 2).skbbk).toBe(44.65);
    // skbbk column is identical between the two categories, band-for-band.
    expect(MY_SOCSO_CATEGORY1_SKBBK.map((b) => b.skbbk)).toEqual(MY_SOCSO_CATEGORY2_SKBBK.map((b) => b.skbbk));
  });

  it('the SKBBK column aligns 1:1 with the 64 SOCSO bands', () => {
    expect(MY_SOCSO_SKBBK_PHASE1).toHaveLength(MY_SOCSO_CATEGORY1.length);
    expect(MY_SOCSO_CATEGORY1_SKBBK).toHaveLength(64);
    // monotonic, NIL-free (SOCSO's first band already contributes), top = 44.65
    expect(MY_SOCSO_SKBBK_PHASE1[0]).toBe(0.2);
    expect(MY_SOCSO_SKBBK_PHASE1[MY_SOCSO_SKBBK_PHASE1.length - 1]).toBe(44.65);
    for (let i = 1; i < MY_SOCSO_SKBBK_PHASE1.length; i++) {
      expect(MY_SOCSO_SKBBK_PHASE1[i]).toBeGreaterThan(MY_SOCSO_SKBBK_PHASE1[i - 1]);
    }
  });
});
