/** Concrete native screen gates; this is not whole Workforce submenu closure. The full publisher
 * must additionally close draft/report/register and other import purposes before its completion prerequisite. */
import type {FunctionActionDescriptor} from './function-action-contract';
export const WORKFORCE_FUNCTIONS:readonly FunctionActionDescriptor[]=[{
 key:'workforceRecords',scope:'company',moduleKey:'workforce',labelKey:'accessConfiguration.capabilities.workforceView',
 kind:'screen',course:'administrative',screenKey:'workforceRecords',href:'/admin/personnel',employeeBearing:true,
 actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'workforce.'+operation,
  delegationFloorFunction:'app.workforce_function_delegation_allowed',bindings:[
   {owner:operation==='view'?'app.access_workforce_projection_company':'app.access_workforce_action_company',operation:'exact-screen-'+operation},
   {owner:'core/workforce-access.ts',operation:'fresh-principal-data-and-company-scope'},
  ]})),
},{key:'workforceImports',scope:'company',moduleKey:'workforce',labelKey:'people.import.title',kind:'submenu',course:'administrative',screenKey:'personnelAdmin',href:'/admin/personnel/import',employeeBearing:true,
 actions:(['view','add','execute'] as const).map(operation=>({
  operation,parentCapability:'workforce.'+(operation==='execute'?'edit':operation),
  delegationFloorFunction:'app.workforce_function_delegation_allowed',
  bindings:operation==='execute'?[
   {owner:'app.workforce_section_import_allowed',operation:'exact-existing-company-execute'},
   {owner:'core/import-sections.ts',operation:'current-employment-and-person-scope-on-direct-and-queued-bank-writes'},
   {owner:'core/personnel-register-import.ts',operation:'existing-register-execute-and-reviewed-qualification-rows'},
   {owner:'app.qualification_import_preview_subject_guard',operation:'database-admission-of-signed-section-subjects'},
   {owner:'core/movement-import.ts',operation:'current-and-proposed-company-execute'},
   {owner:'core/information-correction-import.ts',operation:'current-employment-and-both-company-scopes'},
   {owner:'core/cost-allocation-import.ts',operation:'current-company-and-employment-execute'},
  ]:[
   {owner:'app.workforce_full_import_allowed',operation:'native-workbook-'+operation},
   {owner:'core/import.ts',operation:'current-every-file-company-and-prospective-subject-admission'},
   {owner:'app/admin/personnel/import/page.tsx',operation:'permission-filtered-workbench-companies'},
   ...(operation==='view'?[{owner:'app.bank_import_subjects',operation:'bounded-import-view-native-data-projection'}]:[]),
  ],
 })),
},{key:'profileChanges.maintenance',scope:'company',moduleKey:'workforce',labelKey:'nav.profileChanges',kind:'native_acl',course:'administrative',screenKey:'profileChanges',href:'/admin/personnel/profile-changes',employeeBearing:true,
 actions:(['view','edit'] as const).map(operation=>({operation,parentCapability:'workforce.'+operation,delegationFloorFunction:'app.profile_changes_maintenance_delegation',bindings:[{owner:'app.workforce_profile_maintenance_allowed',operation:'exact-native-maintenance-source-'+operation},{owner:operation==='view'?'app.profile_request_reader':'app.profile_changes_maintenance_write_guard',operation:'actual-maintenance-'+operation},{owner:'core/profile-routing.ts',operation:operation==='view'?'bounded-reroute-candidates':'native-reasoned-reroute'}]})),
}];

/** The own author course never supplies company administration or hire activation. */
export const WORKFORCE_DRAFT_FUNCTIONS:readonly FunctionActionDescriptor[]=[{
 key:'workforceDrafts',scope:'company',moduleKey:'workforce',labelKey:'people.wizard.title',kind:'submenu',course:'administrative',screenKey:'personnelAdmin',href:'/admin/personnel/new',employeeBearing:true,
 actions:(['view','add','edit','delete','execute']as const).map(operation=>({operation,parentCapability:'workforce.'+(operation==='execute'?'add':operation),delegationFloorFunction:'app.workforce_draft_admin_delegation',bindings:[
  {owner:operation==='view'?'app.workforce_draft_view_current':operation==='execute'?'app.access_workforce_prepare_hire_source':'app.workforce_draft_purpose_guard',operation:'actual-draft-'+operation},
  {owner:'core/employee-draft.ts',operation:'native-reservation-draft-save-discard-and-completed-hire'},
 ]})),
},{key:'workforceDrafts.author',scope:'tenant',moduleKey:'workforce',labelKey:'people.wizard.continueTitle',kind:'native_acl',course:'own',screenKey:'personnelAdmin',href:'/admin/personnel/new',employeeBearing:false,
 actions:(['view','add','edit','delete']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.workforce_draft_author_current_legacy_allowed',bindings:[
  {owner:operation==='view'?'app.workforce_draft_view_current':'app.workforce_draft_purpose_guard',operation:'actual-current-author-'+operation},
  {owner:'app.access_workforce_draft',operation:'original-author-or-native-administrative-course'},
 ]})),
}];


export const WORKFORCE_IMPORT_REVERT_FUNCTIONS:readonly FunctionActionDescriptor[]=[{
 key:'workforceImports.revert',scope:'company',moduleKey:'workforce',labelKey:'people.import.title',kind:'submenu',course:'administrative',screenKey:'personnelAdmin',href:'/admin/personnel/import/history',employeeBearing:true,
 actions:(['view','execute','delete']as const).map(operation=>({operation,parentCapability:'workforce.'+(operation==='execute'?'edit':operation),delegationFloorFunction:'app.workforce_function_delegation_allowed',
  bindings:[{owner:'app.import_attempt_revert_current',operation:'whole-actual-applied-item-set-and-'+operation},
   {owner:operation==='delete'?'app.employment_void':'core/import-history.ts',operation:operation==='delete'?'complete-imported-hire-void':'native-compensation-for-entire-attempt'}]})),
}];

/** Existing-employee Execute and new-employee Add share navigation and retain separate owners. */
export const WORKFORCE_IMPORTS_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:WORKFORCE_FUNCTIONS.filter(descriptor=>descriptor.key==='workforceImports'),
 functionLegacyParityFunction:'app.workforce_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.workforce_function_current_legacy_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.workforce_imports_bindings_complete()',
  'app.workforce_full_import_allowed(uuid,text)',
  'app.workforce_section_import_allowed(uuid,text)',
  'app.bank_import_subjects(jsonb)',
  'app.qualification_import_preview_subject_guard()',
 ],
} as const;

export const WORKFORCE_DRAFT_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:WORKFORCE_DRAFT_FUNCTIONS.filter(descriptor=>descriptor.key==='workforceDrafts'),
 functionLegacyParityFunction:'app.workforce_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.workforce_function_current_legacy_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.workforce_drafts_bindings_complete()',
  'app.workforce_draft_actions_current(uuid)',
  'app.access_workforce_prepare_hire_source(uuid,uuid)',
  'app.access_workforce_consumed_draft(jsonb)',
 ],
} as const;

export const WORKFORCE_DRAFT_AUTHOR_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:WORKFORCE_DRAFT_FUNCTIONS.filter(descriptor=>descriptor.key==='workforceDrafts.author'),
 functionLegacyParityFunction:'app.workforce_draft_author_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.workforce_draft_author_current_legacy_allowed',
 legacyGroups:{},
 requiredFunctions:['app.workforce_drafts_bindings_complete()'],
} as const;
