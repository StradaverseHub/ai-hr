import type {FunctionActionDescriptor} from './function-action-contract';
const sourceFunctions=[
 {
  "key": "organization",
  "scope": "company",
  "parent": "organisation",
  "labelKey": "nav.organization",
  "kind": "screen",
  "href": "/admin/organization",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "organization"
 },
 {
  "key": "systemLabels.department",
  "scope": "company",
  "parent": "organisation",
  "labelKey": "admin.systemLabels.category.department",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels"
 },
 {
  "key": "systemLabels.position",
  "scope": "company",
  "parent": "organisation",
  "labelKey": "admin.systemLabels.category.position",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels"
 },
 {
  "key": "systemLabels.cost_center",
  "scope": "company",
  "parent": "organisation",
  "labelKey": "admin.systemLabels.category.cost_center",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels"
 },
 {
  "key": "systemLabels.business_unit",
  "scope": "company",
  "parent": "organisation",
  "labelKey": "admin.systemLabels.category.business_unit",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels"
 },
 {
  "key": "systemLabels.jobGrade",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "admin.systemLabels.category.grade",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels"
 },
 {
  "key": "systemLabels.profileOptions",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.profileOptions",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels"
 },
 {
  "key": "employeeIdConfig.company",
  "scope": "company",
  "parent": "organisation",
  "labelKey": "nav.employeeIdConfig",
  "kind": "submenu",
  "href": "/admin/settings/employee-id",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "employeeIdConfig"
 },
 {
  "key": "employeeIdConfig.global",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.employeeIdConfig",
  "kind": "submenu",
  "href": "/admin/settings/employee-id",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "employeeIdConfig"
 },
 {
  "key": "peopleGeneral",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.peopleGeneral",
  "kind": "screen",
  "href": "/admin/settings/people-general",
  "operations": [
   "view",
   "edit"
  ],
  "screenKey": "peopleGeneral"
 },
 {
  "key": "dashboardCardConfig",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.dashboardCardConfig",
  "kind": "screen",
  "href": "/admin/settings/dashboard",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "dashboardCardConfig"
 },
 {
  "key": "loginPresentation",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.loginPresentation",
  "kind": "screen",
  "href": "/admin/settings/login",
  "operations": [
   "view",
   "edit"
  ],
  "screenKey": "loginPresentation"
 },
 {
  "key": "workflowEmail",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.workflowEmail",
  "kind": "screen",
  "href": "/admin/settings/notifications",
  "operations": [
   "view",
   "edit"
  ],
  "screenKey": "workflowEmail"
 },
 {
  "key": "emailTemplates",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.emailTemplates",
  "kind": "screen",
  "href": "/admin/settings/email-templates",
  "operations": [
   "view",
   "edit"
  ],
  "screenKey": "emailTemplates"
 },
 {
  "key": "entra",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.entra",
  "kind": "screen",
  "href": "/admin/settings/entra",
  "operations": [
   "view",
   "edit"
  ],
  "screenKey": "entra"
 },
 {
  "key": "aiConfig",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.aiConfig",
  "kind": "screen",
  "href": "/control-tower/agents/provider",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "aiConfig"
 },
 {
  "key": "systemTesting",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.systemTesting",
  "kind": "screen",
  "href": "/admin/system-testing",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemTesting"
 },
 {
  "key": "systemExplorer",
  "scope": "tenant",
  "parent": "settings",
  "labelKey": "nav.systemExplorer",
  "kind": "screen",
  "href": "/admin/system-explorer",
  "operations": [
   "view"
  ],
  "screenKey": "systemExplorer"
 }
] as const;
export const ORGANISATION_SETTINGS_FUNCTIONS:readonly FunctionActionDescriptor[]=sourceFunctions.map(row=>({
 key:row.key,scope:row.scope,moduleKey:row.parent,labelKey:row.labelKey,kind:row.kind,course:'administrative',screenKey:row.screenKey,href:row.href,employeeBearing:false,
 actions:row.operations.map(operation=>({operation,parentCapability:row.parent+'.'+operation,delegationFloorFunction:'app.organisation_settings_delegation_allowed',bindings:[{owner:'app.organisation_settings_function_allowed',operation},{owner:'app.organisation_settings_write_guard',operation:'native-source-purpose'}]})),
}));
/** Code-owned native action bindings. Publication refuses absent/unqualified owner prerequisites.
 * Existing role/company/native command floors remain authoritative; reference pickers are independent.
 */
const operations = ['view','add','edit','delete'] as const;
export const ORGANISATION_SETTINGS_CAPABILITY_PUBLICATION = {
 functions:ORGANISATION_SETTINGS_FUNCTIONS,
 functionLegacyParityFunction:'app.organisation_settings_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.organisation_settings_function_current_legacy_allowed',
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
   {owner:'app.organisation_settings_write_guard',operation:'dashboard-login-provider-email-entra-tenant-setting'},
   {owner:'app.email_design_admin',operation:'native-template-view'},
   {owner:'app.entra_configure',operation:'native-directory-configuration'},
   {owner:'app.entra_bind',operation:'native-explicit-account-binding'},
   {owner:'app.entra_retry',operation:'native-directory-retry'},
   {owner:'app.organisation_settings_write_guard',operation:'administrative-testing-instructions-and-assignments'},
   {owner:'core/schema-explorer.ts',operation:'read-only-schema-view'},
   {owner:'core/notification-email.ts',operation:'policy-editor-not-own-consent'},
   {owner:'core/ai-config.ts',operation:'configuration-editor-not-provider-runtime'},
   {owner:'core/admin.ts',operation:'native-grade-and-shared-catalogue'},
  ]})),
 ],
 requiredFunctions:[
  'app.organisation_settings_bindings_complete()',
  'app.organisation_settings_function_allowed(text,text,uuid)',
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
 currentLegacyParityFunction:'app.organisation_settings_current_legacy_allowed',
 delegationFloorFunction:'app.organisation_settings_delegation_allowed',
} as const;
