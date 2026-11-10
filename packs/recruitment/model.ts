/**
 * Recruitment rules (slice 1) — pure, deterministic and client-safe. No database, no clock, no model.
 *
 * The service (./data.ts) runs every write through these functions and the database guards
 * (migration 4401) refuse the same illegal states independently, so a form that skips a check still
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
};
export type JobRequiredField = 'company' | 'title' | 'jobLevel' | 'workLocation' | 'recruitmentType' | 'employmentType';
export type ValidJob = {
  companyId: string; title: string; description: string | null; jobGradeIds: string[]; workLocation: string;
  recruitmentType: RecruitmentType; employmentType: JobEmploymentType; replacedEmploymentId: string | null;
  businessUnitId: string | null; departmentId: string | null; positionAttribute: PositionAttribute;
  processId: string | null; autoArchiveAfterReject: boolean;
};

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
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return {
    ok: true,
    value: {
      companyId: companyId!, title: title!, description: description ?? null, jobGradeIds: jobGradeIds as string[], workLocation: workLocation!,
      recruitmentType: recruitmentType!, employmentType: employmentType!, replacedEmploymentId: refs.replacedEmploymentId as string | null,
      businessUnitId: refs.businessUnitId as string | null, departmentId: refs.departmentId as string | null,
      positionAttribute: positionAttribute!, processId: refs.processId as string | null,
      autoArchiveAfterReject: input.autoArchiveAfterReject === true || input.autoArchiveAfterReject === 'on' || input.autoArchiveAfterReject === 'true',
    },
  };
}

/**
 * The job status machine: Open ↔ On hold, Open / On hold → Closed, and Closed → Open.
 * Reopening a closed job is a slice 1 IMPLEMENTATION DECISION (the reference did not show it); the
 * database guard in 4401 allows exactly the same five moves.
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

/** The job's process is fixed once the job has any application (F3; the 4401 guard refuses it too). */
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
