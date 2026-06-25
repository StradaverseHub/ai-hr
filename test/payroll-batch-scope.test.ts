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
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

async function emp(a: ReturnType<typeof adminCtx>, email: string, departmentId: string, ic: string, companyId?: string) {
  const e = await hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: companyId ?? b.companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  return e;
}

/** A sibling company + department in the same tenant (for the cross-company exclusion case). */
async function siblingCompany() {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Sibling Sdn Bhd' })
    .returning({ id: schema.company.id });
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c.id, name: 'Sibling Dept' })
    .returning({ id: schema.department.id });
  return { companyId: c.id, departmentId: d.id };
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

  it('(a) scopes generation to explicitly named individuals only', async () => {
    const a = adminCtx(b);
    const e1 = await emp(a, 'e1@scope.test', b.deptA, '900101010001');
    await emp(a, 'e2@scope.test', b.deptB, '900101010002');

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05', scope: { employmentIds: [e1.employmentId] } });
    await generatePayslips(a, { batchId });

    const slips = await slipsFor(batchId);
    expect(slips).toHaveLength(1);
    expect(slips[0].employmentId).toBe(e1.employmentId);
  });

  it('(b) unions a selected department with a named individual in another department', async () => {
    const a = adminCtx(b);
    const e1 = await emp(a, 'e1@scope.test', b.deptA, '900101010001'); // included via dept A
    const e2 = await emp(a, 'e2@scope.test', b.deptB, '900101010002'); // included by name
    await emp(a, 'e3@scope.test', b.deptB, '900101010003'); // in dept B but NOT named ⇒ excluded

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [b.deptA], employmentIds: [e2.employmentId] },
    });
    await generatePayslips(a, { batchId });

    const ids = (await slipsFor(batchId)).map((s) => s.employmentId).sort();
    expect(ids).toEqual([e1.employmentId, e2.employmentId].sort());
  });

  it('(c) dedupes an individual who is also in a selected department (no double payslip)', async () => {
    const a = adminCtx(b);
    const e1 = await emp(a, 'e1@scope.test', b.deptA, '900101010001');

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [b.deptA], employmentIds: [e1.employmentId] }, // same person via both paths
    });
    await generatePayslips(a, { batchId });

    const slips = await slipsFor(batchId);
    expect(slips).toHaveLength(1);
    expect(slips[0].employmentId).toBe(e1.employmentId);
  });

  it('(d) excludes a named employmentId belonging to a different company (boundary is deliberate)', async () => {
    const a = adminCtx(b);
    const e1 = await emp(a, 'e1@scope.test', b.deptA, '900101010001');
    const sib = await siblingCompany();
    const foreign = await emp(a, 'foreign@scope.test', sib.departmentId, '900101010009', sib.companyId);

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [e1.employmentId, foreign.employmentId] },
    });
    await generatePayslips(a, { batchId });

    const slips = await slipsFor(batchId);
    expect(slips).toHaveLength(1);
    expect(slips[0].employmentId).toBe(e1.employmentId);
  });

  it('(e) a named, terminated-mid-period employee still gets the prorated final payslip', async () => {
    const a = adminCtx(b);
    const e1 = await emp(a, 'e1@scope.test', b.deptA, '900101010001');
    // Terminate within the period (period = May 2026; terminatedOn >= periodStart).
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-05-15' })
      .where(eq(schema.employment.id, e1.employmentId));

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [e1.employmentId] },
    });
    await generatePayslips(a, { batchId });

    const slips = await slipsFor(batchId);
    expect(slips).toHaveLength(1);
    expect(slips[0].employmentId).toBe(e1.employmentId);
  });

  it('persists employmentIds in batch.scope AND the payroll-batch.created event payload', async () => {
    const a = adminCtx(b);
    const e1 = await emp(a, 'e1@scope.test', b.deptA, '900101010001');

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [e1.employmentId] },
    });

    // Persisted column carries the new field.
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((row.scope as { employmentIds?: string[] } | null)?.employmentIds).toEqual([e1.employmentId]);

    // Appended event payload carries the new field (audit substrate, not just the column).
    const payload = await latestEventPayload(b.tenantId, batchId, 'payroll-batch.created');
    expect((payload?.scope as { employmentIds?: string[] } | undefined)?.employmentIds).toEqual([e1.employmentId]);
  });

  it('drops empty scope arrays ⇒ whole-company default preserved', async () => {
    const a = adminCtx(b);
    await emp(a, 'e1@scope.test', b.deptA, '900101010001');
    await emp(a, 'e2@scope.test', b.deptB, '900101010002');

    // Both arrays empty (the form posts these when nothing is checked) ⇒ normalizeScope → null.
    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [], employmentIds: [] },
    });
    await generatePayslips(a, { batchId });

    expect(await slipsFor(batchId)).toHaveLength(2);
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(row.scope).toBeNull();
  });
});
