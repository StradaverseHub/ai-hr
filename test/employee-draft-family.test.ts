/**
 * FAMILY ON A DRAFT, AND WHAT SURVIVES ACTIVATE — item 759dfc7d, work item 1.
 *
 * The reporter's requirement is one sentence: "The system should retain all information already entered
 * during Draft status and should not require the administrator to re-enter the information." The failure
 * mode that sentence is written against is a SILENT one — a field HR types on the draft that nothing
 * carries across, discovered weeks later when somebody notices a spouse has no employer on file. So this
 * file does not spot-check. It asserts the round trip field by field, and it pins the shapes on both
 * sides so a column added to the writer without being added to the draft fails HERE rather than in
 * production.
 *
 * §1  the completeness rule (pure) — what a draft's family blocks, and what it deliberately does not
 * §2  THE SHAPE CONTRACT — every field the dependent writer accepts exists on the draft AND is mapped
 * §3  the activation round trip, field by field, against a real database
 * §4  the pre-flight — a family the writer would refuse stops the activation before anything is created
 * §5  materialisation is all-or-nothing and idempotent
 * §6  what must NOT have been lost on the way (save-without-validation, the pinned company and code,
 *     discard releasing the reserved number) with a family present
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  DRAFT_STEPS,
  draftFamily,
  missingByStep,
  missingForCreation,
  type EmployeeDraftData,
  type EmployeeDraftFamilyMember,
} from '../lib/employee-draft-schema';
import {
  completeEmployeeDraft,
  createEmployeeDraftWithReservedCode,
  discardEmployeeDraft,
  draftFamilyToDependents,
  getEmployeeDraft,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { listDependents, materialiseDependents } from '../core/dependents';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

let b: Base;

/**
 * A SPOUSE WITH EVERY GENERAL AND EVERY SPOUSE-ONLY FIELD SET, each to a distinct, recognisable value.
 * Distinct on purpose: two fields sharing a value is how a mapping that crosses them over still passes.
 */
const SPOUSE: EmployeeDraftFamilyMember = {
  key: 'k-spouse',
  fullName: 'Farah Aziz',
  relationship: 'spouse',
  dateOfBirth: '1992-03-14',
  gender: 'female',
  icOrPassport: '920314-10-5566',
  isBeneficiary: true,
  phone: '+60 12-345 6789',
  remarks: 'Primary insurance beneficiary',
  passportNumber: 'A12345678',
  residentialAddress: '18 Jalan Damai, 50480 Kuala Lumpur',
  isDeceased: false,
  marriageDate: '2016-08-20',
  marriageStatus: 'married',
  spouseWorking: true,
  occupation: 'Architect',
  companyName: 'Rekabina Sdn Bhd',
  employerAddress: 'Level 9, Menara Rekabina, Petaling Jaya',
};

/** A CHILD WITH EVERY GENERAL AND EVERY CHILD-ONLY FIELD SET, same principle. */
const CHILD: EmployeeDraftFamilyMember = {
  key: 'k-child',
  fullName: 'Iman Nadia',
  relationship: 'child',
  dateOfBirth: '2009-11-02',
  gender: 'undisclosed',
  icOrPassport: '091102-14-0099',
  isBeneficiary: false,
  phone: '+60 11-222 3333',
  remarks: 'Lives with grandparents during term',
  passportNumber: 'B98765432',
  residentialAddress: '77 Lorong Cempaka, 43000 Kajang',
  isDeceased: false,
  isStudent: true,
  schoolName: 'SMK Bandar Baru',
  studyLevel: 'Form 5',
  studyCountry: 'Malaysia',
  childReliefCategory: 'study_tertiary',
  childTaxRelief: true,
  childReliefPercentage: '50',
};

/** A NON-SPOUSE, NON-CHILD member — the third panel, where `occupation` is the only extra field. */
const PARENT: EmployeeDraftFamilyMember = {
  key: 'k-parent',
  fullName: 'Zainab Ismail',
  relationship: 'parent',
  dateOfBirth: '1958-05-30',
  gender: 'female',
  icOrPassport: '580530-08-5432',
  isBeneficiary: true,
  phone: '+60 13-999 0000',
  remarks: 'Dependent mother',
  passportNumber: 'C55554444',
  residentialAddress: '5 Taman Seri, 70000 Seremban',
  isDeceased: false,
  occupation: 'Retired teacher',
};

/**
 * A draft that has everything Activate needs, with every OTHER section fully populated too — the family
 * is what this file is about, but "nothing is retyped" is a claim about the whole record, so the round
 * trip in §3 asserts every section.
 */
function fullDraft(over: Partial<EmployeeDraftData> = {}): EmployeeDraftData {
  return {
    profile: {
      fullName: 'Nadia Yusof',
      primaryEmail: `nadia.${randomUUID().slice(0, 8)}@demo.test`,
      employeeCode: `FAM${randomUUID().slice(0, 8).toUpperCase()}`,
      phone: '+60 19-876 5432',
      gender: 'female',
      dateOfBirth: '1988-07-21',
      maritalStatus: 'married',
      nationality: 'Malaysian',
    },
    employment: {
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      costCenterId: b.costCenterId,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
      provisionalEndOn: '2026-09-01',
    },
    statutory: {
      bankName: 'Maybank',
      bankAccountNo: '512345678901',
      epfNumber: '11223344',
      socsoNumber: '880721105566',
      taxNumber: 'SG 12345678901',
      taxCategory: '3',
      numChildren: '1',
      isResident: 'yes',
      epfCitizenship: 'citizen',
    },
    payroll: {
      basicSalary: '5200',
      monthlyAllowance: '400',
      payMode: 'monthly',
      paymentTerm: 'monthly',
      remarks: 'Initial package',
    },
    family: [SPOUSE, CHILD, PARENT],
    ...over,
  };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

// ── §1 the rule ───────────────────────────────────────────────────────────────────────────────────
describe('§1 what a draft family blocks, and what it deliberately does not', () => {
  it('Family is a step, and it is the LAST one — the numbers already on production rows must not move', () => {
    // `employee_draft.current_step` is a 1-based POSITION into this list. Inserting `family` anywhere but
    // the end silently reopens every draft sitting on production on a different step, which is a data
    // migration disguised as a UI change.
    expect(DRAFT_STEPS).toEqual(['profile', 'employment', 'statutory', 'payroll', 'family']);
  });

  it('NO family member is required — most new joiners have none, and a step that demanded one would block them', () => {
    expect(missingByStep({}).family).toEqual([]);
    expect(missingByStep({ family: [] }).family).toEqual([]);
    // …and a complete member is silent too.
    expect(missingByStep({ family: [SPOUSE, CHILD, PARENT] }).family).toEqual([]);
  });

  it('a member somebody DID add must be writable — a nameless one is named BEFORE the employee exists', () => {
    // THE DEFECT THIS PINS. `materialiseDependents` runs after `hireEmployee` has committed, so a member
    // the writer refuses would fail an activation that has already created an employee — the half-activated
    // state this whole item exists to prevent. The rule moves that refusal to a moment where it costs
    // nothing, and the server re-runs it (`completeEmployeeDraft` → `missingForCreation`) before writing.
    expect(missingByStep({ family: [{ relationship: 'child' }] }).family).toEqual(['familyMemberName']);
    expect(missingByStep({ family: [{ fullName: 'Someone' }] }).family).toEqual(['familyMemberRelationship']);
    // Every date the register stores, not just the date of birth: each reaches Postgres as a `date`.
    for (const bad of [
      { fullName: 'A', relationship: 'child', dateOfBirth: '02/11/2009' },
      { fullName: 'A', relationship: 'spouse', marriageDate: 'last August' },
      { fullName: 'A', relationship: 'parent', deceasedOn: '2020-13-45' },
    ]) {
      expect(missingByStep({ family: [bad] }).family).toEqual(['familyMemberDate']);
    }
  });

  it('three broken members produce three names, not nine — the list is what HR reads, not a count', () => {
    const broken = missingByStep({ family: [{}, {}, {}] }).family;
    expect(broken).toEqual(['familyMemberName', 'familyMemberRelationship']);
  });

  it('the flat Activate list carries the family names, so the button says why it is disabled', () => {
    expect(missingForCreation({ family: [{}] })).toContain('familyMemberName');
  });

  it('a malformed blob reads as NO family rather than throwing — `data` is jsonb and nothing constrains it', () => {
    // A draft written before this item has no `family` key at all; a hand-edited row could carry anything.
    // `.map` on either is a 500 on the continue screen, which is a worse outcome than an ignored value.
    expect(draftFamily({})).toEqual([]);
    expect(draftFamily({ family: 'spouse' } as unknown as EmployeeDraftData)).toEqual([]);
    expect(draftFamily({ family: [null, 'x', SPOUSE] as unknown as EmployeeDraftFamilyMember[] })).toEqual([SPOUSE]);
  });

  it('every computed translation key the Family step adds resolves, in all six locales', () => {
    // `t(`steps.${k}`)` and `t(`fields.${f}`)` are invisible to test/i18n-coverage.test.ts check C.
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      expect(String(msgs.people?.wizard?.steps?.family ?? '').trim(), `${loc} steps.family`).not.toBe('');
      const names = new Set(
        [
          { family: [{}] },
          { family: [{ fullName: 'A', relationship: 'child', dateOfBirth: 'nope' }] },
        ].flatMap((d) => missingByStep(d as EmployeeDraftData).family),
      );
      expect(names.size).toBeGreaterThan(0);
      for (const f of names) {
        expect(String(msgs.people?.wizard?.fields?.[f] ?? '').trim(), `${loc} fields.${f}`).not.toBe('');
      }
      // The draft's Family form renders the PERSONNEL screen's own labels, so its one new key must exist
      // everywhere too — a missing one is a raw `people.detail.family.cancel` on a dialog button.
      expect(String(msgs.people?.detail?.family?.cancel ?? '').trim(), `${loc} family.cancel`).not.toBe('');
    }
  });
});

// ── §2 the shape contract ─────────────────────────────────────────────────────────────────────────
describe('§2 the draft carries EVERY field the dependent writer accepts', () => {
  /** Field names declared in a `export type X = {` … `}` block, read from source. */
  const fieldsOf = (src: string, name: string): string[] => {
    const start = src.indexOf(`export type ${name} = {`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  };

  it('THE CONTRACT: DependentInput ⊆ EmployeeDraftFamilyMember, and every field is actually mapped', () => {
    // THE DEFECT THIS PINS, and it is the reason the mapping is a named exported function rather than an
    // inline object literal: r73 Decision 3 — one writer falls behind a column the other gained, silently.
    // Here that means the Personnel Family tab gains a field, the draft's blob never learns about it, and
    // everything HR typed into it on a draft evaporates at Activate with no error anywhere.
    const dep = read('core/dependents.ts');
    const writerFields = [...fieldsOf(dep, 'DependentInput'), ...fieldsOf(dep, 'DependentExtraInput')];
    expect(writerFields).toContain('fullName');
    expect(writerFields).toContain('childReliefPercentage');
    expect(writerFields.length).toBeGreaterThan(20);

    const draftFields = fieldsOf(read('lib/employee-draft-schema.ts'), 'EmployeeDraftFamilyMember');
    expect(writerFields.filter((f) => !draftFields.includes(f))).toEqual([]);

    // Declared is not carried. Drive the mapper with a member that has every field set and check the
    // OUTPUT keys — a field declared on the type but forgotten in the mapping fails here.
    const mapped = draftFamilyToDependents({ family: [{ ...SPOUSE, ...CHILD }] })[0];
    expect(writerFields.filter((f) => !(f in mapped))).toEqual([]);
  });

  it('the only draft-side field the writer does not take is the editor key, and it is documented as such', () => {
    const draftFields = fieldsOf(read('lib/employee-draft-schema.ts'), 'EmployeeDraftFamilyMember');
    const dep = read('core/dependents.ts');
    const writerFields = new Set([...fieldsOf(dep, 'DependentInput'), ...fieldsOf(dep, 'DependentExtraInput')]);
    expect(draftFields.filter((f) => !writerFields.has(f))).toEqual(['key']);
  });

  it('the conversions are the ones the rest of the draft makes: blank ⇒ null, a select string ⇒ a number', () => {
    const [m] = draftFamilyToDependents({
      family: [{ fullName: '  Farah  ', relationship: 'spouse', phone: '   ', childReliefPercentage: '50' }],
    });
    expect(m.fullName).toBe('Farah');
    expect(m.phone).toBeNull();
    // The child gating is the WRITER's business, so the mapper carries the value across regardless and
    // lets `extraColumnsForAdd` null it — judging it here would put the rule in two places.
    expect(m.childReliefPercentage).toBe(50);
    // An unticked checkbox is `false` for the two the writer defaults to false, and `null` for the three
    // it stores as a tri-state — the same defaults `extraColumnsForAdd` applies.
    expect(m.isBeneficiary).toBe(false);
    expect(m.isDeceased).toBe(false);
    expect(m.spouseWorking).toBeNull();
    expect(m.isStudent).toBeNull();
    expect(m.childTaxRelief).toBeNull();
  });
});

// ── §3 the round trip ─────────────────────────────────────────────────────────────────────────────
describe('§3 everything entered on a draft survives Activate, field by field', () => {
  it('the family becomes real rows, every column, with the writer\'s own relationship gating', async () => {
    const ctx = adminCtx(b);
    const data = fullDraft();
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);

    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const rows = await owner.db
      .select()
      .from(schema.employeeDependent)
      .where(eq(schema.employeeDependent.personId, emp.personId));
    expect(rows).toHaveLength(3);
    const by = (name: string) => rows.find((r) => r.fullName === name)!;

    // ── the spouse: every general field, every spouse-only field, and the child-only columns NULLed
    const s = by('Farah Aziz');
    expect(s.relationship).toBe('spouse');
    expect(s.dateOfBirth).toBe('1992-03-14');
    expect(s.gender).toBe('female');
    expect(s.icOrPassport).toBe('920314-10-5566');
    expect(s.isBeneficiary).toBe(true);
    expect(s.phone).toBe('+60 12-345 6789');
    expect(s.remarks).toBe('Primary insurance beneficiary');
    expect(s.passportNumber).toBe('A12345678');
    expect(s.residentialAddress).toBe('18 Jalan Damai, 50480 Kuala Lumpur');
    expect(s.isDeceased).toBe(false);
    expect(s.deceasedOn).toBeNull();
    expect(s.marriageDate).toBe('2016-08-20');
    expect(s.marriageStatus).toBe('married');
    expect(s.spouseWorking).toBe(true);
    expect(s.occupation).toBe('Architect');
    expect(s.companyName).toBe('Rekabina Sdn Bhd');
    expect(s.employerAddress).toBe('Level 9, Menara Rekabina, Petaling Jaya');
    // Not a drop — `extraColumnsForAdd` stores child-only columns NULL for a non-child, and the draft is
    // held to the SAME rule rather than a second one of its own.
    expect(s.isStudent).toBeNull();
    expect(s.schoolName).toBeNull();
    expect(s.studyLevel).toBeNull();
    expect(s.studyCountry).toBeNull();
    expect(s.childReliefCategory).toBeNull();
    expect(s.childTaxRelief).toBeNull();
    expect(s.childReliefPercentage).toBeNull();

    // ── the child: every general field, every child-only field, and the spouse-only columns NULLed
    const c = by('Iman Nadia');
    expect(c.relationship).toBe('child');
    expect(c.dateOfBirth).toBe('2009-11-02');
    expect(c.gender).toBe('undisclosed');
    expect(c.icOrPassport).toBe('091102-14-0099');
    expect(c.isBeneficiary).toBe(false);
    expect(c.phone).toBe('+60 11-222 3333');
    expect(c.remarks).toBe('Lives with grandparents during term');
    expect(c.passportNumber).toBe('B98765432');
    expect(c.residentialAddress).toBe('77 Lorong Cempaka, 43000 Kajang');
    expect(c.isDeceased).toBe(false);
    expect(c.isStudent).toBe(true);
    expect(c.schoolName).toBe('SMK Bandar Baru');
    expect(c.studyLevel).toBe('Form 5');
    expect(c.studyCountry).toBe('Malaysia');
    expect(c.childReliefCategory).toBe('study_tertiary');
    expect(c.childTaxRelief).toBe(true);
    expect(c.childReliefPercentage).toBe(50);
    expect(c.marriageDate).toBeNull();
    expect(c.marriageStatus).toBeNull();
    expect(c.spouseWorking).toBeNull();
    expect(c.companyName).toBeNull();
    expect(c.employerAddress).toBeNull();

    // ── the parent: the standard panel, where occupation is general and everything gated is NULL
    const p = by('Zainab Ismail');
    expect(p.relationship).toBe('parent');
    expect(p.dateOfBirth).toBe('1958-05-30');
    expect(p.gender).toBe('female');
    expect(p.icOrPassport).toBe('580530-08-5432');
    expect(p.isBeneficiary).toBe(true);
    expect(p.phone).toBe('+60 13-999 0000');
    expect(p.remarks).toBe('Dependent mother');
    expect(p.passportNumber).toBe('C55554444');
    expect(p.residentialAddress).toBe('5 Taman Seri, 70000 Seremban');
    expect(p.occupation).toBe('Retired teacher');
    expect(p.marriageStatus).toBeNull();
    expect(p.schoolName).toBeNull();

    // And they are visible through the SAME read the Personnel Family tab uses, not only in raw SQL.
    const listed = await listDependents(ctx, { personId: emp.personId });
    expect(listed.map((d) => d.fullName).sort()).toEqual(['Farah Aziz', 'Iman Nadia', 'Zainab Ismail']);
  });

  it('and nothing else on the draft is lost on the way — profile, employment, statutory and payroll', async () => {
    // The family is what this item adds, but the reporter's sentence is about the whole record. A change
    // to the activation path that dropped a bank account while carrying the family across would be a worse
    // outcome than the gap this item started from, so the other four sections are asserted here too.
    const ctx = adminCtx(b);
    const data = fullDraft();
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);

    const [emp] = await owner.db
      .select({
        personId: schema.employment.personId,
        companyId: schema.employment.companyId,
        hiredOn: schema.employment.hiredOn,
        employeeCode: schema.employment.employeeCode,
        provisionalEndOn: schema.employment.provisionalEndOn,
      })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    expect(emp.companyId).toBe(b.companyId);
    expect(emp.hiredOn).toBe('2026-06-01');
    expect(emp.provisionalEndOn).toBe('2026-09-01');
    expect(emp.employeeCode).toBe(data.profile!.employeeCode);

    const [person] = await owner.db
      .select({
        fullName: schema.person.fullName,
        primaryEmail: schema.person.primaryEmail,
        phone: schema.person.phone,
        nationality: schema.person.nationality,
        gender: schema.person.gender,
        maritalStatus: schema.person.maritalStatus,
        dateOfBirth: schema.person.dateOfBirth,
      })
      .from(schema.person)
      .where(eq(schema.person.id, emp.personId));
    expect(person.fullName).toBe('Nadia Yusof');
    expect(person.primaryEmail).toBe(data.profile!.primaryEmail);
    expect(person.phone).toBe('+60 19-876 5432');
    expect(person.nationality).toBe('Malaysian');
    expect(person.gender).toBe('female');
    expect(person.maritalStatus).toBe('married');
    expect(person.dateOfBirth).toBe('1988-07-21');

    const [assign] = await owner.db
      .select({
        departmentId: schema.assignment.departmentId,
        positionId: schema.assignment.positionId,
        costCenterId: schema.assignment.costCenterId,
        employmentType: schema.assignment.employmentType,
      })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, employmentId));
    expect(assign.departmentId).toBe(b.deptA);
    expect(assign.positionId).toBe(b.positionId);
    expect(assign.costCenterId).toBe(b.costCenterId);
    expect(assign.employmentType).toBe('full_time');

    const [stat] = await owner.db
      .select()
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    expect(stat.bankName).toBe('Maybank');
    expect(stat.bankAccountNo).toBe('512345678901');
    expect(stat.epfNumber).toBe('11223344');
    expect(stat.socsoNumber).toBe('880721105566');
    expect(stat.taxNumber).toBe('SG 12345678901');
    expect(stat.taxCategory).toBe(3);
    expect(stat.isResident).toBe(true);
    expect(stat.epfCitizenship).toBe('citizen');
    // THE TAX FIGURE HR TYPED IS STILL THE TAX FIGURE. `materialiseDependents` refreshes num_children
    // from the family register, but only for a person on AUTOMATIC child relief — and a new employee is
    // 'manual'. A child on the draft must not silently overwrite the number keyed on Bank & Statutory;
    // that is the benefits-vs-tax firewall, and materialisation is a new door into it.
    expect(stat.childReliefMode).toBe('manual');
    expect(stat.numChildren).toBe(1);

    const [comp] = await owner.db
      .select()
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employmentId));
    expect(comp.basicSalary).toBe('5200.00');
    expect(comp.monthlyAllowance).toBe('400.00');
    expect(comp.payMode).toBe('monthly');
    expect(comp.paymentTerm).toBe('monthly');
    expect(comp.validFrom).toBe('2026-06-01');
    expect(comp.remarks).toBe('Initial package');
  });

  it('a draft with NO family activates exactly as it always did, and creates no family rows', async () => {
    // Every draft written before this item has no `family` key. It must still create the same employee.
    const ctx = adminCtx(b);
    const { family: _dropped, ...noFamily } = fullDraft();
    const { id } = await saveEmployeeDraft(ctx, { data: noFamily, currentStep: 4 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    expect(await listDependents(ctx, { personId: emp.personId })).toEqual([]);
  });
});

// ── §4 the pre-flight ─────────────────────────────────────────────────────────────────────────────
describe('§4 a family the writer would refuse stops the activation BEFORE anything is created', () => {
  const counts = async () => ({
    person: (await owner.db.select({ id: schema.person.id }).from(schema.person)).length,
    employment: (await owner.db.select({ id: schema.employment.id }).from(schema.employment)).length,
    dependent: (await owner.db.select({ id: schema.employeeDependent.id }).from(schema.employeeDependent)).length,
  });

  it('an invalid gender refuses the activation and leaves NO employee behind', async () => {
    // THE DEFECT THIS PINS, and it is the whole reason `assertDependentsValid` exists. Materialisation
    // can only run once a person exists. Without a pre-flight, a member carrying a value the writer
    // rejects fails AFTER `hireEmployee` has committed — leaving an employee who exists, is in headcount,
    // is payable, and has none of the family HR entered, with nothing on screen saying so. Re-pressing
    // Activate cannot fix it either: the Employee ID is now held by the employment, so the second attempt
    // refuses on the ID instead.
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, {
      data: fullDraft({ family: [{ fullName: 'Farah Aziz', relationship: 'spouse', gender: 'lady' }] }),
      currentStep: 5,
    });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Family member 1/);
    expect(await counts()).toEqual(before);
    // The draft survives the refusal — losing the typed work would be the worse failure.
    expect(await getEmployeeDraft(ctx, id)).not.toBeNull();
  });

  it('a relationship that is neither built-in nor an active catalog option is refused the same way', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, {
      data: fullDraft({ family: [SPOUSE, { fullName: 'Someone', relationship: 'godparent' }] }),
      currentStep: 5,
    });
    // Reported by POSITION, never by name: an error message is not a place to put a child's name.
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Family member 2/);
    expect(await counts()).toEqual(before);
  });

  it('a nameless member is refused by the draft rule, before the catalog is even consulted', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, {
      data: fullDraft({ family: [{ relationship: 'child' }] }),
      currentStep: 5,
    });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Cannot create the employee yet/);
    expect(await counts()).toEqual(before);
  });
});

// ── §5 all-or-nothing and idempotent ──────────────────────────────────────────────────────────────
describe('§5 materialisation is all-or-nothing, and running it twice does not duplicate a family', () => {
  it('a failure part-way through leaves NO family member behind, not the ones before it', async () => {
    // THE DEFECT THIS PINS: a family half-carried across is worse than one that failed outright, because
    // nothing on screen afterwards says which members made it. The refusal is provoked on the THIRD
    // member so there are two successful inserts in front of it to roll back.
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data: fullDraft(), currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const beforeCount = (await listDependents(ctx, { personId: emp.personId })).length;

    await expect(
      materialiseDependents(ctx, {
        personId: emp.personId,
        members: [
          { fullName: 'New One', relationship: 'parent' },
          { fullName: 'New Two', relationship: 'sibling' },
          { fullName: 'New Three', relationship: 'not-a-relationship' },
        ],
      }),
    ).rejects.toThrow();
    const after = await listDependents(ctx, { personId: emp.personId });
    expect(after).toHaveLength(beforeCount);
    expect(after.map((d) => d.fullName)).not.toContain('New One');
    expect(after.map((d) => d.fullName)).not.toContain('New Two');
  });

  it('re-running it against the same person skips what is already there rather than duplicating it', async () => {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data: fullDraft(), currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));

    const again = await materialiseDependents(ctx, {
      personId: emp.personId,
      members: draftFamilyToDependents({ family: [SPOUSE, CHILD, PARENT] }),
    });
    expect(again.created).toEqual([]);
    expect(again.skipped).toBe(3);
    expect(await listDependents(ctx, { personId: emp.personId })).toHaveLength(3);
  });
});

// ── §6 what must not have been lost on the way ────────────────────────────────────────────────────
describe('§6 a family present must not change what a draft IS', () => {
  it('SAVE STILL DOES NOT VALIDATE — a half-typed family member saves with everything else', async () => {
    // The reporter's own words: "you can save at any point without filling everything in". A family
    // member with nothing but a relationship is exactly the state HR leaves the screen in at 5pm.
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, {
      data: { profile: { fullName: 'Half Done' }, family: [{ key: 'k', relationship: 'child' }] },
      currentStep: 5,
    });
    const got = await getEmployeeDraft(ctx, id);
    expect(draftFamily(got!.data)).toEqual([{ key: 'k', relationship: 'child' }]);
    // It is OUTSTANDING, not rejected — the distinction the whole draft workflow rests on.
    expect(missingForCreation(got!.data)).toContain('familyMemberName');
  });

  it('the reserved Employee ID and the company stay pinned even when the payload also carries a family', async () => {
    const ctx = adminCtx(b);
    const created = await createEmployeeDraftWithReservedCode(ctx, {
      companyId: b.companyId,
      fullName: 'Held Code',
      primaryEmail: `held.${randomUUID().slice(0, 8)}@demo.test`,
      employeeCode: `HOLD${randomUUID().slice(0, 6).toUpperCase()}`,
    });
    const other = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    await saveEmployeeDraft(ctx, {
      id: created.id,
      data: {
        profile: { fullName: 'Held Code', employeeCode: 'TYPED-OVER' },
        employment: { companyId: other[0].id },
        family: [SPOUSE],
      },
      currentStep: 5,
    });
    const got = await getEmployeeDraft(ctx, created.id);
    expect(got!.data.profile?.employeeCode).toBe(created.employeeCode);
    expect(got!.data.employment?.companyId).toBe(b.companyId);
    // …and the family the same save carried is still there: pinning two fields must not drop a third.
    expect(draftFamily(got!.data)).toHaveLength(1);
  });

  it('DISCARD still releases the reserved number, and takes the family with the draft', async () => {
    const ctx = adminCtx(b);
    const created = await createEmployeeDraftWithReservedCode(ctx, {
      companyId: b.companyId,
      fullName: 'To Discard',
      primaryEmail: `dis.${randomUUID().slice(0, 8)}@demo.test`,
      employeeCode: `DIS${randomUUID().slice(0, 6).toUpperCase()}`,
    });
    await saveEmployeeDraft(ctx, {
      id: created.id,
      data: { profile: { fullName: 'To Discard' }, family: [SPOUSE, CHILD] },
      currentStep: 5,
    });
    await discardEmployeeDraft(ctx, created.id);
    expect(await getEmployeeDraft(ctx, created.id)).toBeNull();
    // Nothing was ever created for the family to be left in — the blob went with the row.
    expect(await owner.db.select({ id: schema.employeeDependent.id }).from(schema.employeeDependent)).toEqual([]);
  });
});
