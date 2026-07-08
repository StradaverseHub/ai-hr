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
  createIndividualTxnsBulk,
  listIndividualTxns,
  updateIndividualTxn,
  deleteIndividualTxn,
  TxnDateOutOfPeriodError,
  AmountNotPositiveError,
  CompanyMismatchError,
  EmploymentNotInBatchScopeError,
  EmptyEmployeeSelectionError,
  DuplicateTxnRowError,
  TXN_KINDS,
  TXN_UNITS,
} from '../core/payroll-individual-txn';
import { BatchNotDraftError, createAdditionalRun } from '../core/payroll';
import { exportIndividualTxnsCsv } from '../core/payroll-view';
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

  // ───────────────────── bulk save (createIndividualTxnsBulk) ─────────────────────

  it('bulk save writes N rows atomically with one created event per row, all readable', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    const { ids } = await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [
        { kind: 'earning', txnDate: '2026-05-05', amount: 100, notes: 'a' },
        { kind: 'deduction', txnDate: '2026-05-10', amount: 50, notes: 'b' },
        { kind: 'overtime', txnDate: '2026-05-15', amount: 25.5, notes: 'c' },
      ],
    });
    expect(ids).toHaveLength(3);

    const list = await listIndividualTxns(a, { batchId });
    expect(list).toHaveLength(3);
    // One 'created' event per new row id (byte-identical eventType to the single-row path).
    for (const id of ids) {
      expect(await eventTypesFor(base.tenantId, id)).toContain('payroll.individual-txn.created');
    }
  });

  it('multi-employee bulk save: 2 employees × 2 rows ⇒ 4 rows + 4 created events, each subject-scoped', async () => {
    const a = adminCtx(base);
    const e1 = await hireEmployee(a, {
      person: { fullName: 'Multi One', primaryEmail: `m1${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const e2 = await hireEmployee(a, {
      person: { fullName: 'Multi Two', primaryEmail: `m2${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });

    const { ids } = await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [e1.employmentId, e2.employmentId],
      rows: [
        { kind: 'earning', txnDate: '2026-05-05', amount: 100 },
        { kind: 'deduction', txnDate: '2026-05-10', amount: 50 },
      ],
    });
    expect(ids).toHaveLength(4); // 2 rows × 2 employees

    const list = await listIndividualTxns(a, { batchId });
    expect(list).toHaveLength(4);
    expect(list.filter((r) => r.employmentId === e1.employmentId)).toHaveLength(2);
    expect(list.filter((r) => r.employmentId === e2.employmentId)).toHaveLength(2);

    // Each created event's subjectEmploymentId names its own row's employee (per-record scoping).
    const events = await owner.db
      .select({ id: schema.domainEvent.aggregateId, subj: schema.domainEvent.subjectEmploymentId })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'payroll.individual-txn.created'));
    const byRow = new Map(list.map((r) => [r.id, r.employmentId]));
    expect(events).toHaveLength(4);
    for (const ev of events) expect(ev.subj).toBe(byRow.get(ev.id));
  });

  it('empty employee selection throws EmptyEmployeeSelectionError, nothing persists', async () => {
    const { a, batchId } = await hireWithBatch('2026-05');
    await expect(
      createIndividualTxnsBulk(a, { batchId, employmentIds: [], rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }] }),
    ).rejects.toBeInstanceOf(EmptyEmployeeSelectionError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
  });

  it('multi-employee atomicity: one out-of-scope employee (C4) rolls back ALL — zero rows for either', async () => {
    const a = adminCtx(base);
    const included = await hireEmployee(a, {
      person: { fullName: 'Batch In', primaryEmail: `bi${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const excluded = await hireEmployee(a, {
      person: { fullName: 'Batch Out', primaryEmail: `bo${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    // The batch scope names ONLY the first employee; the second is out of scope.
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [included.employmentId] },
    });
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [included.employmentId, excluded.employmentId],
        rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }],
      }),
    ).rejects.toBeInstanceOf(EmploymentNotInBatchScopeError);
    // Even the in-scope employee's row must NOT persist — the whole transaction rolled back.
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
  });

  it('multi-employee atomicity: one wrong-company employee (C3) rolls back ALL', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Other Co Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [d2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: c2.id, name: 'OpsX' })
      .returning({ id: schema.department.id });
    const wrongCo = await hireEmployee(a, {
      person: { fullName: 'Wrong Co Multi', primaryEmail: `wcm${randomUUID()}@acme.test` },
      companyId: c2.id,
      departmentId: d2.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId, wrongCo.employmentId],
        rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }],
      }),
    ).rejects.toBeInstanceOf(CompanyMismatchError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
  });

  it('real rollback: a later-row numeric(12,2) overflow persists ZERO rows and ZERO events', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    // amount numeric(12,2) overflows at ≥ 1e10 — the THIRD row throws mid-transaction, AFTER two inserts.
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [
          { kind: 'earning', txnDate: '2026-05-01', amount: 100 },
          { kind: 'earning', txnDate: '2026-05-02', amount: 200 },
          { kind: 'earning', txnDate: '2026-05-03', amount: 10_000_000_000 }, // overflow numeric(12,2)
        ],
      }),
    ).rejects.toThrow();
    // Nothing persisted — the single transaction rolled back the first two inserts + their events.
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'payroll.individual-txn.created'));
    expect(events).toHaveLength(0);
  });

  it('draft gate: bulk save against a processed batch throws BatchNotDraftError, nothing persists', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    await generatePayslips(a, { batchId });
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }],
      }),
    ).rejects.toBeInstanceOf(BatchNotDraftError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
  });

  it('amount>0 magnitude convention: 0 and negative rejected; a positive-amount deduction accepted', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    await expect(
      createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 0 }] }),
    ).rejects.toBeInstanceOf(AmountNotPositiveError);
    await expect(
      createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: -5 }] }),
    ).rejects.toBeInstanceOf(AmountNotPositiveError);
    // A deduction is a POSITIVE magnitude with kind='deduction' (never a negative amount) — accepted.
    const { ids } = await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [{ kind: 'deduction', txnDate: '2026-05-10', amount: 120 }],
    });
    expect(ids).toHaveLength(1);
    const list = await listIndividualTxns(a, { batchId });
    expect(list[0]).toMatchObject({ kind: 'deduction' });
    expect(Number(list[0].amount)).toBeCloseTo(120, 2);
    // The retained single-row update path enforces the SAME amount>0 rule (both surviving write paths agree).
    await expect(updateIndividualTxn(a, { id: ids[0], amount: 0 })).rejects.toBeInstanceOf(AmountNotPositiveError);
  });

  it('duplicate-record validation: two byte-identical grid rows are rejected, nothing persists', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    // Same item + date + amount + remarks twice in one submission ⇒ a keying mistake ⇒ whole tx rejected.
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [
          { kind: 'earning', txnDate: '2026-05-10', amount: 100, notes: 'bonus' },
          { kind: 'earning', txnDate: '2026-05-10', amount: 100, notes: 'bonus' },
        ],
      }),
    ).rejects.toBeInstanceOf(DuplicateTxnRowError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);

    // Rows that differ in amount OR remarks are NOT duplicates — both persist.
    const { ids } = await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [
        { kind: 'earning', txnDate: '2026-05-10', amount: 100, notes: 'bonus' },
        { kind: 'earning', txnDate: '2026-05-10', amount: 100, notes: 'second claim' },
      ],
    });
    expect(ids).toHaveLength(2);

    // The multi-employee cartesian is NOT a duplicate: the same single row for two employees writes two rows.
    const e2 = await hireEmployee(a, {
      person: { fullName: 'Dup Two', primaryEmail: `dup2${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { ids: ids2 } = await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId, e2.employmentId],
      rows: [{ kind: 'overtime', txnDate: '2026-05-12', amount: 40, notes: 'ot' }],
    });
    expect(ids2).toHaveLength(2);
  });

  it('company match (C3): employment.companyId != batch.companyId throws CompanyMismatchError, nothing persists', async () => {
    // Batch belongs to base.companyId; the employee is hired into a SECOND company in the same tenant.
    const { a, batchId } = await hireWithBatch('2026-05');
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Second Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [d2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: c2.id, name: 'Ops2' })
      .returning({ id: schema.department.id });
    const other = await hireEmployee(a, {
      person: { fullName: 'Wrong Co', primaryEmail: `wc${randomUUID()}@acme.test` },
      companyId: c2.id,
      departmentId: d2.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [other.employmentId],
        rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
      }),
    ).rejects.toBeInstanceOf(CompanyMismatchError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
  });

  it('scope membership (C4): a scoped batch that excludes the employee throws EmploymentNotInBatchScopeError', async () => {
    const a = adminCtx(base);
    // Two employees in the same company; the batch scope names ONLY the first.
    const included = await hireEmployee(a, {
      person: { fullName: 'In Scope', primaryEmail: `in${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const excluded = await hireEmployee(a, {
      person: { fullName: 'Out Scope', primaryEmail: `out${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [included.employmentId] },
    });
    // The included employee saves fine; the excluded one is rejected and nothing lands for them.
    await expect(
      createIndividualTxnsBulk(a, { batchId, employmentIds: [included.employmentId], rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }] }),
    ).resolves.toMatchObject({ ids: [expect.any(String)] });
    await expect(
      createIndividualTxnsBulk(a, { batchId, employmentIds: [excluded.employmentId], rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }] }),
    ).rejects.toBeInstanceOf(EmploymentNotInBatchScopeError);
    // Only the one included row persisted.
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(1);
  });

  it('multi-cycle disambiguation (C1): two draft runs same period+runType, different runSeq are each targetable', async () => {
    process.env.MULTI_CYCLE_PAYROLL_ENABLED = 'true';
    try {
      const { a, employmentId, batchId: regularBatch } = await hireWithBatch('2026-05');
      // Two off_cycle runs in the SAME period → runSeq 2 and 3 (regular is runSeq 1). Same (period, runType),
      // distinguished only by runSeq — the exact ambiguous case the wizard's run selector must resolve.
      const off1 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'off_cycle' });
      const off2 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'off_cycle' });
      expect(off1.batchId).not.toBe(off2.batchId);

      // A row saved against the CHOSEN batch lands on exactly that batch, not a sibling with the same runType.
      await createIndividualTxnsBulk(a, { batchId: off2.batchId, employmentIds: [employmentId], rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 42 }] });
      expect(await listIndividualTxns(a, { batchId: off2.batchId })).toHaveLength(1);
      expect(await listIndividualTxns(a, { batchId: off1.batchId })).toHaveLength(0);
      expect(await listIndividualTxns(a, { batchId: regularBatch })).toHaveLength(0);
    } finally {
      delete process.env.MULTI_CYCLE_PAYROLL_ENABLED;
    }
  });

  it('date boundary (C9): last day of a short month accepted, an over-the-end date rejected via bulk save', async () => {
    // 2026 is not a leap year ⇒ Feb has 28 days. 2026-02-28 accepted; 2026-02-29 rejected.
    const { a, employmentId, batchId } = await hireWithBatch('2026-02');
    await expect(
      createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [{ kind: 'earning', txnDate: '2026-02-29', amount: 1 }] }),
    ).rejects.toBeInstanceOf(TxnDateOutOfPeriodError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
    await expect(
      createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [{ kind: 'earning', txnDate: '2026-02-28', amount: 1 }] }),
    ).resolves.toMatchObject({ ids: [expect.any(String)] });
  });

  it('RLS: a non-admin employee cannot bulk-save', async () => {
    const { employmentId, batchId } = await hireWithBatch('2026-05');
    const emp = await hireEmployee(adminCtx(base), {
      person: { fullName: 'BulkPeeker', primaryEmail: `bp${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const uE = await createAppUser(base.tenantId, emp.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };
    await expect(
      createIndividualTxnsBulk(empCtx, { batchId, employmentIds: [employmentId], rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }] }),
    ).rejects.toThrow();
    // The admin sees nothing was written.
    expect(await listIndividualTxns(adminCtx(base), { batchId })).toHaveLength(0);
  });

  // ───────────────────── history export (exportIndividualTxnsCsv) ─────────────────────

  it('export produces a CSV of the scoped rows and appends one exported event', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [
        { kind: 'earning', txnDate: '2026-05-05', amount: 100 },
        { kind: 'deduction', txnDate: '2026-05-10', amount: 50 },
      ],
    });
    const file = await exportIndividualTxnsCsv(a, { companyIds: [base.companyId] });
    expect(file.rowCount).toBe(2);
    expect(file.filename).toMatch(/\.csv$/);
    expect(file.content).toContain('Employee'); // header row
    expect(file.content.trim().split(/\r\n/)).toHaveLength(3); // header + 2 rows

    const exported = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'payroll.individual-txn.exported'));
    expect(exported.length).toBeGreaterThanOrEqual(1);
  });

  it('export fails closed on an empty scope: header-only CSV, zero rows', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-05', amount: 100 }],
    });
    // No authorised company ⇒ no rows, regardless of what exists in the tenant.
    const file = await exportIndividualTxnsCsv(a, { companyIds: [] });
    expect(file.rowCount).toBe(0);
    expect(file.content.trim().split(/\r\n/)).toHaveLength(1); // header only
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

  it('C11: kindLabel.* and cycle.* are actually TRANSLATED (not present-but-English) in every non-en locale', () => {
    // The wizard promotes these dynamic-key labels into the PRIMARY path across 5 non-en locales, but the
    // i18n-coverage guard only checks key PARITY — a value left in English would pass it. This test closes
    // exactly that gap for the dynamic surface: every kindLabel.<k> and cycle.<runType> must differ from its
    // en value in each non-en locale, except a small allowlist of tokens that are legitimately identical
    // (loanwords). All 4 runTypes are covered (the wizard offers whichever have draft batches at runtime).
    const RUN_TYPES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
    const NON_EN = ['ms', 'ta', 'th', 'vi', 'zh'] as const;
    const MESSAGES = path.resolve(__dirname, '../messages');
    // Loanwords that are legitimately identical to English in a Latin-script locale.
    const ALLOW_IDENTICAL = new Set(['ms:cycle.bonus', 'vi:cycle.bonus', 'ms:kindLabel.bonus']);

    const en = JSON.parse(fs.readFileSync(path.join(MESSAGES, 'en.json'), 'utf8')).payroll.transactions.individual;
    for (const loc of NON_EN) {
      const ind = JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8')).payroll.transactions.individual;
      for (const k of TXN_KINDS) {
        const key = `${loc}:kindLabel.${k}`;
        if (ALLOW_IDENTICAL.has(key)) continue;
        expect(ind.kindLabel[k], key).not.toBe(en.kindLabel[k]);
      }
      for (const rt of RUN_TYPES) {
        const key = `${loc}:cycle.${rt}`;
        if (ALLOW_IDENTICAL.has(key)) continue;
        expect(ind.cycle[rt], key).not.toBe(en.cycle[rt]);
      }
    }
  });
});
