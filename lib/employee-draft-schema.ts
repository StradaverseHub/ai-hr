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

export type EmployeeDraftData = {
  profile?: EmployeeDraftProfile;
  employment?: EmployeeDraftEmployment;
  statutory?: EmployeeDraftStatutory;
  payroll?: EmployeeDraftPayroll;
};

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
 */
export const DRAFT_STEPS = ['profile', 'employment', 'statutory', 'payroll'] as const;
export type DraftStepKey = (typeof DRAFT_STEPS)[number];

/** 1-based step number ↔ key. `current_step` on the row is this number. */
export function stepNumber(key: DraftStepKey): number {
  return DRAFT_STEPS.indexOf(key) + 1;
}
export function stepKey(n: number): DraftStepKey {
  return DRAFT_STEPS[Math.min(Math.max(n, 1), DRAFT_STEPS.length) - 1];
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

  return { profile, employment, statutory, payroll };
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
