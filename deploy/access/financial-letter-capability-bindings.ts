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
const letterLegacy=['system_administrator','hr_admin','manager','employee','payroll_partner','performance_comp_partner'];
export const FINANCIAL_LETTER_CAPABILITY_PUBLICATION={
 capabilities:[...finance,...letters],
 requiredFunctions:[
  'app.financial_letter_legacy_allowed(uuid,uuid,text,uuid)',
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
