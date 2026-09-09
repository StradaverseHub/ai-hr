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
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { commitEmployeeImport } from '../core/import';
import { commitSectionImport, validateSectionImport } from '../core/import-sections';
import {
  foreignColumns,
  IMPORT_SECTION_DEFS,
  IMPORT_SECTION_KEYS,
  SECTION_KEY_COLUMN,
  sectionColumns,
  UNSECTIONED_COLUMNS,
} from '../lib/import-sections';
import { IMPORT_COLUMNS } from '../lib/import-schema';
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
