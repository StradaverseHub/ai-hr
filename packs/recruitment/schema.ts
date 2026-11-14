/**
 * The Recruitment pack's satellite tables (ADR-0080 D5/D11) as the service reads and writes them. The DDL,
 * keys, row security, grants and guards are owned by db/migrations/5201_recruitment_core.sql and 5202–5212; these
 * declarations carry no references or checks of their own so they can never disagree with it.
 */
import { boolean, customType, date, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ApplicationState, JobEmploymentType, JobMemberRole, JobStatus, PositionAttribute, RecruitmentStageType, RecruitmentType, SystemStageKey } from './model';
import type {
  ApprovalDecision, CandidateDecision, CandidateResponse, CriterionRating, EvaluationFormDefinition, EvaluationResult, FeedbackEditLock,
  InterviewType, OfferFieldType, OfferSendChannel, OfferStatus, RequisitionApprovalStatus, RequisitionStatus,
} from './hiring-model';
import type { TaskCategory } from './tasks-model';
import type { CandidateFileKind, CandidateSource, ConsentMethod, ConsentStatus, EducationLevel, EntryKind, IdType } from './privacy-model';
import type { ConsultantStatus, ContractAccess, ContractStatus, ContractType, MatchKind, SubmissionOutcome } from './agency-model';
import type { ScreeningCloseReason, ScreeningResult } from './screening-model';
import type { AuthorisationMethod, CheckFileKind, CheckOutcome, CheckStatus } from './background-check-model';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const audit = {
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
};
/** Slice 8 (5208): candidates and applications received through the careers page have no signed-in author (NULL). */
const auditOrCareers = {
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
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
  /** Slice 7 (5207): listed on the employee referral portal while Open. Changed by recruitment administrators only. */
  showOnReferralPortal: boolean('show_on_referral_portal').notNull().default(false),
  /** Slice 8 (5208): listed on the company's public careers page while Open and the page is published. Administrators only;
   *  careersPostedAt is set by the database when the flag is turned on and cleared when it is turned off. */
  showOnCareersPage: boolean('show_on_careers_page').notNull().default(false),
  careersPostedAt: ts('careers_posted_at'),
  /** Slice 15 (5216): the position template the job was created from (reporting only; cleared if the template is deleted). */
  createdFromTemplateId: uuid('created_from_template_id'),
  /** Slice 15 (5216): the job's interview plan — one evaluation form (scorecard template) per round, in order; empty = the
   *  default rounds (D-005). */
  interviewPlanFormIds: uuid('interview_plan_form_ids').array().notNull().default([]),
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
  // Slice 5 (5205): the profile and the removal marker.
  location: text('location'),
  currentCompany: text('current_company'),
  currentTitle: text('current_title'),
  highestEducation: text('highest_education').$type<EducationLevel>(),
  noticePeriod: text('notice_period'),
  source: text('source').$type<CandidateSource>(),
  destroyedAt: ts('destroyed_at'),
  destroyedByUserId: uuid('destroyed_by_user_id'),
  ...auditOrCareers,
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
  /** NULL only for an application received through the careers page (slice 8). */
  createdByUserId: uuid('created_by_user_id'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
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
  /** NULL only for the "applied" event of a careers-page application (slice 8). */
  actorUserId: uuid('actor_user_id'),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
});

// ── Slice 2 (db/migrations/5202_recruitment_team_interviews.sql) ──────────────────────────────────────────

export const recruitmentCompanySetting = pgTable('recruitment_company_setting', {
  companyId: uuid('company_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  scorecardsPrivate: boolean('scorecards_private').notNull().default(true),
  feedbackEditLock: text('feedback_edit_lock').$type<FeedbackEditLock>().notNull().default('until_stage_left'),
  resultRequired: boolean('result_required').notNull().default(true),
  // Slice 3 (5203).
  offerValidDays: integer('offer_valid_days').notNull().default(15),
  offerAcceptMovesForward: boolean('offer_accept_moves_forward').notNull().default(false),
  offerDeclineArchives: boolean('offer_decline_archives').notNull().default(false),
  // Slice 5 (5205).
  retentionMonthsWithoutConsent: integer('retention_months_without_consent').notNull().default(6),
  retentionMonthsWithConsent: integer('retention_months_with_consent').notNull().default(24),
  repeatWindowMonths: integer('repeat_window_months').notNull().default(3),
  // Slice 7 (5207): days a referral of a candidate keeps the first referrer's credit; 0 = off.
  referralProtectionDays: integer('referral_protection_days').notNull().default(180),
  // Slice 15 (5216): "New position from template" is offered in the company.
  positionTemplatesEnabled: boolean('position_templates_enabled').notNull().default(false),
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
  /** Slice 18 (5219): the on-site address and room chosen from the company's list (free text above stays for other cases). */
  addressId: uuid('address_id'),
  roomId: uuid('room_id'),
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

// ── Slice 3 (db/migrations/5203_recruitment_offers_hire_handoff.sql) ──────────────────────────────────────

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

/** The approval decision log: one row per decided step, written by that step's approver (5203/5204). */
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

// ── Slice 4 (db/migrations/5204_recruitment_requisitions.sql) ─────────────────────────────────────────────

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

// ── Slice 5 (db/migrations/5205_recruitment_candidate_privacy.sql) ───────────────────────────────────────────

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
  /** NULL for a resume the applicant uploaded on the careers page (slice 8). */
  uploadedByUserId: uuid('uploaded_by_user_id'),
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
  /** NULL for consent the applicant gave on the careers page (slice 8), which also names the notice version agreed to. */
  recordedByUserId: uuid('recorded_by_user_id'),
  careersNoticeVersion: integer('careers_notice_version'),
});

// ── Slice 7 (db/migrations/5207_recruitment_referrals.sql) ────────────────────────────────────────────────────

/**
 * One row per referred application. Written only by app.recruitment_submit_referral; read by the application's readers
 * (HR). Holds no candidate personal data of its own: the reason is cleared when the candidate is removed (slice 5).
 */
export const recruitmentReferral = pgTable('recruitment_referral', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  referrerPersonId: uuid('referrer_person_id').notNull(),
  referrerUserId: uuid('referrer_user_id').notNull(),
  reason: text('reason'),
  confirmedAt: ts('confirmed_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ── Slice 8 (db/migrations/5208_recruitment_careers_page.sql) ───────────────────────────────────────────────────

/** One public careers page per company. Written by recruitment administrators; read by the public careers functions only
 *  while published. */
export const recruitmentCareersSite = pgTable('recruitment_careers_site', {
  companyId: uuid('company_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  published: boolean('published').notNull().default(false),
  address: text('address'),
  displayName: text('display_name'),
  headline: text('headline'),
  introduction: text('introduction'),
  ...audit,
});

/** The careers privacy notice, one immutable row per version; the database numbers the versions. */
export const recruitmentCareersNotice = pgTable('recruitment_careers_notice', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** Assigned by the database guard; the value sent on insert is replaced. */
  version: integer('version').notNull(),
  body: text('body').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

/** An application received through the careers page: written only by app.recruitment_careers_submit. The message is
 *  cleared when the candidate is removed (slice 5). */
export const recruitmentCareersApplication = pgTable('recruitment_careers_application', {
  applicationId: uuid('application_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  message: text('message'),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

/** Slice 9 (5209): a user's own "read up to" time per company and update category. Rows are the viewer's own only. */
export const recruitmentTaskReadMarker = pgTable('recruitment_task_read_marker', {
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  appUserId: uuid('app_user_id').notNull(),
  category: text('category').$type<TaskCategory>().notNull(),
  readUpTo: ts('read_up_to').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ── Slice 10 (db/migrations/5210_recruitment_agencies.sql) ─────────────────────────────────────────────────────

/** The company's agency tags (administrators). A tag in use can be disabled; its foreign key keeps it from deletion. */
export const recruitmentAgencyTag = pgTable('recruitment_agency_tag', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...audit,
});

/** An agency company (headhunter or RPO provider). Name unique in the company. */
export const recruitmentAgency = pgTable('recruitment_agency', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  ...audit,
});

export const recruitmentAgencyTagLink = pgTable('recruitment_agency_tag_link', {
  agencyId: uuid('agency_id').notNull(),
  tagId: uuid('tag_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

/** A contract with an agency. The fee rate and file are NOT here: see recruitmentAgencyContractTerms (administrators only). */
export const recruitmentAgencyContract = pgTable('recruitment_agency_contract', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  agencyId: uuid('agency_id').notNull(),
  name: text('name').notNull(),
  contractType: text('contract_type').$type<ContractType>().notNull(),
  status: text('status').$type<ContractStatus>().notNull().default('enabled'),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  hrContactUserId: uuid('hr_contact_user_id').notNull(),
  access: text('access').$type<ContractAccess>().notNull().default('public'),
  protectionDays: integer('protection_days'),
  ...audit,
});

/** The fee rate (percent; shown, never calculated into an amount, D-037) and the contract PDF. Administrators only. */
export const recruitmentAgencyContractTerms = pgTable('recruitment_agency_contract_terms', {
  contractId: uuid('contract_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  feeRate: numeric('fee_rate', { precision: 5, scale: 2 }).notNull(),
  fileName: text('file_name'),
  fileMime: text('file_mime'),
  fileSize: integer('file_size'),
  /** Never selected by a list: only the administrator's download reads the bytes. */
  fileContent: bytea('file_content'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
});

/** The users a Restricted contract is released to. */
export const recruitmentAgencyContractUser = pgTable('recruitment_agency_contract_user', {
  contractId: uuid('contract_id').notNull(),
  appUserId: uuid('app_user_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

/** A consultant of a contract: a contact record, not a user. Nothing is ever sent to them (D-036). */
export const recruitmentAgencyConsultant = pgTable('recruitment_agency_consultant', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  contractId: uuid('contract_id').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  mobile: text('mobile'),
  status: text('status').$type<ConsultantStatus>().notNull().default('active'),
  ...audit,
});

/** A contract released to a job, with requirements text for the agency. */
export const recruitmentJobAgencyContract = pgTable('recruitment_job_agency_contract', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  contractId: uuid('contract_id').notNull(),
  requirements: text('requirements'),
  ...audit,
});

/**
 * A submission HR recorded on an agency's behalf. Personal columns are cleared by the slice 5 removal. The outcome is
 * computed again by the database guard; the resume is kept only while the submission waits for review.
 */
export const recruitmentAgencySubmission = pgTable('recruitment_agency_submission', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  contractId: uuid('contract_id').notNull(),
  agencyId: uuid('agency_id').notNull(),
  consultantId: uuid('consultant_id').notNull(),
  submittedOn: date('submitted_on').notNull(),
  fullName: text('full_name'),
  email: text('email'),
  mobile: text('mobile'),
  idType: text('id_type').$type<IdType>(),
  idNumber: text('id_number'),
  currentSalaryAmount: numeric('current_salary_amount', { precision: 18, scale: 2 }),
  currentSalaryCurrency: text('current_salary_currency'),
  expectedSalaryAmount: numeric('expected_salary_amount', { precision: 18, scale: 2 }),
  expectedSalaryCurrency: text('expected_salary_currency'),
  comments: text('comments'),
  resumeName: text('resume_name'),
  resumeMime: text('resume_mime'),
  resumeSize: integer('resume_size'),
  /** Never selected by a list. */
  resumeContent: bytea('resume_content'),
  matchKind: text('match_kind').$type<MatchKind>().notNull(),
  outcome: text('outcome').$type<SubmissionOutcome>().notNull(),
  refusalReason: text('refusal_reason').$type<'protected'>(),
  reviewReason: text('review_reason'),
  candidateId: uuid('candidate_id'),
  applicationId: uuid('application_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  decidedAt: ts('decided_at'),
  decidedByUserId: uuid('decided_by_user_id'),
  personalDataRemovedAt: ts('personal_data_removed_at'),
});

// ── Slice 11 (db/migrations/5211_recruitment_screening.sql) ───────────────────────────────────────────────────

/** One hiring manager asked to screen one application. Open until withdrawn or answered with Advance or Reject. */
export const recruitmentScreeningRequest = pgTable('recruitment_screening_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  reviewerUserId: uuid('reviewer_user_id').notNull(),
  sentByUserId: uuid('sent_by_user_id').notNull(),
  sentAt: ts('sent_at').notNull().defaultNow(),
  note: text('note'),
  closedAt: ts('closed_at'),
  closedReason: text('closed_reason').$type<ScreeningCloseReason>(),
  closedByUserId: uuid('closed_by_user_id'),
});

/** The reviewer's answers to their request, append-only (Pending may be followed by another answer). */
export const recruitmentScreeningAnswer = pgTable('recruitment_screening_answer', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  requestId: uuid('request_id').notNull(),
  result: text('result').$type<ScreeningResult>().notNull(),
  comment: text('comment'),
  answeredAt: ts('answered_at').notNull().defaultNow(),
  answeredByUserId: uuid('answered_by_user_id').notNull(),
});

// ── Slice 12 (db/migrations/5212_recruitment_background_checks.sql) ───────────────────────────────────────────

/** The company's background check types (administrators write; the company's job teams read the names). */
export const recruitmentBackgroundCheckType = pgTable('recruitment_background_check_type', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  seedKey: text('seed_key'),
  ...audit,
});

/** One background check on one application: status, outcome, recorder and status dates (the job's reviewers read it). */
export const recruitmentBackgroundCheck = pgTable('recruitment_background_check', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  status: text('status').$type<CheckStatus>().notNull().default('awaiting_authorisation'),
  outcome: text('outcome').$type<CheckOutcome>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  startedAt: ts('started_at'),
  completedAt: ts('completed_at'),
  cancelledAt: ts('cancelled_at'),
  statusChangedAt: ts('status_changed_at').notNull().defaultNow(),
  statusChangedByUserId: uuid('status_changed_by_user_id').notNull(),
});

/** The types of a check, fixed when it is added. */
export const recruitmentBackgroundCheckTypeLink = pgTable('recruitment_background_check_type_link', {
  checkId: uuid('check_id').notNull(),
  typeId: uuid('type_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
});

/** RESTRICTED (the job's operators and administrators): provider, reference, authorisation, summary, cancellation reason. */
export const recruitmentBackgroundCheckDetail = pgTable('recruitment_background_check_detail', {
  checkId: uuid('check_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  provider: text('provider').notNull(),
  providerReference: text('provider_reference'),
  authorisedOn: date('authorised_on', { mode: 'string' }),
  authorisationMethod: text('authorisation_method').$type<AuthorisationMethod>(),
  authorisationRecordedAt: ts('authorisation_recorded_at'),
  authorisationRecordedByUserId: uuid('authorisation_recorded_by_user_id'),
  summary: text('summary'),
  cancelReason: text('cancel_reason'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
});

/** RESTRICTED: the authorisation file and the report (bytes), at most one of each per check. */
export const recruitmentBackgroundCheckFile = pgTable('recruitment_background_check_file', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  checkId: uuid('check_id').notNull(),
  kind: text('kind').$type<CheckFileKind>().notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  content: bytea('content').notNull(),
  permissionConfirmed: boolean('permission_confirmed').notNull(),
  uploadedAt: ts('uploaded_at').notNull().defaultNow(),
  uploadedByUserId: uuid('uploaded_by_user_id').notNull(),
});

// ── Slice 16 (db/migrations/5217_recruitment_import_export.sql) ───────────────────────────────────────────

/** One candidate import (its id is the bulk job's): company, importer, the permission confirmation, rows in the file, the ending. */
export const recruitmentCandidateImport = pgTable('recruitment_candidate_import', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  permissionConfirmedAt: ts('permission_confirmed_at').notNull(),
  fileRows: integer('file_rows').notNull(),
  outcome: text('outcome').$type<'completed' | 'cancelled' | 'failed'>(),
  finishedAt: ts('finished_at'),
});

/** One result per file row: ids, outcome, codes and field keys — never a value from the file. */
export const recruitmentCandidateImportRow = pgTable('recruitment_candidate_import_row', {
  importId: uuid('import_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  rowNum: integer('row_num').notNull(),
  outcome: text('outcome').$type<'created' | 'failed' | 'invalid'>().notNull(),
  candidateId: uuid('candidate_id'),
  applicationId: uuid('application_id'),
  jobId: uuid('job_id'),
  jobResult: text('job_result').$type<'applied' | 'no_job' | 'unknown_job' | 'job_not_open' | 'job_not_allowed'>(),
  possibleDuplicate: boolean('possible_duplicate').notNull().default(false),
  needsReview: boolean('needs_review').notNull().default(false),
  errorCode: text('error_code'),
  errorFields: text('error_fields').array().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** A candidate with no application: who imported them and when, the job title as written, and whether they are hidden. */
export const recruitmentToAssign = pgTable('recruitment_to_assign', {
  candidateId: uuid('candidate_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  importId: uuid('import_id'),
  jobTitleAsWritten: text('job_title_as_written'),
  possibleDuplicate: boolean('possible_duplicate').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  hiddenAt: ts('hidden_at'),
  hiddenByUserId: uuid('hidden_by_user_id'),
});

/** The notes column of an import file, per candidate (operator-only). */
export const recruitmentCandidateImportNote = pgTable('recruitment_candidate_import_note', {
  candidateId: uuid('candidate_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  importId: uuid('import_id').notNull(),
  note: text('note').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

/** A saved export column set per company and export kind. */
export const recruitmentExportTemplate = pgTable('recruitment_export_template', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  kind: text('kind').$type<'board' | 'talent_pool' | 'interview_feedback'>().notNull(),
  name: text('name').notNull(),
  columns: text('columns').array().notNull(),
  ...audit,
});

// ── Slice 17 (db/migrations/5218_recruitment_waiting_limits.sql) ──────────────────────────────────────────

/** A stage's waiting limit: remind after `remindDays`, suggest archiving after `archiveDays` (optional), calendar or working days. */
export const recruitmentStageWaitingRule = pgTable('recruitment_stage_waiting_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  stageId: uuid('stage_id').notNull(),
  remindDays: integer('remind_days').notNull(),
  archiveDays: integer('archive_days'),
  dayKind: text('day_kind').$type<'calendar' | 'working'>().notNull(),
  ...audit,
});

// ── Slice 18 (db/migrations/5219_recruitment_interview_setup.sql) ─────────────────────────────────────────

/** An interviewer group: a named list of users the scheduler adds as individual interviewers. Grants nothing. */
export const recruitmentInterviewerGroup = pgTable('recruitment_interviewer_group', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  ...audit,
});

export const recruitmentInterviewerGroupMember = pgTable('recruitment_interviewer_group_member', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  groupId: uuid('group_id').notNull(),
  appUserId: uuid('app_user_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

/** A question in the company's bank: guidance for interviewers, never an answered or scored field. */
export const recruitmentInterviewQuestion = pgTable('recruitment_interview_question', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  title: text('title').notNull(),
  guidance: text('guidance'),
  category: text('category'),
  retiredAt: ts('retired_at'),
  retiredByUserId: uuid('retired_by_user_id'),
  ...audit,
});

export const recruitmentInterviewQuestionLink = pgTable('recruitment_interview_question_link', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  questionId: uuid('question_id').notNull(),
  evaluationFormId: uuid('evaluation_form_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdByUserId: uuid('created_by_user_id').notNull(),
});

export const recruitmentInterviewAddress = pgTable('recruitment_interview_address', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  address: text('address').notNull(),
  region: text('region').notNull(),
  mapUrl: text('map_url'),
  ...audit,
});

export const recruitmentInterviewRoom = pgTable('recruitment_interview_room', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  addressId: uuid('address_id').notNull(),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...audit,
});

// Slice 19 (5220): candidate e-mail — the company's sender settings, its template overrides and one delivery row per e-mail.
export const recruitmentCandidateEmailSetting = pgTable('recruitment_candidate_email_setting', {
  companyId: uuid('company_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  senderName: text('sender_name'),
  replyTo: text('reply_to'),
  locale: text('locale').notNull().default('en'),
  ...audit,
});

export const recruitmentCandidateEmailTemplate = pgTable('recruitment_candidate_email_template', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  kind: text('kind').notNull(),
  locale: text('locale').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  ...audit,
});

export const recruitmentCandidateEmail = pgTable('recruitment_candidate_email', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  kind: text('kind').notNull(),
  locale: text('locale').notNull(),
  recipient: text('recipient'),
  subject: text('subject'),
  bodyText: text('body_text'),
  bodyHtml: text('body_html'),
  senderName: text('sender_name').notNull(),
  replyTo: text('reply_to').notNull(),
  status: text('status').notNull().default('queued'),
  errorCode: text('error_code'),
  attempts: integer('attempts').notNull().default(0),
  queuedAt: ts('queued_at').notNull().defaultNow(),
  queuedByUserId: uuid('queued_by_user_id'),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  leaseToken: uuid('lease_token'),
  leaseUntil: ts('lease_until'),
  startedAt: ts('started_at'),
  completedAt: ts('completed_at'),
  relayRevision: text('relay_revision'),
  retriedAt: ts('retried_at'),
  retriedByUserId: uuid('retried_by_user_id'),
  retryCount: integer('retry_count').notNull().default(0),
  contentPurgedAt: ts('content_purged_at'),
});
