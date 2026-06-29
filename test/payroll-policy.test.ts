/**
 * 2.1 Payroll Policy — a named, reusable, company-scoped pay-processing template. Monthly-only slice:
 *  - CRUD + per-company unique name (duplicate rejected within a company, allowed across companies)
 *  - activate/deactivate emits the right event types
 *  - delete blocked while assigned (PolicyInUseError), allowed after unassign
 *  - assignPolicy rejects a cross-company policy (RLS can't catch same-tenant cross-company)
 *  - resolveAssignedPolicy returns the assigned ACTIVE policy, else null (no date logic)
 *  - RLS: tenant-wide READ (kernel resolves under caller's session); admin-only WRITE
 *  - byte-identical regression: a batch for an UNASSIGNED employment is unchanged by the additive column
 *  - history preservation: a processed batch's payslip is immutable and regeneration throws BatchNotDraftError
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, BatchNotDraftError } from '../core/payroll';
import {
  assignPolicy,
  createPolicy,
  deletePolicy,
  DuplicatePolicyNameError,
  getPolicy,
  listPolicies,
  PolicyCompanyMismatchError,
  PolicyInUseError,
  resolveAssignedPolicy,
  setStatus,
  updatePolicy,
} from '../core/payroll-policy';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** A second company in the same tenant + a department, for cross-company + RLS tests. */
async function secondCompany() {
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  const [d2] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c2.id, name: 'Beta Ops' })
    .returning({ id: schema.department.id });
  return { companyId: c2.id, deptId: d2.id };
}

const hire = (name: string, companyId = b.companyId, departmentId = b.deptA) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `pp_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

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

describe('2.1 Payroll Policy — service + substrate', () => {
  it('creates, reads, and updates a monthly policy and emits events', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'Standard Monthly', description: 'Default', policyType: 'monthly' });
    const pol = await getPolicy(a, id);
    expect(pol).toMatchObject({ name: 'Standard Monthly', policyType: 'monthly', status: 'active', payRule: null });

    await updatePolicy(a, { id, name: 'Standard Monthly v2', description: 'Edited' });
    expect((await getPolicy(a, id))?.name).toBe('Standard Monthly v2');

    expect(await eventTypesFor(b.tenantId, id)).toEqual(
      expect.arrayContaining(['payroll-policy.created', 'payroll-policy.updated']),
    );
  });

  it('rejects a duplicate name within a company, allows the same name in another company', async () => {
    const a = adminCtx(b);
    await createPolicy(a, { companyId: b.companyId, name: 'Site Workers', policyType: 'monthly' });
    await expect(createPolicy(a, { companyId: b.companyId, name: 'Site Workers', policyType: 'monthly' })).rejects.toBeInstanceOf(
      DuplicatePolicyNameError,
    );
    // Same name in a different company is fine (uniqueness is per-company).
    const { companyId: c2 } = await secondCompany();
    await expect(createPolicy(a, { companyId: c2, name: 'Site Workers', policyType: 'monthly' })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it('activate/deactivate flips status and emits the right event types', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'Togglable', policyType: 'monthly' });
    await setStatus(a, { id, status: 'inactive' });
    expect((await getPolicy(a, id))?.status).toBe('inactive');
    await setStatus(a, { id, status: 'active' });
    expect((await getPolicy(a, id))?.status).toBe('active');
    expect(await eventTypesFor(b.tenantId, id)).toEqual(
      expect.arrayContaining(['payroll-policy.deactivated', 'payroll-policy.activated']),
    );
  });

  it('blocks deleting an assigned policy (PolicyInUseError), allows it after unassign', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'Assigned', policyType: 'monthly' });
    const e = await hire('Worker');
    await assignPolicy(a, { employmentId: e.employmentId, policyId: id });
    await expect(deletePolicy(a, { id })).rejects.toBeInstanceOf(PolicyInUseError);
    // Unassign, then delete succeeds + emits the deleted event.
    await assignPolicy(a, { employmentId: e.employmentId, policyId: null });
    await expect(deletePolicy(a, { id })).resolves.toMatchObject({ id });
    expect(await eventTypesFor(b.tenantId, id)).toEqual(expect.arrayContaining(['payroll-policy.deleted']));
  });

  it('assignPolicy rejects a cross-company policy (same tenant — RLS cannot catch this)', async () => {
    const a = adminCtx(b);
    const { companyId: c2 } = await secondCompany();
    const { id: polB } = await createPolicy(a, { companyId: c2, name: 'Beta Monthly', policyType: 'monthly' });
    const e = await hire('AlphaWorker'); // employment in company A
    await expect(assignPolicy(a, { employmentId: e.employmentId, policyId: polB })).rejects.toBeInstanceOf(
      PolicyCompanyMismatchError,
    );
    // The employment is still unassigned (no partial write).
    const [emp] = await owner.db
      .select({ p: schema.employment.payrollPolicyId })
      .from(schema.employment)
      .where(eq(schema.employment.id, e.employmentId));
    expect(emp.p).toBeNull();
    // And an assignment emits the assigned event when valid.
    const { id: polA } = await createPolicy(a, { companyId: b.companyId, name: 'Alpha Monthly', policyType: 'monthly' });
    await assignPolicy(a, { employmentId: e.employmentId, policyId: polA });
    expect(await eventTypesFor(b.tenantId, e.employmentId)).toEqual(
      expect.arrayContaining(['employment.payroll-policy.assigned']),
    );
  });

  it('resolveAssignedPolicy returns the assigned active policy, else null (inactive/unassigned)', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'Resolvable', policyType: 'monthly' });
    const e = await hire('Resolver');

    // Unassigned → null (monthly default).
    expect(await withTenant(a, (tx) => resolveAssignedPolicy(tx, e.employmentId))).toBeNull();

    // Assigned + active → the policy.
    await assignPolicy(a, { employmentId: e.employmentId, policyId: id });
    const resolved = await withTenant(a, (tx) => resolveAssignedPolicy(tx, e.employmentId));
    expect(resolved?.id).toBe(id);

    // Assigned but inactive → null (falls back to monthly default).
    await setStatus(a, { id, status: 'inactive' });
    expect(await withTenant(a, (tx) => resolveAssignedPolicy(tx, e.employmentId))).toBeNull();
  });
});

describe('2.1 Payroll Policy — RLS', () => {
  it('tenant-wide READ but admin-only WRITE (non-admin / cross-company)', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'RlsPolicy', policyType: 'monthly' });

    // A non-admin employee in the tenant CAN read the policy (the kernel resolves it under the caller's
    // session — that is why reads are tenant-wide).
    const e = await hire('NonAdmin');
    const uE = await createAppUser(b.tenantId, e.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uE, roles: ['employee'] };
    const seen = await withTenant(empCtx, (tx) =>
      tx.select().from(schema.payrollPolicy).where(eq(schema.payrollPolicy.id, id)),
    );
    expect(seen.length).toBe(1);

    // But the non-admin CANNOT write (RLS WITH CHECK = is_admin_for).
    await expect(
      withTenant(empCtx, (tx) =>
        tx.insert(schema.payrollPolicy).values({
          tenantId: b.tenantId,
          companyId: b.companyId,
          name: 'Sneaky',
          policyType: 'monthly',
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(empCtx, (tx) =>
        tx.update(schema.payrollPolicy).set({ name: 'Hacked' }).where(eq(schema.payrollPolicy.id, id)),
      ),
    ).rejects.toThrow();

    // A company-scoped admin for ANOTHER company cannot write company A's policy.
    const { companyId: c2 } = await secondCompany();
    const otherAdmin: SessionContext = { tenantId: b.tenantId, userId: 'x', grants: [{ role: 'hr_admin', companyId: c2 }] };
    await expect(
      withTenant(otherAdmin, (tx) =>
        tx.update(schema.payrollPolicy).set({ name: 'CrossCo' }).where(eq(schema.payrollPolicy.id, id)),
      ),
    ).rejects.toThrow();

    // The policy is unchanged (no write slipped through RLS).
    const [row] = await owner.db.select().from(schema.payrollPolicy).where(eq(schema.payrollPolicy.id, id));
    expect(row.name).toBe('RlsPolicy');
  });

  it('a different tenant cannot see the policy (tenant isolation)', async () => {
    const a = adminCtx(b);
    await createPolicy(a, { companyId: b.companyId, name: 'Iso', policyType: 'monthly' });
    const other = await seedBase();
    const rows = await withTenant(adminCtx(other), (tx) => tx.select().from(schema.payrollPolicy));
    expect(rows.length).toBe(0);
  });
});

describe('2.1 Payroll Policy — kernel non-perturbation + history', () => {
  const payslipOf = async (batchId: string, employmentId?: string) => {
    const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    return employmentId ? rows.find((r) => r.employmentId === employmentId)! : rows[0];
  };
  const COLS = ['basicSalary', 'allowance', 'overtimePay', 'bonus', 'daysWorked', 'grossPay', 'totalDeductions', 'netPay', 'employerCost'] as const;
  const snap = (ps: Record<string, unknown>) => ({
    cols: Object.fromEntries(COLS.map((c) => [c, ps[c]])),
    statutory: ps.statutory,
  });

  // A unique 12-digit IC per call (the IC column is tenant-unique). 900101 + 6-digit sequence.
  let icSeq = 0;
  const nextIc = () => `900101${String(110000 + icSeq++).padStart(6, '0')}`;
  async function seedPayable(name: string) {
    const a = adminCtx(b);
    const e = await hire(name);
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 500, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
    return e;
  }

  it('byte-identical: a Monthly policy + assignment produces the same payslip as an unassigned employee', async () => {
    const a = adminCtx(b);
    // Two identical employees in ONE batch; one gets a Monthly policy assigned, the other stays unassigned
    // (monthly default). A batch is per-company-per-period, so both must share the same batch.
    const eUnassigned = await seedPayable('Unassigned');
    const eAssigned = await seedPayable('Assigned');
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'PlainMonthly', policyType: 'monthly' });
    await assignPolicy(a, { employmentId: eAssigned.employmentId, policyId: id });

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [eUnassigned.employmentId, eAssigned.employmentId] },
    });
    await generatePayslips(a, { batchId });

    const unassigned = snap(await payslipOf(batchId, eUnassigned.employmentId));
    const assigned = snap(await payslipOf(batchId, eAssigned.employmentId));

    // The Monthly policy (null pay_rule) changes nothing — the additive column + null→monthly default is inert.
    expect(assigned.cols).toEqual(unassigned.cols);
    expect(assigned.statutory).toEqual(unassigned.statutory);
    // Sanity: this scenario actually produced non-trivial figures (basic 5000 + allowance 500 = 5500 gross).
    expect(Number((unassigned.cols as Record<string, string>).grossPay)).toBeCloseTo(5500, 2);
  });

  it('history preservation: a processed batch is immutable and cannot be regenerated after a policy edit', async () => {
    const a = adminCtx(b);
    const e = await seedPayable('Historic');
    const { id } = await createPolicy(a, { companyId: b.companyId, name: 'HistMonthly', policyType: 'monthly' });
    await assignPolicy(a, { employmentId: e.employmentId, policyId: id });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05', scope: { employmentIds: [e.employmentId] } });
    await generatePayslips(a, { batchId }); // batch is now 'processed'
    const before = snap(await payslipOf(batchId));

    // Edit + deactivate the policy AFTER the batch is processed.
    await updatePolicy(a, { id, name: 'HistMonthly EDITED' });
    await setStatus(a, { id, status: 'inactive' });

    // The processed batch's payslip is unchanged …
    const after = snap(await payslipOf(batchId));
    expect(after).toEqual(before);
    // … and a processed batch cannot be regenerated at all (the real history guard — not effective-date logic).
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(BatchNotDraftError);
  });
});
