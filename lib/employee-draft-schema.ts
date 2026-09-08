/**
 * The Create New Employee wizard's shape and its completeness rules — item 6d671f44.
 *
 * Client-safe (no DB imports), because the SAME rules decide three things and they must not drift:
 *   - which steps show a tick and which show a warning, in the browser;
 *   - whether the Activate button is enabled;
 *   - whether `completeEmployeeDraft` will actually accept the draft, on the server.
 * The server re-runs BOTH rules authoritatively — this module is shared, not trusted.
 *
 * ITEM 06f0cb8f SPLIT THE ONE RULE IN TWO, and the split is the whole shape of the new workflow:
 *   - `missingToCreate` — the FOUR things Create asks for (Company, Employee ID, Full Name, Email).
 *     Satisfying it produces a Draft with a HELD Employee ID and nothing else.
 *   - `missingForCreation` — everything an employment actually needs (Department, Employment Type,
 *     Join Date, initial salary…). It is now the ACTIVATE rule, checked when a Draft becomes a person.
 * They are two rules and not one because the reporter's request is precisely that the second one stops
 * blocking the first. Both still run on the server before anything is created, so nothing that used to
 * be checked has stopped being checked; only WHEN it is checked moved.
 *
 * WHAT IS REQUIRED, AND WHERE IT DIFFERS FROM THE TICKET. The reporter listed Identity No and Position
 * among the mandatory fields. Neither is required here, deliberately:
 *   - IDENTITY NO is optional-but-validated. Item e3ce0d4d made `icNumber` nullable precisely so a
 *     non-Malaysian passport holder can be employed; making it mandatory again would re-close that door.
 *     A value that IS supplied must be a valid IC for the company's country pack, checked on the server.
 *   - POSITION is optional because it is optional in `hireEmployee` and in the bulk importer. Making the
 *     wizard stricter than the other two ways of creating an employee is how the three drift apart —
 *     the plan's own warning about import and hand-entry needing the same completion rules.
 * Everything else on their list (Employee Name, Company, Department, Join Date, Employment Type) is
 * required, plus the two the existing hire form already requires: work email and initial basic salary.
 *
 * ITEM bd271009 CHANGED TWO THINGS HERE. Company became the FIRST question (it decides the Employee ID
 * rule) and the Employee ID became conditionally required — see `MissingOptions`. 06f0cb8f then moved
 * both onto the Create screen, which is where `missingToCreate` now judges them.
 */
import { resolveEmployeeIdMode, type EmployeeIdRule } from './employee-id-mode';

export type EmployeeDraftProfile = {
  fullName?: string;
  /** The Employee ID. On the Create screen it is the value HR types in Manual Key In mode (item
   *  bd271009 makes it required there, blank meaning "issue the running number"). AFTER Create it is a
   *  MIRROR of the reserved code held on the row (item 06f0cb8f) — the column
   *  `employee_draft.reserved_employee_code` is the authority, and the continue form shows this copy
   *  read-only, so a draft cannot carry an ID different from the one being held for it. */
  employeeCode?: string;
  /** The Auto / Manual radio PICK (item bd271009), remembered so a resumed draft reopens on it. It is
   *  advisory: `resolveEmployeeIdMode` re-decides against the LIVE setup every time, so a pick that the
   *  company's rule no longer permits is overruled rather than obeyed. */
  employeeIdMode?: string;
  primaryEmail?: string;
  phone?: string;
  gender?: string;
  dateOfBirth?: string;
  maritalStatus?: string;
  /** 35b7af0a group 8 — the nationality the whole identity fork turns on. Optional, like every other
   *  profile field here: the Personnel screen does not require one either, and making the wizard stricter
   *  than `hireEmployee` and the bulk importer is how the three creation paths drift apart (see the note
   *  above about Identity No and Position). ABSENT ON EVERY DRAFT SAVED BEFORE THIS CHANGE, which is why
   *  it is optional in the type as well as in the rules — an old draft must still open and still create. */
  nationality?: string;
  icNumber?: string;
};

export type EmployeeDraftEmployment = {
  companyId?: string;
  departmentId?: string;
  positionId?: string;
  costCenterId?: string;
  gradeId?: string;
  reportingManagerEmploymentId?: string;
  employmentType?: string;
  hiredOn?: string;
  provisionalEndOn?: string;
};

export type EmployeeDraftStatutory = {
  bankName?: string;
  bankAccountNo?: string;
  epfNumber?: string;
  socsoNumber?: string;
  taxNumber?: string;
  taxCategory?: string;
  numChildren?: string;
  /** 35b7af0a group 7 — the SOCSO / EIS contribution categories item a7271737 made the single
   *  per-scheme control on the Personnel screen. 'auto' keeps the PERKESO derivation, 'none' is the
   *  scheme off, and SOCSO additionally offers 'first' / 'second'. */
  socsoCategory?: string;
  eisCategory?: string;
  /** LEGACY, kept so a draft saved before group 7 still opens and still creates the same employee.
   *  The wizard no longer writes it; completeEmployeeDraft maps 'no' forward to eisCategory 'none'. */
  eisEligible?: string;
  isResident?: string;
  epfCitizenship?: string;
};

export type EmployeeDraftPayroll = {
  basicSalary?: string;
  monthlyAllowance?: string;
  payMode?: string;
  paymentTerm?: string;
  rateAmount?: string;
  remarks?: string;
};

/**
 * ONE FAMILY MEMBER, CAPTURED ON A DRAFT — item 759dfc7d, work item 1.
 *
 * WHY IT LIVES IN THE BLOB AND NOWHERE ELSE. `employee_dependent` is keyed to a PERSON, and the whole
 * point of a draft is that no person exists yet ("a draft still creates no person and no employment" —
 * db/schema.ts employeeDraft). So a family member entered before Activate has literally nowhere else to
 * be stored, and `completeEmployeeDraft` materialises these entries into real rows at the moment the
 * person is created (core/dependents.ts `materialiseDependents`).
 *
 * THE FIELD SET IS `DependentInput`'s, NAME FOR NAME, and that is deliberate rather than convenient:
 * a draft field with no counterpart on the writer is a field HR types and Activate silently drops — the
 * exact failure this item exists to prevent. `test/employee-draft-family.test.ts` §2 asserts the two
 * shapes still agree, field by field, so adding a column to `employee_dependent` without adding it here
 * fails a test instead of losing somebody's spouse's employer address.
 *
 * BOOLEANS ARE BOOLEANS, unlike the string-typed sections above. Those are strings because they mirror
 * text inputs the wizard round-trips verbatim; a checkbox has no such intermediate form, and storing
 * 'yes'/'no' would add a second encoding for `materialiseDependents` to decode. jsonb holds both.
 * `childReliefPercentage` stays a STRING because its control is a `<select>` whose value is '100' | '50'
 * | '' — parsed once, at materialisation, exactly as `basicSalary` is.
 */
export type EmployeeDraftFamilyMember = {
  /** Stable per-row key for the editor's list. UI-only: `materialiseDependents` never reads it, and the
   *  natural key (name, relationship, date of birth) is what makes activation idempotent. */
  key?: string;
  fullName?: string;
  relationship?: string;
  dateOfBirth?: string;
  gender?: string;
  icOrPassport?: string;
  isBeneficiary?: boolean;
  phone?: string;
  remarks?: string;
  passportNumber?: string;
  residentialAddress?: string;
  isDeceased?: boolean;
  deceasedOn?: string;
  marriageDate?: string;
  marriageStatus?: string;
  spouseWorking?: boolean;
  occupation?: string;
  companyName?: string;
  employerAddress?: string;
  isStudent?: boolean;
  schoolName?: string;
  studyLevel?: string;
  studyCountry?: string;
  childReliefCategory?: string;
  childTaxRelief?: boolean;
  /** '100' | '50' | '' — the `<select>`'s own value; parsed at materialisation. */
  childReliefPercentage?: string;
};

export type EmployeeDraftData = {
  profile?: EmployeeDraftProfile;
  employment?: EmployeeDraftEmployment;
  statutory?: EmployeeDraftStatutory;
  payroll?: EmployeeDraftPayroll;
  /** Item 759dfc7d — the Family tab's records, held here until Activate creates the person they belong to. */
  family?: EmployeeDraftFamilyMember[];
};

/**
 * The draft's family list, defensively. `data` is jsonb and therefore opaque to SQL and to the type
 * system alike: a draft written before this item has no `family` at all, and nothing stops a hand-edited
 * row carrying an object or a string where an array belongs. Every reader goes through here so a
 * malformed blob reads as "no family" instead of throwing on `.map`.
 */
export function draftFamily(data: EmployeeDraftData): EmployeeDraftFamilyMember[] {
  const f = data.family;
  if (!Array.isArray(f)) return [];
  return f.filter((m): m is EmployeeDraftFamilyMember => !!m && typeof m === 'object' && !Array.isArray(m));
}

/**
 * The CONTINUE-A-DRAFT steps, in order. `key` doubles as the i18n key under `people.wizard.steps`.
 *
 * ITEM 06f0cb8f REMOVED `review`. It existed to gate one button at the end of a five-step form; the form
 * now ends at Activate, which is available from every step and is itself the review — it names exactly
 * what is outstanding and refuses until nothing is. A step whose only content is a list of what the
 * button beneath it already says is a step nobody reads.
 *
 * `profile` SURVIVES BUT MEANS SOMETHING NARROWER: Company, Full Name and Email left it for the Create
 * screen, so what remains is Profile Details — nationality, identity number, phone, date of birth,
 * gender, marital status. None of them is required by any writer, so this step now carries no required
 * field at all and shows a tick from the moment it opens. That is correct and deliberate: they are
 * details, and the reporter's complaint was exactly that details were blocking creation.
 *
 * ITEM 759dfc7d ADDS `family`, AND ADDS IT AT THE END rather than in the reporter's tab order. The tab
 * ORDER the reporter asked for is the screen's business (work item 2 of the plan re-points the tabs);
 * what may not move is the NUMBER each step is stored as — see STEP_NUMBERS below.
 */
export const DRAFT_STEPS = ['profile', 'employment', 'statutory', 'payroll', 'family'] as const;
export type DraftStepKey = (typeof DRAFT_STEPS)[number];

/**
 * THE STORED STEP NUMBER, DECLARED RATHER THAN COUNTED — and 5 IS BURNED.
 *
 * `employee_draft.current_step` is a pointer into a list that has already changed once. Until item
 * 06f0cb8f (c33d5518) the list was profile/employment/statutory/payroll/REVIEW and the wizard wrote
 * `indexOf(step) + 1`, so a draft left on the Review step is sitting in production RIGHT NOW as
 * `current_step = 5`. Removing `review` made 5 fall off the end and clamp to `payroll`, which is where
 * that cohort has reopened ever since.
 *
 * Numbering positionally would now hand 5 to `family` and silently move those drafts onto a tab they
 * have never seen. So the mapping is explicit, `family` is 6, and 5 stays retired: `stepKey(5)` still
 * resolves to `payroll`. The general rule below (a number naming no step resolves to the last step
 * BEFORE it) means the next step retired here costs nothing either.
 */
const STEP_NUMBERS: Record<DraftStepKey, number> = {
  profile: 1,
  employment: 2,
  statutory: 3,
  payroll: 4,
  family: 6,
};

/** 1-based step number ↔ key. `current_step` on the row is this number. */
export function stepNumber(key: DraftStepKey): number {
  return STEP_NUMBERS[key];
}
export function stepKey(n: number): DraftStepKey {
  const exact = DRAFT_STEPS.find((k) => STEP_NUMBERS[k] === n);
  if (exact) return exact;
  const first = DRAFT_STEPS[0];
  const last = DRAFT_STEPS[DRAFT_STEPS.length - 1];
  if (n <= STEP_NUMBERS[first]) return first;
  if (n >= STEP_NUMBERS[last]) return last;
  // A number INSIDE the range that names no step — today only the retired `review` slot. Resolve it to
  // the last step before it, so a draft parked on a step that no longer exists reopens where it has been
  // reopening rather than jumping forward onto whatever inherited its number.
  return [...DRAFT_STEPS].reverse().find((k) => STEP_NUMBERS[k] < n) ?? first;
}

const blank = (v: string | undefined) => (v ?? '').trim() === '';

/**
 * The Employee ID rule the draft is judged against (item bd271009), resolved from the LIVE setup by the
 * caller. Optional, and its ABSENCE is meaningful: omit the property and the Employee ID is not judged at
 * all. Two callers need exactly that — a screen spanning many companies with no single rule to apply, and
 * (item 06f0cb8f) any check made AFTER Create, where the ID is already held and settled.
 */
export type MissingOptions = { employeeIdRule?: EmployeeIdRule | null };

/** ISO yyyy-mm-dd, the only date shape any writer downstream accepts. */
export const DRAFT_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Field names (not messages) still outstanding before a Draft can be ACTIVATED, grouped by the step that
 * owns them. An empty array for a step is what puts a tick on it.
 *
 * Returns FIELD names so the caller translates; returning English here would put UI strings in a
 * module the server also imports.
 */
export function missingByStep(data: EmployeeDraftData): Record<DraftStepKey, string[]> {
  const p = data.profile ?? {};
  const e = data.employment ?? {};
  const pay = data.payroll ?? {};

  // PROFILE DETAILS HAS NO REQUIRED FIELD (item 06f0cb8f). Company, Full Name and Email moved to the
  // Create screen and are `missingToCreate`'s business; what is left here is optional in every writer
  // downstream. The one rule it keeps is a FORMAT rule: a date of birth that is not ISO cannot be stored,
  // so a typo is named on the step that owns it rather than at Activate.
  const profile: string[] = [];
  if (!blank(p.dateOfBirth) && !DRAFT_DATE_RE.test((p.dateOfBirth ?? '').trim())) profile.push('dateOfBirth');

  const employment: string[] = [];
  if (blank(e.departmentId)) employment.push('department');
  if (blank(e.employmentType)) employment.push('employmentType');
  if (blank(e.hiredOn)) employment.push('hiredOn');
  else if (!DRAFT_DATE_RE.test((e.hiredOn ?? '').trim())) employment.push('hiredOn');
  if (!blank(e.provisionalEndOn) && !DRAFT_DATE_RE.test((e.provisionalEndOn ?? '').trim()))
    employment.push('provisionalEndOn');

  // Bank & Statutory has no REQUIRED field of its own — every value on it is optional in the writers
  // that consume it. The one rule it does carry is the importer's: bank name and account number are
  // all-or-nothing, because half a bank instruction cannot pay anybody.
  const s = data.statutory ?? {};
  const statutory: string[] = [];
  if (blank(s.bankName) !== blank(s.bankAccountNo)) statutory.push('bankAccount');

  const payroll: string[] = [];
  const salary = Number((pay.basicSalary ?? '').replace(/[,_]/g, ''));
  if (blank(pay.basicSalary)) payroll.push('basicSalary');
  else if (!Number.isFinite(salary) || salary <= 0) payroll.push('basicSalary');
  // Mirrors setCompensation: a daily or hourly worker without a positive rate cannot be paid.
  if ((pay.payMode === 'daily' || pay.payMode === 'hourly') && !(Number(pay.rateAmount) > 0))
    payroll.push('rateAmount');

  // ── Family (item 759dfc7d) ──────────────────────────────────────────────────────────────────────
  // NO FAMILY MEMBER IS REQUIRED — most new joiners have nothing to record here, and a step that
  // demanded one would block every one of them. What IS required is that a member somebody DID add can
  // actually be written, because `materialiseDependents` runs AFTER `hireEmployee` has committed: a
  // nameless member discovered there fails an activation that has already created an employee, which is
  // the half-activated state this whole item exists to prevent. Judged here instead, where the cost of a
  // refusal is nothing, and re-judged on the server by `completeEmployeeDraft` before anything is written.
  //
  // The value-set rules (gender, the relationship catalog, marriage status, the relief category and
  // share) are NOT duplicated here: they need the tenant's catalog, so they belong to the server's
  // `assertDependentsValid`, which also runs before `hireEmployee`. Between them the two cover every
  // refusal the writer can make.
  const familySet = new Set<string>();
  for (const m of draftFamily(data)) {
    if (blank(m.fullName)) familySet.add('familyMemberName');
    if (blank(m.relationship)) familySet.add('familyMemberRelationship');
    // Every date the register stores. A value that is not ISO reaches Postgres as a `date` and throws
    // there — after the employee exists — so it is named here, on the step that owns it.
    for (const d of [m.dateOfBirth, m.marriageDate, m.deceasedOn]) {
      if (!blank(d) && !DRAFT_DATE_RE.test((d ?? '').trim())) familySet.add('familyMemberDate');
    }
  }
  const family = [...familySet];

  return { profile, employment, statutory, payroll, family };
}

/**
 * Flat list of everything outstanding on the continue-a-draft form. Empty ⇒ the Draft can be ACTIVATED.
 *
 * The name is kept (item 06f0cb8f) because this is still, literally, what creation needs — it is the
 * moment creation happens that moved. Renaming it would have made every call site read as if the rule
 * had changed, when what changed is that a second, much shorter rule now runs first.
 */
export function missingForCreation(data: EmployeeDraftData): string[] {
  const byStep = missingByStep(data);
  return DRAFT_STEPS.flatMap((k) => byStep[k]);
}

/**
 * The FOUR things Create asks for (item 06f0cb8f). Satisfying this reserves an Employee ID and produces
 * a Draft; it does not create a person, an employment or anything else.
 *
 * `opts.employeeIdRule` behaves exactly as it did on the old combined rule and for the same reason: its
 * ABSENCE means "do not judge the Employee ID at all". That is what a caller with no single rule to
 * apply needs — and, after Create, what a draft whose ID is ALREADY HELD needs, because a held code is
 * settled and re-asking whether it should have been typed by hand can only produce a false refusal.
 */
export function missingToCreate(data: EmployeeDraftData, opts: MissingOptions = {}): string[] {
  const p = data.profile ?? {};
  const e = data.employment ?? {};
  const out: string[] = [];
  // Company is FIRST, because it decides which Employee ID Auto Running Number Setup applies (item
  // bd271009) — and, from this item on, it is also fixed the moment Create succeeds: the held ID came
  // from this company's numbering rule, so changing the company afterwards would orphan the number.
  if (blank(e.companyId)) out.push('company');
  if ('employeeIdRule' in opts) {
    const decision = resolveEmployeeIdMode(opts.employeeIdRule, {
      chosen: p.employeeIdMode,
      hasCode: !blank(p.employeeCode),
    });
    if (decision.codeRequired && blank(p.employeeCode)) out.push('employeeCode');
  }
  if (blank(p.fullName)) out.push('fullName');
  if (blank(p.primaryEmail) || !EMAIL_RE.test((p.primaryEmail ?? '').trim())) out.push('primaryEmail');
  return out;
}

/** The drafts list needs a name even before one is typed; '' is rendered as "Untitled" by the screen. */
export function draftLabel(data: EmployeeDraftData): string {
  return (data.profile?.fullName ?? '').trim().slice(0, 200);
}
