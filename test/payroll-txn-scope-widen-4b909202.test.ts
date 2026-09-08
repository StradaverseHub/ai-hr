/**
 * 4b909202 — THE SCOPE REFUSAL IS ABOUT MEMBERSHIP, NOT STATUS, AND IT NOW OFFERS A WAY FORWARD.
 *
 * WHAT THE REPORTER ACTUALLY MET. They processed a run, went to Individual Transaction, and were told
 * "This employee is not included in the selected payroll run." They read that as the PROCESSED status
 * locking transaction entry. It is not: writing onto a processed run has been allowed since 49e7e0a2,
 * and `test/payroll-txn-edit-after-processing.test.ts` pins it. What refused them was C4, the batch
 * SCOPE check — the run covered selected departments, and their employee was not in one.
 *
 * SO THE FIRST TEST HERE IS THE LOAD-BEARING ONE: the same refusal, on a DRAFT run. If it fires with no
 * payslip in existence and the run still in draft, the refusal cannot be about processing, and the old
 * message pointed the operator at the wrong thing entirely. Everything else in this file follows from
 * that: the refusal now NAMES the run, the employee and the scope reason, and it comes with the one
 * genuinely new piece — `addEmploymentToBatchScope`, which widens the run AND, when the run is
 * processed, marks that employment for recalculation in the same transaction.
 *
 * WHY THE MARK IS NOT OPTIONAL. Widening the scope alone would be worse than the refusal it replaces:
 * the save would go through, the run would say nothing, and the newly added person would simply be
 * absent from the payslips — silent, and indistinguishable from working. The last test in the widening
 * block is therefore the one that matters most: added AND flagged, and Close still refuses.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  BatchNeedsRecalculationError,
  BatchNotDraftError,
  PayrollPermissionDeniedError,
  closeBatch,
  createBatch,
  generatePayslips,
} from '../core/payroll';
import {
  addEmploymentToBatchScope,
  createIndividualTxnsBulk,
  EmploymentNotInBatchScopeError,
} from '../core/payroll-individual-txn';
import { txnImportReason } from '../core/payroll-txn-import';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setSetting, type Base } from './harness';

describe('4b909202 — the scope refusal names the run, and offers to widen it', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // Same baseline as the sibling ledger suites: kernel consumption of one-off rows OFF. Irrelevant to
    // every assertion here (the scope guard and the mark are the LEDGER's, whatever the kernel later
    // does with the row), written out rather than assumed because seedBase seeds from the env.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', false);
  });
  afterAll(async () => {
    await closeAll();
  });

  /** Distinct per hire: `employee_statutory_my_ic_uq` is tenant-wide, so two people cannot share one IC. */
  let icSeq = 0;

  /** A hired, payable employee in the named department. */
  async function hire(name: string, departmentId: string) {
    const a = adminCtx(base);
    const ic = `9001010${String(++icSeq).padStart(5, '0')}`;
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.replace(/\W/g, '')}${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    return e;
  }

  /** The batch row as stored — read as OWNER so no assertion here can be shaped by an RLS accident. */
  async function batchRow(batchId: string) {
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    return row;
  }

  const oneRow = { kind: 'earning' as const, txnDate: '2026-05-10', amount: 500 };

  /** Save one earning for one employee onto the run — the exact shape the entry screen submits. */
  const save = (a: ReturnType<typeof adminCtx>, batchId: string, employmentId: string) =>
    createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [oneRow] });

  // ───────────── the refusal is about MEMBERSHIP, and it says which run and who ─────────────

  it('fires on a DRAFT run — so it was never about the payroll being processed', async () => {
    const a = adminCtx(base);
    const inside = await hire('Finance Fay', base.deptA);
    const outside = await hire('Ops Omar', base.deptB);
    // A run for the Finance department only. NOTHING has been generated: it is a draft, and there is not
    // a payslip in the tenant.
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    expect((await batchRow(batchId)).status).toBe('draft');

    // The in-scope employee saves; the out-of-scope one is refused on the very same draft run.
    await expect(save(a, batchId, inside.employmentId)).resolves.toMatchObject({ ids: [expect.any(String)] });
    const err = await save(a, batchId, outside.employmentId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmploymentNotInBatchScopeError);

    // Still draft, still no payslips — the refusal owes nothing to processing.
    expect((await batchRow(batchId)).status).toBe('draft');
    const slips = await owner.db.select({ id: schema.payslip.id }).from(schema.payslip);
    expect(slips).toHaveLength(0);
  });

  it('carries the run, the employee and WHY the run excludes them — a department scope', async () => {
    const a = adminCtx(base);
    const outside = await hire('Ops Omar', base.deptB);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    const err = (await save(a, batchId, outside.employmentId).catch((e: unknown) => e)) as EmploymentNotInBatchScopeError;
    expect(err).toBeInstanceOf(EmploymentNotInBatchScopeError);
    expect(err.batchId).toBe(batchId);
    expect(err.employmentId).toBe(outside.employmentId);
    // The three values the new message interpolates. Without these the sentence is the old anonymous one.
    expect(err.detail).toEqual({ payPeriod: '2026-05', employeeName: 'Ops Omar', reason: 'departments' });
  });

  it('distinguishes a NAMED-LIST run from a departments run, and a run that is both', async () => {
    const a = adminCtx(base);
    const listed = await hire('Listed Lena', base.deptA);
    const outside = await hire('Ops Omar', base.deptB);

    const named = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [listed.employmentId] },
    });
    const e1 = (await save(a, named.batchId, outside.employmentId).catch((e: unknown) => e)) as EmploymentNotInBatchScopeError;
    expect(e1.detail.reason).toBe('employees');

    const both = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-06',
      scope: { departmentIds: [base.deptA], employmentIds: [listed.employmentId] },
    });
    const e2 = (await save(a, both.batchId, outside.employmentId).catch((e: unknown) => e)) as EmploymentNotInBatchScopeError;
    expect(e2.detail.reason).toBe('mixed');
  });

  it('THE IMPORT tells the same story — one situation, one explanation everywhere', async () => {
    const a = adminCtx(base);
    const outside = await hire('Ops Omar', base.deptB);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    const err = await save(a, batchId, outside.employmentId).catch((e: unknown) => e);
    // The file-import path maps the SAME thrown error into its downloadable report. It must carry the
    // same three values the screen renders, or an operator meeting this from a file reads a different
    // explanation of one refusal — which is what the request complained about.
    expect(txnImportReason(err)).toEqual({
      reason: 'employeeNotInScope',
      detail: { employee: 'Ops Omar', period: '2026-05', scope: 'departments' },
    });
  });

  // ───────────── the existing processed-run behaviour, unbroken ─────────────

  it('a save onto a PROCESSED, IN-SCOPE run still flags that employee for recalculation', async () => {
    const a = adminCtx(base);
    const inside = await hire('Finance Fay', base.deptA);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    await generatePayslips(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('processed');
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();

    await expect(save(a, batchId, inside.employmentId)).resolves.toMatchObject({ ids: [expect.any(String)] });

    const marked = await batchRow(batchId);
    expect(marked.needsRecalcAt).not.toBeNull();
    expect(marked.recalcEmploymentIds).toEqual([inside.employmentId]);
  });

  // ───────────── the way forward: widen the run, and never widen it silently ─────────────

  it('adding an OUT-OF-SCOPE employee to a PROCESSED run both widens the scope AND flags that employment', async () => {
    const a = adminCtx(base);
    await hire('Finance Fay', base.deptA);
    const outside = await hire('Ops Omar', base.deptB);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    await generatePayslips(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('processed');
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
    // The save the operator came to make, refused.
    await expect(save(a, batchId, outside.employmentId)).rejects.toBeInstanceOf(EmploymentNotInBatchScopeError);

    const r = await addEmploymentToBatchScope(a, { batchId, employmentId: outside.employmentId });
    expect(r).toMatchObject({ added: true, markedForRecalc: true, payPeriod: '2026-05', status: 'processed' });

    const row = await batchRow(batchId);
    // WIDENED as an exception, not as a rewrite: the operator's department choice survives intact and the
    // one person they named is appended beside it.
    expect(row.scope).toEqual({ departmentIds: [base.deptA], employmentIds: [outside.employmentId] });
    // AND FLAGGED. Without this the newly added person is simply absent from the payslips, silently.
    expect(row.needsRecalcAt).not.toBeNull();
    expect(row.recalcEmploymentIds).toEqual([outside.employmentId]);
    // The flag is the thing Close refuses past, which is what makes the silence impossible.
    await expect(closeBatch(a, { batchId })).rejects.toBeInstanceOf(BatchNeedsRecalculationError);

    // And the save that was refused now goes through — which is the only thing the operator asked for.
    await expect(save(a, batchId, outside.employmentId)).resolves.toMatchObject({ ids: [expect.any(String)] });
  });

  it('on a DRAFT run it widens the scope and marks NOTHING — a draft recalculates by being generated', async () => {
    const a = adminCtx(base);
    const outside = await hire('Ops Omar', base.deptB);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });

    const r = await addEmploymentToBatchScope(a, { batchId, employmentId: outside.employmentId });
    expect(r).toMatchObject({ added: true, markedForRecalc: false, status: 'draft' });

    const row = await batchRow(batchId);
    expect(row.scope).toEqual({ departmentIds: [base.deptA], employmentIds: [outside.employmentId] });
    expect(row.needsRecalcAt).toBeNull();
    expect(row.recalcEmploymentIds).toBeNull();
    await expect(save(a, batchId, outside.employmentId)).resolves.toMatchObject({ ids: [expect.any(String)] });
  });

  it('a CLOSED run is not widened — the request asks for that, and 0011 backs it', async () => {
    const a = adminCtx(base);
    const inside = await hire('Finance Fay', base.deptA);
    const outside = await hire('Ops Omar', base.deptB);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [inside.employmentId] },
    });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');

    await expect(addEmploymentToBatchScope(a, { batchId, employmentId: outside.employmentId })).rejects.toBeInstanceOf(
      BatchNotDraftError,
    );
    expect((await batchRow(batchId)).scope).toEqual({ employmentIds: [inside.employmentId] });
  });

  it('widening a PROCESSED run asks for the same authority the Reprocess screen does', async () => {
    const a = adminCtx(base);
    await hire('Finance Fay', base.deptA);
    const outside = await hire('Ops Omar', base.deptB);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    await generatePayslips(a, { batchId });
    // Take `payroll.reprocess.selective` away from hr_admin for this company. Widening a processed run
    // commits the operator to a reprocessing, so it must refuse exactly where the reprocess would.
    await owner.db.insert(schema.payrollPermissionGrant).values({
      tenantId: base.tenantId,
      companyId: base.companyId,
      permissionKey: 'payroll.reprocess.selective',
      role: 'hr_admin',
      allowed: false,
    });

    await expect(addEmploymentToBatchScope(a, { batchId, employmentId: outside.employmentId })).rejects.toBeInstanceOf(
      PayrollPermissionDeniedError,
    );
    // Refused BEFORE any write: neither the scope nor the mark moved.
    const row = await batchRow(batchId);
    expect(row.scope).toEqual({ departmentIds: [base.deptA] });
    expect(row.needsRecalcAt).toBeNull();
  });

  it('a run that already covers the employee is a no-op success, not a second entry in its list', async () => {
    const a = adminCtx(base);
    const inside = await hire('Finance Fay', base.deptA);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    const r = await addEmploymentToBatchScope(a, { batchId, employmentId: inside.employmentId });
    expect(r).toMatchObject({ added: false, markedForRecalc: false });
    // Untouched: a department-scoped run that already reaches this person is not rewritten into a list.
    expect((await batchRow(batchId)).scope).toEqual({ departmentIds: [base.deptA] });
  });
});

/**
 * The message itself, in all six locales. The old key took NO values; the replacement interpolates the
 * employee, the run's month and a scope token, so a locale that kept the old flat sentence would render
 * a message that still names nothing — parity (test/i18n-coverage.test.ts) cannot see that, because the
 * key is present and non-empty either way.
 */
describe('4b909202 — the refusal reads the same way in every locale', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  const load = (loc: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'messages', `${loc}.json`), 'utf8')) as Record<string, unknown>;
  const at = (o: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

  const PARAMETERISED = ['payroll.transactions.individual.employeeNotInScope', 'payroll.txnImport.reason.employeeNotInScope'];

  it.each(PARAMETERISED)('%s names the employee, the run and the scope reason in every locale', (key) => {
    for (const loc of LOCALES) {
      const msg = at(load(loc), key);
      expect(typeof msg, `${loc} ${key}`).toBe('string');
      const s = msg as string;
      expect(s, `${loc} ${key} must name the employee`).toContain('{employee}');
      expect(s, `${loc} ${key} must name the run's month`).toContain('{period}');
      // The scope reason is a SELECT, not a translated word chosen in code — all three branches present.
      expect(s, `${loc} ${key} must explain the scope`).toContain('{scope, select,');
      for (const branch of ['departments {', 'employees {', 'other {']) {
        expect(s, `${loc} ${key} missing branch ${branch}`).toContain(branch);
      }
    }
  });

  it('the way forward is offered in every locale, and translated rather than copied from English', () => {
    const en = load('en');
    for (const key of ['addToRunCta', 'addToRunDone', 'addToRunDoneRecalc', 'addToRunBusy', 'addToRunDenied']) {
      const dotted = `payroll.transactions.individual.${key}`;
      const enText = at(en, dotted) as string;
      expect(typeof enText, `en ${key}`).toBe('string');
      for (const loc of LOCALES.filter((l) => l !== 'en')) {
        const s = at(load(loc), dotted);
        expect(typeof s, `${loc} ${key}`).toBe('string');
        expect(s, `${loc} ${key} is still the English string`).not.toBe(enText);
      }
    }
  });
});
