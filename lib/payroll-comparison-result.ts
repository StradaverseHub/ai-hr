/** Paid-result comparison shared by the screen and serializers. Inputs are authorized, recorded facts.
 * This module neither reconstructs pay nor decides company access. */
import {
  payrollAmountMinor, payrollMinorDecimal, payrollVariance, payrollComparisonReason,
  PAYROLL_COMPARISON_REASONS, PAYROLL_COMPARISON_REASON_FILTERS, payrollReasonMatches, PayrollComparisonInputError,
  type PayrollComparisonFilters, type PayrollComparisonDefinition,
  type PayrollComparisonMovement, type PayrollReasonEvidence, type PayrollComparisonReason, type PayrollComparisonReasonFilter,
} from './payroll-period-comparison';

export type ComparisonRun = {
  id: string; companyId: string; period: string;
  runType: 'regular' | 'off_cycle' | 'bonus' | 'adjustment';
  status: 'draft' | 'processed' | 'closed'; stale: boolean;
};
export type ComparisonSource = {
  id: string; version: number; runId: string; employmentId: string;
  companyId: string; currency: string | null;
  /** null means the selected item cannot be established from this saved result. */
  amount: string | null;
  coverage: { from: string; to: string };
  proratedCoverage?: { from:string; to:string; windowFrom?:string; windowTo?:string };
};
export type ComparisonIdentity = {
  employmentId: string; companyId: string; employeeCode: string; employeeName: string;
  departmentId: string | null; department: string | null; grade: string | null;
  company: string; costCentre: string | null; hireDate: string; exitDate: string | null;
  movements: readonly PayrollComparisonMovement[];
  verifiedTransferIds: readonly string[];
};
export type ComparisonIssue = {
  code: 'missingPayroll' | 'draftPayroll' | 'previousNotClosed' | 'stalePayroll' | 'itemNotRecorded';
  period: string; companyId: string; runId?: string; resultId?: string;
};
export type ComparisonRow = Omit<ComparisonIdentity, 'movements' | 'verifiedTransferIds'> & {
  currency: string | null; previous: string; current: string;
  /** Unknown currency does not establish that the two periods share a monetary unit. */
  variance: string | null; variancePct: string | null; reason: PayrollReasonEvidence;
  previousPresent: boolean; currentPresent: boolean;
  sources: { id: string; version: number; runId: string }[];
};
export type ComparisonTotal = {
  currency: string | null;
  /** Unknown-currency totals stay separated by employer, never combined into one nominal currency. */
  companyId: string | null;
  previous: string; current: string; variance: string | null; variancePct: string | null;
};
export type ComparisonResult = {
  available: boolean; issues: ComparisonIssue[]; provisional: boolean; runs: ComparisonRun[];
  rows: ComparisonRow[]; displayedRows: number; comparisonRows: number;
  reasonCounts: Record<PayrollComparisonReason, number>;
  reasonFilterCounts: Record<PayrollComparisonReasonFilter, number>;
  summary: { previousHeadcount: number; currentHeadcount: number; joiners: number; leavers: number;
    unexplained: number; totals: ComparisonTotal[] } | null;
  page: number; pageSize: number;
};
const key = (employmentId: string, companyId: string, currency: string | null) =>
  JSON.stringify([employmentId, companyId, currency]);
const abs = (value: bigint) => value < BigInt('0') ? -value : value;
const emptyCounts = () => Object.fromEntries(PAYROLL_COMPARISON_REASONS.map(reason => [reason, 0])) as Record<PayrollComparisonReason, number>;

/** Period availability precedes missing-side arithmetic. A missing whole company-month is not zero. */
export function payrollComparisonAvailability(
  runs: readonly ComparisonRun[], companyIds: readonly string[], previousPeriod: string, currentPeriod: string,
  runType: 'regular' | 'all',
): { runs: ComparisonRun[]; issues: ComparisonIssue[] } {
  const selected = runs.filter(run => companyIds.includes(run.companyId) &&
    [previousPeriod, currentPeriod].includes(run.period) && (runType === 'all' || run.runType === 'regular'));
  const issues: ComparisonIssue[] = [];
  for (const companyId of companyIds) {
    for (const period of [previousPeriod, currentPeriod]) {
      const periodRuns = selected.filter(run => run.companyId === companyId && run.period === period);
      if (!periodRuns.length) issues.push({ code: 'missingPayroll', period, companyId });
      for (const run of periodRuns) {
        const base = { period, companyId, runId: run.id };
        if (run.stale) issues.push({ ...base, code: 'stalePayroll' });
        else if (run.status === 'draft') issues.push({ ...base, code: 'draftPayroll' });
        else if (period === previousPeriod && run.status !== 'closed') issues.push({ ...base, code: 'previousNotClosed' });
      }
    }
  }
  return { runs: selected, issues };
}

export function comparePayrollResults(input: {
  definition: PayrollComparisonDefinition; filters: PayrollComparisonFilters;
  companyIds: readonly string[]; runs: readonly ComparisonRun[]; sources: readonly ComparisonSource[];
  /** Dated at current period end, or previous period end only where no current side exists. */
  identities: readonly ComparisonIdentity[]; previousFrom: string; currentFrom: string; currentTo: string;
  /** Export callers receive all matching rows after enforcing the source/export bounds. */
  paginate?: boolean;
}): ComparisonResult {
  const { filters } = input;
  if (!filters.currentPeriod || !filters.previousPeriod || !input.companyIds.length)
    throw new PayrollComparisonInputError('periodOrScope');
  if (filters.companyId && !input.companyIds.includes(filters.companyId)) throw new PayrollComparisonInputError('companyScope');
  const selectedCompanies = filters.companyId ? [filters.companyId] : input.companyIds;
  const availability = payrollComparisonAvailability(input.runs, selectedCompanies,
    filters.previousPeriod, filters.currentPeriod, filters.runType);
  const runById = new Map(availability.runs.map(run => [run.id, run]));
  const counts = emptyCounts();
  const result: ComparisonResult = {
    available: false, issues: availability.issues, provisional: availability.runs.some(run => run.status === 'processed'),
    runs: availability.runs, rows: [], displayedRows: 0, comparisonRows: 0,
    reasonCounts: counts, reasonFilterCounts: Object.fromEntries(PAYROLL_COMPARISON_REASON_FILTERS.map(reason=>[reason,0])) as Record<PayrollComparisonReasonFilter,number>, summary: null, page: filters.page, pageSize: filters.pageSize,
  };
  // Do not reveal partial totals while one selected run is unavailable.
  if (result.issues.length) return result;
  const seen = new Set<string>();
  type Side = { amount: bigint; sources: ComparisonSource[] };
  const groups = new Map<string, { employmentId: string; companyId: string; currency: string | null; previous: Side; current: Side }>();
  for (const source of input.sources) {
    const run = runById.get(source.runId);
    if (!run) continue;
    if (source.companyId !== run.companyId) throw new PayrollComparisonInputError('sourceEmployer');
    if (seen.has(source.id)) throw new PayrollComparisonInputError('duplicateResult');
    seen.add(source.id);
    if (source.amount === null) {
      result.issues.push({ code: 'itemNotRecorded', companyId: run.companyId, period: run.period,
        runId: run.id, resultId: source.id });
      continue;
    }
    if (source.currency !== null && !/^[A-Z]{3}$/.test(source.currency)) throw new PayrollComparisonInputError('currency');
    const groupKey = key(source.employmentId, source.companyId, source.currency);
    const group = groups.get(groupKey) ?? {
      employmentId: source.employmentId, companyId: source.companyId, currency: source.currency,
      previous: { amount: BigInt('0'), sources: [] }, current: { amount: BigInt('0'), sources: [] },
    };
    const side = run.period === filters.previousPeriod ? group.previous : group.current;
    side.amount += payrollAmountMinor(source.amount); side.sources.push(source); groups.set(groupKey, group);
  }
  if (result.issues.length) return result;
  const identityByKey = new Map(input.identities.map(identity => [key(identity.employmentId, identity.companyId, null), identity]));
  const rows: ComparisonRow[] = [];
  const previousHeadcount = new Set<string>(), currentHeadcount = new Set<string>();
  const joiners = new Set<string>(), leavers = new Set<string>();
  const totals = new Map<string, { currency: string | null; companyId: string | null; previous: bigint; current: bigint }>();
  for (const group of groups.values()) {
    const identity = identityByKey.get(key(group.employmentId, group.companyId, null));
    if (!identity) throw new PayrollComparisonInputError('missingDatedIdentity');
    if (filters.departmentId && identity.departmentId !== filters.departmentId) continue;
    if (group.previous.sources.length) previousHeadcount.add(group.employmentId);
    if (group.current.sources.length) currentHeadcount.add(group.employmentId);
    const evidenceInput = { autoTag: true,
      previousPeriodFrom: input.previousFrom, periodFrom: input.currentFrom, periodTo: input.currentTo,
      hireDate: identity.hireDate, exitDate: identity.exitDate,
      previous: group.previous.amount, current: group.current.amount,
      previousCoverage: group.previous.sources.map(source => source.coverage),
      currentCoverage: group.current.sources.map(source => source.coverage),
      proratedCoverage: group.current.sources.flatMap(source => source.proratedCoverage ? [source.proratedCoverage] : []),
      movements: identity.movements, verifiedTransferIds: identity.verifiedTransferIds };
    const verified = payrollComparisonReason(evidenceInput);
    const reason = input.definition.autoTag ? verified : payrollComparisonReason({ ...evidenceInput, autoTag: false });
    // Headcount changes concern persisted paid-result presence, independent of the chosen item amount.
    if (!group.previous.sources.length && group.current.sources.length &&
      identity.hireDate >= input.currentFrom && identity.hireDate <= input.currentTo) joiners.add(group.employmentId);
    const exit = identity.exitDate;
    const recordedExit = exit && identity.movements.some(m => m.kind === 'exit' && m.status === 'applied' &&
      m.effectiveDate === exit && exit >= input.previousFrom && exit <= input.currentTo);
    if (recordedExit && exit && (
      group.previous.sources.length && !group.current.sources.length &&
        (exit >= input.currentFrom || group.previous.sources.some(source => source.coverage.from <= exit && exit <= source.coverage.to)) ||
      exit >= input.currentFrom && group.current.sources.some(source => source.coverage.from <= exit && exit <= source.coverage.to)
    )) leavers.add(group.employmentId);
    counts[reason.reason]++;
    const variance = group.currency ? payrollVariance(group.previous.amount, group.current.amount) : null;
    const { movements: _movements, verifiedTransferIds: _transfers, ...display } = identity;
    rows.push({ ...display, currency: group.currency,
      previous: payrollMinorDecimal(group.previous.amount), current: payrollMinorDecimal(group.current.amount),
      variance: variance?.difference ?? null, variancePct: variance?.percentage ?? null, reason,
      previousPresent: group.previous.sources.length > 0, currentPresent: group.current.sources.length > 0,
      sources: [...group.previous.sources, ...group.current.sources].map(({ id, version, runId }) => ({ id, version, runId })),
    });
    const totalKey = JSON.stringify([group.currency, group.currency ? null : group.companyId]);
    const total = totals.get(totalKey) ?? { currency: group.currency, companyId: group.currency ? null : group.companyId, previous: BigInt('0'), current: BigInt('0') };
    total.previous += group.previous.amount; total.current += group.current.amount; totals.set(totalKey, total);
  }
  result.available = true; result.comparisonRows = rows.length;
  result.summary = { previousHeadcount: previousHeadcount.size, currentHeadcount: currentHeadcount.size,
    joiners: joiners.size, leavers: leavers.size, unexplained: counts.unexplained,
    totals: [...totals.values()].map(total => ({ currency: total.currency, companyId: total.companyId,
      previous: payrollMinorDecimal(total.previous), current: payrollMinorDecimal(total.current),
      variance: total.currency ? payrollVariance(total.previous, total.current).difference : null,
      variancePct: total.currency ? payrollVariance(total.previous, total.current).percentage : null,
    })).sort((a, b) => (a.currency ?? '').localeCompare(b.currency ?? '') || (a.companyId ?? '').localeCompare(b.companyId ?? '')) };
  for (const filter of PAYROLL_COMPARISON_REASON_FILTERS) result.reasonFilterCounts[filter] = rows.filter(row => payrollReasonMatches(row.reason, filter)).length;
  const minimum = payrollAmountMinor(filters.minVariance);
  const displayed = rows.filter(row => (!filters.reason || payrollReasonMatches(row.reason, filters.reason)) &&
    // Unknown currency rows stay visible: their difference cannot truthfully be tested against a monetary threshold.
    (!filters.onlyVariances || row.variance === null || abs(payrollAmountMinor(row.variance)) >= minimum));
  displayed.sort((a, b) => Number(b.reason.reason === 'unexplained') - Number(a.reason.reason === 'unexplained') ||
    a.reason.reason.localeCompare(b.reason.reason) ||
    compareMagnitude(a.variance, b.variance) || key(a.employmentId, a.companyId, a.currency).localeCompare(key(b.employmentId, b.companyId, b.currency)));
  result.displayedRows = displayed.length;
  result.rows = input.paginate === false ? displayed : displayed.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize);
  return result;
}
function compareMagnitude(a: string | null, b: string | null): number {
  const left = a === null ? BigInt('0') : abs(payrollAmountMinor(a)), right = b === null ? BigInt('0') : abs(payrollAmountMinor(b));
  return left === right ? 0 : left > right ? -1 : 1;
}
