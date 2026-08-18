/**
 * e0cd4583 — THE CP39 PRINTED FORM'S READ, AGAINST A REAL DATABASE.
 *
 * `test/cp39-form.test.ts` pins the RULES with no database at all — the dating rule, the pagination, the
 * two blank columns, the fidelity claim — which is what makes them cheap to assert and impossible to get
 * wrong by accident. NONE of it executes a single line of `localization/my/cp39-form.ts`. This file pins
 * that half: that the four queries join what they claim to join, that the employer header comes off the
 * company's own statutory row, that the preparer block resolves the signatory's CURRENT job title, that
 * the per-employee map hands each person THEIR OWN passport, that a CP38 instalment is counted ONCE for a
 * month that was run twice, and that a period the screen cannot validate degrades instead of throwing.
 *
 * Every one of those is a defect no pure test can see and every one produces a plausible-looking document:
 * a missing join yields an empty box that reads as a genuine data gap and blocks the download; a wrong
 * `.limit(1)` prints somebody's OLD job title beside their name on a tax record; a double-counted CP38
 * over-reports a payment; and a throw on the read path 500s two screens that have always degraded to a
 * card. `test/borang-a-report.test.ts` is this file's template, for the same reason and the same form.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
import * as schema from '../db/schema';
import { hireEmployee, setEmployeeCode, setEmploymentAssignment } from '../core/org';
import { setCompensation } from '../core/comp';
import { setPassportProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { upsertCompanyStatutoryAuthority } from '../core/statutory-authority';
import { setCp38 } from '../core/cp38';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import { reportPreview } from '../core/reporting';
import { CP39_FORM_HEADER_KEYS, cp39FormFrom, missingCp39FormHeader } from '../lib/cp39-form';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // The employer header. Both numbers already existed under these names, which is why this round needed
  // no migration: No. Majikan is `lhdn_employer_no` and No. Pendaftaran Perniagaan is `ssm_registration_no`.
  await setCompanyStatutoryMY(adminCtx(b), {
    companyId: b.companyId,
    lhdnEmployerNo: 'E 908915-10',
    ssmRegistrationNo: '199801012345',
  });
  await owner.db
    .update(schema.company)
    .set({
      addressLine1: 'Level 12, Menara Satu',
      city: 'Kuala Lumpur',
      state: 'Wilayah Persekutuan',
      postcode: '50450',
    })
    .where(eq(schema.company.id, b.companyId));
});

let seq = 0;
async function hire(p: {
  name: string;
  salary: number;
  ic?: string | null;
  taxNumber?: string | null;
  employeeCode?: string;
  hiredOn?: string;
}) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: p.name, primaryEmail: `cp39_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: p.hiredOn ?? '2024-03-01',
  });
  await setCompensation(a, {
    employmentId: E.employmentId,
    basicSalary: p.salary,
    effectiveFrom: p.hiredOn ?? '2024-03-01',
  });
  await setStatutoryProfileMY(a, {
    personId: E.personId,
    icNumber: p.ic === undefined ? '860208105128' : p.ic,
    taxNumber: p.taxNumber === undefined ? 'SG23607354000' : (p.taxNumber ?? ''),
    taxCategory: 1,
    numChildren: 0,
  });
  if (p.employeeCode) await setEmployeeCode(a, { employmentId: E.employmentId, employeeCode: p.employeeCode });
  return E;
}

async function run(period: string) {
  const a = adminCtx(b);
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod: period });
  await generatePayslips(a, { batchId: batch.batchId });
  return reportPreview(a, { companyId: b.companyId, reportId: 'my.cp39', periodKey: period });
}

const preview = (periodKey: string) =>
  reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.cp39', periodKey });

describe('the CP39 employer header', () => {
  it('fills every header box from the company’s own rows, with the month UNSHIFTED', async () => {
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    const r = await run('2026-07');

    const h = r.meta.formHeader!;
    // The read must set EVERY key the renderer looks for. A box the read forgot prints empty on a
    // statutory document and looks exactly like a company that never filled the field in.
    for (const k of CP39_FORM_HEADER_KEYS) expect(h[k], k).toBeDefined();
    expect(h.employerNo).toBe('E 908915-10');
    expect(h.registrationNo).toBe('199801012345');
    expect(h.employerName).toBe('Acme Sdn Bhd');
    expect(h.employerAddress).toContain('Level 12, Menara Satu');
    expect(h.employerAddress).toContain('50450 Kuala Lumpur, Wilayah Persekutuan');
    // ⚠️ THE RULE THE NEIGHBOURING FORM INVERTS. EPF's Borang A files the payroll month PLUS ONE; a CP39
    // reports the PCB actually deducted, so its month is the payroll month itself. A CP39 stamped one
    // month forward looks completely normal and is filed against the wrong period.
    expect(h.deductionPeriodKey).toBe('2026-07');
    expect(h.deductionMonth).toBe('JULAI');
    expect(h.deductionMonthNo).toBe('07');
    expect(h.deductionYear).toBe('2026');
    // Tarikh is the GENERATION date, so it moves with the day rather than with the period.
    expect(h.printedOn).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('does NOT roll the year for a December payroll — the case where the EPF rule would show', async () => {
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    const r = await run('2026-12');
    expect(r.meta.formHeader!.deductionPeriodKey).toBe('2026-12');
    expect(r.meta.formHeader!.deductionMonth).toBe('DISEMBER');
    expect(r.meta.formHeader!.deductionYear).toBe('2026');
  });

  /**
   * A COMPANY WITH NO `company_statutory_my` ROW MUST BE A NAMED GAP, NOT A SILENT ONE. Every value
   * coalesces to '' on this path, which is indistinguishable — in the header alone — from a company that
   * has the row and left the boxes empty. What makes it safe is that `missingCp39FormHeader` reads the
   * SAME '' and blocks the download while the screen names the field, so nobody downloads a CP39 with no
   * No. Majikan on it.
   */
  it('leaves the header blank rather than inventing one, and the gate then blocks on it', async () => {
    await owner.db.delete(schema.companyStatutoryMy).where(eq(schema.companyStatutoryMy.companyId, b.companyId));
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    const r = await run('2026-07');

    const h = r.meta.formHeader!;
    expect(h.employerNo).toBe('');
    expect(h.registrationNo).toBe('');
    // The company's own name and the period survive — only the statutory row is missing.
    expect(h.employerName).toBe('Acme Sdn Bhd');
    expect(h.deductionMonth).toBe('JULAI');
    expect(missingCp39FormHeader(h)).toEqual(['employerNo']);
  });

  it('prints no address lines rather than an empty one when the company has no address', async () => {
    await owner.db
      .update(schema.company)
      .set({ addressLine1: null, city: null, state: null, postcode: null })
      .where(eq(schema.company.id, b.companyId));
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    const r = await run('2026-07');
    expect(r.meta.formHeader!.employerAddress).toBe('');
    // …and an absent address does NOT block: it is a box on the form, not a thing the statement is
    // invalid without.
    expect(missingCp39FormHeader(r.meta.formHeader)).toEqual([]);
  });
});

describe('the preparer block', () => {
  it('fills from the company’s LHDN authority row, and takes the IC off the signatory’s own record', async () => {
    const E = await hire({ name: 'CHONG PEI YUH', salary: 4000, ic: '910416145530' });
    await upsertCompanyStatutoryAuthority(adminCtx(b), {
      companyId: b.companyId,
      authority: 'lhdn',
      phone: '0123081733',
      signatoryPersonId: E.personId,
    });
    const r = await run('2026-07');

    const h = r.meta.formHeader!;
    expect(h.preparerName).toBe('CHONG PEI YUH');
    expect(h.preparerIc).toBe('910416145530');
    expect(h.preparerPosition).toBe('Executive');
    expect(h.preparerPhone).toBe('0123081733');
    // ADVISORY, NEVER BLOCKING — see `missingCp39Preparer`. Readiness is about the employees and the
    // employer number.
    expect(r.readiness).toEqual([]);
  });

  /**
   * ⚠️ THE `.limit(1)` OVER FOUR LEFT JOINS, WHICH IS THE PART THAT GOES WRONG SILENTLY. A signatory who
   * has been promoted has TWO assignment rows; only one of them is open. If the join ever stopped
   * filtering on `valid_to IS NULL`, this test is what notices — the alternative is a CP39 that prints
   * somebody's job title from three years ago and looks completely normal doing it.
   */
  it('prints the signatory’s CURRENT job title after a promotion, never the superseded one', async () => {
    const a = adminCtx(b);
    const E = await hire({ name: 'CHONG PEI YUH', salary: 4000, ic: '910416145530' });
    const [senior] = await owner.db
      .insert(schema.position)
      .values({ tenantId: b.tenantId, companyId: b.companyId, title: 'Finance Manager' })
      .returning({ id: schema.position.id });
    await setEmploymentAssignment(a, {
      employmentId: E.employmentId,
      effectiveDate: '2026-04-01',
      positionId: senior.id,
    });
    await upsertCompanyStatutoryAuthority(a, {
      companyId: b.companyId,
      authority: 'lhdn',
      signatoryPersonId: E.personId,
    });

    // Two assignments on file, exactly one of them open — the state the join has to disambiguate.
    const rows = await owner.db
      .select({ validTo: schema.assignment.validTo })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, E.employmentId));
    expect(rows.length).toBe(2);
    expect(rows.filter((x) => x.validTo === null).length).toBe(1);

    const r = await run('2026-07');
    expect(r.meta.formHeader!.preparerPosition).toBe('Finance Manager');
  });

  it('leaves the block blank when there is no authority row, and still produces the statement', async () => {
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    const r = await run('2026-07');
    const h = r.meta.formHeader!;
    expect([h.preparerName, h.preparerIc, h.preparerPosition, h.preparerPhone]).toEqual(['', '', '', '']);
    expect(r.readiness).toEqual([]);
    expect(missingCp39FormHeader(h)).toEqual([]);
  });
});

describe('the per-employee extras', () => {
  /**
   * THE MAP IS KEYED ON `employmentId` AND THE JOIN GOES THROUGH `person`. Two employees is the smallest
   * fixture that can catch a swap — with one row, a completely wrong key still produces the right answer.
   */
  it('hands each person their own employee number and passport, never the other’s', async () => {
    const one = await hire({ name: 'AAA FIRST', salary: 3000, ic: '900101015555', employeeCode: 'EMP-001' });
    const two = await hire({ name: 'ZZZ SECOND', salary: 3200, ic: null, employeeCode: 'EMP-002' });
    // No core writer sets an employee's passport on the statutory row except this one; the CP39 read is
    // the only consumer that prints it.
    await owner.db
      .update(schema.person)
      .set({ nationality: 'Indonesian' })
      .where(eq(schema.person.id, two.personId));
    await setPassportProfileMY(adminCtx(b), {
      personId: two.personId,
      passportNumber: 'B1234567',
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2034-01-01',
    });

    const r = await run('2026-07');
    // `loadBatchRows` orders by name, so AAA is first and ZZZ second.
    expect(r.rows.map((x) => x.name)).toEqual(['AAA FIRST', 'ZZZ SECOND']);
    const byName = new Map(r.rows.map((x) => [String(x.name), x]));
    expect(byName.get('AAA FIRST')!.employeeNo).toBe('EMP-001');
    expect(byName.get('AAA FIRST')!.passport).toBe('');
    expect(byName.get('ZZZ SECOND')!.employeeNo).toBe('EMP-002');
    expect(byName.get('ZZZ SECOND')!.passport).toBe('B1234567');
    expect(byName.get('AAA FIRST')!.employmentId).toBe(one.employmentId);
    expect(byName.get('ZZZ SECOND')!.employmentId).toBe(two.employmentId);
  });

  /**
   * THE TWO COLUMNS THE SCHEMA CANNOT FILL, asserted where the decision actually lives. `cp39FormFrom`
   * reads them off the row rather than hardcoding them, precisely so a later read that started guessing a
   * country code would be visible HERE rather than nowhere.
   */
  it('emits No. K/P Lama and Kod Negara as explicit blanks, from the read itself', async () => {
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    const r = await run('2026-07');
    expect(r.rows[0].oldIc).toBe('');
    expect(r.rows[0].countryCode).toBe('');
  });

  it('does not add a column to the figures table, so the existing screen and exports are untouched', async () => {
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    const r = await run('2026-07');
    // The CSV/XLSX export and the [formId] table both map `result.columns`, never `Object.keys(row)`.
    expect(r.columns.map((c) => c.key)).toEqual(['name', 'taxNo', 'ic', 'pcb']);
  });
});

describe('CP38, which is not PCB', () => {
  it('carries the instalment as its own figure and its own total', async () => {
    const a = adminCtx(b);
    const withInstalment = await hire({ name: 'AAA INSTALMENT', salary: 9000, ic: '900101015555' });
    await hire({ name: 'ZZZ NONE', salary: 9000, ic: '880808085555' });
    await setCp38(a, {
      employmentId: withInstalment.employmentId,
      cp38Ref: 'CP38/1',
      amount: 320.5,
      validFrom: '2026-01-01',
    });

    const r = await run('2026-07');
    const byName = new Map(r.rows.map((x) => [String(x.name), x]));
    expect(byName.get('AAA INSTALMENT')!.cp38).toBe(320.5);
    expect(byName.get('ZZZ NONE')!.cp38).toBe(0);
    expect(r.totals.cp38).toBe(320.5);
    // PCB is a DIFFERENT deduction and it is still there and still summed separately — the form asks for
    // two totals and two employee counts because they are not the same thing.
    expect(r.totals.pcb).toBeGreaterThan(0);
    expect(byName.get('AAA INSTALMENT')!.pcb).not.toBe(320.5);
  });

  /**
   * ⚠️ ONE MONTH, TWO RUNS, ONE INSTALMENT. `loadBatchRows` aggregates across every run of the period
   * (a regular run plus a bonus run), and the CP39 is ONE filing for the month. The payroll kernel stamps
   * CP38 on the regular run only, so summing single-counts it — which is the same rule the e-Data PCB
   * upload file applies. If either half changed, the printed statement would ask for double the money the
   * court instructed and the page would look completely normal.
   */
  it('counts one instalment for a month that was run twice, not two', async () => {
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);
    const E = await hireEmployee(a, {
      person: { fullName: 'CP39 MULTI', primaryEmail: `cp39_multi_${randomUUID().slice(0, 6)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      employmentType: 'full_time',
      hiredOn: '2024-03-01',
    });
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 9000, effectiveFrom: '2024-03-01' });
    await setStatutoryProfileMY(a, {
      personId: E.personId,
      icNumber: '900101014444',
      taxNumber: 'SG23607354000',
      taxCategory: 1,
      numChildren: 0,
    });
    await setCp38(a, { employmentId: E.employmentId, cp38Ref: 'CP38/M', amount: 200, validFrom: '2026-05-01' });

    const reg = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    const bonus = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: '2026-05', runType: 'bonus' });
    await generatePayslips(a, { batchId: bonus.batchId });

    // Two payslips for the period, one employee, one CP39 line.
    const slips = await owner.db
      .select({ id: schema.payslip.id })
      .from(schema.payslip)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(and(eq(schema.payslip.employmentId, E.employmentId), eq(schema.payrollBatch.payPeriod, '2026-05')));
    expect(slips.length).toBe(2);

    const r = await reportPreview(a, { companyId: b.companyId, reportId: 'my.cp39', periodKey: '2026-05' });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].cp38).toBe(200);
    expect(r.totals.cp38).toBe(200);
  });
});

describe('readiness', () => {
  /**
   * NAMED, NEVER DROPPED. The e-Data PCB file refuses without a tax reference number, so the printed
   * statement inherits exactly that gate — and the review screen has to be able to NAME whoever is
   * missing one, which it cannot do if the read has already removed them. A read that filtered would
   * produce a CP39 that reconciles perfectly to a payroll it does not match.
   */
  it('names whoever has no income tax reference number, without dropping them from the statement', async () => {
    await hire({ name: 'AAA HAS TIN', salary: 4000, ic: '900101015555' });
    await hire({ name: 'ZZZ NO TIN', salary: 4000, ic: '880808085555', taxNumber: null });
    const r = await run('2026-07');

    expect(r.readiness.map((x) => x.name)).toEqual(['ZZZ NO TIN']);
    expect(r.readiness[0].missing).toEqual(['Tax no']);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x.name)).toContain('ZZZ NO TIN');
  });
});

/**
 * ⚠️ THE REGRESSION GUARD. `cp39()` calls `cp39FormExtras`, whose first statement VALIDATES the period and
 * THROWS on anything that is not YYYY-MM. That call must stay BELOW the `hasBatch` check, because two
 * shipped screens hand `reportPreview` an unvalidated period with no try/catch anywhere on the path:
 *
 *   • `/payroll/reports` — the period box is FREE TEXT and its placeholder flips between '2026' and
 *     '2026-07' with the report dropdown, so viewing an annual report and then switching to CP39 submits
 *     '2026' verbatim (app/payroll/reports/page.tsx: `const periodKey = sp.periodKey || ''`).
 *   • `/payroll/statutory-forms/my.cp39` — its own fallback accepts `?periodKey=2026-13`, month and all
 *     (app/payroll/statutory-forms/[formId]/page.tsx, /^\d{4}-\d{2}$/).
 *
 * `my.cp39` has been TOTAL since slice 0: both screens rendered the "No payroll run" card. A throw on this
 * path 500s the whole page instead, and neither the pure test file nor `loadCp39Form`'s own tests can see
 * it — `loadCp39Form` regex-validates the period before it ever calls `reportPreview`.
 */
describe('a period the screens cannot validate degrades, it does not throw', () => {
  it('answers no-batch for a YEAR typed into the period box, the way it always did', async () => {
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    await run('2026-07');
    const r = await preview('2026');
    expect(r.meta.hasBatch).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.columns.map((c) => c.key)).toEqual(['name', 'taxNo', 'ic', 'pcb']);
  });

  it('answers no-batch for an impossible month in the URL, rather than 500ing the screen', async () => {
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    for (const junk of ['2026-13', '2026-00', '2026-99', '', 'nonsense']) {
      const r = await preview(junk);
      expect(r.meta.hasBatch, junk).toBe(false);
      expect(r.rows, junk).toEqual([]);
    }
  });

  it('answers no-batch for a month that was simply never run', async () => {
    await hire({ name: 'ANG PEI YEE', salary: 4000 });
    const r = await preview('2099-12');
    expect(r.meta.hasBatch).toBe(false);
    expect(r.rows).toEqual([]);
  });
});

/**
 * END TO END: what the read produces is what the printed page is built from. `cp39FormFrom` is pure and
 * already unit-tested — what is NOT tested anywhere else is that the read's row keys are the ones it
 * reads. A rename on either side leaves both halves green and prints a page of empty columns.
 */
describe('the read feeds the printed statement', () => {
  it('builds a form whose header, rows and totals all come through unchanged', async () => {
    const a = adminCtx(b);
    const E = await hire({ name: 'ANG PEI YEE', salary: 9000, ic: '860208105128', employeeCode: 'EMP-777' });
    await setCp38(a, { employmentId: E.employmentId, cp38Ref: 'CP38/E2E', amount: 150, validFrom: '2026-01-01' });
    await upsertCompanyStatutoryAuthority(a, {
      companyId: b.companyId,
      authority: 'lhdn',
      phone: '0123081733',
      signatoryPersonId: E.personId,
    });
    const r = await run('2026-07');

    const form = cp39FormFrom({ header: r.meta.formHeader, rows: r.rows });
    expect(form.employerNo).toBe('E 908915-10');
    expect(form.employerName).toBe('Acme Sdn Bhd');
    // The '\n'-joined scalar the read had to flatten comes back as printable lines.
    expect(form.employerAddress).toEqual([
      'Level 12, Menara Satu',
      '50450 Kuala Lumpur, Wilayah Persekutuan',
    ]);
    expect(form.deductionMonth).toBe('JULAI');
    expect(form.preparerName).toBe('ANG PEI YEE');
    expect(form.preparerPhone).toBe('0123081733');

    expect(form.employees).toBe(1);
    const [line] = form.pages[0].rows;
    expect(line.name).toBe('ANG PEI YEE');
    expect(line.tin).toBe('SG23607354000');
    expect(line.newIc).toBe('860208105128');
    expect(line.employeeNo).toBe('EMP-777');
    expect(line.cp38).toBe(150);
    // The arithmetic agrees with the read it was built from, in both directions.
    expect(form.totalPcb).toBe(r.totals.pcb);
    expect(form.totalCp38).toBe(150);
    expect(form.totalAmount).toBe(Math.round((r.totals.pcb + 150) * 100) / 100);
    expect(form.cp38Employees).toBe(1);
    expect(missingCp39FormHeader(r.meta.formHeader)).toEqual([]);
  });
});
