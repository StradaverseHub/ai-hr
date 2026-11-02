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
 actions:(['view','add','execute'] as const).map(operation=>({operation,parentCapability:'workforce.'+(operation==='execute'?'edit':operation),delegationFloorFunction:'app.workforce_function_delegation_allowed',bindings:[{owner:operation==='execute'?'app.workforce_section_import_allowed':'app.workforce_full_import_allowed',operation:'native-workbook-'+operation},{owner:'core/import-sections.ts',operation:'fresh-existing-subject-native-writer-and-execute'},{owner:'core/personnel-register-import.ts',operation:'actual-hire-receipt-or-existing-subject-execute'},{owner:'app.bank_import_subjects',operation:'bounded-import-view-native-data-projection'},{owner:'core/import.ts',operation:'current-every-file-company-and-prospective-subject-admission'},{owner:'app/admin/personnel/import/page.tsx',operation:'permission-filtered-full-import-companies'}]})),
},{key:'profileChanges.maintenance',scope:'company',moduleKey:'workforce',labelKey:'nav.profileChanges',kind:'native_acl',course:'administrative',screenKey:'profileChanges',href:'/admin/personnel/profile-changes',employeeBearing:true,
 actions:(['view','edit'] as const).map(operation=>({operation,parentCapability:'workforce.'+operation,delegationFloorFunction:'app.profile_changes_maintenance_delegation',bindings:[{owner:'app.workforce_profile_maintenance_allowed',operation:'exact-native-maintenance-source-'+operation},{owner:operation==='view'?'app.profile_request_reader':'app.profile_changes_maintenance_write_guard',operation:'actual-maintenance-'+operation},{owner:'core/profile-routing.ts',operation:operation==='view'?'bounded-reroute-candidates':'native-reasoned-reroute'}]})),
}];
