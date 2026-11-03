import type {FunctionActionDescriptor} from './function-action-contract';
/** Exact tenant catalogue owner, separate from company payroll operational authority. */
export const FINANCIAL_SETUP_FUNCTIONS:readonly FunctionActionDescriptor[]=[
 {key:'payroll.historyImport',scope:'company',moduleKey:'payroll',labelKey:'payroll.historyImport.title',kind:'submenu',course:'administrative',screenKey:'payroll',href:'/payroll/history-import',employeeBearing:true,
  actions:['view','add','edit','delete'].map(operation=>({operation:operation as 'view'|'add'|'edit'|'delete',parentCapability:'payroll.'+operation,delegationFloorFunction:'app.financial_history_delegation_allowed',bindings:[{owner:'app.financial_history_function_action',operation},{owner:'app.financial_history_begin',operation:'actual-planned-money-operation'},{owner:'app.financial_history_revert_begin',operation:'exact-restoration'},{owner:'app.financial_history_write_guard',operation:'queued-native-money-and-audit-proof'}]}))},
 {key:'payComponents.catalogue',scope:'tenant',moduleKey:'payroll',labelKey:'admin.users.screen.payComponents',kind:'submenu',course:'administrative',screenKey:'payComponents',href:'/admin/pay-components',
  actions:['view','add','edit','delete'].map(operation=>({operation:operation as 'view'|'add'|'edit'|'delete',parentCapability:'payroll_configuration.'+operation,delegationFloorFunction:'app.financial_setup_delegation_allowed',bindings:[{owner:'app.financial_setup_catalog_function',operation},{owner:'core/pay-components.ts',operation:'purpose-and-native-operation'},{owner:'app.financial_setup_write_guard',operation:'actual-row-logical-operation'}]}))},
 {key:'payComponents.formulaBuilder',scope:'tenant',moduleKey:'payroll',labelKey:'payFormula.title',kind:'submenu',course:'administrative',screenKey:'payComponents',href:'/payroll/formula-builder',
  actions:['view','add','edit','delete'].map(operation=>({operation:operation as 'view'|'add'|'edit'|'delete',parentCapability:'payroll_configuration.'+operation,delegationFloorFunction:'app.financial_setup_delegation_allowed',bindings:[{owner:'app.financial_setup_catalog_function',operation},{owner:'core/pay-formula.ts',operation:'authoring-purpose-and-native-operation'},{owner:'app.financial_setup_write_guard',operation:'actual-row-logical-operation'}]}))},
];
export const FINANCIAL_SETUP_CAPABILITY_PUBLICATION={
 functions:FINANCIAL_SETUP_FUNCTIONS,
 functionLegacyParityFunction:'app.financial_setup_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.financial_setup_function_current_legacy_allowed',
 capabilities:['view','add','edit','delete'].map(operation=>({id:`payroll_configuration.${operation}`,scope:'tenant' as const,bindings:[
  {owner:'app.financial_setup_catalog_action',operation},
  {owner:'app.financial_setup_write_guard',operation:'native-catalogue-logical-operation'},
  {owner:'app.pay_formula_catalog_access',operation:'builder-purpose-not-calculation-definition-read'},
 ]})),
 requiredFunctions:[
  'app.financial_setup_catalog_action(text)',
  'app.financial_setup_catalog_function(text,text)',
  'app.financial_setup_write_guard()',
  'app.financial_setup_legacy_allowed(uuid,uuid,text,uuid)',
  'app.financial_setup_delegation_allowed(uuid,uuid,text,uuid)',
  'app.financial_setup_bindings_complete()',
 ],
 legacyGroups:Object.fromEntries(['view','add','edit','delete'].map(operation=>[`payroll_configuration.${operation}`,['system_administrator','hr_admin']])),
 legacyParityFunction:'app.financial_setup_legacy_allowed',
 currentLegacyParityFunction:'app.financial_setup_current_legacy_allowed',
 delegationFloorFunction:'app.financial_setup_delegation_allowed',
} as const;

export const PAY_COMPONENT_CATALOGUE_CAPABILITY_PUBLICATION={
 ...FINANCIAL_SETUP_CAPABILITY_PUBLICATION,
 functions:FINANCIAL_SETUP_FUNCTIONS.filter(descriptor=>descriptor.key.startsWith('payComponents.')),
 requiredFunctions:[
  'app.pay_component_catalogue_bindings_complete()',
  'app.financial_setup_catalog_action(text)',
  'app.financial_setup_catalog_function(text,text)',
  'app.financial_setup_write_guard()',
  'app.pay_formula_catalog_access()',
 ],
} as const;
