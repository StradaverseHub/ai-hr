/**
 * Zakat transaction history (feedback d435673e) — the two read-only lists that back the Zakat screen's
 * Transaction History block, plus the CSV export egress event. Pinned properties:
 *   • listZakatElections   — every ACTIVE employee with a zakat setup on file. Switching zakat OFF nulls
 *     the setup (kernel rule), so the row drops out; legacy inactive-with-method rows stay visible via the
 *     `method IS NOT NULL OR active` safety net. Scope-fenced; empty scope fails CLOSED.
 *   • listZakatTxnsAcross  — the zakat ACTUALLY deducted in each processed run (fixed-election OR manual
 *     batch-grid origin); a zero-zakat employee is excluded; year/month/employee filters narrow; scope-fenced.
 *   • exportZakatTxnsCsv   — returns CSV bytes (header + row) and appends exactly ONE zakat.history.exported
 *     DomainEvent carrying the actor + rowCount (Layer-0: no cleartext amount in the payload).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips, setPayrollDeductionInput } from '../core/payroll';
import { exportZakatTxnsCsv, listZakatElections, listZakatTxnsAcross } from '../core/payroll-view';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

async function seedCompanyB(b: Base): Promise<{ companyId: string; deptId: string }> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c.id, name: 'Ops B' })
    .returning({ id: schema.department.id });
  return { companyId: c.id, deptId: d.id };
}

const hire = (ctx: SessionContext, companyId: string, departmentId: string, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

/** Hire + compensation + MY statutory profile so generatePayslips can run and a zakat election can attach. */
async function hirePayrollReady(
  a: SessionContext,
  companyId: string,
  deptId: string,
  name: string,
  ic: string,
): Promise<{ employmentId: string; personId: string }> {
  const e = await hire(a, companyId, deptId, name);
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  return { employmentId: e.employmentId, personId: e.personId };
}

/** Attach a FIXED zakat election of `amount` RM to an existing MY statutory profile (read-modify-write). */
async function setFixedZakat(a: SessionContext, personId: string, amount: number) {
  const [cur] = await owner.db
    .select()
    .from(schema.employeeStatutoryMy)
    .where(eq(schema.employeeStatutoryMy.personId, personId));
  await setStatutoryProfileMY(a, {
    personId,
    icNumber: cur.icNumber ?? '',
    zakatActive: true,
    zakatMethod: 'fixed',
    zakatFixed: amount,
    zakatState: 'Selangor',
  });
}

describe('zakat transaction history (d435673e) — read-only lists + export event', () => {
  let base: Base;
  let companyB: { companyId: string; deptId: string };
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    companyB = await seedCompanyB(base);
  });
  afterAll(async () => {
    await closeAll();
  });

  // ───────────────────── listZakatElections ─────────────────────

  it('elections: returns saved setups; switch-off clears the setup (kernel nulls it); legacy inactive-with-method rows stay visible', async () => {
    const a = adminCtx(base);
    const active = await hirePayrollReady(a, base.companyId, base.deptA, 'Active Zakat', '900101011234');
    const off = await hirePayrollReady(a, base.companyId, base.deptA, 'Off Zakat', '900202021235');
    const legacy = await hirePayrollReady(a, base.companyId, base.deptA, 'Legacy Zakat', '900404041237');
    // No election at all — must NOT appear.
    await hirePayrollReady(a, base.companyId, base.deptA, 'No Zakat', '900303031236');

    await setFixedZakat(a, active.personId, 100);
    // Switched OFF through the kernel: resolveZakatElection NULLS every zakat field when zakatActive=false
    // ("no election regardless of stray values"), so the row drops OUT of the current-setup list. The audit
    // history of the save lives in the domain-event log; past deductions stay in listZakatTxnsAcross.
    await setFixedZakat(a, off.personId, 50);
    const [offCur] = await owner.db
      .select()
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, off.personId));
    await setStatutoryProfileMY(a, { personId: off.personId, icNumber: offCur.icNumber ?? '', zakatActive: false });
    // Legacy edge: an inactive row that STILL carries a method (predates the kernel's null-on-off rule, or
    // was written outside the app) remains visible via the `method IS NOT NULL OR active` safety net.
    await owner.db
      .update(schema.employeeStatutoryMy)
      .set({ zakatActive: false, zakatMethod: 'fixed', zakatFixed: '25.00' })
      .where(eq(schema.employeeStatutoryMy.personId, legacy.personId));

    const rows = await listZakatElections(a, { companyIds: [base.companyId] });
    expect(new Set(rows.map((r) => r.employmentId))).toEqual(
      new Set([active.employmentId, legacy.employmentId]),
    );
    const activeRow = rows.find((r) => r.employmentId === active.employmentId)!;
    expect(activeRow).toMatchObject({ employeeName: 'Active Zakat', zakatActive: true, zakatMethod: 'fixed' });
    expect(Number(activeRow.zakatFixed)).toBeCloseTo(100, 2);
    expect(rows.find((r) => r.employmentId === legacy.employmentId)!.zakatActive).toBe(false);
  });

  it('elections: scope fencing excludes the other company; empty scope fails closed', async () => {
    const a = adminCtx(base);
    const eA = await hirePayrollReady(a, base.companyId, base.deptA, 'Elec A', '900101011234');
    const eB = await hirePayrollReady(a, companyB.companyId, companyB.deptId, 'Elec B', '900202021235');
    await setFixedZakat(a, eA.personId, 30);
    await setFixedZakat(a, eB.personId, 40);

    expect((await listZakatElections(a, { companyIds: [base.companyId] })).map((r) => r.company)).toEqual([
      'Acme Sdn Bhd',
    ]);
    expect(await listZakatElections(a, { companyIds: [] })).toEqual([]);
  });

  // ───────────────────── listZakatTxnsAcross ─────────────────────

  it('applied: a fixed-election AND a manual batch-grid zakat both surface after generation; zero-zakat excluded', async () => {
    const a = adminCtx(base);
    const fixed = await hirePayrollReady(a, base.companyId, base.deptA, 'Fixed Z', '900101011234');
    const manual = await hirePayrollReady(a, base.companyId, base.deptA, 'Manual Z', '900202021235');
    // Third employee: no zakat at all → excluded by construction.
    await hirePayrollReady(a, base.companyId, base.deptA, 'Zero Z', '900303031236');

    await setFixedZakat(a, fixed.personId, 100); // auto-applied by the kernel on the regular run
    const bMay = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    // Manual batch-grid zakat (the surviving manual tier) — set BEFORE generation so it wins.
    await setPayrollDeductionInput(a, { batchId: bMay.batchId, employmentId: manual.employmentId, zakat: 75 });
    await generatePayslips(a, { batchId: bMay.batchId });

    const rows = await listZakatTxnsAcross(a, { companyIds: [base.companyId] });
    expect(new Set(rows.map((r) => r.employmentId))).toEqual(new Set([fixed.employmentId, manual.employmentId]));
    const fx = rows.find((r) => r.employmentId === fixed.employmentId)!;
    expect(fx).toMatchObject({ payPeriod: '2026-05', runType: 'regular', batchStatus: 'processed' });
    expect(Number(fx.zakat)).toBeCloseTo(100, 2);
    expect(Number(rows.find((r) => r.employmentId === manual.employmentId)!.zakat)).toBeCloseTo(75, 2);
    // Created date-time is stamped from the payslip row.
    expect(fx.createdOn).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('applied: year/month + employee filters narrow; scope fencing + empty scope fails closed', async () => {
    const a = adminCtx(base);
    const eA = await hirePayrollReady(a, base.companyId, base.deptA, 'Appl A', '900101011234');
    const eB = await hirePayrollReady(a, companyB.companyId, companyB.deptId, 'Appl B', '900202021235');
    await setFixedZakat(a, eA.personId, 100);
    await setFixedZakat(a, eB.personId, 200);
    const bMayA = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const bJunB = await createBatch(a, { companyId: companyB.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: bMayA.batchId });
    await generatePayslips(a, { batchId: bJunB.batchId });
    const companyIds = [base.companyId, companyB.companyId];

    expect(await listZakatTxnsAcross(a, { companyIds })).toHaveLength(2);
    // Period narrows.
    expect((await listZakatTxnsAcross(a, { companyIds, year: 2026, month: 5 })).map((r) => r.payPeriod)).toEqual([
      '2026-05',
    ]);
    expect(await listZakatTxnsAcross(a, { companyIds, year: 2025 })).toEqual([]);
    // Employee narrows.
    const onlyA = await listZakatTxnsAcross(a, { companyIds, employmentId: eA.employmentId });
    expect(onlyA.map((r) => r.employmentId)).toEqual([eA.employmentId]);
    // Scope fence + empty scope fails closed.
    expect((await listZakatTxnsAcross(a, { companyIds: [base.companyId] })).map((r) => r.company)).toEqual([
      'Acme Sdn Bhd',
    ]);
    expect(await listZakatTxnsAcross(a, { companyIds: [] })).toEqual([]);
  });

  it('applied: status filter narrows to processed-only / closed-only; garbage status is ignored (fail closed to unfiltered)', async () => {
    const a = adminCtx(base);
    const e = await hirePayrollReady(a, base.companyId, base.deptA, 'Status Z', '900101011234');
    await setFixedZakat(a, e.personId, 100);
    // Two regular runs in different months: May stays PROCESSED, April is CLOSED.
    const bApr = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId: bApr.batchId });
    await closeBatch(a, { batchId: bApr.batchId });
    const bMay = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: bMay.batchId });
    const companyIds = [base.companyId];

    // Unfiltered: both rows, each carrying its batch status.
    const all = await listZakatTxnsAcross(a, { companyIds });
    expect(all.map((r) => [r.payPeriod, r.batchStatus])).toEqual([
      ['2026-05', 'processed'],
      ['2026-04', 'closed'],
    ]);
    // processed-only excludes the closed row…
    expect((await listZakatTxnsAcross(a, { companyIds, status: 'processed' })).map((r) => r.payPeriod)).toEqual([
      '2026-05',
    ]);
    // …and closed-only excludes the processed row.
    expect((await listZakatTxnsAcross(a, { companyIds, status: 'closed' })).map((r) => r.payPeriod)).toEqual([
      '2026-04',
    ]);
    // A tampered/garbage status never reaches Postgres — it is ignored (unfiltered), not cast (which would throw).
    expect(await listZakatTxnsAcross(a, { companyIds, status: 'DROP TABLE' })).toHaveLength(2);
    // The CSV export honours the same status filter (one source of truth).
    const file = await exportZakatTxnsCsv(a, { companyIds, status: 'closed' });
    expect(file.rowCount).toBe(1);
    expect(file.content).toContain('2026-04');
    expect(file.content).not.toContain('2026-05');
  });

  // ───────────────────── exportZakatTxnsCsv ─────────────────────

  it('export: returns CSV bytes and appends exactly one zakat.history.exported event with actor + rowCount', async () => {
    const a = adminCtx(base);
    const e = await hirePayrollReady(a, base.companyId, base.deptA, 'Csv Z', '900101011234');
    await setFixedZakat(a, e.personId, 100);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    const file = await exportZakatTxnsCsv(a, { companyIds: [base.companyId] });
    expect(file.rowCount).toBe(1);
    expect(file.filename).toMatch(/^zakat-transaction-history_\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = file.content.trim().split(/\r?\n/);
    expect(lines[0]).toContain('Effective Payroll Month');
    expect(lines).toHaveLength(2); // header + one row
    expect(lines[1]).toContain('Csv Z');

    const events = await owner.db
      .select({ eventType: schema.domainEvent.eventType, actorId: schema.domainEvent.actorId, payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.eventType, 'zakat.history.exported')));
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(base.adminUserId);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.rowCount).toBe(1);
    expect(payload.report).toBe('zakat-transaction-history');
    // Layer-0: the payload carries filter references + a count, never a cleartext amount.
    expect(JSON.stringify(payload)).not.toContain('100');
  });

  it('export: empty scope still records a (zero-row) egress event and yields a header-only CSV', async () => {
    const a = adminCtx(base);
    const file = await exportZakatTxnsCsv(a, { companyIds: [] });
    expect(file.rowCount).toBe(0);
    expect(file.content.trim().split(/\r?\n/)).toHaveLength(1); // header only
    const events = await owner.db
      .select({ id: schema.domainEvent.id })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.eventType, 'zakat.history.exported')));
    expect(events).toHaveLength(1);
  });
});
