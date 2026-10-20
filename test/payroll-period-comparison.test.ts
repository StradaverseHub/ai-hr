import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAYROLL_COMPARISON, payrollAmountMinor, payrollVariance,
  payrollComparisonFilters, payrollComparisonReason, validatePayrollComparisonDefinition,
  type PayrollComparisonMovement,
} from '../lib/payroll-period-comparison';
import { comparePayrollResults, type ComparisonRun, type ComparisonSource, type ComparisonIdentity } from '../lib/payroll-comparison-result';
import { recordedPayrollComparisonAmount, recordedPayrollComparisonCurrency } from '../lib/payroll-comparison-source';
const definition = structuredClone(DEFAULT_PAYROLL_COMPARISON);
const companyId = '00000000-0000-0000-0000-000000000001';
const otherCompanyId = '00000000-0000-0000-0000-000000000002';
const filters = payrollComparisonFilters({ currentPeriod: '2026-10' }, definition);
const runs: ComparisonRun[] = [
  { id: 'previous', companyId, period: '2026-09', runType: 'regular', status: 'closed', stale: false },
  { id: 'current', companyId, period: '2026-10', runType: 'regular', status: 'processed', stale: false },
];
const identity = (employmentId: string, overrides: Partial<ComparisonIdentity> = {}): ComparisonIdentity => ({
  employmentId, companyId, employeeCode: '0007', employeeName: '=王小明', departmentId: null,
  department: null, grade: null, company: 'Fictional Employer', costCentre: null,
  hireDate: '2025-01-01', exitDate: null, movements: [], verifiedTransferIds: [], ...overrides,
});
const source = (id: string, employmentId: string, runId: string, amount: string, overrides: Partial<ComparisonSource> = {}): ComparisonSource => ({
  id, employmentId, runId, amount, companyId, currency: 'MYR', version: 1,
  coverage: runId === 'previous' ? { from: '2026-09-01', to: '2026-09-30' } : { from: '2026-10-01', to: '2026-10-31' }, ...overrides,
});
const compare = (sources: ComparisonSource[], identities: ComparisonIdentity[], options: Partial<Parameters<typeof comparePayrollResults>[0]> = {}) => comparePayrollResults({
  definition, filters, companyIds: [companyId], runs, sources, identities,
  previousFrom: '2026-09-01', currentFrom: '2026-10-01', currentTo: '2026-10-31', ...options,
});
const movement = (kind: PayrollComparisonMovement['kind'], date = '2026-10-01', status: PayrollComparisonMovement['status'] = 'applied'): PayrollComparisonMovement => ({
  id: `${kind}-${status}`, sequence: 4, effectiveDate: date, kind, salaryChanged: true, status,
});

describe('payroll comparison exact arithmetic and validation', () => {
  it('keeps cents exact beyond JavaScript safe integer arithmetic and rounds percentage ties', () => {
    expect(payrollAmountMinor('9999999999999999.99')).toBe(BigInt('999999999999999999'));
    expect(payrollVariance(BigInt('20000'), BigInt('20001'))).toEqual({ difference: '0.01', percentage: '0.01' });
    expect(payrollVariance(BigInt('20000'), BigInt('19999'))).toEqual({ difference: '-0.01', percentage: '-0.01' });
    expect(payrollVariance(BigInt('0'), BigInt('500')).percentage).toBeNull();
  });
  it.each([NaN, Infinity, '1e3', '0.001', true, null])('rejects an unsupported amount %s', value => {
    expect(() => payrollAmountMinor(value)).toThrow();
  });
  it('rejects roles that widen the authority ceiling, unknown fields, and invalid pagination', () => {
    expect(() => validatePayrollComparisonDefinition({ ...definition, roles: ['payroll_partner'] })).toThrow();
    expect(() => validatePayrollComparisonDefinition({ ...definition, sql: 'select 1' })).toThrow();
    for (const page of [true, '1e2', -1, '2.5']) expect(() => payrollComparisonFilters({ page }, definition)).toThrow();
    expect(() => payrollComparisonFilters({ currentPeriod: '2026-10', previousPeriod: '2026-11' }, definition)).toThrow();
    expect(payrollComparisonFilters({ currentPeriod: '2026-01' }, definition).previousPeriod).toBe('2025-12');
  });
});

describe('saved result provenance', () => {
  it('reads paid basic independently of component display classification', () => {
    expect(recordedPayrollComparisonAmount('2500.17', { componentLines: [{ code: 'BASIC', amount: 9000 }] }, 'BASIC')).toBe('2500.17');
  });
  it('distinguishes recorded absence from unrecorded history and ignores bucket subtotals', () => {
    expect(recordedPayrollComparisonAmount('0', {}, 'ALLOWANCE')).toBeNull();
    expect(recordedPayrollComparisonAmount('0', { componentLines: [] }, 'ALLOWANCE')).toBe('0.00');
    expect(recordedPayrollComparisonAmount('0', { componentLines: [{ code: 'ALLOWANCE', amount: 10.1, buckets: [{ amount: 10.1 }] }, { code: 'ALLOWANCE', amount: -0.01 }] }, 'ALLOWANCE')).toBe('10.09');
    expect(recordedPayrollComparisonAmount('0', { componentLines: [{ code: 'ALLOWANCE', amount: 'broken' }] }, 'ALLOWANCE')).toBeNull();
  });
  it('does not substitute a live company currency or another employer stamp', () => {
    expect(recordedPayrollComparisonCurrency({ currency: 'MYR' }, companyId)).toBeNull();
    expect(recordedPayrollComparisonCurrency({ reportContext: { version: 1, payingCompanyId: otherCompanyId, currency: 'MYR' } }, companyId)).toBeNull();
    expect(recordedPayrollComparisonCurrency({ reportContext: { version: 1, payingCompanyId: companyId, currency: 'MYR' } }, companyId)).toBe('MYR');
  });
});

describe('period availability and aggregation', () => {
  it.each(['draft', 'processed'] as const)('refuses previous %s payroll before calculating money', status => {
    const result = compare([source('a', 'e', 'current', '100')], [identity('e')], { runs: [{ ...runs[0], status }, runs[1]] });
    expect(result.available).toBe(false); expect(result.summary).toBeNull(); expect(result.rows).toEqual([]);
  });
  it('refuses missing company-months and stale contributing supplementary runs', () => {
    expect(compare([], [], { runs: [runs[1]] }).issues[0].code).toBe('missingPayroll');
    const bonus: ComparisonRun = { ...runs[1], id: 'bonus', runType: 'bonus', stale: true };
    expect(compare([], [], { runs: [...runs, bonus], filters: { ...filters, runType: 'all' } }).issues[0].code).toBe('stalePayroll');
    expect(compare([], [], { runs: [...runs, bonus] }).available).toBe(true);
  });
  it('joins both sides by employment and paying employer, preserving absent versus recorded zero', () => {
    const result = compare([
      source('a', 'rehire-one', 'previous', '100'), source('b', 'rehire-two', 'current', '100'),
      source('c', 'zero-result', 'current', '0'),
    ], [identity('rehire-one'), identity('rehire-two'), identity('zero-result')], { filters: { ...filters, onlyVariances: false } });
    expect(result.comparisonRows).toBe(3);
    expect(result.summary).toMatchObject({ previousHeadcount: 1, currentHeadcount: 2, joiners: 0, leavers: 0 });
    expect(result.rows.find(row => row.employmentId === 'zero-result')).toMatchObject({ previousPresent: false, currentPresent: true });
    expect(result.rows.find(row => row.employmentId === 'rehire-one')?.reason.reason).toBe('unexplained');
  });
  it('sums only actual persisted earnings across selected runs and keeps summary before row filters', () => {
    const bonus: ComparisonRun = { ...runs[1], id: 'bonus', runType: 'bonus' };
    const result = compare([source('a', 'e', 'previous', '100'), source('b', 'e', 'current', '100'), source('c', 'e', 'bonus', '0.01')], [identity('e')], {
      runs: [...runs, bonus], filters: { ...filters, runType: 'all', minVariance: '0.02' },
    });
    expect(result.provisional).toBe(true); expect(result.displayedRows).toBe(0);
    expect(result.reasonCounts.unexplained).toBe(1);
    expect(result.summary?.totals[0]).toMatchObject({ previous: '100.00', current: '100.01', variance: '0.01' });
  });
  it('groups salary changes without losing their labels and finds prorated hires through both chips', () => {
    const sources = [source('p1','increment','previous','100'),source('c1','increment','current','120'),
      source('p2','promotion','previous','100'),source('c2','promotion','current','130'),
      source('c3','newHire','current','50',{coverage:{from:'2026-10-15',to:'2026-10-31'}}),
      source('p4','demotion','previous','100'),source('c4','demotion','current','90')];
    const identities = [identity('increment',{movements:[movement('increment')]}),
      identity('promotion',{movements:[movement('promotion')]}),identity('newHire',{hireDate:'2026-10-15'}),
      identity('demotion',{movements:[movement('demotion')]})];
    const grouped = compare(sources,identities,{filters:payrollComparisonFilters({currentPeriod:'2026-10',reason:'incrementPromotion',pageSize:1},definition)});
    expect(grouped.reasonFilterCounts).toMatchObject({incrementPromotion:2,prorated:1,newHire:1,demotion:1});
    expect(grouped.displayedRows).toBe(2);expect(grouped.rows).toHaveLength(1);
    expect(grouped.summary?.currentHeadcount).toBe(4);
    const allGrouped = compare(sources,identities,{filters:{...filters,reason:'incrementPromotion'},paginate:false});
    expect(allGrouped.rows.map(row=>row.reason.reason).sort()).toEqual(['increment','promotion']);
    const prorated = compare(sources,identities,{filters:{...filters,reason:'prorated'}});
    expect(prorated.rows.map(row=>row.employmentId)).toEqual(['newHire']);
    expect(prorated.rows[0].reason).toMatchObject({reason:'newHire',prorated:true});
    expect(() => payrollComparisonFilters({reason:'salaryChangeOrAnything'},definition)).toThrow();
  });
  it('never merges unknown currencies from different employers or asserts their percentage', () => {
    const result = compare([source('a', 'e', 'current', '100', { currency: null }), source('b', 'f', 'other-current', '200', { companyId: otherCompanyId, currency: null })],
      [identity('e'), identity('f', { companyId: otherCompanyId })], { companyIds: [companyId, otherCompanyId],
        runs: [...runs, ...runs.map(run => ({ ...run, id: `other-${run.id}`, companyId: otherCompanyId }))] });
    expect(result.summary?.totals).toHaveLength(2);
    expect(result.summary?.totals.every(total => total.variance === null && total.variancePct === null)).toBe(true);
  });
  it('refuses unsupported historical items and duplicates instead of giving partial totals', () => {
    expect(compare([source('a', 'e', 'current', '100', { amount: null })], [identity('e')]).summary).toBeNull();
    expect(() => compare([source('a', 'e', 'current', '100'), source('a', 'e', 'current', '100')], [identity('e')])).toThrow();
  });
  it('enforces the selected company and exposes complete counts while paging detail', () => {
    expect(() => compare([], [], { filters: { ...filters, companyId: otherCompanyId } })).toThrow();
    const result = compare([source('a', 'e', 'current', '100'), source('b', 'f', 'current', '200')], [identity('e'), identity('f')], { filters: { ...filters, pageSize: 1 } });
    expect(result.displayedRows).toBe(2); expect(result.rows).toHaveLength(1); expect(result.summary?.currentHeadcount).toBe(2);
  });
});

describe('recorded explanations', () => {
  const base = { autoTag: true, previousPeriodFrom: '2026-09-01', periodFrom: '2026-10-01', periodTo: '2026-10-31',
    hireDate: '2025-01-01', exitDate: null, previous: BigInt('100'), current: BigInt('0'),
    previousCoverage: [{ from: '2026-09-01', to: '2026-09-30' }], currentCoverage: [], movements: [] };
  it('never treats missing pay alone as resignation', () => {
    expect(payrollComparisonReason(base).reason).toBe('unexplained');
    expect(payrollComparisonReason({ ...base, exitDate: '2026-10-01' }).reason).toBe('unexplained');
  });
  it('recognizes an applied exit at the previous coverage end, but not an unrelated old exit', () => {
    expect(payrollComparisonReason({ ...base, exitDate: '2026-09-30', movements: [movement('exit', '2026-09-30')] }).reason).toBe('resigned');
    expect(payrollComparisonReason({ ...base, exitDate: '2025-09-30', movements: [movement('exit', '2025-09-30')] }).reason).toBe('unexplained');
  });
  it('requires saved coverage for prorated hire or exit and ignores pending/reversed changes', () => {
    const currentCoverage = [{ from: '2026-10-15', to: '2026-10-31' }];
    expect(payrollComparisonReason({ ...base, hireDate: '2026-10-15', previous: BigInt('0'), current: BigInt('100'), currentCoverage })).toMatchObject({ reason: 'newHire', prorated: true });
    for (const status of ['pending', 'reversed', 'superseded'] as const)
      expect(payrollComparisonReason({ ...base, movements: [movement('promotion', '2026-10-01', status)] }).reason).toBe('unexplained');
  });
  it('requires verified transfer evidence and picks the latest salary change with disclosed alternatives', () => {
    const movements = [movement('transfer'), movement('increment'), { ...movement('promotion'), sequence: 5 }];
    expect(payrollComparisonReason({ ...base, movements })).toMatchObject({ reason: 'promotion', multipleChanges: true });
    expect(payrollComparisonReason({ ...base, movements, verifiedTransferIds: ['transfer-applied'] }).reason).toBe('transfer');
    expect(payrollComparisonReason({ ...base, movements, autoTag: false }).reason).toBe('unclassified');
  });
  it('retains verified joiner counts when automatic detail labels are off', () => {
    const result = compare([source('a', 'e', 'current', '0')], [identity('e', { hireDate: '2026-10-01' })], { definition: { ...definition, autoTag: false } });
    expect(result.summary?.joiners).toBe(1); expect(result.reasonCounts.unclassified).toBe(1);
  });
});
