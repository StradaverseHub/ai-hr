/**
 * My Payroll — Self Personal Tax Relief (LHDN TP1). `myTaxRelief` (core/read.ts) is a read-only self-view
 * that sources the relief ACTUALLY APPLIED to a payslip from `payslip.statutory.lp` — NOT the raw
 * `payroll_input.tp1Deduction` input. These tests pin the edges the implementation rests on:
 *   • RLS isolation — A sees A's TP1, B sees nothing of A's (via the payslip RLS self-branch).
 *   • Draft-batch exclusion — a TP1 keyed into payroll_input with no generated payslip never surfaces.
 *   • Applied-figure correctness — the returned tp1 equals payslip.statutory.lp, including when the
 *     applied figure was clamped to differ from the raw input (a regression to raw input fails loudly).
 *   • Leaver visibility — a terminated employment's TP1 history still appears (they need it to file taxes).
 *   • Year scoping — the YTD/subtotal is scoped to the requested assessment year, not blended.
 *   • Type coercion — the YTD is a number (numeric(12,2) inside JSONB arrives as a string).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { myTaxRelief, myTaxReliefEmploymentIds } from '../core/read';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let base: Base;

async function hire(name: string, ic: string, companyId = base.companyId, departmentId = base.deptA) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2024-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  return e;
}

/** Run a full regular batch with a TP1 input for one employee; returns the generated batch id. */
async function runBatchWithTp1(employmentId: string, payPeriod: string, tp1: number, companyId = base.companyId) {
  const a = adminCtx(base);
  const { batchId } = await createBatch(a, { companyId, payPeriod });
  await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 0, tp1Deduction: tp1 });
  await generatePayslips(a, { batchId });
  return batchId;
}

const selfCtx = (userId: string, personId: string): SessionContext => ({
  tenantId: base.tenantId,
  userId,
  roles: ['employee'],
  personId,
});

describe('My Payroll — Self TP1 (myTaxRelief)', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('RLS isolation: A sees A’s TP1; B (different company) sees nothing of A’s', async () => {
    const eA = await hire('Aisyah', '900101010001');
    // Second company (with its own department) + employee B, isolated from A.
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Bravo Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [d2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: c2.id, name: 'Ops' })
      .returning({ id: schema.department.id });
    const eB = await hire('Bala', '900202020002', c2.id, d2.id);

    await runBatchWithTp1(eA.employmentId, '2026-03', 250);

    const uA = await createAppUser(base.tenantId, eA.personId, 'employee');
    const uB = await createAppUser(base.tenantId, eB.personId, 'employee');
    const ctxA = selfCtx(uA, eA.personId);
    const ctxB = selfCtx(uB, eB.personId);

    const idsA = await myTaxReliefEmploymentIds(ctxA);
    const idsB = await myTaxReliefEmploymentIds(ctxB);

    const resA = await myTaxRelief(ctxA, idsA, 2026);
    expect(resA.rows).toHaveLength(1);
    expect(resA.rows[0].tp1).toBe(250);
    expect(resA.ytd).toBe(250);

    // B, asked for B's own ids, has no TP1 at all.
    const resBOwn = await myTaxRelief(ctxB, idsB, 2026);
    expect(resBOwn.rows).toHaveLength(0);

    // And even if B somehow passed A's employment ids, payslip RLS returns zero rows for B.
    const resBSpoof = await myTaxRelief(ctxB, idsA, 2026);
    expect(resBSpoof.rows).toHaveLength(0);
    expect(resBSpoof.ytd).toBe(0);
  });

  it('draft-batch exclusion: a TP1 keyed into payroll_input with no generated payslip is EXCLUDED', async () => {
    const e = await hire('Chong', '900303030003');
    const a = adminCtx(base);
    // Create a DRAFT batch with a TP1 input but do NOT generate payslips.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 0, tp1Deduction: 999 });

    // Sanity: the raw input exists…
    const inputs = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(eq(schema.payrollInput.batchId, batchId));
    expect(inputs).toHaveLength(1);
    expect(Number(inputs[0].tp1Deduction)).toBe(999);
    // …but no payslip was generated.
    const slips = await owner.db
      .select()
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batchId));
    expect(slips).toHaveLength(0);

    const u = await createAppUser(base.tenantId, e.personId, 'employee');
    const ctx = selfCtx(u, e.personId);
    const ids = await myTaxReliefEmploymentIds(ctx);
    const res = await myTaxRelief(ctx, ids, 2026);
    // The pre-clamp input must NOT surface — we read applied lp from the payslip, which does not exist.
    expect(res.rows).toHaveLength(0);
    expect(res.ytd).toBe(0);
  });

  it('applied-figure correctness: returns payslip.statutory.lp even when it differs from the raw input', async () => {
    const e = await hire('Devi', '900404040004');
    // Generate with a raw input of 600…
    const batchId = await runBatchWithTp1(e.employmentId, '2026-05', 600);
    const [slip] = await owner.db
      .select({ id: schema.payslip.id, statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batchId));
    expect(Number((slip.statutory as { lp?: unknown }).lp)).toBe(600);

    // …then simulate a clamp: the APPLIED relief on the payslip is 400, diverging from the 600 input.
    const clamped = { ...(slip.statutory as Record<string, unknown>), lp: 400 };
    await owner.db
      .update(schema.payslip)
      .set({ statutory: clamped })
      .where(eq(schema.payslip.id, slip.id));

    const u = await createAppUser(base.tenantId, e.personId, 'employee');
    const ctx = selfCtx(u, e.personId);
    const ids = await myTaxReliefEmploymentIds(ctx);
    const res = await myTaxRelief(ctx, ids, 2026);
    expect(res.rows).toHaveLength(1);
    // The read must reflect the APPLIED figure (400), not the raw input (600).
    expect(res.rows[0].tp1).toBe(400);
    expect(res.ytd).toBe(400);
  });

  it('leaver visibility: a terminated employment’s TP1 history still appears', async () => {
    const e = await hire('Eng', '900505050005');
    await runBatchWithTp1(e.employmentId, '2026-02', 150);
    // Terminate the employment AFTER the payslip was generated.
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-03-31' })
      .where(eq(schema.employment.id, e.employmentId));

    const u = await createAppUser(base.tenantId, e.personId, 'employee');
    const ctx = selfCtx(u, e.personId);
    // The leaver-safe resolver must NOT filter out terminated employments.
    const ids = await myTaxReliefEmploymentIds(ctx);
    expect(ids).toContain(e.employmentId);

    const res = await myTaxRelief(ctx, ids, 2026);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].tp1).toBe(150);
  });

  it('year scoping: YTD is scoped to the requested assessment year, not blended across years', async () => {
    const e = await hire('Farah', '900606060006');
    await runBatchWithTp1(e.employmentId, '2025-11', 300); // prior year
    await runBatchWithTp1(e.employmentId, '2026-01', 200); // requested year
    await runBatchWithTp1(e.employmentId, '2026-07', 100); // requested year

    const u = await createAppUser(base.tenantId, e.personId, 'employee');
    const ctx = selfCtx(u, e.personId);
    const ids = await myTaxReliefEmploymentIds(ctx);

    const res2026 = await myTaxRelief(ctx, ids, 2026);
    expect(res2026.year).toBe(2026);
    expect(res2026.rows).toHaveLength(2); // only the two 2026 rows
    expect(res2026.rows.every((r) => r.payPeriod.startsWith('2026'))).toBe(true);
    expect(res2026.ytd).toBe(300); // 200 + 100, NOT 600 (would include 2025)

    const res2025 = await myTaxRelief(ctx, ids, 2025);
    expect(res2025.rows).toHaveLength(1);
    expect(res2025.ytd).toBe(300);
  });

  it('type coercion: the YTD is a number and arithmetic is exact across rows', async () => {
    const e = await hire('Gopal', '900707070007');
    await runBatchWithTp1(e.employmentId, '2026-01', 123.45);
    await runBatchWithTp1(e.employmentId, '2026-02', 76.55);

    const u = await createAppUser(base.tenantId, e.personId, 'employee');
    const ctx = selfCtx(u, e.personId);
    const ids = await myTaxReliefEmploymentIds(ctx);
    const res = await myTaxRelief(ctx, ids, 2026);

    expect(typeof res.ytd).toBe('number');
    // 123.45 + 76.55 = 200.00 — a string concat would yield "0123.4576.55" / NaN, never 200.
    expect(res.ytd).toBe(200);
    expect(res.rows.every((r) => typeof r.tp1 === 'number')).toBe(true);
  });

  it('empty when the principal has no person link', async () => {
    const ctx: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'], personId: null };
    const ids = await myTaxReliefEmploymentIds(ctx);
    expect(ids).toEqual([]);
    const res = await myTaxRelief(ctx, ids, 2026);
    expect(res.rows).toHaveLength(0);
    expect(res.ytd).toBe(0);
  });
});
