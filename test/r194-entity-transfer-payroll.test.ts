/**
 * 3c88d593 — Employee Entity Transfer, STAGE ONE: the legal entity becomes an effective-dated fact, and a
 * payroll month containing a transfer splits into two segments and two payslips.
 *
 * WHAT WAS REPRODUCED ON PRODUCTION BEFORE ANY OF THIS WAS WRITTEN (2026-08-13, read-only). Employee
 * 100814 transferred from Fiamma to ISEDECOR BINA effective 11 August 2026. August produced ONE payslip,
 * for the whole month, entirely under ISEDECOR — nothing at all under Fiamma for 1–10 August. The cause
 * was not payroll ignoring the transfer date: `employment.company_id` is a single mutable value, so once
 * the transfer overwrote it there was nothing left to look up. `assignment` already versioned position,
 * department, cost centre, business unit, location and employment type; the entity was the one dimension
 * missing from it, and migration 0440 adds it.
 *
 * WHAT THIS SUITE PINS, in the order it matters:
 *
 *   1. THE RESOLVER'S DATE ARITHMETIC, with no database at all. `mergeCompanySegments` is pure, so the
 *      rules that decide where a month splits — exclusive valid_to, adjacent same-entity rows merging,
 *      gaps filling from today's column, zero-length rows contributing nothing — are pinned by a table of
 *      dates rather than by a payroll run. Every later assertion depends on these being right.
 *
 *   2. THE WRITER. An Entity Transfer now records the entity ON the dated spine, not only in the column.
 *      Without this the migration would be a dead column and the backfill a one-off.
 *
 *   3. THE SPLIT ITSELF, end to end: two runs, two payslips, each naming its own entity and its own date
 *      range, and — the assertion that would have caught the original fault — the OUTGOING entity's run
 *      still sees an employee whose company column has already moved on.
 *
 *   4. THE ARITHMETIC ADDS UP. The two segments prorate against the SAME monthly denominator, so they sum
 *      to one month's salary. A split that produced 1.0 + 1.0 (each segment prorating against its own
 *      length) would pay the employee twice and is the most likely way to get this wrong.
 *
 *   5. TWO INDEPENDENT STATUTORY COMPUTATIONS, each on its own wage portion with its own ceiling — NOT one
 *      halved. This falls out of the architecture (a batch belongs to one company, so two segments are two
 *      runs) rather than from a code path, which is exactly why it is asserted: an architectural guarantee
 *      nobody checks is a comment.
 *
 *   6. NOTHING ELSE MOVES. An employee who did not transfer is byte-identical, and so is an employee whose
 *      entity history exists but never changes — the post-backfill steady state for ~every employment.
 *
 * OUT OF SCOPE, DELIBERATELY (stage two): attendance, leave and reporting reading the resolver. The plan
 * says the resolver must be proven on payroll before a dozen call sites adopt it.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createMovementEvent } from '../core/movement';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  companyOnDate,
  companySegmentsForPeriod,
  mergeCompanySegments,
  segmentForCompany,
} from '../core/employment-company';
import { withTenant } from '../db/client';
// The backfill is rehearsed HERE, against a real cluster, because it must NOT be run against production
// blind and because "idempotent" is a claim only a second run can settle.
import { companyAt, replayTimeline, runBackfill } from '../scripts/backfill-assignment-company';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
/** The DESTINATION legal entity and the org master data an entity transfer must land on. */
let coB: string;
let deptB2: string;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
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

const email = () => `ent_${randomUUID().slice(0, 8)}@t.local`;

async function hireInto(companyId: string, departmentId: string, hiredOn: string, ic: string) {
  const a = adminCtx(b);
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

const payslipsOf = (batchId: string) =>
  owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

const assignmentsOf = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.assignment)
    .where(and(eq(schema.assignment.employmentId, employmentId), isNull(schema.assignment.supersededAt)))
    .orderBy(schema.assignment.validFrom);

// ─────────────────────── 1. the date arithmetic, with no database ───────────────────────

describe('the resolver: merged, gap-filled, non-overlapping entity segments', () => {
  const CUR = 'current-co';
  const A = 'co-a';
  const B2 = 'co-b';

  it('no history at all ⇒ ONE segment on the current company (the pre-backfill steady state)', () => {
    expect(mergeCompanySegments([], CUR, '2026-08-01', '2026-08-31')).toEqual([
      { companyId: CUR, from: '2026-08-01', to: '2026-08-31' },
    ]);
  });

  it('splits at the transfer date, and valid_to is EXCLUSIVE — the 11th belongs to the NEW entity', () => {
    // The writers CLOSE the outgoing version at the effective date and OPEN the new one on the same day
    // (daterange '[)' — migration 0001's assignment_no_overlap depends on it). So a transfer effective
    // 2026-08-11 means the old entity's last paid day is the 10th, not the 11th. Getting this backwards
    // is a one-day overpayment on one side and a one-day underpayment on the other.
    const rows = [
      { companyId: A, from: '2026-07-23', to: '2026-08-10' }, // valid_to 2026-08-11, exclusive
      { companyId: B2, from: '2026-08-11', to: null },
    ];
    expect(mergeCompanySegments(rows, B2, '2026-08-01', '2026-08-31')).toEqual([
      { companyId: A, from: '2026-08-01', to: '2026-08-10' },
      { companyId: B2, from: '2026-08-11', to: '2026-08-31' },
    ]);
  });

  it('MERGES adjacent versions naming the same entity — a department move is not an entity move', () => {
    // Without the merge, a department transfer mid-month would split the payroll month into two segments
    // of ONE company and produce two payslips for one employer: the exact opposite of this item's intent.
    const rows = [
      { companyId: A, from: '2026-08-01', to: '2026-08-14' },
      { companyId: A, from: '2026-08-15', to: null },
    ];
    expect(mergeCompanySegments(rows, A, '2026-08-01', '2026-08-31')).toEqual([
      { companyId: A, from: '2026-08-01', to: '2026-08-31' },
    ]);
  });

  it('FILLS a leading gap from the current column rather than dropping the days', () => {
    // An employment backfilled only from its transfer onward has no row covering 1–10. Those days are not
    // "unemployed"; they are unrecorded, and today's column is the only answer available for them.
    const rows = [{ companyId: B2, from: '2026-08-11', to: null }];
    expect(mergeCompanySegments(rows, B2, '2026-08-01', '2026-08-31')).toEqual([
      { companyId: B2, from: '2026-08-01', to: '2026-08-31' },
    ]);
    // …and when the fallback differs from the recorded row, both appear, in order.
    expect(mergeCompanySegments(rows, A, '2026-08-01', '2026-08-31')).toEqual([
      { companyId: A, from: '2026-08-01', to: '2026-08-10' },
      { companyId: B2, from: '2026-08-11', to: '2026-08-31' },
    ]);
  });

  it('a zero-length version contributes nothing (a movement dated on the day a version started)', () => {
    const rows = [
      { companyId: A, from: '2026-08-01', to: '2026-08-14' },
      { companyId: A, from: '2026-08-15', to: '2026-08-14' }, // closed on the day it opened
      { companyId: B2, from: '2026-08-15', to: null },
    ];
    expect(mergeCompanySegments(rows, B2, '2026-08-01', '2026-08-31')).toEqual([
      { companyId: A, from: '2026-08-01', to: '2026-08-14' },
      { companyId: B2, from: '2026-08-15', to: '2026-08-31' },
    ]);
  });

  it('segments are clipped to the asked-for window, never widened past it', () => {
    const rows = [
      { companyId: A, from: '2020-01-01', to: '2026-08-10' },
      { companyId: B2, from: '2026-08-11', to: null },
    ];
    const segs = mergeCompanySegments(rows, B2, '2026-08-05', '2026-08-20');
    expect(segs).toEqual([
      { companyId: A, from: '2026-08-05', to: '2026-08-10' },
      { companyId: B2, from: '2026-08-11', to: '2026-08-20' },
    ]);
    // Every day of the window is covered exactly once, which is what lets payroll treat the segment as a
    // tenure window without re-checking for holes.
    expect(segs[0].from).toBe('2026-08-05');
    expect(segs[segs.length - 1].to).toBe('2026-08-20');
  });

  it('segmentForCompany reports a re-entry (out and back within one month) rather than hiding it', () => {
    // A payslip cannot represent two disjoint ranges. Returning the outer hull would silently pay the
    // middle stretch under the wrong employer, so the flag exists to make it visible if it ever happens.
    const segs = [
      { companyId: A, from: '2026-08-01', to: '2026-08-09' },
      { companyId: B2, from: '2026-08-10', to: '2026-08-19' },
      { companyId: A, from: '2026-08-20', to: '2026-08-31' },
    ];
    expect(segmentForCompany(segs, A)).toEqual({ from: '2026-08-01', to: '2026-08-09', split: true });
    expect(segmentForCompany(segs, B2)).toEqual({ from: '2026-08-10', to: '2026-08-19', split: false });
    expect(segmentForCompany(segs, 'never-here')).toBeNull();
  });
});

// ─────────────────────── 2. the writer: history, not just a column ───────────────────────

describe('the writer: an Entity Transfer records the entity on the dated spine', () => {
  it('hire stamps the entity, so a never-transferred employment needs no backfill', async () => {
    const hire = await hireInto(b.companyId, b.deptA, '2026-07-23', '900101010101');
    const rows = await assignmentsOf(hire.employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(b.companyId);
  });

  it('the transfer CLOSES the old entity version and OPENS a new one at the effective date', async () => {
    const hire = await hireInto(b.companyId, b.deptA, '2026-07-23', '900101010102');
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-08-11',
      companyId: coB,
      departmentId: deptB2,
      remarks: 'Group restructure',
    });

    const rows = await assignmentsOf(hire.employmentId);
    expect(rows).toHaveLength(2);
    expect(rows[0].companyId).toBe(b.companyId);
    expect(rows[0].validFrom).toBe('2026-07-23');
    expect(rows[0].validTo).toBe('2026-08-11'); // exclusive: last day under the old entity is the 10th
    expect(rows[1].companyId).toBe(coB);
    expect(rows[1].validFrom).toBe('2026-08-11');
    expect(rows[1].validTo).toBeNull();
    // The column moved too — this replaces nothing, it adds the half that was missing.
    const [emp] = await owner.db
      .select({ companyId: schema.employment.companyId })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId));
    expect(emp.companyId).toBe(coB);
  });

  it('ONE version, not two: the placement legs fold into the entity leg on the same date', async () => {
    // The department moves in the same act. Two writers each doing CLOSE+INSERT on the same effective
    // date would leave a zero-length row behind and an Employment History that says the person moved
    // twice; core/movement.ts hands its assignment leg to the entity writer for exactly this reason.
    const hire = await hireInto(b.companyId, b.deptA, '2026-07-23', '900101010103');
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-08-11',
      companyId: coB,
      departmentId: deptB2,
    });
    const rows = await assignmentsOf(hire.employmentId);
    expect(rows).toHaveLength(2);
    expect(rows[1].departmentId).toBe(deptB2);
    expect(rows.filter((r) => r.validFrom === r.validTo)).toHaveLength(0);
  });

  it('the DB-backed resolver answers a date from those rows', async () => {
    const hire = await hireInto(b.companyId, b.deptA, '2026-07-23', '900101010104');
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-08-11',
      companyId: coB,
      departmentId: deptB2,
    });
    const a = adminCtx(b);
    await withTenant(a, async (tx) => {
      expect(await companyOnDate(tx, hire.employmentId, '2026-08-10')).toBe(b.companyId);
      expect(await companyOnDate(tx, hire.employmentId, '2026-08-11')).toBe(coB);
      expect(await companySegmentsForPeriod(tx, hire.employmentId, '2026-08-01', '2026-08-31')).toEqual([
        { companyId: b.companyId, from: '2026-08-01', to: '2026-08-10' },
        { companyId: coB, from: '2026-08-11', to: '2026-08-31' },
      ]);
    });
  });
});

// ─────────────────────── 3–5. the split, end to end ───────────────────────

describe('a transferred month produces two payslips, one per entity', () => {
  /** The reported case: hired into A, transferred to B effective 11 August, August run on both entities. */
  async function transferredEmployee(ic: string) {
    const hire = await hireInto(b.companyId, b.deptA, '2026-07-23', ic);
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-08-11',
      companyId: coB,
      departmentId: deptB2,
    });
    return hire;
  }

  it('THE FAULT: the OUTGOING entity still sees the employee, whose company column has already moved on', async () => {
    const hire = await transferredEmployee('900101010201');
    const a = adminCtx(b);
    // Before this item, this run produced NO payslip for this employee at all: the selection asked
    // `employment.company_id = batch.company_id`, and the column already said ISEDECOR.
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    const slips = await payslipsOf(batchId);
    expect(slips.map((s) => s.employmentId)).toContain(hire.employmentId);
  });

  it('two runs, two payslips, each stamped with its own entity and date range', async () => {
    const hire = await transferredEmployee('900101010202');
    const a = adminCtx(b);
    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });

    const out = (await payslipsOf(outgoing.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    const inc = (await payslipsOf(incoming.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    expect(out).toBeTruthy();
    expect(inc).toBeTruthy();

    const outSeg = (out.statutory as Record<string, unknown>).segment as { companyId: string; from: string; to: string };
    const incSeg = (inc.statutory as Record<string, unknown>).segment as { companyId: string; from: string; to: string };
    expect(outSeg).toEqual({ companyId: b.companyId, from: '2026-08-01', to: '2026-08-10' });
    expect(incSeg).toEqual({ companyId: coB, from: '2026-08-11', to: '2026-08-31' });
    // The day counts partition the month: 10 + 21 = 31. Nobody is paid twice and no day is dropped.
    expect(Number(out.daysWorked)).toBe(10);
    expect(Number(inc.daysWorked)).toBe(21);
    expect(Number(out.daysWorked) + Number(inc.daysWorked)).toBe(31);
  });

  it('THE ARITHMETIC ADDS UP: the two segments sum to ONE month of basic, not two', async () => {
    // The most likely way to get this wrong is to let each run prorate against its OWN segment length,
    // which gives factor 1.0 twice and pays the employee double. Both runs prorate against the same
    // monthly denominator (31), so 10/31 + 21/31 = 1.
    const hire = await transferredEmployee('900101010203');
    const a = adminCtx(b);
    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });

    const out = (await payslipsOf(outgoing.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    const inc = (await payslipsOf(incoming.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    expect(Number(out.basicSalary)).toBeCloseTo(6600 * (10 / 31), 1);
    expect(Number(inc.basicSalary)).toBeCloseTo(6600 * (21 / 31), 1);
    // Rounding is per-slip, so the sum lands within a cent or two of the whole month — never near double.
    expect(Number(out.basicSalary) + Number(inc.basicSalary)).toBeCloseTo(6600, 1);
  });

  it('TWO INDEPENDENT STATUTORY COMPUTATIONS, each on its own wage portion — not one halved', async () => {
    // Each employer reports its own EPF/SOCSO/EIS/PCB on its own portion, with the ceilings applying to
    // each employer separately. That is the normal Malaysian treatment and it is what the plan told the
    // reporter would be built. It falls out of the architecture — a batch is one company, so the two
    // segments are computed by two runs, each loading its own company's ruleset and registration — which
    // is precisely why it is asserted here rather than assumed.
    const hire = await transferredEmployee('900101010204');
    const a = adminCtx(b);
    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });

    const out = (await payslipsOf(outgoing.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    const inc = (await payslipsOf(incoming.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    const outSt = out.statutory as Record<string, number>;
    const incSt = inc.statutory as Record<string, number>;

    // Each side computed a real, positive EPF leg — neither is zero (which is what "one computation, one
    // employer" would have produced) and neither is the whole month's.
    expect(outSt.epfEmployee).toBeGreaterThan(0);
    expect(incSt.epfEmployee).toBeGreaterThan(0);
    // Each side's contribution is proportionate to ITS OWN gross, not to the whole month's.
    expect(outSt.epfEmployee).toBeLessThan(incSt.epfEmployee); // 10 days' wage < 21 days' wage
    expect(outSt.epfEmployer).toBeGreaterThan(0);
    expect(incSt.epfEmployer).toBeGreaterThan(0);
    // And each is stamped with its OWN employer's period, so a statutory form can tell them apart.
    expect((out.statutory as Record<string, unknown>).segment).toBeTruthy();
    expect((inc.statutory as Record<string, unknown>).segment).toBeTruthy();
  });

  it('the INCOMING entity does not pay the days before the transfer', async () => {
    const hire = await transferredEmployee('900101010205');
    const a = adminCtx(b);
    const incoming = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: incoming.batchId });
    const inc = (await payslipsOf(incoming.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    // The original fault, from the other side: a full month, 6600.00, under the destination entity.
    expect(Number(inc.basicSalary)).toBeLessThan(6600);
    expect(Number(inc.daysWorked)).toBe(21);
  });
});

// ─────────────────────── 6. nothing else moves ───────────────────────

describe('an employment that never transferred is untouched', () => {
  it('one covering segment ⇒ NO segment stamp, a full month, and the whole basic', async () => {
    const hire = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010301');
    const a = adminCtx(b);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    const slip = (await payslipsOf(batchId)).find((s) => s.employmentId === hire.employmentId)!;
    expect(Number(slip.basicSalary)).toBe(6600);
    expect(Number(slip.daysWorked)).toBe(31);
    // The absence of the stamp IS the byte-identical guarantee: a payslip with no segment is the payslip
    // this system produced before migration 0440 existed.
    expect((slip.statutory as Record<string, unknown>).segment).toBeUndefined();
  });

  it('a mid-month JOINER still prorates on the hire date, and gains no segment stamp', async () => {
    // The proration primitives are shared, so the risk is that the entity window overwrites the tenure
    // window. It must not: an employment with a single covering segment reaches them with `undefined`.
    const hire = await hireInto(b.companyId, b.deptA, '2026-08-16', '900101010302');
    const a = adminCtx(b);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    const slip = (await payslipsOf(batchId)).find((s) => s.employmentId === hire.employmentId)!;
    expect(Number(slip.daysWorked)).toBe(16); // 16–31 August inclusive
    expect((slip.statutory as Record<string, unknown>).segment).toBeUndefined();
  });

  it('an employee hired into the OTHER entity is not dragged onto this one\'s run', async () => {
    // The widened selection is an OR over the period, not a widening of the tenant. Someone who was never
    // in this company on any day of the month must not appear on it.
    const mine = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010303');
    const theirs = await hireInto(coB, deptB2, '2026-01-01', '900101010304');
    const a = adminCtx(b);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    const ids = (await payslipsOf(batchId)).map((s) => s.employmentId);
    expect(ids).toContain(mine.employmentId);
    expect(ids).not.toContain(theirs.employmentId);
  });

  it('a transfer in a LATER month leaves this month whole on the old entity', async () => {
    const hire = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010305');
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-09-15',
      companyId: coB,
      departmentId: deptB2,
    });
    const a = adminCtx(b);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    const slip = (await payslipsOf(batchId)).find((s) => s.employmentId === hire.employmentId)!;
    expect(Number(slip.basicSalary)).toBe(6600);
    expect((slip.statutory as Record<string, unknown>).segment).toBeUndefined();
  });
});

// ─────────────────────── 7. the backfill, rehearsed ───────────────────────

/**
 * THE BACKFILL IS A SCRIPT, NOT PART OF DEPLOY (`deploy.sh` runs migrations, not scripts), and it must
 * not be run against production blind. It is rehearsed here against a real cluster for two reasons that
 * a report-only dry run cannot cover: that it produces the RIGHT split for the reported shape, and that
 * it is genuinely idempotent — a claim only a second run settles.
 *
 * THE FIXTURE REPRODUCES THE PRODUCTION SHAPE EXACTLY, including the part the approved plan got wrong.
 * On production employee 100814's assignment boundary at 2026-08-10 belongs to a PROMOTION applied that
 * day (domain_event seq 6886), and the 11 August transfer wrote no boundary at all — its `changes` are
 * companyId and joinDate only. The plan reads those two dates as a disagreement to be reconciled by
 * moving the boundary; doing that would destroy the promotion's own effective date. The right action is
 * to SPLIT at the transfer date and leave the promotion's boundary alone, and that is what these cases
 * pin.
 */
describe('the backfill: history for rows written before migration 0440', () => {
  const url = () => process.env.TEST_MIGRATION_DATABASE_URL!;

  /** Strip the entity history the new writers stamp, leaving exactly the pre-0440 shape. */
  const eraseHistory = () => owner.db.update(schema.assignment).set({ companyId: null });

  it('replayTimeline: no transfers ⇒ one company for all of history; a transfer opens a second range', () => {
    expect(replayTimeline([], 'co-x', '2020-01-01')).toEqual([{ from: '2020-01-01', companyId: 'co-x' }]);
    const t = [{ eventId: 'e1', effectiveDate: '2026-08-11', before: 'co-a', after: 'co-b' }];
    expect(replayTimeline(t, 'co-b', '2026-07-23')).toEqual([
      { from: '2026-07-23', companyId: 'co-a' },
      { from: '2026-08-11', companyId: 'co-b' },
    ]);
    expect(companyAt(replayTimeline(t, 'co-b', '2026-07-23')!, '2026-08-10')).toBe('co-a');
    expect(companyAt(replayTimeline(t, 'co-b', '2026-07-23')!, '2026-08-11')).toBe('co-b');
  });

  it('replayTimeline REFUSES when the replay does not land on the stored company', () => {
    // The ledger and the column disagree about something the script does not model. Guessing at a legal
    // entity is how you pay the wrong employer, so the employment is left completely alone.
    const t = [{ eventId: 'e1', effectiveDate: '2026-08-11', before: 'co-a', after: 'co-b' }];
    expect(replayTimeline(t, 'co-c', '2026-07-23')).toBeNull();
  });

  it('stamps a never-transferred employment with its single company, and re-running writes nothing', async () => {
    const hire = await hireInto(b.companyId, b.deptA, '2026-01-01', '900101010401');
    await eraseHistory();
    expect((await assignmentsOf(hire.employmentId))[0].companyId).toBeNull();

    const dry = await runBackfill(url(), { apply: false });
    expect(dry.plans.find((p) => p.employmentId === hire.employmentId)!.stamps).toHaveLength(1);
    expect((await assignmentsOf(hire.employmentId))[0].companyId).toBeNull(); // report-only wrote nothing

    const wet = await runBackfill(url(), { apply: true });
    expect(wet.applied.stamps).toBeGreaterThanOrEqual(1);
    expect((await assignmentsOf(hire.employmentId))[0].companyId).toBe(b.companyId);

    const again = await runBackfill(url(), { apply: false });
    expect(again.plans.reduce((n, p) => n + p.stamps.length + p.splits.length, 0)).toBe(0);
  });

  it('THE REPORTED SHAPE: splits at the TRANSFER date and leaves an unrelated boundary where it is', async () => {
    // 1. hired 23 July. 2. an unrelated movement on 10 August writes a boundary (production: a promotion).
    // 3. a company-only transfer on 11 August, which before this item wrote no boundary at all.
    const hire = await hireInto(b.companyId, b.deptA, '2026-07-23', '900101010402');
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-08-10',
      departmentId: b.deptB,
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-08-11',
      companyId: coB,
      departmentId: deptB2,
    });
    // Erase BOTH the entity history and the boundary the new writer created, so the fixture is exactly
    // the pre-0440 state the backfill will meet on production: a boundary at 08-10 and none at 08-11.
    const before = await assignmentsOf(hire.employmentId);
    await owner.db
      .delete(schema.assignment)
      .where(eq(schema.assignment.id, before[before.length - 1].id));
    await owner.db
      .update(schema.assignment)
      .set({ validTo: null })
      .where(eq(schema.assignment.id, before[before.length - 2].id));
    await eraseHistory();
    const pre = await assignmentsOf(hire.employmentId);
    expect(pre.map((r) => [r.validFrom, r.validTo])).toEqual([
      ['2026-07-23', '2026-08-10'],
      ['2026-08-10', null],
    ]);

    await runBackfill(url(), { apply: true });

    const post = await assignmentsOf(hire.employmentId);
    expect(post.map((r) => [r.validFrom, r.validTo, r.companyId])).toEqual([
      // the unrelated 10 August boundary is UNTOUCHED — moving it would destroy that movement's date
      ['2026-07-23', '2026-08-10', b.companyId],
      ['2026-08-10', '2026-08-11', b.companyId],
      // …and the transfer date now has a boundary of its own
      ['2026-08-11', null, coB],
    ]);

    // And the resolver now answers the question the whole item exists for.
    const a = adminCtx(b);
    await withTenant(a, async (tx) => {
      expect(await companySegmentsForPeriod(tx, hire.employmentId, '2026-08-01', '2026-08-31')).toEqual([
        { companyId: b.companyId, from: '2026-08-01', to: '2026-08-10' },
        { companyId: coB, from: '2026-08-11', to: '2026-08-31' },
      ]);
    });

    // Idempotent: a second run finds nothing to do.
    const again = await runBackfill(url(), { apply: false });
    expect(again.plans.reduce((n, p) => n + p.stamps.length + p.splits.length, 0)).toBe(0);
  });

  it('after the backfill, the outgoing entity pays exactly its ten days', async () => {
    // End to end from the pre-0440 state: this is the assertion that would have caught the reported
    // fault, and it is driven by the backfill rather than by the writers.
    const hire = await hireInto(b.companyId, b.deptA, '2026-07-23', '900101010403');
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-08-11',
      companyId: coB,
      departmentId: deptB2,
    });
    await eraseHistory();
    // Pre-backfill the resolver falls back to the column, so August is one segment on the DESTINATION —
    // i.e. exactly the fault, still reproducible, which proves the fallback is what it claims to be.
    const a = adminCtx(b);
    const stale = await createBatch(a, { companyId: coB, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: stale.batchId });
    const staleSlip = (await payslipsOf(stale.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    expect(Number(staleSlip.basicSalary)).toBe(6600); // the whole month, on the new entity

    await runBackfill(url(), { apply: true });

    const outgoing = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: outgoing.batchId });
    const out = (await payslipsOf(outgoing.batchId)).find((s) => s.employmentId === hire.employmentId)!;
    expect(Number(out.daysWorked)).toBe(10);
    expect((out.statutory as Record<string, unknown>).segment).toEqual({
      companyId: b.companyId,
      from: '2026-08-01',
      to: '2026-08-10',
    });
  });
});
