/**
 * 8ca344bf — BORANG 8A, against a real database.
 *
 * test/borang-8a.test.ts pins the RULES with no database at all, which is what makes them cheap to assert
 * and impossible to get wrong by accident. This file pins the READ: that the query joins what it claims to
 * join, that the header comes off the company's own statutory row, that the start/stop dates are filled
 * only inside the contribution month, and that a person with no identity card number is NAMED rather than
 * silently dropped from a statutory filing.
 *
 * Every one of those is a defect that a pure test cannot see and that produces a plausible-looking document
 * in production: a missing join yields an empty schedule, a wrong join yields somebody else's figure, and a
 * dropped employee yields a Borang 8A that reconciles perfectly to a payroll it does not match.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { reportPreview } from '../core/reporting';
import { BORANG_8A_HEADER_KEYS, borang8AFrom } from '../lib/borang-8a';
// r372 — THE THIRD SURFACE, COVERED BY ITS OWN TEST AND NOT BY INFERENCE. `socsoEisFileForBatch` is an
// INDEPENDENT resolution of the same PERKESO population as the read above — its own batch query, its own
// accumulator, its own download route — and r296 is what happened the last time the two resolved one field
// separately. So the corrected wage is asserted on the FILE'S OWN BYTES here, not deduced from the report.
import { socsoEisFileForBatch } from '../localization/my/socso-eis-file';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // The employer header: PERKESO employer code + the SSM number that doubles as MyCoID, and an address.
  await setCompanyStatutoryMY(adminCtx(b), {
    companyId: b.companyId,
    socsoEmployerCode: 'B3201005082P',
    ssmRegistrationNo: '202301012345',
  });
  await owner.db
    .update(schema.company)
    .set({ addressLine1: 'Level 8, Menara Satu', city: 'Kuala Lumpur', state: 'Wilayah Persekutuan', postcode: '50000' })
    .where(eq(schema.company.id, b.companyId));
});

let seq = 0;
async function hire(p: { name: string; hiredOn: string; salary: number; ic: string | null; terminatedOn?: string }) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: p.name, primaryEmail: `b8a_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: p.hiredOn,
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: p.salary, effectiveFrom: p.hiredOn });
  // A BLANK IC is stored as null (the rule setStatutoryProfileMY has carried since 55865c32), which is
  // exactly the readiness case this form has to name.
  await setStatutoryProfileMY(a, {
    personId: E.personId,
    icNumber: p.ic ?? '',
    taxCategory: 1,
    numChildren: 0,
  });
  if (p.terminatedOn) {
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: p.terminatedOn })
      .where(eq(schema.employment.id, E.employmentId));
  }
  return E;
}

async function run(period: string) {
  const a = adminCtx(b);
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod: period });
  await generatePayslips(a, { batchId: batch.batchId });
  return reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-8a', periodKey: period });
}

describe('the Borang 8A read', () => {
  it('fills the header from the company’s own statutory row, and stamps the payroll month with no shift', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128' });
    const r = await run('2026-07');

    const h = r.meta.formHeader!;
    for (const k of BORANG_8A_HEADER_KEYS) expect(h[k], k).toBeDefined();
    expect(h.employerCode).toBe('B3201005082P');
    // MyCoID REUSES ssm_registration_no — one number, one home. A second column would let the two disagree.
    expect(h.mycoid).toBe('202301012345');
    expect(h.employerName).toBe('Acme Sdn Bhd');
    expect(h.employerAddress).toContain('Level 8, Menara Satu');
    expect(h.employerAddress).toContain('50000 Kuala Lumpur, Wilayah Persekutuan');
    // THE TWO DATING RULES, end to end rather than only in the pure test.
    expect(h.contributionMonth).toBe('07 / 2026');
    expect(h.contributionPeriodKey).toBe('2026-07');
    expect(h.payrollPeriodKey).toBe('2026-07');
    expect(h.paymentDueDate).toBe('31/07/2026');
  });

  it('takes the contribution from the run — SOCSO employee + employer, and nothing else', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128' });
    const r = await run('2026-07');

    expect(r.meta.hasBatch).toBe(true);
    expect(r.rows).toHaveLength(1);
    const [slip] = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .limit(1);
    const st = slip.statutory as Record<string, number>;
    const expected = Math.round((Number(st.socsoEmployee) + Number(st.socsoEmployer)) * 100) / 100;
    expect(expected, 'the fixture must actually produce a SOCSO figure').toBeGreaterThan(0);
    expect(r.rows[0].contribution).toBe(expected);
    // EIS is its own PERKESO filing and must NOT be inside this column.
    expect(Number(st.eisEmployee) + Number(st.eisEmployer)).toBeGreaterThan(0);
    expect(r.rows[0].contribution).not.toBe(
      Math.round((Number(st.socsoEmployee) + Number(st.socsoEmployer) + Number(st.eisEmployee) + Number(st.eisEmployer)) * 100) / 100,
    );
    // …and the two excluded figures are SHOWN beside the form total rather than dropped silently.
    const labels = (r.meta.summary ?? []).map((s) => s.label);
    expect(labels).toContain('EIS — filed separately');
    expect(labels).toContain('SKBBK — not on this form');
  });

  it('reconciles: the row total, the reported total, and the run’s own SOCSO all agree', async () => {
    await hire({ name: 'ZAINAB BINTI ALI', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555' });
    await hire({ name: 'ABU BIN BAKAR', hiredOn: '2024-03-01', salary: 5000, ic: '880808085555' });
    const r = await run('2026-07');

    const summed = r.rows.reduce((a, row) => a + Number(row.contribution), 0);
    expect(Math.round(summed * 100)).toBe(Math.round(r.totals.contribution * 100));
    const tile = (label: string) => Number((r.meta.summary ?? []).find((s) => s.label === label)!.value);
    expect(tile('Amaun Caruman (form)')).toBe(r.totals.contribution);
    // Summed by an INDEPENDENT path (straight off the payslips, not through the per-employee grouping), so
    // a divergence would mean the grouping dropped or double-counted somebody.
    expect(tile('SOCSO in this run (EE+ER)')).toBe(r.totals.contribution);
  });

  it('sorts by name, so the schedule is reproducible month to month', async () => {
    await hire({ name: 'ZAINAB BINTI ALI', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555' });
    await hire({ name: 'ABU BIN BAKAR', hiredOn: '2024-03-01', salary: 3000, ic: '880808085555' });
    const r = await run('2026-07');
    expect(r.rows.map((row) => row.name)).toEqual(['ABU BIN BAKAR', 'ZAINAB BINTI ALI']);
  });

  /**
   * COLUMN (1) IS FILLED ONLY INSIDE THE CONTRIBUTION MONTH. A joining date printed every single month
   * reads as a new joiner every single month, which is precisely what the specimen avoids by leaving both
   * boxes blank for a continuing employee.
   */
  it('fills the start date only for someone who joined inside the month, and blanks it otherwise', async () => {
    await hire({ name: 'AAA CONTINUING', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555' });
    await hire({ name: 'BBB NEW JOINER', hiredOn: '2026-07-14', salary: 3000, ic: '880808085555' });
    const r = await run('2026-07');

    const byName = new Map(r.rows.map((row) => [String(row.name), row]));
    expect(byName.get('AAA CONTINUING')!.startDate).toBe('');
    // ddmmyyyy with no separators — the artwork's own (hhbbtttt).
    expect(byName.get('BBB NEW JOINER')!.startDate).toBe('14072026');
    // Nobody left this month, so the stop column is blank for both, exactly as the specimen leaves it.
    expect(r.rows.every((row) => row.stopDate === '')).toBe(true);
    // …and no status is invented for anyone: PERKESO's code list is not in the specimen.
    expect(r.rows.every((row) => row.status === '')).toBe(true);
  });

  it('fills the stop date only for someone who left inside the month', async () => {
    await hire({ name: 'CCC LEAVER', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555', terminatedOn: '2026-07-31' });
    await hire({ name: 'DDD LATER LEAVER', hiredOn: '2024-03-01', salary: 3000, ic: '880808085555', terminatedOn: '2026-08-15' });
    const r = await run('2026-07');
    const byName = new Map(r.rows.map((row) => [String(row.name), row]));
    expect(byName.get('CCC LEAVER')!.stopDate).toBe('31072026');
    expect(byName.get('DDD LATER LEAVER')!.stopDate).toBe('');
  });

  /**
   * THE READINESS GATE'S OWN HALF: the person with no identity card number is NAMED, and is still on the
   * schedule. Dropping them would produce a form that reconciles to nothing and understates the filing.
   */
  it('names whoever has no identity card number, without dropping them from the schedule', async () => {
    await hire({ name: 'AAA WITH IC', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555' });
    await hire({ name: 'BBB NO IC', hiredOn: '2024-03-01', salary: 3000, ic: null });
    const r = await run('2026-07');

    expect(r.readiness.map((x) => x.name)).toEqual(['BBB NO IC']);
    expect(r.readiness[0].missing).toEqual(['IC']);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((row) => row.ic)).toContain('');
  });

  /** A month with no run is not an empty form: the screen says so, and the header is still there. */
  it('reports no batch rather than an empty schedule for a month that was never run', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128' });
    const r = await reportPreview(adminCtx(b), {
      companyId: b.companyId,
      reportId: 'my.borang-8a',
      periodKey: '2099-12',
    });
    expect(r.meta.hasBatch).toBe(false);
    expect(r.rows).toEqual([]);
    // The header survives, so the screen can still name the month it found nothing for.
    expect(r.meta.formHeader!.contributionMonth).toBe('12 / 2099');
  });

  /** End to end: what the read produces is a form the renderer will accept, and its pages add up. */
  it('produces a form the renderer accepts, whose sheet totals sum to Amaun Caruman', async () => {
    for (let i = 0; i < 22; i += 1) {
      await hire({ name: `EMP ${String(i).padStart(2, '0')}`, hiredOn: '2024-03-01', salary: 3000 + i, ic: null });
    }
    const r = await run('2026-07');
    const form = borang8AFrom({ header: r.meta.formHeader, rows: r.rows });
    expect(form.employees).toBe(22);
    expect(form.pages.length).toBe(2); // 20 rows per sheet
    const summed = form.pages.reduce((a, p) => a + p.pageTotal, 0);
    expect(Math.round(summed * 100)).toBe(Math.round(form.total * 100));
    expect(Math.round(form.total * 100)).toBe(Math.round(r.totals.contribution * 100));
  });

  /** A malformed period is refused rather than read as a literal batch key that finds nothing. */
  it('refuses a period that is not YYYY-MM', async () => {
    await expect(
      reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.borang-8a', periodKey: '2026-13' }),
    ).rejects.toThrow(/YYYY-MM/);
  });
});


/**
 * ─── r227, CORRECTED IN r372 — WHAT AN ADDITIONAL RUN DOES TO THE SALARY (UPAH) COLUMN ───────────
 *
 * THE SAME DEFECT AS THE BORANG A ONE, THROUGH THE OTHER AGENCY'S BASE, AND THE SAME REASON IT WAS
 * INVISIBLE: `createAdditionalRun` appeared ZERO times in this repository's statutory-form guards, so
 * every one of them ran a single regular run and the suite was green whatever a second run did to a
 * filed figure.
 *
 * ── THE CLAIM THIS BLOCK USED TO PIN, QUOTED SO IT CANNOT COME BACK BY ACCIDENT ──────────────────
 * Between r227 and r372 the two cases below asserted the DEFECT as a deliberately recorded fact, under
 * this header:
 *
 *     "Pinned, not fixed: nothing in r226/r227 changes the stamp or the sum. The reporter sees the change
 *      to their own filed figures before it is filed, and the number can no longer move unobserved."
 *
 * and their assertions read:
 *
 *     expect(wageOf(after, 'AAA KEPT')).toBeCloseTo(oneMonth * 2, 2);
 *     expect(wageOf(await preview(a, '2026-07'), 'AAA PAID')).toBeCloseTo(oneMonth * 2, 2);
 *
 * THE REPORTER MADE THAT DECISION (item d4f6848f, approved 2026-09-30): report the month's wage ONCE and
 * move no contribution amount. The claim above is RETIRED, not deleted.
 *
 * ── THE MECHANISM, WHICH DID NOT CHANGE, BECAUSE THE FIX IS NOT IN THE KERNEL ────────────────────
 * `statutory.bases.socsoEis` is stamped from `wagesExOt + statOvertime` (core/payroll.ts) on EVERY
 * payslip, and on an additional run those are the CUMULATIVE month figures by design (r187 — they must
 * match the `now` side of the delta the run charges). It is IDENTICAL on each run of the month, not
 * accumulating. This read used to SUM it across the period's runs (ADR-0024), which counts the month once
 * per run; it now takes it ONCE, from the greatest `run_seq` (localization/my/statutory-month-wage.ts).
 *
 * NOTHING PRINTED ON THE PAPER BORANG 8A MOVED AT ALL. The salary base has no column on the agency's page;
 * it rides on the row for the PERKESO ASSIST upload file, which is where the overstated figure was filed.
 */
describe('r372 — an additional run and the SOCSO salary column', () => {
  const salary = 4000;

  async function twoRuns(period: string) {
    // Granted BEFORE the snapshot is taken: a point-in-time synthetic snapshot would read it off.
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);
    const reg = await createBatch(a, { companyId: b.companyId, payPeriod: period });
    await generatePayslips(a, { batchId: reg.batchId });
    const extra = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: period, runType: 'bonus' });
    return { a, reg, extra };
  }

  const preview = (a: Awaited<ReturnType<typeof entitledCtx>>, period: string) =>
    reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-8a', periodKey: period });
  const wageOf = (r: Awaited<ReturnType<typeof preview>>, name: string) =>
    Number(r.rows.find((row) => row.name === name)!.wage);
  const contribOf = (r: Awaited<ReturnType<typeof preview>>, name: string) =>
    Number(r.rows.find((row) => row.name === name)!.contribution);
  /**
   * The month's PERKESO legs added straight off the payslips — INDEPENDENTLY of the report — so "the
   * contributions did not move" is measured against the stored figures and not the report's own
   * arithmetic. They are deltas (ADR-0024) and summing them is correct; that is the half that must stay.
   */
  async function perkesoPaidInMonth(employmentId: string, batchIds: string[]) {
    const slips = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(and(eq(schema.payslip.employmentId, employmentId), inArray(schema.payslip.batchId, batchIds)));
    const t = { socso: 0, eis: 0 };
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Record<string, number>;
      t.socso += Number(st.socsoEmployee ?? 0) + Number(st.socsoEmployer ?? 0);
      t.eis += Number(st.eisEmployee ?? 0) + Number(st.eisEmployer ?? 0);
    }
    return { socso: Math.round(t.socso * 100) / 100, eis: Math.round(t.eis * 100) / 100 };
  }

  /**
   * Two employees identical in every respect except whether the bonus run processed them. KEPT is held in
   * the run by an OVERTIME figure keyed against it — a door the skip counts (so the reason it prints is
   * never false) and that an additional run does not PAY (`slipOvertime` is forced to 0), which is how
   * the kernel itself produces a genuine zero-value payslip with no surgery on any row.
   */
  it('a zero-value bonus payslip leaves the salary box at ONE month, and moves no contribution', async () => {
    const kept = await hire({ name: 'AAA KEPT', hiredOn: '2024-03-01', salary, ic: '900101015555' });
    await hire({ name: 'BBB SKIPPED', hiredOn: '2024-03-01', salary, ic: '880808085555' });
    const { a, reg, extra } = await twoRuns('2026-07');

    const before = await preview(a, '2026-07');
    const oneMonth = wageOf(before, 'AAA KEPT');
    expect(oneMonth).toBeGreaterThan(0);
    expect(wageOf(before, 'BBB SKIPPED')).toBe(oneMonth);
    const keptContribBefore = contribOf(before, 'AAA KEPT');

    await setPayrollInput(a, { batchId: extra.batchId, employmentId: kept.employmentId, overtimeAmount: 500 });
    const gen = await generatePayslips(a, { batchId: extra.batchId });
    expect('skipped' in gen && Array.isArray(gen.skipped) ? gen.skipped.map((x) => x.name) : []).toEqual([
      'BBB SKIPPED',
    ]);

    const extraSlips = await owner.db
      .select({ gross: schema.payslip.grossPay, statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, extra.batchId));
    expect(extraSlips).toHaveLength(1);
    expect(Number(extraSlips[0].gross)).toBe(0);
    // The zero-value payslip DOES carry a full month's wage in its own SOCSO/EIS basis. That has not
    // changed and is why the old SUM was wrong; the read no longer adds it to the earlier run's.
    const bases = (extraSlips[0].statutory as { bases?: Record<string, number> }).bases!;
    expect(Number(bases.socsoEis)).toBeCloseTo(oneMonth, 2);

    const after = await preview(a, '2026-07');
    // ── THE FIX, STATED AS A NUMBER (item d4f6848f). The retired assertion read `oneMonth * 2`.
    expect(wageOf(after, 'AAA KEPT')).toBeCloseTo(oneMonth, 2);
    expect(wageOf(after, 'AAA KEPT')).toBeLessThan(oneMonth * 2);
    expect(wageOf(after, 'BBB SKIPPED')).toBeCloseTo(oneMonth, 2);
    // ── AND THE CONTRIBUTIONS DID NOT MOVE. In the SAME test as the wage, on purpose.
    expect(contribOf(after, 'AAA KEPT')).toBeCloseTo(keptContribBefore, 2);
    const paid = await perkesoPaidInMonth(kept.employmentId, [reg.batchId, extra.batchId]);
    expect(contribOf(after, 'AAA KEPT')).toBeCloseTo(paid.socso, 2);
    // Nobody is held: the two runs agree about the wage, so the document is still downloadable.
    expect(after.readiness.flatMap((x) => x.missing).filter((m) => m.includes('DIFFERENT wages'))).toEqual([]);
  });

  /**
   * The half the r226 skip never fixed: the doubling belonged to the bases, not to the zero-value payslip,
   * so anybody the additional run had something to pay kept both counts. A bonus is outside the SOCSO/EIS
   * base by law, so the corrected answer here is EXACTLY one month with nothing of the bonus in it — which
   * makes this the cleanest of the three cases, and the one where "one month" and "two months" are
   * unmistakably different numbers.
   */
  it('reports exactly one month for somebody the bonus run actually pays', async () => {
    const paid = await hire({ name: 'AAA PAID', hiredOn: '2024-03-01', salary, ic: '900101015555' });
    const { a, reg, extra } = await twoRuns('2026-07');
    const oneMonth = wageOf(await preview(a, '2026-07'), 'AAA PAID');

    await setPayrollInput(a, {
      batchId: extra.batchId,
      employmentId: paid.employmentId,
      overtimeAmount: 0,
      bonusAmount: 1000,
    });
    await generatePayslips(a, { batchId: extra.batchId });

    const after = await preview(a, '2026-07');
    expect(wageOf(after, 'AAA PAID')).toBeCloseTo(oneMonth, 2);
    expect(wageOf(after, 'AAA PAID')).toBeLessThan(oneMonth * 2);
    const paidLegs = await perkesoPaidInMonth(paid.employmentId, [reg.batchId, extra.batchId]);
    expect(contribOf(after, 'AAA PAID')).toBeCloseTo(paidLegs.socso, 2);
  });

  /**
   * ── THE THIRD SURFACE, ON ITS OWN BYTES (r372) ───────────────────────────────────────────────────
   *
   * `socsoEisFileForBatch` resolves the same PERKESO population through its OWN query and its OWN
   * accumulator, behind /payroll/reports/socso-eis-file. It carried the identical defect and it must now
   * carry the identical correction — not a copy of it. Asserted on `totals.salaryCents`, which
   * `perkesoFileTotals` reads back OUT OF THE EMITTED RECORD rather than adding up from the rows, so this
   * is the number that would actually reach PERKESO ASSIST.
   *
   * AND THE TWO PERKESO SURFACES ARE COMPARED TO EACH OTHER, which is the r296 lesson: one writer is not
   * enough if two reads disagree about what to hand it.
   */
  it('the PERKESO upload file carries one month in its salary box, from the same derivation', async () => {
    const kept = await hire({ name: 'AAA KEPT', hiredOn: '2024-03-01', salary, ic: '900101015555' });
    const { a, reg, extra } = await twoRuns('2026-07');

    const before = await socsoEisFileForBatch(a, { companyId: b.companyId, periodKey: '2026-07' });
    const oneMonthCents = before.totals.salaryCents;
    expect(oneMonthCents).toBeGreaterThan(0);
    expect(before.totals.records).toBe(1);

    await setPayrollInput(a, { batchId: extra.batchId, employmentId: kept.employmentId, overtimeAmount: 500 });
    await generatePayslips(a, { batchId: extra.batchId });

    const after = await socsoEisFileForBatch(a, { companyId: b.companyId, periodKey: '2026-07' });
    // ONE record for the month, whatever number of runs it held, and ONE month in the salary box.
    expect(after.totals.records).toBe(1);
    expect(after.totals.salaryCents).toBe(oneMonthCents);
    expect(after.totals.salaryCents).not.toBe(oneMonthCents * 2);
    // The contribution boxes are byte-identical to the month's own stored legs.
    const paidLegs = await perkesoPaidInMonth(kept.employmentId, [reg.batchId, extra.batchId]);
    expect(after.totals.socsoCents).toBe(Math.round(paidLegs.socso * 100));
    expect(after.totals.eisCents).toBe(Math.round(paidLegs.eis * 100));
    // AND THE TWO PERKESO SURFACES AGREE about the month's wage — the r296 property, on the field r296 was
    // about. One employee in this month, so the file's total IS that employee's salary box.
    const report = await preview(a, '2026-07');
    expect(after.totals.salaryCents).toBe(Math.round(wageOf(report, 'AAA KEPT') * 100));
  });

  /**
   * ── AND WHERE ONE FIGURE IS NOT THE TRUTH, BOTH PERKESO SURFACES REFUSE ──────────────────────────
   *
   * A mid-month pay change makes the month's runs disagree about `bases.socsoEis`, and then no single
   * salary figure is the month's wage. `localization/my/multicycle-worksheet.ts` already refuses this exact
   * shape as `inconsistent_run_bases`; printing whichever run happened to be last would be a figure nobody
   * can stand behind (CLAUDE.md §8).
   *
   * THE SALARY IS RAISED BETWEEN THE TWO RUNS, which is the reporter's own case ("somebody's pay changed
   * part way through the month") and is produced by the kernel rather than by editing a stored row: the
   * regular run is charged on the old wage and the bonus run re-derives the new one.
   */
  it('names the person and holds both PERKESO surfaces when the month’s runs disagree about the wage', async () => {
    const e = await hire({ name: 'AAA CHANGED', hiredOn: '2024-03-01', salary, ic: '900101015555' });
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);
    const reg = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId: reg.batchId });
    // The raise, effective inside the month, AFTER the regular run was charged on the old figure.
    await setCompensation(adminCtx(b), {
      employmentId: e.employmentId,
      basicSalary: salary + 1500,
      effectiveFrom: '2026-07-16',
    });
    const extra = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: '2026-07', runType: 'bonus' });
    await setPayrollInput(a, { batchId: extra.batchId, employmentId: e.employmentId, overtimeAmount: 500 });
    await generatePayslips(a, { batchId: extra.batchId });

    // The two runs really were charged on different SOCSO/EIS wages, or this test asserts nothing.
    const stamped = await owner.db
      .select({ statutory: schema.payslip.statutory, runSeq: schema.payrollBatch.runSeq })
      .from(schema.payslip)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(and(eq(schema.payslip.employmentId, e.employmentId), inArray(schema.payslip.batchId, [reg.batchId, extra.batchId])));
    const socsoBases = stamped
      .map((r) => Number((r.statutory as { bases?: Record<string, number> }).bases?.socsoEis ?? 0))
      .sort((x, y) => x - y);
    expect(socsoBases).toHaveLength(2);
    expect(Math.abs(socsoBases[1] - socsoBases[0])).toBeGreaterThan(0.005);

    // SURFACE ONE — the Borang 8A read NAMES them, with a reason that says the runs disagree rather than
    // that nothing was recorded, and the existing gate holds every download off that list.
    const report = await preview(a, '2026-07');
    const named = report.readiness.find((x) => x.name === 'AAA CHANGED');
    expect(named, 'the person whose month has no single wage must be NAMED').toBeTruthy();
    expect(named!.missing.join(' ')).toContain('SOCSO/EIS wage basis');
    expect(named!.missing.join(' ')).toContain('DIFFERENT wages');
    // …and they are NOT dropped from the schedule, which would produce a form reconciling to nothing.
    expect(report.rows.map((r) => r.name)).toContain('AAA CHANGED');

    // SURFACE TWO — the independent upload-file read refuses by name, and says why in its own words.
    await expect(socsoEisFileForBatch(a, { companyId: b.companyId, periodKey: '2026-07' })).rejects.toThrow(
      /DIFFERENT SOCSO\/EIS wages[\s\S]*AAA CHANGED/,
    );
  });
});
