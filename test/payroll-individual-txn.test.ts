/**
 * 1.2.2 Individual Transaction (ADR-0056) — a pure dated one-off payroll transaction ledger.
 *
 * Covers: create/list/update/delete round-trip + events; date-in-period validation; the draft gate
 * (no writes once a batch is processed); no-carry-forward (batch-scoped FK); the byte-identical invariant
 * (the ledger is inert w.r.t. computed pay in this slice); RLS (non-admin / wrong-company can't read/write);
 * and i18n dynamic-key parity (the kind.* / unit.* labels resolve non-empty in all 6 locales).
 *
 * ADR-0077 slice 3 — THE THREE GATES THIS FILE DRIVES ARE PER-TENANT ENTITLEMENT ROWS, NOT ENV FLAGS:
 *   • `payroll.individual_txn_pay_enabled`  (SETTING) — was INDIVIDUAL_TXN_PAY_ENABLED
 *   • `typed_pay_components`                (MODULE)  — was TYPED_PAY_COMPONENTS_ENABLED
 *   • `multi_cycle_payroll`                 (MODULE)  — was MULTI_CYCLE_PAYROLL_ENABLED
 *
 * WHICH CONTEXT A TEST USES IS THEREFORE PART OF ITS MEANING. `adminCtx` carries a SYNTHETIC snapshot
 * derived from `legacyEnabledModulesIn(process.env)` / `legacyEnabledSettingsIn(process.env)` — under
 * the suite's env that is the four ungated modules and NO settings, so `typed_pay_components` reads OFF
 * and every setting reads its CATALOG DEFAULT (`false`). A `setSetting` or `setModule` written
 * afterwards reaches it only through the harness's in-memory mirror, never from the row. (Until slice 3
 * it was `entitlementsExempt: 'harness'`, which answered TRUE for every module and could express
 * neither half of this file's flag matrix.) Every assertion that depends on a gate's value
 * therefore runs through `entitledCtx` (a REAL resolved snapshot), resolved AFTER the setModule /
 * setSetting writes it must see, because the snapshot is point-in-time. `adminCtx` is retained only for
 * gate-independent fixture work (hiring, compensation, batch creation, plain ledger CRUD).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import {
  createIndividualTxn,
  createIndividualTxnsBulk,
  listIndividualTxns,
  listUnattachedIndividualTxns,
  updateIndividualTxn,
  deleteIndividualTxn,
  TxnDateOutOfPeriodError,
  AmountNotPositiveError,
  CompanyMismatchError,
  EmploymentNotInBatchScopeError,
  EmptyEmployeeSelectionError,
  DuplicateTxnRowError,
  InvalidPayPeriodError,
  MissingTxnTargetError,
  ComponentRequiredError,
  InvalidTxnComponentError,
  TXN_KINDS,
  TXN_UNITS,
} from '../core/payroll-individual-txn';
import {
  BatchNotDraftError,
  IndividualTxnRequiresTypedComponentsError,
  createAdditionalRun,
  resetProcessedBatch,
} from '../core/payroll';
import { backfillEmploymentComponentsFromCompensation, seedPayComponentCatalog } from '../core/pay-components';
// 0db616f3 — the hand-run January repair is rehearsed in this file, against a real cluster, on a fixture
// built to the shape measured on production. It deletes rows and moves money between runs; a script like
// that is not something to first exercise on the only copy of the data that matters.
import { runJanuaryRepair } from '../scripts/repair-january-bonus-double-import';
import { exportIndividualTxnsCsv } from '../core/payroll-view';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
  harnessSnapshot,
} from './harness';

describe('1.2.2 Individual Transaction', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // f1564110 Phase 3 — every test in this file starts with kernel consumption OFF (the product
    // default); the Phase-3 describe below grants what it needs per test. Two different mechanisms,
    // both written out rather than assumed, because they fail differently:
    //   • `payroll.individual_txn_pay_enabled` is a SETTING whose catalog default is false — but
    //     seedBase writes a platform row with value TRUE on any box whose env carries
    //     INDIVIDUAL_TXN_PAY_ENABLED (the live deployment sets it, see deploy/enable-demo-flags.sh),
    //     so "no row" is NOT a reliable off here. The row is written false to make the baseline
    //     environment-independent instead of ordering-dependent.
    //   • `typed_pay_components` is a MODULE, where a MISSING row is disabled (C7). seedBase seeds
    //     none under the suite's env (test/env.ts deletes TYPED_PAY_COMPONENTS_ENABLED), and the
    //     DELETE below states that rather than relying on it.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', false);
    await setModule(base.tenantId, 'typed_pay_components', null);
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

  // ───────────────────── the write gate (widened by 49e7e0a2) ─────────────────────

  /**
   * UPDATED DELIBERATELY BY 49e7e0a2, NOT LOOSENED TO SUIT A CHANGE. This test used to assert that a
   * PROCESSED run refused every write. That rule is gone on purpose: every payroll run on production sits
   * at processed, so it was a permanent freeze rather than a narrow guard. What replaced it is not an
   * unlock — a write onto a processed run now marks the run for recalculation and Close refuses until that
   * is cleared, which is asserted in full in test/payroll-txn-edit-after-processing.test.ts.
   *
   * What this file keeps asserting is the half that did NOT change: a CLOSED run refuses everything, and
   * `BatchNotDraftError` is still the refusal.
   */
  it('after generatePayslips (processed), create/update/delete are ALLOWED and mark the run for recalculation', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });

    await generatePayslips(a, { batchId });
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(batch.status).toBe('processed');

    await expect(
      createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-11', amount: 10 }),
    ).resolves.toMatchObject({ id: expect.any(String) });
    await expect(updateIndividualTxn(a, { id, amount: 60 })).resolves.toMatchObject({ id });
    await expect(deleteIndividualTxn(a, { id })).resolves.toMatchObject({ id });

    const [marked] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(marked.needsRecalcAt).not.toBeNull();
    expect(marked.recalcEmploymentIds).toEqual([employmentId]);
  });

  it('a CLOSED run still refuses create/update/delete with BatchNotDraftError', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });

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

  it('GATE-OFF GUARD: with payroll.individual_txn_pay_enabled off the rows are INERT w.r.t. computed pay', async () => {
    // f1564110 Phase 3 repurposed this byte-identical invariant as the GATE-OFF guard: kernel consumption
    // exists behind `payroll.individual_txn_pay_enabled`, and with that setting off (written false in
    // beforeEach) the payslip figures must remain identical with vs without ledger rows — proving
    // gate-off payroll is untouched.
    //
    // ADR-0077 slice 3: generation runs through `entitledCtx`, a REAL snapshot, so the OFF really is the
    // tenant's row. Under `adminCtx` this guard would be vacuous — an exempt context reads every setting
    // as its catalog default, so the ledger could never be switched on for it whatever the row said.
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
      // Real snapshot: `payroll.individual_txn_pay_enabled` is false and there is no `typed_pay_components`
      // row (both set in beforeEach) ⇒ the ledger is genuinely un-consumed on BOTH halves.
      const off = await entitledCtx(base);
      await generatePayslips(off, { batchId });
      const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
      // Strip row identity (id / batch / employment / created); the money figures + statutory JSONB remain.
      const { id: _id, batchId: _b, employmentId: _e, createdAt: _c, ...figures } = ps;
      const [selection]=await owner.db.select().from(schema.employmentTaxSelectionMy).where(and(eq(schema.employmentTaxSelectionMy.tenantId,ps.tenantId),eq(schema.employmentTaxSelectionMy.employmentId,ps.employmentId),eq(schema.employmentTaxSelectionMy.companyId,companyId)));
      const [savedBatch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,ps.batchId));
      expect(savedBatch).toMatchObject({tenantId:ps.tenantId,companyId});expect(selection).toBeDefined();expect(selection.transitionState).toBe('resolved');
      const statutory=ps.statutory as Record<string,unknown>,meta=statutory.pcbMeta as Record<string,unknown>;
      expect(meta).toMatchObject({taxSelectionId:selection.id,taxSelectionVersion:selection.version,taxSelectionSource:'income_tax_resident',calculationScheme:selection.scheme});
      // Independently locate each fixture employee's applicable salary, rather than trusting the
      // saved stamp to choose its own owner. Compare every saved input before normalizing identity.
      const salaryOwners = await owner.db.select().from(schema.compensation).where(and(
        eq(schema.compensation.tenantId, base.tenantId),
        eq(schema.compensation.employmentId, e.employmentId),
        isNull(schema.compensation.supersededAt),
        lte(schema.compensation.validFrom, '2026-05-31'),
        or(isNull(schema.compensation.validTo), gt(schema.compensation.validTo, '2026-05-31')),
      ));
      expect(ps).toMatchObject({ tenantId: base.tenantId, employmentId: e.employmentId });
      expect(savedBatch).toMatchObject({ payPeriod: '2026-05' });
      expect(salaryOwners).toHaveLength(1);
      expect(salaryOwners[0]).toMatchObject({ basicSalary: '4321.00', payMode: 'monthly',
        validFrom: '2026-01-01', validTo: null, supersededAt: null });
      const basis = statutory.salaryBasis as Record<string, unknown>;
      expect(basis).toEqual({ version: 1, referenceDate: '2026-05-31',
        compensationId: salaryOwners[0].id, effectiveFrom: '2026-01-01',
        basicSalary: '4321.00', payMode: 'monthly' });
      // Distinct fixture employees have distinct authority UUIDs. Preserve all financial fields and
      // complete statutory JSON; normalize only the independently validated ownership UUIDs.
      return {...figures,statutory:{...statutory,
        salaryBasis:{...basis,compensationId:'validated-compensation-selection'},
        pcbMeta:{...meta,taxSelectionId:'validated-employment-selection'}}};
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
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], entitlements: harnessSnapshot(base.tenantId) };

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

  /** 49e7e0a2 — the bulk path's gate moved with the single-row path's: closed refuses, processed does not.
   *  Asserted on a CLOSED run, which is the state the gate now describes. */
  it('write gate: bulk save against a CLOSED batch throws BatchNotDraftError, nothing persists', async () => {
    const { a, employmentId, batchId } = await hireWithBatch('2026-05');
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });
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
    // ADR-0077 slice 3 — `createAdditionalRun` is gated on the `multi_cycle_payroll` MODULE entitlement.
    // Granted as a row, and the run creation is driven through `entitledCtx` (resolved AFTER the grant)
    // so the row is what actually opens the gate; under the exempt `adminCtx` the grant would be inert
    // decoration and this test would pass with no entitlement at all.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId, batchId: regularBatch } = await hireWithBatch('2026-05');
    const multi = await entitledCtx(base);
    // Two off_cycle runs in the SAME period → runSeq 2 and 3 (regular is runSeq 1). Same (period, runType),
    // distinguished only by runSeq — the exact ambiguous case the wizard's run selector must resolve.
    const off1 = await createAdditionalRun(multi, { companyId: base.companyId, payPeriod: '2026-05', runType: 'off_cycle' });
    const off2 = await createAdditionalRun(multi, { companyId: base.companyId, payPeriod: '2026-05', runType: 'off_cycle' });
    expect(off1.batchId).not.toBe(off2.batchId);

    // A row saved against the CHOSEN batch lands on exactly that batch, not a sibling with the same runType.
    await createIndividualTxnsBulk(a, { batchId: off2.batchId, employmentIds: [employmentId], rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 42 }] });
    expect(await listIndividualTxns(a, { batchId: off2.batchId })).toHaveLength(1);
    expect(await listIndividualTxns(a, { batchId: off1.batchId })).toHaveLength(0);
    expect(await listIndividualTxns(a, { batchId: regularBatch })).toHaveLength(0);
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

  // ─────────── f1564110 Phase 2 — period-keyed (unattached) entry + attach-on-generate ───────────

  /** Hire one employee with comp + statutory profile but NO batch (the pre-run entry scenario). */
  async function hireNoBatch() {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Pre Run', primaryEmail: `prerun${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    return { a, personId: e.personId, employmentId: e.employmentId };
  }

  it('period-keyed entry: rows save UNATTACHED before any run exists; listed, editable, deletable', async () => {
    const { a, employmentId } = await hireNoBatch();

    // Bulk save with NO batch — the reporter’s core ask: entry before payroll processing exists.
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
    });
    expect(ids).toHaveLength(1);

    // Single-row create supports the period-keyed shape too.
    const { id: singleId } = await createIndividualTxn(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentId,
      kind: 'deduction',
      txnDate: '2026-05-20',
      amount: 30,
    });

    const un = await listUnattachedIndividualTxns(a);
    expect(un.filter((r) => [ids[0], singleId].includes(r.id))).toHaveLength(2);
    expect(un.find((r) => r.id === ids[0])).toMatchObject({ payPeriod: '2026-05', companyId: base.companyId });

    // Rows persisted with batch_id NULL + the (company, month) home stamped.
    const [raw] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, ids[0]));
    expect(raw.batchId).toBeNull();
    expect(raw.companyId).toBe(base.companyId);
    expect(raw.payPeriod).toBe('2026-05');

    // Unattached rows are editable / deletable with NO draft-batch gate; the date is still bounded by
    // the row's own pay month.
    await updateIndividualTxn(a, { id: ids[0], amount: 120, txnDate: '2026-05-12' });
    await expect(updateIndividualTxn(a, { id: ids[0], txnDate: '2026-06-01' })).rejects.toBeInstanceOf(
      TxnDateOutOfPeriodError,
    );
    await deleteIndividualTxn(a, { id: singleId });
    expect((await listUnattachedIndividualTxns(a)).some((r) => r.id === singleId)).toBe(false);

    const events = await eventTypesFor(base.tenantId, ids[0]);
    expect(events).toContain('payroll.individual-txn.created');
    expect(events).toContain('payroll.individual-txn.updated');
  });

  it('period-keyed validation: malformed month, missing target, out-of-month date, wrong company', async () => {
    const { a, employmentId } = await hireNoBatch();
    const row = [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }];

    await expect(
      createIndividualTxnsBulk(a, { companyId: base.companyId, payPeriod: '2026-5', employmentIds: [employmentId], rows: row }),
    ).rejects.toBeInstanceOf(InvalidPayPeriodError);
    await expect(
      createIndividualTxnsBulk(a, { employmentIds: [employmentId], rows: row }),
    ).rejects.toBeInstanceOf(MissingTxnTargetError);
    await expect(
      createIndividualTxnsBulk(a, {
        companyId: base.companyId,
        payPeriod: '2026-04', // date below is outside this month
        employmentIds: [employmentId],
        rows: row,
      }),
    ).rejects.toBeInstanceOf(TxnDateOutOfPeriodError);

    // C3 on the unattached path: the employment must belong to the target company.
    const [otherCo] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Other Co (period-keyed C3)' })
      .returning({ id: schema.company.id });
    await expect(
      createIndividualTxnsBulk(a, { companyId: otherCo.id, payPeriod: '2026-05', employmentIds: [employmentId], rows: row }),
    ).rejects.toBeInstanceOf(CompanyMismatchError);

    expect(await listUnattachedIndividualTxns(a)).toHaveLength(0); // nothing persisted by any failure
  });

  it("attach-on-generate: unattached rows are stamped onto the month's REGULAR run — that month only", async () => {
    const { a, employmentId } = await hireNoBatch();

    // Two rows for May, one for June — keyed in before ANY run exists.
    const may = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [
        { kind: 'earning', txnDate: '2026-05-10', amount: 100 },
        { kind: 'deduction', txnDate: '2026-05-15', amount: 25 },
      ],
    });
    const jun = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-06',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-06-05', amount: 77 }],
    });

    // The month's regular run is created LAST and calculated — the reporter's proposed workflow.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    // May rows are attached to the run (visible in its ledger), each with an 'attached' event.
    const attached = await listIndividualTxns(a, { batchId });
    expect(attached.map((r) => r.id).sort()).toEqual([...may.ids].sort());
    for (const id of may.ids) {
      expect(await eventTypesFor(base.tenantId, id)).toContain('payroll.individual-txn.attached');
    }

    // The June row is untouched — no cross-month carry, still unattached.
    const un = await listUnattachedIndividualTxns(a);
    expect(un.map((r) => r.id)).toEqual(jun.ids);
  });

  it('attach-on-generate: a row that named NO pay cycle is the REGULAR run’s — an off-cycle generation leaves it unattached', async () => {
    // c11e81aa NARROWED THE RULE THIS CASE PINS, AND THE CASE SURVIVES BECAUSE THE NARROWING KEPT IT.
    // The rule used to be "regular run, full stop"; it is now "the regular run collects a row that named
    // no cycle (or named a regular one), and nobody else does". This row names none — which is every row
    // on production — so the off-cycle run must still leave it alone and the regular run must still take
    // it. That is the invariant that stops one month's money being paid twice, and it is asserted below
    // unchanged; only the title moved.
    //
    // Same conversion as the C1 test above: the `multi_cycle_payroll` entitlement row is what lets the
    // off-cycle run exist, and `multi` (resolved after the grant) is the context that can see it.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId, batchId: regularId } = await hireWithBatch('2026-05');
    const multi = await entitledCtx(base);
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 42 }],
    });

    const off = await createAdditionalRun(multi, { companyId: base.companyId, payPeriod: '2026-05', runType: 'off_cycle' });
    await generatePayslips(multi, { batchId: off.batchId });
    const [afterOff] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, ids[0]));
    expect(afterOff.batchId).toBeNull(); // NOT collected by the off-cycle run

    await generatePayslips(multi, { batchId: regularId });
    const [afterRegular] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, ids[0]));
    expect(afterRegular.batchId).toBe(regularId); // collected exactly once, by the regular run
  });

  it('attach-on-generate honours batch scope: out-of-scope unattached rows stay unattached', async () => {
    const a = adminCtx(base);
    const mk = async (name: string, ic: string) => {
      const e = await hireEmployee(a, {
        person: { fullName: name, primaryEmail: `scope${randomUUID()}@acme.test` },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic }); // distinct ICs — IC is unique
      return e.employmentId;
    };
    const inScope = await mk('Scope In', '900101011234');
    const outScope = await mk('Scope Out', '900101015678');
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [inScope, outScope],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 10 }],
    });
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [inScope] },
    });
    await generatePayslips(a, { batchId });

    const rows = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(inArray(schema.payrollIndividualTxn.id, ids));
    expect(rows.find((r) => r.employmentId === inScope)?.batchId).toBe(batchId);
    expect(rows.find((r) => r.employmentId === outScope)?.batchId).toBeNull();
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
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], entitlements: harnessSnapshot(base.tenantId) };
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
  // ───────────────────── f1564110 Phase 3 — gated kernel consumption ─────────────────────
  // Golden per-kind fixtures with the `payroll.individual_txn_pay_enabled` setting AND the
  // `typed_pay_components` module entitled (the anchor configuration). Each test builds a BASELINE
  // employee (no ledger rows) and a WITH-ROWS employee in separate fresh companies (same tenant, same
  // period — the inert-test pattern) and compares payslips, so the assertions are deltas, robust to
  // statutory-pack changes. Gate-off byte-identity is guarded by the GATE-OFF GUARD test above.
  //
  // No afterEach reset is needed any more: the gates are tenant ROWS, and resetDb() + seedBase() in the
  // outer beforeEach give every test a brand-new tenant. There is no process-wide state left to leak.
  describe('Phase 3 — kernel consumption (payroll.individual_txn_pay_enabled)', () => {
    let seq = 0;
    /** Hire one employee (comp 5000 / allowance 0 + statutory profile) in a FRESH company with its own
     *  draft batch for 2026-05; seed the component catalog + backfill BASIC/ALLOWANCE (typed substrate). */
    async function setupEmployee() {
      seq += 1;
      const a = adminCtx(base);
      const [c] = await owner.db
        .insert(schema.company)
        .values({ tenantId: base.tenantId, legalName: `P3 Co ${seq} ${randomUUID().slice(0, 8)}` })
        .returning({ id: schema.company.id });
      const [d] = await owner.db
        .insert(schema.department)
        .values({ tenantId: base.tenantId, companyId: c.id, name: 'Ops' })
        .returning({ id: schema.department.id });
      const e = await hireEmployee(a, {
        person: { fullName: `P3 Emp ${seq}`, primaryEmail: `p3-${randomUUID()}@acme.test` },
        companyId: c.id,
        departmentId: d.id,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
      // IC is tenant-unique - derive one per employee from the sequence.
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `900101${String(seq).padStart(6, '0')}` });
      await seedPayComponentCatalog(a); // idempotent (tenant-level catalog)
      await backfillEmploymentComponentsFromCompensation(a);
      const { batchId } = await createBatch(a, { companyId: c.id, payPeriod: '2026-05' });
      return { a, employmentId: e.employmentId, batchId };
    }

    type Stat = Record<string, number> & { recordLines?: { code: string; name: string; amount: number }[]; otSource?: string };
    /**
     * Generate `batchId` in the ANCHOR configuration and read back the payslip.
     *
     * ADR-0077 slice 3: the anchor is now a real entitlement state — a `typed_pay_components` module row
     * plus a `payroll.individual_txn_pay_enabled` setting row — read through a REAL snapshot resolved
     * AFTER those writes, because a snapshot is point-in-time. Both writes are idempotent.
     *
     * (This note used to say `adminCtx` "is entitlementsExempt, so the setting reads its catalog
     * default". That described an earlier draft; slice 3 removed the exemption and gave adminCtx a
     * snapshot derived from the same helpers seedBase uses. The conclusion is unchanged — under the
     * suite's env adminCtx answers both of these DISABLED, so the kernel would never consume the ledger
     * and every delta assertion below would silently become an assertion about an inert one — but the
     * reason is now the derived snapshot, not an exemption.)
     */
    async function generateAndRead(batchId: string) {
      await setModule(base.tenantId, 'typed_pay_components', 'active');
      await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
      const on = await entitledCtx(base);
      await generatePayslips(on, { batchId });
      const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
      return { ps, st: ps.statutory as Stat };
    }

    async function componentIdByCode(code: string): Promise<string> {
      const [row] = await owner.db
        .select({ id: schema.payComponent.id })
        .from(schema.payComponent)
        .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, code)));
      return row.id;
    }

    it('componentless LEGACY earning folds with conservative defaults (EPF/SOCSO/PCB-liable wages) + named record line', async () => {
      const b = await setupEmployee();
      const w = await setupEmployee();
      // Created through the exempt `adminCtx`, for which `payroll.individual_txn_pay_enabled` reads its
      // catalog default (false) — so the component requirement does not fire and this is a legacy
      // componentless payable row, exactly as one keyed before the gate existed.
      await createIndividualTxn(w.a, { batchId: w.batchId, employmentId: w.employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 500, notes: 'Spot award' });
      const { ps: bp, st: bs } = await generateAndRead(b.batchId);
      const { ps: wp, st: ws } = await generateAndRead(w.batchId);
      expect(Number(wp.grossPay)).toBeCloseTo(Number(bp.grossPay) + 500, 2); // paid
      expect(Number(wp.allowance)).toBeCloseTo(Number(bp.allowance) + 500, 2); // wage-allowance bucket
      expect(ws.epfEmployee).toBeGreaterThan(bs.epfEmployee); // EPF base includes it (5500 vs 5000)
      expect(ws.socsoEmployee).toBeGreaterThan(bs.socsoEmployee); // SOCSO base includes it (under the ceiling)
      expect((ws.recordLines ?? []).some((l) => l.code === 'TXN_EARNING' && l.name === 'Spot award' && l.amount === 500)).toBe(true);
    });

    it('componentless LEGACY deduction is POST-statutory: net −amount, statutory identical', async () => {
      const b = await setupEmployee();
      const w = await setupEmployee();
      await createIndividualTxn(w.a, { batchId: w.batchId, employmentId: w.employmentId, kind: 'deduction', txnDate: '2026-05-12', amount: 300, notes: 'Damage recovery' });
      const { ps: bp, st: bs } = await generateAndRead(b.batchId);
      const { ps: wp, st: ws } = await generateAndRead(w.batchId);
      expect(Number(wp.grossPay)).toBeCloseTo(Number(bp.grossPay), 2); // gross untouched
      expect(Number(wp.netPay)).toBeCloseTo(Number(bp.netPay) - 300, 2);
      expect(Number(wp.totalDeductions)).toBeCloseTo(Number(bp.totalDeductions) + 300, 2);
      expect(Number(wp.otherDeductions)).toBeCloseTo(Number(bp.otherDeductions) + 300, 2);
      for (const k of ['epfEmployee', 'socsoEmployee', 'eisEmployee', 'pcb'] as const) {
        expect(ws[k]).toBeCloseTo(bs[k], 2); // post-statutory: no base changes
      }
      expect((ws.recordLines ?? []).some((l) => l.code === 'TXN_DEDUCTION' && l.amount === -300)).toBe(true);
    });

    it('component-carrying earning rides the catalog statutory flags (BONUS: EPF yes, SOCSO no)', async () => {
      const b = await setupEmployee();
      const w = await setupEmployee();
      const bonusId = await componentIdByCode('BONUS');
      // Gate ON for the WRITE too: with `payroll.individual_txn_pay_enabled` set, a new payable row
      // requires a component — provided here. Written through `entitledCtx` because the exempt fixture
      // context reads the setting as its catalog default and would not apply the requirement at all.
      await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
      const on = await entitledCtx(base);
      await createIndividualTxn(on, { batchId: w.batchId, employmentId: w.employmentId, kind: 'earning', componentId: bonusId, txnDate: '2026-05-15', amount: 1000, notes: 'Ad-hoc bonus' });
      const { ps: bp, st: bs } = await generateAndRead(b.batchId);
      const { ps: wp, st: ws } = await generateAndRead(w.batchId);
      expect(Number(wp.bonus)).toBeCloseTo(Number(bp.bonus) + 1000, 2); // (EPF && !SOCSO) ⇒ the bonus bucket
      expect(Number(wp.grossPay)).toBeCloseTo(Number(bp.grossPay) + 1000, 2);
      expect(ws.epfEmployee).toBeGreaterThan(bs.epfEmployee); // EPF-liable per the catalog flag
      expect(ws.socsoEmployee).toBeCloseTo(bs.socsoEmployee, 2); // SOCSO excludes bonus per the catalog flag
      // 417d4937 — UPDATED, NOT DELETED. This line used to expect 'Ad-hoc bonus', the transaction's
      // free-text remark, and that expectation was the defect written down: the record line is now named
      // from the PAY ITEM ('Bonus', the BONUS catalog row's own description). The remark is a note about
      // the transaction, not the identity of the pay item, and letting it win is how A0004's Meal
      // Allowance came to be recorded as a Director Fee. Nothing about the money moved — every delta
      // above is unchanged.
      expect((ws.recordLines ?? []).some((l) => l.code === 'BONUS' && l.name === 'Bonus' && l.amount === 1000)).toBe(true);
      expect((ws.recordLines ?? []).some((l) => l.name === 'Ad-hoc bonus')).toBe(false);
    });

    /**
     * 417d4937 — THE REPORTER'S OWN SHAPE, reproduced: a componented transaction wearing a PREVIOUS
     * item's label in its remark.
     *
     * Measured on production (A0004, 2026-01): componentId resolved to A0040 MEAL ALLOWANCE, RM400 paid
     * and inside gross, and `recordLines` named it "A0020 — DIRECTOR FEE" — the label the entry screen
     * auto-filled for the item that was picked FIRST and never cleared when the item was changed. The
     * reporter read that as a phantom Director Fee transaction and a missing Meal Allowance; it was one
     * transaction with the wrong name on it.
     *
     * The BASELINE half is the important half: the same transaction without the stale remark must produce
     * the same money AND the same name, which is what says the remark can no longer reach the display.
     */
    it('417d4937 — a componented txn is named by its PAY ITEM, never by a stale remark, and the money is unmoved', async () => {
      const clean = await setupEmployee();
      const stale = await setupEmployee();
      // The reporter's pay item: PCB non-taxable, EPF/SOCSO liable (production A0040's exact flags).
      const [meal] = await owner.db
        .insert(schema.payComponent)
        .values({
          tenantId: base.tenantId,
          code: 'A0040',
          name: 'MEAL ALLOWANCE',
          kind: 'allowance',
          includedInEpf: true,
          includedInSocsoEis: true,
          includedInPcb: false,
          prorates: false,
        })
        .returning({ id: schema.payComponent.id });
      await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
      const on = await entitledCtx(base);
      for (const [w, notes] of [
        [clean, null],
        // The label of a DIFFERENT pay item, left behind by the entry screen's auto-fill.
        [stale, 'A0020 — DIRECTOR FEE'],
      ] as const) {
        await createIndividualTxn(on, {
          batchId: w.batchId,
          employmentId: w.employmentId,
          kind: 'earning',
          componentId: meal.id,
          txnDate: '2026-05-18',
          amount: 400,
          ...(notes != null ? { notes } : {}),
        });
      }
      const { ps: cp, st: cs } = await generateAndRead(clean.batchId);
      const { ps: sp, st: ss } = await generateAndRead(stale.batchId);

      // 1. THE NAME comes from the pay item on BOTH, and the phantom Director Fee is nowhere.
      for (const st of [cs, ss]) {
        expect((st.recordLines ?? []).some((l) => l.code === 'A0040' && l.name === 'MEAL ALLOWANCE' && l.amount === 400)).toBe(true);
        expect((st.recordLines ?? []).some((l) => /DIRECTOR FEE/i.test(l.name))).toBe(false);
      }
      // 2. The Transaction Detail grid's own stamp agrees with the record line — one item, one name.
      const compLines = (ss.componentLines as unknown as { code: string; name: string }[] | undefined) ?? [];
      expect(compLines.some((l) => l.code === 'A0040' && l.name === 'MEAL ALLOWANCE')).toBe(true);
      // 3. THE MONEY IS UNMOVED. A PCB-exempt pay item is paid, is inside gross and inside the allowance
      //    column — the reporter's "it disappears" concern — and the stale remark changed none of it.
      expect(Number(sp.grossPay)).toBeCloseTo(Number(cp.grossPay), 2);
      expect(Number(sp.allowance)).toBeCloseTo(Number(cp.allowance), 2);
      expect(Number(sp.netPay)).toBeCloseTo(Number(cp.netPay), 2);
      expect(Number(sp.allowance)).toBeCloseTo(400, 2); // the fixture's own allowance is 0
      for (const k of ['epfEmployee', 'socsoEmployee', 'eisEmployee', 'pcb'] as const) {
        expect(ss[k], k).toBeCloseTo(cs[k], 2);
      }
    });

    it("overtime kind adds to the OT figure with otSource='individual-txn' provenance", async () => {
      const b = await setupEmployee();
      const w = await setupEmployee();
      await createIndividualTxn(w.a, { batchId: w.batchId, employmentId: w.employmentId, kind: 'overtime', txnDate: '2026-05-08', amount: 200, notes: 'Ad-hoc OT' });
      const { ps: bp, st: bs } = await generateAndRead(b.batchId);
      const { ps: wp, st: ws } = await generateAndRead(w.batchId);
      expect(Number(wp.overtimePay)).toBeCloseTo(Number(bp.overtimePay) + 200, 2);
      expect(ws.otSource).toBe('individual-txn');
      expect(ws.epfEmployee).toBeCloseTo(bs.epfEmployee, 2); // EPF excludes overtime
      expect(ws.socsoEmployee).toBeGreaterThan(bs.socsoEmployee); // SOCSO/EIS include overtime
    });

    it('unpaid kind adds its RM amount to the unpaid deduction (pre-statutory)', async () => {
      const b = await setupEmployee();
      const w = await setupEmployee();
      await createIndividualTxn(w.a, { batchId: w.batchId, employmentId: w.employmentId, kind: 'unpaid', txnDate: '2026-05-20', amount: 150, notes: 'Absent day' });
      const { ps: bp, st: bs } = await generateAndRead(b.batchId);
      const { ps: wp, st: ws } = await generateAndRead(w.batchId);
      // The unpaid figure rides otherDeductions (slipUnpaid) on the payslip.
      expect(Number(wp.otherDeductions)).toBeCloseTo(Number(bp.otherDeductions) + 150, 2);
      expect(Number(wp.netPay)).toBeLessThan(Number(bp.netPay));
      expect(ws.epfEmployee).toBeLessThan(bs.epfEmployee); // PRE-statutory: wage base reduced (4850 vs 5000)
      expect((ws.recordLines ?? []).some((l) => l.code === 'TXN_UNPAID' && l.amount === -150)).toBe(true);
    });

    it('leave kind is RECORD-ONLY (documented v1 skip): money identical, named record line present', async () => {
      const b = await setupEmployee();
      const w = await setupEmployee();
      await createIndividualTxn(w.a, { batchId: w.batchId, employmentId: w.employmentId, kind: 'leave', txnDate: '2026-05-21', amount: 99, notes: 'Comp leave note' });
      const { ps: bp, st: bs } = await generateAndRead(b.batchId);
      const { ps: wp, st: ws } = await generateAndRead(w.batchId);
      expect(Number(wp.grossPay)).toBeCloseTo(Number(bp.grossPay), 2);
      expect(Number(wp.netPay)).toBeCloseTo(Number(bp.netPay), 2);
      expect(Number(wp.totalDeductions)).toBeCloseTo(Number(bp.totalDeductions), 2);
      for (const k of ['epfEmployee', 'socsoEmployee', 'eisEmployee', 'pcb'] as const) {
        expect(ws[k]).toBeCloseTo(bs[k], 2);
      }
      expect((ws.recordLines ?? []).some((l) => l.code === 'TXN_LEAVE' && l.name === 'Comp leave note')).toBe(true);
    });

    it('gate on: a NEW payable row REQUIRES a component (create + bulk); non-payable kinds do not; component on a non-payable kind is rejected', async () => {
      const { employmentId, batchId } = await setupEmployee();
      const bonusId = await componentIdByCode('BONUS');
      // The requirement is driven by the `payroll.individual_txn_pay_enabled` ROW, so every call below
      // goes through `entitledCtx` — resolved after the write. Under `adminCtx` the setting would read
      // its catalog default (false) and NONE of the four refusals below would fire: this is precisely
      // the test that must not be left on an exempt context.
      await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
      const on = await entitledCtx(base);
      await expect(
        createIndividualTxn(on, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 }),
      ).rejects.toBeInstanceOf(ComponentRequiredError);
      await expect(
        createIndividualTxnsBulk(on, { batchId, employmentIds: [employmentId], rows: [{ kind: 'deduction', txnDate: '2026-05-10', amount: 50 }] }),
      ).rejects.toBeInstanceOf(ComponentRequiredError);
      await expect(
        createIndividualTxn(on, { batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 50 }),
      ).resolves.toMatchObject({ id: expect.any(String) });
      await expect(
        createIndividualTxn(on, { batchId, employmentId, kind: 'overtime', componentId: bonusId, txnDate: '2026-05-11', amount: 50 }),
      ).rejects.toBeInstanceOf(InvalidTxnComponentError);
      // Kind-mismatch: a deduction row cannot carry an allowance-kind component.
      await expect(
        createIndividualTxn(on, { batchId, employmentId, kind: 'deduction', componentId: bonusId, txnDate: '2026-05-11', amount: 50 }),
      ).rejects.toBeInstanceOf(InvalidTxnComponentError);
    });

    it('FAIL-CLOSED: gate on + typed components OFF + payable rows present ⇒ generation throws (documented dependency)', async () => {
      const w = await setupEmployee();
      // Keyed while the gate is off (adminCtx reads the catalog default) ⇒ a componentless payable row.
      await createIndividualTxn(w.a, { batchId: w.batchId, employmentId: w.employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 100 });
      // The exact dependency this test names: the ledger setting ON while the `typed_pay_components`
      // MODULE has no row. `entitledCtx` is mandatory here — `adminCtx` is exempt, which answers TRUE
      // for every catalogued module, so typed components could never be off and the fail-closed branch
      // would be unreachable.
      await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
      await setModule(base.tenantId, 'typed_pay_components', null);
      const on = await entitledCtx(base);
      await expect(generatePayslips(on, { batchId: w.batchId })).rejects.toBeInstanceOf(IndividualTxnRequiresTypedComponentsError);
    });

    /**
     * ════════════════════════════════════════════════════════════════════════════════════════════════
     * 0db616f3 (migration 0437) — THE CONSUMED MARKER
     * ════════════════════════════════════════════════════════════════════════════════════════════════
     *
     * MEASURED ON PRODUCTION 2026-08-13: `payroll_individual_txn` carried no column of any kind saying
     * whether a row had been paid, and the fold's predicate was `batch_id = $1` and nothing else. So a
     * row moved from one run to another — by a repair, or by an operator re-pointing it — would be paid
     * a second time with nothing recording that the money had already gone out. That is the class the
     * import-side duplicate refusal does NOT close, and it is what January was one generation away from.
     *
     * The marker names the RUN rather than being a boolean, and these three cases are why.
     */
    describe('0db616f3 — a line paid by one run cannot be paid by another', () => {
      it('the marker is stamped by the run that paid it, and only once it really has', async () => {
        const w = await setupEmployee();
        const { ids } = await createIndividualTxnsBulk(w.a, {
          batchId: w.batchId,
          employmentIds: [w.employmentId],
          rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 500, notes: 'Spot award' }],
        });
        const before = await owner.db
          .select()
          .from(schema.payrollIndividualTxn)
          .where(eq(schema.payrollIndividualTxn.id, ids[0]));
        expect(before[0].consumedBatchId).toBeNull(); // a keyed row is not a paid row
        expect(before[0].consumedAt).toBeNull();

        await generateAndRead(w.batchId);
        const [after] = await owner.db
          .select()
          .from(schema.payrollIndividualTxn)
          .where(eq(schema.payrollIndividualTxn.id, ids[0]));
        expect(after.consumedBatchId).toBe(w.batchId);
        expect(after.consumedAt).not.toBeNull();
      });

      /**
       * THE ONE THAT CLOSES THE CLASS. A line paid by the regular run, then re-pointed at a second run of
       * the same month — the shape the January repair script produces on purpose, and the shape an
       * operator produces by accident. The second run must pay NOTHING for it.
       */
      it('re-pointing a PAID line at a second run of the same month does not pay it again', async () => {
        await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
        const w = await setupEmployee();
        const bonusId = await componentIdByCode('BONUS');
        await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
        const on = await entitledCtx(base);
        const { ids } = await createIndividualTxnsBulk(on, {
          batchId: w.batchId,
          employmentIds: [w.employmentId],
          rows: [{ kind: 'earning', componentId: bonusId, txnDate: '2026-05-10', amount: 500, notes: 'Bonus' }],
        });
        const { ps: paidOnce } = await generateAndRead(w.batchId);
        expect(Number(paidOnce.grossPay)).toBeGreaterThan(5000); // the 500 really was paid

        // Now the row is moved to a BONUS run of the same month, exactly as a repair would move it.
        const [company] = await owner.db
          .select({ companyId: schema.payrollBatch.companyId })
          .from(schema.payrollBatch)
          .where(eq(schema.payrollBatch.id, w.batchId));
        const multi = await entitledCtx(base);
        const bonusRun = await createAdditionalRun(multi, {
          companyId: company.companyId,
          payPeriod: '2026-05',
          runType: 'bonus',
        });
        await owner.db
          .update(schema.payrollIndividualTxn)
          .set({ batchId: bonusRun.batchId })
          .where(eq(schema.payrollIndividualTxn.id, ids[0]));

        await generatePayslips(multi, { batchId: bonusRun.batchId });
        const [bonusSlip] = await owner.db
          .select()
          .from(schema.payslip)
          .where(eq(schema.payslip.batchId, bonusRun.batchId));
        // Before 0437 this payslip carried the 500 a second time. The marker still names the run that
        // paid it, so the bonus run's fold never saw the row.
        expect(Number(bonusSlip.grossPay)).toBeCloseTo(0, 2);
        const [row] = await owner.db
          .select()
          .from(schema.payrollIndividualTxn)
          .where(eq(schema.payrollIndividualTxn.id, ids[0]));
        expect(row.consumedBatchId).toBe(w.batchId);
      });

      /**
       * AND THE HALF THAT MUST STILL WORK. `resetProcessedBatch` exists so a mistake can be corrected and
       * the month re-run; a boolean marker would have made every one-off row vanish from that re-run, and
       * an operator correcting a typo would have silently stopped paying someone's overtime.
       */
      it('reset → re-generate still pays the line, and the marker is released while the payslips are gone', async () => {
        const w = await setupEmployee();
        const { ids } = await createIndividualTxnsBulk(w.a, {
          batchId: w.batchId,
          employmentIds: [w.employmentId],
          rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 500, notes: 'Spot award' }],
        });
        const { ps: first } = await generateAndRead(w.batchId);

        // a03b2d9b — reset is behind its own setting, and test/env.ts deletes the env default so every
        // test that wants it opts in explicitly. Resolved AFTER the write, because a snapshot is
        // point-in-time and `generateAndRead` above already resolved one for the generation.
        await setSetting(base.tenantId, 'payroll.reset_enabled', true);
        const on = await entitledCtx(base);
        await resetProcessedBatch(on, { batchId: w.batchId, reason: 'correcting a typo' });
        const [released] = await owner.db
          .select()
          .from(schema.payrollIndividualTxn)
          .where(eq(schema.payrollIndividualTxn.id, ids[0]));
        // The payslip that justified the marker no longer exists, so neither does the marker.
        expect(released.consumedBatchId).toBeNull();
        expect(released.consumedAt).toBeNull();

        const { ps: second } = await generateAndRead(w.batchId);
        expect(Number(second.grossPay)).toBeCloseTo(Number(first.grossPay), 2);
        const [reconsumed] = await owner.db
          .select()
          .from(schema.payrollIndividualTxn)
          .where(eq(schema.payrollIndividualTxn.id, ids[0]));
        expect(reconsumed.consumedBatchId).toBe(w.batchId);
      });
    });
  });
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════════
   * 0db616f3 — THE JANUARY REPAIR, REHEARSED
   * ══════════════════════════════════════════════════════════════════════════════════════════════════
   *
   * scripts/repair-january-bonus-double-import.ts is run BY HAND against production after the release
   * that carries migration 0437 (`deploy.sh` runs migrations, not scripts). It deletes rows and moves
   * money between runs, so it is rehearsed here against a real cluster on a fixture built to the exact
   * shape measured on production 2026-08-13 — 24 imported rows, 11 duplicated pairs, 13 distinct rows
   * totalling RM62,524.51, with two rows that appear in only ONE of the two waves.
   *
   * The last of those is the whole reason the script is not "delete the second import": one row exists
   * only in the earlier wave (RM1,650.71) and a different one only in the later (RM17,325.00), so either
   * naive answer silently drops money a real person is owed.
   */
  describe('0db616f3 — the January bonus repair script', () => {
    /** The production multiset, by (employee, amount, how many copies). One employment carries the ten
     *  BONUS amounts; three carry the RM500 ANGPOW line, which is what makes them three groups and not
     *  one. Total 24 rows, 13 groups, RM62,524.51 distinct — the plan's own figures. */
    const AMOUNTS: [empIndex: number, amount: string, copies: number][] = [
      [0, '6195.00', 2],
      [0, '1700.00', 2],
      [0, '6249.60', 2],
      [0, '3990.00', 2],
      [0, '8400.00', 2],
      [0, '1234.20', 2],
      [0, '5250.00', 2],
      [0, '9030.00', 2],
      [0, '17325.00', 1], // only in the LATER wave on production
      [0, '1650.71', 1], // only in the EARLIER wave on production
      [0, '500.00', 2],
      [1, '500.00', 2],
      [2, '500.00', 2],
    ];

    async function january() {
      await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
      const a = adminCtx(base);
      const emps: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const e = await hireEmployee(a, {
          person: { fullName: `Jan Bonus ${i}`, primaryEmail: `jan${randomUUID()}@acme.test` },
          companyId: base.companyId,
          departmentId: base.deptA,
          employmentType: 'full_time',
          hiredOn: '2025-01-01',
        });
        await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
        emps.push(e.employmentId);
      }
      await seedPayComponentCatalog(a);
      const [bonusComp] = await owner.db
        .select({ id: schema.payComponent.id })
        .from(schema.payComponent)
        .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, 'BONUS')));

      const { batchId: regularId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
      const multi = await entitledCtx(base);
      const bonus = await createAdditionalRun(multi, {
        companyId: base.companyId,
        payPeriod: '2026-01',
        runType: 'bonus',
      });

      // The 24 imported rows, all on the REGULAR run — which is the defect.
      const ids: string[] = [];
      for (const [empIndex, amount, copies] of AMOUNTS) {
        for (let c = 0; c < copies; c += 1) {
          const [row] = await owner.db
            .insert(schema.payrollIndividualTxn)
            .values({
              tenantId: base.tenantId,
              batchId: regularId,
              companyId: base.companyId,
              payPeriod: '2026-01',
              employmentId: emps[empIndex],
              kind: 'earning',
              componentId: bonusComp.id,
              txnDate: '2026-01-31',
              amount,
              source: 'import',
            })
            .returning({ id: schema.payrollIndividualTxn.id });
          ids.push(row.id);
        }
      }
      // …and ONE hand-keyed row that the script must never see, let alone touch.
      const [handKeyed] = await owner.db
        .insert(schema.payrollIndividualTxn)
        .values({
          tenantId: base.tenantId,
          batchId: regularId,
          companyId: base.companyId,
          payPeriod: '2026-01',
          employmentId: emps[0],
          kind: 'earning',
          componentId: bonusComp.id,
          txnDate: '2026-01-15',
          amount: '123.45',
        })
        .returning({ id: schema.payrollIndividualTxn.id });

      return { regularId, bonusId: bonus.batchId, emps, handKeyedId: handKeyed.id, importedIds: ids };
    }

    const url = () => process.env.TEST_MIGRATION_DATABASE_URL!;

    it('report-only names 13 keepers at RM62,524.51 and 11 duplicates, and writes nothing', async () => {
      const f = await january();
      const dry = await runJanuaryRepair(url(), {
        apply: false,
        sourceBatchId: f.regularId,
        targetBatchId: f.bonusId,
      });
      expect(dry.refusals).toEqual([]);
      expect(dry.keep).toHaveLength(13);
      expect(dry.keepTotal).toBe('62524.51');
      expect(dry.surplus).toHaveLength(11);
      expect(dry.alreadyCorrect).toBe(false);

      // Nothing moved.
      const still = await owner.db
        .select({ id: schema.payrollIndividualTxn.id })
        .from(schema.payrollIndividualTxn)
        .where(and(eq(schema.payrollIndividualTxn.batchId, f.regularId), eq(schema.payrollIndividualTxn.source, 'import')));
      expect(still).toHaveLength(24);
    });

    it('apply leaves 13 rows on the BONUS run, deletes 11, and is safe to run again', async () => {
      const f = await january();
      const wet = await runJanuaryRepair(url(), { apply: true, sourceBatchId: f.regularId, targetBatchId: f.bonusId });
      expect(wet.refusals).toEqual([]);

      const onBonus = await owner.db
        .select({ id: schema.payrollIndividualTxn.id, amount: schema.payrollIndividualTxn.amount })
        .from(schema.payrollIndividualTxn)
        .where(and(eq(schema.payrollIndividualTxn.batchId, f.bonusId), eq(schema.payrollIndividualTxn.source, 'import')));
      expect(onBonus).toHaveLength(13);
      expect(onBonus.reduce((t, r) => t + Math.round(Number(r.amount) * 100), 0)).toBe(6252451);

      // BOTH single-wave rows survive — the two the naive answers would have dropped.
      const amounts = onBonus.map((r) => Number(r.amount));
      expect(amounts).toContain(17325);
      expect(amounts).toContain(1650.71);

      // The regular run keeps its hand-keyed row and nothing else.
      const onRegular = await owner.db
        .select({ id: schema.payrollIndividualTxn.id })
        .from(schema.payrollIndividualTxn)
        .where(eq(schema.payrollIndividualTxn.batchId, f.regularId));
      expect(onRegular.map((r) => r.id)).toEqual([f.handKeyedId]);

      // IDEMPOTENT: a second run finds nothing to do and still verifies the same 13 / RM62,524.51.
      const again = await runJanuaryRepair(url(), { apply: true, sourceBatchId: f.regularId, targetBatchId: f.bonusId });
      expect(again.refusals).toEqual([]);
      expect(again.alreadyCorrect).toBe(true);
      expect(again.keep).toHaveLength(13);
      expect(again.keepTotal).toBe('62524.51');
      expect(again.surplus).toHaveLength(0);
    });

    /** THE REFUSAL THAT MATTERS MOST. Moving a line that has already been paid is how money gets paid
     *  twice, which is the whole reason 0437 exists. If this ever fires on production the data has moved
     *  since the plan was approved and a human has to look. */
    it('refuses outright — and writes nothing — if any row has already been paid', async () => {
      const f = await january();
      await owner.db
        .update(schema.payrollIndividualTxn)
        .set({ consumedBatchId: f.regularId, consumedAt: new Date() })
        .where(eq(schema.payrollIndividualTxn.id, f.importedIds[0]));

      const r = await runJanuaryRepair(url(), { apply: true, sourceBatchId: f.regularId, targetBatchId: f.bonusId });
      expect(r.refusals.some((m) => m.includes('already been paid'))).toBe(true);
      const untouched = await owner.db
        .select({ id: schema.payrollIndividualTxn.id })
        .from(schema.payrollIndividualTxn)
        .where(and(eq(schema.payrollIndividualTxn.batchId, f.regularId), eq(schema.payrollIndividualTxn.source, 'import')));
      expect(untouched).toHaveLength(24);
    });

    it('refuses a target run that is not the month\'s bonus run', async () => {
      const f = await january();
      const r = await runJanuaryRepair(url(), {
        apply: true,
        sourceBatchId: f.regularId,
        targetBatchId: f.regularId, // the regular run pointed at itself
      });
      expect(r.refusals.some((m) => m.includes("not the month's bonus run"))).toBe(true);
    });
  });
});
