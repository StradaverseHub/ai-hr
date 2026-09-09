/**
 * Item 2983802f — THE PER-SECTION IMPORTER.
 *
 * §1 THE CATALOGUE, as a pure invariant: every column of the wide template is owned by exactly one
 *    section, or is explicitly listed as one no section may write, WITH a reason. A column added to
 *    the wide template in future cannot quietly fail to be considered.
 * §2 THE FENCE, enforced server-side. A Bank and Statutory file carrying a Profile column is refused
 *    whole — because the file is user-supplied and "which columns the template shipped with" protects
 *    nobody who edits the sheet.
 * §3 THE PER-ROW VERDICT, produced by the DRY RUN before anything is written.
 * §4 A BLANK CELL MEANS "LEAVE THIS AS IT IS" — the assertion this whole item turns on. A Bank and
 *    Statutory import for an existing employee must leave their ADDRESS untouched, and must leave the
 *    rest of their statutory row untouched too (the setters it calls rewrite their whole block from
 *    their arguments, so an unmerged payload would blank what the file never mentioned).
 * §5 The other three sections, cell → record.
 * §6 TWO EMPLOYEES CAN NEVER BE GIVEN ONE IDENTITY — the work email (no unique index behind it, so
 *    nothing else stands between a column-shifted sheet and two people sharing a login) and the
 *    identity number (a unique index, whose violation used to reach the admin AND the stored history
 *    as raw driver text carrying the NRIC as a bound parameter).
 * §7 AN IMPORT THAT REPORTS SUCCESS MUST BE VISIBLE ON THE SCREEN — the Employment periods written
 *    where the Employment tab reads them, a fence refusal that names only doors that exist, a preview
 *    that does not call an unchanged row an update, and a history badge that does not call a
 *    nothing-was-wrong run a failure.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { commitEmployeeImport, listEmployeeImportRuns } from '../core/import';
import { commitSectionImport, validateSectionImport, writeFailureMessage } from '../core/import-sections';
import {
  foreignColumns,
  IMPORT_SECTION_DEFS,
  IMPORT_SECTION_KEYS,
  SECTION_KEY_COLUMN,
  sectionColumns,
  UNSECTIONED_COLUMNS,
} from '../lib/import-sections';
import { importRunOutcome, IMPORT_COLUMNS } from '../lib/import-schema';
import { setEmploymentInfo } from '../core/org';
import { setBankProfileMY, setIcProfileMY, setPassportProfileMY } from '../localization/my/statutory';
import { parseCsvRecords } from '../lib/csv';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let a: ReturnType<typeof adminCtx>;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = adminCtx(b);
});
afterAll(async () => {
  await closeAll();
});

const recs = (header: string, rows: string[]) => parseCsvRecords(`${header}\n${rows.join('\n')}`).records;
const ic = (n: number) => `8${String(n).padStart(2, '0')}0101${String(n).padStart(2, '0')}5566`.slice(0, 12);

/** The wide template's columns, in the order the fixture below fills them. */
const WIDE_HEADER = [
  'full_name',
  'email',
  'department',
  'hired_on',
  'ic_number',
  'basic_salary',
  'employee_code',
  'phone',
  'employment_type',
  'bank_name',
  'bank_account_no',
  'epf_number',
  'socso_number',
  'tax_number',
  'tax_category',
  'num_children',
  'address_line_1',
  'address_line_2',
  'postcode',
  'city',
  'emergency_contact_name',
  'emergency_contact_phone',
].join(',');

/** Create one employee through the REAL wide importer, so everything this file then updates was
 *  written by the product rather than fixtured into place. */
async function seedEmployee(n: number, code: string) {
  const row = [
    `Section Subject ${n}`,
    `sec${n}@acme.test`,
    'Finance',
    '2026-01-05',
    ic(n),
    '5000',
    code,
    '+60 12-300 00' + n,
    'full_time',
    'Maybank',
    `51400011122${n}`,
    `EPF-${n}`,
    `SOC-${n}`,
    `TAX-${n}`,
    '2',
    '3',
    'No 12 Jalan Bunga',
    'Taman Melati',
    '53100',
    'Kuala Lumpur',
    'Aunt May',
    '+60 12-999 0000',
  ].join(',');
  const r = await commitEmployeeImport(a, { companyId: b.companyId, records: recs(WIDE_HEADER, [row]) });
  expect(r.imported, JSON.stringify(r.failed)).toBe(1);
}

async function personOf(code: string) {
  const [row] = await owner.db
    .select({
      id: schema.person.id,
      fullName: schema.person.fullName,
      primaryEmail: schema.person.primaryEmail,
      phone: schema.person.phone,
      permanentAddressLine1: schema.person.permanentAddressLine1,
      permanentAddressLine2: schema.person.permanentAddressLine2,
      permanentPostcode: schema.person.permanentPostcode,
      permanentCity: schema.person.permanentCity,
    })
    .from(schema.person)
    .innerJoin(schema.employment, eq(schema.employment.personId, schema.person.id))
    .where(and(eq(schema.employment.tenantId, b.tenantId), eq(schema.employment.employeeCode, code)));
  return row;
}

async function statutoryOf(code: string) {
  const p = await personOf(code);
  const [row] = await owner.db
    .select()
    .from(schema.employeeStatutoryMy)
    .where(eq(schema.employeeStatutoryMy.personId, p.id));
  return row;
}

async function employmentOf(code: string) {
  const [row] = await owner.db
    .select()
    .from(schema.employment)
    .where(and(eq(schema.employment.tenantId, b.tenantId), eq(schema.employment.employeeCode, code)));
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('2983802f §1 · the section catalogue accounts for every column', () => {
  it('every main-sheet column is the key, owned by exactly one section, or explicitly unsectioned', () => {
    const all = [...IMPORT_COLUMNS.required, ...IMPORT_COLUMNS.optional];
    const owners = new Map<string, string[]>();
    for (const s of IMPORT_SECTION_KEYS) {
      if (IMPORT_SECTION_DEFS[s].family) continue; // the family sheet is its own contract
      for (const c of [...IMPORT_SECTION_DEFS[s].required, ...IMPORT_SECTION_DEFS[s].optional]) {
        owners.set(c, [...(owners.get(c) ?? []), s]);
      }
    }
    const unowned = all.filter((c) => c !== SECTION_KEY_COLUMN && !owners.has(c) && !(c in UNSECTIONED_COLUMNS));
    expect(
      unowned,
      `These wide-template columns belong to no section and are not listed in UNSECTIONED_COLUMNS with a ` +
        `reason. Decide which section owns them, or say why none may write them:\n${unowned.join('\n')}`,
    ).toEqual([]);

    const doubled = [...owners.entries()].filter(([, s]) => s.length > 1);
    expect(doubled, `A column may be owned by at most one section:\n${JSON.stringify(doubled)}`).toEqual([]);

    const contradictory = [...owners.keys()].filter((c) => c in UNSECTIONED_COLUMNS);
    expect(contradictory, 'A column cannot be both owned and unsectioned').toEqual([]);
  });

  it('every section template carries the Employee ID key first', () => {
    for (const s of IMPORT_SECTION_KEYS) expect(sectionColumns(s)[0]).toBe(SECTION_KEY_COLUMN);
  });

  it('unsectioned columns each carry a reason', () => {
    for (const [col, why] of Object.entries(UNSECTIONED_COLUMNS)) {
      expect(why.length, `${col} needs a reason`).toBeGreaterThan(10);
    }
  });
});

describe('2983802f §2 · the section fence is enforced on the FILE, not on the template', () => {
  it('a recognised column belonging to another section is refused; an unknown column is ignored', () => {
    expect(foreignColumns('bank_statutory', ['employee_code', 'bank_name', 'address_line_1'])).toEqual([
      'address_line_1',
    ]);
    // Not a column the importer has ever heard of — real spreadsheets carry these, and refusing them
    // would reject good files for no safety gain.
    expect(foreignColumns('bank_statutory', ['employee_code', 'bank_name', 'internal_notes'])).toEqual([]);
    expect(foreignColumns('profile', ['employee_code', 'city', 'basic_salary'])).toEqual(['basic_salary']);
  });

  it('a Bank and Statutory file carrying a Profile column is refused WHOLE and writes nothing', async () => {
    await seedEmployee(21, 'SEC0021');
    const before = await personOf('SEC0021');
    const header = 'employee_code,bank_account_no,address_line_1';
    const records = recs(header, ['SEC0021,999888777,Somewhere Else']);

    const preview = await validateSectionImport(a, { section: 'bank_statutory', records });
    expect(preview.fileErrors.length).toBeGreaterThan(0);
    expect(preview.fileErrors.join(' ')).toContain('address_line_1');

    // The server refuses independently of the screen — the disabled button is a courtesy, not the guard.
    const result = await commitSectionImport(a, { section: 'bank_statutory', records });
    expect(result.updated).toBe(0);
    expect(result.fileErrors.length).toBeGreaterThan(0);
    const after = await personOf('SEC0021');
    expect(after.permanentAddressLine1).toBe(before.permanentAddressLine1);
    expect((await statutoryOf('SEC0021')).bankAccountNo).toBe('5140001112221');
  });

  it('a file with no Employee ID column is refused whole', async () => {
    await seedEmployee(22, 'SEC0022');
    const records = recs('email,bank_account_no', ['sec22@acme.test,111']);
    const preview = await validateSectionImport(a, { section: 'bank_statutory', records });
    expect(preview.missingColumns).toContain('employee_code');
    expect(preview.fileErrors.length).toBeGreaterThan(0);
  });
});

describe('2983802f §3 · the per-row verdict, before anything is written', () => {
  it('says UPDATE for a matched Employee ID and refuses one that matches nobody', async () => {
    await seedEmployee(31, 'SEC0031');
    const records = recs('employee_code,bank_account_no', ['SEC0031,700700700', 'NOSUCH1,700700701']);
    const preview = await validateSectionImport(a, { section: 'bank_statutory', records });

    expect(preview.rows[0].verdict).toBe('update');
    expect(preview.rows[0].ok).toBe(true);
    expect(preview.rows[0].employeeName).toBe('Section Subject 31');
    expect(preview.rows[0].changes).toContain('bank_account_no');

    expect(preview.rows[1].verdict).toBe('create');
    expect(preview.rows[1].ok).toBe(false);
    expect(preview.rows[1].errors.join(' ')).toContain('NOSUCH1');
    expect(preview.updateCount).toBe(1);
    expect(preview.createCount).toBe(1);
  });

  it('says NO CHANGE for a matched row whose every cell is blank, and writes nothing for it', async () => {
    await seedEmployee(32, 'SEC0032');
    const records = recs('employee_code,bank_name,bank_account_no,tax_number', ['SEC0032,,,']);
    const preview = await validateSectionImport(a, { section: 'bank_statutory', records });
    expect(preview.rows[0].verdict).toBe('skip');
    expect(preview.updateCount).toBe(0);

    const result = await commitSectionImport(a, { section: 'bank_statutory', records });
    expect(result.updated).toBe(0);
    // The blank cells did NOT clear the bank details they were sitting under.
    const stat = await statutoryOf('SEC0032');
    expect(stat.bankName).toBe('Maybank');
    expect(stat.bankAccountNo).toBe('5140001112232');
  });

  it('refuses two rows for the same employee rather than letting file order decide', async () => {
    await seedEmployee(33, 'SEC0033');
    const records = recs('employee_code,tax_number', ['SEC0033,AAA', 'SEC0033,BBB']);
    const preview = await validateSectionImport(a, { section: 'bank_statutory', records });
    expect(preview.rows[1].errors.join(' ')).toContain('Duplicate');
  });
});

describe('2983802f §4 · A BLANK CELL MEANS "LEAVE THIS AS IT IS"', () => {
  /**
   * THE ASSERTION THIS ITEM TURNS ON. A wide file that nulled its omitted columns would wipe data
   * across every employee it named, in one confirm — the single most expensive way this feature can
   * fail. So a Bank and Statutory import is run for an employee who has an address, and the address is
   * read back FROM THE DATABASE afterwards.
   */
  it('a Bank and Statutory import leaves the employee’s ADDRESS untouched', async () => {
    await seedEmployee(41, 'SEC0041');
    const before = await personOf('SEC0041');
    expect(before.permanentAddressLine1).toBe('No 12 Jalan Bunga'); // the fixture really did write one

    const records = recs('employee_code,bank_name,bank_account_no', ['SEC0041,CIMB,8009991122']);
    const result = await commitSectionImport(a, { section: 'bank_statutory', records });
    expect(result.updated).toBe(1);

    const after = await personOf('SEC0041');
    expect(after.permanentAddressLine1).toBe('No 12 Jalan Bunga');
    expect(after.permanentAddressLine2).toBe('Taman Melati');
    expect(after.permanentPostcode).toBe('53100');
    expect(after.permanentCity).toBe('Kuala Lumpur');
    expect(after.fullName).toBe('Section Subject 41');
    expect(after.phone).toBe('+60 12-300 0041');
    // …and the bank details it DID carry actually moved.
    const stat = await statutoryOf('SEC0041');
    expect(stat.bankName).toBe('CIMB');
    expect(stat.bankAccountNo).toBe('8009991122');
  });

  /**
   * The same rule INSIDE one setter's block. `setTax` rewrites every tax column from its arguments, so
   * a file supplying only the tax reference number would reset the tax category to 1 and the child
   * count to 0 unless the stored values are merged in first. That is the identical catastrophe at a
   * smaller scale, and it is the one a careless implementation actually ships.
   */
  it('a tax-number-only import leaves tax category, child count and the EPF/SOCSO numbers alone', async () => {
    await seedEmployee(42, 'SEC0042');
    const before = await statutoryOf('SEC0042');
    expect(before.taxCategory).toBe(2);
    expect(before.numChildren).toBe(3);

    const records = recs('employee_code,tax_number', ['SEC0042,LHDN-NEW-42']);
    const result = await commitSectionImport(a, { section: 'bank_statutory', records });
    expect(result.updated).toBe(1);

    const after = await statutoryOf('SEC0042');
    expect(after.taxNumber).toBe('LHDN-NEW-42');
    expect(after.taxCategory).toBe(2);
    expect(after.numChildren).toBe(3);
    // Nothing outside the tax block moved either — `setTax` is a partial setter, and the merge above
    // must not have tempted anyone into the full-row one.
    expect(after.epfNumber).toBe(before.epfNumber);
    expect(after.socsoNumber).toBe(before.socsoNumber);
    expect(after.bankAccountNo).toBe(before.bankAccountNo);
    expect(after.icNumber).toBe(before.icNumber);
  });

  /**
   * EVERY CARRY-THROUGH, PINNED — one assertion per merged field, not one per setter.
   *
   * The four below were the ones nothing held: the whole suite stayed green with the person phone, the
   * custom-payment-holder block, the passport remark + ISO country code and the CP39 old identity-card
   * number all dropped from their merges. Each of those, shipped, is silent data loss on a file that
   * never mentioned the field — which is the ONE failure this item exists to prevent.
   */
  it('a Profile file that changes only the city leaves the mobile number alone', async () => {
    await seedEmployee(43, 'SEC0043');
    const before = await personOf('SEC0043');
    expect(before.phone).toBe('+60 12-300 0043'); // the fixture really did write one

    const records = recs('employee_code,city', ['SEC0043,Shah Alam']);
    expect((await commitSectionImport(a, { section: 'profile', records })).updated).toBe(1);

    const after = await personOf('SEC0043');
    expect(after.permanentCity).toBe('Shah Alam');
    // `updatePerson` rewrites name / email / phone from its arguments: an unmerged payload nulls this.
    expect(after.phone).toBe('+60 12-300 0043');
    expect(after.fullName).toBe('Section Subject 43');
    expect(after.primaryEmail).toBe('sec43@acme.test');
  });

  it('a bank-account-only import leaves the custom payment holder alone — the salary is not redirected', async () => {
    await seedEmployee(44, 'SEC0044');
    const p = await personOf('SEC0044');
    // Somebody else is paid this employee's salary — a real configuration, and the one a careless
    // `setBank` payload silently cancels by nulling the four columns it was not passed.
    await setBankProfileMY(a, {
      personId: p.id,
      bankName: 'Maybank',
      bankAccountNo: '5140001112244',
      enableCustomHolderName: true,
      customHolderName: 'Siti binti Ahmad',
      enableCustomHolderId: true,
      customHolderId: '900101015566',
    });

    const records = recs('employee_code,bank_account_no', ['SEC0044,7009998888']);
    expect((await commitSectionImport(a, { section: 'bank_statutory', records })).updated).toBe(1);

    const stat = await statutoryOf('SEC0044');
    expect(stat.bankAccountNo).toBe('7009998888');
    expect(stat.enableCustomHolderName).toBe(true);
    expect(stat.customHolderName).toBe('Siti binti Ahmad');
    expect(stat.enableCustomHolderId).toBe(true);
    expect(stat.customHolderId).toBe('900101015566');
  });

  it('a passport-expiry-only import leaves the remark and the CP39 country code alone', async () => {
    await seedEmployee(45, 'SEC0045');
    const p = await personOf('SEC0045');
    await setPassportProfileMY(a, {
      personId: p.id,
      passportNumber: 'A1234567',
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2029-01-01',
      passportRemark: 'Renewed at KLIA',
      passportIssuingCountryCode: 'MY',
    });

    // "Correct 400 expiry dates" — the file the whole merge exists to make legal.
    const records = recs('employee_code,passport_expiry_date', ['SEC0045,2031-05-05']);
    expect((await commitSectionImport(a, { section: 'profile', records })).updated).toBe(1);

    const stat = await statutoryOf('SEC0045');
    expect(stat.passportExpiryDate).toBe('2031-05-05');
    expect(stat.passportNumber).toBe('A1234567');
    expect(stat.passportIssueDate).toBe('2024-01-01');
    // Neither has an import column at all, and `setPassport` rewrites both from its arguments.
    expect(stat.passportRemark).toBe('Renewed at KLIA');
    expect(stat.passportIssuingCountryCode).toBe('MY');
  });

  it('an IC correction leaves the CP39 old identity-card number alone', async () => {
    await seedEmployee(46, 'SEC0046');
    const p = await personOf('SEC0046');
    await setIcProfileMY(a, { personId: p.id, icNumber: ic(46), oldIcNumber: 'A 1234567' });

    const records = recs('employee_code,ic_number', [`SEC0046,${ic(96)}`]);
    expect((await commitSectionImport(a, { section: 'profile', records })).updated).toBe(1);

    const stat = await statutoryOf('SEC0046');
    expect(stat.icNumber).toBe(ic(96));
    // `setIc` rewrites `old_ic_number` from its argument — an omitted one wipes the CP39's No. K/P Lama.
    expect(stat.oldIcNumber).toBe('A 1234567');
  });
});

describe('2983802f §5 · the other three sections write what they own', () => {
  it('Profile updates the address and the emergency contact, and leaves the bank alone', async () => {
    await seedEmployee(51, 'SEC0051');
    const bankBefore = (await statutoryOf('SEC0051')).bankAccountNo;
    const records = recs('employee_code,address_line_1,city,emergency_contact_phone', [
      'SEC0051,Unit 8 Menara Baru,Petaling Jaya,+60 19-111 2222',
    ]);
    const preview = await validateSectionImport(a, { section: 'profile', records });
    expect(preview.rows[0].changes).toEqual(
      expect.arrayContaining(['address_line_1', 'city', 'emergency_contact_phone']),
    );
    expect((await commitSectionImport(a, { section: 'profile', records })).updated).toBe(1);

    const after = await personOf('SEC0051');
    expect(after.permanentAddressLine1).toBe('Unit 8 Menara Baru');
    expect(after.permanentCity).toBe('Petaling Jaya');
    // Untouched by a Profile file: the postcode it never mentioned, and the whole statutory row.
    expect(after.permanentPostcode).toBe('53100');
    expect((await statutoryOf('SEC0051')).bankAccountNo).toBe(bankBefore);
  });

  it('Employment writes the probation and notice periods and the direct superior', async () => {
    await seedEmployee(52, 'SEC0052');
    await seedEmployee(53, 'SEC0053');
    const records = recs('employee_code,probation_months,resignation_notice_months,direct_superior', [
      'SEC0052,6,2,SEC0053',
    ]);
    const result = await commitSectionImport(a, { section: 'employment', records });
    expect(result.updated, JSON.stringify(result.failed)).toBe(1);

    const emp = await employmentOf('SEC0052');
    expect(emp.probationMonths).toBe(6);
    expect(emp.resignationNoticeMonths).toBe(2);

    const manager = await employmentOf('SEC0053');
    const [line] = await owner.db
      .select()
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.subordinateEmploymentId, emp.id));
    expect(line.managerEmploymentId).toBe(manager.id);
  });

  it('Employment refuses a direct superior nobody employs, and refuses the employee themselves', async () => {
    await seedEmployee(54, 'SEC0054');
    const preview = await validateSectionImport(a, {
      section: 'employment',
      records: recs('employee_code,direct_superior', ['SEC0054,GHOST9']),
    });
    expect(preview.rows[0].errors.join(' ')).toContain('GHOST9');
    const self = await validateSectionImport(a, {
      section: 'employment',
      records: recs('employee_code,direct_superior', ['SEC0054,SEC0054']),
    });
    expect(self.rows[0].errors.join(' ')).toContain('themselves');
  });

  it('Family adds a member to an existing employee, and skips one that is already on file', async () => {
    await seedEmployee(55, 'SEC0055');
    const records = recs('employee_code,full_name,relationship,date_of_birth', [
      'SEC0055,Nurul Huda,spouse,1990-04-04',
    ]);
    expect((await commitSectionImport(a, { section: 'family', records })).updated).toBe(1);

    const p = await personOf('SEC0055');
    const deps = await owner.db
      .select()
      .from(schema.employeeDependent)
      .where(eq(schema.employeeDependent.personId, p.id));
    expect(deps.map((d) => d.fullName)).toEqual(['Nurul Huda']);

    // Two identical rows in ONE file must not do it either — the stored set is read before the loop,
    // so the resolver has to remember what it has already decided to add.
    const twice = recs('employee_code,full_name,relationship,date_of_birth', [
      'SEC0055,Ali Bin Abu,child,2015-01-01',
      'SEC0055,Ali Bin Abu,child,2015-01-01',
    ]);
    const twicePreview = await validateSectionImport(a, { section: 'family', records: twice });
    expect(twicePreview.rows[0].verdict).toBe('update');
    expect(twicePreview.rows[1].verdict).toBe('skip');

    // Re-uploading the same file must not give somebody two spouses.
    const second = await validateSectionImport(a, { section: 'family', records });
    expect(second.rows[0].verdict).toBe('skip');
    expect(second.rows[0].warnings.join(' ')).toContain('Already on file');
    expect((await commitSectionImport(a, { section: 'family', records })).updated).toBe(0);
    const after = await owner.db
      .select()
      .from(schema.employeeDependent)
      .where(eq(schema.employeeDependent.personId, p.id));
    expect(after.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('2983802f §6 · two employees can never be given one identity', () => {
  /**
   * The work email is the LOGIN identity and has no unique index behind it (db/schema.ts: `primaryEmail`
   * carries only `person_tenant_idx`), so nothing but this check stands between a column-shifted
   * spreadsheet and two people sharing an account. The identity number DOES have one — which is worse,
   * not better: the collision surfaced as a raw driver error at commit, carrying the NRIC itself as a
   * bound parameter into the admin's screen and into the stored import history.
   */
  it('refuses a second row in ONE file that assigns the same work email, and the second employee keeps theirs', async () => {
    await seedEmployee(61, 'SEC0061');
    await seedEmployee(62, 'SEC0062');
    const records = recs('employee_code,email', ['SEC0061,shared@acme.test', 'SEC0062,shared@acme.test']);

    const preview = await validateSectionImport(a, { section: 'profile', records });
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[1].errors.join(' ')).toContain('Duplicate email in this file');
    expect(preview.rows[1].ok).toBe(false);
    expect(preview.updateCount).toBe(1);

    const result = await commitSectionImport(a, { section: 'profile', records });
    expect(result.updated).toBe(1);
    expect((await personOf('SEC0061')).primaryEmail).toBe('shared@acme.test');
    expect((await personOf('SEC0062')).primaryEmail).toBe('sec62@acme.test');
  });

  it('refuses a work email that another employee already holds', async () => {
    await seedEmployee(63, 'SEC0063');
    await seedEmployee(64, 'SEC0064');
    const records = recs('employee_code,email', ['SEC0063,sec64@acme.test']);

    const preview = await validateSectionImport(a, { section: 'profile', records });
    expect(preview.rows[0].errors.join(' ')).toContain('already has the work email');
    expect(preview.updateCount).toBe(0);

    expect((await commitSectionImport(a, { section: 'profile', records })).updated).toBe(0);
    expect((await personOf('SEC0063')).primaryEmail).toBe('sec63@acme.test');
    expect((await personOf('SEC0064')).primaryEmail).toBe('sec64@acme.test');
  });

  it('refuses two rows in ONE file that assign the same identity number, in the DRY RUN', async () => {
    await seedEmployee(65, 'SEC0065');
    await seedEmployee(66, 'SEC0066');
    const shared = ic(96);
    const records = recs('employee_code,ic_number', [`SEC0065,${shared}`, `SEC0066,${shared}`]);

    const preview = await validateSectionImport(a, { section: 'profile', records });
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[1].errors.join(' ')).toContain('Duplicate ic_number in this file');
    // …and the refusal names the ROW, never the number (PDPA — this is an identity document).
    expect(preview.rows[1].errors.join(' ')).not.toContain(shared);

    // The second row must never reach the write, so no raw unique-violation can be reported or stored.
    const result = await commitSectionImport(a, { section: 'profile', records });
    expect(result.failed).toEqual([]);
    expect(result.updated).toBe(1);
    expect((await statutoryOf('SEC0066')).icNumber).toBe(ic(66));
  });

  it('a failed write is reported by column and row — never by the driver’s text or a bound value', () => {
    // The exact shape observed before this was fixed: a Drizzle unique violation whose message carries
    // the statement AND the NRIC that caused it, which was rendered to the admin and persisted into
    // `employee_import_run.errors`.
    const driverError = Object.assign(
      new Error(
        'Failed query: update "employee_statutory_my" set "ic_number" = $1, "old_ic_number" = $2, ' +
          '"updated_at" = now() where "person_id" = $3 params: 899010199556,,e251f6a3-1111-2222-3333-444455556666',
      ),
      { code: '23505' },
    );
    const msg = writeFailureMessage('ic', driverError);
    expect(msg).toContain('ic_number');
    expect(msg).toContain('another employee already has');
    expect(msg).not.toContain('899010199556');
    expect(msg).not.toContain('Failed query');
    expect(msg).not.toContain('e251f6a3');

    // A failure that is NOT a collision still names the columns and still quotes nothing.
    const other = writeFailureMessage('bank', new Error('null value in column "bank_name" params: 5140001112299'));
    expect(other).toContain('bank_account_no');
    expect(other).not.toContain('5140001112299');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('2983802f §7 · an import that reports success must be visible on the screen', () => {
  /**
   * "Appears to work and does nothing" is the worst pass this feature can produce. Migration 0213 moved
   * the Employment tab's periods to a VALUE + UNIT pair and the tab renders `probationValue ??
   * probationMonths` — so an import that wrote only the legacy column changed nothing anybody could see
   * for every employee whose Employment tab had ever been saved.
   */
  it('Employment writes the probation and notice period the Employment tab actually reads', async () => {
    await seedEmployee(71, 'SEC0071');
    const records = recs('employee_code,probation_months,resignation_notice_months', ['SEC0071,6,2']);
    const result = await commitSectionImport(a, { section: 'employment', records });
    expect(result.updated, JSON.stringify(result.failed)).toBe(1);

    const emp = await employmentOf('SEC0071');
    expect(emp.probationValue).toBe(6);
    expect(emp.probationUnit).toBe('month');
    expect(emp.noticeBeforeConfirmationValue).toBe(2);
    expect(emp.noticeBeforeConfirmationUnit).toBe('month');
    // …and the legacy twin is written from the SAME cell, so the tab's fallback can never contradict it.
    expect(emp.probationMonths).toBe(6);
    expect(emp.resignationNoticeMonths).toBe(2);
  });

  it('an employee whose Employment tab was saved once still SEES the imported probation period', async () => {
    await seedEmployee(72, 'SEC0072');
    const before = await employmentOf('SEC0072');
    // Exactly what the Employment tab form posts (page.tsx has probationValue/probationUnit inputs and
    // no probationMonths input at all) — the save that used to make an import invisible.
    await setEmploymentInfo(a, { employmentId: before.id, probationValue: '3', probationUnit: 'month' });

    const records = recs('employee_code,probation_months', ['SEC0072,6']);
    expect((await commitSectionImport(a, { section: 'employment', records })).updated).toBe(1);

    const emp = await employmentOf('SEC0072');
    expect(emp.probationValue ?? emp.probationMonths).toBe(6); // ← the expression the tab renders
    expect(emp.probationUnit).toBe('month');
  });

  it('a days column writes a DAYS period, and months + days on one row is refused', async () => {
    await seedEmployee(73, 'SEC0073');
    const days = recs('employee_code,probation_days', ['SEC0073,90']);
    expect((await commitSectionImport(a, { section: 'employment', records: days })).updated).toBe(1);
    const emp = await employmentOf('SEC0073');
    expect(emp.probationValue).toBe(90);
    expect(emp.probationUnit).toBe('day');
    expect(emp.probationDays).toBe(90);

    // The screen holds ONE number and ONE unit per period, so half of this row would be dropped.
    const both = await validateSectionImport(a, {
      section: 'employment',
      records: recs('employee_code,probation_months,probation_days', ['SEC0073,3,15']),
    });
    expect(both.rows[0].errors.join(' ')).toContain('cannot both be filled in');
    expect(both.rows[0].ok).toBe(false);
  });

  it('the fence names the section that owns a refused column, and says plainly when none does', async () => {
    await seedEmployee(74, 'SEC0074');
    const moved = await validateSectionImport(a, {
      section: 'bank_statutory',
      records: recs('employee_code,bank_name,address_line_1', ['SEC0074,CIMB,Somewhere Else']),
    });
    expect(moved.fileErrors.join(' ')).toContain('address_line_1');
    expect(moved.fileErrors.join(' ')).toContain('Profile'); // the door exists, so name it

    // epf_number is owned by NO section. The old refusal told the reader to "choose the section that
    // owns them" — on the single likeliest bulk update HR would attempt, that was a door that is not
    // there. It has to say so instead.
    const homeless = await validateSectionImport(a, {
      section: 'bank_statutory',
      records: recs('employee_code,bank_name,epf_number', ['SEC0074,CIMB,EPF-9']),
    });
    const joined = homeless.fileErrors.join(' ');
    expect(joined).toContain('epf_number');
    expect(joined).toContain('No section file can change these columns');
    expect(joined).not.toContain('choose the section that owns');
  });

  it('a Profile row that repeats what is already on file is NO CHANGE, not an update', async () => {
    await seedEmployee(75, 'SEC0075');
    // The emergency-contact block lives in the per-person register, not on `person`; a diff that could
    // not see it called all five columns changed and turned a re-uploaded corrected file into a page of
    // phantom updates.
    const preview = await validateSectionImport(a, {
      section: 'profile',
      records: recs('employee_code,emergency_contact_name,emergency_contact_phone,city', [
        'SEC0075,Aunt May,+60 12-999 0000,Kuala Lumpur',
      ]),
    });
    expect(preview.rows[0].changes).toEqual([]);
    expect(preview.rows[0].verdict).toBe('skip');
    expect(preview.updateCount).toBe(0);
  });

  it('a run in which every row was already correct is not badged as a failure', async () => {
    await seedEmployee(76, 'SEC0076');
    const records = recs('employee_code,bank_name,bank_account_no', ['SEC0076,Maybank,5140001112276']);
    const result = await commitSectionImport(a, {
      section: 'bank_statutory',
      records,
      fileName: 'nothing-to-do.xlsx',
    });
    expect(result.updated).toBe(0);
    expect(result.failed).toEqual([]);

    const [run] = await listEmployeeImportRuns(a);
    expect(run.totalRows).toBe(1);
    expect(run.importedRows).toBe(0);
    expect(run.failedRows).toBe(0);
    // Nothing was wrong with this run. Keying the badge on "imported nothing" painted it red.
    expect(importRunOutcome(run)).toBe('succeeded');
  });

  it('refuses a row whose Employee ID matches nobody, and names the template that DOES add people', async () => {
    await seedEmployee(77, 'SEC0077');
    const preview = await validateSectionImport(a, {
      section: 'profile',
      records: recs('employee_code,city', ['SEC0077,Ipoh', 'NOBODY7,Ipoh']),
    });
    expect(preview.createCount).toBe(1);
    const refusal = preview.rows[1].errors.join(' ');
    expect(refusal).toContain('NOBODY7');
    expect(refusal).toContain('can only UPDATE');
    expect(refusal).toContain('cannot add anyone');
    expect(refusal).toContain('Everything — new employees');
  });
});
