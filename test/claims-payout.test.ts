/**
 * Claim payout (ADR-0021 §3, Slice 5) — the two routes a confirmed-taxable flag chooses between:
 *   • taxable     → prefilled onto a draft payroll batch, rides the taxable allowance base
 *                   (PCB/EPF/SOCSO/EIS), marked paid when the batch processes.
 *   • non-taxable → off-cycle reimbursement: list due, export bank CSV, mark paid.
 * Plus the equivalence guarantee: no prefilled claims ⇒ payroll is unperturbed.
 *
 * ADR-0077 slice 3 — WHY THIS FILE DRIVES `entitledCtx`, NOT `adminCtx`.
 * This file writes no feature-gate env var and never did. It broke anyway, because the payslip
 * assertions below are only true on the LEGACY earnings path, and which path `generatePayslips` takes
 * is now decided by `isModuleEnabled(ctx, 'typed_pay_components')` instead of
 * `process.env.TYPED_PAY_COMPONENTS_ENABLED`. Those two do NOT agree for the fixture admin context:
 * test/env.ts deletes the env var (so the old read was false), while `adminCtx` carries
 * `entitlementsExempt: 'harness'` and an exempt context answers TRUE for every catalogued module — so
 * `adminCtx` silently switches the typed-component path ON, and the typed fold reads neither
 * `compensation.monthly_allowance` nor `payroll_input.claim_allowance` (core/payroll.ts `earningsOf`),
 * making the allowance/gross/EPF figures 0 / basic-only.
 *
 * The tenant's DATA says the opposite and is what these tests mean: `seedBase` seeds no
 * `tenant_module` row for `typed_pay_components` (LEGACY_MODULE_ENV_GATES gates it on the same env var
 * test/env.ts deletes), and a missing row is disabled (C7). `entitledCtx` resolves a REAL snapshot from
 * those rows, so the legacy path is exercised exactly as before and every assertion below is unchanged.
 * `claims` and `payroll` are both seeded active, so nothing else in this flow closes.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  createClaimType,
  decideClaim,
  listReimbursementsDue,
  markReimbursementsPaid,
  prefillClaimsForBatch,
  reimbursementCsv,
  submitClaim,
} from '../core/claims';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { closeAll, entitledCtx, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

// An incurred date inside the 45-day receipt window (submitClaim now rejects older expense dates). These
// payout tests only care about the routing of an approved claim, not the specific expense date.
const recent = (daysBack = 5): string =>
  new Date(new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime() - daysBack * 86400000).toISOString().slice(0, 10);

const payslipFor = async (batchId: string) => {
  const [ps] = await owner.db
    .select()
    .from(schema.payslip)
    .where(eq(schema.payslip.batchId, batchId));
  return ps;
};

const claimAllowanceInput = async (batchId: string) => {
  const [row] = await owner.db
    .select({ claimAllowance: schema.payrollInput.claimAllowance })
    .from(schema.payrollInput)
    .where(eq(schema.payrollInput.batchId, batchId));
  return row ? Number(row.claimAllowance) : null;
};

describe('ADR-0021 — claim payout', () => {
  let base: Base;
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

  it('equivalence: no prefilled claims ⇒ payroll is unperturbed', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'NoClaim');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
    // A taxable claim exists and is even approved — but is NEVER prefilled onto the batch.
    const { id: typeId } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: true, requiresReceipt: false });
    const { id } = await submitClaim(a, { employmentId: e.employmentId, claimTypeId: typeId, amount: 300, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: id, decision: 'approve' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    // Allowance line == fixed monthly allowance only; gross == basic + allowance. The approved claim
    // is invisible to payroll until it is explicitly prefilled.
    expect(Number(ps.allowance)).toBeCloseTo(500, 2);
    expect(Number(ps.grossPay)).toBeCloseTo(4500, 2);
    // EPF base = wages (4500) → ceil(4500 * 0.11) = 495.
    expect((ps.statutory as Record<string, number>).epfEmployee).toBe(495);
    // The claim stayed approved — it was not silently paid.
    const [claim] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    expect(claim.status).toBe('approved');
  });

  it('prefills an approved taxable claim onto the batch → taxable allowance base + marked paid', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'Taxable');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    const { id: typeId } = await createClaimType(a, { code: 'PHONE', name: 'Phone allowance', defaultTaxable: true, requiresReceipt: false });
    const { id } = await submitClaim(a, { employmentId: e.employmentId, claimTypeId: typeId, amount: 300, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: id, decision: 'approve' }); // taxable defaulted true

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const res = await prefillClaimsForBatch(a, { batchId });
    expect(res).toMatchObject({ applied: 1, claims: 1, total: 300 });
    expect(await claimAllowanceInput(batchId)).toBeCloseTo(300, 2);

    // Claim reserved to the batch + audit event.
    const [linked] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    expect(linked.payrollBatchId).toBe(batchId);
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-request.queued-for-payroll');

    await generatePayslips(a, { batchId });
    const ps = await payslipFor(batchId);
    // The claim rides the taxable allowance line: gross = basic 4000 + claim 300 = 4300.
    expect(Number(ps.allowance)).toBeCloseTo(300, 2);
    expect(Number(ps.grossPay)).toBeCloseTo(4300, 2);
    // EPF base now 4300 → ceil(4300 * 0.11) = 473 (proves the claim is in the statutory base).
    expect((ps.statutory as Record<string, number>).epfEmployee).toBe(473);

    // Processing the batch marks the claim paid (off the approved→paid edge) with an event.
    const [paid] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).not.toBeNull();
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-request.paid');
  });

  it('prefill is idempotent and ignores non-taxable claims', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'Mixed');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    const { id: taxableType } = await createClaimType(a, { code: 'PHONE', name: 'Phone', defaultTaxable: true, requiresReceipt: false });
    const { id: nonTaxableType } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    const { id: tx } = await submitClaim(a, { employmentId: e.employmentId, claimTypeId: taxableType, amount: 200, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: tx, decision: 'approve' });
    const { id: nt } = await submitClaim(a, { employmentId: e.employmentId, claimTypeId: nonTaxableType, amount: 999, incurredOn: recent(4) });
    await decideClaim(a, { claimRequestId: nt, decision: 'approve' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const first = await prefillClaimsForBatch(a, { batchId });
    expect(first).toMatchObject({ claims: 1, total: 200 }); // only the taxable one
    const second = await prefillClaimsForBatch(a, { batchId });
    expect(second).toMatchObject({ applied: 0, claims: 0, total: 0 }); // already linked
    expect(await claimAllowanceInput(batchId)).toBeCloseTo(200, 2); // not doubled
  });

  it('lists, exports and pays non-taxable reimbursements', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'Reimburse');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await owner.db.insert(schema.employeeStatutoryMy).values({
      tenantId: base.tenantId,
      personId: e.personId,
      icNumber: '900101-01-0001',
      bankName: 'Maybank',
      bankAccountNo: '5140-1234-5678',
    });
    const { id: typeId } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    const { id } = await submitClaim(a, { employmentId: e.employmentId, claimTypeId: typeId, amount: 125.5, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: id, decision: 'approve' }); // non-taxable

    const due = await listReimbursementsDue(a);
    expect(due.map((r) => r.id)).toContain(id);
    const row = due.find((r) => r.id === id)!;
    expect(row.amount).toBeCloseTo(125.5, 2);
    expect(row.bankName).toBe('Maybank');

    const csv = await reimbursementCsv(a);
    expect(csv.payeeCount).toBe(1);
    expect(csv.total).toBeCloseTo(125.5, 2);
    expect(csv.missingBank).toBe(0);
    expect(csv.content).toContain('Reimburse');
    expect(csv.content).toContain('125.50');

    const { paid } = await markReimbursementsPaid(a, { claimIds: [id], payoutRef: 'IBG 2026-06-20' });
    expect(paid).toBe(1);
    const [after] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    expect(after.status).toBe('paid');
    expect(after.payoutRef).toBe('IBG 2026-06-20');
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-request.paid');
    // No longer due once paid.
    expect((await listReimbursementsDue(a)).map((r) => r.id)).not.toContain(id);
  });

  it('markReimbursementsPaid ignores taxable claims (payroll-routed)', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'WrongRoute');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    const { id: typeId } = await createClaimType(a, { code: 'PHONE', name: 'Phone', defaultTaxable: true, requiresReceipt: false });
    const { id } = await submitClaim(a, { employmentId: e.employmentId, claimTypeId: typeId, amount: 100, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: id, decision: 'approve' }); // taxable

    const { paid } = await markReimbursementsPaid(a, { claimIds: [id], payoutRef: 'x' });
    expect(paid).toBe(0); // taxable claims are not reimbursable
    const [claim] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    expect(claim.status).toBe('approved');
  });
});
