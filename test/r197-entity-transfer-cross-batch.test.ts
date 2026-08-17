/**
 * 1b0943d5 / 3c88d593 — Employee Entity Transfer, STAGE TWO: the other half of a transferred month, and
 * the control that refuses to let one be paid without the other.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT ACTUALLY WENT WRONG, AND WHY STAGE ONE PASSING ITS OWN SUITE DID NOT CATCH IT
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Stage one (r194) made a payroll run SEGMENT correctly: given a batch belonging to Fiamma, an employee
 * who transferred out on 11 August is paid for 1–10 August and no more. Every assertion in
 * test/r194-entity-transfer-payroll.test.ts is about ONE run at a time, and every one of them is right.
 *
 * On production, on 2026-08-14, that shipped an underpayment. Employee 100814's August was reprocessed on
 * the ISEDECOR run: 6,600.00 → 4,470.97 (= 6,600 ÷ 31 × 21), correct for the twenty-one days ISEDECOR
 * owns. The Fiamma counterpart for 1–10 August — 2,129.03 — was never created, because **a payroll_batch
 * belongs to ONE company and 2026-08 has EIGHT of them**, and `reprocessSelectedEmployees` recomputes
 * strictly within the one it is given. No single-batch operation can complete a transferred month. The
 * employee was short 2,129.03 and the ONLY reason anybody noticed was that the batch total happened to
 * fall by exactly that amount and somebody was reading it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * SO THE SUBJECT OF THIS FILE IS THE MONTH, NOT THE RUN
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every case below spans MORE THAN ONE BATCH, because a defect that only exists between two batches is
 * invisible to any test that looks at one. What it pins, in the order it matters:
 *
 *   1. THE TILING ARITHMETIC, pure and DB-free. Gap, overlap, exact fit, leading and trailing holes. It
 *      is the whole control, so it is pinned by a table of dates before any payroll runs at all.
 *
 *   2. THE PAYSLIP CAN STATE ITS COVERAGE (migration 0442). Columns, not a jsonb key — because the check
 *      asks the question across several employers' batches at once, and because "01 Aug – 10 Aug 2026"
 *      on the document is the reporter's own requirement. NULL still reads as the whole period, so every
 *      payslip issued before this round is unchanged.
 *
 *   3. THE PRODUCTION SHAPE, END TO END: two companies, two batches, two payslips, contiguous coverage
 *      tiling August exactly, and the two grosses summing to the un-segmented figure.
 *
 *   4. THE REPORTED ERROR IS GONE. "None of the selected employees belong to this run." was thrown by
 *      the membership predicate on the OUTGOING employer's run — the very run that has to produce the
 *      missing half.
 *
 *   5. THE CONTROL REFUSES. A month that does not tile cannot be CLOSED; a run that would strand days on
 *      an already-closed counterpart cannot be PROCESSED at all; and a counterpart that merely has not
 *      caught up yet is MARKED so it cannot be closed either. Today's shortfall would have been caught
 *      by case 3's first assertion; these are what make it impossible to finalise.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE: that the two halves' statutory contributions sum to anything.
 * They must not. Two segments are two independent computations under two employers, each with its own
 * ceilings — see the r194 suite, which pins exactly that. The control is the CALENDAR, not the money.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createMovementEvent } from '../core/movement';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips, reprocessSelectedEmployees } from '../core/payroll';
import {
  PayrollCounterpartClosedError,
  PayrollCoverageIncompleteError,
  coverageDefects,
} from '../core/payroll-coverage';
import { payPeriodBounds, payslipCoverage, payslipSegmentOf } from '../core/payslip-segment';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const AUG = { from: '2026-08-01', to: '2026-08-31' };

// ─────────────────────── 1. the tiling arithmetic, with no database at all ───────────────────────

describe('coverageDefects: does a set of payslips tile the month?', () => {
  it('a single claim over the whole period is complete', () => {
    expect(coverageDefects(AUG, [{ from: '2026-08-01', to: '2026-08-31' }])).toEqual([]);
  });

  it('THE PRODUCTION SHAPE: two contiguous halves tile August exactly', () => {
    // 1–10 Fiamma, 11–31 ISEDECOR. The two ranges TOUCH — 10 August and 11 August are adjacent days —
    // which is the one thing an off-by-one here would get wrong in both directions at once.
    expect(
      coverageDefects(AUG, [
        { from: '2026-08-01', to: '2026-08-10' },
        { from: '2026-08-11', to: '2026-08-31' },
      ]),
    ).toEqual([]);
  });

  it('THE r194 FAULT: the counterpart half missing is a gap, named by its exact days', () => {
    // This is the assertion that was worth the whole round. ISEDECOR paid 11–31 and nothing paid 1–10.
    expect(coverageDefects(AUG, [{ from: '2026-08-11', to: '2026-08-31' }])).toEqual([
      { kind: 'gap', from: '2026-08-01', to: '2026-08-10' },
    ]);
  });

  it('a hole in the middle, and a hole at the end, are both reported', () => {
    expect(
      coverageDefects(AUG, [
        { from: '2026-08-01', to: '2026-08-10' },
        { from: '2026-08-16', to: '2026-08-31' },
      ]),
    ).toEqual([{ kind: 'gap', from: '2026-08-11', to: '2026-08-15' }]);
    expect(coverageDefects(AUG, [{ from: '2026-08-01', to: '2026-08-10' }])).toEqual([
      { kind: 'gap', from: '2026-08-11', to: '2026-08-31' },
    ]);
  });

  it('two employers claiming the same days is an OVERLAP, not a gap', () => {
    // The repair state: the outgoing run has issued its ten days while the incoming run still holds a
    // stale whole-month slip. Nobody is short — somebody is paid twice — and it must be just as loud.
    expect(
      coverageDefects(AUG, [
        { from: '2026-08-01', to: '2026-08-10' },
        { from: '2026-08-01', to: '2026-08-31' },
      ]),
    ).toEqual([{ kind: 'overlap', from: '2026-08-01', to: '2026-08-10' }]);
  });

  it('nothing at all is one gap over the whole period', () => {
    expect(coverageDefects(AUG, [])).toEqual([{ kind: 'gap', ...AUG }]);
  });

  it('claims are clamped to the period, so a slip cannot report days outside the month it belongs to', () => {
    expect(coverageDefects(AUG, [{ from: '2026-07-20', to: '2026-09-05' }])).toEqual([]);
    expect(coverageDefects(AUG, [{ from: '2026-09-01', to: '2026-09-30' }])).toEqual([
      { kind: 'gap', ...AUG },
    ]);
  });
});

// ─────────────────────── 2. the payslip's own coverage, and what NULL means ───────────────────────

describe('payslipCoverage / payslipSegmentOf: three homes, one answer', () => {
  it('the 0442 columns win when they are set', () => {
    expect(
      payslipCoverage({ coverageFrom: '2026-08-01', coverageTo: '2026-08-10', statutory: {} }, AUG),
    ).toEqual({ from: '2026-08-01', to: '2026-08-10' });
  });

  it('a slip written by r194 falls back to its jsonb stamp, so the round does not lose one', () => {
    expect(
      payslipCoverage(
        { coverageFrom: null, coverageTo: null, statutory: { segment: { companyId: 'co', from: '2026-08-11', to: '2026-08-31' } } },
        AUG,
      ),
    ).toEqual({ from: '2026-08-11', to: '2026-08-31' });
  });

  it('NULL columns and no stamp mean THE WHOLE PERIOD — every payslip this system ever issued', () => {
    expect(payslipCoverage({ coverageFrom: null, coverageTo: null, statutory: { epfEmployee: 726 } }, AUG)).toEqual(AUG);
    expect(payslipCoverage({}, AUG)).toEqual(AUG);
    // A half-set pair cannot produce a one-ended range the tiling could not compare.
    expect(payslipCoverage({ coverageFrom: '2026-08-01', coverageTo: null }, AUG)).toEqual(AUG);
  });

  it('"segmented" means NARROWER than the period, and nothing else', () => {
    // The rule the screen and both PDF routes render on. A whole-month slip is not segmented however it
    // records its coverage, so an ordinary payslip prints exactly what it printed before this item.
    expect(payslipSegmentOf({ coverageFrom: '2026-08-01', coverageTo: '2026-08-31' }, '2026-08')).toBeNull();
    expect(payslipSegmentOf({ coverageFrom: null, coverageTo: null }, '2026-08')).toBeNull();
    expect(payslipSegmentOf({ coverageFrom: '2026-08-01', coverageTo: '2026-08-10' }, '2026-08')).toEqual({
      from: '2026-08-01',
      to: '2026-08-10',
    });
  });

  it('payPeriodBounds knows February and refuses anything that is not a period', () => {
    expect(payPeriodBounds('2026-08')).toEqual(AUG);
    expect(payPeriodBounds('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' }); // leap
    expect(payPeriodBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(payPeriodBounds('2026-13')).toBeNull();
    expect(payPeriodBounds('August')).toBeNull();
  });
});

// ─────────────────────── 3. the migration is a journal entry, not a file ───────────────────────

describe('migration 0442', () => {
  it('is on disk AND in the journal, with a `when` above every entry before it', () => {
    const root = process.cwd();
    const journal = JSON.parse(
      fs.readFileSync(path.join(root, 'db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const e = journal.entries.find((x) => x.tag === '0442_payslip_coverage_dates');
    expect(e, 'journal entry for 0442').toBeTruthy();
    expect(fs.existsSync(path.join(root, 'db/migrations/0442_payslip_coverage_dates.sql'))).toBe(true);
    const maxBefore = Math.max(...journal.entries.filter((x) => x.idx < e!.idx).map((x) => x.when));
    expect(e!.when).toBeGreaterThan(maxBefore);
  });

  it('adds the columns NULLABLE, so no existing payslip can be invalidated by it', () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'db/migrations/0442_payslip_coverage_dates.sql'),
      'utf8',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "coverage_from" date');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "coverage_to" date');
    expect(sql).not.toMatch(/coverage_(from|to)"?\s+date\s+not null/i);
  });
});

// ─────────────────────── 4–6. the month, across two employers' batches ───────────────────────

describe('a transferred month, across the two batches that own it', () => {
  let b: Base;
  let a: SessionContext;
  /** The DESTINATION legal entity — the production shape is Fiamma (b.companyId) → ISEDECOR BINA. */
  let coB: string;
  let deptB2: string;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(closeAll);

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    a = await entitledCtx(b);
    const [co] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'ISEDECOR BINA SDN BHD' })
      .returning({ id: schema.company.id });
    coB = co.id;
    const [d] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: coB, name: 'Bina Operations' })
      .returning({ id: schema.department.id });
    deptB2 = d.id;
  });

  const email = () => `r197_${randomUUID().slice(0, 8)}@t.local`;

  async function hireInto(companyId: string, departmentId: string, hiredOn: string, ic: string) {
    const hire = await hireEmployee(a, {
      person: { fullName: 'Segment Subject', primaryEmail: email() },
      companyId,
      departmentId,
      employmentType: 'full_time',
      hiredOn,
    });
    await setStatutoryProfileMY(a, {
      personId: hire.personId,
      icNumber: ic,
      bankName: 'Maybank',
      bankAccountNo: '1234567890',
    });
    await setCompensation(a, {
      employmentId: hire.employmentId,
      basicSalary: 6600,
      monthlyAllowance: 0,
      effectiveFrom: hiredOn,
    });
    return hire;
  }

  const transferOn = (employmentId: string, effectiveDate: string) =>
    createMovementEvent(a, { employmentId, kind: 'entityTransfer', effectiveDate, companyId: coB, departmentId: deptB2 });

  const slipOf = async (batchId: string, employmentId: string) => {
    const [row] = await owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    return row ?? null;
  };

  const batchRow = async (batchId: string) => {
    const [row] = await owner.db
      .select()
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.id, batchId));
    return row;
  };

  // ── 4. the production shape, end to end ────────────────────────────────────────────────────────

  it('TWO PAYSLIPS, CONTIGUOUS DATES, AND THE TWO HALVES SUM TO THE WHOLE MONTH', async () => {
    // Employee 100814's shape exactly: Fiamma → ISEDECOR BINA effective 11 August 2026, on 6,600.00.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010701');
    // …and a colleague who did not move, as the un-segmented control the two halves must sum to.
    const stayed = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010702');
    await transferOn(moved.employmentId, '2026-08-11');

    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });

    const out = (await slipOf(outgoing.batchId, moved.employmentId))!;
    const inc = (await slipOf(incoming.batchId, moved.employmentId))!;
    const control = (await slipOf(outgoing.batchId, stayed.employmentId))!;
    expect(out, 'the OUTGOING employer must have a payslip — this is the half r194 never created').toBeTruthy();
    expect(inc).toBeTruthy();

    // (a) each names its own days, in COLUMNS a query can read across batches (migration 0442).
    expect([out.coverageFrom, out.coverageTo]).toEqual(['2026-08-01', '2026-08-10']);
    expect([inc.coverageFrom, inc.coverageTo]).toEqual(['2026-08-11', '2026-08-31']);
    // …and the unsegmented colleague's slip records the whole month rather than nothing, so the tiling
    // check never has to guess what an unstamped row means.
    expect([control.coverageFrom, control.coverageTo]).toEqual(['2026-08-01', '2026-08-31']);

    // (b) the two windows are contiguous and cover August exactly — no gap, no overlap.
    expect(
      coverageDefects(AUG, [
        { from: out.coverageFrom!, to: out.coverageTo! },
        { from: inc.coverageFrom!, to: inc.coverageTo! },
      ]),
    ).toEqual([]);

    // (c) and the arithmetic adds up: 6600 ÷ 31 × 10 + 6600 ÷ 31 × 21 = a full month, measured against a
    //     colleague on the same salary whose month was never split. A split that prorated each segment
    //     against its OWN length would pay 1.0 + 1.0 and is the most likely way to get this wrong.
    expect(Number(out.grossPay)).toBeCloseTo(2129.03, 2);
    expect(Number(inc.grossPay)).toBeCloseTo(4470.97, 2);
    expect(Number(out.grossPay) + Number(inc.grossPay)).toBeCloseTo(Number(control.grossPay), 2);

    // (d) with both halves issued, the month tiles — so each employer may finalise its own run.
    await closeBatch(a, { batchId: outgoing.batchId });
    expect((await batchRow(outgoing.batchId)).status).toBe('closed');
  });

  // ── 5. the reported error ───────────────────────────────────────────────────────────────────────

  it('THE REPORTED ERROR IS GONE: the OUTGOING run accepts a reprocess of the transferred employee', async () => {
    // "None of the selected employees belong to this run." — thrown by reprocessSelectedEmployees'
    // membership predicate on the Fiamma run, because 100814's company column had already moved to
    // ISEDECOR. That run is precisely the one that has to produce the missing 1–10 August half, so the
    // error made the fix unreachable from the screen the reporter was standing on.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010703');
    await transferOn(moved.employmentId, '2026-08-11');

    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });

    const r = await reprocessSelectedEmployees(a, {
      batchId: outgoing.batchId,
      employmentIds: [moved.employmentId],
      reason: 'r197 regression',
    });
    expect(r.status).toBe('completed');

    // …and the recomputed slip still owns exactly its ten days, at a bumped version.
    const out = (await slipOf(outgoing.batchId, moved.employmentId))!;
    expect([out.coverageFrom, out.coverageTo]).toEqual(['2026-08-01', '2026-08-10']);
    expect(out.version).toBe(2);
  });

  // ── 6. the control ──────────────────────────────────────────────────────────────────────────────

  it('REFUSES TO FINISH WITH ONLY ONE: a month missing its counterpart cannot be closed', async () => {
    // Exactly r194's end state, reproduced: the incoming employer has paid its twenty-one days and the
    // outgoing employer's ten days do not exist anywhere. Generation is allowed — the other company's run
    // legitimately has not happened yet, and refusing here would deadlock the pair, since whichever ran
    // first would be blocked by the one that had not. CLOSE is where every excuse has expired.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010704');
    await transferOn(moved.employmentId, '2026-08-11');

    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });
    const inc = (await slipOf(incoming.batchId, moved.employmentId))!;
    expect([inc.coverageFrom, inc.coverageTo]).toEqual(['2026-08-11', '2026-08-31']);

    await expect(closeBatch(a, { batchId: incoming.batchId })).rejects.toThrow(PayrollCoverageIncompleteError);
    // …and it says WHO, so the message can send the operator straight to them.
    await closeBatch(a, { batchId: incoming.batchId }).catch((e) => {
      expect((e as PayrollCoverageIncompleteError).employmentIds).toEqual([moved.employmentId]);
      expect((e as PayrollCoverageIncompleteError).problems[0].defects).toEqual([
        { kind: 'gap', from: '2026-08-01', to: '2026-08-10' },
      ]);
    });
    // The refusal changed nothing: a refused close must leave the run exactly as it was.
    expect((await batchRow(incoming.batchId)).status).toBe('processed');
  });

  it('MARKS THE COUNTERPART RUN, so the half it owes cannot be quietly left out', async () => {
    // The repair path, and the state production is actually in: the outgoing employer's August was
    // processed BEFORE anyone knew about the transfer, so it holds a whole-month slip. Running the
    // incoming employer now makes that slip wrong — and this is where r194 went silent.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010705');
    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    expect(Number((await slipOf(outgoing.batchId, moved.employmentId))!.grossPay)).toBeCloseTo(6600, 2);

    await transferOn(moved.employmentId, '2026-08-11');
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });

    // 1. the outgoing run is now flagged, BY NAME, as owing a recalculation for this employee…
    const flagged = await batchRow(outgoing.batchId);
    expect(flagged.needsRecalcAt).not.toBeNull();
    expect(flagged.recalcEmploymentIds).toContain(moved.employmentId);

    // 2. …neither run can be closed while the month is double-claimed (1–31 and 11–31 overlap)…
    await expect(closeBatch(a, { batchId: incoming.batchId })).rejects.toThrow(PayrollCoverageIncompleteError);

    // 3. …and the fix is the reprocess the flag points at. Afterwards the month tiles and both close.
    await reprocessSelectedEmployees(a, {
      batchId: outgoing.batchId,
      employmentIds: [moved.employmentId],
      reason: 'entity transfer counterpart',
    });
    const out = (await slipOf(outgoing.batchId, moved.employmentId))!;
    const inc = (await slipOf(incoming.batchId, moved.employmentId))!;
    expect([out.coverageFrom, out.coverageTo]).toEqual(['2026-08-01', '2026-08-10']);
    expect(
      coverageDefects(AUG, [
        { from: out.coverageFrom!, to: out.coverageTo! },
        { from: inc.coverageFrom!, to: inc.coverageTo! },
      ]),
    ).toEqual([]);
    expect(Number(out.grossPay) + Number(inc.grossPay)).toBeCloseTo(6600, 2);
    await closeBatch(a, { batchId: outgoing.batchId });
    expect((await batchRow(outgoing.batchId)).status).toBe('closed');
  });

  it('REFUSES TO PROCESS AT ALL when the counterpart run is already CLOSED and can never take the days', async () => {
    // The one shape that is unrecoverable rather than merely incomplete, and therefore the one refused
    // before anything commits. The outgoing employer closed August — a closed run is frozen — and only
    // afterwards was the transfer recorded, backdated to the 11th. Processing the incoming employer now
    // would issue 11–31 and leave 1–10 owed by a run that can no longer be written to.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010706');
    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    await closeBatch(a, { batchId: outgoing.batchId });
    expect((await batchRow(outgoing.batchId)).status).toBe('closed');

    await transferOn(moved.employmentId, '2026-08-11');
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await expect(generatePayslips(a, { batchId: incoming.batchId })).rejects.toThrow(PayrollCounterpartClosedError);

    // NOTHING COMMITTED. The refusal is thrown inside the generation transaction, so the run is still a
    // draft with no payslips at all — "refuse rather than commit a partial set", taken literally.
    expect((await batchRow(incoming.batchId)).status).toBe('draft');
    expect(await slipOf(incoming.batchId, moved.employmentId)).toBeNull();
  });

  it('leaves an ORDINARY month completely alone — no marks, no refusals, no new events', async () => {
    // The additive guarantee, stated as a test rather than as a comment. Two companies, two runs, nobody
    // transferred: every employment resolves to ONE entity segment, so the control does not examine a
    // single one of them and both runs close exactly as they did before this round.
    const here = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010707');
    const there = await hireInto(coB, deptB2, '2026-01-01', '900101010708');

    const one = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: one.batchId });
    const two = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: two.batchId });

    expect(Number((await slipOf(one.batchId, here.employmentId))!.grossPay)).toBeCloseTo(6600, 2);
    expect(Number((await slipOf(two.batchId, there.employmentId))!.grossPay)).toBeCloseTo(6600, 2);
    expect((await batchRow(one.batchId)).needsRecalcAt).toBeNull();
    expect((await batchRow(two.batchId)).needsRecalcAt).toBeNull();
    const noise = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'payroll-batch.segment-coverage-incomplete'));
    expect(noise).toHaveLength(0);
    await closeBatch(a, { batchId: one.batchId });
    await closeBatch(a, { batchId: two.batchId });
    expect((await batchRow(one.batchId)).status).toBe('closed');
    expect((await batchRow(two.batchId)).status).toBe('closed');
  });
});
