/**
 * The Recruitment pack's satellite tables (ADR-0080 D5/D11) as the service reads and writes them. The DDL,
 * keys, row security, grants and guards are owned by db/migrations/4401_recruitment_core.sql and 4402–4404; these
 * declarations carry no references or checks of their own so they can never disagree with it.
 */
import { boolean, customType, date, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ApplicationState, JobEmploymentType, JobMemberRole, JobStatus, PositionAttribute, RecruitmentStageType, RecruitmentType, SystemStageKey } from './model';
import type {
  ApprovalDecision, CandidateDecision, CandidateResponse, CriterionRating, EvaluationFormDefinition, EvaluationResult, FeedbackEditLock,
  InterviewType, OfferFieldType, OfferSendChannel, OfferStatus, RequisitionApprovalStatus, RequisitionStatus,
} from './hiring-model';
import type { CandidateFileKind, CandidateSource, ConsentMethod, ConsentStatus, EducationLevel, EntryKind, IdType } from './privacy-model';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const audit = {
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
};

export const recruitmentStage = pgTable('recruitment_stage', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  stageType: text('stage_type').$type<RecruitmentStageType>().notNull(),
  systemKey: text('system_key').$type<SystemStageKey>(),
  enabled: boolean('enabled').notNull().default(true),
  seedKey: text('seed_key'),
  ...audit,
});

export const recruitmentProcess = pgTable('recruitment_process', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  seedKey: text('seed_key'),
  ...audit,
});

export const recruitmentProcessStage = pgTable('recruitment_process_stage', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  processId: uuid('process_id').notNull(),
  stageId: uuid('stage_id').notNull(),
  position: integer('position').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const recruitmentArchiveReason = pgTable('recruitment_archive_reason', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  internalReason: text('internal_reason').notNull(),
  externalReason: text('external_reason').notNull(),
  kind: text('kind').$type<'default' | 'custom'>().notNull(),
  displayed: boolean('displayed').notNull().default(true),
  position: integer('position').notNull().default(1000),
  seedKey: text('seed_key'),
  ...audit,
});

export const recruitmentJobOpening = pgTable('recruitment_job_opening', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** Allocated by the database guard; the value sent on insert is replaced. */
  jobNumber: text('job_number').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  jobGradeIds: uuid('job_grade_ids').array().notNull(),
  workLocation: text('work_location').notNull(),
  recruitmentType: text('recruitment_type').$type<RecruitmentType>().notNull(),
  employmentType: text('employment_type').$type<JobEmploymentType>().notNull(),
  replacedEmploymentId: uuid('replaced_employment_id'),
  businessUnitId: uuid('business_unit_id'),
  departmentId: uuid('department_id'),
  status: text('status').$type<JobStatus>().notNull().default('open'),
  positionAttribute: text('position_attribute').$type<PositionAttribute>().notNull(),
  processId: uuid('process_id').notNull(),
  autoArchiveAfterReject: boolean('auto_archive_after_reject').notNull().default(false),
  statusChangedAt: ts('status_changed_at').notNull().defaultNow(),
  ...audit,
});

export const recruitmentJobMember = pgTable('recruitment_job_member', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  memberRole: text('member_role').$type<JobMemberRole>().notNull(),
  appUserId: uuid('app_user_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

export const recruitmentCandidate = pgTable('recruitment_candidate', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  fullName: text('full_name').notNull(),
  email: text('email'),
  phone: text('phone'),
  ownerUserId: uuid('owner_user_id'),
  // Slice 5 (4405): the profile and the removal marker.
  location: text('location'),
  currentCompany: text('current_company'),
  currentTitle: text('current_title'),
  highestEducation: text('highest_education').$type<EducationLevel>(),
  noticePeriod: text('notice_period'),
  source: text('source').$type<CandidateSource>(),
  destroyedAt: ts('destroyed_at'),
  destroyedByUserId: uuid('destroyed_by_user_id'),
  ...audit,
});

export const recruitmentApplication = pgTable('recruitment_application', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  currentStageId: uuid('current_stage_id').notNull(),
  state: text('state').$type<ApplicationState>().notNull().default('active'),
  archiveReasonId: uuid('archive_reason_id'),
  stageLeftAtArchive: uuid('stage_left_at_archive'),
  source: text('source'),
  appliedAt: ts('applied_at').notNull().defaultNow(),
  stateChangedAt: ts('state_changed_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
});

export const recruitmentApplicationEvent = pgTable('recruitment_application_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  kind: text('kind').$type<'applied' | 'moved' | 'rejected' | 'hired'>().notNull(),
  fromStageId: uuid('from_stage_id'),
  toStageId: uuid('to_stage_id'),
  fromState: text('from_state').$type<ApplicationState>(),
  toState: text('to_state').$type<ApplicationState>().notNull(),
  archiveReasonId: uuid('archive_reason_id'),
  actorUserId: uuid('actor_user_id').notNull(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
});

// ── Slice 2 (db/migrations/4402_recruitment_team_interviews.sql) ──────────────────────────────────────────

export const recruitmentCompanySetting = pgTable('recruitment_company_setting', {
  companyId: uuid('company_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  scorecardsPrivate: boolean('scorecards_private').notNull().default(true),
  feedbackEditLock: text('feedback_edit_lock').$type<FeedbackEditLock>().notNull().default('until_stage_left'),
  resultRequired: boolean('result_required').notNull().default(true),
  // Slice 3 (4403).
  offerValidDays: integer('offer_valid_days').notNull().default(15),
  offerAcceptMovesForward: boolean('offer_accept_moves_forward').notNull().default(false),
  offerDeclineArchives: boolean('offer_decline_archives').notNull().default(false),
  // Slice 5 (4405).
  retentionMonthsWithoutConsent: integer('retention_months_without_consent').notNull().default(6),
  retentionMonthsWithConsent: integer('retention_months_with_consent').notNull().default(24),
  repeatWindowMonths: integer('repeat_window_months').notNull().default(3),
  ...audit,
});

export const recruitmentEvaluationForm = pgTable('recruitment_evaluation_form', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  definition: jsonb('definition').$type<EvaluationFormDefinition>().notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  seedKey: text('seed_key'),
  ...audit,
});

export const recruitmentInterview = pgTable('recruitment_interview', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  stageId: uuid('stage_id').notNull(),
  roundNo: integer('round_no').notNull(),
  interviewType: text('interview_type').$type<InterviewType>().notNull(),
  startsAt: ts('starts_at').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  site: text('site'),
  meetingRoom: text('meeting_room'),
  evaluationFormId: uuid('evaluation_form_id').notNull(),
  candidateResponse: text('candidate_response').$type<CandidateResponse>().notNull().default('pending'),
  cancelledAt: ts('cancelled_at'),
  cancelledByUserId: uuid('cancelled_by_user_id'),
  ...audit,
});

export const recruitmentInterviewInterviewer = pgTable('recruitment_interview_interviewer', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  interviewId: uuid('interview_id').notNull(),
  appUserId: uuid('app_user_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

export const recruitmentScorecard = pgTable('recruitment_scorecard', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  interviewId: uuid('interview_id').notNull(),
  interviewerUserId: uuid('interviewer_user_id').notNull(),
  evaluationFormId: uuid('evaluation_form_id').notNull(),
  ratings: jsonb('ratings').$type<Record<string, CriterionRating>>().notNull(),
  result: text('result').$type<EvaluationResult>(),
  overview: text('overview'),
  submittedAt: ts('submitted_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ── Slice 3 (db/migrations/4403_recruitment_offers_hire_handoff.sql) ──────────────────────────────────────

export const recruitmentOfferField = pgTable('recruitment_offer_field', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  label: text('label').notNull(),
  fieldType: text('field_type').$type<OfferFieldType>().notNull(),
  choices: text('choices').array().notNull(),
  required: boolean('required').notNull().default(false),
  needsApproval: boolean('needs_approval').notNull().default(false),
  private: boolean('private').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  position: integer('position').notNull().default(1000),
  seedKey: text('seed_key'),
  ...audit,
});

export const recruitmentApprovalStep = pgTable('recruitment_approval_step', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  flowKind: text('flow_kind').$type<'offer' | 'requisition'>().notNull(),
  position: integer('position').notNull(),
  approverUserId: uuid('approver_user_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

export const recruitmentOffer = pgTable('recruitment_offer', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  status: text('status').$type<OfferStatus>().notNull().default('draft'),
  approvalRound: integer('approval_round').notNull().default(0),
  /** The current round's ordered approvers and the pending step's position (null when none is pending). */
  approverUserIds: uuid('approver_user_ids').array().notNull().default([]),
  pendingPosition: integer('pending_position'),
  lastRejectionComment: text('last_rejection_comment'),
  sentAt: ts('sent_at'),
  sentChannel: text('sent_channel').$type<OfferSendChannel>(),
  sentByUserId: uuid('sent_by_user_id'),
  validDays: integer('valid_days'),
  candidateDecision: text('candidate_decision').$type<CandidateDecision>().notNull().default('pending'),
  decidedAt: ts('decided_at'),
  decidedByUserId: uuid('decided_by_user_id'),
  ...audit,
});

export const recruitmentOfferValue = pgTable('recruitment_offer_value', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  offerId: uuid('offer_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  valueText: text('value_text'),
  // Decimals stay strings end to end (numeric columns): money is never a float.
  valueNumber: numeric('value_number', { precision: 16, scale: 4 }),
  valueDate: date('value_date'),
  valueAmount: numeric('value_amount', { precision: 18, scale: 2 }),
  currency: text('currency'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
});

/** The approval decision log: one row per decided step, written by that step's approver (4403/4404). */
const approvalColumns = {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  round: integer('round').notNull(),
  position: integer('position').notNull(),
  approverUserId: uuid('approver_user_id').notNull(),
  decision: text('decision').$type<ApprovalDecision>().notNull(),
  comment: text('comment'),
  actedAt: ts('acted_at').notNull().defaultNow(),
};

export const recruitmentOfferApproval = pgTable('recruitment_offer_approval', {
  ...approvalColumns,
  jobId: uuid('job_id').notNull(),
  offerId: uuid('offer_id').notNull(),
});

export const recruitmentHireHandoff = pgTable('recruitment_hire_handoff', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  employeeDraftId: uuid('employee_draft_id').notNull(),
  reservedEmployeeCode: text('reserved_employee_code'),
  linkedAt: ts('linked_at').notNull().defaultNow(),
  linkedByUserId: uuid('linked_by_user_id').notNull(),
});

// ── Slice 4 (db/migrations/4404_recruitment_requisitions.sql) ─────────────────────────────────────────────

export const recruitmentRequisition = pgTable('recruitment_requisition', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** Allocated by the database guard; the value sent on insert is replaced. */
  reqNumber: text('req_number').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  vacancies: integer('vacancies').notNull(),
  jobGradeIds: uuid('job_grade_ids').array().notNull(),
  hiringManagerUserId: uuid('hiring_manager_user_id'),
  partnerUserId: uuid('partner_user_id'),
  recruiterUserId: uuid('recruiter_user_id'),
  workLocation: text('work_location').notNull(),
  employmentType: text('employment_type').notNull(),
  recruitmentType: text('recruitment_type').notNull(),
  replacedEmploymentId: uuid('replaced_employment_id'),
  departmentId: uuid('department_id'),
  dateOpened: date('date_opened'),
  targetOnboardDate: date('target_onboard_date'),
  yearsExperience: integer('years_experience'),
  education: text('education'),
  salaryMin: numeric('salary_min', { precision: 18, scale: 2 }),
  salaryMax: numeric('salary_max', { precision: 18, scale: 2 }),
  salaryCurrency: text('salary_currency'),
  workingDays: text('working_days'),
  workingHours: text('working_hours'),
  mandatorySkills: text('mandatory_skills'),
  preferredSkills: text('preferred_skills'),
  benefits: text('benefits'),
  status: text('status').$type<RequisitionStatus>().notNull().default('draft'),
  approvalStatus: text('approval_status').$type<RequisitionApprovalStatus>().notNull().default('not_submitted'),
  approvalRound: integer('approval_round').notNull().default(0),
  approverUserIds: uuid('approver_user_ids').array().notNull().default([]),
  pendingPosition: integer('pending_position'),
  statusChangedAt: ts('status_changed_at').notNull().defaultNow(),
  ...audit,
});

export const recruitmentRequisitionApproval = pgTable('recruitment_requisition_approval', {
  ...approvalColumns,
  requisitionId: uuid('requisition_id').notNull(),
});

export const recruitmentRequisitionJob = pgTable('recruitment_requisition_job', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  requisitionId: uuid('requisition_id').notNull(),
  jobId: uuid('job_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

// ── Slice 5 (db/migrations/4405_recruitment_candidate_privacy.sql) ───────────────────────────────────────────

const bytea = customType<{ data: Buffer; driver: Buffer }>({ dataType: () => 'bytea' });

export const recruitmentCandidateRestricted = pgTable('recruitment_candidate_restricted', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  currentSalaryAmount: numeric('current_salary_amount', { precision: 18, scale: 2 }),
  currentSalaryCurrency: text('current_salary_currency'),
  expectedSalaryAmount: numeric('expected_salary_amount', { precision: 18, scale: 2 }),
  expectedSalaryCurrency: text('expected_salary_currency'),
  idType: text('id_type').$type<IdType>(),
  idNumber: text('id_number'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
});

export const recruitmentCandidateEntry = pgTable('recruitment_candidate_entry', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  kind: text('kind').$type<EntryKind>().notNull(),
  organisation: text('organisation').notNull(),
  title: text('title'),
  fromMonth: date('from_month'),
  toMonth: date('to_month'),
  isCurrent: boolean('is_current').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

export const recruitmentCandidateFile = pgTable('recruitment_candidate_file', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  kind: text('kind').$type<CandidateFileKind>().notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** Never selected by a list: only an authorised download reads the bytes. */
  content: bytea('content').notNull(),
  permissionConfirmed: boolean('permission_confirmed').notNull(),
  uploadedAt: ts('uploaded_at').notNull().defaultNow(),
  uploadedByUserId: uuid('uploaded_by_user_id').notNull(),
});

export const recruitmentTagGroup = pgTable('recruitment_tag_group', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...audit,
});

export const recruitmentTag = pgTable('recruitment_tag', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  groupId: uuid('group_id').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...audit,
});

export const recruitmentCandidateTag = pgTable('recruitment_candidate_tag', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  tagId: uuid('tag_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

export const recruitmentCandidateConsent = pgTable('recruitment_candidate_consent', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  status: text('status').$type<ConsentStatus>().notNull(),
  effectiveOn: date('effective_on').notNull(),
  method: text('method').$type<ConsentMethod>().notNull(),
  noticeReference: text('notice_reference'),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
  recordedByUserId: uuid('recorded_by_user_id').notNull(),
});
