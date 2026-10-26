/** Closed workload inventory shared by the gateway and management page. Add a feature before enabling a new model caller. */
export const AI_FEATURES = [
  {id:'hr_assistant',module:'assistant',kind:'assistant',setting:null},
  {id:'provider_evaluation',module:null,kind:'feature',setting:null},
  {id:'module_agent_evaluation',module:'assistant',kind:'feature',setting:null},
  {id:'readiness_reminders',module:'notifications',kind:'agent',setting:'notifications.readiness_nudge_enabled'},
  {id:'claims_triage',module:'claims',kind:'agent',setting:'claims.input_triage_enabled'},
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
