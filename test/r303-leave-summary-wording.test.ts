/**
 * r303 hand-fix (verification of 31492f74). Two wording defects the verifier proved on real engine ledgers:
 *   1. The Earned to Date status sentence said "No entitlement table applies, so nothing is credited" directly above
 *      a list of credits adding up to a non-zero figure — a Replacement Leave with Leave Credits, or a year granted
 *      before its eligibility rule expired. Where credits exist the status is now stated without that claim.
 *   2. English band sentences read "1 years of service" / "0 years and under 1 years".
 * The dates below are fixed PAST dates injected into the services (the Leave Credit service takes `today`).
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { leaveEntitlementBreakdown } from '../core/read';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { grantLeaveCredit, runToilExpiry, setToilPolicy } from '../core/toil';
import { explainLeaveSummary, type ExplainStep } from '../lib/leave-summary-explain';
import { formatDays } from '../lib/day-format';
import en from '../messages/en.json';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const hire = (hiredOn: string, companyId = b.companyId, departmentId = b.deptA, grant: { id: string; code: string }[] = []) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Wording Employee', primaryEmail: `r303wd_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: grant,
  });

const t = createTranslator({ locale: 'en', messages: en as never, namespace: 'leave.breakdown.explain' as never }) as unknown as (
  k: string,
  v?: Record<string, string | number>,
) => string;
const english = (steps: ExplainStep[]) =>
  steps
    .map((s) => {
      const v: Record<string, string | number> = {};
      for (const [k, a] of Object.entries(s.args ?? {})) {
        if ('days' in a) v[k] = formatDays(a.days);
        else if ('signedDays' in a) v[k] = a.signedDays > 0 ? `+${formatDays(a.signedDays)}` : formatDays(a.signedDays);
        else if ('date' in a) v[k] = a.date;
        else if ('text' in a) v[k] = a.text;
        else if ('count' in a) v[k] = a.count;
        else if ('choice' in a) v[k] = a.choice;
        else v[k] = a.list.join(', ');
      }
      return t(s.key, v);
    })
    .join(' | ');

describe('a status sentence never says nothing is credited above a list of credits', () => {
  it('Replacement Leave with Leave Credits: "No entitlement table applies, so nothing is credited" next to the credits', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    const admin = await entitledCtx(b);
    await setToilPolicy(admin, { companyId: b.companyId, enabled: true, accrualBasis: 'hours_worked', expiryDays: 90, onExpiry: 'lapse', allowFirstScheduleEligible: false, autoAccrueOnApproval: false, carryForwardAtYearEnd: false, employeeRequestEnabled: true });
    const e = await hire('2024-01-01');
    await setCompensation(adminCtx(b), { employmentId: e.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    const TODAY = '2026-06-15';
    await setRestDay(adminCtx(b), { employmentId: e.employmentId, shiftDate: '2026-06-13' });
    await grantLeaveCredit(admin, { employmentId: e.employmentId, workedDate: '2026-06-13', days: 2, reason: 'Worked rest day', today: TODAY });
    await runToilExpiry(admin, { today: TODAY });
    const [rl] = await owner.db.select({ id: schema.leaveType.id }).from(schema.leaveType).where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
    const bd = (await leaveEntitlementBreakdown(admin, e.employmentId, rl.id, TODAY, 'en', { derivation: true }))!;
    const lines = explainLeaveSummary(bd, { available: bd.totalAvailable });
    const keys = lines.ytdEntitled.map((s) => s.key);
    const text = english(lines.ytdEntitled);
    expect(keys, text).toContain('earnedNoTableWithCredits');
    expect(bd.currentYearEntitlement).toBe(2);
    expect(keys.includes('earnedNoTable') && keys.includes('creditItem'), `contradiction: ${text}`).toBe(false);
  });

  it('an eligibility rule that expired after the year was granted: "nothing is credited" next to 12.00 credited', async () => {
    const tpl = await createEntitlementTemplate(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, name: 'Annual — all', serviceBands: [{ fromYears: 0, toYears: null, days: 12 }], validFrom: '2020-01-01' });
    await createEligibilityRule(adminCtx(b), { name: 'Everyone', templateLineageId: tpl.lineageId, criteria: { companyIds: [b.companyId] }, validFrom: '2020-01-01' });
    // A second table exists so the status is no_eligibility_match rather than a sole-table fallback.
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, name: 'Annual — ops', serviceBands: [{ fromYears: 0, toYears: null, days: 14 }], validFrom: '2020-01-01' });
    const e = await hire('2025-01-01');
    await owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: e.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '12.00', effectiveOn: '2026-01-01' });
    await owner.db.update(schema.entitlementEligibilityRule).set({ validTo: '2026-08-13' } as never).where(eq(schema.entitlementEligibilityRule.tenantId, b.tenantId));
    const bd = (await leaveEntitlementBreakdown(adminCtx(b), e.employmentId, b.annualLeaveTypeId, '2026-09-01', 'en', { derivation: true }))!;
    const lines = explainLeaveSummary(bd, { available: bd.totalAvailable });
    const keys = lines.ytdEntitled.map((s) => s.key);
    const text = english(lines.ytdEntitled);
    expect(keys.some((k) => k.endsWith('WithCredits')), text).toBe(true);
    expect(text, 'the English sentence').not.toMatch(/nothing is credited/);
    expect(bd.currentYearEntitlement).toBe(12);
    expect((keys.includes('earnedNoTable') || keys.includes('earnedMethodMissing')) && keys.includes('creditItem'), `contradiction: ${text}`).toBe(false);
  });
});

describe('band sentences use the plural the number needs (en)', () => {
  it('1 year / 2 years, open and closed bands', () => {
    expect(t('eligibleBandOpen', { from: 1, days: '14.00' })).toBe("The table's band for 1 year of service and over gives 14.00 days.");
    expect(t('eligibleBand', { from: 0, to: 1, days: '8.00' })).toBe("The table's band for 0 years and under 1 year of service gives 8.00 days.");
    expect(t('eligibleBand', { from: 2, to: 5, days: '16.00' })).toBe("The table's band for 2 years and under 5 years of service gives 16.00 days.");
  });
});
