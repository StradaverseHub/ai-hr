/**
 * 6036dab7 — THE EA (C.P.8A) AGAINST THE CUSTOMER'S FIELD MAPPING.
 *
 * The statement already existed in both languages off ONE renderer (587ee719). What it did not have was
 * most of the boxes on the customer's mapping: Part C (Pencen dan Lain-lain) was absent from the form
 * entirely, CP38 printed the words "not tracked" long after payroll started stamping the figure, Part A
 * had no job title / employee number / passport, and ten Part B boxes had nowhere to hold a number.
 *
 * This file pins the READ — the one place all of that has to be true, since the HTML page and the PDF
 * both render whatever `eaStatement` returns:
 *   1. Part A's three added particulars come from the tables the read already joined (no new column).
 *   2. `partD.cp38` is the year's summed `payslip.statutory.cp38` — asserted AGAINST the payslip rows,
 *      because "the EA agrees with what the CP39 filed" is the claim, not "the EA prints some number".
 *   3. Part C exists, is zero by default, and its total equals its own two lines.
 *   4. A manual Part B box reaches `partB.gross`, so the printed lines sum to the printed total.
 *   5. EVERY field in the EA vocabulary can be amended and read back — the completeness ratchet that
 *      fails the day a box is added to EA_FIELDS and not wired into the statement.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee, terminateEmployment } from '../core/org';
import { setCompensation } from '../core/comp';
import { setPassportProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { setCp38 } from '../core/cp38';
import { createBatch, generatePayslips } from '../core/payroll';
import { employeeEaStatement } from '../core/reporting';
import { updateCompany } from '../core/admin';
import { upsertCompanyStatutoryAuthority } from '../core/statutory-authority';
import { setEaOverride } from '../core/ea-override';
import { EA_FIELDS, EA_PART_B_COMPONENTS } from '../localization/my/reports';

/** One employee with a payroll year, a job title, an employee number and a passport. */
async function seedEmployee(base: Base, opts: { cp38?: number } = {}) {
  const a = adminCtx(base);
  const E = await hireEmployee(a, {
    person: { fullName: 'Aisyah Rahman', primaryEmail: 'aisyah@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    positionId: base.positionId, // seedBase titles this 'Executive'
    employeeCode: 'EA-0007',
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101015555', taxCategory: 1, numChildren: 0 });
  await setPassportProfileMY(a, {
    personId: E.personId,
    passportNumber: 'A12345678',
    passportIssueDate: '2024-01-01',
    passportExpiryDate: '2034-01-01',
  });
  if (opts.cp38) {
    await setCp38(a, {
      employmentId: E.employmentId,
      cp38Ref: 'CP38/2026/00123',
      amount: opts.cp38,
      validFrom: '2026-01-01',
    });
  }
  for (const period of ['2026-01', '2026-02']) {
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId: batch.batchId });
  }
  return E;
}

describe('6036dab7 — EA statement against the customer field mapping', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('Part A carries job title, employee number and passport — from tables the read already joined', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base);
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(ea).not.toBeNull();
    expect(ea!.employee.jobTitle).toBe('Executive');
    expect(ea!.employee.employeeNo).toBe('EA-0007');
    // The SAME column cp39FormExtras reads for the printed CP39 — one passport, one answer.
    expect(ea!.employee.passport).toBe('A12345678');
  });

  it('CP38 is the year’s summed payslip figure, and equals what the CP39 return files', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base, { cp38: 200 });
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });

    // Read the stamped scalar straight off the payslips — the same `statutory.cp38` cp39() totals. The EA
    // must agree with it, which is a stronger claim than "the EA prints a non-zero number".
    const slips = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, E.employmentId));
    const filed = slips.reduce((sum, s) => sum + Number((s.statutory as { cp38?: number } | null)?.cp38 ?? 0), 0);

    expect(filed).toBeCloseTo(400, 2); // two regular runs × RM 200
    expect(ea!.partD.cp38).toBeCloseTo(filed, 2);
    // …and it is a separate figure from the MTD, not folded into it.
    expect(ea!.partD.mtd).not.toBeCloseTo(ea!.partD.cp38, 2);
  });

  it('an employee with no CP38 instruction reports 0.00, not a missing field', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base);
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(ea!.partD.cp38).toBe(0);
  });

  it('Part C exists, is zero by default, and its total equals its own two lines', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base);

    const before = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(before!.partC).toEqual({ pension: 0, annuity: 0, total: 0 });

    await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'pension', amount: 12000, reason: 'ex-employer pension' });
    await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'annuity', amount: 3000, reason: 'annuity' });

    const after = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(after!.partC.pension).toBeCloseTo(12000, 2);
    expect(after!.partC.annuity).toBeCloseTo(3000, 2);
    expect(after!.partC.total).toBeCloseTo(15000, 2);
    // Part C is NOT employment income: it must not leak into Part B's total.
    expect(after!.partB.gross).toBeCloseTo(before!.partB.gross, 2);
  });

  it('a manual Part B box reaches the printed total, so the lines still sum to it', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base);

    const before = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(before!.partB.gratuity).toBe(0);
    expect(before!.partB.benefitsInKind).toBe(0);

    await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'gratuity', amount: 7000, reason: 'ex-gratia on cessation' });
    await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'benefitsInKind', amount: 3600, reason: 'company car' });

    const after = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(after!.partB.gratuity).toBeCloseTo(7000, 2);
    expect(after!.partB.benefitsInKind).toBeCloseTo(3600, 2);
    expect(after!.partB.gross).toBeCloseTo(before!.partB.gross + 10600, 2);
    // The printed total IS the sum of the printed component lines — the §0 invariant, now over all of them.
    const componentSum = EA_PART_B_COMPONENTS.reduce(
      (sum, f) => sum + (after!.partB as unknown as Record<string, number>)[f],
      0,
    );
    expect(after!.partB.gross).toBeCloseTo(componentSum, 2);
  });

  /**
   * r209 fix — THE JAWATAN MUST SURVIVE TERMINATION, AND THE CASE ABOVE CANNOT SEE THAT.
   *
   * 6036dab7 read the job title off the OPEN assignment (`valid_to IS NULL`), and `terminateEmploymentTx`
   * closes the open assignment at the termination date. So Part A printed '—' for the job title on every
   * LEAVER's form — the population an EA is chiefly issued to — while the employee number and passport
   * beside it printed fine. The active-employee case above passes throughout, which is exactly why the
   * hole survived the round: this test asserts the SAME three particulars AFTER a termination.
   */
  it('Part A keeps the job title after termination — the assignment closes, the Jawatan does not', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base);
    const before = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(before!.employee.jobTitle).toBe('Executive');

    await terminateEmployment(a, { employmentId: E.employmentId, terminationDate: '2026-02-28' });

    // The state the old predicate could not see: the assignment is CLOSED, on the termination date.
    const [asg] = await owner.db
      .select({ validTo: schema.assignment.validTo })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, E.employmentId));
    expect(asg.validTo).toBe('2026-02-28');

    const after = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(after!.employee.terminatedOn).toBe('2026-02-28');
    expect(after!.employee.jobTitle).toBe('Executive');
    // The two particulars that never broke, asserted alongside so a regression is attributable.
    expect(after!.employee.employeeNo).toBe('EA-0007');
    expect(after!.employee.passport).toBe('A12345678');
  });

  /**
   * r219 — THE FOOT OF THE PRINTED C.P.8A, AND WHERE EACH BOX COMES FROM.
   *
   * The form's ruled officer box asks for Name Pegawai / Jawatan / Nama dan Alamat Majikan / No. Telefon
   * Majikan, and its header asks for LHDNM Negeri. None of that was on the read before this round, so
   * this case is the one place the SOURCE of each is asserted rather than assumed — and it is the same
   * source the printed CP39 uses for its preparer block, deliberately: two LHDN documents naming
   * different officers for one company is the failure that costs a filing.
   */
  it('the employer block carries the address, phone, LHDN branch state and the LHDN signatory', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base);

    await updateCompany(a, {
      id: base.companyId,
      legalName: 'Acme Sdn Bhd',
      addressLine1: 'No. 12, Jalan Raja Chulan',
      addressLine2: 'Bukit Ceylon',
      city: 'Kuala Lumpur',
      state: 'Wilayah Persekutuan',
      postcode: '50200',
      phone: '03-2000 1234',
    });
    // The signatory is the person behind THIS employment, whose assignment titles them 'Executive'.
    await upsertCompanyStatutoryAuthority(a, {
      companyId: base.companyId,
      authority: 'lhdn',
      state: 'W.P. Kuala Lumpur',
      signatoryPersonId: E.personId,
    });

    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(ea!.employer.phone).toBe('03-2000 1234');
    // Three free lines collapse to two here (line 3 is empty) plus the postcode/town, state tail.
    expect(ea!.employer.address).toEqual([
      'No. 12, Jalan Raja Chulan',
      'Bukit Ceylon',
      '50200 Kuala Lumpur, Wilayah Persekutuan',
    ]);
    // LHDNM Negeri is the LHDN row's state, NOT the company's postal state — they are different columns
    // on different tables and a company may file with a branch outside its own postal state.
    expect(ea!.employer.lhdnState).toBe('W.P. Kuala Lumpur');
    expect(ea!.employer.officerName).toBe('Aisyah Rahman');
    expect(ea!.employer.officerPosition).toBe('Executive');
  });

  it('a company with no LHDN authority row and no address leaves every one of those boxes empty', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base);
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    // NULL, not '' and not a placeholder: the renderer prints the blank form's rule for each (AGENTS 28).
    expect(ea!.employer.address).toEqual([]);
    expect(ea!.employer.phone).toBeNull();
    expect(ea!.employer.lhdnState).toBeNull();
    expect(ea!.employer.officerName).toBeNull();
    expect(ea!.employer.officerPosition).toBeNull();
    // …while the two boxes that were always there keep working.
    expect(ea!.employer.name).toBe('Acme Sdn Bhd');
  });

  it('every field in the EA vocabulary can be amended and read back off the statement', async () => {
    const a = adminCtx(base);
    const E = await seedEmployee(base);
    // 111.11 is chosen to differ from every payroll-derived baseline in this fixture, so no write lands on
    // setEaOverride's "amended == derived ⇒ clear" path and silently drops out of the result.
    for (const field of EA_FIELDS) {
      await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field, amount: 111.11, reason: `amend ${field}` });
    }
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(ea!.overrides.map((o) => o.field).sort()).toEqual([...EA_FIELDS].sort());
    // Every `original` is the payroll-derived baseline, never undefined/NaN — the audit trail's `before`.
    for (const o of ea!.overrides) {
      expect(Number.isFinite(o.original), `${o.field} has a non-finite derived baseline`).toBe(true);
      expect(o.amended).toBeCloseTo(111.11, 2);
    }
  });
});
