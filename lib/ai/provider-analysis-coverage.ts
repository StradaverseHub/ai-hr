import {providerDataReviewStatus} from './provider-data-reviews';
/** Candidate analysis coverage only. No listed contract is specialist-approved or activated here.
 * Existing feature/source/actor/spend checks still apply; a candidate grants no new native workflow.
 * Exact raw drafts, individual assessments, import labels/documents and vision remain blocked. */
import {AI_FEATURES,type AiFeatureId} from './features';
export const ANALYSIS_DOMAIN_METRICS=Object.freeze({
 workforce:Object.freeze(['active_workforce','joiners','departures','vacancies','onboarding_completion'] as const),
 attendance:Object.freeze(['scheduled_hours','attendance_consistency','lateness_frequency','absence_frequency','overtime_hours'] as const),
 leave:Object.freeze(['leave_taken','leave_pending','leave_coverage','leave_cancellation_volume'] as const),
 payroll:Object.freeze(['payroll_cost','headcount','overtime_cost','employer_contribution_cost','variable_pay_cost'] as const),
 claims:Object.freeze(['expense_total','claim_volume','processing_time','returned_claim_share'] as const),
 performance:Object.freeze(['review_completion','goal_progress','development_plan_completion','feedback_participation'] as const),
 rewards:Object.freeze(['review_completion','budget_utilisation','proposal_volume'] as const),
 organisation:Object.freeze(['open_workload','overdue_workload','completed_workload','handoff_volume','approval_wait_time'] as const),
});
export type ProviderAnalysisDomain=keyof typeof ANALYSIS_DOMAIN_METRICS;
export const ANALYSIS_DOMAIN_DRIVERS=Object.freeze({
 workforce:Object.freeze(['recorded_hiring_volume','recorded_departure_volume','recorded_vacancy_change','recorded_onboarding_progress'] as const),
 attendance:Object.freeze(['recorded_schedule_change','recorded_overtime_change','recorded_attendance_change'] as const),
 leave:Object.freeze(['recorded_request_volume','recorded_coverage_change','recorded_cancellation_volume'] as const),
 payroll:Object.freeze(['recorded_headcount_change','recorded_overtime_change','recorded_pay_policy_change','recorded_contribution_policy_change'] as const),
 claims:Object.freeze(['recorded_claim_volume','recorded_expense_mix','recorded_processing_backlog'] as const),
 performance:Object.freeze(['recorded_cycle_progress','recorded_participation_change','recorded_development_activity'] as const),
 rewards:Object.freeze(['recorded_cycle_progress','recorded_proposal_volume','recorded_budget_change'] as const),
 organisation:Object.freeze(['recorded_intake_change','recorded_completion_change','recorded_handoff_change','recorded_review_wait_change'] as const),
});
export const ANALYSIS_DOMAIN_CATEGORIES=Object.freeze({
 workforce:Object.freeze(['employees','contractors','open_positions','onboarding'] as const),
 attendance:Object.freeze(['scheduled_work','completed_work','late_arrivals','absence','overtime'] as const),
 leave:Object.freeze(['pending','approved','cancelled'] as const),
 payroll:Object.freeze(['base_pay','overtime','variable_pay','employer_contributions'] as const),
 claims:Object.freeze(['travel','meals','supplies','other'] as const),
 performance:Object.freeze(['not_started','in_progress','completed'] as const),
 rewards:Object.freeze(['not_started','in_review','completed'] as const),
 organisation:Object.freeze(['open','overdue','completed','awaiting_review'] as const),
});
const all=Object.freeze(Object.keys(ANALYSIS_DOMAIN_METRICS) as ProviderAnalysisDomain[]);
const featureDomains:Readonly<Partial<Record<AiFeatureId,readonly ProviderAnalysisDomain[]>>>=Object.freeze({
 hr_assistant:all,report_insight:all,
 readiness_reminders:Object.freeze(['workforce','organisation'] as const),
 claims_triage:Object.freeze(['claims'] as const),
 payroll_hypotheses:Object.freeze(['payroll'] as const),payroll_explanation:Object.freeze(['payroll'] as const),pay_rule_draft:Object.freeze(['payroll'] as const),
 performance_360:Object.freeze(['performance'] as const),performance_tc:Object.freeze(['performance'] as const),performance_pm:Object.freeze(['performance'] as const),
 performance_review:Object.freeze(['performance'] as const),performance_idp:Object.freeze(['performance'] as const),performance_calib:Object.freeze(['performance','rewards'] as const),
 performance_assistant:Object.freeze(['performance','rewards'] as const),
});
export const BLOCKED_ANALYSIS_VARIANTS=Object.freeze(['raw_free_text','raw_documents','raw_images','exact_personal_amounts','exact_dates','individual_ratings_or_recommendations','import_header_mapping','unstructured_drafting'] as const);
/** Every registered feature has an explicit entry: absence of an analysis candidate is a refusal,
 * never an implicit approval or a fallback to the old unmasked workload. */
export const PROVIDER_ANALYSIS_COVERAGE=Object.freeze(AI_FEATURES.map(feature=>Object.freeze({feature:feature.id,
 domains:featureDomains[feature.id]??Object.freeze([] as ProviderAnalysisDomain[]),
 operations:Object.freeze(feature.id==='hr_assistant'?['conversation','draft'] as const:featureDomains[feature.id]?['draft'] as const:[]),
 reviewStatus:providerDataReviewStatus('aggregate_comparison_analysis_v1'),blockedVariants:BLOCKED_ANALYSIS_VARIANTS})));
