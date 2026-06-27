/**
 * 1.2.2 Individual Transaction (ADR-0056) — a pure dated one-off payroll transaction ledger.
 *
 * Covers: create/list/update/delete round-trip + events; date-in-period validation; the draft gate
 * (no writes once a batch is processed); no-carry-forward (batch-scoped FK); the byte-identical invariant
 * (the ledger is inert w.r.t. computed pay in this slice); RLS (non-admin / wrong-company can't read/write);
 * and i18n dynamic-key parity (the kind.* / unit.* labels resolve non-empty in all 6 locales).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  createIndividualTxn,
  listIndividualTxns,
  updateIndividualTxn,
  deleteIndividualTxn,
  TxnDateOutOfPeriodError,
  TXN_KINDS,
  TXN_UNITS,
} from '../core/payroll-individual-txn';
import { BatchNotDraftError } from '../core/payroll';
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

describe('1.2.2 Individual Transaction', () => {
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

  /** Hire one employee with comp + statutory profile and create a draft batch for the given period. */
  async function hireWithBatch(period = '2026-05') {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Indiv Tx', primaryEmail: `tx${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    return { a, personId: e.personId, employmentId: e.employmentId, batchId };
  }

  // ───────────────────── round-trip + events ─────────────────────

  it('create / list / update / delete round-trip emits created/updated/deleted events', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();

    const { id } = await createIndividualTxn(a, {
      batchId,
      employmentId,
      kind: 'overtime',
      txnDate: '2026-05-10',
      amount: 250.5,
      quantity: 4,
      unit: 'hours',
      notes: 'rest-day OT',
    });

    let list = await listIndividualTxns(a, { batchId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, kind: 'overtime', txnDate: '2026-05-10', unit: 'hours', notes: 'rest-day OT' });
    expect(Number(list[0].amount)).toBeCloseTo(250.5, 2);
    expect(Number(list[0].quantity)).toBeCloseTo(4, 2);
    expect(list[0].name).toBe('Indiv Tx'); // joined person name

    await updateIndividualTxn(a, { id, kind: 'earning', txnDate: '2026-05-12', amount: 99, quantity: null, unit: null, notes: 'fixed' });
    list = await listIndividualTxns(a, { batchId });
    expect(list[0]).toMatchObject({ kind: 'earning', txnDate: '2026-05-12', quantity: null, unit: null, notes: 'fixed' });
    expect(Number(list[0].amount)).toBeCloseTo(99, 2);

    await deleteIndividualTxn(a, { id });
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);

    const events = await eventTypesFor(base.tenantId, id);
    expect(events).toContain('payroll.individual-txn.created');
    expect(events).toContain('payroll.individual-txn.updated');
    expect(events).toContain('payroll.individual-txn.deleted');
  });

  it('all 5 kinds are accepted', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    for (const kind of TXN_KINDS) {
      await createIndividualTxn(a, { batchId, employmentId, kind, txnDate: '2026-05-05', amount: 10 });
    }
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(TXN_KINDS.length);
  });

  // ───────────────────── date-in-period ─────────────────────

  it('a txnDate outside the batch pay-period month throws TxnDateOutOfPeriodError; in-period succeeds', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');

    // Day before the period and day after the period both rejected.
    await expect(
      createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-04-30', amount: 1 }),
    ).rejects.toBeInstanceOf(TxnDateOutOfPeriodError);
    await expect(
      createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-06-01', amount: 1 }),
    ).rejects.toBeInstanceOf(TxnDateOutOfPeriodError);

    // Inclusive bounds (first + last calendar day of May) succeed.
    await expect(createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-01', amount: 1 })).resolves.toMatchObject({ id: expect.any(String) });
    await expect(createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-31', amount: 1 })).resolves.toMatchObject({ id: expect.any(String) });

    // An update that moves the date out of the period is also rejected.
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-15', amount: 1 });
    await expect(updateIndividualTxn(a, { id, txnDate: '2026-07-01' })).rejects.toBeInstanceOf(TxnDateOutOfPeriodError);
  });

  it('February leap/non-leap month bounds are derived correctly', async () => {
    // 2026 is not a leap year ⇒ Feb has 28 days; 2026-02-29 must be rejected, 2026-02-28 accepted.
    const { a, employmentId, batchId } = await hireWithBatch('2026-02');
    await expect(
      createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-02-29', amount: 1 }),
    ).rejects.toBeInstanceOf(TxnDateOutOfPeriodError);
    await expect(
      createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-02-28', amount: 1 }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  // ───────────────────── draft gate ─────────────────────

  it('after generatePayslips (processed), create/update/delete all throw BatchNotDraftError', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });

    await generatePayslips(a, { batchId });
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(batch.status).toBe('processed');

    await expect(
      createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-11', amount: 10 }),
    ).rejects.toBeInstanceOf(BatchNotDraftError);
    await expect(updateIndividualTxn(a, { id, amount: 60 })).rejects.toBeInstanceOf(BatchNotDraftError);
    await expect(deleteIndividualTxn(a, { id })).rejects.toBeInstanceOf(BatchNotDraftError);
  });

  // ───────────────────── no carry-forward ─────────────────────

  it('no carry-forward: a second batch for the next month has an empty list (batch-scoped FK)', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Carry', primaryEmail: `carry${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });

    const may = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const jun = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });

    await createIndividualTxn(a, { batchId: may.batchId, employmentId: e.employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 100 });

    expect(await listIndividualTxns(a, { batchId: may.batchId })).toHaveLength(1);
    expect(await listIndividualTxns(a, { batchId: jun.batchId })).toHaveLength(0);
  });

  // ───────────────────── byte-identical invariant ─────────────────────

  it('individual-txn rows are INERT w.r.t. computed pay (payslip figures identical with vs without rows)', async () => {
    // Two equivalent employees in two equivalent batches; one batch gets a full set of individual-txn rows.
    // The generated payslip figures must be identical — proving the ledger does not fold into pay in this slice.
    // Same period (so the period-derived statutory metadata is identical) but two separate companies in the
    // same tenant — equivalent employees with equal comp. The only difference is that one batch carries a full
    // set of individual-txn rows. The compared payslip figures must be identical ⇒ the ledger is inert.
    async function company(name: string): Promise<string> {
      const [c] = await owner.db
        .insert(schema.company)
        .values({ tenantId: base.tenantId, legalName: name })
        .returning({ id: schema.company.id });
      const [d] = await owner.db
        .insert(schema.department)
        .values({ tenantId: base.tenantId, companyId: c.id, name: 'Finance' })
        .returning({ id: schema.department.id });
      return JSON.stringify({ companyId: c.id, deptId: d.id });
    }
    async function generate(coStr: string, ic: string, withTxns: boolean): Promise<Record<string, unknown>> {
      const { companyId, deptId } = JSON.parse(coStr) as { companyId: string; deptId: string };
      const a = adminCtx(base);
      const e = await hireEmployee(a, {
        person: { fullName: `Inert${ic}`, primaryEmail: `inert${randomUUID()}@acme.test` },
        companyId,
        departmentId: deptId,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4321, monthlyAllowance: 250, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
      const { batchId } = await createBatch(a, { companyId, payPeriod: '2026-05', scope: { employmentIds: [e.employmentId] } });
      if (withTxns) {
        for (const kind of TXN_KINDS) {
          await createIndividualTxn(a, { batchId, employmentId: e.employmentId, kind, txnDate: '2026-05-15', amount: 999, quantity: 8, unit: 'hours', notes: kind });
        }
      }
      await generatePayslips(a, { batchId });
      const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
      // Strip row identity (id / batch / employment / created); the money figures + statutory JSONB remain.
      const { id: _id, batchId: _b, employmentId: _e, createdAt: _c, ...figures } = ps;
      return figures;
    }
    const without = await generate(await company('Inert Co A'), '900101011234', false);
    const withRows = await generate(await company('Inert Co B'), '900101015678', true);
    expect(withRows).toEqual(without);
  });

  // ───────────────────── RLS ─────────────────────

  it('RLS: a non-admin (employee) cannot read or write the table', async () => {
    const { employmentId, batchId } = await hireWithBatch();
    // Seed a row as owner (bypasses RLS) so there is something to (not) read.
    await owner.db.insert(schema.payrollIndividualTxn).values({
      tenantId: base.tenantId,
      batchId,
      employmentId,
      kind: 'earning',
      txnDate: '2026-05-10',
      amount: '100.00',
    });

    const emp = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Peeker', primaryEmail: `peek${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const uE = await createAppUser(base.tenantId, emp.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };

    // The employee can NOT read the admin-only ledger (can_admin_payroll_for is false).
    const seen = await withTenant(empCtx, (tx) =>
      tx.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.batchId, batchId)),
    );
    expect(seen).toHaveLength(0);

    // …and cannot write it (WITH CHECK requires can_admin_payroll_for).
    await expect(
      withTenant(empCtx, (tx) =>
        tx.insert(schema.payrollIndividualTxn).values({
          tenantId: base.tenantId,
          batchId,
          employmentId,
          kind: 'earning',
          txnDate: '2026-05-11',
          amount: '5.00',
        }),
      ),
    ).rejects.toThrow();
  });

  it('RLS WITH CHECK: an admin of another tenant/company cannot insert a row referencing this batch', async () => {
    const { batchId, employmentId } = await hireWithBatch();
    // A different tenant's admin — its can_admin_payroll_for never covers this batch's company, and tenant
    // isolation already differs, so the insert (referencing batchId) must fail.
    const other = await seedBase();
    await expect(
      withTenant(adminCtx(other), (tx) =>
        tx.insert(schema.payrollIndividualTxn).values({
          tenantId: other.tenantId,
          batchId,
          employmentId,
          kind: 'earning',
          txnDate: '2026-05-10',
          amount: '1.00',
        }),
      ),
    ).rejects.toThrow();
    // And it cannot read this tenant's rows either.
    await owner.db.insert(schema.payrollIndividualTxn).values({
      tenantId: base.tenantId,
      batchId,
      employmentId,
      kind: 'earning',
      txnDate: '2026-05-10',
      amount: '2.00',
    });
    const otherSees = await withTenant(adminCtx(other), (tx) =>
      tx.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.batchId, batchId)),
    );
    expect(otherSees).toHaveLength(0);
  });

  // ───────────────────── i18n dynamic-key parity ─────────────────────

  it('every kind.* and unit.* label resolves non-empty in all 6 locales (closes the dynamic-key gap)', () => {
    const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
    const MESSAGES = path.resolve(__dirname, '../messages');
    for (const loc of LOCALES) {
      const d = JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8'));
      const ind = d.payroll.transactions.individual;
      for (const k of TXN_KINDS) {
        expect(typeof ind.kindLabel?.[k], `${loc} kindLabel.${k}`).toBe('string');
        expect(String(ind.kindLabel[k]).trim().length, `${loc} kindLabel.${k} non-empty`).toBeGreaterThan(0);
      }
      for (const u of TXN_UNITS) {
        expect(typeof ind.unitLabel?.[u], `${loc} unitLabel.${u}`).toBe('string');
        expect(String(ind.unitLabel[u]).trim().length, `${loc} unitLabel.${u} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
