import { expect, it } from 'vitest';
import { addNotice, defaultSettlementPolicy, settlement, type SettlementInput } from '../lib/lifecycle-v9-calculator';
const input = (): SettlementInput => ({ type: 'Resignation', noticeDate: '2026-09-30', sourceLastDay: '2026-10-30', grade: 'E3', employmentType: 'permanent', contractNotice: null, override: null, keepSourceDate: false, remainingLeave: 5, basic: 5200, allowances: 260, currency: 'MYR', offsetLeave: false, reduceEncashment: null });
it('uses the employment contract before grade policy and clamps month ends', () => {
  expect(addNotice('2026-01-31', { value: 1, unit: 'month' })).toBe('2026-02-28');
  const source = input(); source.contractNotice = { value: 2, unit: 'week' };
  expect(settlement(source, defaultSettlementPolicy())).toMatchObject({ calculatedLastDay: '2026-10-14', noticeSource: 'Employment contract', mismatch: true });
});
it('uses the fixed date for contract end and retirement', () => {
  for (const type of ['Contract end', 'Retirement'] as const) expect(settlement({ ...input(), type, sourceLastDay: '2026-11-14' }, defaultSettlementPolicy()).lastDay).toBe('2026-11-14');
});
it('takes the authoritative leave balance and applies rate, allowance, cap and reduction policy', () => {
  const source = input(), policy = defaultSettlementPolicy();
  expect(settlement(source, policy)).toMatchObject({ encashDays: 5, dailyRate: 200, amount: 1000, payDate: '2026-11-25', ready: true });
  policy.includeAllowances = true; policy.encashmentCap = 3;
  expect(settlement(source, policy)).toMatchObject({ encashDays: 3, dailyRate: 210, amount: 630 });
  source.reduceEncashment = { days: 2, reason: 'HR settlement approval' };
  expect(settlement(source, policy)).toMatchObject({ encashDays: 2, amount: 420, reductionStale: false });
  policy.encashmentCap = 1;
  expect(settlement(source, policy)).toMatchObject({ encashDays: 1, reductionStale: true });
});
it('offsets positive leave against unserved notice and recovers negative leave without a cap', () => {
  const source = input(), policy = defaultSettlementPolicy();
  source.override = { date: '2026-10-28', kind: 'earlyRelease', reason: 'Agreed early release' }; source.offsetLeave = true;
  expect(settlement(source, policy)).toMatchObject({ unservedDays: 2, offsetDays: 2, encashDays: 3, amount: 600 });
  source.remainingLeave = -2; policy.encashmentCap = 0;
  expect(settlement(source, policy)).toMatchObject({ offsetDays: 0, encashDays: -2, amount: -400, deduction: true });
});
it('requires real salary and leave data rather than treating absent data as zero', () => {
  const source = input(); source.basic = null; source.remainingLeave = null;
  expect(settlement(source, defaultSettlementPolicy())).toMatchObject({ ready: false, amount: null, missing: ['Leave balance as at the last working day', 'Effective basic salary'] });
});
