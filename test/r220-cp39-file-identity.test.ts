/**
 * 00806b4c — THE e-DATA PCB UPLOAD FILE'S IDENTITY BOXES, END TO END FROM THE EMPLOYEE RECORD.
 *
 * WHAT WAS WRONG, AND WHY NOTHING SAID SO. `buildCp39File` has accepted `oldIc`, `passport` and
 * `countryCode` since it was written and places them at Exhibit 4's columns 73–84, 97–108 and 109–110.
 * `cp39FileForBatch` — the layer that reads the payroll month out of the database and hands it those rows
 * — selected only `tax_number`, `ic_number` and `employee_code`. So every line LHDN ever received carried
 * the new identity card and three empty boxes, and a foreign employee holding ONLY a passport was filed
 * with NO identity number at all. The file was still 136 characters a line, its header totals still
 * reconciled, and the portal's complaint (if it ever came) would be about a taxpayer it could not match,
 * long after the payment.
 *
 * ⚠️ THE DEFECT LIVED IN THE CONTRACT BETWEEN THE QUERY AND THE PURE BUILDER, where a unit test of either
 * half passes throughout (AGENTS rule 17) — which is exactly why this file exists at the DB level rather
 * than as more cases in test/cp39-form.test.ts. Those pin the layout from a hand-built row set; these pin
 * that the row set is built from what HR actually typed.
 *
 * ⚠️ AND THE REFUSAL MUST NEVER FIRE ON AN ORDINARY MONTH. Refusing to produce a statutory file is a
 * bigger failure than a blank box: nobody can file at all. The gate is "an identity number of SOME kind"
 * — new card, passport, or the pre-1990 old card — never "a MyKad", because a foreign employee legitimately
 * has no MyKad and their line is complete without one. The first case below is the plain Malaysian month
 * that must keep working, and it is first on purpose.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setIcProfileMY, setPassportProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { cp39FileForBatch, Cp39NotReadyError } from '../localization/my/cp39-file';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let base: Base;
let a: SessionContext;
const PERIOD = '2026-01';

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
  await setCompanyStatutoryMY(a, { companyId: base.companyId, lhdnEmployerNo: 'E 908915-10' });
});

let seq = 0;
/** An employee on the January run, with a tax reference number (mandatory on every CP39 line). */
async function hire(fullName: string, tin: string) {
  seq += 1;
  const e = await hireEmployee(a, {
    person: { fullName, primaryEmail: `cp39file_${seq}_${Date.now()}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 5500,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  // icNumber is REQUIRED as a key and NULLABLE as a value — the setter is a full-row overwrite, so a
  // caller that omitted it would silently wipe a stored card. Each case sets the identity it means.
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: null, taxNumber: tin });
  return e;
}

/** Run January and build the file for it. */
async function fileForJanuary() {
  const b = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
  await generatePayslips(a, { batchId: b.batchId });
  return cp39FileForBatch(a, { companyId: base.companyId, periodKey: PERIOD });
}

/** Exhibit-4 detail-record slices, 0-based [start, end) — the whole format is positional. */
const AT = {
  name: [12, 72],
  oldIc: [72, 84],
  newIc: [84, 96],
  passport: [96, 108],
  country: [108, 110],
} as const;
const box = (line: string, k: keyof typeof AT) => line.slice(AT[k][0], AT[k][1]);
/** The detail line for an employee, found by the name box rather than by position in the file. */
const lineFor = (content: string, name: string) =>
  content
    .split('\r\n')
    .filter((l) => l.startsWith('D'))
    .find((l) => box(l, 'name').trim() === name.toUpperCase())!;

describe('00806b4c — an ordinary Malaysian month is untouched', () => {
  it('files an identity-card-only employee exactly as before, and refuses nothing', async () => {
    const e = await hire('Plain Malaysian', 'IG 531367080');
    await setIcProfileMY(a, { personId: e.personId, icNumber: '900101018888' });

    const f = await fileForJanuary();
    const line = lineFor(f.content, 'Plain Malaysian');
    expect(line).toHaveLength(136);
    expect(box(line, 'newIc')).toBe('900101018888');
    // The other three boxes are blank because the record holds nothing for them — that is the ordinary
    // case, and it must stay a blank rather than becoming a refusal.
    expect(box(line, 'oldIc')).toBe(' '.repeat(12));
    expect(box(line, 'passport')).toBe(' '.repeat(12));
    expect(box(line, 'country')).toBe('  ');
    expect(f.content.split('\r\n')[0]).toHaveLength(57);
  });
});

describe('00806b4c — the three boxes that used to be empty on every line', () => {
  it('carries the old card, the passport and the country code from the employee record', async () => {
    const withOld = await hire('Old Card Holder', 'IG 100000001');
    await setIcProfileMY(a, { personId: withOld.personId, icNumber: '600101015678', oldIcNumber: 'A 1234567' });

    const foreign = await hire('Passport Holder', 'IG 100000002');
    await setPassportProfileMY(a, {
      personId: foreign.personId,
      passportNumber: 'A1234567',
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2030-01-01',
      // The demonym the picker writes, and the ISO-2 the CP39 wants, stored apart. Neither is derived
      // from the other, and the file must file the CODE.
      passportIssuingCountry: 'Indonesian',
      passportIssuingCountryCode: 'ID',
    });

    const f = await fileForJanuary();

    const oldLine = lineFor(f.content, 'Old Card Holder');
    expect(box(oldLine, 'oldIc')).toBe('A 1234567   ');
    // The old card must not DISPLACE the new one — both boxes exist and both are filled.
    expect(box(oldLine, 'newIc')).toBe('600101015678');

    const fgnLine = lineFor(f.content, 'Passport Holder');
    expect(box(fgnLine, 'passport')).toBe('A1234567    ');
    expect(box(fgnLine, 'country')).toBe('ID');
    // THE REGRESSION THIS CASE EXISTS FOR: before 00806b4c this employee's whole identity block —
    // columns 73 to 110 — went to LHDN as spaces.
    expect(fgnLine.slice(72, 110).trim()).not.toBe('');
    expect(box(fgnLine, 'newIc')).toBe(' '.repeat(12)); // they have no MyKad, and that is correct

    for (const l of f.content.split('\r\n').filter((x) => x.startsWith('D'))) expect(l).toHaveLength(136);
  });

  it('files the country CODE, never the nationality text stored beside it', async () => {
    const e = await hire('Code Not Demonym', 'IG 100000003');
    await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'B7654321',
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2030-01-01',
      passportIssuingCountry: 'Singaporean',
      passportIssuingCountryCode: 'SG',
    });
    const f = await fileForJanuary();
    expect(box(lineFor(f.content, 'Code Not Demonym'), 'country')).toBe('SG');
    // A two-character box cannot hold "Singaporean" at all; what it COULD hold is the first two letters
    // of it, silently, on a tax filing. That is the failure the separate column exists to prevent.
    expect(f.content).not.toContain('SINGAPOREAN');
    expect(box(lineFor(f.content, 'Code Not Demonym'), 'country')).not.toBe('SI');
  });
});

describe('00806b4c — no identity number of any kind is a refusal, and it names the people', () => {
  it('refuses rather than filing a line with an empty identity block', async () => {
    await hire('Has A Card', 'IG 100000004').then((e) =>
      setIcProfileMY(a, { personId: e.personId, icNumber: '900101017777' }),
    );
    await hire('No Identity At All', 'IG 100000005');

    const b = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: b.batchId });

    const err: unknown = await cp39FileForBatch(a, { companyId: base.companyId, periodKey: PERIOD }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Cp39NotReadyError);
    const message = (err as Error).message;
    // NAMED — the operator has to know WHO to go and fix, exactly as the TIN and employee-number gates do.
    expect(message).toContain('No Identity At All');
    // …and only them: naming a colleague whose record is complete sends HR to the wrong screen.
    expect(message).not.toContain('Has A Card');
    // The sentence has to say what to enter, not merely that something is missing.
    expect(message).toMatch(/passport/i);
  });

  it('lifts as soon as the passport is entered — the refusal is a prompt, not a dead end', async () => {
    const e = await hire('Fixed By Passport', 'IG 100000006');
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: b.batchId });
    await expect(cp39FileForBatch(a, { companyId: base.companyId, periodKey: PERIOD })).rejects.toThrow(
      Cp39NotReadyError,
    );

    await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'C1112223',
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2030-01-01',
    });
    const f = await cp39FileForBatch(a, { companyId: base.companyId, periodKey: PERIOD });
    expect(box(lineFor(f.content, 'Fixed By Passport'), 'passport')).toBe('C1112223    ');
  });

  /**
   * ⚠️ THE DELIBERATE NARROWING, AND THE ONE A LATER TIDY-UP WILL WANT TO WIDEN.
   *
   * An employee whose ONLY document on file is a pre-1990 card produces a line that DOES carry an
   * identity number — in the old-card box, which is the box Exhibit 4 provides for exactly that. Refusing
   * them would block the month's filing for a record that is complete and correct, and HR would have
   * nothing to enter to clear it. The refusal is for a line with an EMPTY identity block, and this is not
   * one.
   */
  it('does not refuse an employee identified only by an old identity card', async () => {
    const e = await hire('Old Card Only', 'IG 100000007');
    await setIcProfileMY(a, { personId: e.personId, icNumber: '', oldIcNumber: '7654321' });
    const f = await fileForJanuary();
    const line = lineFor(f.content, 'Old Card Only');
    expect(box(line, 'oldIc')).toBe('7654321     ');
    expect(box(line, 'newIc')).toBe(' '.repeat(12));
  });
});

/**
 * 00806b4c (gap close) — THE OPPOSITE FAILURE THE SAME CHANGE MADE REACHABLE.
 *
 * The refusal above is for an EMPTY identity block. This one is for an identity number that does not FIT
 * the box Exhibit 4 gives it: old K/P 12, passport 12, Kod Negara 2, all three filled from unbounded
 * `text` columns, two of them free-text inputs with no maxLength. `alpha()` hard-truncates to width, so
 * before this gate a 14-character passport went to LHDN as its first twelve characters — a well-formed
 * 136-character line carrying an identifier that belongs to somebody else or to nobody, indistinguishable
 * from a correct one. Refuse and name the record, exactly as feedback de2823cc decided for the employee
 * number: a silently truncated identifier in a statutory file is worse than a refusal.
 */
describe('00806b4c — an identity number that does not fit its box is refused, never filed cut short', () => {
  it('refuses when a stored passport is longer than the CP39 field, naming the person and the value', async () => {
    const ok = await hire('Fits The Box', 'IG 100000008');
    await setIcProfileMY(a, { personId: ok.personId, icNumber: '900101016666' });

    const long = await hire('Passport Too Long', 'IG 100000009');
    await setPassportProfileMY(a, {
      personId: long.personId,
      passportNumber: 'A1234567890123', // 14 characters; the box holds 12
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2030-01-01',
    });

    const b = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: b.batchId });
    const err: unknown = await cp39FileForBatch(a, { companyId: base.companyId, periodKey: PERIOD }).catch(
      (e: unknown) => e,
    );

    // A READINESS refusal, not a builder crash — the download route turns this into a 422 carrying the
    // sentence below. The builder's own guard behind it would be a 500: true, but useless to the operator.
    expect(err).toBeInstanceOf(Cp39NotReadyError);
    const message = (err as Error).message;
    expect(message).toContain('Passport Too Long');
    expect(message).toContain('A1234567890123'); // the value, so HR can see WHAT does not fit
    expect(message).toMatch(/passport number/i); // and WHICH box, since three of them are fixed width
    // …and not the colleague whose record is fine: naming them sends HR to the wrong screen.
    expect(message).not.toContain('Fits The Box');
  });

  it('lifts the moment the number is corrected, and then files it whole', async () => {
    const e = await hire('Corrected Passport', 'IG 100000010');
    const passport = (n: string) =>
      setPassportProfileMY(a, {
        personId: e.personId,
        passportNumber: n,
        passportIssueDate: '2024-01-01',
        passportExpiryDate: '2030-01-01',
      });
    await passport('A1234567890123');

    const b = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: b.batchId });
    await expect(cp39FileForBatch(a, { companyId: base.companyId, periodKey: PERIOD })).rejects.toThrow(
      Cp39NotReadyError,
    );

    await passport('A12345678901'); // 12 — at the limit, and it must arrive UNCUT
    const f = await cp39FileForBatch(a, { companyId: base.companyId, periodKey: PERIOD });
    const line = lineFor(f.content, 'Corrected Passport');
    expect(box(line, 'passport')).toBe('A12345678901');
    expect(line).toHaveLength(136);
  });
});
