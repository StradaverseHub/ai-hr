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
  "screenKey": "organization",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "systemLabels",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "systemLabels",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "systemLabels",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "systemLabels",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "systemLabels",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "systemLabels",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "employeeIdConfig",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "employeeIdConfig",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "peopleGeneral",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "dashboardCardConfig",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "loginPresentation",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "workflowEmail",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "emailTemplates",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "entra",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "aiConfig",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "systemTesting",
  "floor": "app.organisation_settings_delegation_allowed"
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
  "screenKey": "systemExplorer",
  "floor": "app.organisation_settings_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.religion",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.religion",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.race",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.race",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.nationality",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.nationality",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.state",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.state",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.country",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.country",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.relationship",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.relationship",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.salutation",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.salutation",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.division",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.division",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.branch",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.branch",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.region",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.region",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.line",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.line",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.section",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.section",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.team",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.team",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.base",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.base",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.category",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.category",
  "kind": "submenu",
  "href": "/admin/settings/system-labels",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.dependentRelationship",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.dependentRelationship",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
 {
  "key": "systemLabels.profileOptions.qualificationLevel",
  "scope": "tenant",
  "parent": "function.systemLabels.profileOptions",
  "labelKey": "admin.profileOptions.category.qualificationLevel",
  "kind": "submenu",
  "href": "/admin/settings/system-labels/profile-options",
  "operations": [
   "view",
   "add",
   "edit",
   "delete"
  ],
  "screenKey": "systemLabels",
  "floor": "app.organisation_profile_option_delegation_allowed"
 },
{
 "key": "profileRequestSettings",
 "scope": "tenant",
 "parent": "settings",
 "labelKey": "nav.profileRequestSettings",
 "kind": "screen",
 "href": "/admin/settings/profile-requests",
 "operations": [
  "view",
  "edit"
 ],
 "screenKey": "profileRequestSettings",
 "floor": "app.organisation_settings_delegation_allowed"
},
{
 "key": "profileApprovalRules",
 "scope": "tenant",
 "parent": "settings",
 "labelKey": "essProfile.approvalRules",
 "kind": "screen",
 "href": "/admin/settings/profile-requests/rules",
 "operations": [
  "view",
  "edit"
 ],
 "screenKey": "profileApprovalRules",
 "floor": "app.organisation_settings_delegation_allowed"
},
{
 "key": "loginPresentation.sessionPolicy",
 "scope": "tenant",
 "parent": "settings",
 "labelKey": "sessionTimeout.settingsTitle",
 "kind": "submenu",
 "href": "/admin/settings/login",
 "operations": [
  "view",
  "edit"
 ],
 "screenKey": "loginPresentation",
 "floor": "app.organisation_settings_delegation_allowed"
},
{key:'dashboardCardConfig.home',scope:'company',parent:'organisation',labelKey:'nav.dashboardCardConfig',kind:'submenu',href:'/admin/settings/dashboard?section=content',operations:['view','edit'],screenKey:'dashboardCardConfig',floor:'app.organisation_settings_delegation_allowed'}
] as const;
export const ORGANISATION_SETTINGS_FUNCTIONS:readonly FunctionActionDescriptor[]=sourceFunctions.map(row=>({
 key:row.key,scope:row.scope,moduleKey:row.parent.startsWith('function.')?'settings':row.parent,labelKey:row.labelKey,kind:row.kind,course:'administrative',screenKey:row.screenKey,href:row.href,employeeBearing:false,
 actions:row.operations.map(operation=>({operation,parentCapability:row.parent+'.'+operation,delegationFloorFunction:row.floor,bindings:[{owner:'app.organisation_settings_function_allowed',operation},{owner:row.key==='dashboardCardConfig.home'?'app.organisation_home_configuration_action':'app.organisation_settings_write_guard',operation:'native-source-purpose'}]})),
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
   {owner:'core/session-policy.ts',operation:'exact-editor-course-not-runtime-authentication-limit'},
   {owner:'app.email_design_admin',operation:'native-template-view'},
   {owner:'app.entra_configure',operation:'native-directory-configuration'},
   {owner:'app.entra_bind',operation:'native-explicit-account-binding'},
   {owner:'app.entra_retry',operation:'native-directory-retry'},
   {owner:'app.organisation_settings_write_guard',operation:'administrative-testing-instructions-and-assignments'},
   {owner:'core/schema-explorer.ts',operation:'read-only-schema-view'},
   {owner:'core/notification-email.ts',operation:'policy-editor-not-own-consent'},
   {owner:'core/ai-config.ts',operation:'configuration-editor-not-provider-runtime'},
   {owner:'app.ai_configuration_native_write_guard',operation:'actual-candidate-and-protocol-receipt-mutation'},
   {owner:'core/ai-provider-readiness.ts',operation:'fresh-edit-before-synthetic-evaluation-and-recording'},
   {owner:'core/admin.ts',operation:'native-grade-and-shared-catalogue'},
  ]})),
 ],
 requiredFunctions:[
  'app.organisation_settings_bindings_complete()',
  'app.organisation_home_configuration_action(uuid,text)',
  'app.organisation_settings_function_allowed(text,text,uuid)',
  'app.organisation_action_allowed(text,uuid)',
  'app.settings_action_allowed(text)',
  'app.organisation_settings_write_guard()',
  'app.ai_configuration_native_write_guard()',
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
