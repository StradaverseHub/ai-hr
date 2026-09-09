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
import type { EmployeeDraftData } from '../lib/employee-draft-schema';
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
