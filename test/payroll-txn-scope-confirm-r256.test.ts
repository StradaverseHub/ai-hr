/**
 * r256 (4b909202 rev 2) — ONE CONFIRMATION, AND CONTINUE IS ONE TRANSACTION.
 *
 * WHAT THE REPORTER REJECTED. r255 shipped the refusal with a way forward: a message naming the
 * employee, the run and the reason, and then a SEPARATE "Add {employee} to this run" button beside it.
 * Our own plan invited them to reject that if they would rather be asked, and they did. The screen now
 * asks ONE question at the point of save — Continue or Cancel — and this file is the service half of it.
 *
 * THE LOAD-BEARING TEST IS THE ATOMICITY ONE, and it is not a nicety. The two-step committed the
 * widening in one transaction and then let the screen re-submit the save in ANOTHER: between the two
 * commits the run had been widened onto somebody whose money was never posted, and nothing on any screen
 * said so — a browser closed in that window left it permanently. A single prompt that preserved that gap
 * would be the same defect wearing a better sentence. So `widenScopeIfNeeded` widens INSIDE the write
 * transaction, and the proof is that a save which fails AFTER the widening leaves the run's scope
 * exactly as it found it.
 *
 * AND THE r255 GUARD SURVIVES THE CHANGE OF PRESENTATION. `EmploymentNotActiveInPeriodError` is what
 * stops a leaver being widened onto a processed run and marked for a recalculation no screen can ever
 * perform (`listPayslipLessEligible` will not list them, `reprocessSelectedEmployees` classifies them
 * 'neither', `removeEmployeePayroll` has nothing to remove). Continue is a different button, not a
 * different rule: pressing it on a leaver is refused, and `canAddToRun` still tells the screen to
 * withhold Continue in the first place.
 *
 * The widening's own guards — closed run, company match, the reprocess authority, the concurrent-add
 * merge — are asserted against `addEmploymentToBatchScope` in
 * test/payroll-txn-scope-widen-4b909202.test.ts and are not re-asserted here. What IS re-asserted here
 * is that the confirmed SAVE reaches all of them, because that is the path that ships.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, terminateEmployment } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  BatchNeedsRecalculationError,
  BatchNotDraftError,
  PayrollPermissionDeniedError,
  closeBatch,
  createBatch,
  generatePayslips,
  listPayslipLessEligible,
  reprocessSelectedEmployees,
} from '../core/payroll';
import {
  createIndividualTxnsBulk,
  EmploymentNotActiveInPeriodError,
  EmploymentNotInBatchScopeError,
  TxnDateOutOfPeriodError,
} from '../core/payroll-individual-txn';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

describe('r256 — Continue widens the run, saves the transaction and marks the reprocess as ONE transaction', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // Same baseline as the sibling ledger suites: kernel consumption of one-off rows OFF. Irrelevant to
    // every assertion here — the scope guard, the widening and the mark are the LEDGER's whatever the
    // kernel later does with the row — written out rather than assumed because seedBase seeds from env.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', false);
  });
  afterAll(async () => {
    await closeAll();
  });

  /** Distinct per hire: `employee_statutory_my_ic_uq` is tenant-wide, so two people cannot share one IC. */
  let icSeq = 0;

  async function hire(name: string, departmentId: string) {
    const a = adminCtx(base);
    const ic = `9101010${String(++icSeq).padStart(5, '0')}`;
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

  /** Read as OWNER so no assertion here can be shaped by an RLS accident. */
  async function batchRow(batchId: string) {
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    return row;
  }
  async function txnRows(employmentId: string) {
    return owner.db
      .select({ id: schema.payrollIndividualTxn.id })
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
  }

  const oneRow = { kind: 'earning' as const, txnDate: '2026-05-10', amount: 500 };

  /** The save the entry screen makes when the operator presses Save and answers nothing. */
  const save = (a: ReturnType<typeof adminCtx>, batchId: string, employmentId: string) =>
    createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [oneRow] });

  /** The same save, with Continue pressed. Same values, one extra flag — which is exactly what the
   *  screen re-submits, and why Continue cannot save something other than what was refused. */
  const saveConfirmed = (
    a: ReturnType<typeof adminCtx>,
    batchId: string,
    employmentId: string,
    rows: Array<{ kind: 'earning'; txnDate: string; amount: number }> = [oneRow],
  ) => createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows, widenScopeIfNeeded: true });

  /** A processed run scoped to Finance, with one out-of-scope Operations employee ready to be refused. */
  async function processedFinanceRun() {
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
    return { a, batchId, outside };
  }

  // ───────────────────────── Continue ─────────────────────────

  it('CONTINUE does all three in one go — widens the run, writes the row, marks the reprocess', async () => {
    const { a, batchId, outside } = await processedFinanceRun();
    // The save the operator came to make, unanswered: still refused, exactly as it was.
    await expect(save(a, batchId, outside.employmentId)).rejects.toBeInstanceOf(EmploymentNotInBatchScopeError);

    const r = await saveConfirmed(a, batchId, outside.employmentId);
    expect(r.ids).toHaveLength(1);
    // The screen needs this to say "added AND saved" rather than the bare "Transaction added" of a save
    // that widened nothing — three things happened and the operator has to be told all three.
    expect(r.widenedEmploymentIds).toEqual([outside.employmentId]);

    const row = await batchRow(batchId);
    // WIDENED as an exception, not as a rewrite: the department choice survives and the one person is
    // appended beside it.
    expect(row.scope).toEqual({ departmentIds: [base.deptA], employmentIds: [outside.employmentId] });
    // SAVED — the half r255's first step could not deliver on its own.
    expect(await txnRows(outside.employmentId)).toHaveLength(1);
    // MARKED — without it the newly added person is simply absent from the payslips, silently.
    expect(row.needsRecalcAt).not.toBeNull();
    expect(row.recalcEmploymentIds).toEqual([outside.employmentId]);
    // And the mark is what Close refuses past, which is what makes the silence impossible.
    await expect(closeBatch(a, { batchId })).rejects.toBeInstanceOf(BatchNeedsRecalculationError);
  });

  /**
   * THE ONE THAT MATTERS. This is the window r255's two steps left open, and the reason the plan says a
   * single prompt "must NOT preserve that": widen commits, the save fails, and the run is now scoped to
   * somebody with no money on it and — on a processed run — a recalculation mark for a payslip nothing
   * asked for. Here the widening and the insert are one transaction, so the failure takes the widening
   * down with it and the operator is left exactly where they started.
   *
   * The row fails on `assertDateInPeriod`, which runs AFTER the scope loop — i.e. after the point where
   * the widening has already happened in this transaction. That ordering is the whole test.
   */
  it('a CONFIRMED save that then fails leaves NOTHING behind — not the row, and not the widening', async () => {
    const { a, batchId, outside } = await processedFinanceRun();

    await expect(
      saveConfirmed(a, batchId, outside.employmentId, [{ kind: 'earning', txnDate: '2026-06-10', amount: 500 }]),
    ).rejects.toBeInstanceOf(TxnDateOutOfPeriodError);

    const row = await batchRow(batchId);
    expect(row.scope, 'the run was widened by a save that never wrote a row — the two-step window is back').toEqual({
      departmentIds: [base.deptA],
    });
    expect(row.needsRecalcAt, 'a processed run was marked for a recalculation nothing asked for').toBeNull();
    expect(row.recalcEmploymentIds).toBeNull();
    expect(await txnRows(outside.employmentId)).toHaveLength(0);
    // Which is the point: the run the operator was left with is still exactly the run they had.
    await closeBatch(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
  });

  it('CANCEL writes nothing at all — no widening, no row, no mark', async () => {
    const { a, batchId, outside } = await processedFinanceRun();
    // Cancel is the ABSENCE of the confirmation: the screen simply never re-submits, so the only write
    // the service ever saw is the refused one. Nothing to undo, because nothing was done.
    await expect(save(a, batchId, outside.employmentId)).rejects.toBeInstanceOf(EmploymentNotInBatchScopeError);

    const row = await batchRow(batchId);
    expect(row.scope).toEqual({ departmentIds: [base.deptA] });
    expect(row.needsRecalcAt).toBeNull();
    expect(await txnRows(outside.employmentId)).toHaveLength(0);
    await closeBatch(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
  });

  it('on a DRAFT run Continue widens and writes, and marks NOTHING — a draft recalculates by being generated', async () => {
    const a = adminCtx(base);
    const outside = await hire('Ops Omar', base.deptB);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });

    const r = await saveConfirmed(a, batchId, outside.employmentId);
    expect(r.widenedEmploymentIds).toEqual([outside.employmentId]);
    const row = await batchRow(batchId);
    expect(row.scope).toEqual({ departmentIds: [base.deptA], employmentIds: [outside.employmentId] });
    expect(await txnRows(outside.employmentId)).toHaveLength(1);
    expect(row.needsRecalcAt).toBeNull();
    expect(row.recalcEmploymentIds).toBeNull();
  });

  it('a run that already covers the employee is saved with no widening to report', async () => {
    const a = adminCtx(base);
    const inside = await hire('Finance Fay', base.deptA);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    // The flag is harmless on a save that needs no widening — which matters, because a screen that
    // re-submitted with it set would otherwise rewrite a department run into a list.
    const r = await saveConfirmed(a, batchId, inside.employmentId);
    expect(r.ids).toHaveLength(1);
    expect(r.widenedEmploymentIds).toEqual([]);
    expect((await batchRow(batchId)).scope).toEqual({ departmentIds: [base.deptA] });
  });

  // ───────────── the refusals Continue does NOT get past ─────────────

  /**
   * r255's guard, under r256's presentation. The reporter asked for a prompt; they did not ask for a
   * prompt that can widen a processed run onto somebody the reprocess can never finish. `canAddToRun` is
   * what withholds Continue from the screen (asserted below), and this is the service refusing it anyway
   * for the browser that sends the flag regardless — advice on the screen, enforcement here.
   */
  it('CONTINUE ON A LEAVER IS STILL REFUSED, and leaves the processed run closeable', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    await hire('Finance Fay', base.deptA);
    const leaver = await hire('Left Larry', base.deptB);
    await terminateEmployment(a, { employmentId: leaver.employmentId, terminationDate: '2026-03-31' });
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    await generatePayslips(a, { batchId });

    await expect(saveConfirmed(a, batchId, leaver.employmentId)).rejects.toBeInstanceOf(EmploymentNotActiveInPeriodError);

    const row = await batchRow(batchId);
    expect(row.scope).toEqual({ departmentIds: [base.deptA] });
    // The part that would have been unrecoverable: a mark nothing could clear.
    expect(row.needsRecalcAt).toBeNull();
    expect(row.recalcEmploymentIds).toBeNull();
    expect(await txnRows(leaver.employmentId)).toHaveLength(0);
    // Nobody would have been able to reprocess them anyway — the Reprocess screen's own read agrees.
    expect((await listPayslipLessEligible(a, { batchId })).map((r) => r.employmentId)).not.toContain(
      leaver.employmentId,
    );
    await closeBatch(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
  });

  it('tells the screen to WITHHOLD Continue for a leaver, so the prompt is never offered as a dead end', async () => {
    const a = adminCtx(base);
    const leaver = await hire('Left Larry', base.deptB);
    await terminateEmployment(a, { employmentId: leaver.employmentId, terminationDate: '2026-03-31' });
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    const err = (await save(a, batchId, leaver.employmentId).catch((e: unknown) => e)) as EmploymentNotInBatchScopeError;
    expect(err).toBeInstanceOf(EmploymentNotInBatchScopeError);
    // `txnFailure` attaches `confirmAddToRun` — and the screen therefore renders the prompt — only when
    // this is true. False here, so the operator reads the reason instead of a Continue that cannot work.
    expect(err.detail.canAddToRun).toBe(false);
  });

  it('a CLOSED run still refuses outright — Continue is not a way past 0011', async () => {
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

    await expect(saveConfirmed(a, batchId, outside.employmentId)).rejects.toBeInstanceOf(BatchNotDraftError);
    expect((await batchRow(batchId)).scope).toEqual({ employmentIds: [inside.employmentId] });
    expect(await txnRows(outside.employmentId)).toHaveLength(0);
  });

  it('CONTINUE on a processed run still asks for the same authority the Reprocess screen does', async () => {
    const { a, batchId, outside } = await processedFinanceRun();
    // Take `payroll.reprocess.selective` away. Continuing commits the operator to a reprocessing, so it
    // must refuse exactly where the reprocess would — the prompt is a different question, not a bypass.
    await owner.db.insert(schema.payrollPermissionGrant).values({
      tenantId: base.tenantId,
      companyId: base.companyId,
      permissionKey: 'payroll.reprocess.selective',
      role: 'hr_admin',
      allowed: false,
    });

    await expect(saveConfirmed(a, batchId, outside.employmentId)).rejects.toBeInstanceOf(PayrollPermissionDeniedError);
    const row = await batchRow(batchId);
    expect(row.scope).toEqual({ departmentIds: [base.deptA] });
    expect(row.needsRecalcAt).toBeNull();
    expect(await txnRows(outside.employmentId)).toHaveLength(0);
  });

  /**
   * THE WHOLE PATH, END TO END. r255 pinned this for the button; it has to stay true for the prompt, and
   * through the ONE transaction rather than two. Refused → confirmed → offered by the Reprocess screen →
   * reprocessed → the run closes. If any link breaks, Continue hands the operator a run they cannot close
   * — which is worse than the refusal it replaced.
   */
  it('the employee Continue adds is one the reprocess can FINISH — and the run then closes', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    await hire('Finance Fay', base.deptA);
    const outside = await hire('Ops Omar', base.deptB);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { departmentIds: [base.deptA] },
    });
    await generatePayslips(a, { batchId });

    await expect(save(a, batchId, outside.employmentId)).rejects.toBeInstanceOf(EmploymentNotInBatchScopeError);
    expect((await saveConfirmed(a, batchId, outside.employmentId)).widenedEmploymentIds).toEqual([
      outside.employmentId,
    ]);
    await expect(closeBatch(a, { batchId })).rejects.toBeInstanceOf(BatchNeedsRecalculationError);

    const eligible = await listPayslipLessEligible(a, { batchId });
    expect(
      eligible.map((r) => r.employmentId),
      'the confirmed employee is not on the Reprocess screen, so the mark can never be cleared',
    ).toContain(outside.employmentId);

    const job = await reprocessSelectedEmployees(a, {
      batchId,
      employmentIds: [outside.employmentId],
      reason: 'added from Transaction Entry',
    });
    expect(job.status).toBe('completed');
    const [slip] = await owner.db
      .select({ id: schema.payslip.id, net: schema.payslip.netPay })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, outside.employmentId));
    expect(slip, 'the reprocess wrote no payslip for the employee Continue added').toBeTruthy();
    expect(Number(slip.net)).toBeGreaterThan(0);

    const done = await batchRow(batchId);
    expect(done.needsRecalcAt).toBeNull();
    await closeBatch(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
  });

  /**
   * ONE mark, not two. The widening no longer marks on the save path precisely so this holds: the mark is
   * a statement about the RUN, and two `payroll-batch.recalc-required` events written in the same instant
   * about the same run and the same person are two History entries saying one thing.
   */
  it('records ONE recalculation mark for a confirmed save, not one from the widening and one from the write', async () => {
    const { a, batchId, outside } = await processedFinanceRun();
    await saveConfirmed(a, batchId, outside.employmentId);

    const events = await owner.db
      .select({ type: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, batchId));
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'payroll-batch.recalc-required')).toHaveLength(1);
    // And the widening still leaves its own trace, so one situation is one readable pair in History.
    expect(types.filter((t) => t === 'payroll-batch.scope-widened')).toHaveLength(1);
  });
});

/**
 * The prompt itself, in all six locales. Key parity (test/i18n-coverage.test.ts) proves the keys exist
 * and are non-empty; it cannot see a locale that kept the English string, and it cannot see an ICU select
 * whose branches are missing — which would render a question with no grounds or an effect line that lies
 * about whether Continue marks a reprocessing.
 */
describe('r256 — the one prompt reads the same way in every locale', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  const load = (loc: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'messages', `${loc}.json`), 'utf8')) as Record<string, unknown>;
  const at = (o: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
  const NS = 'payroll.transactions.individual';

  it('the question names the employee, the run and WHY the run excludes them — in every locale', () => {
    for (const loc of LOCALES) {
      const s = at(load(loc), `${NS}.scopeConfirmBody`) as string;
      expect(typeof s, `${loc}`).toBe('string');
      expect(s, `${loc} must name the employee`).toContain('{employee}');
      expect(s, `${loc} must name the run's month`).toContain('{period}');
      // The scope reason is a SELECT, not a translated word chosen in code — all three branches present,
      // or a run that is BOTH departments and a named list is described as though it were one of them.
      expect(s, `${loc} must explain the scope`).toContain('{scope, select,');
      for (const branch of ['departments {', 'employees {', 'other {']) {
        expect(s, `${loc} scopeConfirmBody missing branch ${branch}`).toContain(branch);
      }
    }
  });

  it('the effect line says whether Continue also marks a reprocessing — both endings, in every locale', () => {
    for (const loc of LOCALES) {
      const s = at(load(loc), `${NS}.scopeConfirmEffect`) as string;
      expect(typeof s, `${loc}`).toBe('string');
      // A processed run's Continue commits the operator to a reprocessing and a draft's does not. One
      // ending for both would either invent a reprocessing or hide one.
      expect(s, `${loc} must branch on whether the run is processed`).toContain('{processed, select,');
      for (const branch of ['yes {', 'other {']) {
        expect(s, `${loc} scopeConfirmEffect missing branch ${branch}`).toContain(branch);
      }
      expect(s, `${loc} must name the employee`).toContain('{employee}');
    }
  });

  it('the title, the buttons and the two success lines are translated rather than copied from English', () => {
    const en = load('en');
    for (const key of [
      'scopeConfirmTitle',
      'scopeConfirmContinue',
      'scopeConfirmBusy',
      'scopeConfirmSaved',
      'scopeConfirmSavedRecalc',
    ]) {
      const enText = at(en, `${NS}.${key}`) as string;
      expect(typeof enText, `en ${key}`).toBe('string');
      for (const loc of LOCALES.filter((l) => l !== 'en')) {
        const s = at(load(loc), `${NS}.${key}`);
        expect(typeof s, `${loc} ${key}`).toBe('string');
        expect(s, `${loc} ${key} is still the English string`).not.toBe(enText);
      }
    }
  });

  /**
   * The two-step's copy is RETIRED, not left to rot. `addToRunCta` / `addToRunBusy` / `addToRunDone` /
   * `addToRunDoneRecalc` described a button that no longer exists, and a catalogue that still offers
   * "Add {employee} to this run" invites the next reader to wire it back up. The two refusals r255 added
   * are NOT retired and are checked here for exactly that reason: `addToRunNotEmployed` is still thrown
   * (now from inside a confirmed save) and `employeeNotInScopeNoDetail` is still what page.tsx's
   * `?error=` path resolves.
   */
  it('retires the two-step button copy from every locale, and keeps the refusals that still fire', () => {
    for (const loc of LOCALES) {
      const m = load(loc);
      for (const gone of ['addToRunCta', 'addToRunBusy', 'addToRunDone', 'addToRunDoneRecalc']) {
        expect(at(m, `${NS}.${gone}`), `${loc} still carries the retired key ${gone}`).toBeUndefined();
      }
      for (const kept of ['addToRunDenied', 'addToRunNotEmployed', 'employeeNotInScopeNoDetail', 'employeeNotInScope']) {
        expect(typeof at(m, `${NS}.${kept}`), `${loc} lost the still-live key ${kept}`).toBe('string');
      }
    }
  });

  /**
   * And the SCREEN no longer renders the button. Source-shape, because this is a contract between two
   * files: the workspace could keep a control whose label key is gone and it would render the raw key
   * path in the browser with tsc, the suite and `next build` all green (rule 6's failure mode). The
   * absence of the label key in the source is the honest check — no comment in these files mentions it.
   */
  it('the screen no longer renders a separate "Add to this run" control', () => {
    const workspace = fs.readFileSync(
      path.resolve(__dirname, '..', 'app', 'payroll', 'transactions', 'individual', 'txn-workspace.tsx'),
      'utf8',
    );
    expect(workspace, 'the two-step button is still on the screen').not.toContain('addToRunCta');
    expect(workspace, 'the two-step button is still on the screen').not.toContain('addToRunBusy');
    // And the one prompt IS there, asked with the service's own facts.
    expect(workspace).toContain('scopeConfirmContinue');
    expect(workspace).toContain('scopeConfirmEffect');
  });
});
