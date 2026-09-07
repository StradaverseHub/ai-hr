/**
 * Item 2983802f — "the import template only supports a limited number of employee fields".
 *
 * The template-versus-fields PARITY guard lives in test/employee-import-field-parity.test.ts and is the
 * durable half of this item. THIS file is the behavioural half: the seven blocks that were genuinely
 * absent now travel from a spreadsheet cell into the employee record, and the two structural cases the
 * plan singled out actually behave the way it says they do.
 *
 * §1 THE SCOPE FENCE, first, because it is the promise the plan made to the reporter: "a file that
 *    imports successfully today will still import successfully". Pinned with the exact column list the
 *    template had BEFORE this change, spelled out here rather than derived — deriving it from
 *    IMPORT_COLUMNS would make the assertion re-derive itself and pass forever.
 * §2 The new columns, cell → record, read back from the database rather than from the preview.
 * §3 Per-row, per-column validation for the new blocks.
 * §4 DIRECT SUPERIOR AS A FORWARD REFERENCE — the manager further down the file.
 * §5 THE FAMILY SHEET, including the decision the plan asked to be made and documented: a family row
 *    naming an employee the file does not contain rejects the WHOLE file and writes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  carriedProfileValue,
  classifyCatalogCell,
  commitEmployeeImport,
  validateEmployeeImport,
} from '../core/import';
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

/** Build records from a header line + data lines, exactly as the screen's CSV path does. */
const recs = (header: string, rows: string[]) => parseCsvRecords(`${header}\n${rows.join('\n')}`).records;

/** A distinct valid 12-digit MyKad per row so nothing collides. */
const ic = (n: number) => `8${String(n).padStart(2, '0')}0101${String(n).padStart(2, '0')}5566`.slice(0, 12);

/** The employee row the person the import created, by work email. */
async function personByEmail(email: string) {
  const [row] = await owner.db
    .select()
    .from(schema.person)
    .where(and(eq(schema.person.tenantId, b.tenantId), eq(schema.person.primaryEmail, email)));
  return row;
}

async function employmentByCode(code: string) {
  const [row] = await owner.db
    .select()
    .from(schema.employment)
    .where(and(eq(schema.employment.tenantId, b.tenantId), eq(schema.employment.employeeCode, code)));
  return row;
}

describe('2983802f §1 · the scope fence — today’s file still imports', () => {
  /**
   * The exact contract as it stood BEFORE this item: 6 required + 23 optional. Written out by hand on
   * purpose. If this were derived from IMPORT_COLUMNS it would silently follow every future change and
   * assert nothing at all — the whole point is to pin the shape of a file an existing customer has
   * already saved on their machine.
   */
  const LEGACY_HEADER = [
    'full_name',
    'email',
    'department',
    'hired_on',
    'ic_number',
    'basic_salary',
    'company',
    'employee_code',
    'phone',
    'position',
    'cost_center',
    'employment_type',
    'monthly_allowance',
    'bank_name',
    'bank_account_no',
    'epf_number',
    'socso_number',
    'tax_number',
    'tax_category',
    'num_children',
    'eis_eligible',
    'is_resident',
    'epf_citizenship',
    'pay_mode',
    'payment_term',
    'rate_amount',
  ].join(',');

  const LEGACY_ROW = [
    'Legacy Filer',
    'legacy@acme.test',
    'Finance',
    '2026-03-02',
    ic(11),
    '4800',
    '', // company — blank keeps the on-screen target company
    'LEG0001',
    '+60 12-000 1111',
    'Executive',
    'CC1',
    'full_time',
    '250',
    'Maybank',
    '514000111222',
    '',
    '',
    '',
    '2',
    '1',
    'yes',
    'yes',
    'citizen',
    'monthly',
    'monthly',
    '',
  ].join(',');

  it('a file carrying only the pre-2983802f columns validates with no errors and imports', async () => {
    const records = recs(LEGACY_HEADER, [LEGACY_ROW]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.rows[0].errors, 'a file that imported yesterday must import today').toEqual([]);
    expect(preview.validCount).toBe(1);
    expect(preview.missingColumns).toEqual([]);
    // The new machinery is present but inert: no family sheet, nothing refused at file level.
    expect(preview.fileErrors).toEqual([]);
    expect(preview.dependents.total).toBe(0);

    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.dependentsImported).toBe(0);
    expect(result.superiorFailed).toEqual([]);
  });

  it('EVERY new column is optional — an absent column can never make a row invalid', async () => {
    // Belt and braces on the same promise, stated as a rule rather than a sample: nothing this item
    // added may appear in `missingColumns`, which is the list of REQUIRED columns a file lacks.
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(LEGACY_HEADER, [LEGACY_ROW]),
    });
    expect(preview.missingColumns).toEqual([]);
  });

  it('an existing file does not write an address, a passport or an emergency contact', async () => {
    // The columns are absent, so the row must not touch those records AT ALL — a writer that ran with
    // blank values would clear fields on a re-import and blank an address nobody asked it to touch.
    await commitEmployeeImport(a, { companyId: b.companyId, records: recs(LEGACY_HEADER, [LEGACY_ROW]) });
    const p = await personByEmail('legacy@acme.test');
    expect(p.permanentAddressLine1).toBeNull();
    const contacts = await owner.db
      .select()
      .from(schema.personEmergencyContact)
      .where(eq(schema.personEmergencyContact.personId, p.id));
    expect(contacts).toHaveLength(0);
    const [stat] = await owner.db
      .select()
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, p.id));
    expect(stat.passportNumber).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const NEW_HEADER = [
  'full_name,email,department,hired_on,ic_number,basic_salary,employee_code,employment_type',
  'passport_number,passport_issue_date,passport_expiry_date,passport_issuing_country',
  'address_line_1,address_line_2,address_line_3,postcode,city,state,country',
  'emergency_contact_name,emergency_contact_relationship,emergency_contact_phone,emergency_contact_home_phone,emergency_contact_address',
  'probation_end_date,probation_months,probation_days,confirmation_date',
  'resignation_notice_months,resignation_notice_days,direct_superior',
].join(',');

/** One filled-in row of the new blocks. `over` replaces named cells by column name. */
function newRow(over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    full_name: 'Faizal Bin Osman',
    email: 'faizal@acme.test',
    department: 'Finance',
    hired_on: '2026-04-01',
    ic_number: ic(21),
    basic_salary: '6000',
    employee_code: 'NEW0001',
    employment_type: 'full_time',
    passport_number: 'A98765432',
    passport_issue_date: '2022-01-10',
    passport_expiry_date: '2032-01-09',
    passport_issuing_country: '',
    address_line_1: '88 Jalan Bukit',
    address_line_2: 'Taman Desa',
    address_line_3: '',
    postcode: '58100',
    city: 'Kuala Lumpur',
    state: '',
    country: '',
    emergency_contact_name: 'Salmah Binti Ali',
    emergency_contact_relationship: '',
    emergency_contact_phone: '+60 19-888 7777',
    emergency_contact_home_phone: '03-7788 9900',
    // No comma: these rows are joined into raw CSV without quoting, and a comma here would silently
    // shift every column after it — which is exactly how this test first went red.
    emergency_contact_address: '88 Jalan Bukit Kuala Lumpur',
    probation_end_date: '2026-07-01',
    probation_months: '3',
    probation_days: '0',
    confirmation_date: '2026-07-01',
    resignation_notice_months: '2',
    resignation_notice_days: '0',
    direct_superior: '',
  };
  const merged = { ...base, ...over };
  return NEW_HEADER.split(',')
    .map((c) => merged[c] ?? '')
    .join(',');
}

describe('2983802f §2 · the seven absent blocks reach the employee record', () => {
  it('passport, address, emergency contact, probation and notice all land in the database', async () => {
    const records = recs(NEW_HEADER, [newRow()]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.rows[0].errors).toEqual([]);

    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([]);

    const p = await personByEmail('faizal@acme.test');

    // PASSPORT — on the pack's statutory row, beside the IC.
    const [stat] = await owner.db
      .select()
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, p.id));
    expect(stat.passportNumber).toBe('A98765432');
    expect(stat.passportIssueDate).toBe('2022-01-10');
    expect(stat.passportExpiryDate).toBe('2032-01-09');
    // …and the IC is still there. The passport writer must ADD identification, never replace it.
    expect(stat.icNumber).toBe(ic(21));

    // ADDRESS — the permanent block, which is what the Contact & Address card reads.
    expect(p.permanentAddressLine1).toBe('88 Jalan Bukit');
    expect(p.permanentAddressLine2).toBe('Taman Desa');
    expect(p.permanentPostcode).toBe('58100');
    expect(p.permanentCity).toBe('Kuala Lumpur');

    // EMERGENCY CONTACT — a row in the register, filed as Primary.
    const contacts = await owner.db
      .select()
      .from(schema.personEmergencyContact)
      .where(
        and(
          eq(schema.personEmergencyContact.personId, p.id),
          isNull(schema.personEmergencyContact.archivedAt),
        ),
      );
    expect(contacts).toHaveLength(1);
    expect(contacts[0].fullName).toBe('Salmah Binti Ali');
    expect(contacts[0].mobilePhone).toBe('+60 19-888 7777');
    expect(contacts[0].homePhone).toBe('03-7788 9900');
    expect(contacts[0].priority).toBe('primary');

    // PROBATION + NOTICE PERIOD — on the employment.
    const emp = await employmentByCode('NEW0001');
    expect(emp.provisionalEndOn, 'probation end date').toBe('2026-07-01');
    expect(emp.probationMonths).toBe(3);
    expect(emp.probationDays).toBe(0);
    expect(emp.confirmationDate).toBe('2026-07-01');
    expect(emp.resignationNoticeMonths).toBe(2);
    expect(emp.resignationNoticeDays).toBe(0);
  });

  it('the employee’s own phone survives the address write', async () => {
    // `updatePerson` re-writes the core name/email/phone trio, so an address save that forgot to carry
    // the phone through would blank the number the same row had just supplied. Cheap to get wrong.
    const header = `${NEW_HEADER},phone`;
    const row = `${newRow()},+60 11-222 3333`;
    await commitEmployeeImport(a, { companyId: b.companyId, records: recs(header, [row]) });
    const p = await personByEmail('faizal@acme.test');
    expect(p.phone).toBe('+60 11-222 3333');
  });
});

describe('2983802f §3 · the new columns are validated, per row and per column', () => {
  const errorsFor = async (over: Record<string, string>) => {
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(NEW_HEADER, [newRow(over)]),
    });
    return preview.rows[0].errors.join(' | ');
  };

  it('a partial passport block is refused, naming the three columns', async () => {
    const e = await errorsFor({ passport_expiry_date: '' });
    expect(e).toMatch(/passport_number, passport_issue_date and passport_expiry_date/);
  });

  it('a passport that expires before it was issued is refused', async () => {
    expect(await errorsFor({ passport_expiry_date: '2021-01-01' })).toMatch(/passport_expiry_date/);
  });

  it('a malformed date names the column it came from', async () => {
    expect(await errorsFor({ confirmation_date: '01/07/2026' })).toMatch(
      /confirmation_date must be YYYY-MM-DD/,
    );
  });

  it('a probation period that is not a whole number is refused', async () => {
    expect(await errorsFor({ probation_months: '2.5' })).toMatch(/Invalid probation_months/);
    expect(await errorsFor({ resignation_notice_days: '-4' })).toMatch(/Invalid resignation_notice_days/);
  });

  it('probation_end_date is refused for anything but a full-time hire', async () => {
    // On a contract employment the same underlying column means the END OF THE CONTRACT, so accepting
    // it here would record a contract end date nobody typed.
    const e = await errorsFor({ employment_type: 'contract', probation_end_date: '2026-07-01' });
    expect(e).toMatch(/probation_end_date applies to full_time employees only/);
  });

  it('a date before the hire date is refused', async () => {
    expect(await errorsFor({ confirmation_date: '2026-01-01' })).toMatch(
      /confirmation_date must be on or after hired_on/,
    );
  });

  it('passport_issuing_country is checked against the NATIONALITY list, not the country list', async () => {
    // The Passport card's Issuing Country picker is fed from the tenant's NATIONALITY catalog
    // (app/admin/personnel/[employmentId]/page.tsx → IdentityFields `countryOptions`), so the value the
    // product itself stores in this column is a demonym — "Malaysian", not "Malaysia". The separate
    // passport_issuing_country_code field carries the ISO code precisely because one is not derivable
    // from the other (e4b541c6). Checking this column against `country` inverted the whole rule: it
    // refused every value the card can produce and accepted values the card's dropdown never offers.
    //
    // BOTH catalogs are seeded on purpose. With only one configured the empty-catalog free-text
    // tolerance accepts anything, and the test would pass whichever list the importer consulted.
    await owner.db.insert(schema.profileOption).values([
      { tenantId: b.tenantId, category: 'nationality', value: 'Malaysian', label: 'Malaysian', sortOrder: 1 },
      { tenantId: b.tenantId, category: 'country', value: 'Malaysia', label: 'Malaysia', sortOrder: 1 },
    ]);
    expect(await errorsFor({ passport_issuing_country: 'Malaysian' }), 'the value the card stores').toBe('');
    expect(await errorsFor({ passport_issuing_country: 'Malaysia' }), 'a country NAME').toMatch(
      /"Malaysia" is not an active nationality option/,
    );

    // …and it reaches the column the card reads back, spelled the way the card spells it.
    const result = await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(NEW_HEADER, [newRow({ passport_issuing_country: 'Malaysian' })]),
    });
    expect(result.imported).toBe(1);
    const p = await personByEmail('faizal@acme.test');
    const [stat] = await owner.db
      .select()
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, p.id));
    expect(stat.passportIssuingCountry).toBe('Malaysian');
  });

  it('a value the catalog REFUSED contributes nothing — it never falls back to the raw cell', () => {
    // The three outcomes of a catalog-governed cell are kept apart because collapsing "blank" and
    // "refused" into one `undefined` made the payload builder fall back to the RAW cell for a value the
    // dry run had just rejected. Nothing wrote it — the row carried the error and was skipped at commit —
    // but a rejected value surviving in the payload, with only an unrelated guard between it and the
    // database, is the silently-wrong-field this whole item exists to prevent.
    const refused = classifyCatalogCell('Selangoor', (v) => v === 'Selangor');
    expect(refused).toEqual({ kind: 'refused', value: 'Selangoor' });
    expect(carriedProfileValue(refused, 'Selangoor'), 'a refused cell contributes NOTHING').toBeUndefined();

    expect(classifyCatalogCell('Selangor', (v) => v === 'Selangor')).toEqual({ kind: 'ok', value: 'Selangor' });
    expect(carriedProfileValue({ kind: 'ok', value: 'Selangor' }, 'Selangor')).toBe('Selangor');

    // A blank verdict and a column with no validator both fall through to the raw cell, which is how
    // every plain-text address column is carried.
    expect(classifyCatalogCell('  ', () => false)).toEqual({ kind: 'blank' });
    expect(carriedProfileValue({ kind: 'blank' }, '')).toBeUndefined();
    expect(carriedProfileValue(undefined, '88 Jalan Bukit')).toBe('88 Jalan Bukit');
  });

  it('a state that is not an active catalog option is refused, and a configured one is accepted', async () => {
    // With an EMPTY catalog the tenant has never configured the list and free text is accepted, exactly
    // as it is on the Personnel screens — so the catalog has to exist before the rule can bite.
    expect(await errorsFor({ state: 'Selangor' }), 'empty catalog ⇒ free text').toBe('');
    await owner.db
      .insert(schema.profileOption)
      .values({ tenantId: b.tenantId, category: 'state', value: 'Selangor', label: 'Selangor', sortOrder: 1 });
    expect(await errorsFor({ state: 'Selangor' })).toBe('');
    expect(await errorsFor({ state: 'Selangoor' })).toMatch(/is not an active state option/);
  });
});

describe('2983802f §4 · direct superior is a forward reference', () => {
  const twoRowHeader = 'full_name,email,department,hired_on,ic_number,basic_salary,employee_code,direct_superior';

  it('a manager further DOWN the file resolves — file order does not decide validity', async () => {
    const records = recs(twoRowHeader, [
      // A0002 reports to A0005, which is the row BELOW. Row-by-row resolution would fail this file.
      `Junior One,junior@acme.test,Finance,2026-05-01,${ic(31)},4000,A0002,A0005`,
      `Senior Two,senior@acme.test,Finance,2026-05-01,${ic(32)},9000,A0005,`,
    ]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.rows.flatMap((r) => r.errors)).toEqual([]);

    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(2);
    expect(result.superiorFailed).toEqual([]);

    const junior = await employmentByCode('A0002');
    const senior = await employmentByCode('A0005');
    const [line] = await owner.db
      .select()
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.subordinateEmploymentId, junior.id));
    expect(line.managerEmploymentId).toBe(senior.id);
    expect(line.lineType).toBe('administrative');
    expect(line.validFrom).toBe('2026-05-01');
  });

  it('a manager who is ALREADY employed resolves too, by Employee ID or by work email', async () => {
    await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(twoRowHeader, [`Existing Boss,boss@acme.test,Finance,2026-01-05,${ic(41)},12000,BOSS1,`]),
    });
    const byCode = await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(twoRowHeader, [`New Hire,newhire@acme.test,Finance,2026-06-01,${ic(42)},5000,NEW1,BOSS1`]),
    });
    expect(byCode.imported).toBe(1);
    const byEmail = await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(twoRowHeader, [
        `Other Hire,other@acme.test,Finance,2026-06-01,${ic(43)},5000,NEW2,boss@acme.test`,
      ]),
    });
    expect(byEmail.imported).toBe(1);

    const boss = await employmentByCode('BOSS1');
    for (const code of ['NEW1', 'NEW2']) {
      const sub = await employmentByCode(code);
      const [line] = await owner.db
        .select()
        .from(schema.reportingLine)
        .where(eq(schema.reportingLine.subordinateEmploymentId, sub.id));
      expect(line?.managerEmploymentId, code).toBe(boss.id);
    }
  });

  it('a superior nobody can find is a per-row error, not a silent drop', async () => {
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(twoRowHeader, [`Lost Soul,lost@acme.test,Finance,2026-05-01,${ic(33)},4000,A0003,NOBODY`]),
    });
    expect(preview.rows[0].errors.join(' | ')).toMatch(/Unknown direct_superior "NOBODY"/);
    expect(preview.validCount).toBe(0);
  });

  it('a manager whose ONLY fault is its own direct_superior still fails the subordinate, in the dry run', async () => {
    // Row 1's manager is row 2, and row 2's only fault is its own direct_superior cell. That error is
    // added by the SAME pass that decides row 1 — so reading the manager's `ok` flag mid-pass read a
    // flag not yet re-derived, previewed row 1 as Ready to Import, created the person with NO manager,
    // and reported the miss only after the write. The point of a preview is that this is seen first.
    const records = recs(twoRowHeader, [
      `Ali Baba,ali@acme.test,Finance,2026-05-01,${ic(60)},4000,S1,S2`,
      `Bala Krishnan,bala@acme.test,Finance,2026-05-01,${ic(61)},4000,S2,NOBODY`,
    ]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.rows[1].errors.join(' | ')).toMatch(/Unknown direct_superior "NOBODY"/);
    expect(preview.rows[0].ok, 'row 1 must not be previewed as ready to import').toBe(false);
    expect(preview.rows[0].errors.join(' | ')).toMatch(
      /direct_superior "S2" is on row 2 of this file, which has errors/,
    );
    expect(preview.validCount).toBe(0);

    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(0);
    // Nothing was created, so there is nothing to report AFTER the write — which is the whole change:
    // the miss moved from `superiorFailed` (too late) into the preview (still fixable).
    expect(result.superiorFailed).toEqual([]);
  });

  it('the refusal is transitive — a chain of three fails all the way up the file', async () => {
    // C is refused on its own account, so B (who reports to C) has nothing to point at, so A (who
    // reports to B) has nothing either. One pass in file order can only ever see one link of that.
    const records = recs(twoRowHeader, [
      `Top Level,top@acme.test,Finance,2026-05-01,${ic(62)},4000,T1,T2`,
      `Middle One,middle@acme.test,Finance,2026-05-01,${ic(63)},4000,T2,T3`,
      `Bottom Bad,bottom@acme.test,NoSuchDept,2026-05-01,${ic(64)},4000,T3,`,
    ]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.rows[2].errors.join(' | '), 'row 3 fails on its own department').toMatch(/NoSuchDept/);
    expect(preview.rows[1].errors.join(' | ')).toMatch(/is on row 3 of this file, which has errors/);
    expect(preview.rows[0].errors.join(' | ')).toMatch(/is on row 2 of this file, which has errors/);
    expect(preview.validCount, 'all three rows are refused').toBe(0);
  });

  it('a row that names itself, and a pair that name each other, are both refused', async () => {
    const self = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(twoRowHeader, [`Me Myself,me@acme.test,Finance,2026-05-01,${ic(34)},4000,A0004,A0004`]),
    });
    expect(self.rows[0].errors.join(' | ')).toMatch(/cannot be the employee themselves/);

    const loop = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(twoRowHeader, [
        `Ping,ping@acme.test,Finance,2026-05-01,${ic(35)},4000,P1,P2`,
        `Pong,pong@acme.test,Finance,2026-05-01,${ic(36)},4000,P2,P1`,
      ]),
    });
    expect(loop.rows.flatMap((r) => r.errors).join(' | ')).toMatch(/reporting cycle/);
    // Refused in the DRY RUN, which is the point: a cycle caught at write time leaves half the pair created.
    expect(loop.validCount).toBe(0);
  });
});

describe('2983802f §5 · the family sheet', () => {
  const empHeader = 'full_name,email,department,hired_on,ic_number,basic_salary,employee_code';
  const famHeader = 'employee_code,full_name,relationship,date_of_birth,gender,ic_or_passport,passport_number,phone,is_beneficiary,remarks';

  const employees = () =>
    recs(empHeader, [
      `Parent One,parent@acme.test,Finance,2026-02-02,${ic(51)},7000,F0001`,
      `Other Staff,other2@acme.test,Finance,2026-02-02,${ic(52)},5000,F0002`,
    ]);

  it('one employee can carry SEVERAL family members — the shape flat columns could not express', async () => {
    const family = recs(famHeader, [
      'F0001,Nurul Huda,spouse,1988-05-06,female,,,+60 12-345 6789,yes,',
      'F0001,Aiman,child,2015-02-11,male,,,,no,',
      'F0001,Alia,child,2019-09-30,female,,,,no,',
    ]);
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: employees(),
      dependentRecords: family,
    });
    expect(preview.fileErrors).toEqual([]);
    expect(preview.dependents.total).toBe(3);
    expect(preview.dependents.validCount).toBe(3);

    const result = await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: employees(),
      dependentRecords: family,
    });
    expect(result.imported).toBe(2);
    expect(result.dependentsImported).toBe(3);

    const p = await personByEmail('parent@acme.test');
    const rows = await owner.db
      .select()
      .from(schema.employeeDependent)
      .where(eq(schema.employeeDependent.personId, p.id));
    expect(rows).toHaveLength(3);
    const spouse = rows.find((r) => r.relationship === 'spouse')!;
    expect(spouse.fullName).toBe('Nurul Huda');
    expect(spouse.dateOfBirth).toBe('1988-05-06');
    expect(spouse.gender).toBe('female');
    expect(spouse.isBeneficiary).toBe(true);
    // Blank means NO here, unlike the employee sheet's default-true statutory flags.
    expect(rows.filter((r) => r.relationship === 'child').every((r) => r.isBeneficiary === false)).toBe(true);
  });

  it('AN EMPLOYEE ID THE EMPLOYEE SHEET DOES NOT CARRY REJECTS THE WHOLE FILE — nothing is written', async () => {
    // The decision the plan asked to be made and documented. The alternative (import the employees and
    // drop the orphan family row) leaves a workforce loaded with a silent hole in it.
    const family = recs(famHeader, [
      'F0001,Nurul Huda,spouse,1988-05-06,female,,,,yes,',
      'F9999,Ghost Child,child,2015-02-11,male,,,,no,',
    ]);
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: employees(),
      dependentRecords: family,
    });
    expect(preview.fileErrors.join(' | ')).toMatch(/"F9999", which is not on the employee sheet/);
    // The EMPLOYEE rows are individually fine — this is a file-level refusal, not a row-level one, and
    // the distinction is the whole reason `fileErrors` exists.
    expect(preview.validCount).toBe(2);
    expect(preview.rows.flatMap((r) => r.errors)).toEqual([]);

    const result = await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: employees(),
      dependentRecords: family,
    });
    expect(result.imported, 'not one employee may be created').toBe(0);
    expect(result.dependentsImported).toBe(0);
    expect(result.fileErrors.length).toBeGreaterThan(0);
    // And the database agrees — no half-import behind a zero count.
    const people = await owner.db
      .select()
      .from(schema.person)
      .where(eq(schema.person.tenantId, b.tenantId));
    expect(people).toHaveLength(0);
    const deps = await owner.db
      .select()
      .from(schema.employeeDependent)
      .where(eq(schema.employeeDependent.tenantId, b.tenantId));
    expect(deps).toHaveLength(0);
  });

  it('an invalid family row rejects the file too — a skipped family member is invisible', async () => {
    const family = recs(famHeader, ['F0001,Nurul Huda,cousin-in-law,1988-05-06,female,,,,yes,']);
    const result = await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: employees(),
      dependentRecords: family,
    });
    expect(result.imported).toBe(0);
    expect(result.fileErrors.join(' | ')).toMatch(/Family sheet/);
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: employees(),
      dependentRecords: family,
    });
    expect(preview.dependents.rows[0].errors.join(' | ')).toMatch(/Unknown relationship "cousin-in-law"/);
  });

  it('a family member of an employee row that itself has errors rejects the file', async () => {
    // The employee will not be created, so the family row has nobody to belong to. Skipping it quietly
    // is the same invisible hole as an unmatched Employee ID.
    const broken = recs(empHeader, [`No Email,,Finance,2026-02-02,${ic(53)},7000,F0001`]);
    const family = recs(famHeader, ['F0001,Nurul Huda,spouse,1988-05-06,female,,,,yes,']);
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: broken,
      dependentRecords: family,
    });
    expect(preview.dependents.rows[0].errors.join(' | ')).toMatch(/has errors, so this family member/);
    expect(preview.fileErrors.length).toBeGreaterThan(0);
  });

  it('a file with no family sheet behaves exactly as it always did', async () => {
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records: employees() });
    expect(result.imported).toBe(2);
    expect(result.dependentsImported).toBe(0);
    expect(result.fileErrors).toEqual([]);
  });
});
