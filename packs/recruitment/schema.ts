/**
 * The Recruitment pack's satellite tables (ADR-0080 D5/D11) as the service reads and writes them. The DDL,
 * keys, row security, grants and guards are owned by db/migrations/4401_recruitment_core.sql; these
 * declarations carry no references or checks of their own so they can never disagree with it.
 */
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ApplicationState, JobEmploymentType, JobMemberRole, JobStatus, PositionAttribute, RecruitmentStageType, RecruitmentType, SystemStageKey } from './model';

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
