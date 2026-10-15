/**
 * r369 (item eb949191) — THE CONFIRMATION GESTURE SURVIVES THE IMPORT PATH.
 *
 * eb949191 made a zero or blank Basic Salary legal: a Director paid quarterly Director Fees has no
 * monthly basic, so refusing the zero forced HR to invent a figure, and paying them instead nets a
 * payslip BELOW ZERO. What `core/comp.ts` kept of the refusal we originally proposed is one condition —
 * a zero-basic monthly record needs `compensation.remarks` saying why (`SalaryRemarkRequiredError`).
 * That sentence is the only thing that distinguishes a deliberate zero from a mistyped one, months
 * before any payroll run reads either, and the kernel never reads it to decide money.
 *
 * THE GAP THIS FILE PINS. The employee importer had no column for that reason. The row therefore
 * validated (0 is a non-negative number) and then threw at COMMIT, so the reporter's own Director —
 * onboarded by file, like the rest of their workforce — failed on a refusal the file could not answer.
 * The fix is a column, not a relaxation, and the three properties below are what "not a relaxation"
 * has to mean:
 *
 *   §2  a zero-basic row WITH a reason imports, and the reason is ON the compensation row afterwards.
 *   §3  a zero-basic row WITHOUT a reason still fails, names the column to fill, and writes NOTHING —
 *       and no default reason is invented on the operator's behalf anywhere.
 *   §4  A FILE WITH NO SUCH COLUMN AT ALL imports every row exactly as it did before r369. This is the
 *       property most worth a test: every customer's saved spreadsheet predates the column.
 *
 * §1 is the contract and the handed-out template, which are pure and need no database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { commitEmployeeImport, validateEmployeeImport } from '../core/import';
import { IMPORT_COLUMNS } from '../lib/import-schema';
import { missingByTab } from '../lib/employee-draft-schema';
import { buildTemplateCsv, employeeTemplate } from '../lib/import-template';
import { UNSECTIONED_COLUMNS, foreignColumns } from '../lib/import-sections';
import { employeeColumnLabel, EMPLOYEE_XLSX_COLUMNS } from '../lib/import-template-xlsx';
import { parseCsvRecords } from '../lib/csv';
import {parsePersonnelImportCsv} from '../lib/personnel-import-contract';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const COLUMN = 'salary_remarks';

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

/** Records from a header line + data lines, exactly as the screen's CSV path builds them. */
const recs = (header: string, rows: string[]) => parseCsvRecords(`${header}\n${rows.join('\n')}`).records;

/** A distinct valid 12-digit MyKad per row so nothing collides with the seed or with a sibling row. */
const ic = (n: number) => `7${String(n).padStart(2, '0')}0214${String(n).padStart(2, '0')}6521`.slice(0, 12);

/** The employment's OPEN compensation row — the one every reader of current pay resolves. */
async function openComp(employeeCode: string) {
  const [emp] = await owner.db
    .select()
    .from(schema.employment)
    .where(and(eq(schema.employment.tenantId, b.tenantId), eq(schema.employment.employeeCode, employeeCode)));
  if (!emp) return null;
  const [row] = await owner.db
    .select()
    .from(schema.compensation)
    .where(
      and(
        eq(schema.compensation.tenantId, b.tenantId),
        eq(schema.compensation.employmentId, emp.id),
        isNull(schema.compensation.validTo),
        isNull(schema.compensation.supersededAt),
      ),
    );
  return row ?? null;
}

async function personByEmail(email: string) {
  const [row] = await owner.db
    .select()
    .from(schema.person)
    .where(and(eq(schema.person.tenantId, b.tenantId), eq(schema.person.primaryEmail, email)));
  return row ?? null;
}

// ═════════════════════════ §1 · the contract and the template we hand out ═════════════════════════

describe('r369 §1 · the column is in the contract, on the template, and OPTIONAL', () => {
  it('is an OPTIONAL column, never a required one', () => {
    expect(IMPORT_COLUMNS.optional).toContain(COLUMN);
    expect(IMPORT_COLUMNS.required).not.toContain(COLUMN);
  });

  it('the downloadable CSV template carries it, and leaves it BLANK on every sample row', () => {
    // Blank sample cells are the template's own demonstration that a row with a basic salary is not
    // made to carry a reason. A sample row that filled it in would teach the opposite.
    const { headers, records } = parsePersonnelImportCsv(buildTemplateCsv(employeeTemplate),{columns:[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional]});
    expect(headers).toContain(COLUMN);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(Number(r.basic_salary), 'every sample row has a positive basic').toBeGreaterThan(0);
      expect(r[COLUMN], 'so no sample row needs a reason').toBe('');
    }
  });

  it('the .xlsx heading resolves through the actual Personnel header contract', () => {
    const label=employeeColumnLabel(COLUMN);
    const parsed=parsePersonnelImportCsv('"'+label.replaceAll('"','""')+'"\nReason',{columns:[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional]});
    expect(parsed.headers).toEqual([COLUMN]);expect(parsed.records[0][COLUMN]).toBe('Reason');
    expect(EMPLOYEE_XLSX_COLUMNS).toContain(COLUMN);
  });

  it('no section import owns it, and it says why (the rule every wide-template column obeys)', () => {
    // test/import-sections.test.ts demands that sections + UNSECTIONED_COLUMNS account for every
    // main-sheet column; this is the half of that claim specific to this column.
    expect(UNSECTIONED_COLUMNS[COLUMN]).toBeTruthy();
    // And it is RECOGNISED, so pasting it into a narrow section file is refused rather than ignored.
    expect(foreignColumns('profile', [COLUMN])).toContain(COLUMN);
  });
});

// ════════════ §2 · (a) a zero-basic row WITH a reason imports, and carries the reason ═════════════

const HEADER = `full_name,email,department,hired_on,ic_number,basic_salary,employee_code,employment_type,${COLUMN}`;

const DIRECTOR_REASON = "paid by quarterly director's fees";

describe('r369 §2 · a zero-basic row WITH a reason imports', () => {
  const row = (over: Partial<Record<string, string>> = {}) =>
    [
      over.full_name ?? 'Tan Wei Ling',
      over.email ?? 'director@acme.test',
      over.department ?? 'Finance',
      over.hired_on ?? '2026-01-06',
      over.ic_number ?? ic(41),
      over.basic_salary ?? '0',
      over.employee_code ?? 'DIR0001',
      over.employment_type ?? 'full_time',
      over[COLUMN] ?? DIRECTOR_REASON,
    ].join(',');

  it('the DRY RUN accepts it', async () => {
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records: recs(HEADER, [row()]) });
    expect(preview.rows[0].errors, 'a stated reason is the whole condition').toEqual([]);
    expect(preview.validCount).toBe(1);
  });

  it('it imports, and the REASON IS ON THE COMPENSATION ROW — read from the database, not the preview', async () => {
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records: recs(HEADER, [row()]) });
    expect(result.failed, 'nothing may throw at commit either').toEqual([]);
    expect(result.imported).toBe(1);

    const comp = await openComp('DIR0001');
    expect(comp, 'the import must have written an open salary record').toBeTruthy();
    // The zero really is stored as a zero — the point of the item is that it is not invented away.
    expect(comp!.basicSalary).toBe('0.00');
    // …and the confirmation gesture travelled all the way from the spreadsheet cell to the record.
    expect(comp!.remarks).toBe(DIRECTOR_REASON);
  });

  it.each(['', '   '])('a blank basic_salary (%j) with a reason follows the Draft rule and stores an explicit zero', async basic => {
    // r374/item 7dbaf677 deliberately made the initial amount optional. c445 shares that form rule
    // with the import; blank is an explicit zero, never a fabricated positive wage or numeric NaN.
    expect(IMPORT_COLUMNS.required).not.toContain('basic_salary');
    expect(IMPORT_COLUMNS.optional).toContain('basic_salary');
    expect(missingByTab({ payroll: { basicSalary: basic, remarks: DIRECTOR_REASON } }).payroll).toEqual([]);
    const records = recs(HEADER, [row({ basic_salary: basic, email: 'blank@acme.test', employee_code: 'DIR0009' })]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.validCount).toBe(1);
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(1);expect(result.failed).toEqual([]);
    expect(await personByEmail('blank@acme.test')).toBeTruthy();
    expect(await openComp('DIR0009')).toMatchObject({ basicSalary: '0.00', remarks: DIRECTOR_REASON });
  });

  it('a blank basic_salary without a reason is refused before any employee or salary is written', async () => {
    expect(missingByTab({ payroll: { basicSalary: '' } }).payroll).toEqual(['remarks']);
    const records = recs(HEADER, [row({ basic_salary: '', email: 'blank-unconfirmed@acme.test', employee_code: 'DIR0010', [COLUMN]: '' })]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.validCount).toBe(0);expect(preview.rows[0].errors.join(' | ')).toContain(COLUMN);
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(0);expect(result.skipped).toBe(1);expect(result.failed).toEqual([]);
    expect(await personByEmail('blank-unconfirmed@acme.test')).toBeNull();
    expect(await openComp('DIR0010')).toBeNull();
  });

  it.each(['-1', 'not-a-number'])('a supplied invalid basic_salary %j stays refused even with a reason', async basic => {
    const records = recs(HEADER, [row({ basic_salary: basic, email: 'invalid-basic@acme.test', employee_code: 'DIR0011' })]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.validCount).toBe(0);expect(preview.rows[0].errors.join(' | ')).toContain('Invalid basic_salary');
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(0);expect(result.skipped).toBe(1);
    expect(await personByEmail('invalid-basic@acme.test')).toBeNull();expect(await openComp('DIR0011')).toBeNull();
  });

  it('a daily worker with a zero basic and a real RATE needs no reason (the OTHER leg is untouched)', async () => {
    // `unpayableSalaryLeg` splits the two legs: for daily/hourly the RATE is what pays, so a zero
    // monthly-equivalent basic asks nothing of the operator. Widening the rule to every pay mode would
    // have been the easy mistake.
    const dailyHeader = `${HEADER},pay_mode,rate_amount`;
    const records = recs(dailyHeader, [
      `${row({ email: 'daily@acme.test', employee_code: 'DAI0001', ic_number: ic(42), [COLUMN]: '' })},daily,180`,
    ]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.rows[0].errors).toEqual([]);
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(1);
    expect((await openComp('DAI0001'))!.remarks, 'and no reason is invented for them').toBeNull();
  });
});

// ═════ §3 · (b) a zero-basic row WITHOUT a reason still fails, and nothing is written for it ══════

describe('r369 §3 · a zero-basic row WITHOUT a reason is still refused', () => {
  const noReason = ['Lim Mei Chen', 'noreason@acme.test', 'Finance', '2026-01-06', ic(43), '0', 'NOR0001', 'full_time', ''].join(',');
  const good = ['Aisyah Rahman', 'paid@acme.test', 'Operations', '2026-01-06', ic(44), '4200', 'OK00001', 'full_time', ''].join(',');

  it('the DRY RUN fails that row, and the message NAMES THE COLUMN to fill', async () => {
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records: recs(HEADER, [noReason]) });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.validCount).toBe(0);
    const msg = preview.rows[0].errors.join(' | ');
    // An operator reading this in the error report has to know WHICH cell to type in.
    expect(msg).toContain(COLUMN);
    expect(msg).toContain('basic_salary is 0');
  });

  it('it is refused BEFORE anything is written — no person, no employment, no salary record', async () => {
    // "Fails the row" has to mean the row left no trace. A refusal that happened after hireEmployee
    // would leave a person in the system with no pay, which is worse than either outcome.
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records: recs(HEADER, [noReason]) });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await personByEmail('noreason@acme.test')).toBeNull();
    expect(await openComp('NOR0001')).toBeNull();
  });

  it('it never imports SILENTLY — a zero-basic row with no reason cannot end up with a NULL remark', async () => {
    // The failure mode this pins is the tempting "fix": let the row through and store NULL. That would
    // make a mistyped zero and a deliberate one identical on the record for ever.
    await commitEmployeeImport(a, { companyId: b.companyId, records: recs(HEADER, [noReason]) });
    const rows = await owner.db
      .select()
      .from(schema.compensation)
      .where(and(eq(schema.compensation.tenantId, b.tenantId), eq(schema.compensation.basicSalary, '0.00')));
    expect(rows, 'no zero-basic salary record may exist from that row at all').toEqual([]);
  });

  it('NO DEFAULT REASON is supplied anywhere — nothing the system wrote counts as a confirmation', async () => {
    // If the importer invented a remark the row would IMPORT, and `imported` would be 1. Asserting the
    // refusal and asserting "no default" are therefore the same assertion, said from the other side.
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records: recs(HEADER, [noReason]) });
    expect(result.imported).toBe(0);
    expect(result.failed.concat(result.superiorFailed)).toEqual([]);
  });

  it('only THAT row fails — the rest of the file still imports', async () => {
    // Per-row, not per-file: a day-one migration wants maximum rows in. One Director somebody forgot to
    // explain must not strand three hundred colleagues.
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: recs(HEADER, [noReason, good]),
    });
    expect(preview.total).toBe(2);
    expect(preview.validCount).toBe(1);
    expect(preview.fileErrors, 'this is a row problem, never a whole-file refusal').toEqual([]);

    const result = await commitEmployeeImport(a, { companyId: b.companyId, records: recs(HEADER, [noReason, good]) });
    expect(result.imported).toBe(1);
    expect(await personByEmail('paid@acme.test')).toBeTruthy();
    expect(await personByEmail('noreason@acme.test')).toBeNull();
  });
});

// ══════════ §4 · (c) BACKWARD COMPATIBILITY — a file with no such column at all is unchanged ══════════

describe('r369 §4 · an existing file with NO salary_remarks column imports every row unchanged', () => {
  /**
   * The exact contract as it stood BEFORE r369 — 6 required + 43 optional — written out BY HAND. It is
   * deliberately not derived from `IMPORT_COLUMNS`: a derived list would silently follow this change and
   * assert nothing at all, and what needs pinning is the shape of a spreadsheet a customer saved last
   * month and will upload next month.
   */
  const LEGACY_HEADER = [
    'full_name', 'email', 'department', 'hired_on', 'ic_number', 'basic_salary',
    'company', 'employee_code', 'phone', 'position', 'cost_center', 'employment_type',
    'monthly_allowance', 'bank_name', 'bank_account_no', 'epf_number', 'socso_number', 'tax_number',
    'tax_category', 'num_children', 'eis_eligible', 'is_resident', 'epf_citizenship',
    'pay_mode', 'payment_term', 'rate_amount',
    'passport_number', 'passport_issue_date', 'passport_expiry_date', 'passport_issuing_country',
    'address_line_1', 'address_line_2', 'address_line_3', 'postcode', 'city', 'state', 'country',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone',
    'emergency_contact_home_phone', 'emergency_contact_address',
    'probation_end_date', 'probation_months', 'probation_days', 'confirmation_date',
    'resignation_notice_months', 'resignation_notice_days', 'direct_superior',
  ].join(',');

  const legacyRow = (name: string, email: string, code: string, icNum: string, basic: string, dept = 'Finance') =>
    [
      name, email, dept, '2026-02-03', icNum, basic,
      '', code, '+60 12-345 6789', '', '', 'full_time',
      '300', 'Maybank', '514012345678', '', '', '',
      '2', '0', 'true', 'true', 'MALAYSIAN',
      'monthly', 'monthly', '',
      '', '', '', '',
      '', '', '', '', '', '', '',
      '', '', '', '', '',
      '', '', '', '',
      '', '', '',
    ].join(',');

  it('the legacy header really does NOT carry the new column (or this whole section proves nothing)', () => {
    expect(LEGACY_HEADER.split(',')).not.toContain(COLUMN);
    // Keep the historical 49-column file literal: c445 expands today's template rather than changing
    // what a previously downloaded file contained. Every old column remains recognised and every
    // currently mandatory column is present; actual legacy writes are verified below.
    const legacy = LEGACY_HEADER.split(','), current = [...IMPORT_COLUMNS.required, ...IMPORT_COLUMNS.optional];
    expect(legacy).toHaveLength(49);
    expect(legacy.filter(column => !current.includes(column))).toEqual([]);
    expect(IMPORT_COLUMNS.required.filter(column => !legacy.includes(column))).toEqual([]);
    expect(parsePersonnelImportCsv(LEGACY_HEADER, { columns: current }).headers).toEqual(legacy);
  });

  it('every row of a three-row legacy file validates clean and imports', async () => {
    const records = recs(LEGACY_HEADER, [
      legacyRow('Nadia Yusof', 'nadia.legacy@acme.test', 'LEG0001', ic(51), '5200'),
      legacyRow('Ravi Chandran', 'ravi.legacy@acme.test', 'LEG0002', ic(52), '9800', 'Operations'),
      legacyRow('Siti Aminah', 'siti.legacy@acme.test', 'LEG0003', ic(53), '4100', 'Operations'),
    ]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    for (const r of preview.rows) {
      expect(r.errors, `row ${r.rowNum} of a file that imported before r369 must still import`).toEqual([]);
    }
    expect(preview.validCount).toBe(3);
    // The absent column may never be reported as missing — `missingColumns` is the REQUIRED ones a file
    // lacks, and an optional column appearing there would block a legitimate upload.
    expect(preview.missingColumns).toEqual([]);
    expect(preview.missingColumns).not.toContain(COLUMN);

    const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
    expect(result.imported).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it('the salary records it writes are byte-identical to the pre-r369 write: remarks NULL', async () => {
    // The service stores an omitted remark as NULL and logs no `remarks` field change, so "unchanged"
    // is checkable on the row itself rather than argued from the call site.
    const records = recs(LEGACY_HEADER, [legacyRow('Nadia Yusof', 'nadia.legacy@acme.test', 'LEG0001', ic(51), '5200')]);
    await commitEmployeeImport(a, { companyId: b.companyId, records });
    const comp = await openComp('LEG0001');
    expect(comp!.basicSalary).toBe('5200.00');
    expect(comp!.monthlyAllowance).toBe('300.00');
    expect(comp!.payMode).toBe('monthly');
    expect(comp!.remarks, 'an absent column writes NULL, exactly as before the column existed').toBeNull();
  });

  it('the compensation.set event records NO remarks change for a legacy row', async () => {
    // `fieldsChanged` is what the audit trail shows. A file that never mentioned remarks must not make
    // the log claim somebody set one.
    const records = recs(LEGACY_HEADER, [legacyRow('Nadia Yusof', 'nadia.legacy@acme.test', 'LEG0001', ic(51), '5200')]);
    await commitEmployeeImport(a, { companyId: b.companyId, records });
    const comp = await openComp('LEG0001');
    const [ev] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.aggregateId, comp!.id)));
    expect(ev, 'the import must have appended a compensation event').toBeTruthy();
    expect((ev.payload as { fieldsChanged: string[] }).fieldsChanged).not.toContain('remarks');
  });

  it('a legacy file whose basic salary is 0 fails THAT row and names the column it has no way to carry', async () => {
    // The honest edge of backward compatibility: before r369 such a row imported and then blocked the
    // whole company's payroll run. It is refused now, which is better, and the error tells the operator
    // the one thing they need — which column to add to their file.
    const records = recs(LEGACY_HEADER, [legacyRow('Old Director', 'olddir@acme.test', 'LEG0004', ic(54), '0')]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' | ')).toContain(COLUMN);
  });
});
