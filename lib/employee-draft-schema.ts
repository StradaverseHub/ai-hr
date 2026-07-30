/**
 * The Create New Employee wizard's shape and its completeness rules — item 6d671f44.
 *
 * Client-safe (no DB imports), because the SAME rules decide three things and they must not drift:
 *   - which steps show a tick and which show a warning, in the browser;
 *   - whether the Review step's "Create Employee" button is enabled;
 *   - whether `completeEmployeeDraft` will actually accept the draft, on the server.
 * The server re-runs `missingForCreation` authoritatively — this module is shared, not trusted.
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
 */

export type EmployeeDraftProfile = {
  fullName?: string;
  /** Optional BY DESIGN: blank means `hireEmployee` generates the next code at CREATION, which is the
   *  reporter's rule that a draft must not consume an Employee ID. */
  employeeCode?: string;
  primaryEmail?: string;
  phone?: string;
  gender?: string;
  dateOfBirth?: string;
  maritalStatus?: string;
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

/** The wizard's steps, in order. `key` doubles as the i18n key under `people.wizard.steps`. */
export const DRAFT_STEPS = ['profile', 'employment', 'statutory', 'payroll', 'review'] as const;
export type DraftStepKey = (typeof DRAFT_STEPS)[number];

/** 1-based step number ↔ key. `current_step` on the row is this number. */
export function stepNumber(key: DraftStepKey): number {
  return DRAFT_STEPS.indexOf(key) + 1;
}
export function stepKey(n: number): DraftStepKey {
  return DRAFT_STEPS[Math.min(Math.max(n, 1), DRAFT_STEPS.length) - 1];
}

const blank = (v: string | undefined) => (v ?? '').trim() === '';

/** ISO yyyy-mm-dd, the only date shape any writer downstream accepts. */
export const DRAFT_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Field names (not messages) that must be supplied before an employee can be created, grouped by the
 * step that owns them. An empty array for a step is what puts a tick on it.
 *
 * Returns FIELD names so the caller translates; returning English here would put UI strings in a
 * module the server also imports.
 */
export function missingByStep(data: EmployeeDraftData): Record<DraftStepKey, string[]> {
  const p = data.profile ?? {};
  const e = data.employment ?? {};
  const pay = data.payroll ?? {};

  const profile: string[] = [];
  if (blank(p.fullName)) profile.push('fullName');
  if (blank(p.primaryEmail)) profile.push('primaryEmail');
  else if (!EMAIL_RE.test((p.primaryEmail ?? '').trim())) profile.push('primaryEmail');
  if (!blank(p.dateOfBirth) && !DRAFT_DATE_RE.test((p.dateOfBirth ?? '').trim())) profile.push('dateOfBirth');

  const employment: string[] = [];
  if (blank(e.companyId)) employment.push('company');
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

  return { profile, employment, statutory, payroll, review: [] };
}

/** Flat list of everything outstanding. Empty ⇒ the draft can become an employee. */
export function missingForCreation(data: EmployeeDraftData): string[] {
  const byStep = missingByStep(data);
  return DRAFT_STEPS.flatMap((k) => byStep[k]);
}

/** The drafts list needs a name even before one is typed; '' is rendered as "Untitled" by the screen. */
export function draftLabel(data: EmployeeDraftData): string {
  return (data.profile?.fullName ?? '').trim().slice(0, 200);
}
