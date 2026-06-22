/**
 * ADR-0035 1E (#23) — batch subset selection. A batch carries an optional scope { departmentIds?,
 * employmentIds? }; generation narrows the active-employee set to it (departments resolve through the
 * effective-dated assignment). No scope ⇒ the whole company (unchanged).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

async function emp(a: ReturnType<typeof adminCtx>, email: string, departmentId: string, ic: string) {
  const e = await hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: b.companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  return e;
}
const slipsFor = (batchId: string) =>
  owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

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

describe('ADR-0035 1E — batch subset selection', () => {
  it('scopes generation to the selected departments', async () => {
    const a = adminCtx(b);
    const e1 = await emp(a, 'e1@scope.test', b.deptA, '900101010001');
    await emp(a, 'e2@scope.test', b.deptB, '900101010002');

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05', scope: { departmentIds: [b.deptA] } });
    await generatePayslips(a, { batchId });

    const slips = await slipsFor(batchId);
    expect(slips).toHaveLength(1);
    expect(slips[0].employmentId).toBe(e1.employmentId);
  });

  it('whole company (no scope) includes everyone', async () => {
    const a = adminCtx(b);
    await emp(a, 'e1@scope.test', b.deptA, '900101010001');
    await emp(a, 'e2@scope.test', b.deptB, '900101010002');

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    expect(await slipsFor(batchId)).toHaveLength(2);
  });
});
