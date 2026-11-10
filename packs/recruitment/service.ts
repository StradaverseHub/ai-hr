/**
 * Recruitment service facade (ADR-0080 D11 criterion 3).
 *
 * The ONE module outside-the-pack callers import for recruitment services; test/recruitment-pack-drift.test.ts
 * refuses any other route into the pack's internals. Server-only: it reaches db/client. The pack's client-safe
 * declaration is `packs/recruitment/index.ts`, and the pure rules are re-exported here for server callers.
 */
import 'server-only';

export {
  recruitmentCompanies, recruitmentViewer, recruitmentTeamPresence, ensureRecruitmentDefaults, recruitmentOverview, recruitmentPipelineCounts, listJobs,
  jobFormOptions, createJob, getJob, updateJob, changeJobStatus, addJobMember, removeJobMember, candidateBoard, addApplication, moveApplication,
  rejectApplication, applicationHistory, recruitmentSettings, updateStage, updateProcess, saveArchiveReason, deleteArchiveReason,
} from './data';
export type {
  RecruitmentCompany, RecruitmentViewer, RecruitmentOverview, RecruitmentPipelineCountRow, JobListFilters, JobListRow, JobList, JobFormOptions, JobDetail,
  StageTab, ApplicationCard, CandidateBoard, ApplicationHistoryRow, RecruitmentSettings, UserLabel,
} from './data';
// Slice 2 — interviews and scorecards.
export {
  interviewFormOptions, scheduleInterview, cancelInterview, setCandidateResponse, applicationInterviews, interviewSchedule, scorecardForm,
  submitScorecard, getScorecard, interviewSettings, updateInterviewSettings, saveEvaluationForm, myJobRoles,
} from './interviews';
export type {
  InterviewFormOptions, InterviewCard, InterviewerView, ApplicationInterviews, ScheduleFilters, ScheduleRow, InterviewSchedule, ScorecardForm,
  ScorecardView, InterviewSettings,
} from './interviews';
// Slice 3 — offers and the hire hand-off.
export {
  applicationOffer, saveOffer, submitOffer, withdrawOffer, decideOffer, markOfferSent, recordOfferDecision, offerSettings, updateOfferSettings,
  saveOfferField, saveApprovalFlow, offerForApprover, applicationHire, hireHandoffPrefill, linkHireDraft,
} from './offers';
export type { OfferView, OfferSettings, HirePrefill, ApplicationHire, PendingOfferApproval } from './offers';
// Slice 4 — job requisitions and the talent pool.
export {
  listRequisitions, getRequisition, requisitionFormOptions, createRequisition, updateRequisition, submitRequisition, withdrawRequisition,
  decideRequisition, changeRequisitionStatus, associateJob, dissociateJob, requisitionJobPrefill, myApprovals, talentPool, addPoolCandidateToJob,
} from './requisitions';
export type { RequisitionFilters, RequisitionRow, RequisitionList, RequisitionDetail, MyApprovals, PoolFilters, PoolCard, TalentPool } from './requisitions';
// Slice 5 — candidate records and privacy.
export { checkDuplicateCandidate } from './data';
export type { AddApplicationInput, DuplicateCheck, DuplicateMatch } from './data';
export {
  candidateProfile, updateCandidateProfile, saveCandidateRestricted, addCandidateEntry, removeCandidateEntry, uploadCandidateFile, getCandidateFile,
  deleteCandidateFile, tagCatalog, saveTagGroup, saveTag, addCandidateTag, removeCandidateTag, recordConsent, privacySettings, updatePrivacySettings,
  dueForDestruction, destroyCandidates,
} from './candidates';
export type {
  CandidateProfile, CandidateEntryView, CandidateFileView, CandidateRestrictedView, ConsentEntryView, TagCatalog, PrivacySettings, DueCandidate,
} from './candidates';
export {
  EDUCATION_LEVELS, CANDIDATE_SOURCES, ID_TYPES, FILE_KINDS, ENTRY_KINDS, CONSENT_STATUSES, CONSENT_METHODS, REPEAT_WINDOW_CHOICES, CANDIDATE_FILE_ACCEPT,
  CANDIDATE_FILE_MAX_BYTES,
} from './privacy-model';
export type { EducationLevel, CandidateSource, IdType, CandidateFileKind, EntryKind, ConsentStatus, ConsentMethod, ConsentState } from './privacy-model';
export {
  RecruitmentError, RECRUITMENT_ERROR_CODES, JOB_STATUSES, JOB_STATUS_TRANSITIONS, JOB_MEMBER_ROLES, POSITION_ATTRIBUTES, RECRUITMENT_TYPES,
  JOB_EMPLOYMENT_TYPES, RECRUITMENT_STAGE_TYPES, canChangeJobStatus, jobTab,
} from './model';
export type { JobStatus, JobMemberRole, RecruitmentErrorCode, RecruitmentStageType, PositionAttribute, RecruitmentType, JobEmploymentType, ApplicationState } from './model';
export {
  INTERVIEW_TYPES, CANDIDATE_RESPONSES, EVALUATION_RESULTS, FEEDBACK_EDIT_LOCKS, OFFER_FIELD_TYPES, OFFER_SEND_CHANNELS, CANDIDATE_DECISIONS,
  REQUISITION_STATUSES, REQUISITION_TABS, REQUISITION_APPROVAL_STATUSES, NOTES_MAX_WORDS, sectionTotals, interviewStatus,
} from './hiring-model';
export type {
  InterviewType, InterviewStatus, CandidateResponse, EvaluationResult, FeedbackEditLock, EvaluationFormDefinition, OfferFieldType, OfferStatus,
  OfferValue, OfferLabel, CandidateDecision, RequisitionStatus, EffectiveRequisitionStatus, RequisitionApprovalStatus, ApprovalStepView,
} from './hiring-model';
