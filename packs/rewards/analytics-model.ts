import { sum } from './engine';

export const analyticsPositions = ['below', 'within', 'above'] as const;
export type AnalyticsPosition = typeof analyticsPositions[number] | 'noRange';
export const analyticsPerformance = ['OU', 'AE', 'ME', 'BE', 'UA'] as const;
export const analyticsTalent = ['SSTAR', 'STAR', 'SCORE', 'IMPRO', 'PIP'] as const;
export const analyticsBreakdowns = ['unit', 'gradeBand', 'talent', 'performance', 'department'] as const;
export type AnalyticsBreakdown = typeof analyticsBreakdowns[number];
export type AnalyticsBasis = 'monthly' | 'annual';
export type AnalyticsView = 'salary' | 'bonus';

export type AnalyticsRow = {
  id: string; unitId: string; name: string; employeeCode: string;
  grade: string; talent: string | null; performance: string | null;
  department: { id: string; name: string } | null;
  beforeCents: number | null; afterCents: number | null;
  meritCents: number; promotionCents: number; specialCents: number;
  beforeRange: readonly [number, number, number] | null;
  afterRange: readonly [number, number, number] | null;
  promoted: boolean; incrementRun: boolean; excludedByPayWindow: boolean;
  bonusEligible: boolean; bonusBasicCents: number | null; bonusCents: number; lumpCents: number;
  pooled: boolean; exceptions: number; blockers: number;
};

export type AnalyticsTotals = {
  people: number; beforeCents: number; afterCents: number; meritCents: number;
  promotionCents: number; specialCents: number; increased: number;
  eligible: number; paid: number; bonusCents: number; lumpCents: number; eligibleAnnualBasicCents: number; eligibleBonusCents: number;
};

export type AnalyticsUnit = {
  id: string; cycleId: string; cycle: string; year: number; companyId: string; company: string;
  businessUnitId: string; unit: string; groupId: string | null; groupName: string | null;
  uploaded: boolean; branchFactors: boolean; people: number; blockers: number;
  poolCents: number | null; patAchievement: number | null; canSeePat: boolean; canOpenReview: boolean;
};

export const emptyAnalyticsTotals = (): AnalyticsTotals => ({
  people: 0, beforeCents: 0, afterCents: 0, meritCents: 0, promotionCents: 0,
  specialCents: 0, increased: 0, eligible: 0, paid: 0, bonusCents: 0, lumpCents: 0,
  eligibleAnnualBasicCents: 0, eligibleBonusCents: 0,
});

export const analyticsRatio = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : null;
const mean = (values: number[]) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  const ordered = values.toSorted((left, right) => left - right);
  return (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2;
};
const known = (values: (number | null)[]) => values.filter((value): value is number => value !== null);

export function analyticsTotals(rows: readonly AnalyticsRow[]): AnalyticsTotals {
  return {
    people: rows.length,
    beforeCents: sum(rows.map(row => row.beforeCents ?? 0)),
    afterCents: sum(rows.map(row => row.afterCents ?? 0)),
    meritCents: sum(rows.map(row => row.meritCents)),
    promotionCents: sum(rows.map(row => row.promotionCents)),
    specialCents: sum(rows.map(row => row.specialCents)),
    increased: rows.filter(row => row.beforeCents !== null && row.afterCents !== null && row.afterCents > row.beforeCents).length,
    eligible: rows.filter(row => row.bonusEligible).length,
    paid: rows.filter(row => row.bonusEligible && row.bonusCents > 0).length,
    bonusCents: sum(rows.map(row => row.bonusCents)),
    lumpCents: sum(rows.map(row => row.lumpCents)),
    eligibleAnnualBasicCents: sum(rows.filter(row => row.bonusEligible).map(row => (row.bonusBasicCents ?? 0) * 12)),
    eligibleBonusCents: sum(rows.filter(row => row.bonusEligible).map(row => row.bonusCents)),
  };
}

export function combineAnalyticsTotals(totals: readonly AnalyticsTotals[]): AnalyticsTotals {
  const result = emptyAnalyticsTotals();
  for (const key of Object.keys(result) as (keyof AnalyticsTotals)[]) result[key] = sum(totals.map(total => total[key]));
  return result;
}

export function rangePosition(basic: number | null, range: AnalyticsRow['beforeRange']): AnalyticsPosition {
  if (basic === null || !range) return 'noRange';
  if (basic < range[0]) return 'below';
  return basic > range[2] ? 'above' : 'within';
}

export const analyticsIncrease = (row: AnalyticsRow) => row.beforeCents === null || row.afterCents === null
  ? null : analyticsRatio(row.afterCents - row.beforeCents, row.beforeCents);
const compa = (basic: number | null, range: AnalyticsRow['beforeRange']) =>
  basic === null || !range ? null : analyticsRatio(basic, range[1]);
const bonusMonths = (row: AnalyticsRow) => row.bonusBasicCents === null ? null : analyticsRatio(row.bonusCents, row.bonusBasicCents);

export function salaryMetrics(rows: readonly AnalyticsRow[]) {
  const totals = analyticsTotals(rows);
  const increases = known(rows.map(analyticsIncrease)).filter(rate => rate > 0);
  return {
    ...totals, increaseCents: totals.afterCents - totals.beforeCents,
    increaseRate: analyticsRatio(totals.afterCents - totals.beforeCents, totals.beforeCents),
    medianIncrease: median(increases), averageIncrease: mean(increases),
    medianBeforeCr: median(known(rows.map(row => compa(row.beforeCents, row.beforeRange)))),
    medianAfterCr: median(known(rows.map(row => compa(row.afterCents, row.afterRange)))),
  };
}

export function bonusMetrics(rows: readonly AnalyticsRow[]) {
  const totals = analyticsTotals(rows);
  const months = known(rows.filter(row => row.bonusEligible).map(bonusMonths));
  const mixBasic = totals.eligibleAnnualBasicCents;
  const mixBonus = totals.eligibleBonusCents;
  return {
    ...totals, payout: totals.bonusCents + totals.lumpCents, averageMonths: mean(months),
    medianMonths: median(months), highestMonths: months.reduce<number | null>((high, value) => high === null ? value : Math.max(high, value), null),
    payMix: analyticsRatio(mixBonus, mixBasic + mixBonus),
    exceptions: sum(rows.map(row => row.exceptions)), blockers: sum(rows.map(row => row.blockers)),
  };
}

export function payPositionMetrics(rows: readonly AnalyticsRow[]) {
  const stages = {
    before: rows.map(row => rangePosition(row.beforeCents, row.beforeRange)),
    after: rows.map(row => rangePosition(row.afterCents, row.afterRange)),
  };
  const counts = (values: AnalyticsPosition[]) => ({
    below: values.filter(value => value === 'below').length,
    within: values.filter(value => value === 'within').length,
    above: values.filter(value => value === 'above').length,
    noRange: values.filter(value => value === 'noRange').length,
  });
  return {
    before: counts(stages.before), after: counts(stages.after),
    upIntoRange: stages.before.filter((position, index) => position === 'below' && stages.after[index] === 'within').length,
    stillBelow: stages.before.filter((position, index) => position === 'below' && stages.after[index] === 'below').length,
    pushedAbove: stages.before.filter((position, index) => (position === 'within' || position === 'below') && stages.after[index] === 'above').length,
  };
}

export function averageIncreaseAndCr(rows: readonly AnalyticsRow[]) {
  return {
    count: rows.length,
    increase: mean(known(rows.map(analyticsIncrease))),
    afterCr: mean(known(rows.map(row => compa(row.afterCents, row.afterRange)))),
  };
}

export function analyticsGradeBand(grade: string) {
  if (grade === 'H') return 'H';
  const value = Number(grade);
  if (value >= 12 && value <= 15) return '12–15';
  if (value >= 16 && value <= 19) return '16–19';
  if (value >= 20 && value <= 21) return '20–21';
  if (value === 22 || value === 23) return String(value);
  return null;
}
export const analyticsGradeBands = ['H', '12–15', '16–19', '20–21', '22', '23'] as const;

export const analyticsMonthBands = ['0', '<1', '1–2', '2–3', '3–4', '4–5', '5+'] as const;
export function analyticsMonthBand(row: AnalyticsRow) {
  const months = row.bonusEligible ? bonusMonths(row) : null;
  if (months === null) return null;
  if (months === 0) return analyticsMonthBands[0];
  return analyticsMonthBands[Math.min(6, Math.floor(months) + 1)];
}

/** Only previously authorised, identifiable rows enter any drill, even when summary totals include a protected cohort. */
export function analyticsSlice(rows: readonly AnalyticsRow[], dimension: string, value: string | null) {
  if (value === null) return [...rows];
  return rows.filter(row => {
    switch (dimension) {
      case 'unit': return row.unitId === value;
      case 'grade': return row.grade === value;
      case 'gradeBand': return analyticsGradeBand(row.grade) === value || (analyticsGradeBand(row.grade) === null && value === '');
      case 'talent': return (row.talent ?? '') === value;
      case 'performance': return (row.performance ?? '') === value;
      case 'department': return (row.department?.id ?? '') === value;
      case 'before': return rangePosition(row.beforeCents, row.beforeRange) === value;
      case 'after': return rangePosition(row.afterCents, row.afterRange) === value;
      case 'bonusMonths': return analyticsMonthBand(row) === value;
      case 'run': return value === 'salary' ? row.incrementRun : value === 'bonus' && row.bonusEligible;
      default: return false;
    }
  });
}

export type AnalyticsSlice = readonly [string, string];
export function parseAnalyticsDrill(input: string | null): AnalyticsSlice[] {
  if (!input || input.length > 600) return [];
  try {
    const value: unknown = JSON.parse(input);
    const dimensions = ['unit', 'grade', 'gradeBand', 'talent', 'performance', 'department', 'before', 'after', 'bonusMonths', 'run'];
    if (!Array.isArray(value) || value.length > 3) return [];
    const clauses = value.filter((clause): clause is [string, string] =>
      Array.isArray(clause) && clause.length === 2 && dimensions.includes(clause[0]) && typeof clause[1] === 'string' && clause[1].length <= 80);
    return clauses.length === value.length ? clauses : [];
  } catch {
    return [];
  }
}

export type AnalyticsGroup = { key: string; label: string; rows: AnalyticsRow[]; unit?: AnalyticsUnit };

export function analyticsBreakdownGroups(rows: readonly AnalyticsRow[], units: readonly AnalyticsUnit[], dimension: AnalyticsBreakdown): AnalyticsGroup[] {
  if (dimension === 'unit') return units.map(unit => ({
    key: unit.id, label: `${unit.company} · ${unit.unit}`, rows: analyticsSlice(rows, 'unit', unit.id), unit,
  }));
  const groups = new Map<string, AnalyticsGroup>();
  for (const row of rows) {
    const key = (dimension === 'gradeBand' ? analyticsGradeBand(row.grade)
      : dimension === 'department' ? row.department?.id : row[dimension]) ?? '';
    const group = groups.get(key) ?? {
      key, label: dimension === 'department' ? row.department?.name ?? '' : key, rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  const order: readonly string[] = dimension === 'gradeBand' ? analyticsGradeBands
    : dimension === 'talent' ? analyticsTalent : dimension === 'performance' ? analyticsPerformance : [];
  return [...groups.values()].sort((left, right) => {
    const a = order.indexOf(left.key), b = order.indexOf(right.key);
    return (a < 0 ? 100 : a) - (b < 0 ? 100 : b) || left.label.localeCompare(right.label);
  });
}
