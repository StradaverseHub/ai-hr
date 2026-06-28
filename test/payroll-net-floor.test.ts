/**
 * Audit M#16 — EA s.24 net-floor on post-tax deductions.
 *
 * `generatePayslips` clamps the loan to yield to other deductions, but the manual deduction + CP38
 * (`slipExtraDeduct`) were never headroom-checked — a large CP38 garnishment (or CP38 + a manual deduction)
 * on a low salary could still drive `net = grossPay − totalDeductions` below zero, corrupting batch totals
 * and the bank file.
 *
 * Statutory: EA 1955 s.24(1)/(8) — non-statutory deductions ≤ 50% of wages; CP38 is a court/LHDN order
 * exempt from the private 50% cap but must still never produce a negative net.
 *
 * Fix: clamp every post-tax deduction in priority order (manual deduct → CP38 → loan) so net ≥ 0 by
 * construction, and emit a clamp warning event whenever a deduction is reduced. The no-extra-deduction path
 * must stay byte-identical.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCp38 } from '../core/cp38';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
} from '../core/pay-components';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

const payslipOf = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
};

const clampEvents = async (tenantId: string, batchId: string) => {
  const rows = await owner.db
    .select({ eventType: schema.domainEvent.eventType, payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.aggregateId, batchId));
  return rows.filter((r) => r.eventType.includes('clamp'));
};

let icSeq = 0;
const nextIc = () => `9001010${String(10000 + icSeq++).slice(-5)}`;
const hire = async (b: Base, name: string, basic: number) => {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
};

async function codeId(ctx: SessionContext, code: string): Promise<string> {
  const cat = await listPayComponents(ctx);
  return cat.find((c) => c.code === code)!.id;
}

describe('M#16 — EA s.24 net-floor on post-tax deductions', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterEach(() => {
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterAll(async () => {
    await closeAll();
  });

  it('basic 3000 + CP38 2500 + manual deduction: persisted net >= 0 and a clamp warning is recorded', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(base, 'Floored', 3000);
    const basicId = await codeId(a, 'BASIC');
    const deductId = await codeId(a, 'DEDUCTION');
    // BASIC 3000 + a 600 manual deduction; CP38 2500. Untreated: net = 3000 − statutory − (600 + 2500) < 0.
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 3000, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: deductId, amount: 600, effectiveFrom: '2026-01-01' });
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/FLOOR', amount: 2500, validFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await generatePayslips(a, { batchId });
    const ps = await payslipOf(batchId);

    // The REQUIREMENT: a payslip never persists a negative net from CP38 + a manual deduction.
    expect(Number(ps.netPay)).toBeGreaterThanOrEqual(0);
    // total deductions and otherDeductions reconcile to a non-negative net.
    expect(Number(ps.grossPay) - Number(ps.totalDeductions)).toBeGreaterThanOrEqual(0);
    expect(Number(ps.netPay)).toBeCloseTo(Number(ps.grossPay) - Number(ps.totalDeductions), 2);

    // A clamp warning event was emitted (the deduction could not be fully recovered).
    const clamps = await clampEvents(base.tenantId, batchId);
    expect(clamps.length).toBeGreaterThanOrEqual(1);
  });

  it('no-extra-deduction golden: a plain low-salary payslip is byte-identical (net = gross − statutory) and emits NO clamp event', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'Plain', 3000);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    // No CP38, no loan, no manual deduction (un-gated path).
    await generatePayslips(a, { batchId });
    const ps = await payslipOf(batchId);

    const st = ps.statutory as Record<string, number>;
    const statDed = st.epfEmployee + st.socsoEmployee + (st.socsoSkbbk ?? 0) + st.eisEmployee + st.pcb;
    expect(Number(ps.otherDeductions)).toBeCloseTo(0, 2);
    expect(Number(ps.totalDeductions)).toBeCloseTo(statDed, 2);
    expect(Number(ps.netPay)).toBeCloseTo(3000 - statDed, 2);

    // No deduction was clamped ⇒ no clamp event.
    const clamps = await clampEvents(base.tenantId, batchId);
    expect(clamps.length).toBe(0);
    void e;
  });
});
