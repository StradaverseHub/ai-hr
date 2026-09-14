/**
 * EVERY FIELD A DRAFT CAN HOLD SURVIVES ACTIVATE — item 759dfc7d.
 *
 * THE FAILURE THIS FILE EXISTS AGAINST IS SILENT. The reporter's sentence is "the system should retain
 * all information already entered during Draft status and should not require the administrator to
 * re-enter the information", and the way that promise breaks is never loud: a field is added to the draft
 * screen, nobody adds it to the activation path, and HR types a SOCSO category for months before
 * somebody notices every employee created this way is on the default one. Nothing throws. Nothing turns
 * red. The draft row is deleted at Activate, so the evidence is gone too.
 *
 * SO THIS IS NOT A SPOT CHECK, AND IT IS NOT A HAND-WRITTEN LIST EITHER. §1 reads the draft's own TYPE
 * DECLARATIONS out of lib/employee-draft-schema.ts and requires every property to appear in `LANDS`
 * below — a table that says, for each field, WHERE it ends up. A field added to the type without being
 * added there fails immediately, in a test whose message tells you what to do. §2 then activates a draft
 * with EVERY field set to its own distinct value and reads each landing back out of the database.
 *
 * WHY DISTINCT VALUES EVERYWHERE. Two fields sharing a value is how a mapping that crosses them over
 * still passes — the swap is invisible when both sides read '1'. Every string here is unique.
 *
 * WHAT IS DELIBERATELY NOT HERE: the family list. `EmployeeDraftFamilyMember` has twenty-six fields of
 * its own and test/employee-draft-family.test.ts §2/§3 already walks the dependent writer's shape
 * against it and asserts the round trip column by column. §1 asserts the family LIST lands rather than
 * re-deriving that work here; duplicating it would give two places to update and one of them would rot.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { DRAFT_PERIOD_UNITS, type EmployeeDraftData } from '../lib/employee-draft-schema';
import { completeEmployeeDraft, saveEmployeeDraft } from '../core/employee-draft';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

let b: Base;
/** Two things `seedBase` does not provide and two draft fields need somewhere to land. */
let gradeId: string;
let managerEmploymentId: string;

/**
 * WHERE EVERY DRAFT FIELD ENDS UP. `null` means "does not land, and here is why" — the two entries that
 * carry one are not oversights and each says what it does instead.
 *
 * This table is the contract §1 enforces and §2 exercises. Adding a field to `EmployeeDraftProfile`,
 * `EmployeeDraftEmployment`, `EmployeeDraftStatutory` or `EmployeeDraftPayroll` without adding it here
 * fails §1 — which is the whole point, because the alternative is that it silently goes nowhere.
 */
const LANDS: Record<string, Record<string, string | null>> = {
  EmployeeDraftProfile: {
    fullName: 'person.full_name',
    employeeCode: 'employment.employee_code',
    // A UI pick, not a value: it decides WHICH id path runs (a typed code, or the running number). It is
    // exercised in §2 — the employee below carries the hand-keyed code that this mode selects — and there
    // is no column for it because storing a remembered radio choice on a person would mean nothing.
    employeeIdMode: null,
    primaryEmail: 'person.primary_email',
    phone: 'person.phone',
    gender: 'person.gender',
    dateOfBirth: 'person.date_of_birth',
    maritalStatus: 'person.marital_status',
    nationality: 'person.nationality',
    icNumber: 'employee_statutory_my.ic_number',
    // ── item a72610af ────────────────────────────────────────────────────────────────────────────
    // The profile fields land through `updatePerson` — the writer the Personnel Profile tab saves
    // through and the one `commitEmployeeImport` already uses. `completeEmployeeDraft` calls it only
    // when the draft carries at least one of them, so a draft written before this item produces a
    // byte-identical employee and no spurious `person.updated` event.
    salutation: 'person.salutation',
    firstName: 'person.first_name',
    lastName: 'person.last_name',
    preferredName: 'person.preferred_name',
    religion: 'person.religion',
    race: 'person.race',
    homePhone: 'person.home_phone',
    personalEmail: 'person.personal_email',
    // The passport block lands through the company pack's `setPassport`, called only when the draft
    // carries one — calling it unconditionally would make a non-Malaysian's passport MANDATORY and the
    // wizard stricter than `hireEmployee` and the bulk importer.
    passportNumber: 'employee_statutory_my.passport_number',
    passportIssueDate: 'employee_statutory_my.passport_issue_date',
    passportExpiryDate: 'employee_statutory_my.passport_expiry_date',
    passportIssuingCountry: 'employee_statutory_my.passport_issuing_country',
    passportIssuingCountryCode: 'employee_statutory_my.passport_issuing_country_code',
    passportRemark: 'employee_statutory_my.passport_remark',
  },
  EmployeeDraftEmployment: {
    companyId: 'employment.company_id',
    departmentId: 'assignment.department_id',
    positionId: 'assignment.position_id',
    costCenterId: 'assignment.cost_center_id',
    gradeId: 'employment.grade_id',
    reportingManagerEmploymentId: 'reporting_line.manager_employment_id',
    employmentType: 'assignment.employment_type',
    hiredOn: 'employment.hired_on',
    provisionalEndOn: 'employment.provisional_end_on',
    // ── item a72610af ────────────────────────────────────────────────────────────────────────────
    // NONE of these reaches `hireEmployee` — `HireParams` accepts not one of them. They are `employment`
    // columns whose writer is `setEmploymentInfo`, which `completeEmployeeDraft` now calls after the hire,
    // exactly as `commitEmployeeImport` has since item 2983802f.
    probationValue: 'employment.probation_value',
    probationUnit: 'employment.probation_unit',
    extendedProbationValue: 'employment.extended_probation_value',
    extendedProbationUnit: 'employment.extended_probation_unit',
    confirmationDate: 'employment.confirmation_date',
    noticeBeforeConfirmationValue: 'employment.notice_before_confirmation_value',
    noticeBeforeConfirmationUnit: 'employment.notice_before_confirmation_unit',
    noticeAfterConfirmationValue: 'employment.notice_after_confirmation_value',
    noticeAfterConfirmationUnit: 'employment.notice_after_confirmation_unit',
  },
  EmployeeDraftStatutory: {
    bankName: 'employee_statutory_my.bank_name',
    bankAccountNo: 'employee_statutory_my.bank_account_no',
    epfNumber: 'employee_statutory_my.epf_number',
    socsoNumber: 'employee_statutory_my.socso_number',
    taxNumber: 'employee_statutory_my.tax_number',
    taxCategory: 'employee_statutory_my.tax_category',
    numChildren: 'employee_statutory_my.num_children',
    socsoCategory: 'employee_statutory_my.socso_category',
    eisCategory: 'employee_statutory_my.eis_category',
    // LEGACY, and it lands INDIRECTLY — a draft written before 35b7af0a group 7 carries the old
    // yes/no and `completeEmployeeDraft` maps 'no' forward onto eis_category 'none'. §2 has its own
    // case for it, because a legacy draft is exactly the row that cannot be re-typed.
    eisEligible: 'employee_statutory_my.eis_category (mapped forward)',
    isResident: 'employee_statutory_my.is_resident',
    epfCitizenship: 'employee_statutory_my.epf_citizenship',
    // ── item a72610af ────────────────────────────────────────────────────────────────────────────
    // The EPF CATEGORY is the five-name UI value; `mapEpfUiMode` turns it into one of the three lawful
    // KWSP enum values at the server boundary, exactly as the Personnel statutory action does. The two
    // elected rates are NOT collected on a draft (a below-floor rate would throw inside a writer that
    // can only run after the employee exists) — see EmployeeDraftStatutory.epfMode.
    epfMode: 'employee_statutory_my.epf_mode (mapped through mapEpfUiMode)',
    employerBearsEpf: 'employee_statutory_my.employer_bears_epf',
    employerBearsSocso: 'employee_statutory_my.employer_bears_socso',
    employerBearsEis: 'employee_statutory_my.employer_bears_eis',
    employerBearsSkbbk: 'employee_statutory_my.employer_bears_skbbk',
    // These three belong to the TAX writer, not the statutory one, so they land through `pack.setTax`
    // AFTER `pack.statutory.set` — that setter is a total overwrite of the tax columns, so the order and
    // the pass-through are both load-bearing.
    disabledIndividual: 'employee_statutory_my.disabled_individual',
    disabledSpouse: 'employee_statutory_my.disabled_spouse',
    childReliefMode: 'employee_statutory_my.child_relief_mode',
    // The training levy switch has its own partial-save writer, and its ABSENT state is meaningful
    // ("follow the company's HRDF registration default"), so an absent value is not written at all.
    subjectToHrdf: 'employee_statutory_my.subject_to_hrdf',
  },
  EmployeeDraftPayroll: {
    basicSalary: 'compensation.basic_salary',
    monthlyAllowance: 'compensation.monthly_allowance',
    payMode: 'compensation.pay_mode',
    paymentTerm: 'compensation.payment_term',
    rateAmount: 'compensation.rate_amount',
    remarks: 'compensation.remarks',
  },
};

/** The property names declared on one exported type, read from the source rather than from a copy. */
function fieldsOf(typeName: string): string[] {
  const src = read('lib/employee-draft-schema.ts');
  const start = src.indexOf(`export type ${typeName} = {`);
  expect(start, `${typeName} not found — has the schema been restructured?`).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n};', start));
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
}

/** A draft with EVERY field of every section set, each to its own recognisable value. */
function everyField(): EmployeeDraftData {
  const tag = randomUUID().slice(0, 8);
  return {
    profile: {
      fullName: 'Nadia Yusof',
      // Hand-keyed, which is what `employeeIdMode: 'manual'` selects. seedBase configures no Employee ID
      // Auto Running Number Setup, so manual is forced AND permitted — the situation eight of the nine
      // live companies are in.
      employeeCode: `SUR${tag.toUpperCase()}`,
      employeeIdMode: 'manual',
      primaryEmail: `nadia.${tag}@survival.test`,
      phone: '+60 19-876 5432',
      gender: 'female',
      dateOfBirth: '1988-07-21',
      maritalStatus: 'married',
      nationality: 'Malaysian',
      icNumber: '880721-10-5566',
      // item a72610af — the profile fields, each its own recognisable value.
      salutation: 'Puan',
      firstName: 'Nadia',
      lastName: 'Yusof',
      preferredName: 'Nad',
      religion: 'Islam',
      race: 'Malay',
      homePhone: '+60 3-2222 3333',
      personalEmail: `nadia.personal.${tag}@survival.test`,
      // The passport TRIO IS COMPLETE, because an incomplete one is refused by `missingForCreation`
      // before anything is created (all-or-nothing, the same rule the Bank tab carries).
      passportNumber: `A${tag.toUpperCase()}`,
      passportIssueDate: '2021-04-05',
      passportExpiryDate: '2031-04-04',
      passportIssuingCountry: 'Malaysian',
      passportIssuingCountryCode: 'my',
      passportRemark: 'Renewed at Putrajaya',
    },
    employment: {
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      costCenterId: b.costCenterId,
      gradeId,
      reportingManagerEmploymentId: managerEmploymentId,
      employmentType: 'contract',
      hiredOn: '2026-06-01',
      provisionalEndOn: '2027-05-31',
      // item a72610af — four periods and a date, every value and every unit different, so a mapping
      // that crossed two of them over could not pass. The confirmation date is AFTER the hire date:
      // `setEmploymentInfo` refuses one that is not, and `missingByTab` restates that rule so the
      // refusal lands on the tab rather than after the employee exists.
      probationValue: '3',
      probationUnit: 'month',
      extendedProbationValue: '6',
      extendedProbationUnit: 'week',
      confirmationDate: '2026-09-01',
      noticeBeforeConfirmationValue: '14',
      noticeBeforeConfirmationUnit: 'day',
      noticeAfterConfirmationValue: '2',
      noticeAfterConfirmationUnit: 'month',
    },
    statutory: {
      bankName: 'Maybank',
      bankAccountNo: '512345678901',
      epfNumber: '11223344',
      socsoNumber: '990101105577',
      taxNumber: 'SG 12345678901',
      taxCategory: '3',
      numChildren: '2',
      socsoCategory: 'second',
      eisCategory: 'none',
      isResident: 'no',
      epfCitizenship: 'pr',
      // item a72610af. The EPF category is 'semi_auto' rather than 'auto', because 'auto' is also what a
      // draft that carries NO category maps to — testing it would prove nothing.
      epfMode: 'semi_auto',
      // FOUR BOOLEANS CANNOT ALL BE DISTINCT, so they ALTERNATE. The 1-0-1-0 pattern is what a crossed
      // mapping would have to reproduce exactly to survive, which no adjacent swap does.
      employerBearsEpf: 'yes',
      employerBearsSocso: 'no',
      employerBearsEis: 'yes',
      employerBearsSkbbk: 'no',
      disabledIndividual: 'yes',
      disabledSpouse: 'no',
      // 'auto_table' rather than 'auto' ON PURPOSE: 'auto' makes `syncChildReliefFromFamily` re-derive
      // num_children from the family register at materialisation, which would overwrite the figure HR
      // typed and make the num_children assertion below untestable. 'auto_table' is equally distinct
      // from the 'manual' default and leaves the head count alone.
      childReliefMode: 'auto_table',
      subjectToHrdf: 'yes',
    },
    payroll: {
      basicSalary: '5200',
      monthlyAllowance: '400',
      // DAILY on purpose: it is the only pay mode for which `rateAmount` is meaningful, and a monthly
      // draft would leave that field untested — the exact shape of hole this file exists to close.
      payMode: 'daily',
      paymentTerm: 'monthly',
      rateAmount: '180',
      remarks: 'Initial package',
    },
    family: [{ fullName: 'Farah Aziz', relationship: 'spouse', dateOfBirth: '1992-03-14' }],
  };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await seedExtras();
});

/** A job grade and a manager to point the draft's Job Grade and Reporting Manager pickers at. */
async function seedExtras() {
  const [g] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code: `G${randomUUID().slice(0, 4)}`, name: 'Executive' })
    .returning({ id: schema.jobGrade.id });
  gradeId = g.id;
  const hired = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Aisha Rahman', primaryEmail: `aisha.${randomUUID().slice(0, 8)}@survival.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2025-01-01',
  });
  managerEmploymentId = hired.employmentId;
}
afterAll(async () => {
  await closeAll();
});

// ── §1 the contract ───────────────────────────────────────────────────────────────────────────────
describe('§1 every field the draft type declares has a declared destination', () => {
  for (const typeName of Object.keys(LANDS)) {
    it(`${typeName} — no field is unaccounted for, in either direction`, () => {
      const declared = fieldsOf(typeName);
      expect(declared.length, `${typeName} looks empty — the source parse is probably wrong`)
        .toBeGreaterThan(3);
      // Every field on the type is in the table…
      expect(declared.filter((f) => !(f in LANDS[typeName])),
        `add these to LANDS with the column they end up in (or null + the reason they do not)`).toEqual([]);
      // …and every entry in the table is still a field on the type, so a removed field does not leave a
      // row here claiming something is carried across when nothing is.
      expect(Object.keys(LANDS[typeName]).filter((f) => !declared.includes(f)),
        `these are in LANDS but no longer on ${typeName}`).toEqual([]);
    });
  }

  it('the draft period units are the SAME list the writer accepts (item a72610af)', () => {
    // `setEmploymentInfo` refuses a unit it does not know ("Period unit must be Month, Week or Day."),
    // and it refuses it AFTER `hireEmployee` has committed. The draft schema restates the list because it
    // is shared with the browser and core/org.ts is a server module — so the two must be pinned equal, or
    // a unit added to the writer and not to the screen becomes a half-created employee.
    const org = read('core/org.ts');
    const declared = org.slice(
      org.indexOf('export const EMPLOYMENT_PERIOD_UNITS'),
      org.indexOf('\n', org.indexOf('export const EMPLOYMENT_PERIOD_UNITS')),
    );
    expect(declared, 'EMPLOYMENT_PERIOD_UNITS not found — has core/org.ts been restructured?')
      .toContain('EMPLOYMENT_PERIOD_UNITS');
    const units = [...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(units.length, 'the unit list parsed empty').toBeGreaterThan(0);
    expect([...DRAFT_PERIOD_UNITS]).toEqual(units);
  });

  it('the family list has its own file, and this one says so rather than half-covering it', () => {
    const src = read('lib/employee-draft-schema.ts');
    expect(src).toContain('family?: EmployeeDraftFamilyMember[]');
    // The claim being made: `materialiseDependents` is what carries it, and its own shape contract is
    // pinned elsewhere. If that file stops asserting it, this pointer is a lie — so check it is there.
    const fam = read('test/employee-draft-family.test.ts');
    expect(fam).toContain('THE CONTRACT: DependentInput ⊆ EmployeeDraftFamilyMember');
    expect(fam).toContain('§3 everything entered on a draft survives Activate, field by field');
  });
});

// ── §2 the round trip ─────────────────────────────────────────────────────────────────────────────
describe('§2 activate a draft with every field set, and read every landing back', () => {
  it('nothing typed on any of the five tabs is dropped on the way to a real employee', async () => {
    const ctx = adminCtx(b);
    const data = everyField();
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 1 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);

    const [emp] = await owner.db
      .select()
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    expect(emp.employeeCode, 'employment.employee_code').toBe(data.profile!.employeeCode);
    expect(emp.companyId, 'employment.company_id').toBe(b.companyId);
    expect(emp.gradeId, 'employment.grade_id').toBe(gradeId);
    expect(emp.hiredOn, 'employment.hired_on').toBe('2026-06-01');
    expect(emp.provisionalEndOn, 'employment.provisional_end_on').toBe('2027-05-31');
    // item a72610af — the probation / confirmation / notice block. NONE of these reaches `hireEmployee`;
    // they are here only because `completeEmployeeDraft` composes `setEmploymentInfo` after the hire.
    expect(emp.probationValue, 'employment.probation_value').toBe(3);
    expect(emp.probationUnit, 'employment.probation_unit').toBe('month');
    expect(emp.extendedProbationValue, 'employment.extended_probation_value').toBe(6);
    expect(emp.extendedProbationUnit, 'employment.extended_probation_unit').toBe('week');
    expect(emp.confirmationDate, 'employment.confirmation_date').toBe('2026-09-01');
    expect(emp.noticeBeforeConfirmationValue, 'employment.notice_before_confirmation_value').toBe(14);
    expect(emp.noticeBeforeConfirmationUnit, 'employment.notice_before_confirmation_unit').toBe('day');
    expect(emp.noticeAfterConfirmationValue, 'employment.notice_after_confirmation_value').toBe(2);
    expect(emp.noticeAfterConfirmationUnit, 'employment.notice_after_confirmation_unit').toBe('month');

    const [person] = await owner.db
      .select()
      .from(schema.person)
      .where(eq(schema.person.id, emp.personId));
    expect(person.fullName, 'person.full_name').toBe('Nadia Yusof');
    expect(person.primaryEmail, 'person.primary_email').toBe(data.profile!.primaryEmail);
    expect(person.phone, 'person.phone').toBe('+60 19-876 5432');
    expect(person.gender, 'person.gender').toBe('female');
    expect(person.dateOfBirth, 'person.date_of_birth').toBe('1988-07-21');
    expect(person.maritalStatus, 'person.marital_status').toBe('married');
    expect(person.nationality, 'person.nationality').toBe('Malaysian');
    // item a72610af — the eight profile fields, through `updatePerson`.
    expect(person.salutation, 'person.salutation').toBe('Puan');
    expect(person.firstName, 'person.first_name').toBe('Nadia');
    expect(person.lastName, 'person.last_name').toBe('Yusof');
    expect(person.preferredName, 'person.preferred_name').toBe('Nad');
    expect(person.religion, 'person.religion').toBe('Islam');
    expect(person.race, 'person.race').toBe('Malay');
    expect(person.homePhone, 'person.home_phone').toBe('+60 3-2222 3333');
    expect(person.personalEmail, 'person.personal_email').toBe(data.profile!.personalEmail);
    // AND THE CORE TRIO SURVIVED THAT WRITE. `updatePerson` REWRITES fullName / primaryEmail / phone on
    // every call rather than leaving an omitted one alone, so a caller that forgot to pass the phone
    // through would blank the number `hireEmployee` had just stored — silently, on every activation that
    // happened to carry a profile field. Asserted above and again here on purpose.
    expect(person.phone, 'person.phone survived the profile write').toBe('+60 19-876 5432');

    const [assign] = await owner.db
      .select()
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, employmentId));
    expect(assign.departmentId, 'assignment.department_id').toBe(b.deptA);
    expect(assign.positionId, 'assignment.position_id').toBe(b.positionId);
    expect(assign.costCenterId, 'assignment.cost_center_id').toBe(b.costCenterId);
    expect(assign.employmentType, 'assignment.employment_type').toBe('contract');

    const lines = await owner.db
      .select()
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.subordinateEmploymentId, employmentId));
    expect(lines, 'reporting_line — the manager picked on the Employment tab').toHaveLength(1);
    expect(lines[0].managerEmploymentId, 'reporting_line.manager_employment_id')
      .toBe(managerEmploymentId);

    const [stat] = await owner.db
      .select()
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    // NORMALISED, not dropped: the MY pack stores an NRIC without its dashes, exactly as it does when
    // the same number is typed on the Personnel screen. The assertion names the stored form so a future
    // reader does not mistake it for the field going missing.
    expect(stat.icNumber, 'employee_statutory_my.ic_number').toBe('880721105566');
    expect(stat.bankName, 'employee_statutory_my.bank_name').toBe('Maybank');
    expect(stat.bankAccountNo, 'employee_statutory_my.bank_account_no').toBe('512345678901');
    expect(stat.epfNumber, 'employee_statutory_my.epf_number').toBe('11223344');
    expect(stat.socsoNumber, 'employee_statutory_my.socso_number').toBe('990101105577');
    expect(stat.taxNumber, 'employee_statutory_my.tax_number').toBe('SG 12345678901');
    expect(stat.taxCategory, 'employee_statutory_my.tax_category').toBe(3);
    // The FIGURE HR TYPED, not one the family register derived. A new employee is on manual child
    // relief, so the spouse on the draft must not move a tax input.
    expect(stat.numChildren, 'employee_statutory_my.num_children').toBe(2);
    expect(stat.socsoCategory, 'employee_statutory_my.socso_category').toBe('second');
    expect(stat.eisCategory, 'employee_statutory_my.eis_category').toBe('none');
    expect(stat.isResident, 'employee_statutory_my.is_resident').toBe(false);
    expect(stat.epfCitizenship, 'employee_statutory_my.epf_citizenship').toBe('pr');
    // item a72610af — the passport block, through `pack.setPassport`.
    expect(stat.passportNumber, 'employee_statutory_my.passport_number').toBe(data.profile!.passportNumber);
    expect(stat.passportIssueDate, 'employee_statutory_my.passport_issue_date').toBe('2021-04-05');
    expect(stat.passportExpiryDate, 'employee_statutory_my.passport_expiry_date').toBe('2031-04-04');
    expect(stat.passportIssuingCountry, 'employee_statutory_my.passport_issuing_country').toBe('Malaysian');
    // UPPERCASED BY THE WRITER, not dropped: the column is a CODE and a lowercase one would not match a
    // statutory list, so `setPassportProfileMY` normalises it. The assertion names the stored form.
    expect(stat.passportIssuingCountryCode, 'employee_statutory_my.passport_issuing_country_code').toBe('MY');
    expect(stat.passportRemark, 'employee_statutory_my.passport_remark').toBe('Renewed at Putrajaya');
    // item a72610af — the EPF category, mapped to its lawful enum. 'semi_auto' is an employee-side
    // election with the employer side left statutory, which is `voluntary_excess` with a null employer
    // rate; the draft collects no rates, so both sides stay statutory.
    expect(stat.epfMode, 'employee_statutory_my.epf_mode').toBe('voluntary_excess');
    expect(stat.epfEmployeeRate, 'employee_statutory_my.epf_employee_rate — no rate on a draft').toBeNull();
    expect(stat.epfEmployerRate, 'employee_statutory_my.epf_employer_rate — no rate on a draft').toBeNull();
    // item a72610af — the four employer-bears switches, in their alternating pattern.
    expect(stat.employerBearsEpf, 'employee_statutory_my.employer_bears_epf').toBe(true);
    expect(stat.employerBearsSocso, 'employee_statutory_my.employer_bears_socso').toBe(false);
    expect(stat.employerBearsEis, 'employee_statutory_my.employer_bears_eis').toBe(true);
    expect(stat.employerBearsSkbbk, 'employee_statutory_my.employer_bears_skbbk').toBe(false);
    // item a72610af — the two reliefs and the child-relief mode, through `pack.setTax`. That setter is a
    // TOTAL overwrite of the tax columns, so these three landing is only half the claim: the tax number,
    // the category and the head count asserted above must ALSO have survived it, which is what proves the
    // pass-through is real rather than three columns quietly reset to their defaults.
    expect(stat.disabledIndividual, 'employee_statutory_my.disabled_individual').toBe(true);
    expect(stat.disabledSpouse, 'employee_statutory_my.disabled_spouse').toBe(false);
    expect(stat.childReliefMode, 'employee_statutory_my.child_relief_mode').toBe('auto_table');
    // …and the residency the statutory writer set is still the one the tax writer re-derived, rather
    // than the 'resident' default it would have written for a caller that omitted it.
    expect(stat.taxResidency, 'employee_statutory_my.tax_residency, derived from isResident').toBe('non_resident');
    // item a72610af — the training levy switch, through its own partial-save writer.
    expect(stat.subjectToHrdf, 'employee_statutory_my.subject_to_hrdf').toBe(true);

    const [comp] = await owner.db
      .select()
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employmentId));
    expect(comp.basicSalary, 'compensation.basic_salary').toBe('5200.00');
    expect(comp.monthlyAllowance, 'compensation.monthly_allowance').toBe('400.00');
    expect(comp.payMode, 'compensation.pay_mode').toBe('daily');
    expect(comp.paymentTerm, 'compensation.payment_term').toBe('monthly');
    expect(comp.rateAmount, 'compensation.rate_amount').toBe('180.00');
    expect(comp.remarks, 'compensation.remarks').toBe('Initial package');

    // And the family list came with it (its own columns are asserted in employee-draft-family.test.ts).
    const deps = await owner.db
      .select()
      .from(schema.employeeDependent)
      .where(eq(schema.employeeDependent.personId, emp.personId));
    expect(deps.map((d) => d.fullName)).toEqual(['Farah Aziz']);
  });

  it('the LEGACY eisEligible on an old draft still lands, because that draft cannot be re-typed', async () => {
    // A draft saved before 35b7af0a group 7 carries `eisEligible: 'no'` and NO categories at all. It is
    // sitting in a table, nobody is going to re-enter it, and it must create the same employee it always
    // would have: EIS off.
    const ctx = adminCtx(b);
    const data = everyField();
    delete data.statutory!.eisCategory;
    data.statutory!.eisEligible = 'no';
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 3 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const [stat] = await owner.db
      .select({ eisCategory: schema.employeeStatutoryMy.eisCategory })
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    expect(stat.eisCategory).toBe('none');
  });

  /**
   * ONE NEW GROUP AT A TIME — item a72610af, and this is the case §2 above cannot reach.
   *
   * §2 activates a draft with EVERYTHING set, so every writer it calls finds a statutory row already
   * seeded by the one before it. Two of the new writers REFUSE when that row does not exist —
   * `setTaxProfileMY` throws NoIcYetError and `setOthersStatutoryMY` throws NoStatutoryProfileError — and
   * they run AFTER `hireEmployee` has committed. So a draft whose ONLY statutory value is an OKU claim,
   * or only the training-levy switch, is precisely the shape that would half-create an employee: the
   * person exists, the activation throws, and the draft is left behind.
   *
   * The same question applies to the other two new landings for the opposite reason: `setEmploymentInfo`
   * refuses an EMPTY write set ("Nothing to change.") and `updatePerson` rewrites the core trio on every
   * call, so each must be called only when the draft carries something for it, and must not damage what
   * the hire already wrote when it is.
   */
  describe('a draft carrying only ONE of the new groups still activates', () => {
    /** The four Create fields plus the three Activate needs, and nothing else. */
    const minimal = (): EmployeeDraftData => ({
      profile: {
        fullName: 'Minimal Case',
        employeeCode: `MIN${randomUUID().slice(0, 6).toUpperCase()}`,
        employeeIdMode: 'manual',
        primaryEmail: `minimal.${randomUUID().slice(0, 8)}@survival.test`,
        phone: '+60 12-000 0001',
      },
      employment: { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-03-01' },
      payroll: { basicSalary: '3000' },
    });
    const statOf = async (employmentId: string) => {
      const [emp] = await owner.db
        .select({ personId: schema.employment.personId })
        .from(schema.employment)
        .where(eq(schema.employment.id, employmentId));
      const [stat] = await owner.db
        .select()
        .from(schema.employeeStatutoryMy)
        .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
      return { personId: emp.personId, stat };
    };

    it('only an OKU claim — the tax writer needs a statutory row and must still find one', async () => {
      const ctx = adminCtx(b);
      const data = minimal();
      data.statutory = { disabledIndividual: 'yes' };
      const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 3 });
      const { employmentId } = await completeEmployeeDraft(ctx, id);
      const { stat } = await statOf(employmentId);
      expect(stat, 'a statutory row was seeded for the claim to land on').toBeTruthy();
      expect(stat.disabledIndividual).toBe(true);
      // …and nothing else was invented: no IC, and the tax defaults are the column defaults.
      expect(stat.icNumber).toBeNull();
      expect(stat.numChildren).toBe(0);
    });

    it('only the training levy switch — the others-statutory writer likewise', async () => {
      const ctx = adminCtx(b);
      const data = minimal();
      data.statutory = { subjectToHrdf: 'no' };
      const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 3 });
      const { employmentId } = await completeEmployeeDraft(ctx, id);
      const { stat } = await statOf(employmentId);
      // An EXPLICIT No, which is not the same as the absent "follow the company default" — that is the
      // whole point of the tri-state (feedback 57840a6e).
      expect(stat.subjectToHrdf).toBe(false);
    });

    it('a draft that names NO statutory value at all leaves subject_to_hrdf following the company', async () => {
      const ctx = adminCtx(b);
      const { id } = await saveEmployeeDraft(ctx, { data: minimal(), currentStep: 1 });
      const { employmentId } = await completeEmployeeDraft(ctx, id);
      const { personId } = await statOf(employmentId);
      const rows = await owner.db
        .select()
        .from(schema.employeeStatutoryMy)
        .where(eq(schema.employeeStatutoryMy.personId, personId));
      // No statutory row at all, exactly as before this item — the new fields cannot conjure one by
      // omission, or every hire that has no statutory detail today would start getting one.
      expect(rows, 'no statutory row is seeded for a draft with no statutory detail').toHaveLength(0);
    });

    it('only a passport — its writer seeds the row itself, and demands no IC to do it', async () => {
      const ctx = adminCtx(b);
      const data = minimal();
      data.profile!.nationality = 'Malaysian';
      data.profile!.passportNumber = 'P9988776';
      data.profile!.passportIssueDate = '2022-01-10';
      data.profile!.passportExpiryDate = '2032-01-09';
      const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 1 });
      const { employmentId } = await completeEmployeeDraft(ctx, id);
      const { stat } = await statOf(employmentId);
      expect(stat.passportNumber).toBe('P9988776');
      expect(stat.icNumber, 'a passport holder needs no MyKad').toBeNull();
    });

    it('only the probation periods — and the hire the employment write follows is unharmed', async () => {
      const ctx = adminCtx(b);
      const data = minimal();
      data.employment!.probationValue = '90';
      data.employment!.probationUnit = 'day';
      const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 2 });
      const { employmentId } = await completeEmployeeDraft(ctx, id);
      const [emp] = await owner.db
        .select()
        .from(schema.employment)
        .where(eq(schema.employment.id, employmentId));
      expect(emp.probationValue).toBe(90);
      expect(emp.probationUnit).toBe('day');
      expect(emp.hiredOn, 'the hire date the hire wrote is untouched').toBe('2026-03-01');
    });

    it('only a preferred name — and the phone the HIRE wrote survives the profile write', async () => {
      // `updatePerson` REWRITES fullName / primaryEmail / phone on every call rather than leaving an
      // omitted one alone. A landing that forgot to pass the phone through would blank the number
      // `hireEmployee` had just stored — silently, and only for drafts that happened to carry a profile
      // field, which is the worst possible shape for a defect.
      const ctx = adminCtx(b);
      const data = minimal();
      data.profile!.preferredName = 'Min';
      const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 1 });
      const { employmentId } = await completeEmployeeDraft(ctx, id);
      const { personId } = await statOf(employmentId);
      const [person] = await owner.db.select().from(schema.person).where(eq(schema.person.id, personId));
      expect(person.preferredName).toBe('Min');
      expect(person.phone, 'the phone survived the profile write').toBe('+60 12-000 0001');
      expect(person.fullName).toBe('Minimal Case');
    });
  });

  it('a draft saved on ANY tab activates the same employee — the tab is not part of the record', async () => {
    // The move onto tabs added one stored value that did not exist as a concept before: which tab was
    // open. It must be navigation and nothing else. Saving the identical payload from each of the five
    // tabs must produce the identical employee, so the pointer can never become an input.
    const ctx = adminCtx(b);
    const seen: string[] = [];
    for (const step of [1, 2, 3, 4, 6]) {
      await resetDb();
      b = await seedBase();
      await seedExtras();
      const inner = adminCtx(b);
      const data = everyField();
      const { id } = await saveEmployeeDraft(inner, { data, currentStep: step });
      const { employmentId } = await completeEmployeeDraft(inner, id);
      const [emp] = await owner.db
        .select({ personId: schema.employment.personId, hiredOn: schema.employment.hiredOn })
        .from(schema.employment)
        .where(eq(schema.employment.id, employmentId));
      const [comp] = await owner.db
        .select({ basicSalary: schema.compensation.basicSalary, rateAmount: schema.compensation.rateAmount })
        .from(schema.compensation)
        .where(eq(schema.compensation.employmentId, employmentId));
      const [stat] = await owner.db
        .select({ socsoCategory: schema.employeeStatutoryMy.socsoCategory })
        .from(schema.employeeStatutoryMy)
        .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
      seen.push(`${emp.hiredOn}|${comp.basicSalary}|${comp.rateAmount}|${stat.socsoCategory}`);
    }
    expect(new Set(seen).size, `five tabs produced different employees: ${seen.join(' / ')}`).toBe(1);
    expect(ctx).toBeTruthy();
  });
});
