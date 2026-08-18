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
 *   6. AND IT REFUSES IN THE TWO SHAPES THAT LOOK FINE FROM THE CALENDAR, each of which let a month
 *      close with somebody underpaid while every earlier assertion in this file still passed:
 *      a DRAFT counterpart run (a batch that exists is not a payment), and an employment with NO PAYSLIP
 *      on the closing run (the examined population is the employer's obligation, not the run's output —
 *      an employee dropped from both scopes was paid nothing and refused by nothing). Plus the resolver
 *      shape underneath them: a mid-month hire that also transfers must resolve to two ADJACENT segments
 *      inside its own tenure, not three spanning a month the person was not employed for.
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
import { createMovementEvent, editMovementEvent, movementHistory, reverseMovementEvent } from '../core/movement';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  closeBatch,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  reprocessSelectedEmployees,
} from '../core/payroll';
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

  it('declares its index AND its CHECK in db/schema.ts too, not only in the .sql', () => {
    // Source-shape, because the defect lives in the gap between two files and neither one is wrong on its
    // own. `db/schema.ts` is what drizzle-kit DIFFS the database against: an object that exists only in a
    // hand-written migration reads as drift, and the next generated migration proposes DROPPING it. This
    // repo already declares both kinds in the ORM schema (`check()` appears a dozen times), so the rule is
    // the repo's own, not a new one — 0442 simply had to follow it.
    const src = fs.readFileSync(path.join(process.cwd(), 'db/schema.ts'), 'utf8');
    expect(src, 'payslip_employment_idx must be declared in the ORM schema').toMatch(
      /index\('payslip_employment_idx'\)/,
    );
    expect(src, 'payslip_coverage_ordered must be declared in the ORM schema').toMatch(
      /check\(\s*'payslip_coverage_ordered'/,
    );
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

  // ── 7. the two holes the control had, each of which let a month close with somebody underpaid ──────

  it('A DRAFT COUNTERPART IS NOT PAYMENT: a run that merely EXISTS does not let the month close', async () => {
    // THE ORDINARY SEQUENCE THAT CLOSED CLEAN. Fiamma's August is processed BEFORE anybody records the
    // transfer, so it holds a WHOLE-MONTH slip. The transfer to ISEDECOR effective 11 August is then
    // recorded, and ISEDECOR's run is opened — and left in DRAFT, which is where a run sits for most of
    // its life. Now look at what the calendar test sees: every day of August IS claimed (by Fiamma, for
    // twenty-one days it does not own), so there is no gap and no overlap; and ISEDECOR is not a
    // "missing company" because a batch for it exists. Both of those arms pass. The employee is owed
    // 11–31 August by an employer that has issued nothing, and the close was allowed.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010709');
    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    expect([
      (await slipOf(outgoing.batchId, moved.employmentId))!.coverageFrom,
      (await slipOf(outgoing.batchId, moved.employmentId))!.coverageTo,
    ]).toEqual(['2026-08-01', '2026-08-31']);

    await transferOn(moved.employmentId, '2026-08-11');
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    expect((await batchRow(incoming.batchId)).status).toBe('draft');
    expect(await slipOf(incoming.batchId, moved.employmentId)).toBeNull();

    await expect(closeBatch(a, { batchId: outgoing.batchId })).rejects.toThrow(PayrollCoverageIncompleteError);
    await closeBatch(a, { batchId: outgoing.batchId }).catch((e) => {
      const problem = (e as PayrollCoverageIncompleteError).problems[0];
      // …and this is the point of the case: NEITHER of the arms that existed before fires. The refusal
      // comes from the third question — "has each segment's employer issued exactly the days it owes?"
      expect(problem.defects, 'the calendar test alone is satisfied').toEqual([]);
      expect(problem.missingCompanyIds, 'and so is the missing-run test').toEqual([]);
      expect(problem.counterparts.map((c) => [c.companyId, c.status, c.stale])).toEqual([
        [b.companyId, 'processed', true], // issued 01–31 where it owes 01–10
        [coB, 'draft', true], // owes 11–31 and has issued nothing
      ]);
    });
    expect((await batchRow(outgoing.batchId)).status).toBe('processed');

    // The way OUT is issuing the payslip, never opening a run. Generate ISEDECOR's half, reprocess the
    // Fiamma slip the transfer invalidated, and the same close is allowed.
    await generatePayslips(a, { batchId: incoming.batchId });
    await reprocessSelectedEmployees(a, {
      batchId: outgoing.batchId,
      employmentIds: [moved.employmentId],
      reason: 'entity transfer counterpart',
    });
    await closeBatch(a, { batchId: outgoing.batchId });
    expect((await batchRow(outgoing.batchId)).status).toBe('closed');
  });

  it('EXAMINES WHO THE MONTH SAYS IT OWES, not whom the run happened to pay', async () => {
    // THE SECOND HOLE, and it is the operator's natural escape route from the first. The population the
    // control examined came from the CLOSING RUN'S OWN PAYSLIPS — so an employment with no slip on the
    // run was never examined, which is precisely the employment being underpaid.
    //
    //   the outgoing run is scoped and the mover is left out → it closed with no refusal at all;
    //   the incoming run is then refused (its counterpart is frozen) → and dropping the mover from the
    //   incoming scope too closed BOTH runs clean, with the employee paid nothing whatever for August.
    //
    // The question has to be the employer's OBLIGATION — who does the entity history say this company
    // employed during this period — not the run's output.
    const stayer = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010710');
    const there = await hireInto(coB, deptB2, '2026-01-01', '900101010711');
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010712');
    await transferOn(moved.employmentId, '2026-08-11');

    const outgoing = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-08',
      scope: { employmentIds: [stayer.employmentId] },
    });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const incoming = await createBatch(a, {
      companyId: coB,
      payPeriod: '2026-08',
      scope: { employmentIds: [there.employmentId] },
    });
    await generatePayslips(a, { batchId: incoming.batchId });

    // Nobody has paid the mover a cent, and neither run holds a slip that could be inspected for them.
    expect(await slipOf(outgoing.batchId, moved.employmentId)).toBeNull();
    expect(await slipOf(incoming.batchId, moved.employmentId)).toBeNull();

    // Both runs are refused, and both name the same person — the one neither of them paid.
    for (const batchId of [outgoing.batchId, incoming.batchId]) {
      await expect(closeBatch(a, { batchId })).rejects.toThrow(PayrollCoverageIncompleteError);
      await closeBatch(a, { batchId }).catch((e) => {
        expect((e as PayrollCoverageIncompleteError).employmentIds).toEqual([moved.employmentId]);
        expect((e as PayrollCoverageIncompleteError).problems[0].defects).toEqual([
          { kind: 'gap', from: '2026-08-01', to: '2026-08-31' },
        ]);
      });
      expect((await batchRow(batchId)).status).toBe('processed');
    }
  });

  it('A MID-MONTH HIRE THAT TRANSFERS THE SAME MONTH IS TWO ADJACENT SEGMENTS, NOT THREE', async () => {
    // Hired into Fiamma on 3 August, moved to ISEDECOR on the 11th. The resolver used to fill every
    // uncovered day of the window with the employment's CURRENT company, so this month resolved as
    // ISEDECOR[01–02], Fiamma[03–10], ISEDECOR[11–31] — the same entity twice, non-adjacent so the merge
    // could not join them, and claiming days before the person was hired. `segmentForCompany` then handed
    // ISEDECOR's run the FIRST of its two ranges, 01–02, whose end falls before the hire date: ISEDECOR
    // prorated an empty window and paid for none of the twenty-one days it actually owned, while Fiamma
    // paid its eight. The window has to be the employment's own dates.
    const moved = await hireInto(b.companyId, b.deptA, '2026-08-03', '900101010713');
    // …and an identical colleague hired the same day who never moved, as the control the halves sum to.
    const control = await hireInto(b.companyId, b.deptA, '2026-08-03', '900101010714');
    await transferOn(moved.employmentId, '2026-08-11');

    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });

    const out = (await slipOf(outgoing.batchId, moved.employmentId))!;
    const inc = (await slipOf(incoming.batchId, moved.employmentId))!;
    expect([out.coverageFrom, out.coverageTo]).toEqual(['2026-08-03', '2026-08-10']);
    expect([inc.coverageFrom, inc.coverageTo]).toEqual(['2026-08-11', '2026-08-31']);

    // The tiling is over the days the person was EMPLOYED for — 03–31 — not over the calendar month.
    // Demanding they tile all of August would report the days before the hire as an unpaid stretch.
    expect(
      coverageDefects({ from: '2026-08-03', to: '2026-08-31' }, [
        { from: out.coverageFrom!, to: out.coverageTo! },
        { from: inc.coverageFrom!, to: inc.coverageTo! },
      ]),
    ).toEqual([]);

    // And the money follows the calendar: twenty-nine days between two employers, measured against the
    // colleague hired on the same day whose month was never split.
    const ctrl = (await slipOf(outgoing.batchId, control.employmentId))!;
    expect(Number(out.grossPay), 'Fiamma owes 3–10 August: 6600 ÷ 31 × 8').toBeCloseTo(1703.23, 2);
    expect(Number(inc.grossPay), 'ISEDECOR owes 11–31 August: 6600 ÷ 31 × 21').toBeCloseTo(4470.97, 2);
    // …and the two halves reconstruct the control's twenty-nine days TO THE CENT. Not to the exact
    // figure: the halves are two independent computations under two employers, each rounded to a cent, so
    // one rounding step of difference is arithmetic rather than a defect. A lost week is not.
    // (compared in whole cents — the difference of three floats is not itself a money figure)
    const centsApart = Math.round(
      Math.abs(Number(out.grossPay) + Number(inc.grossPay) - Number(ctrl.grossPay)) * 100,
    );
    expect(centsApart).toBeLessThanOrEqual(1);
    // …so the month adds up and both employers may finalise.
    await closeBatch(a, { batchId: outgoing.batchId });
    await closeBatch(a, { batchId: incoming.batchId });
    expect((await batchRow(outgoing.batchId)).status).toBe('closed');
    expect((await batchRow(incoming.batchId)).status).toBe('closed');
  });
  // ── 8. the history moved AFTER the payslips were written ─────────────────────────────────────────

  const entityMovementId = async (employmentId: string) => {
    const rows = await movementHistory(a, employmentId);
    return rows.find((r) => r.kind === 'entityTransfer')!.id;
  };

  it('A ROLLED-BACK TRANSFER DOES NOT ERASE THE HALF-PAID MONTH FROM THE CONTROL', async () => {
    // THE THIRD TIME THE SAME DEFECT: a signal computed and never read. Everything the control asks is
    // asked of TODAY'S entity history — so a correction made AFTER the outgoing run is processed removes
    // the underpaid employment from the examined population altogether, and every arm passes by never
    // being reached. Each step here is a first-class supported operation.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010715');
    await transferOn(moved.employmentId, '2026-08-11');

    // 1. Fiamma's August is generated while the transfer stands, and its slip is CORRECT: ten days.
    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const out = (await slipOf(outgoing.batchId, moved.employmentId))!;
    expect([out.coverageFrom, out.coverageTo]).toEqual(['2026-08-01', '2026-08-10']);
    expect(Number(out.grossPay)).toBeCloseTo(2129.03, 2);

    // 2. …and the movement is then ROLLED BACK. `reverseLegTx` supersedes the assignment leg and puts
    //    `employment.company_id` back in the same transaction, which is the whole point of a rollback.
    await reverseMovementEvent(a, {
      employmentId: moved.employmentId,
      movementId: await entityMovementId(moved.employmentId),
      reason: 'keyed against the wrong employee',
    });
    const [emp] = await owner.db
      .select({ companyId: schema.employment.companyId })
      .from(schema.employment)
      .where(eq(schema.employment.id, moved.employmentId));
    expect(emp.companyId, 'the rollback put the employment back under Fiamma').toBe(b.companyId);

    // 3. August now resolves to ONE segment — Fiamma for all thirty-one days — so the split-only fast
    //    path drops this employment before any arm is evaluated. That is the hole: Fiamma employed them
    //    the whole month and its run has issued ten days of it, and nothing else in the system would
    //    notice. No movement or entity-history path marks a processed run, so needs-recalculation does
    //    not cover it either. WHAT SAVES IT is the slip: a payslip narrower than its own period is a
    //    claim that the month was split, and it is read as one.
    await expect(closeBatch(a, { batchId: outgoing.batchId })).rejects.toThrow(PayrollCoverageIncompleteError);
    await closeBatch(a, { batchId: outgoing.batchId }).catch((e) => {
      const problem = (e as PayrollCoverageIncompleteError).problems[0];
      expect(problem.employmentId).toBe(moved.employmentId);
      expect(problem.expected.map((seg) => [seg.companyId, seg.from, seg.to])).toEqual([
        [b.companyId, '2026-08-01', '2026-08-31'],
      ]);
      expect(problem.defects, 'the twenty-one days nobody now claims').toEqual([
        { kind: 'gap', from: '2026-08-11', to: '2026-08-31' },
      ]);
      expect(problem.counterparts.map((c) => [c.companyId, c.stale])).toEqual([[b.companyId, true]]);
    });
    expect((await batchRow(outgoing.batchId)).status).toBe('processed');

    // 4. And the way out is the recalculation the refusal points at: the whole month, on one slip, under
    //    the only employer the history now names.
    await reprocessSelectedEmployees(a, {
      batchId: outgoing.batchId,
      employmentIds: [moved.employmentId],
      reason: 'entity transfer rolled back',
    });
    const fixed = (await slipOf(outgoing.batchId, moved.employmentId))!;
    expect([fixed.coverageFrom, fixed.coverageTo]).toEqual(['2026-08-01', '2026-08-31']);
    expect(Number(fixed.grossPay)).toBeCloseTo(6600, 2);
    await closeBatch(a, { batchId: outgoing.batchId });
    expect((await batchRow(outgoing.batchId)).status).toBe('closed');
  });

  it('AND SO DOES RE-DATING ONE: an ordinary fat-finger fix moves the month out from under the slip', async () => {
    // The same hole reached without any rollback at all. The transfer is real and stays recorded — only
    // its effective date is corrected, from 11 August to 11 September, which is the most ordinary
    // correction there is. August then resolves to a single Fiamma segment exactly as above while
    // Fiamma's run still holds a ten-day slip.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010716');
    await transferOn(moved.employmentId, '2026-08-11');
    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    expect([
      (await slipOf(outgoing.batchId, moved.employmentId))!.coverageFrom,
      (await slipOf(outgoing.batchId, moved.employmentId))!.coverageTo,
    ]).toEqual(['2026-08-01', '2026-08-10']);

    await editMovementEvent(a, {
      movementId: await entityMovementId(moved.employmentId),
      employmentId: moved.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-09-11',
      companyId: coB,
      departmentId: deptB2,
      reason: 'effective date keyed a month early',
    });

    await expect(closeBatch(a, { batchId: outgoing.batchId })).rejects.toThrow(PayrollCoverageIncompleteError);
    await closeBatch(a, { batchId: outgoing.batchId }).catch((e) => {
      const problem = (e as PayrollCoverageIncompleteError).problems[0];
      expect(problem.employmentId).toBe(moved.employmentId);
      expect(problem.defects).toEqual([{ kind: 'gap', from: '2026-08-11', to: '2026-08-31' }]);
    });
    expect((await batchRow(outgoing.batchId)).status).toBe('processed');
  });

  it('AN ADDITIONAL RUN IS NOT REFUSED OVER DAYS IT OWES NOTHING TO', async () => {
    // The control is a REGULAR-run question. A bonus run pays extra money over days the regular run
    // already owns — core/payroll-coverage.ts does not count its payslips as claims, so closing one can
    // neither open a hole in the month nor fill one. Ungated, the refusal fired on it anyway, and the
    // operator standing on the bonus run could do nothing about it from there.
    const moved = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010717');
    await transferOn(moved.employmentId, '2026-08-11');
    const regular = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: regular.batchId });

    // ISEDECOR has no run at all, so August does not tile and the REGULAR run is refused — unchanged.
    await expect(closeBatch(a, { batchId: regular.batchId })).rejects.toThrow(PayrollCoverageIncompleteError);

    // The bonus run for the same company and month closes, and closing it cascades nothing: the pay
    // period stays open because its regular run is still processed.
    const bonus = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: '2026-08', runType: 'bonus' });
    await generatePayslips(a, { batchId: bonus.batchId });
    await closeBatch(a, { batchId: bonus.batchId });
    expect((await batchRow(bonus.batchId)).status).toBe('closed');
    const [period] = await owner.db
      .select({ status: schema.payPeriod.status })
      .from(schema.payPeriod)
      .where(and(eq(schema.payPeriod.companyId, b.companyId), eq(schema.payPeriod.period, '2026-08')));
    expect(period.status).not.toBe('closed');

    // …and the regular run is still refused afterwards: nothing about the bonus run's close satisfied it.
    await expect(closeBatch(a, { batchId: regular.batchId })).rejects.toThrow(PayrollCoverageIncompleteError);
  });
});
