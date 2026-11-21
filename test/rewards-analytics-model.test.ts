import { describe, expect, it } from 'vitest';
import {
  analyticsBreakdownGroups, analyticsMonthBand, analyticsSlice, analyticsTotals, averageIncreaseAndCr,
  bonusMetrics, combineAnalyticsTotals, emptyAnalyticsTotals, parseAnalyticsDrill, payPositionMetrics,
  salaryMetrics, type AnalyticsRow,
} from '../packs/rewards/analytics-model';

const row = (patch: Partial<AnalyticsRow>): AnalyticsRow => ({
  id: 'row', unitId: 'review-a', name: 'Fictional employee', employeeCode: 'A',
  grade: '12', talent: 'SSTAR', performance: 'OU', department: { id: 'department-a', name: 'Fictional team' },
  beforeCents: 300_000, afterCents: 360_000,
  meritCents: 30_000, promotionCents: 30_000, specialCents: 0,
  beforeRange: [350_000, 400_000, 450_000], afterRange: [350_000, 450_000, 500_000],
  promoted: true, incrementRun: true, excludedByPayWindow: false,
  bonusEligible: true, bonusBasicCents: 300_000, bonusCents: 450_000, lumpCents: 0,
  pooled: true, exceptions: 1, blockers: 0, ...patch,
});

describe('Rewards Analytics measures', () => {
  const promotion = row({});
  const excluded = row({ id: 'excluded', grade: '23', beforeCents: 600_000, afterCents: 600_000,
    meritCents: 0, promotionCents: 0, promoted: false, incrementRun: false, excludedByPayWindow: true,
    beforeRange: null, afterRange: null, bonusBasicCents: 600_000, bonusCents: 0, performance: 'ME', department: null,
  });
  const unknown = row({ id: 'unknown', beforeCents: null, afterCents: null, beforeRange: null, afterRange: null,
    incrementRun: false, meritCents: 0, promotionCents: 0, bonusEligible: false, bonusBasicCents: null, bonusCents: 0,
  });

  it('uses the proposed grade after promotion, excludes missing ranges, and keeps in-window salary unchanged', () => {
    expect(payPositionMetrics([promotion, excluded, unknown])).toEqual({
      before: { below: 1, within: 0, above: 0, noRange: 2 },
      after: { below: 0, within: 1, above: 0, noRange: 2 },
      upIntoRange: 1, stillBelow: 0, pushedAbove: 0,
    });
    expect(salaryMetrics([promotion, excluded, unknown])).toMatchObject({
      beforeCents: 900_000, afterCents: 960_000, increaseCents: 60_000, people: 3, increased: 1,
      increaseRate: 60_000 / 900_000, medianBeforeCr: .75, medianAfterCr: .8, averageIncrease: .2,
    });
    expect(averageIncreaseAndCr(analyticsSlice([promotion, excluded, unknown], 'run', 'salary'))).toEqual({ count: 1, increase: .2, afterCr: .8 });
  });

  it('uses eligible bonus basic for months and annual share, and separates lumps from months', () => {
    const withLump = row({ id: 'lump', bonusEligible: false, bonusCents: 0, lumpCents: 7_500 });
    expect(bonusMetrics([promotion, excluded, unknown, withLump])).toMatchObject({
      payout: 457_500, eligible: 2, paid: 1, averageMonths: .75, medianMonths: .75, highestMonths: 1.5,
      eligibleAnnualBasicCents: 10_800_000, eligibleBonusCents: 450_000,
    });
    expect([0, .5, 1, 2, 3, 4, 5, 11].map(n => analyticsMonthBand(row({ bonusCents: n * 300_000 })))).toEqual(
      ['0', '<1', '1–2', '2–3', '3–4', '4–5', '5+', '5+'],
    );
    expect(analyticsMonthBand(unknown)).toBeNull();
  });

  it('keeps headline-only contributions out of named breakdown and drill rows', () => {
    const visible = [promotion, excluded];
    const totals = combineAnalyticsTotals([analyticsTotals(visible), { ...emptyAnalyticsTotals(), people: 3, beforeCents: 450_000 }]);
    expect(totals).toMatchObject({ people: 5, beforeCents: 1_350_000 });
    expect(analyticsBreakdownGroups(visible, [], 'department').map(group => [group.label, group.rows.length])).toEqual([
      ['', 1], ['Fictional team', 1],
    ]);
    const drill = parseAnalyticsDrill(JSON.stringify([['run', 'salary'], ['grade', '12'], ['before', 'below']]));
    expect(drill.reduce((rows, [dimension, key]) => analyticsSlice(rows, dimension, key), visible).map(row => row.id)).toEqual(['row']);
    expect(parseAnalyticsDrill(JSON.stringify([['personId', 'protected']]))).toEqual([]);
  });
});
