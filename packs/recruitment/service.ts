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
// Slice 6 — recruitment reports: four fixed dashboards, aggregates only, each one read-only snapshot.
export { recruitmentOverviewReport, recruitmentPositionsReport, recruitmentInterviewsReport, recruitmentTeamReport, ReportTooSlowError } from './reports';
export type {
  ReportScope, ReportOptions, OverviewReport, OverviewJobRow, PositionsReport, PositionRow, PositionFigures, FunnelStep, InterviewsReport, TeamReport, TeamRow,
} from './reports';
export {
  REPORT_KINDS, REPORT_MAX_MONTHS, REPORT_JOB_LIMIT, REPORT_RECRUITER_LIMIT, NO_VALUE, formatPercent, formatNumber, formatDelta, barPercent,
} from './report-model';
export type { ReportKind, ReportPeriod, Granularity, Bucket, ReportFilterInput } from './report-model';
// Slice 7 — employee referrals: the portal, the refer form and My referrals (the referrer); the portal setting, the
// protection period and the referral on an application (HR).
export {
  referralEligible, referralPortal, referralPortalJob, submitReferral, myReferrals, setJobReferralPortal, referralSettings, updateReferralSettings,
  applicationReferral,
} from './referrals';
export type { ReferralPortalJob, ReferralInput, MyReferralRow, ReferralSettings, ApplicationReferral } from './referrals';
export {
  REFERRAL_REASON_MAX, REFERRAL_DAILY_LIMIT, REFERRAL_PROTECTION_DEFAULT_DAYS, REFERRAL_PROTECTION_MAX_DAYS, REFERRAL_STATUSES, REFERRAL_REFUSALS,
  validateReferralInput, validateProtectionDays, referralStatus,
} from './referral-model';
export type { ReferralStatus, ReferralRefusal, ReferralProgress } from './referral-model';
// Slice 8 — the public careers page and online applications: HR's settings, notice versions and job switch; the
// anonymous page, job and submission (through 4408's definer functions only); the careers record on an application.
export {
  careersSettings, updateCareersSettings, setCareersPublished, setJobCareersPage, jobCareersStatus, applicationCareers, careersPublicPage,
  careersPublicJob, submitCareersApplication, careersClientLimited,
} from './careers';
export type {
  CareersSettings, CareersNoticeVersionView, JobCareersStatus, ApplicationCareers, CareersPublicJobRow, CareersPublicPage, CareersPublicJob,
  CareersPageQuery, CareersSubmission, CareersSubmitResult,
} from './careers';
export {
  CAREERS_DISPLAY_NAME_MAX, CAREERS_HEADLINE_MAX, CAREERS_INTRODUCTION_MAX, CAREERS_NOTICE_MAX, CAREERS_NAME_MAX, CAREERS_MESSAGE_MAX,
  CAREERS_CLIENT_HOURLY_LIMIT, CAREERS_COMPANY_DAILY_LIMIT, CAREERS_PAGE_SIZE, CAREERS_BODY_MAX_BYTES, CAREERS_QUERY_MAX, CAREERS_PUBLISH_REQUIREMENTS,
  CAREERS_FORM_FIELDS, CAREERS_FIELD_ERRORS, CAREERS_OUTCOMES, validateCareersSettings, careersPublishMissing, validateCareersApplication,
  normaliseCareersMobile, careersPageNumber, careersPageCount,
} from './careers-model';
export type { CareersPublishRequirement, CareersFormField, CareersFieldError, CareersOutcome, CareersApplicationInput, CareersSettingsInput } from './careers-model';
// Slice 9 — recruitment tasks and updates: the live to-do list (also the bell's recruitment tasks), the live updates per
// category, unread counts against the viewer's own read markers (4409) and "Mark all as read".
export { recruitmentTodos, recruitmentJobTodos, recruitmentUpdates, recruitmentUnreadCounts, markRecruitmentTasksRead, pendingRecruitmentTasks } from './tasks';
export type { RecruitmentUpdatesPage, RecruitmentJobTodos } from './tasks';
export {
  TASK_CATEGORIES, TASK_TABS, TODO_KINDS, UPDATE_KINDS, UPDATES_WINDOW_DAYS, UPDATES_PAGE_SIZE, UPDATES_MAX_PAGE, UNREAD_CAP, TODO_LIMIT,
  TODO_COUNT_CAP, TODO_JOB_LIMIT, BELL_TIMEOUT_MS, JOB_TODOS_TIMEOUT_MS, PERSONAL_TODO_KINDS, JOB_TODO_KINDS, isPersonalTodo, isTaskCategory, parseTaskTab, parseUpdatesPage, readCategories, updatesSince, countText, todoHref,
  updateHref, todoToPackTask, updatesHasMore, encodeUpdatesCursor, decodeUpdatesCursor,
} from './tasks-model';
export type { TaskCategory, TaskTab, TodoKind, PersonalTodoKind, UpdateKind, RecruitmentTodo, RecruitmentUpdate } from './tasks-model';
// Slice 10 — agencies and headhunters: agencies, tags, contracts (fee rate and file for administrators only), consultants,
// jobs released to contracts, submissions recorded by HR with the duplicate and protection check, administrators' review,
// and the agency on an application.
export {
  agencySetup, saveAgency, saveAgencyTag, deleteAgencyTag, agencyContracts, agencyContract, saveAgencyContract, uploadAgencyContractFile,
  removeAgencyContractFile, getAgencyContractFile, addAgencyContractUser, removeAgencyContractUser, saveAgencyConsultant, jobAgencyContracts,
  assignAgencyContract, updateAgencyAssignment, removeAgencyAssignment, agencySubmissionOptions, recordAgencySubmission, jobAgencySubmissions,
  agencyReviewQueue, agencySubmissionReview, acceptAgencySubmission, rejectAgencySubmission, applicationAgency, removeAgencySubmissionData,
  agencySubmissionsDue,
} from './agencies';
export type {
  AgencySetup, AgencyRow, AgencyTagRow, AgencyContact, ContractFilters, ContractRow, ContractDetail, ConsultantRow, ContractPositionRow, JobAgencyAssignment,
  JobAgencyContracts, SubmissionContractOption, AgencySubmissionInput, AgencySubmissionResult, JobAgencySubmissionRow, AgencyReviewRow,
  AgencySubmissionReview, ApplicationAgency, AgencySubmissionDue,
} from './agencies';
export {
  CONTRACT_TYPES, CONTRACT_STATUSES, CONTRACT_ACCESS, CONSULTANT_STATUSES, SUBMISSION_OUTCOMES, MATCH_KINDS, AGENCY_NAME_MAX, AGENCY_TAG_MAX,
  CONTRACT_NAME_MAX, REQUIREMENTS_MAX, COMMENTS_MAX, REVIEW_REASON_MAX, AGENCY_PROTECTION_DEFAULT_DAYS, PROTECTION_OVERRIDE_MAX_DAYS,
  CONTRACT_EXPIRY_NOTICE_DAYS, CONTRACT_FILE_MAX_BYTES, CONTRACT_FILE_ACCEPT, AGENCY_DAILY_LIMIT, contractUsableOn, contractExpiryDue, daysUntil, insideProtection,
  protectionDays, matchKind, submissionFor, feeRate, validateContractInput, validateSubmissionInput, validateConsultantInput,
} from './agency-model';
export type { ContractType, ContractStatus, ContractAccess, ConsultantStatus, SubmissionOutcome, MatchKind, CheckOutcome, ContractPositionCounts } from './agency-model';
// Slice 11 — resume screening by hiring managers: send (one or many applications of one job, with the optional move), reassign,
// withdraw, the reviewer's answer, the To screen list and an application's Screening section; the board's statuses and filter
// come with candidateBoard.
export {
  screeningSendOptions, sendForScreening, reassignScreening, withdrawScreening, answerScreening, myScreeningRequests, applicationScreening,
} from './screening';
export type {
  ScreeningReviewerOption, ScreeningSendOptions, ScreeningSendResult, ScreeningAnswerView, ScreeningTodoRow, ScreeningRequestView, ApplicationScreening,
} from './screening';
export {
  SCREENING_RESULTS, ASSIGNMENT_STATUSES, SCREENING_CLOSE_REASONS, SCREENING_NOTE_MAX, SCREENING_COMMENT_MAX, SCREENING_SEND_MAX, SCREENING_LIST_LIMIT,
  SCREENING_STATUS_WINDOW, isScreeningResult,
  parseAssignmentFilter, closesRequest, validateSendInput, validateAnswerInput, assignmentStatus, statusCounts, requestState,
} from './screening-model';
export type { ScreeningResult, AssignmentStatus, ScreeningCloseReason, RequestState, StatusRequest, StatusAnswer } from './screening-model';
// Slice 12 — background checks: the company's check types (administrators), adding a check, the candidate's authorisation
// first, start, complete with an outcome and report, cancel; the application's section (full for the job's operators and
// administrators, type/status/outcome/dates for its hiring managers), audited downloads and counts by status for the reports.
// The board's markers come with candidateBoard; the recorder's to-dos with the slice 9 tasks.
export {
  backgroundCheckTypes, saveBackgroundCheckType, deleteBackgroundCheckType, addDefaultBackgroundCheckTypes, addBackgroundCheck,
  recordBackgroundCheckAuthorisation, startBackgroundCheck, completeBackgroundCheck, cancelBackgroundCheck, getBackgroundCheckFile,
  applicationBackgroundChecks, backgroundCheckCounts,
} from './background-checks';
export type {
  BackgroundCheckTypeRow, BackgroundCheckTypes, CheckFileInput, BackgroundCheckFileView, BackgroundCheckRestricted, BackgroundCheckView,
  ApplicationBackgroundChecks, BackgroundCheckCounts,
} from './background-checks';
export {
  CHECK_STATUSES, CHECK_OUTCOMES, AUTHORISATION_METHODS, CHECK_FILE_KINDS, CHECK_TRANSITIONS, DEFAULT_CHECK_TYPES, CHECK_TYPE_NAME_MAX,
  CHECK_TYPE_DESCRIPTION_MAX, CHECK_PROVIDER_MAX, CHECK_REFERENCE_MAX, CHECK_SUMMARY_MAX, CHECK_CANCEL_REASON_MAX, CHECK_TYPES_PER_CHECK_MAX,
  CHECK_OVERDUE_DAYS, CHECK_FILE_MAX_BYTES, AUTHORISATION_FILE_ACCEPT, REPORT_FILE_ACCEPT, canMoveCheck, isFinalCheck, checkOverdue, overdueFrom,
  checkStageAllowed, checkMarker, checkStatusCounts, validateCheckTypeInput, validateAddCheckInput, validateAuthorisationInput, validateCompleteInput,
  validateCancelInput,
} from './background-check-model';
// (Slice 10 already exports a CheckOutcome — the agency check's; the background check outcome is BackgroundCheckOutcome here.)
export type { CheckStatus, CheckOutcome as BackgroundCheckOutcome, AuthorisationMethod, CheckFileKind, CheckMarker, CheckStagePosition } from './background-check-model';
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
