/** Code-owned native action bindings. Publication refuses absent/unqualified owner prerequisites.
 * Existing role/company/native command floors remain authoritative; reference pickers are independent.
 */
const operations = ['view','add','edit','delete'] as const;
export const ORGANISATION_SETTINGS_CAPABILITY_PUBLICATION = {
 capabilities:[
  ...operations.map(operation=>({id:`organisation.${operation}`,scope:'company' as const,bindings:[
   {owner:'app.organisation_action_allowed',operation},
   {owner:'app.organisation_settings_write_guard',operation:'raw-current-and-proposed-organisation'},
   {owner:'core/admin.ts',operation:'native-company-structure-and-labels'},
   {owner:'core/system-labels.ts',operation:'criteria-company-ceiling'},
  ]})),
  ...operations.map(operation=>({id:`settings.${operation}`,scope:'tenant' as const,bindings:[
   {owner:'app.settings_action_allowed',operation},
   {owner:'app.organisation_settings_write_guard',operation:'raw-shared-catalogue-and-policy'},
   {owner:'core/employee-id-config.ts',operation:'native-global-configuration-not-private-number-allocation'},
   {owner:'core/people-general.ts',operation:'native-revisioned-policy'},
   {owner:'core/admin.ts',operation:'native-grade-and-shared-catalogue'},
  ]})),
 ],
 requiredFunctions:[
  'app.organisation_action_allowed(text,uuid)',
  'app.settings_action_allowed(text)',
  'app.organisation_settings_write_guard()',
  'app.organisation_settings_legacy_allowed(uuid,uuid,text,uuid)',
  'app.organisation_settings_delegation_allowed(uuid,uuid,text,uuid)',
  'app.organisation_company_born(uuid)',
  'app.organisation_allocate_employee_code(uuid)',
 ],
 legacyGroups:Object.fromEntries([
  ...operations.map(operation=>[`organisation.${operation}`,['system_administrator','hr_admin'] as const]),
  ...operations.map(operation=>[`settings.${operation}`,['system_administrator'] as const]),
 ]),
 legacyParityFunction:'app.organisation_settings_legacy_allowed',
 delegationFloorFunction:'app.organisation_settings_delegation_allowed',
} as const;
