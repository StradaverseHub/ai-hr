import {FINANCIAL_LETTER_FUNCTIONS} from './financial-letter-function-bindings';
/** Code-owned action bindings; only the restricted publisher may activate these after complete checks. */
const finance=[
 ...['view','add','edit','delete'].map(operation=>({id:`payroll.${operation}`,scope:'company' as const,bindings:[
  {owner:operation==='view'?'app.can_admin_payroll_for':'app.access_financial_write_guard',operation:`payroll-${operation}`},
  {owner:'app.access_financial_action_company',operation:'fresh-native-company-function-floor'},
 ]})),
 ...['view','add','edit','delete'].map(operation=>({id:`performance_compensation.${operation}`,scope:'company' as const,bindings:[
  {owner:operation==='view'?'app.can_admin_perfcomp_for':'app.access_financial_write_guard',operation:`performance-compensation-${operation}`},
  {owner:'app.access_financial_action_company',operation:'fresh-native-company-function-floor'},
 ]})),
];
const letters=['view','add','edit','delete','approve','issue'].map(operation=>({id:`letters.${operation}`,scope:'company' as const,bindings:[
 {owner:'app.access_letter_action_for_user',operation:`letters-${operation}`},
 {owner:operation==='view'?'app.letter_permission_for_user_at':'app.access_letter_write_guard',operation:'native-letter-acl-and-exact-action-floor'},
]}));
const letterLegacy=['system_administrator','hr_admin'];
export const FINANCIAL_LETTER_CAPABILITY_PUBLICATION={
 capabilities:[...finance,...letters],
 functions:FINANCIAL_LETTER_FUNCTIONS,
 functionLegacyParityFunction:'app.financial_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.financial_function_current_legacy_allowed',
 legacyParityFunction:'app.financial_letter_legacy_allowed',
 currentLegacyParityFunction:'app.financial_letter_current_legacy_allowed',
 delegationFloorFunction:'app.financial_letter_delegation_allowed',
 requiredFunctions:[
  // Defined only after the complete installed action binding inventory passes review.
  'app.financial_letter_bindings_complete()',
  'app.financial_letter_legacy_allowed(uuid,uuid,text,uuid)',
  'app.financial_letter_current_legacy_allowed(uuid,uuid,text,uuid)',
  'app.financial_letter_delegation_allowed(uuid,uuid,text,uuid)',
  'app.access_financial_action_company(text,uuid,text)',
  'app.access_financial_action_employment(text,uuid,text)',
  'app.access_financial_write_guard()',
  'app.access_letter_action_for_user(uuid,uuid,uuid,text,text)',
  'app.access_letter_write_guard()',
 ],
 legacyGroups:Object.fromEntries([...finance,...letters].map(capability=>[capability.id,
  capability.id.startsWith('payroll.')?['system_administrator','hr_admin','payroll_partner']:
  capability.id.startsWith('performance_compensation.')?['system_administrator','hr_admin','performance_comp_partner']:letterLegacy,
 ])) as Record<string,readonly string[]>,
} as const;

export const LETTER_OPERATIONS_CAPABILITY_PUBLICATION={
 ...FINANCIAL_LETTER_CAPABILITY_PUBLICATION,
 capabilities:letters,
 functions:FINANCIAL_LETTER_FUNCTIONS.filter(descriptor=>descriptor.moduleKey==='letters'),
 legacyGroups:Object.fromEntries(letters.map(capability=>[capability.id,letterLegacy])),
 requiredFunctions:[
  'app.letter_operations_bindings_complete()',
  'app.access_letter_action_for_user(uuid,uuid,uuid,text,text)',
  'app.access_letter_write_guard()',
  'app.letter_function_action(text,text,uuid)',
  'app.letter_recipient_function_action(text)',
 ],
} as const;

export const ONEHR_PLAN_ACKNOWLEDGEMENT_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:FINANCIAL_LETTER_FUNCTIONS.filter(descriptor=>descriptor.key==='performance.onehr.planAcknowledgement'),
 functionLegacyParityFunction:FINANCIAL_LETTER_CAPABILITY_PUBLICATION.functionLegacyParityFunction,
 functionCurrentLegacyParityFunction:FINANCIAL_LETTER_CAPABILITY_PUBLICATION.functionCurrentLegacyParityFunction,
 legacyGroups:{},
 requiredFunctions:[
  'app.onehr_plan_acknowledgement_bindings_complete()',
  'app.onehr_plan_acknowledgement_action(uuid,text)',
  'app.onehr_plan_acknowledge(uuid,integer,boolean,uuid,text)',
  'app.financial_onehr_plan_acknowledgement_guard()',
 ],
} as const;

export const ONEHR_PANEL_FEEDBACK_CAPABILITY_PUBLICATION={
 ...ONEHR_PLAN_ACKNOWLEDGEMENT_CAPABILITY_PUBLICATION,
 functions:FINANCIAL_LETTER_FUNCTIONS.filter(descriptor=>descriptor.key==='performance.onehr.panelFeedback'),
 requiredFunctions:[
  'app.onehr_panel_feedback_bindings_complete()',
  'app.onehr_feedback_card(uuid)',
  'app.onehr_feedback_apply(uuid,boolean,jsonb,text,jsonb)',
  'app.financial_onehr_feedback_delta_guard()',
  'app.financial_onehr_draft_write_guard()',
 ],
} as const;
