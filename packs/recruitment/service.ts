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
  submitScorecard, getScorecard, interviewSettings, updateInterviewSettings, saveEvaluationForm, myJobRoles, addInterviewers,
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
// anonymous page, job and submission (through 5708's definer functions only); the careers record on an application.
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
// category, unread counts against the viewer's own read markers (5709) and "Mark all as read".
export { recruitmentTodos, recruitmentJobTodos, recruitmentWaitingTodos, recruitmentUpdates, recruitmentUnreadCounts, markRecruitmentTasksRead, pendingRecruitmentTasks } from './tasks';
export type { RecruitmentUpdatesPage, RecruitmentJobTodos } from './tasks';
export {
  TASK_CATEGORIES, TASK_TABS, TODO_KINDS, UPDATE_KINDS, UPDATES_WINDOW_DAYS, UPDATES_PAGE_SIZE, UPDATES_MAX_PAGE, UNREAD_CAP, TODO_LIMIT,
  TODO_COUNT_CAP, TODO_JOB_LIMIT, BELL_TIMEOUT_MS, JOB_TODOS_TIMEOUT_MS, WAITING_TODOS_TIMEOUT_MS, PERSONAL_TODO_KINDS, JOB_TODO_KINDS, isPersonalTodo, isTaskCategory, parseTaskTab, parseUpdatesPage, readCategories, updatesSince, countText, todoHref,
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
// Slice 13 — custom talent pools (two levels; sharing with all recruiters or listed users) and the blocked list (administrators
// add and remove with a reason; matching applications from every channel are marked for an administrator's review, which
// holds them from moving, offers and hire until resolved). The board's review flag and pools come with candidateBoard; the
// public pool's "Pools: …" and blocked flag with talentPool.
export {
  poolSettings, savePool, deletePool, poolNav, poolMembers, applicationPools, poolChoices, addCandidateToPool, removeCandidateFromPool,
} from './pools';
export type { PoolSettingsRow, PoolSettings, PoolNavRow, PoolNav, PoolMemberCard, PoolMembers, CandidatePools } from './pools';
export { blockCandidate, unblockCandidate, resolveReviewMark, applicationReview, blockedList } from './blocked-list';
export type { ReviewMarkView, ApplicationReview, BlockedEntryRow, BlockedHistoryRow, BlockedList } from './blocked-list';
export {
  POOL_NAME_MAX, POOL_DESCRIPTION_MAX, POOL_SHARING, POOL_SHARE_MAX, POOL_LIST_LIMIT, BLOCKED_REASON_MAX, REVIEW_RESOLUTIONS, BLOCKED_HISTORY_ACTIONS,
  MARK_CLEARED_KINDS, REVIEW_VIEWS, validatePoolInput, poolTree, parsePoolKey, poolLabels, validateBlockedReason, parseResolution, identityOf,
  blockedIdentityMatch, reviewView,
} from './pool-model';
export type { PoolSharing, ReviewResolution, BlockedHistoryAction, MarkClearedKind, ReviewView, PoolKey, PoolNode, Identity } from './pool-model';
// Slice 14 — custom candidate and job fields: Settings › Custom fields (administrators: fields of each type with labels in six
// locales, options, order, enable and disable; the sensitive-category word list refuses fields by name, D-052); the values are
// filled on the candidate profile and the job form (candidateProfile/updateCandidateProfile, jobFormOptions/getJob/createJob/
// updateJob) and filter the board, the talent pool and the job list (candidateBoard, talentPool, listJobs).
export {
  customFieldSettings, saveCustomField, deleteCustomField, moveCustomField, saveCustomFieldOption, deleteCustomFieldOption, moveCustomFieldOption,
  parseCustomFieldKind,
} from './custom-fields';
export type { CustomFieldSettings, CustomFieldRow, CustomOptionRow } from './custom-fields';
export type { CustomFieldView, CustomOptionView, CustomFilterChoice } from './custom-field-store';
export {
  CUSTOM_FIELD_KINDS, CUSTOM_FIELD_TYPES, CHOICE_TYPES, FILTER_TYPES, CUSTOM_FIELD_LOCALES, CUSTOM_LABEL_MAX, CUSTOM_HELP_MAX, CUSTOM_SHORT_TEXT_MAX,
  CUSTOM_LONG_TEXT_MAX, CUSTOM_DECIMALS_MAX, CUSTOM_FIELDS_MAX, CUSTOM_FIELDS_TOTAL_MAX, CUSTOM_OPTIONS_MAX, CUSTOM_FORM_MARKER, SENSITIVE_CATEGORIES, SENSITIVE_WORDS,
  customInputName, sensitiveCategory, validateCustomFieldInput, validateCustomOptionInput, labelFor, validateCustomValues, customValuesFromForm, sameValue,
  formValue, parseCustomFilter, customFilterKey, moveInOrder, decimalText, compareDecimal, answerable, stripIgnorable,
} from './custom-field-model';
export type {
  CustomFieldKind, CustomFieldType, CustomFieldLocale, CustomLabels, SensitiveCategory, CustomFieldInput, CustomOptionInput, ValidCustomField, FieldRule,
  TypedValue, RawCustomValues, CustomFilter,
} from './custom-field-model';
// Slice 15 — position templates: Settings › Position templates (administrators: templates and the company setting) and "New
// position from template" (a pre-filled, unsaved draft of the new-position form with notes for parts no longer usable; a
// requisition's values win over the template's). createJob records the template; jobs carry an interview plan.
export {
  positionTemplateSettings, positionTemplateEditor, savePositionTemplate, setPositionTemplateEnabled, deletePositionTemplate,
  updatePositionTemplateSetting, positionTemplateChoices, positionTemplateChoicesTx, newPositionFromTemplate, newPositionFromTemplateTx,
} from './position-templates';
export type {
  PositionTemplateRow, PositionTemplateSettings, PositionTemplateEditor, TemplateDraftView, PositionTemplateChoices, PositionFromTemplate, NewPositionFromTemplateOptions,
} from './position-templates';
export { POSITION_TEMPLATE_NAME_MAX, POSITION_TEMPLATES_MAX, validateTemplateInput, resolveTemplate, mergeRequisition } from './position-template-model';
export type {
  TemplateInput, ValidTemplate, TemplateRecord, TemplateAvailability, TemplateNote, PositionDraft, RequisitionValues,
} from './position-template-model';
// Slice 16 — candidate import (a background job on the shared bulk-job kernel; core/recruitment-candidate-import-worker.ts runs
// the rows through importCandidateRowTx), the To assign list, list exports and saved column sets (export templates).
export {
  previewCandidateImport, startCandidateImport, candidateImportJob, cancelCandidateImport, candidateImportResult, recentCandidateImports,
  candidateImportTemplate, prepareCandidateImport, importCandidateRowTx, finishCandidateImportTx, toAssignList, assignToJob, setToAssignHidden,
  importHash, TO_ASSIGN_LIST_MAX, TO_ASSIGN_COUNT_CAP, IMPORT_PREVIEWS_PER_DAY, IMPORT_PREVIEW_TIMEOUT_MS,
} from './import';
export type {
  ImportPreview, ImportPreviewRow, CandidateImportJobInput, CandidateImportJob, ImportCounters, ImportResultRow, RecentImport, ImportStep, ImportStepPayload,
  ImportRowOutcome, ToAssignEntry, ToAssignList, ImportTemplate,
} from './import';
export {
  CANDIDATE_IMPORT_KIND, IMPORT_MAX_ROWS, IMPORT_MAX_FILE_BYTES, IMPORT_MAX_TEXT_BYTES, IMPORT_COLUMNS, IMPORT_HEADERS, IMPORT_ISSUE_CODES, IMPORT_FILE_ERRORS,
  IMPORT_PREVIEW_ISSUES_MAX, JOB_RESULTS, parseCandidateImport, importTemplateHeader, permissionConfirmed, requiredIssues, normHeader,
} from './import-model';
export type { ImportColumn, ImportIssueCode, ImportFileError, RowIssue, JobResult } from './import-model';
export {
  exportBoard, exportTalentPool, exportInterviewFeedback, recordExport, exportTemplates, saveExportTemplate, deleteExportTemplate, exportTemplateColumns,
  exportColumnChoices, EXPORT_TIMEOUT_MS, EXPORTS_PER_TENANT,
} from './export';
export type { ExportTable, BoardExportFilter, PoolExportFilter, ExportTemplateRow } from './export';
export {
  EXPORT_KINDS, EXPORT_FORMATS, EXPORT_MAX_ROWS, EXPORT_COLUMNS, RESTRICTED_EXPORT_COLUMNS, EXPORT_TEMPLATE_NAME_MAX, isExportKind, parseExportFormat,
  defaultExportColumns, chooseExportColumns, validateExportTemplate, safeRows, exportCsv, exportFileName, isCustomColumn,
} from './export-model';
export type { ExportKind, ExportFormat, ExportCell } from './export-model';
// Slice 17 — applications left unprocessed: Settings › Waiting limits (administrators: per stage, a reminder and an optional
// "suggest archiving" threshold, calendar or working days from the company's holiday calendar), the waiting time on the application
// page, and a job's "Suggested to archive" list archived in one action through the normal reject path (D-057: never automatic). The
// board's badges, filter and counts come with candidateBoard; the Overview's per-job counts with recruitmentJobTodos.
export {
  waitingRuleSettings, saveWaitingRule, deleteWaitingRule, applicationWaiting, suggestedArchiveList, archiveSuggestedApplications,
} from './waiting';
export type {
  WaitingRuleRow, WaitingRuleSettings, ApplicationWaiting, SuggestedRow, SuggestedArchiveList, SuggestedArchiveRefusal, SuggestedArchiveResult,
} from './waiting';
export {
  WAITING_DAY_KINDS, WAITING_REMIND_MAX, WAITING_ARCHIVE_MAX, WAITING_FILTERS, WAITING_SCAN_LIMIT, WAITING_BOARD_SCAN_LIMIT, SUGGESTED_LIST_LIMIT, HOLIDAY_LOOKBACK_DAYS, addDays, isWeekend, isWorkingDay,
  waitingDays, waitingCutoff, ruleCutoffs, waitingLevel, holidayWindowStart, parseWaitingFilter, validateWaitingRule,
} from './waiting-model';
export type { WaitingDayKind, WaitingFilter, WaitingRule, WaitingLevel, WaitingRuleInput } from './waiting-model';
// Slice 18 — interview set-up: interviewer groups (scheduling and addInterviewers add each current member once; the group grants
// nothing and is not recorded on the interview), the question bank linked to scorecard templates (read-only guidance on the feedback
// form, never scored; retired questions hidden), and the company's interview addresses and meeting rooms (a room is never booked
// for two overlapping interviews: 5719's exclusion constraint). No meeting or calendar integration (D-058).
export {
  interviewerGroupSettings, saveInterviewerGroup, deleteInterviewerGroup, questionBankSettings, saveInterviewQuestion, setInterviewQuestionRetired,
  deleteInterviewQuestion, interviewPlaceSettings, saveInterviewAddress, deleteInterviewAddress, saveInterviewRoom, deleteInterviewRoom,
} from './interview-setup';
export type {
  GroupMemberView, InterviewerGroupRow, InterviewerGroupSettings, SchedulingGroup, SchedulingAddress, QuestionRow, QuestionBankSettings, RoomRow, AddressRow,
  InterviewPlaceSettings,
} from './interview-setup';
export {
  GROUP_NAME_MAX, GROUP_MEMBERS_MAX, GROUPS_MAX, QUESTION_TITLE_MAX, QUESTION_GUIDANCE_MAX, QUESTION_CATEGORY_MAX, QUESTIONS_MAX, FORM_QUESTIONS_MAX,
  ADDRESS_NAME_MAX, ADDRESS_TEXT_MAX, ADDRESS_REGION_MAX, MAP_LINK_MAX, ADDRESSES_MAX, ROOM_NAME_MAX, ROOM_CAPACITY_MAX, ROOMS_PER_ADDRESS_MAX, INTERVIEWERS_MAX,
  validateGroup, expandInterviewers, validateQuestion, guidanceQuestions, isHttpsMapLink, validateAddress, validateRoom, resolvePlace, interviewPeriod, periodsOverlap,
} from './interview-setup-model';
export type {
  GroupInput, ValidGroup, QuestionInput, ValidQuestion, GuidanceQuestion, AddressInput, ValidAddress, RoomInput, ValidRoom,
} from './interview-setup-model';
export {
  RecruitmentError, RECRUITMENT_ERROR_CODES, JOB_STATUSES, JOB_STATUS_TRANSITIONS, JOB_MEMBER_ROLES, POSITION_ATTRIBUTES, RECRUITMENT_TYPES,
  JOB_EMPLOYMENT_TYPES, RECRUITMENT_STAGE_TYPES, canChangeJobStatus, jobTab, INTERVIEW_PLAN_MAX, INTERVIEW_PLAN_FORM_MARKER, parseInterviewPlan, interviewPlanFromForm,
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
// Slice 19 — candidate e-mail: the company's sender and templates (administrators), the previews people see, receipts HR ticks and
// rejection letters queued with the action they belong to (careers-page receipts wait for slice 21, D-064), the application page's list, an administrator's retry, and the sweep
// step that delivers through the embedded relay (5720; docs/adr/2026-11-14-recruitment-candidate-email.md).
export {
  candidateEmailComposers, previewCandidateEmail, candidateEmailSettings, saveCandidateEmailSettings, saveCandidateEmailTemplate, resetCandidateEmailTemplate,
  applicationCandidateEmails, retryCandidateEmail, candidateEmailDefault, rejectionEmailPreviews, REJECTION_PREVIEW_LIMIT,
} from './candidate-email';
export type {
  CandidateEmailComposer, CandidateEmailSettingsView, CandidateEmailTemplateView, CandidateEmailRow, ApplicationCandidateEmails, CandidateEmailQueueResult,
  RejectionEmailChoice, RejectionEmailPreview,
} from './candidate-email';
export { deliverCandidateEmails, DELIVERY_BATCH as CANDIDATE_EMAIL_DELIVERY_BATCH } from './candidate-email-delivery';
export type { CandidateEmailDeliveryResult } from './candidate-email-delivery';
export {
  CANDIDATE_EMAIL_KINDS, CANDIDATE_EMAIL_LOCALES, CANDIDATE_EMAIL_PLACEHOLDERS, CANDIDATE_EMAIL_SUBJECT_MAX, CANDIDATE_EMAIL_BODY_MAX,
  CANDIDATE_EMAIL_SENDER_NAME_MAX, CANDIDATE_EMAIL_HOURLY_CAP, REJECTION_EMAIL_DELAYS, CANDIDATE_EMAIL_PURGE_DAYS, renderCandidateEmail,
  validateCandidateEmailTemplate, validateCandidateEmailSettings, candidateEmailDisplayState, linkish, usableRecipient, defaultSenderName,
} from './candidate-email-model';
export type { CandidateEmailKind, CandidateEmailLocale, CandidateEmailDisplayState, RenderedCandidateEmail } from './candidate-email-model';
