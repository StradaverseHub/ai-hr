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
