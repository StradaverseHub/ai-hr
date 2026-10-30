/**
 * Performance service facade (ADR-0080 D11 criterion 3, rung 4).
 *
 * The ONE module outside-the-pack callers import for performance services. It re-exports the
 * pack's implementation file in place — physical file moves are explicitly optional per D11; the
 * boundary is import discipline, enforced by test/performance-pack-drift.test.ts: any file
 * outside the pack surface importing `core/performance` directly (instead of this facade) fails
 * the ratchet unless it is audited kernel-contract debt (the "performance" allowlist in
 * test/pack-drift-allowlist.json — see packs/performance/index.ts for who and why).
 *
 * Server-only in practice (drags in db/client) — never import from client components; the pack's
 * client-safe declaration is `packs/performance/index.ts`.
 */
export * from '../../core/performance';

export * from "./onehr/service";
export { draftOnehrNarrative } from './onehr/ai';
export { getReviewConversation, sendReviewMessage, keepCompetencyReflection, type ConversationStage, type ReviewMessage } from './onehr/conversation';
export { getCalibrationConversation,sendCalibrationMessage } from './onehr/calibration-conversation';

export { previewAssessmentParticipantsTx, snapshotAssessmentParticipantsTx, assessmentParticipantsTx, setAssessmentParticipation } from './onehr/participation-service';
// D-P1-22 (ADR-0150): the cycle exclusion rule.
export { listUnitExclusionRules, previewUnitExclusion, saveUnitExclusion, endUnitExclusion, unitExclusionPlanTx, type UnitExclusionScope } from './onehr/unit-exclusion-service';
export { planUnitExclusion, planKpiLine, dedupeChain, fullPanelTarget, type UnitExclusionPlan, type UnitExclusionFacts } from './onehr/unit-exclusion-model';
// D-P1-22 X5: the cycle page card's read projections (labels and choices; the plan and its numbers stay above).
export { getUnitExclusionScreen, previewUnitExclusionScreen, type UnitExclusionScreen, type UnitExclusionPreviewView, type UnitExclusionRuleView, type UnitExclusionChoice } from './onehr/unit-exclusion-screen';

export * from './onehr/rating-record-service';
export type { RatingRecordSnapshot } from './onehr/rating-record-model';
export { buildRatingRecordWorkbook } from './onehr/rating-record-xlsx';
export { getAssessmentPersonalRecord } from './onehr/personal-record-service';
export { importAssessmentArchitecture, generateAssessmentProfiles, saveAssessmentCatalogueProfile, setAssessmentCareerRoute } from './onehr/architecture-service';

export { getFeedbackConversation, sendFeedbackMessage } from './onehr/feedback-conversation';

export { buildAssessmentPanels, importAssessmentPanels } from './onehr/panel-admin-service';

export { getAssessmentProgress, exportAssessmentProgress, getAssessmentAssessorProgress, exportAssessmentAssessorProgress } from './onehr/progress-service';
export { getAssessmentFileTexts,readAssessmentFileTexts } from './onehr/evidence-reading';
export { getAssessmentInsightSource } from './onehr/insight-source';
export { getAssessmentPerformanceInsight } from './onehr/insight-service';
export { suggestAssessmentDevelopmentGoals,applyAssessmentDevelopmentGoals } from './onehr/development-suggestion-service';

export { saveAssessmentProfitAchievement } from './onehr/profit-service';

export { getAssessmentAiSwitches,setAssessmentAiSwitch,ASSESSMENT_AI_FEATURES,type AssessmentAiFeature } from './onehr/ai-settings';

export { rewriteAssessmentField } from './onehr/rewrite-service';
export { suggestAssessmentCareerPlan,applyAssessmentCareerPlan } from './onehr/career-draft-service';
export { getAssessmentReminders,saveAssessmentReminderRules,saveAssessmentReminderWords,previewAssessmentReminder,queueAssessmentReminders,assessmentReminderRecipientsTx,sweepAssessmentReminders } from './onehr/reminder-service';

export { updateAssessmentFramework } from './onehr/service';

export {getAssessmentCompetencyInsight} from './onehr/competency-insight-service';

export {getAssessmentIdpFit} from './onehr/idp-fit-service';

export {getAssessmentPotentialInsight} from './onehr/potential-insight-service';

export {getAssessmentWrittenRemarks} from './onehr/written-remarks-service';

export {getAssessmentRecordInsight} from './onehr/record-insight-service';

export {getAssessmentTalentInsight} from './onehr/talent-insight-service';
export {getAssessmentTalentPerson} from './onehr/talent-person-service';
export {saveAssessmentTalentRemark} from './onehr/service';
export {askPerformanceGuide,getPerformanceGuideReport,exportPerformanceGuideReport,getPerformanceGuideFacts} from './onehr/guide-service';

export {getAssessmentAdminAssistant,askAssessmentAdmin,runAssessmentAdminAction,getAssessmentAdminReadiness,getAssessmentAdminIndex} from './onehr/admin-agent-service';
export {getAssessmentAdminReport,buildAssessmentAdminReport,getAssessmentAdminReportHistory,exportAssessmentAdminReport,assessmentAdminReportLinks,assessmentAdminReportCsv} from './onehr/admin-report-service';
export {buildAssessmentAdminWorkbook} from './onehr/admin-report-xlsx';

export {getAssessmentOverview} from './onehr/overview-service';

// WP-B1 (APR-020) — the Calibration destination (read-only list + the sidebar flag).
export {listMyCalibrationSessions,hasCalibrationAssignment,pendingCalibrationTasks,calibrationListTierOrder,type CalibrationListSession} from './onehr/calibration-list';
// WP-B2 — leader seat registry (BU CEO, BG CEO, group chief), HOD assignment, calibration groups, generated scopes.
export {listLeaderSeats,appointLeaderSeat,endLeaderSeat,listHodAssignments,previewHodChange,applyHodChange,listCalibrationGroups,createCalibrationGroup,renameCalibrationGroup,retireCalibrationGroup,listCalibrationGroupMembers,addCalibrationGroupMembers,endCalibrationGroupMember,generateCalibrationScopes,importLeaders,type LeaderSeatRow,type HodAssignmentRow,type HodPlan,type HodPreviewRow,type GeneratedScopes} from './onehr/leader-seat-service';
export {getLeaderRoster,type LeaderRoster,type LeaderRosterPerson,type LeaderRosterCompany} from './onehr/leader-roster-service';
export {LEADER_SEAT_TYPES,mapLeaderImport,partitionHodPlan,hodPlanFingerprint,type LeaderSeatType,type HodBlocker,type HodWarning,type LeaderImportInput,type LeaderImportPlan} from './onehr/leader-seat-model';
// WP-C (APR-022) — the HOD department view (read-only) and its link flag.
export {getDepartmentView,hasDepartmentView,type DepartmentView} from './onehr/department-view';
// WP-E (CF-08) — two-step result release (the one release writer), the release board and the leader read.
export {releaseOnehrResult,releaseOnehrResults,getOnehrReleaseBoard,listOnehrLedPeople,getOnehrLedPerson,hasLedPeople,type BulkReleaseInput,type BulkReleaseResult,type ReleaseBoardFilters,type ReleaseBoardRow,type ReleaseBoardCell} from './onehr/release-service';
export {releaseResults,releaseSteps,releaseStatuses,ledTabs,type ReleaseComponent,type ReleaseStep,type ReleaseResult,type ReleaseStatus,type LedTab,type LeaderRole,type ChainTier} from './onehr/release-model';
// WP-A3 — leader status data for the home cards (counts, states and dates only; the cards are drawn elsewhere).
export {getLeaderStatus,leaderStatusSchema,type LeaderStatus,type LeaderStatusSeat} from './onehr/leader-status-service';
export {pendingPerformanceTasks} from './onehr/tasks';
export {getPerformanceHomeBlock,hasAssignedPerformanceWork,WHERE_YOU_STAND_RULE,standingPerformance,leaderRailSteps,type WhereYouStandRule,type PerformanceHomeBlock,type HomeStep,type HomeStepKey,type HomeStepState,type HomeNextStep,type HomeStanding,type HomeTeam} from './onehr/home-cards';
// D-P1-32 PT-X1 — the Performance & Talent tab registry (pure), its one facts builder and the per-tab route check.
export {PERFORMANCE_AREA_TABS,PERFORMANCE_STRIP_LABEL_KEYS,performanceAreaStrips,performanceAreaStrip,performanceAreaTab,performanceTabState,activePerformanceTab,type PerformanceAreaFacts,type PerformanceAreaItem,type PerformanceAreaStrip,type PerformanceAreaTab,type PerformanceTabId,type PerformanceTabState,type PerformanceTabView,type PerformanceTabMatch,type OwnFeedbackReport,type PerformanceCalibrationHint,performanceCalibrationHints,CALIBRATION_SESSION_PATHS} from './onehr/tab-model';
export {getPerformanceAreaFacts,getPerformanceAreaFactsAndItems,performanceTabAccess} from './onehr/tab-service';
// D-P1-32 PT-X5 — the admin area's section addresses (pure), for the sidebar's Performance admin entry (app/layout.tsx).
export {adminSectionHref} from './onehr/admin-sections';
export {getPerformanceHome} from './onehr/performance-home-service';
export {performanceHomeLayout,homeNext,homeSlot,notInReason,teamCounts,toolDoors,pastJourney,type PerformanceHomeView,type PerformanceHomeLayout,type PerformanceHomeCardId,type HomeNext,type HomeRow,type HomeSlot,type HomeRail,type NotInReason,type TeamCounts,type HomeToolGroup,type RunningLeaderStatus,type RecordLeaderStatus} from './onehr/performance-home-model';

export {performanceAnalysisSourceTx} from './onehr/analysis-source';
