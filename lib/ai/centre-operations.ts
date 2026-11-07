/** Business operations that shared a gateway feature now have independent child restrictions.
 * This metadata grants nothing; each owner retains its native feature, scope and adjudication. */
export const AI_CENTRE_OPERATIONS=Object.freeze([
 {id:'pay_formula_draft',label:'Draft a pay formula',owner:'core/pay-formula-ai.ts#draftPayFormula'},
 {id:'pay_rule_draft',label:'Draft a pay rule',owner:'core/pay-rule-ai.ts#draftPayRule'},
 {id:'report_spec_draft',label:'Draft a report',owner:'core/report-ai.ts#draftReportSpec'},
 {id:'domain_analysis',label:'Analyse an HR domain',owner:'core/ai-domain-analysis.ts#generateDomainAnalysis'},
 {id:'workforce_analysis',label:'Analyse workforce trends',owner:'core/ai-workforce-analysis.ts#generateWorkforceAnalysis'},
 {id:'payroll_comparison',label:'Explain payroll comparisons',owner:'core/ai-payroll-comparison-analysis.ts#generatePrivatePayrollComparisonAnalysis'},
 {id:'feedback_plan',label:'Draft a feedback plan',owner:'core/feedback.ts#generateFeedbackPlan'},
 {id:'manager_review_draft',label:'Draft a manager review',owner:'core/performance.ts#draftManagerReview'},
 {id:'development_goals',label:'Suggest development goals',owner:'packs/performance/onehr/development-suggestion-service.ts#suggestAssessmentDevelopmentGoals'},
 {id:'career_plan',label:'Suggest a career plan',owner:'packs/performance/onehr/career-draft-service.ts#suggestAssessmentCareerPlan'},
 {id:'performance_rewrite',label:'Rewrite a Performance draft',owner:'packs/performance/onehr/rewrite-service.ts#rewriteAssessmentField'},
 {id:'performance_guide',label:'Ask the Performance guide',owner:'packs/performance/onehr/guide-service.ts#askPerformanceGuide'},
 {id:'performance_admin',label:'Ask the Performance administrator assistant',owner:'packs/performance/onehr/admin-agent-service.ts#askAssessmentAdmin'},
 {id:'competency_insight',label:'Generate competency insights',owner:'packs/performance/onehr/competency-insight-service.ts#getAssessmentCompetencyInsight'},
 {id:'performance_insight',label:'Generate Performance insights',owner:'packs/performance/onehr/insight-service.ts#getAssessmentPerformanceInsight'},
] as const);
