/**
 * Recruitment rules (slice 1) — pure, deterministic and client-safe. No database, no clock, no model.
 *
 * The service (./data.ts) runs every write through these functions and the database guards
 * (migration 5201) refuse the same illegal states independently, so a form that skips a check still
 * cannot write one. Names of stages, the process and archive reasons below are EDITABLE SEED DEFAULTS
 * a company receives once; behaviour never keys off a name, only off ids, types and system keys.
 */
import { PERSONNEL_EMPLOYMENT_TYPES } from '../../lib/personnel-choice-vocabulary';

export const RECRUITMENT_STAGE_TYPES = ['system_default', 'screening', 'interview', 'offer', 'test', 'none'] as const;
export type RecruitmentStageType = (typeof RECRUITMENT_STAGE_TYPES)[number];
export const JOB_STATUSES = ['open', 'on_hold', 'closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const POSITION_ATTRIBUTES = ['regular', 'evergreen'] as const;
export type PositionAttribute = (typeof POSITION_ATTRIBUTES)[number];
export const RECRUITMENT_TYPES = ['budgeted', 'unbudgeted', 'replacement'] as const;
export type RecruitmentType = (typeof RECRUITMENT_TYPES)[number];
export const JOB_EMPLOYMENT_TYPES = PERSONNEL_EMPLOYMENT_TYPES;
export type JobEmploymentType = (typeof JOB_EMPLOYMENT_TYPES)[number];
export const JOB_MEMBER_ROLES = ['recruiter', 'assistant', 'hiring_manager', 'interviewer'] as const;
export type JobMemberRole = (typeof JOB_MEMBER_ROLES)[number];
export const APPLICATION_STATES = ['active', 'hired', 'archived'] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];
export const SYSTEM_STAGE_KEYS = ['application_review', 'onboarding'] as const;
export type SystemStageKey = (typeof SYSTEM_STAGE_KEYS)[number];

/** Seed defaults: the stage catalogue, in process order. Hired and Archived are terminal STATES, not stages. */
export const DEFAULT_STAGES: readonly { seedKey: string; name: string; type: RecruitmentStageType; systemKey?: SystemStageKey }[] = [
  { seedKey: 'application_review', name: 'Application Review', type: 'system_default', systemKey: 'application_review' },
  { seedKey: 'recruiter_screening', name: "Recruiter's Screening", type: 'screening' },
  { seedKey: 'ai_interview', name: 'AI Interview', type: 'test' },
  { seedKey: 'hiring_manager_review', name: 'Hiring Manager Review', type: 'screening' },
  { seedKey: 'interview', name: 'Interview', type: 'interview' },
  { seedKey: 'offer', name: 'Offer', type: 'offer' },
  { seedKey: 'medical_check_up', name: 'Medical check-up', type: 'none' },
  { seedKey: 'background_check', name: 'Background check', type: 'none' },
  { seedKey: 'onboarding', name: 'Onboarding', type: 'system_default', systemKey: 'onboarding' },
];
export const DEFAULT_PROCESS = { seedKey: 'recruitment_process', name: 'Recruitment process' } as const;
/** The seven default archive reasons: the internal reason HR picks and the external reason a candidate may see. */
export const DEFAULT_ARCHIVE_REASONS: readonly { seedKey: string; internal: string; external: string }[] = [
  { seedKey: 'skills_mismatch', internal: 'Lack of capacity', external: 'Skills or experience mismatch' },
  { seedKey: 'no_response', internal: 'No response', external: 'No response' },
  { seedKey: 'requisition_changed', internal: 'Job requisition has been changed', external: 'Job requisition has been changed' },
  { seedKey: 'package_mismatch', internal: 'Package mismatch', external: 'Package mismatch' },
  { seedKey: 'culture_mismatch', internal: 'Company culture mismatch', external: 'Company culture mismatch' },
  { seedKey: 'reject', internal: 'Reject', external: 'Reject' },
  { seedKey: 'other', internal: 'Other', external: 'Other' },
];

/** Every refusal the recruitment service can give, as a stable code the screens translate. */
export const RECRUITMENT_ERROR_CODES = [
  'forbidden', 'not_found', 'missing_fields', 'invalid_input', 'invalid_status_change', 'process_locked',
  'process_unavailable', 'stage_not_in_process', 'stage_unavailable', 'reason_required', 'application_closed',
  'job_closed', 'duplicate_application', 'system_stage', 'reason_in_use', 'default_reason',
  // Slices 2–4.
  'not_interviewer', 'feedback_locked', 'interview_closed', 'invalid_form', 'form_in_use', 'self_approval', 'not_your_step',
  'offer_state', 'offer_closed', 'approval_pending', 'requisition_terminal', 'hire_not_eligible', 'hire_linked', 'not_in_pool',
  // Slice 5.
  'possible_duplicate', 'repeat_application', 'candidate_removed', 'file_type', 'file_too_large', 'permission_required', 'not_due',
  'confirm_required', 'consent_state', 'tag_disabled',
  // Slice 6.
  'period_invalid', 'period_too_long', 'report_too_slow',
  // Slice 7: every database refusal of a referral reaches the referrer as this one code (D-023).
  'referral_refused',
  // Slice 8: the careers page address is used by another company; the page cannot be published yet (missing items).
  'careers_address_taken', 'careers_incomplete',
  // Slice 10: a name already used in the company; a tag on an agency; a contract not usable (disabled, outside its period,
  // not released to the user, or not assigned to the job); an HR contact without recruitment administration; the same
  // agency already submitted the person to the job; a submission already decided; a consultant who is not active.
  'name_taken', 'tag_in_use', 'contract_unavailable', 'contact_invalid', 'repeat_submission', 'submission_decided', 'consultant_unavailable',
  // …the recorder's 50 agency submission attempts for today (Kuala Lumpur) are used; another session is changing the same
  // candidate (a lock wait gave up or a deadlock was broken) — try again.
  'agency_daily_limit', 'candidate_busy',
  // Slice 11: a chosen reviewer is not a hiring manager of the job; the job has no hiring manager to send to; the screening
  // request was withdrawn or already answered; only the named reviewer answers; one selection spans several jobs.
  'not_hiring_manager', 'no_hiring_manager', 'screening_closed', 'not_your_request', 'mixed_jobs',
  // Slice 12: a background check is added only at or after the job's Offer stage (or a background-check stage); the check is
  // completed or cancelled (final); the action does not fit the check's status; the authorisation must be recorded first; a
  // chosen type is disabled or not the company's; a type in use cannot be deleted.
  'check_stage', 'check_closed', 'check_state', 'authorisation_required', 'check_type_unavailable', 'type_in_use',
  // Slice 13: the application needs an administrator's review (a blocked-list mark) before it moves, gets an offer or is hired;
  // the candidate is already on the blocked list; the entry was already removed; the mark was already cleared; pools nest two
  // levels (and a sub-pool follows its pool's sharing); a pool with sub-pools is deleted only after them.
  'needs_review', 'already_blocked', 'blocked_entry_removed', 'mark_cleared', 'pool_depth', 'pool_has_subpools',
  // …and a listed person's data is not removed while their entry holds a review on another candidate's active application.
  'blocked_entry_has_open_marks',
  // …"Not the same person" does not apply to the listed person's own marks (only removing the entry resolves those).
  'own_entry_mark',
  // Slice 14: a field's name or help text names a sensitive category (D-052); a field with values keeps its type and restricted
  // setting and cannot be deleted; an option in use cannot be deleted (disable it); a required custom field is empty; a custom
  // value does not fit its field (type, range, decimals or options); the company already has the most fields or options.
  'sensitive_field', 'field_in_use', 'option_in_use', 'custom_field_required', 'custom_value_invalid', 'custom_field_limit',
  // …a required choice field needs an enabled option (making it required, disabling or deleting its last enabled option).
  'required_needs_option',
  // Slice 15: the position template is disabled, deleted, of another company, or templates are off for the company; the company
  // already has the most templates.
  'template_unavailable', 'template_limit',
  // Slice 16: the import file cannot be read as an import (detail: the reason); the file is not the one previewed; the caller
  // already has an import running; the import already ended; the candidate is not on the To assign list; the job is not Open;
  // an export has more rows than allowed (narrow the filters).
  'import_file_invalid', 'import_changed', 'import_running', 'import_finished', 'not_to_assign', 'job_not_open', 'export_too_large',
  // …another export of the person (or too many in the tenant) is running; an export or a preview ran out of time (narrow the
  // filters / split the file); the person's previews for today are used.
  'export_busy', 'export_too_slow', 'import_too_heavy', 'import_preview_limit',
  // Slice 18: an interviewer group is not the company's (or was deleted); a question linked to a scorecard template cannot be
  // deleted (retire it); a retired question cannot be linked; an address or room some interview uses cannot be deleted (disable the
  // room); a room is disabled, of another address or company, or not for this kind of interview; the room is already booked at an
  // overlapping time; a map link is not https; the company already has the most groups, questions, addresses or rooms (or a
  // template the most questions); the chosen groups leave no one who can interview.
  'group_unavailable', 'question_in_use', 'question_retired', 'address_in_use', 'room_in_use', 'room_unavailable', 'room_booked',
  'map_link_https', 'setup_limit', 'no_interviewers',
] as const;
export type RecruitmentErrorCode = (typeof RECRUITMENT_ERROR_CODES)[number];

export class RecruitmentError extends Error {
  constructor(public readonly code: RecruitmentErrorCode, public readonly detail?: readonly string[]) {
    super(`recruitment:${code}${detail?.length ? `:${detail.join(',')}` : ''}`);
    this.name = 'RecruitmentError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
};
const member = <T extends string>(set: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (set as readonly string[]).includes(value) ? (value as T) : null;

/** The job fields a person enters. Everything arrives as untrusted form text. */
export type JobInput = {
  companyId?: unknown; title?: unknown; description?: unknown; jobGradeIds?: unknown; workLocation?: unknown;
  recruitmentType?: unknown; employmentType?: unknown; replacedEmploymentId?: unknown; businessUnitId?: unknown;
  departmentId?: unknown; positionAttribute?: unknown; processId?: unknown; autoArchiveAfterReject?: unknown;
  /** Slice 15: the interview plan's scorecard templates in round order (empty entries are left out); undefined = unchanged. */
  interviewPlanFormIds?: unknown;
};
export type JobRequiredField = 'company' | 'title' | 'jobLevel' | 'workLocation' | 'recruitmentType' | 'employmentType';
export type ValidJob = {
  companyId: string; title: string; description: string | null; jobGradeIds: string[]; workLocation: string;
  recruitmentType: RecruitmentType; employmentType: JobEmploymentType; replacedEmploymentId: string | null;
  businessUnitId: string | null; departmentId: string | null; positionAttribute: PositionAttribute;
  processId: string | null; autoArchiveAfterReject: boolean;
  /** Slice 15: the interview plan, one evaluation form per round in order; undefined when the form did not carry it. */
  interviewPlanFormIds: string[] | undefined;
};

/** Slice 15: the most rounds an interview plan holds (job or template). */
export const INTERVIEW_PLAN_MAX = 10;
/** Slice 15: the form marker that says a form carried the interview plan (without it, a job's plan is left as it is). */
export const INTERVIEW_PLAN_FORM_MARKER = 'ip.present';
/**
 * An interview plan from a form: the chosen scorecard template of each round, in order. The plan has no gaps: empty rounds may only
 * END it (trailing empty rounds are dropped); an empty round followed by a filled one is refused rather than silently renumbering
 * the later rounds (owner ruling, slice 15 review). The same form may serve several rounds. Null when it has a gap, is longer than
 * INTERVIEW_PLAN_MAX or names something that is not an id.
 */
export function parseInterviewPlan(value: unknown): string[] | null {
  const raw = (Array.isArray(value) ? value : value == null ? [] : [value]).map((x) => (typeof x === 'string' ? x.trim() : x));
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === '' || raw[end - 1] == null)) end--;
  const list = raw.slice(0, end);
  if (list.length > INTERVIEW_PLAN_MAX || !list.every(isUuid)) return null;
  return list as string[];
}
/** The interview plan a form carried (`INTERVIEW_PLAN_FORM_MARKER` present), or undefined when it did not (a job's plan is then left
 *  as it is — the Job info form carries no plan). */
export function interviewPlanFromForm(form: Pick<FormData, 'has' | 'getAll'>): string[] | undefined {
  return form.has(INTERVIEW_PLAN_FORM_MARKER) ? form.getAll('interviewPlanFormIds').map(String) : undefined;
}

const optionalId = (value: unknown): string | null | 'invalid' =>
  value == null || value === '' ? null : isUuid(value) ? value : 'invalid';

/**
 * Validate a job. The six required fields (title, job level, work location, recruitment type, employment
 * type and company) are refused here when missing, whatever the form did. `processId` may be omitted: the
 * service then uses the company's default process.
 */
export function validateJobInput(input: JobInput): { ok: true; value: ValidJob } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const missing: JobRequiredField[] = [];
  const companyId = isUuid(input.companyId) ? input.companyId : null;
  if (!companyId) missing.push('company');
  const title = clean(input.title, 200);
  if (!title) missing.push('title');
  const grades = (Array.isArray(input.jobGradeIds) ? input.jobGradeIds : input.jobGradeIds == null || input.jobGradeIds === '' ? [] : [input.jobGradeIds])
    .filter((id) => id !== '');
  const jobGradeIds = [...new Set(grades)];
  if (!jobGradeIds.length) missing.push('jobLevel');
  const workLocation = clean(input.workLocation, 200);
  if (!workLocation) missing.push('workLocation');
  const recruitmentType = member(RECRUITMENT_TYPES, input.recruitmentType);
  if (!recruitmentType) missing.push('recruitmentType');
  const employmentType = member(JOB_EMPLOYMENT_TYPES, input.employmentType);
  if (!employmentType) missing.push('employmentType');
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };

  const invalid: string[] = [];
  if (jobGradeIds.length > 50 || !jobGradeIds.every(isUuid)) invalid.push('jobLevel');
  const description = input.description == null || input.description === '' ? null : typeof input.description === 'string' && input.description.length <= 20000 ? input.description : undefined;
  if (description === undefined) invalid.push('description');
  const positionAttribute = input.positionAttribute == null || input.positionAttribute === '' ? 'regular' : member(POSITION_ATTRIBUTES, input.positionAttribute);
  if (!positionAttribute) invalid.push('positionAttribute');
  const refs = { replacedEmploymentId: optionalId(input.replacedEmploymentId), businessUnitId: optionalId(input.businessUnitId), departmentId: optionalId(input.departmentId), processId: optionalId(input.processId) };
  for (const [key, value] of Object.entries(refs)) if (value === 'invalid') invalid.push(key);
  const interviewPlanFormIds = input.interviewPlanFormIds === undefined ? undefined : parseInterviewPlan(input.interviewPlanFormIds);
  if (interviewPlanFormIds === null) invalid.push('interviewPlan');
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return {
    ok: true,
    value: {
      companyId: companyId!, title: title!, description: description ?? null, jobGradeIds: jobGradeIds as string[], workLocation: workLocation!,
      recruitmentType: recruitmentType!, employmentType: employmentType!, replacedEmploymentId: refs.replacedEmploymentId as string | null,
      businessUnitId: refs.businessUnitId as string | null, departmentId: refs.departmentId as string | null,
      positionAttribute: positionAttribute!, processId: refs.processId as string | null,
      autoArchiveAfterReject: input.autoArchiveAfterReject === true || input.autoArchiveAfterReject === 'on' || input.autoArchiveAfterReject === 'true',
      interviewPlanFormIds: interviewPlanFormIds ?? undefined,
    },
  };
}

/**
 * The job status machine: Open ↔ On hold, Open / On hold → Closed, and Closed → Open.
 * Reopening a closed job is a slice 1 IMPLEMENTATION DECISION (the reference did not show it); the
 * database guard in 5201 allows exactly the same five moves.
 */
export const JOB_STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  open: ['on_hold', 'closed'],
  on_hold: ['open', 'closed'],
  closed: ['open'],
};
export function canChangeJobStatus(from: JobStatus, to: JobStatus): boolean {
  return JOB_STATUS_TRANSITIONS[from].includes(to);
}
/** The Opening tab holds Open and On hold jobs; the Closed tab holds Closed jobs. */
export const jobTab = (status: JobStatus): 'opening' | 'closed' => (status === 'closed' ? 'closed' : 'opening');

/** A process's stage as the movement rules see it. */
export type ProcessStage = { stageId: string; position: number; enabled: boolean };

/** The process's enabled stages in order. A disabled stage is skipped by every move; applications already in it stay. */
export function enabledStagesInOrder(stages: readonly ProcessStage[]): ProcessStage[] {
  return [...stages].filter((s) => s.enabled).sort((a, b) => a.position - b.position);
}

/** Where a new application starts: the first enabled stage of the job's process. */
export function firstStage(stages: readonly ProcessStage[]): string | null {
  return enabledStagesInOrder(stages)[0]?.stageId ?? null;
}

export type MovePlan = { kind: 'moved'; from: string; to: string } | { kind: 'hired'; from: string };

/**
 * Move forward: the next ENABLED stage after the current one in the job's process; from the last enabled
 * stage the application is hired. The current stage itself may have been disabled since the application
 * entered it — it still has a position, so "next" is still defined.
 */
export function planMoveForward(stages: readonly ProcessStage[], currentStageId: string): MovePlan {
  const current = stages.find((s) => s.stageId === currentStageId);
  if (!current) throw new RecruitmentError('stage_not_in_process');
  const next = enabledStagesInOrder(stages).find((s) => s.position > current.position);
  return next ? { kind: 'moved', from: currentStageId, to: next.stageId } : { kind: 'hired', from: currentStageId };
}

/** Move to a chosen stage: any enabled stage of the job's process other than the current one. */
export function planMoveTo(stages: readonly ProcessStage[], currentStageId: string, targetStageId: string): MovePlan {
  if (!stages.some((s) => s.stageId === currentStageId)) throw new RecruitmentError('stage_not_in_process');
  const target = stages.find((s) => s.stageId === targetStageId);
  if (!target) throw new RecruitmentError('stage_not_in_process');
  if (!target.enabled || target.stageId === currentStageId) throw new RecruitmentError('stage_unavailable');
  return { kind: 'moved', from: currentStageId, to: target.stageId };
}

/** Reject: an archive reason is mandatory, and the stage left is kept. */
export function planReject(currentStageId: string, archiveReasonId: unknown): { stageLeft: string; reasonId: string } {
  if (!isUuid(archiveReasonId)) throw new RecruitmentError('reason_required');
  return { stageLeft: currentStageId, reasonId: archiveReasonId };
}

/** The new candidate fields of an "add application" form. */
export type CandidateInput = { fullName?: unknown; email?: unknown; phone?: unknown; source?: unknown };
export function validateCandidateInput(input: CandidateInput): { ok: true; value: { fullName: string; email: string | null; phone: string | null; source: string | null } } | { ok: false; fields: string[] } {
  const fullName = clean(input.fullName, 200);
  const emailText = input.email == null || input.email === '' ? null : clean(input.email, 254)?.toLowerCase() ?? '';
  const phone = input.phone == null || input.phone === '' ? null : clean(input.phone, 40) ?? '';
  const source = input.source == null || input.source === '' ? null : clean(input.source, 120) ?? '';
  const fields: string[] = [];
  if (!fullName) fields.push('fullName');
  if (emailText === '' || (emailText && !/^[^\s@]+@[^\s@]+$/.test(emailText))) fields.push('email');
  if (phone === '') fields.push('phone');
  if (source === '') fields.push('source');
  return fields.length ? { ok: false, fields } : { ok: true, value: { fullName: fullName!, email: emailText, phone, source } };
}

/** The job's process is fixed once the job has any application (F3; the 5201 guard refuses it too). */
export function processChangeRefused(currentProcessId: string, requestedProcessId: string, hasApplications: boolean): boolean {
  return requestedProcessId !== currentProcessId && hasApplications;
}

/** One history row per move, as the append-only event table stores it (actor and time are added by the database). */
export type HistoryEvent =
  | { kind: 'applied'; fromStageId: null; toStageId: string; fromState: null; toState: 'active'; archiveReasonId: null }
  | { kind: 'moved'; fromStageId: string; toStageId: string; fromState: 'active'; toState: 'active'; archiveReasonId: null }
  | { kind: 'hired'; fromStageId: string; toStageId: null; fromState: 'active'; toState: 'hired'; archiveReasonId: null }
  | { kind: 'rejected'; fromStageId: string; toStageId: null; fromState: 'active'; toState: 'archived'; archiveReasonId: string };
export function appliedEvent(startStageId: string): HistoryEvent {
  return { kind: 'applied', fromStageId: null, toStageId: startStageId, fromState: null, toState: 'active', archiveReasonId: null };
}
export function moveEvent(plan: MovePlan): HistoryEvent {
  return plan.kind === 'hired'
    ? { kind: 'hired', fromStageId: plan.from, toStageId: null, fromState: 'active', toState: 'hired', archiveReasonId: null }
    : { kind: 'moved', fromStageId: plan.from, toStageId: plan.to, fromState: 'active', toState: 'active', archiveReasonId: null };
}
export function rejectEvent(reject: { stageLeft: string; reasonId: string }): HistoryEvent {
  return { kind: 'rejected', fromStageId: reject.stageLeft, toStageId: null, fromState: 'active', toState: 'archived', archiveReasonId: reject.reasonId };
}
