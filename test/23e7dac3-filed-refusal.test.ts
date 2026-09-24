/**
 * ADR-0085 step 4 — A RUN THAT WOULD RESTATE A FILED MONTH IS REFUSED, AND THE REFUSAL NAMES THE FILING.
 *
 * This is the guard that makes item 23e7dac3 (process cycles in any order) safe to ship. EPF, SOCSO and
 * PCB are worked out on what an employee has been paid so far in the month, so a second run in a month
 * can change a figure the first run already produced. Unfiled, that is arithmetic. Filed, it is a
 * restatement of a figure LHDN, KWSP or PERKESO already holds, which is an amendment made with the
 * agency and is out of ADR-0085's scope (§6).
 *
 * EVERY ARM HAS ITS OPPOSITE BESIDE IT, because both ways of being wrong are cheap to hide:
 *   - a filed month refuses AND an unfiled month of the same shape proceeds;
 *   - the refusal NAMES the return type, its period and its filing date — a message that merely said
 *     "this month is filed" would pass a `rejects.toThrow()` and tell an operator nothing;
 *   - a DRAFT artefact (somebody pressed "Record generation" on a preview) does NOT refuse — r292's
 *     defect, repeated here would be repeating it on a money path;
 *   - reversing the filing RELEASES the refusal, so the guard tracks the live claim;
 *   - a recorded PCB PAYMENT refuses on its own, with no return at all;
 *   - a run at run_seq 1 is never refused, so an ordinary single monthly run is unaffected;
 *   - the guard is consulted at BOTH doors: creating the run, and generating its payslips after a
 *     filing landed in between.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  PeriodAlreadyFiledError,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  setPayrollInput,
} from '../core/payroll';
import { markReportFiled, reverseReportFiling } from '../core/reporting';
import { recordPcbPayment } from '../core/pcb-payment';
import { describeFiledEvidence } from '../core/statutory-filed';
import { todayInKualaLumpur } from '../lib/hr-date';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import type { SessionContext } from '../db/client';

const MONTH = '2026-05';
/**
 * THE FORM E ARM IS DERIVED FROM THE CLOCK, NOT WRITTEN DOWN. `markReportFiled` refuses a filing date in
 * the future, and Form E for a year is lodged in the year AFTER it — so a hardcoded (year, filing date)
 * pair is either impossible today or quietly becomes so (CLAUDE.md §8). The completed year before this
 * one, filed today, is the only pair that stays true whenever this suite runs.
 */
const TODAY = todayInKualaLumpur();
const PRIOR_YEAR = String(Number(TODAY.slice(0, 4)) - 1);
const PRIOR_YEAR_MONTH = `${PRIOR_YEAR}-05`;
let base: Base;
let a: SessionContext;
let employmentId: string;

/** An artefact exactly as `recordReport` leaves one: status 'draft', nothing filed. */
async function draftReport(periodKey = MONTH, reportType = 'my.cp39', periodKind = 'month') {
  const [row] = await owner.db
    .insert(schema.statutoryReport)
    .values({
      tenantId: base.tenantId,
      companyId: base.companyId,
      jurisdiction: 'MY',
      reportType,
      periodKind,
      periodKey,
      status: 'draft',
      statutoryVersion: 'MY-2026.1',
      rowCount: 1,
      generatedBy: base.adminUserId,
    })
    .returning({ id: schema.statutoryReport.id });
  return row.id;
}

/** The month's regular run, processed — the state every arm below starts from. */
async function regularRun(period = MONTH) {
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(a, { batchId });
  return batchId;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  // The entitlement ROW is the gate (ADR-0077 slice 3) and `entitledCtx` snapshots point-in-time, so
  // the grant is written before the context is built.
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  a = await entitledCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: 'Filed Guard', primaryEmail: 'fg@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2025-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
  employmentId = e.employmentId;
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0085 step 4 · a filed month refuses the run that would restate it', () => {
  it('(b) a month with a FILED return refuses a second run, and the message names what was filed', async () => {
    await regularRun();
    const rep = await draftReport();
    await markReportFiled(a, { reportId: rep, ackRef: 'LHDN-ACK-77123', filedOn: '2026-06-10' });

    const err = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' }).then(
      () => null,
      (e: unknown) => e,
    );
    // The TYPE, so a caller can branch on the refusal rather than on a message that would also match a
    // different throw — and so this arm cannot pass because some unrelated error happened to be raised.
    expect(err).toBeInstanceOf(PeriodAlreadyFiledError);
    const filed = err as PeriodAlreadyFiledError;
    expect(filed.code).toBe('PERIOD_ALREADY_FILED');
    // NAMES WHAT WAS FILED AND WHEN. Each assertion is a separate substring: a single regex over the
    // whole sentence would go green on a message that had lost the reference or the date.
    expect(filed.message).toContain('my.cp39');
    expect(filed.message).toContain('2026-06-10');
    expect(filed.message).toContain('LHDN-ACK-77123');
    expect(filed.message).toContain(MONTH);
    // …and the structured evidence, so a screen does not have to parse the sentence back apart.
    expect(filed.evidence).toEqual([
      expect.objectContaining({ kind: 'statutory-return', what: 'my.cp39', periodKey: MONTH, covers: 'month', on: '2026-06-10', reference: 'LHDN-ACK-77123' }),
    ]);
  });

  it('(b-opposite) the SAME month with nothing filed accepts the second run', async () => {
    await regularRun();
    const r = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' });
    expect(r.batchId).toBeTruthy();
    await setPayrollInput(a, { batchId: r.batchId, employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    await expect(generatePayslips(a, { batchId: r.batchId })).resolves.toBeTruthy();
  });

  it('a DRAFT artefact for the month does NOT refuse (r292: a recorded PREVIEW is not a filing)', async () => {
    await regularRun();
    await draftReport();
    await expect(
      createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' }),
    ).resolves.toBeTruthy();
  });

  it('(c) reversing the filing RELEASES the refusal', async () => {
    await regularRun();
    const rep = await draftReport();
    await markReportFiled(a, { reportId: rep, ackRef: 'LHDN-ACK-77123', filedOn: '2026-06-10' });
    await expect(
      createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' }),
    ).rejects.toBeInstanceOf(PeriodAlreadyFiledError);

    await reverseReportFiling(a, { reportId: rep, reason: 'Recorded against the wrong month' });
    const r = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' });
    await setPayrollInput(a, { batchId: r.batchId, employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    await expect(generatePayslips(a, { batchId: r.batchId })).resolves.toBeTruthy();
  });

  it('a recorded PCB PAYMENT refuses on its own, with no return in the table at all', async () => {
    await regularRun();
    await recordPcbPayment(a, { companyId: base.companyId, periodKey: MONTH, kind: 'mtd', receiptRef: 'RCPT-9911', paidOn: '2026-06-12' });
    const err = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' }).then(
      () => null,
      (e: unknown) => e as PeriodAlreadyFiledError,
    );
    expect(err).toBeInstanceOf(PeriodAlreadyFiledError);
    expect(err!.message).toContain('MTD payment');
    expect(err!.message).toContain('2026-06-12');
    expect(err!.message).toContain('RCPT-9911');
    expect(await owner.db.select().from(schema.statutoryReport)).toHaveLength(0);
  });

  it('a YEAR-keyed filed return (Form E) covers the month and refuses', async () => {
    await regularRun(PRIOR_YEAR_MONTH);
    const rep = await draftReport(PRIOR_YEAR, 'my.cp8d', 'year');
    await markReportFiled(a, { reportId: rep, ackRef: 'E-ACK-ANNUAL', filedOn: TODAY });
    const err = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PRIOR_YEAR_MONTH, runType: 'bonus' }).then(
      () => null,
      (e: unknown) => e as PeriodAlreadyFiledError,
    );
    expect(err).toBeInstanceOf(PeriodAlreadyFiledError);
    expect(err!.message).toContain(`for the year ${PRIOR_YEAR}`);
    expect(err!.evidence[0]).toMatchObject({ covers: 'year', periodKey: PRIOR_YEAR });
    // …AND ITS OPPOSITE: the same filing says nothing about a month in a DIFFERENT year.
    await regularRun(MONTH);
    await expect(
      createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' }),
    ).resolves.toBeTruthy();
  });

  it('(e-guard) a run at run_seq 1 is NEVER refused — a lone monthly run restates nothing', async () => {
    // Filed BEFORE the month is run at all. Contrived, but it is exactly the shape a year-keyed Form E
    // produces for a later month, and r292's judgement is that regenerating a month's ONE run must stay
    // possible or a customer who filed a wrong figure could never correct it.
    const rep = await draftReport();
    await markReportFiled(a, { reportId: rep, ackRef: 'LHDN-ACK-77123', filedOn: '2026-06-10' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: MONTH });
    const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(b.runSeq).toBe(1);
    await expect(generatePayslips(a, { batchId })).resolves.toBeTruthy();
  });

  it('the guard is at BOTH doors: a run created before the filing still refuses at generate', async () => {
    await regularRun();
    // Created while the month is clean…
    const r = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: MONTH, runType: 'bonus' });
    await setPayrollInput(a, { batchId: r.batchId, employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    // …then the return is lodged, and only THEN is the run processed.
    const rep = await draftReport();
    await markReportFiled(a, { reportId: rep, ackRef: 'LHDN-ACK-77123', filedOn: '2026-06-10' });
    const err = await generatePayslips(a, { batchId: r.batchId }).then(
      () => null,
      (e: unknown) => e as PeriodAlreadyFiledError,
    );
    expect(err).toBeInstanceOf(PeriodAlreadyFiledError);
    expect(err!.message).toContain('Processing this run');
    // NOTHING WAS WRITTEN on the refusing path — the guard sits before any figure is computed.
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, r.batchId))).toHaveLength(0);
  });
});

describe('ADR-0085 step 4 · the refusal sentence', () => {
  it('names each filing, says when, and never invents a date or a reference it does not hold', () => {
    expect(describeFiledEvidence([])).toBe('nothing');
    expect(
      describeFiledEvidence([
        { kind: 'statutory-return', what: 'my.cp39', periodKey: '2026-05', covers: 'month', on: '2026-06-10', reference: 'ACK-1' },
      ]),
    ).toBe('return my.cp39 on 2026-06-10 (ref ACK-1)');
    // An absent date SAYS it is absent rather than printing a plausible one; an absent reference is
    // simply omitted (an absent box asserts nothing — CLAUDE.md §8).
    expect(
      describeFiledEvidence([{ kind: 'pcb-payment', what: 'mtd', periodKey: '2026-05', covers: 'month', on: null, reference: null }]),
    ).toBe('a MTD payment (date not recorded)');
    // Bounded: a month with many filings still yields a sentence a person can read.
    const many = Array.from({ length: 5 }, (_, i) => ({
      kind: 'statutory-return' as const, what: `my.r${i}`, periodKey: '2026-05', covers: 'month' as const, on: '2026-06-10', reference: null,
    }));
    expect(describeFiledEvidence(many)).toContain('and 2 more');
  });
});
