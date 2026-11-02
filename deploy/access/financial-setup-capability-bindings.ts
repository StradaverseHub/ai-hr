/** Exact tenant catalogue owner, separate from company payroll operational authority. */
export const FINANCIAL_SETUP_CAPABILITY_PUBLICATION={
 capabilities:['view','add','edit','delete'].map(operation=>({id:`payroll_configuration.${operation}`,scope:'tenant' as const,bindings:[
  {owner:'app.financial_setup_catalog_action',operation},
  {owner:'app.financial_setup_write_guard',operation:'native-catalogue-logical-operation'},
  {owner:'app.pay_formula_catalog_access',operation:'builder-purpose-not-calculation-definition-read'},
 ]})),
 requiredFunctions:[
  'app.financial_setup_catalog_action(text)',
  'app.financial_setup_write_guard()',
  'app.financial_setup_legacy_allowed(uuid,uuid,text,uuid)',
  'app.financial_setup_delegation_allowed(uuid,uuid,text,uuid)',
  'app.financial_setup_bindings_complete()',
 ],
 legacyGroups:Object.fromEntries(['view','add','edit','delete'].map(operation=>[`payroll_configuration.${operation}`,['system_administrator','hr_admin']])),
 legacyParityFunction:'app.financial_setup_legacy_allowed',
 delegationFloorFunction:'app.financial_setup_delegation_allowed',
} as const;
