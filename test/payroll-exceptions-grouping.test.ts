/**
 * AI-native batch (11 November 2026) — the grouped Exceptions page's pure rules: three-bucket classification, grouping,
 * the bulk "Mark as expected" guard and each exception's line of evidence. No database; every expected value is written
 * out.
 */
import { describe, expect, it } from 'vitest';
import { DETECTORS, HYPOTHESIS_DETECTOR_ID } from '../core/payroll-anomaly-detectors';
import {
  BULK_EXPECT_MAX, BulkExpectRefused, CATALOGUE, bucketCounts, bucketOf, buildGroups, describeGroup, findingDetail, groupKey, mayBulkExpect,
  parseGroupKey, parseSignature, planBulkExpect, requestedIds, skipReason, variantOf, verdictBucket, type BulkCandidate, type GroupAggregateRow,
} from '../lib/payroll-exceptions';

const ALL_IDS = [...DETECTORS.map(d => d.id), HYPOTHESIS_DETECTOR_ID];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agg = (checkId: string, severity: string, variant: string | null, exceptions: number, extra: Partial<GroupAggregateRow> = {}): GroupAggregateRow =>
  ({ checkId, severity, variant, exceptions, people: exceptions, companies: 1, runs: 1, companyNames: [], ...extra });

describe('three buckets, from the check and its severity only', () => {
  it('sorts every catalogued check deterministically', () => {
    const table = Object.fromEntries(ALL_IDS.map(id => [id, [bucketOf(id, 'block'), bucketOf(id, 'review')]]));
    expect(table).toEqual({
      'negative-net': ['check', 'check'],
      'statutory-over-cap': ['check', 'check'],
      'missing-bank-profile': ['missing', 'missing'],
      'duplicate-employment-pay': ['check', 'check'],
      'zero-net-with-pay': ['check', 'check'],
      'missing-tax-profile': ['missing', 'missing'],
      'pay-without-attendance': ['check', 'setup'],
      'proration-mismatch': ['check', 'check'],
      'net-swing': ['check', 'check'],
      'component-appeared': ['check', 'setup'],
      'component-vanished': ['check', 'setup'],
      hypothesis: ['check', 'check'],
    });
  });

  it('never puts a blocking finding in the set-up bucket, and puts an uncatalogued check where each one is looked at', () => {
    for (const id of [...ALL_IDS, 'a-check-added-later']) expect(bucketOf(id, 'block'), id).not.toBe('setup');
    expect(bucketOf('a-check-added-later', 'review')).toBe('check');
  });

  it('counts one exception once, in its most serious bucket, so the three figures add up', () => {
    expect(verdictBucket('review', [{ checkId: 'pay-without-attendance', severity: 'review' }, { checkId: 'missing-tax-profile', severity: 'review' }])).toBe('missing');
    expect(verdictBucket('block', [{ checkId: 'missing-bank-profile', severity: 'block' }, { checkId: 'net-swing', severity: 'review' }])).toBe('check');
    expect(verdictBucket('block', [{ checkId: 'component-appeared', severity: 'review' }])).toBe('check');
    expect(verdictBucket('review', [])).toBe('check');
    expect(parseSignature(['net-swing:review', 'broken', 'missing-bank-profile:block'])).toEqual([
      { checkId: 'net-swing', severity: 'review' }, { checkId: 'missing-bank-profile', severity: 'block' }]);
    const counts = bucketCounts([
      { disposition: 'block', signature: ['negative-net:block'], count: 5 },
      { disposition: 'review', signature: ['net-swing:review'], count: 3 },
      { disposition: 'block', signature: ['missing-bank-profile:block'], count: 31 },
      { disposition: 'review', signature: ['missing-tax-profile:review'], count: 9 },
      { disposition: 'review', signature: ['pay-without-attendance:review'], count: 74 },
      { disposition: 'review', signature: ['component-appeared:review'], count: 13 },
    ]);
    expect(counts).toEqual({ check: 8, missing: 40, setup: 87 });
    expect(counts.check + counts.missing + counts.setup).toBe(135);
  });
});

describe('groups', () => {
  it('splits by the bank reason and by the pay item, and falls back without one', () => {
    expect(variantOf('missing-bank-profile', { reason: 'payment-method-not-set' })).toBe('payment-method-not-set');
    expect(variantOf('missing-bank-profile', { reason: 'bank-details-missing' })).toBe('bank-details-missing');
    expect(variantOf('missing-bank-profile', { paymentMethod: 'unset' })).toBeNull();
    expect(variantOf('missing-bank-profile', { reason: 'something-new' })).toBeNull();
    expect(variantOf('component-appeared', { component: 'hrdf' })).toBe('hrdf');
    expect(variantOf('component-appeared', { component: 'formulaEvaluations' })).toBe('other');
    expect(variantOf('component-vanished', null)).toBe('other');
    expect(variantOf('negative-net', { reason: 'payment-method-not-set' })).toBeNull();
  });

  it('round-trips a group key and refuses anything else', () => {
    const id = { checkId: 'missing-bank-profile', severity: 'block', variant: 'bank-details-missing' };
    expect(groupKey(id)).toBe('missing-bank-profile.block.bank-details-missing');
    expect(parseGroupKey(groupKey(id))).toEqual(id);
    expect(parseGroupKey('pay-without-attendance.review.-')).toEqual({ checkId: 'pay-without-attendance', severity: 'review', variant: null });
    for (const bad of [undefined, '', 'a.b', 'Negative.block.-', 'negative-net.urgent.-', 'negative-net.block.x y', 'a.b.c.d', 'x'.repeat(200), 7])
      expect(parseGroupKey(bad), String(bad)).toBeNull();
  });

  it('orders worst first and says what each group\'s button does; blocking groups are only ever worked one by one', () => {
    const groups = buildGroups([
      agg('component-appeared', 'review', 'hrdf', 13), agg('pay-without-attendance', 'review', null, 74, { companies: 9 }),
      agg('net-swing', 'review', null, 3), agg('missing-tax-profile', 'review', null, 9), agg('negative-net', 'block', null, 5),
      agg('missing-bank-profile', 'block', 'payment-method-not-set', 31), agg('zero-net-with-pay', 'review', null, 0),
    ]);
    expect(groups.map(g => [g.key, g.bucket, g.blocking, g.action, g.bulkExpect, g.fixTab])).toEqual([
      ['negative-net.block.-', 'check', true, 'one_by_one', false, null],
      ['net-swing.review.-', 'check', false, 'review', false, null],
      ['missing-bank-profile.block.payment-method-not-set', 'missing', true, 'fix_records', false, 'payroll'],
      ['missing-tax-profile.review.-', 'missing', false, 'fix_records', false, 'bankStatutory'],
      ['pay-without-attendance.review.-', 'setup', false, 'mark_expected', true, null],
      ['component-appeared.review.hrdf', 'setup', false, 'mark_expected', true, null],
    ]);
    expect(describeGroup(agg('missing-bank-profile', 'block', 'bank-details-missing', 1)).fixTab).toBe('bankStatutory');
    expect(describeGroup(agg('missing-bank-profile', 'block', null, 1)).copy.title).toBe('check.missingBankProfile.title');
    expect(describeGroup(agg('component-appeared', 'review', 'hrdf', 1)).copy).toEqual({
      title: 'check.componentAppeared.titleNamed', why: 'check.componentAppeared.why', todo: 'check.componentAppeared.todo', component: 'component.hrdf' });
  });

  it('never offers bulk for a blocking group, whatever its check', () => {
    for (const id of [...Object.keys(CATALOGUE), 'a-check-added-later']) {
      expect(mayBulkExpect({ checkId: id, severity: 'block', variant: null }), id).toBe(false);
      expect(describeGroup(agg(id, 'block', null, 2)).action === 'mark_expected', id).toBe(false);
    }
    expect(Object.keys(CATALOGUE).filter(id => mayBulkExpect({ checkId: id, severity: 'review', variant: null })).sort())
      .toEqual(['component-appeared', 'component-vanished', 'pay-without-attendance']);
  });
});

describe('the bulk "Mark as expected" guard', () => {
  const SETUP = { checkId: 'pay-without-attendance', severity: 'review', variant: null };
  const cand = (n: number, over: Partial<BulkCandidate> = {}): BulkCandidate => ({ verdictId: uuid(n), disposition: 'review', resolved: false, superseded: false,
    findings: [{ checkId: 'pay-without-attendance', severity: 'review', facts: { netPay: 100 } }], ...over });

  it('refuses a blocking or non-set-up group outright', () => {
    for (const group of [{ checkId: 'negative-net', severity: 'block', variant: null }, { checkId: 'missing-bank-profile', severity: 'block', variant: 'payment-method-not-set' },
      { checkId: 'pay-without-attendance', severity: 'block', variant: null }, { checkId: 'net-swing', severity: 'review', variant: null },
      { checkId: 'missing-tax-profile', severity: 'review', variant: null }]) {
      expect(() => planBulkExpect(group, [uuid(1)], [cand(1)]), group.checkId).toThrow(BulkExpectRefused);
      try { planBulkExpect(group, [uuid(1)], [cand(1)]); } catch (e) { expect((e as BulkExpectRefused).reason).toBe('blocking'); }
    }
  });

  it('closes only open, non-blocking exceptions whose every finding is this check, and says why it skipped the rest', () => {
    const plan = planBulkExpect(SETUP, [1, 2, 3, 4, 5, 6, 7, 8].map(uuid), [
      cand(1),
      cand(2, { disposition: 'block' }),
      cand(3, { findings: [{ checkId: 'pay-without-attendance', severity: 'review', facts: null }, { checkId: 'negative-net', severity: 'block', facts: null }] }),
      cand(4, { findings: [{ checkId: 'pay-without-attendance', severity: 'review', facts: null }, { checkId: 'missing-tax-profile', severity: 'review', facts: null }] }),
      cand(5, { resolved: true }),
      cand(6, { superseded: true }),
      cand(7, { findings: [{ checkId: 'component-appeared', severity: 'review', facts: { component: 'bonus' } }] }),
    ]);
    expect(plan.resolve).toEqual([uuid(1)]);
    expect(plan.skipped).toEqual([
      { verdictId: uuid(2), reason: 'blocking' }, { verdictId: uuid(3), reason: 'blocking' }, { verdictId: uuid(4), reason: 'other_checks' },
      { verdictId: uuid(5), reason: 'closed' }, { verdictId: uuid(6), reason: 'closed' }, { verdictId: uuid(7), reason: 'other_checks' },
      { verdictId: uuid(8), reason: 'not_found' },
    ]);
  });

  it('matches the pay item of a pay-item group', () => {
    const hrdf = { checkId: 'component-appeared', severity: 'review', variant: 'hrdf' };
    const c = (n: number, component: string) => cand(n, { findings: [{ checkId: 'component-appeared', severity: 'review', facts: { component } }] });
    expect(skipReason(hrdf, c(1, 'hrdf'))).toBeNull();
    expect(skipReason(hrdf, c(2, 'bonus'))).toBe('not_in_group');
  });

  it('takes 1 to BULK_EXPECT_MAX distinct ids, nothing else', () => {
    expect(BULK_EXPECT_MAX).toBe(25);
    expect(requestedIds([uuid(1), uuid(1).toUpperCase(), uuid(2)])).toEqual([uuid(1), uuid(2)]);
    const reason = (values: unknown[]) => { try { requestedIds(values); return null; } catch (e) { return (e as BulkExpectRefused).reason; } };
    expect(reason([])).toBe('nothing');
    expect(reason(['not-an-id'])).toBe('invalid');
    expect(reason([uuid(1), 3])).toBe('invalid');
    expect(reason(Array.from({ length: BULK_EXPECT_MAX }, (_, i) => uuid(i)))).toBeNull();
    expect(reason(Array.from({ length: BULK_EXPECT_MAX + 1 }, (_, i) => uuid(i)))).toBe('too_many');
  });
});

describe('each exception\'s line of evidence', () => {
  it('picks the stored figures out by name and says which are money', () => {
    expect(findingDetail('negative-net', { netPay: -300, grossPay: 100, totalDeductions: 400 }))
      .toEqual({ key: 'detail.negativeNet', money: { grossPay: 100, totalDeductions: 400, netPay: -300 }, numbers: {} });
    expect(findingDetail('net-swing', { netPay: 11642.8, priorNetPay: 6386.55, movementPct: 82.3, thresholdPct: 30 }))
      .toEqual({ key: 'detail.netSwing', money: { priorNetPay: 6386.55, netPay: 11642.8 }, numbers: { pct: 82.3 }, direction: 'up' });
    expect(findingDetail('net-swing', { netPay: 1, priorNetPay: 2, movementPct: -50 }).direction).toBe('down');
    expect(findingDetail('missing-bank-profile', { netPay: 900, paymentMethod: 'unset', reason: 'payment-method-not-set' }).key).toBe('detail.missingBankProfile.paymentMethodNotSet');
    expect(findingDetail('missing-bank-profile', { netPay: 900, paymentMethod: 'bank_transfer', reason: 'bank-details-missing' }).key).toBe('detail.missingBankProfile.bankDetailsMissing');
    expect(findingDetail('missing-bank-profile', { netPay: 900, paymentMethod: 'unset' }).key).toBe('detail.missingBankProfile.generic');
    expect(findingDetail('missing-tax-profile', { pcb: 0 }).key).toBe('detail.missingTaxProfile.noTax');
    expect(findingDetail('missing-tax-profile', { pcb: 12 })).toEqual({ key: 'detail.missingTaxProfile.withTax', money: { pcb: 12 }, numbers: {} });
    expect(findingDetail('statutory-over-cap', { component: 'eisEmployee', actual: 10, cap: 7.9, excess: 2.1 }).component).toBe('component.eisEmployee');
    expect(findingDetail('component-appeared', { component: 'mysteryItem', amount: 5 }).component).toBe('component.other');
    expect(findingDetail('duplicate-employment-pay', { netPay: 10, otherEmployments: 1, otherEmploymentIds: uuid(9) }))
      .toEqual({ key: 'detail.duplicateEmploymentPay', money: { netPay: 10 }, numbers: { others: 1 } });
  });

  it('gives the generic sentence, never a blank or a field name, when a figure is missing', () => {
    expect(findingDetail('negative-net', { netPay: -1 }).key).toBe('detail.generic');
    expect(findingDetail('net-swing', {}).key).toBe('detail.generic');
    expect(findingDetail('a-check-added-later', { netPay: 1 }).key).toBe('detail.generic');
    expect(findingDetail('proration-mismatch', null).key).toBe('detail.generic');
  });
});
