/**
 * Recruitment service facade (ADR-0080 D11 criterion 3).
 *
 * The ONE module outside-the-pack callers import for recruitment services; test/recruitment-pack-drift.test.ts
 * refuses any other route into the pack's internals. Server-only: it reaches db/client. The pack's client-safe
 * declaration is `packs/recruitment/index.ts`, and the pure rules are re-exported here for server callers.
 */
import 'server-only';

export {
  recruitmentCompanies, ensureRecruitmentDefaults, recruitmentOverview, recruitmentPipelineCounts, listJobs, jobFormOptions, createJob, getJob, updateJob,
  changeJobStatus, addJobMember, removeJobMember, candidateBoard, addApplication, moveApplication, rejectApplication,
  applicationHistory, recruitmentSettings, updateStage, updateProcess, saveArchiveReason, deleteArchiveReason,
} from './data';
export type {
  RecruitmentCompany, RecruitmentOverview, RecruitmentPipelineCountRow, JobListFilters, JobListRow, JobList, JobFormOptions, JobDetail, StageTab, ApplicationCard,
  CandidateBoard, ApplicationHistoryRow, RecruitmentSettings, UserLabel,
} from './data';
export {
  RecruitmentError, RECRUITMENT_ERROR_CODES, JOB_STATUSES, JOB_STATUS_TRANSITIONS, JOB_MEMBER_ROLES, POSITION_ATTRIBUTES, RECRUITMENT_TYPES,
  JOB_EMPLOYMENT_TYPES, RECRUITMENT_STAGE_TYPES, canChangeJobStatus, jobTab,
} from './model';
export type { JobStatus, JobMemberRole, RecruitmentErrorCode, RecruitmentStageType, PositionAttribute, RecruitmentType, JobEmploymentType, ApplicationState } from './model';
