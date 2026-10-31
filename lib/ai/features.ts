/** Closed workload inventory shared by the gateway and management page. Add a feature before enabling a new model caller. */
export const AI_FEATURES = [
  {id:'hr_assistant',module:'assistant',kind:'assistant',setting:null},
  {id:'provider_evaluation',module:null,kind:'feature',setting:null},
  {id:'module_agent_evaluation',module:'assistant',kind:'feature',setting:null},
  {id:'personnel_import_mapping',module:'employees',kind:'feature',setting:null},
  {id:'module_agent_planning',module:'assistant',kind:'feature',setting:null},
  {id:'readiness_reminders',module:'notifications',kind:'agent',setting:'notifications.readiness_nudge_enabled'},
  {id:'claims_triage',module:'claims',kind:'agent',setting:'claims.input_triage_enabled'},
  // WP13 (R18): deterministic scheduled reminders under the agent principal. Listed so AI management can switch
  // them on (attributed to the administrator), but template-only: they never enter model admission, so the SQL
  // control context does not list them and any admission attempt for them is refused (TEMPLATE_ONLY_AI_FEATURES).
  {id:'approval_chasers',module:'notifications',kind:'agent',setting:'notifications.approval_chasers_enabled'},
  {id:'review_chasers',module:'notifications',kind:'agent',setting:'notifications.review_chasers_enabled'},
  {id:'clock_reminders',module:'notifications',kind:'agent',setting:'notifications.missing_clock_reminders_enabled'},
  {id:'document_reminders',module:'notifications',kind:'agent',setting:'notifications.passport_expiry_reminders_enabled'},
  {id:'lifecycle_chasers',module:'notifications',kind:'agent',setting:'notifications.lifecycle_step_chasers_enabled'},
  {id:'payroll_hypotheses',module:'payroll',kind:'agent',setting:'payroll.anomaly_hypotheses_enabled'},
  {id:'payroll_explanation',module:'payroll',kind:'feature',setting:null},
  {id:'pay_rule_draft',module:'payroll',kind:'feature',setting:null},
  {id:'report_insight',module:null,kind:'feature',setting:null},
  ...(['360','tc','pm','review','idp','calib'] as const).map(id=>({id:`performance_${id}` as const,module:'performance',kind:'feature',setting:`performance.ai_${id}_enabled`})),
  {id:'performance_assistant',module:'performance',kind:'assistant',setting:null},
  {id:'feedback_planning',module:null,kind:'platform',setting:'feedback.ai_planning_enabled'},
] as const;
export type AiFeatureId=typeof AI_FEATURES[number]['id'];
export const isAiFeature=(value:unknown):value is AiFeatureId=>typeof value==='string'&&AI_FEATURES.some(f=>f.id===value);
/** WP13: switchable scheduled agents that make no model call (owner decision 2, 29 Oct 2026). Never admitted. */
export const TEMPLATE_ONLY_AI_FEATURES=Object.freeze(['approval_chasers','review_chasers','clock_reminders','document_reminders','lifecycle_chasers'] as const);
export const isTemplateOnlyAiFeature=(value:unknown):boolean=>typeof value==='string'&&(TEMPLATE_ONLY_AI_FEATURES as readonly string[]).includes(value);
