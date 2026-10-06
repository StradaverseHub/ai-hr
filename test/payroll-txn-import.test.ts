/**
 * 5c65367d — the Excel import for Fixed Transaction and Individual Transaction, against real Postgres.
 *
 * THE PROMISE THIS FILE HOLDS: "Manual Entry = Excel Import = Same validation + Same business rules +
 * Same payroll calculation logic." Every assertion below is a check that the import did NOT grow a
 * second answer — it either surfaced the live service's own refusal, or it wrote through the live
 * service and inherited its side effects.
 *
 * ── THE ONE THAT MATTERS MOST ────────────────────────────────────────────────────────────────────────
 * A preview that says "Valid" and then throws 23P01 on commit is worse than no preview, and it is the
 * failure mode this whole item exists to avoid. Migration 0426's EXCLUDE constraint is keyed on
 * employment + component + INCLUSIVE daterange and NOT on payroll cycle. Two of the tests below are
 * about exactly that: a window that only TOUCHES an existing one is refused in the PREVIEW, and a
 * duplicate PAIR INSIDE ONE FILE is refused in the preview too — the service can never catch that
 * second one for us, because each row is individually fine and by the time the second is written the
 * first is already committed.
 *
 * ── AND THE ONE THAT IS FREE ─────────────────────────────────────────────────────────────────────────
 * Importing onto a processed run marks it for recalculation, because the write goes through
 * `createIndividualTxnsBulk` and that service calls `markBatchNeedsRecalc` itself. The request's "must
 * not automatically mark newly imported transactions as Processed" is satisfied by routing, not by code
 * written here — which is the point, and which is what the last block asserts.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import { listEmploymentPayComponents, seedPayComponentCatalog, setEmploymentPayComponent } from '../core/pay-components';
import { listIndividualTxnsAcross } from '../core/payroll-view';
import { commitTxnImport, validateTxnImport, type TxnImportRecord } from '../core/payroll-txn-import';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

describe('5c65367d — payroll transaction Excel import', () => {
  let base: Base;
  let employmentId: string;
  let employeeCode: string;
  let scopeIds: string[];

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    scopeIds = [base.companyId];
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Import Target', primaryEmail: `imp${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    employmentId = e.employmentId;
    await setCompensation(a, { employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    // The employee code is generated at hire; the import matches on it, so it is read rather than assumed.
    const [row] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    employeeCode = row.code ?? '';
    expect(employeeCode).not.toBe('');
  });
  afterAll(async () => {
    await closeAll();
  });

  const componentCode = async (code: string) => {
    const [row] = await owner.db
      .select({ id: schema.payComponent.id, code: schema.payComponent.code })
      .from(schema.payComponent)
      .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, code)));
    return row;
  };

  /** A Fixed Transaction row as the parsed spreadsheet hands it over. */
  const fixedRec = (p: Partial<TxnImportRecord> = {}): TxnImportRecord => ({
    employee_id: employeeCode,
    employee_name: 'Import Target',
    pay_item_code: 'BONUS',
    pay_item: 'Bonus',
    amount: '100',
    payroll_cycle: 'regular',
    start_date: '2026-08-01',
    end_date: '',
    remarks: '',
    ...p,
  });

  /** An Individual Transaction row, likewise. */
  const indivRec = (p: Partial<TxnImportRecord> = {}): TxnImportRecord => ({
    employee_id: employeeCode,
    employee_name: 'Import Target',
    pay_item_code: 'BONUS',
    pay_item: 'Bonus',
    kind: 'earning',
    quantity: '',
    amount: '250',
    transaction_date: '2026-08-05',
    notes: '',
    ...p,
  });

  const validateFixed = (records: TxnImportRecord[]) =>
    validateTxnImport(adminCtx(base), { kind: 'fixed', scopeIds, records });
  const commitFixed = (records: TxnImportRecord[]) =>
    commitTxnImport(adminCtx(base), { kind: 'fixed', scopeIds, records });
  const validateIndiv = (records: TxnImportRecord[]) =>
    validateTxnImport(adminCtx(base), { kind: 'individual', scopeIds, records });
  const commitIndiv = (records: TxnImportRecord[]) =>
    commitTxnImport(adminCtx(base), { kind: 'individual', scopeIds, records });

  // ══════════════════════ whole-file refusals ══════════════════════

  it('an empty file is a FILE error, not zero row errors', async () => {
    expect((await validateFixed([])).fileError).toBe('emptyFile');
  });

  it('a renamed column is a FILE error, not four hundred identical row errors', async () => {
    // "Pay Item Code" renamed to "Item Code" → the column key is gone. Reporting it per row would tell
    // the operator four hundred times that a pay item is missing, and never that a heading is wrong.
    const bad = { ...fixedRec() } as TxnImportRecord;
    delete bad.pay_item_code;
    expect((await validateFixed([bad])).fileError).toBe('missingColumns');
  });

  // ══════════════════════ resolution ══════════════════════

  it('names an unknown employee code rather than saying the row is invalid', async () => {
    const p = await validateFixed([fixedRec({ employee_id: 'NOBODY-1' })]);
    expect(p.valid).toBe(0);
    expect(p.rows[0].reason).toBe('employeeUnknown');
    expect(p.rows[0].detail?.value).toBe('NOBODY-1');
    // And the row number is the SPREADSHEET's, so the operator can find it.
    expect(p.rows[0].rowNum).toBe(2);
  });

  it('names an unknown pay item code', async () => {
    const p = await validateFixed([fixedRec({ pay_item_code: 'NOPE' })]);
    expect(p.rows[0].reason).toBe('payItemUnknown');
    expect(p.rows[0].detail?.value).toBe('NOPE');
  });

  it('REFUSES an archived pay item — the request asks for "Payroll Item is active"', async () => {
    const bonus = await componentCode('BONUS');
    await owner.db
      .update(schema.payComponent)
      .set({ archivedAt: new Date() })
      .where(eq(schema.payComponent.id, bonus.id));
    const p = await validateFixed([fixedRec()]);
    expect(p.rows[0].reason).toBe('payItemUnknown');
  });

  it('an employee OUTSIDE the admin’s company scope is simply not in the catalogue', async () => {
    // Not "denied" — company scope is an application concern, and the resolver only ever sees the
    // scoped list. An EMPTY scope is the sharpest form of that, and it is a real trap rather than a
    // theoretical one: `listEmployees` treats an empty companyIds array as "no filter" and returns the
    // whole tenant, so without an explicit fail-closed guard in loadCatalogs this row would resolve.
    const p = await validateTxnImport(adminCtx(base), { kind: 'fixed', scopeIds: [], records: [fixedRec()] });
    expect(p.rows[0].reason).toBe('employeeUnknown');
    expect(p.valid).toBe(0);
  });

  // ══════════════════════ shape ══════════════════════

  it.each([
    ['amount', { amount: 'one hundred' }, 'amountInvalid'],
    ['amount not positive', { amount: '0' }, 'amountNotPositive'],
    ['start date', { start_date: '01/08/2026' }, 'startDateInvalid'],
    ['end date', { end_date: 'soon' }, 'endDateInvalid'],
    ['end before start', { end_date: '2026-07-01' }, 'endBeforeStart'],
    ['cycle', { payroll_cycle: 'weekly' }, 'cycleUnknown'],
  ])('Fixed: refuses a bad %s by name', async (_label, patch, reason) => {
    const p = await validateFixed([fixedRec(patch as Partial<TxnImportRecord>)]);
    expect(p.rows[0].reason).toBe(reason);
    expect(p.valid).toBe(0);
  });

  it('Fixed: accepts a blank Payroll Cycle — the tag is optional, exactly as on the Add form', async () => {
    const p = await validateFixed([fixedRec({ payroll_cycle: '' })]);
    expect(p.rows[0].ok).toBe(true);
  });

  it('reads the money HR types, commas and RM included', async () => {
    const p = await validateFixed([fixedRec({ amount: 'RM 1,500.50' })]);
    expect(p.rows[0].ok).toBe(true);
    expect(p.rows[0].amount).toBe('1500.50');
  });

  // ══════════════════════ THE DUPLICATE PREDICATE ══════════════════════

  it('refuses a window that only TOUCHES an existing row — inclusive at both ends, like the constraint', async () => {
    const a = adminCtx(base);
    const bonus = await componentCode('BONUS');
    await setEmploymentPayComponent(a, {
      employmentId,
      componentId: bonus.id,
      amount: 100,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30',
    });
    // Starts on the day the existing row ENDS. A half-open range would call this fine; the database
    // would then raise 23P01 on commit.
    const p = await validateFixed([fixedRec({ start_date: '2026-06-30' })]);
    expect(p.rows[0].ok).toBe(false);
    expect(p.rows[0].reason).toBe('overlap');
    expect(p.rows[0].detail?.code).toBe('BONUS');
  });

  it('does NOT refuse a window that starts the day AFTER an existing row ends', async () => {
    const a = adminCtx(base);
    const bonus = await componentCode('BONUS');
    await setEmploymentPayComponent(a, {
      employmentId,
      componentId: bonus.id,
      amount: 100,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30',
    });
    expect((await validateFixed([fixedRec({ start_date: '2026-07-01' })])).rows[0].ok).toBe(true);
  });

  it('ignores the payroll CYCLE when deciding a clash, because the constraint does', async () => {
    const a = adminCtx(base);
    const bonus = await componentCode('BONUS');
    await setEmploymentPayComponent(a, {
      employmentId,
      componentId: bonus.id,
      amount: 100,
      effectiveFrom: '2026-08-01',
      runType: 'regular',
    });
    // A different cycle tag does NOT make it a different row: employment_pay_component_no_overlap has
    // no cycle in its key. 4fffe638 added payroll_cycle_id to the table, and it is not in the key either
    // (a record and a label; the kernel never reads it).
    const p = await validateFixed([fixedRec({ start_date: '2026-08-15', payroll_cycle: 'bonus' })]);
    expect(p.rows[0].reason).toBe('overlap');
  });

  /**
   * THE IN-FILE PAIR. Each row is individually valid; only together are they wrong. The service cannot
   * catch this — it sees one row at a time, and by the time the second is refused the first is already
   * committed, which is a half-imported file.
   */
  it('refuses an in-file duplicate PAIR in the PREVIEW, and names the row it collides with', async () => {
    const p = await validateFixed([
      fixedRec({ start_date: '2026-08-01', end_date: '2026-12-31' }),
      fixedRec({ start_date: '2026-09-01' }),
    ]);
    expect(p.rows[0].ok).toBe(true);
    expect(p.rows[1].ok).toBe(false);
    expect(p.rows[1].reason).toBe('overlapInFile');
    expect(p.rows[1].detail?.row).toBe(2); // the spreadsheet row it collides with
    expect(p.valid).toBe(1);
  });

  it('a REFUSED preview row is not written, and nothing 23P01 escapes on commit', async () => {
    const r = await commitFixed([
      fixedRec({ start_date: '2026-08-01', end_date: '2026-12-31' }),
      fixedRec({ start_date: '2026-09-01' }),
    ]);
    expect(r.written).toBe(1);
    expect(r.failed).toHaveLength(0); // the bad row never reached the service
    const live = await listEmploymentPayComponents(adminCtx(base), employmentId);
    expect(live.filter((x) => x.code === 'BONUS')).toHaveLength(1);
  });

  it('refuses a row whose window a CLOSED run already paid — the service’s own guard, surfaced', async () => {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });
    const p = await validateFixed([fixedRec({ start_date: '2026-08-01' })]);
    // The pre-flight does not model closed runs — the SERVICE does, so this row reads Valid and is
    // refused at commit, BY NAME, with nothing written. That is the honest split: the import never
    // re-implements a rule it can route to.
    expect(p.rows[0].ok).toBe(true);
    const r = await commitFixed([fixedRec({ start_date: '2026-08-01' })]);
    expect(r.written).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].reason).toBe('closedRun');
    expect(r.failed[0].detail?.period).toBe('2026-08');
    expect(await listEmploymentPayComponents(a, employmentId)).toHaveLength(0);
  });

  // ══════════════════════ the happy path ══════════════════════

  it('writes valid rows THROUGH the live service, with the cycle tag and remarks intact', async () => {
    const r = await commitFixed([fixedRec({ amount: '100', remarks: 'From August', payroll_cycle: 'bonus' })]);
    expect(r.written).toBe(1);
    expect(r.failed).toHaveLength(0);
    const live = await listEmploymentPayComponents(adminCtx(base), employmentId);
    const row = live.find((x) => x.code === 'BONUS');
    expect(row).toBeTruthy();
    expect(Number(row!.amount)).toBeCloseTo(100, 2);
    expect(row!.validFrom).toBe('2026-08-01');
    expect(row!.runType).toBe('bonus');
    expect(row!.remarks).toBe('From August');
  });

  it('imports the VALID rows and reports the failures — a bad row does not sink the file', async () => {
    const r = await commitFixed([
      fixedRec({ start_date: '2026-08-01' }),
      fixedRec({ employee_id: 'NOBODY-1' }),
      fixedRec({ pay_item_code: 'ALLOWANCE', start_date: '2026-08-01' }),
    ]);
    expect(r.written).toBe(2);
    const live = await listEmploymentPayComponents(adminCtx(base), employmentId);
    expect(live.map((x) => x.code).sort()).toEqual(['ALLOWANCE', 'BONUS']);
  });

  // ══════════════════════ Individual Transaction ══════════════════════

  it('Individual: writes a one-off row through createIndividualTxnsBulk, marked as imported', async () => {
    const r = await commitIndiv([indivRec({ amount: '250', notes: 'Q3 incentive' })]);
    expect(r.written).toBe(1);
    const rows = await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId });
    expect(rows).toHaveLength(1);
    expect(rows[0].txnDate).toBe('2026-08-05');
    expect(Number(rows[0].amount)).toBeCloseTo(250, 2);
    expect(rows[0].notes).toBe('Q3 incentive');
    // 4e403268's provenance column. An imported row is NOT hand-keyed and says so.
    expect(rows[0].source).toBe('import');
  });

  it('Individual: an unlabelled row takes the pay item’s own name, exactly as the Add form does', async () => {
    await commitIndiv([indivRec({ notes: '' })]);
    const rows = await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId });
    expect(rows[0].notes).toBeTruthy();
    expect(rows[0].componentCode).toBe('BONUS');
  });

  it.each([
    ['transaction date', { transaction_date: '05/08/2026' }, 'txnDateInvalid'],
    ['kind', { kind: 'wibble' }, 'kindUnknown'],
    ['quantity', { quantity: 'lots' }, 'quantityInvalid'],
    ['amount', { amount: '0' }, 'amountNotPositive'],
  ])('Individual: refuses a bad %s by name, and writes nothing', async (_label, patch, reason) => {
    const p = await validateIndiv([indivRec(patch as Partial<TxnImportRecord>)]);
    expect(p.rows[0].reason).toBe(reason);
    const r = await commitIndiv([indivRec(patch as Partial<TxnImportRecord>)]);
    expect(r.written).toBe(0);
    expect(await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId })).toHaveLength(0);
  });

  it('Individual: a blank Kind falls back to the pay item’s own class', async () => {
    const p = await validateIndiv([indivRec({ kind: '' })]);
    expect(p.rows[0].ok).toBe(true);
    await commitIndiv([indivRec({ kind: '' })]);
    const rows = await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId });
    expect(rows[0].kind).toBe('earning');
  });

  /**
   * THE QUANTITY RULE IS THE PAY ITEM'S, NOT THE TEMPLATE'S. `payRuleInputUnit` is the same resolver the
   * entry form asks, so a file and the form cannot disagree about which box has to be filled in.
   */
  it('Individual: a pay item that calculates from hours refuses a row with no hours', async () => {
    const bonus = await componentCode('BONUS');
    await owner.db
      .update(schema.payComponent)
      .set({ rule: { kind: 'per_hour', rate: 10 } })
      .where(eq(schema.payComponent.id, bonus.id));
    const p = await validateIndiv([indivRec({ quantity: '', amount: '250' })]);
    expect(p.rows[0].reason).toBe('quantityRequiredHours');
  });

  it('Individual: the PREVIEW shows the DERIVED amount, not the one typed into the file', async () => {
    const bonus = await componentCode('BONUS');
    await owner.db
      .update(schema.payComponent)
      .set({ rule: { kind: 'per_hour', rate: 10 } })
      .where(eq(schema.payComponent.id, bonus.id));
    // The file says 999; the item says 10 an hour × 5 hours.
    const p = await validateIndiv([indivRec({ quantity: '5', amount: '999' })]);
    expect(p.rows[0].ok).toBe(true);
    expect(p.rows[0].amount).toBe('50.00');
    await commitIndiv([indivRec({ quantity: '5', amount: '999' })]);
    const rows = await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId });
    // A preview that showed one figure and stored another would not be a preview.
    expect(Number(rows[0].amount)).toBeCloseTo(50, 2);
    expect(Number(rows[0].quantity)).toBeCloseTo(5, 2);
    expect(rows[0].unit).toBe('hours');
  });

  /**
   * THE REQUEST'S PAYROLL-STATUS RULE, AND IT IS FREE. "The system must not automatically mark newly
   * imported transactions as Processed merely because the payroll has previously been processed." The
   * write goes through `createIndividualTxnsBulk`, which calls `markBatchNeedsRecalc` itself — so the
   * run is marked stale and the employee is named on it, exactly as when a row is typed by hand.
   */
  it('Individual: importing onto a PROCESSED run marks it for recalculation and names the employee', async () => {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });

    const r = await commitIndiv([indivRec({ transaction_date: '2026-08-05' })]);
    expect(r.written).toBe(1);

    const [batch] = await withTenant(a, (tx) =>
      tx
        .select({
          needsRecalcAt: schema.payrollBatch.needsRecalcAt,
          ids: schema.payrollBatch.recalcEmploymentIds,
          status: schema.payrollBatch.status,
        })
        .from(schema.payrollBatch)
        .where(eq(schema.payrollBatch.id, batchId)),
    );
    expect(batch.status).toBe('processed');
    expect(batch.needsRecalcAt).not.toBeNull();
    expect(batch.ids as string[]).toContain(employmentId);
    // And the result says so, so the screen can tell the operator before they walk away.
    expect(r.recalcBatchIds).toContain(batchId);

    // The row itself is NOT reported as paid: it is not in the payslip that run produced.
    const rows = await listIndividualTxnsAcross(a, { companyIds: [base.companyId], employmentId });
    expect(rows[0].reprocessRequired).toBe(true);
  });

  it('Individual: a month with no run yet imports period-keyed, which is the designed pre-run flow', async () => {
    const r = await commitIndiv([indivRec({ transaction_date: '2026-09-10' })]);
    expect(r.written).toBe(1);
    const rows = await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId });
    expect(rows[0].payPeriod).toBe('2026-09');
    expect(rows[0].batchStatus).toBeNull(); // unattached — generatePayslips will stamp it on
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════════
   * 0db616f3 — THE JANUARY DOUBLE IMPORT
   * ══════════════════════════════════════════════════════════════════════════════════════════════════
   *
   * MEASURED ON PRODUCTION 2026-08-13. A bonus file was uploaded at 15:27 and again at 15:30. Both
   * landed 12 rows on the January REGULAR run, because this importer pinned `runType === 'regular'` and
   * the file had no way to say otherwise; the BONUS run folded its own batch id, found nothing, and
   * produced nineteen zero payslips — which is exactly why the operator concluded the first upload had
   * failed. 24 rows / RM106,073.31 where 13 / RM62,524.51 were owed, 11 of them exact duplicates.
   *
   * Every test below pins one of the four things that had to be true for that to happen. None of them
   * would have passed before this change: there was no duplicate check on this half at all, no
   * `source_ref`, no acknowledgement that a run had already been paid, and no cycle column.
   */
  describe('0db616f3 — a file cannot be imported twice, and it can say which run it is for', () => {
    it('the SAME file uploaded twice: every row of the second upload is refused, and nothing is written', async () => {
      const file = [indivRec({ amount: '250' }), indivRec({ amount: '400' })];
      const first = await commitIndiv(file);
      expect(first.written).toBe(2);

      // The PREVIEW refuses it, before anything is written — a preview that said "Valid" here and then
      // wrote a second copy is the whole defect.
      const p = await validateIndiv(file);
      expect(p.valid).toBe(0);
      expect(p.rows.map((r) => r.reason)).toEqual(['duplicateInRun', 'duplicateInRun']);

      const second = await commitIndiv(file);
      expect(second.written).toBe(0);
      const rows = await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId });
      expect(rows).toHaveLength(2);
    });

    it('two IDENTICAL rows inside ONE file: the second is refused, naming the row it duplicates', async () => {
      // The case no service can catch for us — each row is individually fine, and by the time the second
      // is written the first has already committed in its own transaction.
      const p = await validateIndiv([indivRec(), indivRec()]);
      expect(p.rows[0].ok).toBe(true);
      expect(p.rows[1].reason).toBe('duplicateInFile');
      expect(p.rows[1].detail?.row).toBe(2); // the header is row 1, so the first data row is row 2

      const r = await commitIndiv([indivRec(), indivRec()]);
      expect(r.written).toBe(1);
      expect(await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId })).toHaveLength(1);
    });

    /**
     * THE CASE THAT DECIDED THE DUPLICATE KEY. January's two waves were NOT the same file: one person
     * appears only in the first and a different person only in the second, which is why "delete the later
     * import" would have dropped RM17,325.00 owed to a real employee. So a re-upload of a CORRECTED file
     * must write the rows that changed and refuse the ones that did not — keyed on the amount, not on the
     * file's identity, which is why both rules exist.
     */
    it('a CORRECTED file re-uploaded writes only what changed', async () => {
      await commitIndiv([indivRec({ amount: '250' }), indivRec({ amount: '400' })]);
      const corrected = [indivRec({ amount: '250' }), indivRec({ amount: '450' })];
      const p = await validateIndiv(corrected);
      expect(p.rows[0].reason).toBe('duplicateInRun'); // unchanged — already there
      expect(p.rows[1].ok).toBe(true); // 400 → 450 is a different line
      const r = await commitIndiv(corrected);
      expect(r.written).toBe(1);
      const rows = await listIndividualTxnsAcross(adminCtx(base), { companyIds: [base.companyId], employmentId });
      expect(rows.map((x) => Number(x.amount)).sort((a, b) => a - b)).toEqual([250, 400, 450]);
    });

    it('an imported row now carries the upload it came from, which is what the duplicate check could not do before', async () => {
      await commitIndiv([indivRec()]);
      const [row] = await owner.db
        .select({ source: schema.payrollIndividualTxn.source, sourceRef: schema.payrollIndividualTxn.sourceRef })
        .from(schema.payrollIndividualTxn)
        .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
      expect(row.source).toBe('import');
      // `xlsx:<digest of the whole file>:<row number>`. On production all 24 January rows had NULL here.
      expect(row.sourceRef).toMatch(/^xlsx:[0-9a-f]{32}:2$/);
    });

    it('the same file-row is refused even when its amount was edited afterwards', async () => {
      // The amount key alone would let this through — the stored row no longer matches the file. The
      // file-row identity is what says "this upload has already been applied".
      await commitIndiv([indivRec({ amount: '250' })]);
      await owner.db
        .update(schema.payrollIndividualTxn)
        .set({ amount: '999.00' })
        .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
      const p = await validateIndiv([indivRec({ amount: '250' })]);
      expect(p.rows[0].reason).toBe('duplicateImported');
    });

    /** THE SILENCE. The run had already produced payslips and the screen said nothing about it. */
    it('importing behind a run that has already been paid WARNS, and still writes the row', async () => {
      const a = adminCtx(base);
      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
      await generatePayslips(a, { batchId });

      const p = await validateIndiv([indivRec()]);
      expect(p.rows[0].ok).toBe(true); // a warning is NOT a refusal — 5c65367d's approved behaviour stands
      expect(p.warned).toBe(1);
      expect((p.rows[0].warnings ?? []).map((w) => w.reason)).toContain('runAlreadyProcessed');

      const r = await commitIndiv([indivRec()]);
      expect(r.written).toBe(1);
      expect(r.recalcBatchIds).toContain(batchId);
    });

    it('a run that is still a DRAFT raises no warning — there is nothing to be behind', async () => {
      const a = adminCtx(base);
      await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
      const p = await validateIndiv([indivRec()]);
      expect(p.rows[0].warnings).toBeUndefined();
      expect(p.warned).toBe(0);
    });

    it('Payroll Cycle "bonus" sends the row to the BONUS run instead of the salary run', async () => {
      await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
      const multi = await entitledCtx(base);
      await createBatch(multi, { companyId: base.companyId, payPeriod: '2026-08' });
      const bonus = await createAdditionalRun(multi, {
        companyId: base.companyId,
        payPeriod: '2026-08',
        runType: 'bonus',
      });

      const r = await commitTxnImport(multi, {
        kind: 'individual',
        scopeIds,
        records: [indivRec({ payroll_cycle: 'bonus' })],
      });
      expect(r.written).toBe(1);
      const [row] = await owner.db
        .select({ batchId: schema.payrollIndividualTxn.batchId })
        .from(schema.payrollIndividualTxn)
        .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
      // THE WHOLE JANUARY DEFECT, INVERTED: the line is on the bonus run, not the salary run.
      expect(row.batchId).toBe(bonus.batchId);
    });

    /**
     * AND IT IS REFUSED RATHER THAN FALLING BACK. A period-keyed row is collected by attach-on-generate,
     * which is REGULAR-RUN-ONLY — so "bonus, but there is no bonus run" would land on the salary run,
     * which is precisely what January did. Refusing is the only answer that does not rebuild the defect.
     */
    it('Payroll Cycle "bonus" with no bonus run is REFUSED by name, and writes nothing', async () => {
      const a = adminCtx(base);
      await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
      const p = await validateIndiv([indivRec({ payroll_cycle: 'bonus' })]);
      expect(p.rows[0].reason).toBe('runMissingForCycle');
      expect(p.rows[0].detail?.cycle).toBe('bonus');
      const r = await commitIndiv([indivRec({ payroll_cycle: 'bonus' })]);
      expect(r.written).toBe(0);
      expect(await listIndividualTxnsAcross(a, { companyIds: [base.companyId], employmentId })).toHaveLength(0);
    });

    it('a blank Payroll Cycle behaves exactly as before — the regular run, then period-keyed', async () => {
      const a = adminCtx(base);
      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
      await commitIndiv([indivRec({ payroll_cycle: '' })]);
      const [row] = await owner.db
        .select({ batchId: schema.payrollIndividualTxn.batchId })
        .from(schema.payrollIndividualTxn)
        .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
      expect(row.batchId).toBe(batchId);
    });

    it('an unknown Payroll Cycle is refused by name rather than silently ignored', async () => {
      const p = await validateIndiv([indivRec({ payroll_cycle: 'quarterly' })]);
      expect(p.rows[0].reason).toBe('cycleUnknown');
    });

    /**
     * THE MIS-TARGET, MADE VISIBLE. Routing is never INFERRED from the pay item — `display_category` is
     * presentation metadata and paying a bonus inside the salary run is completely ordinary, so forcing a
     * separate run on everyone would be worse than the defect. What the operator gets instead is being
     * told, before they press Confirm, that the month has a bonus run their bonus line is not going to.
     */
    it('a bonus-coded item heading for the salary run in a month that HAS a bonus run says so', async () => {
      const bonusComp = await componentCode('BONUS');
      await owner.db
        .update(schema.payComponent)
        .set({ displayCategory: 'bonus' })
        .where(eq(schema.payComponent.id, bonusComp.id));
      await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
      const multi = await entitledCtx(base);
      await createBatch(multi, { companyId: base.companyId, payPeriod: '2026-08' });
      await createAdditionalRun(multi, { companyId: base.companyId, payPeriod: '2026-08', runType: 'bonus' });

      const p = await validateTxnImport(multi, { kind: 'individual', scopeIds, records: [indivRec()] });
      expect(p.rows[0].ok).toBe(true); // still written — only the operator knows which they meant
      expect((p.rows[0].warnings ?? []).map((w) => w.reason)).toContain('bonusRunExists');

      // …and it is silent when the operator HAS said which run they want.
      const stated = await validateTxnImport(multi, {
        kind: 'individual',
        scopeIds,
        records: [indivRec({ payroll_cycle: 'bonus' })],
      });
      expect(stated.rows[0].warnings).toBeUndefined();
    });

    it('no bonus run in the month ⇒ no warning: a bonus paid inside the salary run is ordinary', async () => {
      const bonusComp = await componentCode('BONUS');
      await owner.db
        .update(schema.payComponent)
        .set({ displayCategory: 'bonus' })
        .where(eq(schema.payComponent.id, bonusComp.id));
      const a = adminCtx(base);
      await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
      const p = await validateIndiv([indivRec()]);
      expect(p.rows[0].warnings).toBeUndefined();
    });
  });
});
