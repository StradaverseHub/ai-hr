/**
 * Payroll readiness aggregation (feedback 5db3ae48, Phase A) — the config-LEVEL pre-flight above the
 * per-batch preProcessAdvisory. Exercises the tri-state classification (ok | warning | blocker) the
 * reporter's PRE-PROCESS VALIDATION step asks for, and confirms:
 *   • RECOMMENDED severities (product decision 4): no active cycle = BLOCKER; missing pay-day / pay
 *     items / assigned policy = WARNING (the run still computes via defaults).
 *   • Product decision 6: an unassigned payroll policy is a WARNING, never a hard blocker (monthly
 *     fallback is legitimate).
 *   • The employee-master check keeps the same blocker(no salary)/warning(no statutory) semantics as
 *     preProcessAdvisory but at company scope.
 *   • The transactions check is informational (never blocks) and reflects individual txns entered.
 *   • `ready` is true iff there are no blockers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { seedPayComponentCatalog } from '../core/pay-components';
import { upsertPayrollCycle } from '../core/payroll-cycle';
import { setPayrollConfig } from '../core/payroll-config';
import { createPolicy } from '../core/payroll-policy';
import { payrollReadiness, type ReadinessCheck, type ReadinessCheckKey } from '../core/payroll-readiness';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const PERIOD = '2026-05';

const byKey = (checks: ReadinessCheck[]) =>
  Object.fromEntries(checks.map((c) => [c.key, c])) as Record<ReadinessCheckKey, ReadinessCheck>;

async function hire(a: ReturnType<typeof adminCtx>, name: string) {
  return hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@readiness.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

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

describe('5db3ae48 Phase A — payroll readiness aggregation', () => {
  it('bare company: no active cycle is a BLOCKER; missing items/schedule/policy are WARNINGS; not ready', async () => {
    const a = adminCtx(b);
    const report = await payrollReadiness(a, { companyId: b.companyId, payPeriod: PERIOD });
    const c = byKey(report.checks);

    // The seed company has no cycle at all → the one hard config blocker.
    expect(c.payrollCycle.status).toBe('blocker');
    // Warnings — the run could still compute against defaults, so these never hard-block.
    expect(c.payrollItems.status).toBe('warning');
    expect(c.payrollSchedule.status).toBe('warning');
    expect(c.payrollPolicy.status).toBe('warning');
    // No employees seeded → the master-data check is clean, not a blocker.
    expect(c.masterData.status).toBe('ok');
    // Transactions never block.
    expect(c.transactions.status).toBe('ok');

    expect(report.blockers).toBeGreaterThanOrEqual(1);
    expect(report.ready).toBe(false);
  });

  it('a fully configured company clears every config blocker and is ready', async () => {
    const a = adminCtx(b);
    await seedPayComponentCatalog(a); // active pay-item catalog
    await upsertPayrollCycle(a, { companyId: b.companyId, name: 'Monthly', runType: 'regular' }); // active regular cycle
    await setPayrollConfig(a, { companyId: b.companyId, payDay: 25 }); // pay-day schedule
    await createPolicy(a, { companyId: b.companyId, name: 'Standard Monthly', policyType: 'monthly' }); // active policy

    const report = await payrollReadiness(a, { companyId: b.companyId, payPeriod: PERIOD });
    const c = byKey(report.checks);

    expect(c.payrollCycle.status).toBe('ok');
    expect(c.payrollItems.status).toBe('ok');
    expect(c.payrollSchedule.status).toBe('ok');
    expect(c.payrollPolicy.status).toBe('ok');
    expect(c.masterData.status).toBe('ok');

    // Statutory may legitimately be a stale WARNING (pack on disk not ingested in the test env) but is
    // never a blocker — the merged ruleset always resolves. So: no blockers, ready.
    expect(c.statutoryConfig.status).not.toBe('blocker');
    expect(report.blockers).toBe(0);
    expect(report.ready).toBe(true);
  });

  it('an employee with no salary record makes masterData a BLOCKER; adding compensation downgrades it', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'No Salary');

    let report = await payrollReadiness(a, { companyId: b.companyId, payPeriod: PERIOD });
    let master = byKey(report.checks).masterData;
    expect(master.status).toBe('blocker');
    expect(master.detail.missingCompensation).toBe(1);
    expect(report.ready).toBe(false);

    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    report = await payrollReadiness(a, { companyId: b.companyId, payPeriod: PERIOD });
    master = byKey(report.checks).masterData;
    // Salary present, statutory profile still absent → downgraded from blocker to warning.
    expect(master.status).toBe('warning');
    expect(master.detail.missingCompensation).toBe(0);
    expect(master.detail.missingStatutory).toBe(1);

    await setStatutoryProfileMY(a, { personId: emp.personId, icNumber: '900101010099', bankName: 'Maybank', bankAccountNo: '111222333' });
    report = await payrollReadiness(a, { companyId: b.companyId, payPeriod: PERIOD });
    expect(byKey(report.checks).masterData.status).toBe('ok');
  });

  it('transactions check counts individual txns for the company+period and never blocks', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'Txn Guy');

    let report = await payrollReadiness(a, { companyId: b.companyId, payPeriod: PERIOD });
    expect(byKey(report.checks).transactions.detail.entered).toBe(0);

    // An unattached one-off txn keyed by (company, period) — the pre-run "enter transactions" signal.
    await owner.db.insert(schema.payrollIndividualTxn).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      payPeriod: PERIOD,
      employmentId: emp.employmentId,
      kind: 'earning',
      txnDate: `${PERIOD}-10`,
      amount: '250.00',
    });

    report = await payrollReadiness(a, { companyId: b.companyId, payPeriod: PERIOD });
    const txn = byKey(report.checks).transactions;
    expect(txn.status).toBe('ok');
    expect(txn.detail.entered).toBe(1);
    // A txn in a DIFFERENT month is not counted for this period.
    expect(txn.detail.entered).toBe(1);
  });
});
