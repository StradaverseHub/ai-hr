/**
 * 9c8dad7a / 3aae0789 — BORANG A, against a real database.
 *
 * test/borang-a.test.ts pins the RULES with no database at all, which is what makes them cheap to assert
 * and impossible to get wrong by accident. This file pins the READ: that the query joins what it claims to
 * join, that the header comes off the company's own statutory row and its EPF authority row, that Upah is
 * the wage the run CHARGED EPF ON rather than gross pay, and that a person with no EPF member number is
 * NAMED rather than silently dropped from a statutory filing.
 *
 * Every one of those is a defect a pure test cannot see and that produces a plausible-looking document in
 * production: a missing join yields an empty form, a wrong join yields somebody else's figure, a dropped
 * employee yields a Borang A that reconciles perfectly to a payroll it does not match, and a wage quietly
 * taken from gross pay over-reports a statutory contribution for everybody with overtime.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { upsertCompanyStatutoryAuthority } from '../core/statutory-authority';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { reportPreview } from '../core/reporting';
// r372 (item f022dd70) — the read behind the download pop-up's Payroll Cycle list. Exercised HERE, beside
// the report it feeds, so "the control offers a run" and "the file contains that run" stay one claim.
import { listFilableRunsForPeriod } from '../core/payroll-view';
import { BORANG_A_HEADER_KEYS, borangAFrom, money } from '../lib/borang-a';
import { renderBorangAPdf } from '../lib/borang-a-pdf';
import { borangBbcdFrom } from '../lib/borang-bbcd';
import { renderBorangBbcdPdf } from '../lib/borang-bbcd-pdf';
import { borangAFileReadiness, buildBorangAFile, parseBorangAFileTotals } from '../lib/kwsp-borang-a-file';

/** r407 — every string a rendered PDF drew (pdf-lib's Flate content streams, WinAnsi hex strings). */
function drawnTexts(pdf: Buffer): string[] {
  const out: string[] = [];
  for (const m of pdf.toString('latin1').matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = pdf.indexOf('endstream', start, 'latin1');
    let body: string;
    try {
      body = zlib.inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) out.push(Buffer.from(t[1], 'hex').toString('latin1'));
  }
  return out;
}

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // The employer header: the EPF employer reference, which already existed under this name and is why
  // this round needed no migration.
  await setCompanyStatutoryMY(adminCtx(b), { companyId: b.companyId, epfEmployerNo: '019632261' });
  await owner.db
    .update(schema.company)
    .set({ addressLine1: 'Level 12, Menara Satu', city: 'Kuala Lumpur', state: 'Wilayah Persekutuan', postcode: '50450' })
    .where(eq(schema.company.id, b.companyId));
});

let seq = 0;
async function hire(p: { name: string; hiredOn: string; salary: number; ic: string | null; epfNumber?: string | null }) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: p.name, primaryEmail: `ba_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: p.hiredOn,
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: p.salary, effectiveFrom: p.hiredOn });
  await setStatutoryProfileMY(a, {
    personId: E.personId,
    icNumber: p.ic ?? '',
    epfNumber: p.epfNumber ?? '',
    taxCategory: 1,
    numChildren: 0,
  });
  return E;
}

async function run(period: string) {
  const a = adminCtx(b);
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod: period });
  await generatePayslips(a, { batchId: batch.batchId });
  return reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-a', periodKey: period });
}

describe('the Borang A read', () => {
  it('fills the header from the company’s own rows, and stamps the payroll month PLUS ONE', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await run('2026-07');

    const h = r.meta.formHeader!;
    for (const k of BORANG_A_HEADER_KEYS) expect(h[k], k).toBeDefined();
    expect(h.employerRef).toBe('019632261');
    expect(h.employerName).toBe('Acme Sdn Bhd');
    expect(h.employerAddress).toContain('Level 12, Menara Satu');
    expect(h.employerAddress).toContain('50450 Kuala Lumpur, Wilayah Persekutuan');
    // THE +1 RULE, END TO END rather than only in the pure test. A July payroll files an 08/2026 form.
    expect(h.payrollPeriodKey).toBe('2026-07');
    expect(h.contributionPeriodKey).toBe('2026-08');
    expect(h.contributionMonth).toBe('08 / 2026');
    expect(h.contributionMonthCode).toBe('0826');
    // Tarikh DiCetak is the generation date, so it moves with the day rather than with the period.
    expect(h.printedOn).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('rolls the YEAR for a December payroll, which is where a wrong rule is worst', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await run('2026-12');
    expect(r.meta.formHeader!.contributionPeriodKey).toBe('2027-01');
    expect(r.meta.formHeader!.contributionMonthCode).toBe('0127');
  });

  /**
   * THE ONE THIS FORM IS MOST LIKELY TO LOSE QUIETLY. Gross pay is always available and always looks
   * plausible; it also includes overtime, which EPF excludes.
   */
  it('takes Upah from the run’s own EPF wage basis, never from gross pay', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await run('2026-07');

    const [slip] = await owner.db
      .select({ statutory: schema.payslip.statutory, gross: schema.payslip.grossPay })
      .from(schema.payslip)
      .limit(1);
    const st = slip.statutory as Record<string, number> & { bases?: Record<string, number> };
    expect(st.bases, 'the fixture must produce a run that stamps its wage bases').toBeTruthy();

    const expectedWage = Math.round((Number(st.bases!.epf) + Number(st.bases!.epfAdditional)) * 100) / 100;
    expect(r.rows[0].wage).toBe(expectedWage);
    expect(r.rows[0].employer).toBe(Math.round(Number(st.epfEmployer) * 100) / 100);
    expect(r.rows[0].employee).toBe(Math.round(Number(st.epfEmployee) * 100) / 100);
    expect(r.rows[0].wageRecorded).toBe('yes');

    // …and the strip SHOWS gross beside it, so the difference is visible rather than arguable.
    const labels = (r.meta.summary ?? []).map((s) => s.label);
    expect(labels).toContain('Upah — the EPF-liable wage');
    expect(labels).toContain('Gross pay — NOT what the form uses');
    const tile = (label: string) => Number((r.meta.summary ?? []).find((s) => s.label === label)!.value);
    expect(tile('Gross pay — NOT what the form uses')).toBe(Math.round(Number(slip.gross) * 100) / 100);
  });

  /**
   * 61 OF 121 PRODUCTION PAYSLIPS PREDATE r187's WAGE-BASIS STAMP. This is the case that must NOT fall
   * back to gross pay — "we do not know what this was charged on" is a different statement from "it was
   * charged on nothing", and only one of them may be printed.
   */
  it('marks a payslip with no wage basis as NOT recorded, and blocks on it instead of guessing', async () => {
    const E = await hire({ name: 'OLD RUN', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    await run('2026-07');
    // Strip the stamp, exactly as a pre-r187 payslip has it: the blob is there, the `bases` object is not.
    const [slip] = await owner.db
      .select({ id: schema.payslip.id, statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, E.employmentId))
      .limit(1);
    const st = { ...(slip.statutory as Record<string, unknown>) };
    delete st.bases;
    await owner.db.update(schema.payslip).set({ statutory: st }).where(eq(schema.payslip.id, slip.id));

    const r = await reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.borang-a', periodKey: '2026-07' });
    expect(r.rows[0].wageRecorded).toBe('');
    // NOT gross pay, and not a plausible-looking number of any kind.
    expect(r.rows[0].wage).toBe(0);
    expect(r.readiness.map((x) => x.name)).toEqual(['OLD RUN']);
    expect(r.readiness[0].missing.join(' ')).toMatch(/EPF wage basis/);
  });

  it('reconciles: the row total, the reported total and the run’s own EPF all agree', async () => {
    await hire({ name: 'ZAINAB BINTI ALI', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555', epfNumber: '18690645' });
    await hire({ name: 'ABU BIN BAKAR', hiredOn: '2024-03-01', salary: 5000, ic: '880808085555', epfNumber: '19807671' });
    const r = await run('2026-07');

    const summedEmployer = r.rows.reduce((a, row) => a + Number(row.employer), 0);
    const summedEmployee = r.rows.reduce((a, row) => a + Number(row.employee), 0);
    expect(Math.round(summedEmployer * 100)).toBe(Math.round(r.totals.employer * 100));
    expect(Math.round(summedEmployee * 100)).toBe(Math.round(r.totals.employee * 100));
    const tile = (label: string) => Number((r.meta.summary ?? []).find((s) => s.label === label)!.value);
    // Summed by an INDEPENDENT path (straight off the payslips, not through the per-employee grouping), so
    // a divergence would mean the grouping dropped or double-counted somebody.
    expect(tile('EPF in this run (EE+ER)')).toBe(Math.round((r.totals.employer + r.totals.employee) * 100) / 100);
    expect(tile('Amaun Caruman (form)')).toBe(Math.round((r.totals.employer + r.totals.employee) * 100) / 100);
  });

  it('sorts by name, so the form is reproducible month to month', async () => {
    await hire({ name: 'ZAINAB BINTI ALI', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555', epfNumber: '18690645' });
    await hire({ name: 'ABU BIN BAKAR', hiredOn: '2024-03-01', salary: 3000, ic: '880808085555', epfNumber: '19807671' });
    const r = await run('2026-07');
    expect(r.rows.map((row) => row.name)).toEqual(['ABU BIN BAKAR', 'ZAINAB BINTI ALI']);
  });

  /**
   * THE READINESS GATE'S OWN HALF. MEASURED on production 2026-08-13: 9 of 33 employees have an EPF
   * member number. Dropping the other 24 would produce a form that reconciles to nothing and understates
   * the filing by two thirds — which is exactly why they are NAMED and kept.
   */
  it('names whoever has no EPF member number, without dropping them from the form', async () => {
    await hire({ name: 'AAA WITH NUMBER', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555', epfNumber: '18690645' });
    await hire({ name: 'BBB NO NUMBER', hiredOn: '2024-03-01', salary: 3000, ic: '880808085555', epfNumber: null });
    const r = await run('2026-07');

    expect(r.readiness.map((x) => x.name)).toEqual(['BBB NO NUMBER']);
    expect(r.readiness[0].missing).toEqual(['EPF member no.']);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((row) => row.memberNo)).toContain('');
  });

  it('names an absent identity card number too, and both at once when both are absent', async () => {
    await hire({ name: 'CCC NEITHER', hiredOn: '2024-03-01', salary: 3000, ic: null, epfNumber: null });
    const r = await run('2026-07');
    expect(r.readiness[0].missing).toEqual(['EPF member no.', 'IC']);
  });

  /**
   * The authorised-representative block. It is ADVISORY: production carries one row across nine
   * companies, and blocking on it would make the feature unusable on day one for eight of them.
   */
  it('fills the representative block from the company’s EPF authority row when there is one', async () => {
    const E = await hire({ name: 'CHONG PEI YUH', hiredOn: '2024-03-01', salary: 4000, ic: '910416145530', epfNumber: '17955667' });
    await upsertCompanyStatutoryAuthority(adminCtx(b), {
      companyId: b.companyId,
      authority: 'epf',
      phone: '0123081733',
      email: 'rep@example.com',
      signatoryPersonId: E.personId,
    });
    const r = await run('2026-07');
    const h = r.meta.formHeader!;
    expect(h.repName).toBe('CHONG PEI YUH');
    // The signatory's identity card number comes off their own statutory record, not off the authority row.
    expect(h.repIc).toBe('910416145530');
    expect(h.repPhone).toBe('0123081733');
    expect(h.repEmail).toBe('rep@example.com');
    // …and it does NOT block: readiness is about the employees and the employer reference.
    expect(r.readiness).toEqual([]);
  });

  it('leaves the representative block blank rather than inventing one, and still produces the form', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await run('2026-07');
    const h = r.meta.formHeader!;
    expect([h.repName, h.repIc, h.repPosition, h.repPhone, h.repEmail]).toEqual(['', '', '', '', '']);
    expect(r.readiness).toEqual([]);
  });

  /** A month with no run is not an empty form: the screen says so, and the header is still there. */
  it('reports no batch rather than an empty form for a month that was never run', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await reportPreview(adminCtx(b), {
      companyId: b.companyId,
      reportId: 'my.borang-a',
      periodKey: '2099-12',
    });
    expect(r.meta.hasBatch).toBe(false);
    expect(r.rows).toEqual([]);
    // The header survives, +1 rule included, so the screen can name the month it found nothing for.
    expect(r.meta.formHeader!.contributionMonth).toBe('01 / 2100');
  });

  /** A malformed period is refused rather than read as a literal batch key that finds nothing. */
  it('refuses a period that is not YYYY-MM', async () => {
    await expect(
      reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.borang-a', periodKey: '2026-13' }),
    ).rejects.toThrow(/YYYY-MM/);
  });
});

/**
 * END TO END: what the read produces feeds BOTH outputs, and the two agree — which is the whole reason
 * they are built from one row set rather than two queries.
 */
describe('the read feeds both outputs', () => {
  it('produces a form whose page totals add up and whose upload file balances', async () => {
    for (let i = 0; i < 25; i += 1) {
      await hire({
        name: `EMP ${String(i).padStart(2, '0')}`,
        hiredOn: '2024-03-01',
        salary: 3000 + i,
        ic: `9001010${String(100000 + i).slice(1)}`,
        epfNumber: String(20000000 + i),
      });
    }
    const r = await run('2026-07');
    const form = borangAFrom({ header: r.meta.formHeader, rows: r.rows });
    expect(form.employees).toBe(25);
    expect(form.pages.length).toBe(2); // 22 rows per sheet

    // The paper: page sums == the form total, and the last carry-out IS the total.
    const summed = form.pages.reduce((a, p) => a + p.pageEmployer, 0);
    expect(Math.round(summed * 100)).toBe(Math.round(form.totalEmployer * 100));
    expect(form.pages[form.pages.length - 1].carryOutEmployer).toBe(form.totalEmployer);
    expect(Math.round(form.totalEmployer * 100)).toBe(Math.round(r.totals.employer * 100));

    // The file: same rows, and the invariant holds on the emitted bytes.
    const rows = form.pages.flatMap((p) => p.rows);
    expect(borangAFileReadiness({ employerRef: form.employerRef, rows }).ok).toBe(true);
    const text = buildBorangAFile({
      employer: { epfRefNo: form.employerRef, code: 'DSK', periodMonth: 8, periodYear: 2026 },
      // THREE amounts per line, in the sample file's own order, and the two contributions are never
      // added together — cc74dcb2 decoded a real KWSP file and the 02 record has a box for each.
      employees: rows.map((row) => ({
        epfMemberNo: row.memberNo,
        icNumber: row.ic,
        name: row.name,
        staffNo: row.staffNo,
        employerContribution: row.employer,
        employeeContribution: row.employee,
        wages: row.wage,
      })),
    });
    const t = parseBorangAFileTotals(text);
    expect(t.detailCount).toBe(25);
    // THE TWO OUTPUTS AGREE, which is the property that makes "check the paper, upload the file" safe.
    expect(t.detailEmployerCents).toBe(Math.round(form.totalEmployer * 100));
    expect(t.detailEmployeeCents).toBe(Math.round(form.totalEmployee * 100));
    expect(t.detailEmployerCents + t.detailEmployeeCents).toBe(Math.round(form.totalContribution * 100));
    expect(t.detailWageCents).toBe(Math.round(form.totalWage * 100));
    expect(t.headerEmployerCents).toBe(t.trailerEmployerCents);
    expect(t.headerEmployeeCents).toBe(t.trailerEmployeeCents);
    // The hash total counts the very member numbers on the file, so a lost 02 line would change it.
    expect(t.controlTotal).toBe(t.memberNoSum);
  });
});


/**
 * ─── r227, CORRECTED IN r372 — WHAT AN ADDITIONAL RUN DOES TO THE UPAH COLUMN ────────────────────
 *
 * THIS COVERAGE DID NOT EXIST BEFORE r227, and its absence is why a change to a FILED STATUTORY FORM
 * nearly shipped unmeasured. `createAdditionalRun` appeared ZERO times in test/borang-a.test.ts,
 * test/borang-8a.test.ts, test/kwsp-borang-a-file.test.ts, test/socso-eis-file.test.ts and
 * test/cp39-form.test.ts — counted, not assumed. Every statutory-form guard in this repository ran a
 * SINGLE regular run, so the whole suite was green whatever an extra run did to the figures on the paper.
 *
 * ── THE CLAIM THIS BLOCK USED TO PIN, QUOTED SO IT CANNOT COME BACK BY ACCIDENT ──────────────────
 * Between r227 and r372 the two cases below asserted the DEFECT as a deliberately recorded fact, under
 * this header:
 *
 *     "WHAT IS PINNED HERE IS THE FACT, NOT A FIX. Nothing in r226/r227 changes how `bases` are stamped
 *      or how this form sums them; the reporter is being shown the change before it is filed, and that
 *      decision is theirs. The point of these cases is that the number can no longer move without a test
 *      saying so."
 *
 * and their assertions read:
 *
 *     expect(wageOf(after, 'AAA KEPT')).toBeCloseTo(oneMonth * 2, 2);          // the doubling
 *     expect(wageOf(after, 'AAA PAID')).toBeGreaterThanOrEqual(oneMonth * 2);  // and for a paid person
 *
 * THE REPORTER MADE THAT DECISION (item d4f6848f, approved 2026-09-30): report the month's wage ONCE and
 * move no contribution amount. The claim above is RETIRED, not deleted — it is the number this round
 * changed, and a reader of a statutory guard is entitled to see what it used to say.
 *
 * ── THE MECHANISM, WHICH DID NOT CHANGE, BECAUSE THE FIX IS NOT IN THE KERNEL ────────────────────
 * `statutory.bases.epf` is stamped from `wagesExOt` (core/payroll.ts) — the FULL month's wage — on EVERY
 * payslip, including an additional run's, because on an additional run the bases are deliberately the
 * CUMULATIVE month (r187: they must match the `now` side of the statutory delta the run charges). It is
 * IDENTICAL on each run of the month, not accumulating. The Borang A read used to SUM
 * `bases.epf + bases.epfAdditional` across every payslip in the month, and summing a whole-month figure
 * counts the month once per run. The read now takes it ONCE, from the greatest `run_seq`
 * (localization/my/statutory-month-wage.ts). The stamp is untouched; so is every contribution.
 *
 * ── WHAT EACH CASE BELOW ASSERTS IN ONE BREATH ───────────────────────────────────────────────────
 * The wage AND the contributions, in the SAME test, deliberately: the contributions are what must not
 * move, so a later "simplification" of the fold that quietly re-summed the wage would have to break an
 * assertion about money to do it.
 */
describe('r372 — an additional run and the Upah column', () => {
  const salary = 4000;

  /** The regular run, then a bonus run that pays NOBODY in it — the shape the reported case produces. */
  async function twoRuns(period: string) {
    // `multi_cycle_payroll` is granted BEFORE the snapshot is taken; a synthetic adminCtx snapshot is
    // point-in-time and would read the grant off (the discipline every multi-cycle test here follows).
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);
    const reg = await createBatch(a, { companyId: b.companyId, payPeriod: period });
    await generatePayslips(a, { batchId: reg.batchId });
    const extra = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: period, runType: 'bonus' });
    return { a, reg, extra };
  }

  const preview = (a: Awaited<ReturnType<typeof entitledCtx>>, period: string) =>
    reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-a', periodKey: period });
  const wageOf = (r: Awaited<ReturnType<typeof preview>>, name: string) =>
    Number(r.rows.find((row) => row.name === name)!.wage);
  const contribOf = (r: Awaited<ReturnType<typeof preview>>, name: string) => {
    const row = r.rows.find((x) => x.name === name)!;
    return { employer: Number(row.employer), employee: Number(row.employee) };
  };
  /**
   * The month's EPF legs added straight off the payslips — INDEPENDENTLY of the report — so "the
   * contributions did not move" is measured against the stored figures and not against the report's own
   * arithmetic. They are deltas (ADR-0024) and summing them is correct; that is the half that must stay.
   */
  async function epfPaidInMonth(employmentId: string, batchIds: string[]) {
    const slips = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(
        and(eq(schema.payslip.employmentId, employmentId), inArray(schema.payslip.batchId, batchIds)),
      );
    let employer = 0;
    let employee = 0;
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Record<string, number>;
      employer += Number(st.epfEmployer ?? 0);
      employee += Number(st.epfEmployee ?? 0);
    }
    return { employer: Math.round(employer * 100) / 100, employee: Math.round(employee * 100) / 100 };
  }
  /** The bases the month's GREATEST run_seq stamped — the figure the corrected read is supposed to print. */
  async function latestBases(batchIds: string[], employmentId: string) {
    const rows = await owner.db
      .select({ statutory: schema.payslip.statutory, runSeq: schema.payrollBatch.runSeq })
      .from(schema.payslip)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(
        and(eq(schema.payslip.employmentId, employmentId), inArray(schema.payslip.batchId, batchIds)),
      );
    // An explicit fold over run_seq, exactly as the derivation does it — never `rows[rows.length - 1]`.
    let best: { runSeq: number; bases: Record<string, number> } | null = null;
    for (const r of rows) {
      const bases = (r.statutory as { bases?: Record<string, number> }).bases;
      if (!bases) continue;
      if (best === null || r.runSeq > best.runSeq) best = { runSeq: r.runSeq, bases };
    }
    return best;
  }

  /**
   * ONE MONTH, TWO EMPLOYEES, IDENTICAL IN EVERY RESPECT EXCEPT WHETHER THE BONUS RUN PROCESSED THEM.
   *
   * KEPT is held in the run by an OVERTIME figure keyed on the bonus run — a door the skip counts
   * (r226: a keyed transaction always keeps its owner, so the reason printed is never false) and that an
   * additional run does not actually PAY (`slipOvertime` is forced to 0). So the kernel itself produces
   * the genuine article: a payslip worth nothing, carrying a full month's wage in its EPF basis. No
   * surgery on any row. THAT is the shape that used to add a second month to Upah.
   */
  it('a zero-value bonus payslip leaves Upah at ONE month, and moves no contribution', async () => {
    const kept = await hire({ name: 'AAA KEPT', hiredOn: '2024-03-01', salary, ic: '900101015555', epfNumber: '18690645' });
    await hire({ name: 'BBB SKIPPED', hiredOn: '2024-03-01', salary, ic: '880808085555', epfNumber: '19807671' });
    const { a, reg, extra } = await twoRuns('2026-07');

    // BEFORE the extra run: one payslip each, one month's wage each. This is the figure that would be filed.
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

    // The extra run wrote ONE payslip and it is worth NOTHING — a zero-value row, exactly the reported case.
    const extraSlips = await owner.db
      .select({ gross: schema.payslip.grossPay, statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, extra.batchId));
    expect(extraSlips).toHaveLength(1);
    // `grossPay = round2(bonus)` on an additional run, and there is no bonus — so this is structurally a
    // zero-value payslip, not one that merely happens to total nothing.
    expect(Number(extraSlips[0].gross)).toBe(0);
    // …and it DOES carry a full month's wage in its own EPF basis. That fact has not changed and is why
    // the old SUM was wrong; what changed is that the read no longer adds it to the earlier run's.
    const basesEpf = (extraSlips[0].statutory as { bases?: Record<string, number> }).bases!.epf;
    expect(Number(basesEpf)).toBeCloseTo(oneMonth, 2);

    const after = await preview(a, '2026-07');
    // ── THE FIX, STATED AS A NUMBER (item d4f6848f). The person the run kept still has ONE month's wage
    //    on a one-month form. The retired assertion at the top of this block read `oneMonth * 2`.
    expect(wageOf(after, 'AAA KEPT')).toBeCloseTo(oneMonth, 2);
    expect(wageOf(after, 'AAA KEPT')).toBeLessThan(oneMonth * 2);
    // The person it left out is untouched — one month, as filed, exactly as before.
    expect(wageOf(after, 'BBB SKIPPED')).toBeCloseTo(oneMonth, 2);
    // ── AND THE CONTRIBUTIONS DID NOT MOVE. Asserted in the SAME test as the wage, on purpose: these two
    //    claims are the whole of what the reporter approved, and splitting them lets one be "simplified".
    expect(contribOf(after, 'AAA KEPT')).toEqual(keptContribBefore);
    expect(contribOf(after, 'AAA KEPT')).toEqual(await epfPaidInMonth(kept.employmentId, [reg.batchId, extra.batchId]));
    expect(contribOf(after, 'BBB SKIPPED')).toEqual(contribOf(before, 'BBB SKIPPED'));
    // Nobody is held: the two runs agree about the wage, so the document is still downloadable.
    expect(after.readiness.flatMap((x) => x.missing).filter((m) => m.includes('DIFFERENT wages'))).toEqual([]);
  });

  /**
   * THE HALF THE r226 SKIP NEVER FIXED, AND THE ONE THIS ROUND EXISTS FOR. Somebody the bonus run PAYS
   * also used to get a second full month's wage in Upah, because the doubling is a property of the bases
   * and not of the zero-value payslip. Now their Upah is the month's normal wage plus the month's
   * additional stream, counted once each — which is what Upah is.
   */
  it('reports one month plus the month’s bonus for somebody the bonus run actually pays', async () => {
    const paid = await hire({ name: 'AAA PAID', hiredOn: '2024-03-01', salary, ic: '900101015555', epfNumber: '18690645' });
    const { a, reg, extra } = await twoRuns('2026-07');
    const before = await preview(a, '2026-07');
    const oneMonth = wageOf(before, 'AAA PAID');

    await setPayrollInput(a, {
      batchId: extra.batchId,
      employmentId: paid.employmentId,
      overtimeAmount: 0,
      bonusAmount: 1000,
    });
    await generatePayslips(a, { batchId: extra.batchId });

    const after = await preview(a, '2026-07');
    // THE FIGURE, DERIVED FROM THE KERNEL'S OWN STAMP rather than from a hardcoded 5,000: Upah is the
    // greatest run's `bases.epf + bases.epfAdditional`, and `bases.epfAdditional` is CUMULATIVE for the
    // month, so that one row already carries the whole month's bonus. The retired assertion read
    // `toBeGreaterThanOrEqual(oneMonth * 2)`.
    const latest = await latestBases([reg.batchId, extra.batchId], paid.employmentId);
    expect(latest).not.toBeNull();
    const expected = Math.round((Number(latest!.bases.epf) + Number(latest!.bases.epfAdditional)) * 100) / 100;
    expect(wageOf(after, 'AAA PAID')).toBeCloseTo(expected, 2);
    expect(wageOf(after, 'AAA PAID')).toBeCloseTo(oneMonth + 1000, 2);
    // NEVER TWICE THE MONTH AGAIN. The bonus is smaller than a month's salary here precisely so that the
    // "one month + bonus" answer and the "two months" answer cannot be the same number.
    expect(wageOf(after, 'AAA PAID')).toBeLessThan(oneMonth * 2);
    // And the money: still the sum of the two runs' EPF legs, unchanged by any of this.
    expect(contribOf(after, 'AAA PAID')).toEqual(await epfPaidInMonth(paid.employmentId, [reg.batchId, extra.batchId]));
  });

  /**
   * THE ANSWER MUST NOT DEPEND ON WHICH RUN LANDED FIRST (ADR-0085 step 5 / item 23e7dac3: a bonus, an
   * off-cycle or an advance salary may legitimately lead the month, and the regular run then RESTATES it).
   * Two months, the same salary and the same bonus, opposite orders — one Upah.
   *
   * This is the case a `[length-1]` fold passes by luck in one order and fails in the other, and it is why
   * the derivation folds on `run_seq` rather than on the row the query happened to return last.
   */
  it('gives the same Upah whether the bonus run or the regular run led the month', async () => {
    const e = await hire({ name: 'AAA PAID', hiredOn: '2024-03-01', salary, ic: '900101015555', epfNumber: '18690645' });
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);

    // JULY: the regular run leads, the bonus run follows.
    const julyReg = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId: julyReg.batchId });
    const julyBonus = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: '2026-07', runType: 'bonus' });
    await setPayrollInput(a, { batchId: julyBonus.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    await generatePayslips(a, { batchId: julyBonus.batchId });

    // AUGUST: the bonus run leads, the regular run follows and restates the month.
    const augBonus = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: '2026-08', runType: 'bonus' });
    await setPayrollInput(a, { batchId: augBonus.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    await generatePayslips(a, { batchId: augBonus.batchId });
    const augReg = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: augReg.batchId });

    // The run sequences really are opposite, or this test is asserting nothing.
    const seqs = async (ids: string[]) =>
      (
        await owner.db
          .select({ runSeq: schema.payrollBatch.runSeq, runType: schema.payrollBatch.runType })
          .from(schema.payrollBatch)
          .where(inArray(schema.payrollBatch.id, ids))
      )
        .sort((x, y) => x.runSeq - y.runSeq)
        .map((x) => x.runType);
    expect(await seqs([julyReg.batchId, julyBonus.batchId])).toEqual(['regular', 'bonus']);
    expect(await seqs([augBonus.batchId, augReg.batchId])).toEqual(['bonus', 'regular']);

    const july = wageOf(await preview(a, '2026-07'), 'AAA PAID');
    const august = wageOf(await preview(a, '2026-08'), 'AAA PAID');
    expect(july).toBeCloseTo(august, 2);
    // …and it is ONE month plus the bonus, not two months, in both orders.
    expect(july).toBeCloseTo(salary + 1000, 2);
    expect(august).toBeLessThan(salary * 2);
  });

  /**
   * ── AND WHERE ONE FIGURE IS NOT THE TRUTH, THE FORM IS HELD (r372) ───────────────────────────────
   *
   * A mid-month pay change makes the month's runs disagree about `bases.epf`, and then no single Upah is
   * the month's wage. `localization/my/multicycle-worksheet.ts` already refuses this exact shape as
   * `inconsistent_run_bases`; printing whichever run happened to be last would be a figure nobody can
   * stand behind (CLAUDE.md §8), which is the one thing a statutory form may not contain.
   *
   * THE RAISE IS KEYED BETWEEN THE TWO RUNS, which is the reporter's own case ("somebody's pay changed
   * part way through the month"), and the DIVERGENCE IS PRODUCED BY THE KERNEL rather than by editing a
   * stored row: the regular run's payslip keeps the figure it was charged on, and the bonus run re-derives
   * the new one (`generatePayslips` reads the OPEN compensation row, `isNull(validTo)`).
   *
   * THE GATE ITSELF IS NOT RE-ASSERTED HERE. `app/payroll/borang-a/shared.ts` already refuses the document
   * for ANY entry in this list, and test/borang-a.test.ts pins that decision on its source; what this case
   * has to prove is that the person REACHES the list, by name, with a reason that is true.
   */
  it('names the person and holds the form when the month’s runs disagree about the wage', async () => {
    const e = await hire({ name: 'AAA CHANGED', hiredOn: '2024-03-01', salary, ic: '900101015555', epfNumber: '18690645' });
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

    // The two runs really were charged on different EPF wages, or this test asserts nothing.
    const stamped = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(
        and(
          eq(schema.payslip.employmentId, e.employmentId),
          inArray(schema.payslip.batchId, [reg.batchId, extra.batchId]),
        ),
      );
    const epfBases = stamped
      .map((r) => Number((r.statutory as { bases?: Record<string, number> }).bases?.epf ?? 0))
      .sort((x, y) => x - y);
    expect(epfBases).toHaveLength(2);
    expect(Math.abs(epfBases[1] - epfBases[0])).toBeGreaterThan(0.005);

    const after = await preview(a, '2026-07');
    const named = after.readiness.find((x) => x.name === 'AAA CHANGED');
    expect(named, 'the person whose month has no single wage must be NAMED').toBeTruthy();
    expect(named!.missing.join(' ')).toContain('EPF wage basis');
    // The reason says the runs DISAGREE — not that the basis is absent, which is a different refusal with
    // its own wording ("this run predates the record of what EPF was charged on") and would be false here.
    expect(named!.missing.join(' ')).toContain('DIFFERENT wages');
    expect(named!.missing.join(' ')).not.toContain('predates');
    // …and they are NOT dropped from the form, which would produce a Borang A reconciling to nothing.
    expect(after.rows.map((r) => r.name)).toContain('AAA CHANGED');
    // The review screen still shows a figure beside the warning — it is real data an operator has to
    // compare the runs against. `wageRecorded` keeps its own meaning: a basis WAS recorded, twice.
    expect(after.rows.find((r) => r.name === 'AAA CHANGED')!.wageRecorded).toBe('yes');
  });
});

/**
 * r372 (item f022dd70) — THE PAYROLL CYCLE SELECTION, against a real kernel and a real Postgres.
 *
 * `test/statutory-month-wage.test.ts` pins the FOLD with no database, which is where the arithmetic
 * belongs. This block pins the three things only a database can answer: that the selection reaches the
 * query at all, that the figures it produces are the ones the SELECTED runs actually charged, and that
 * omitting the parameter takes the old path and produces the old numbers.
 *
 * ⚠️ THE DB TEST IS THE MORE EASILY FOOLED ONE, NOT THE STRONGER ONE. r372's own wage fix had a revert
 * test that FAILED in the pure test and PASSED here, because Postgres happened to return the rows in
 * `run_seq` order. So nothing below asserts a position, an ordering or a row index: every assertion is an
 * invariant about a named employee's figures, and the two that could be satisfied by luck (the wage) are
 * paired with the contributions they are supposed to agree with.
 */
describe('r372 — filing one payroll cycle of a month on its own', () => {
  const salary = 4000;
  const BONUS = 1200;

  /**
   * July, with TWO employees and two runs: the regular run pays them both, the bonus run pays a real bonus
   * to ONE of them.
   *
   * THE SECOND EMPLOYEE IS THE POINT OF THE FIXTURE, not padding. An additional run SKIPS anybody with no
   * keyed input, so ZZZ REGULAR ONLY genuinely has no payslip on the bonus run — which is what makes
   * "an unticked cycle contributes no employee" an assertion about the filter rather than about a person
   * who was never in the month at all.
   */
  async function julyWithBonus() {
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);
    const e = await hire({
      name: 'AAA CYCLE',
      hiredOn: '2024-03-01',
      salary,
      ic: '900101015555',
      epfNumber: '18690645',
    });
    await hire({
      name: 'ZZZ REGULAR ONLY',
      hiredOn: '2024-03-01',
      salary,
      ic: '880808085555',
      epfNumber: '19807671',
    });
    const reg = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId: reg.batchId });
    const bonus = await createAdditionalRun(a, {
      companyId: b.companyId,
      payPeriod: '2026-07',
      runType: 'bonus',
    });
    await setPayrollInput(a, {
      batchId: bonus.batchId,
      employmentId: e.employmentId,
      overtimeAmount: 0,
      bonusAmount: BONUS,
    });
    const gen = await generatePayslips(a, { batchId: bonus.batchId });
    // Asserted, not assumed: the fixture only means what it claims if the kernel really left the second
    // employee out of the bonus run.
    expect('skipped' in gen && Array.isArray(gen.skipped) ? gen.skipped.map((x) => x.name) : []).toEqual([
      'ZZZ REGULAR ONLY',
    ]);
    // The run numbers are READ BACK rather than assumed to be 1 and 2 — `run_seq` is the kernel's to
    // allocate, and a test that hard-coded them would be pinning an implementation detail of createBatch.
    const rows = await owner.db
      .select({ id: schema.payrollBatch.id, runSeq: schema.payrollBatch.runSeq, runType: schema.payrollBatch.runType })
      .from(schema.payrollBatch)
      .where(
        and(eq(schema.payrollBatch.companyId, b.companyId), eq(schema.payrollBatch.payPeriod, '2026-07')),
      );
    const regularSeq = rows.find((r) => r.runType === 'regular')!.runSeq;
    const bonusSeq = rows.find((r) => r.runType === 'bonus')!.runSeq;
    return { a, e, regularSeq, bonusSeq, batchIds: rows.map((r) => r.id) };
  }

  const view = (a: Awaited<ReturnType<typeof entitledCtx>>, runSeqs?: number[]) =>
    reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-a', periodKey: '2026-07', runSeqs });
  const rowOf = (r: { rows: Record<string, unknown>[] }, name: string) =>
    r.rows.find((x) => x.name === name)!;

  /**
   * ⚠️ THE ASSERTION THE WHOLE FEATURE TURNS ON. A Bonus-only Borang A must carry the BONUS as Upah, with
   * the bonus run's own contributions beside it. The implementation this replaced — filtering the payslip
   * query and handing the ordinary fold a shorter list — files a full month's salary here, because the
   * kernel stamps `bases.epf` (the whole month's normal wage) on the bonus run too.
   */
  it('a Bonus-only filing carries the bonus as Upah, not the month’s salary', async () => {
    const { a, bonusSeq } = await julyWithBonus();
    const whole = rowOf(await view(a), 'AAA CYCLE');
    const bonusOnly = rowOf(await view(a, [bonusSeq]), 'AAA CYCLE');

    expect(Number(whole.wage)).toBeCloseTo(salary + BONUS, 2);
    expect(Number(bonusOnly.wage)).toBeCloseTo(BONUS, 2);
    // …and it is NOT the whole month's figure, which is what the naive implementation would print.
    expect(Number(bonusOnly.wage)).toBeLessThan(Number(whole.wage));

    // THE CONTRIBUTIONS AGREE WITH THE WAGE. A wage that shrank while the contributions did not is the
    // very mismatch this is here to prevent, so both are asserted together rather than the wage alone.
    expect(Number(bonusOnly.employer)).toBeGreaterThan(0);
    expect(Number(bonusOnly.employer)).toBeLessThan(Number(whole.employer));
    expect(Number(bonusOnly.employee)).toBeLessThan(Number(whole.employee));
  });

  it('a regular-only filing carries the month’s salary and none of the bonus', async () => {
    const { a, regularSeq } = await julyWithBonus();
    const regularOnly = rowOf(await view(a, [regularSeq]), 'AAA CYCLE');
    expect(Number(regularOnly.wage)).toBeCloseTo(salary, 2);
    // The colleague the bonus run skipped is unaffected either way — their month is one run long.
    expect(Number(rowOf(await view(a, [regularSeq]), 'ZZZ REGULAR ONLY').wage)).toBeCloseTo(salary, 2);
    expect(Number(rowOf(await view(a), 'ZZZ REGULAR ONLY').wage)).toBeCloseTo(salary, 2);
  });

  /**
   * THE NO-CHANGE GUARANTEE, MEASURED. Omitting the parameter must produce the identical report — not a
   * similar one. Compared as a whole object, so a field that moved cannot hide behind the two the other
   * tests happen to read.
   */
  it('omitting the selection produces exactly the report the month produced before', async () => {
    const { a, regularSeq, bonusSeq } = await julyWithBonus();
    const omitted = await view(a);
    const everyRun = await view(a, [regularSeq, bonusSeq]);
    expect(omitted.rows).toEqual(everyRun.rows);
    expect(omitted.totals).toEqual(everyRun.totals);
    expect(omitted.readiness).toEqual(everyRun.readiness);
  });

  /**
   * r407 (item 4f45f9b0) — THE SAME TWO GUARANTEES, THROUGH THE NEW DOOR: the drawn page.
   *
   * The criteria step's Select All submits NO `run` parameter (components/run-picker.tsx), so the form an
   * operator downloads after ticking everything is the unfiltered one by construction. This pins the other
   * half: even a selection that NAMES every run renders the very same bytes, so the two cannot drift. Date
   * is frozen only around the render (pdf-lib stamps CreationDate/ModDate); the read's own Tarikh DiCetak
   * is today's for both.
   */
  it('r407 — ticking every cycle renders the very same PDF bytes as no selection', async () => {
    const { a, regularSeq, bonusSeq } = await julyWithBonus();
    const omitted = await view(a);
    const everyRun = await view(a, [regularSeq, bonusSeq]);
    const draw = async (r: Awaited<ReturnType<typeof view>>) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-12T02:00:00Z'));
      try {
        return Buffer.from(await renderBorangAPdf(borangAFrom({ header: r.meta.formHeader!, rows: r.rows })));
      } finally {
        vi.useRealTimers();
      }
    };
    const [x, y] = [await draw(omitted), await draw(everyRun)];
    expect(x.byteLength).toBeGreaterThan(1000);
    expect(x.equals(y), 'Select All drew a different Borang A from no selection').toBe(true);
  });

  it('r407 — a bonus-only Borang A PRINTS the bonus as Upah, with the bonus run\'s own contributions', async () => {
    const { a, bonusSeq } = await julyWithBonus();
    const r = await view(a, [bonusSeq]);
    const form = borangAFrom({ header: r.meta.formHeader!, rows: r.rows });
    const drawn = Buffer.from(await renderBorangAPdf(form));
    const texts = drawnTexts(drawn);
    const row = form.pages[0].rows.find((x) => x.name === 'AAA CYCLE')!;
    expect(row.wage).toBeCloseTo(BONUS, 2);
    // ON THE PAGE, not only in the read: the Upah cell says the bonus, never the month's salary.
    expect(texts).toContain(money(BONUS));
    expect(texts).not.toContain(money(salary));
    expect(texts).not.toContain(money(salary + BONUS));
    expect(texts).toContain(money(row.employer));
    expect(texts).toContain(money(row.employee));
  });

  /**
   * r411 (item 4f45f9b0) — THE BBCD'S AMAUN CARUMAN IS THE BORANG A TOTAL, for every selection. Measured
   * against the stored payslips, not only against the form it is projected from: a projection that agreed
   * with a Borang A that had itself drifted would agree with the wrong number. Each selection is also drawn,
   * and the drawn Amaun Caruman box is read back off the page.
   */
  it('r411 — the BBCD amount equals the Borang A total for all, regular-only and bonus-only selections', async () => {
    const { a, regularSeq, bonusSeq } = await julyWithBonus();
    const slips = await owner.db
      .select({ statutory: schema.payslip.statutory, runSeq: schema.payrollBatch.runSeq })
      .from(schema.payslip)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(and(eq(schema.payrollBatch.companyId, b.companyId), eq(schema.payrollBatch.payPeriod, '2026-07')));
    const storedSen = (seqs: number[]) =>
      slips
        .filter((x) => seqs.includes(x.runSeq))
        .reduce((acc, x) => {
          const st = (x.statutory ?? {}) as Record<string, number>;
          return acc + Math.round(Number(st.epfEmployer ?? 0) * 100) + Math.round(Number(st.epfEmployee ?? 0) * 100);
        }, 0);
    const amounts: Record<string, number> = {};
    for (const [label, sel, seqs] of [
      ['all', undefined, [regularSeq, bonusSeq]],
      ['regular', [regularSeq], [regularSeq]],
      ['bonus', [bonusSeq], [bonusSeq]],
    ] as const) {
      const r = await view(a, sel ? [...sel] : undefined);
      const form = borangAFrom({ header: r.meta.formHeader!, rows: r.rows });
      const bbcd = borangBbcdFrom(form);
      expect(bbcd.amount, label).toBe(form.totalContribution);
      expect(Math.round(bbcd.amount * 100), `${label}: the stored payslips`).toBe(storedSen([...seqs]));
      expect(storedSen([...seqs]), label).toBeGreaterThan(0);
      // ON THE PAGE: the BBCD box and the Borang A box print the same string.
      const bbcdTexts = drawnTexts(Buffer.from(await renderBorangBbcdPdf(bbcd)));
      const baTexts = drawnTexts(Buffer.from(await renderBorangAPdf(form)));
      expect(bbcdTexts.filter((t) => /^[\d,]+\.\d\d$/.test(t)), label).toEqual([money(form.totalContribution)]);
      expect(baTexts, label).toContain(money(bbcd.amount));
      amounts[label] = Math.round(bbcd.amount * 100);
    }
    // The three are three different numbers, and the parts add up to the whole.
    expect(amounts.regular).not.toBe(amounts.bonus);
    expect(amounts.regular + amounts.bonus).toBe(amounts.all);
  });

  it('r411 — ticking every cycle draws the very same BBCD bytes as no selection', async () => {
    const { a, regularSeq, bonusSeq } = await julyWithBonus();
    const draw = async (sel?: number[]) => {
      const r = await view(a, sel);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-12T02:00:00Z'));
      try {
        return Buffer.from(await renderBorangBbcdPdf(borangBbcdFrom(borangAFrom({ header: r.meta.formHeader!, rows: r.rows }))));
      } finally {
        vi.useRealTimers();
      }
    };
    const [x, y, z] = [await draw(), await draw([regularSeq, bonusSeq]), await draw([bonusSeq])];
    expect(x.byteLength).toBeGreaterThan(1000);
    expect(x.equals(y), 'Select All drew a different BBCD from no selection').toBe(true);
    // …and the comparison can tell two BBCDs apart: a bonus-only one is different bytes.
    expect(x.equals(z)).toBe(false);
  });

  it('leaves out an employee the selected cycles never paid, and keeps them for the ones that did', async () => {
    const { a, regularSeq, bonusSeq } = await julyWithBonus();
    // The whole month, and a regular-only filing, both carry BOTH people…
    for (const sel of [undefined, [regularSeq]]) {
      const names = (await view(a, sel)).rows.map((r) => r.name);
      expect(names, String(sel)).toContain('AAA CYCLE');
      expect(names, String(sel)).toContain('ZZZ REGULAR ONLY');
    }
    // …and a Bonus-only filing carries only the person the bonus run actually paid. Not "present with
    // zeros": absent, because a statutory return names contributors and nobody else.
    const bonusNames = (await view(a, [bonusSeq])).rows.map((r) => r.name);
    expect(bonusNames).toEqual(['AAA CYCLE']);
  });

  it('answers a selection that names no run of this month apart from "no payroll run"', async () => {
    const { a } = await julyWithBonus();
    const nothing = await view(a, [97]);
    // The month HAS runs — so `hasBatch` stays true and the third state is what says the selection missed.
    expect(nothing.meta.hasBatch).toBe(true);
    expect(nothing.meta.selectionEmpty).toBe(true);
    expect(nothing.rows).toEqual([]);
    // …and an unfiltered read of the same month says neither of those things.
    const whole = await view(a);
    expect(whole.meta.selectionEmpty).toBeUndefined();
    expect(whole.rows.length).toBeGreaterThan(0);
  });

  /**
   * A DRAFT RUN IS NOT OFFERED AND CONTRIBUTES NOTHING. Asserted through the read that the pop-up uses,
   * so the control and the file cannot disagree about which runs exist — the r296 shape.
   */
  it('the eligible-runs read offers only completed runs that actually paid somebody', async () => {
    const { a, regularSeq, bonusSeq } = await julyWithBonus();
    await createAdditionalRun(a, { companyId: b.companyId, payPeriod: '2026-07', runType: 'off_cycle' });
    const offered = await listFilableRunsForPeriod(a, {
      companyIds: [b.companyId],
      companyId: b.companyId,
      periodKey: '2026-07',
    });
    // The off-cycle run was created and never generated: draft, no payslips, and therefore not offered.
    expect(offered.map((r) => r.runSeq).sort((x, y) => x - y)).toEqual([regularSeq, bonusSeq].sort((x, y) => x - y));
    for (const r of offered) expect(['processed', 'closed']).toContain(r.status);
  });

  it('the eligible-runs read fails closed for a company outside the caller’s scope', async () => {
    const { a } = await julyWithBonus();
    expect(
      await listFilableRunsForPeriod(a, { companyIds: [], companyId: b.companyId, periodKey: '2026-07' }),
    ).toEqual([]);
    expect(
      await listFilableRunsForPeriod(a, {
        companyIds: [randomUUID()],
        companyId: b.companyId,
        periodKey: '2026-07',
      }),
    ).toEqual([]);
  });
});
