/** Concrete native screen gates; this is not whole Workforce submenu closure. The full publisher
 * must additionally bind draft/import/report/register purposes before its completion prerequisite. */
import type {FunctionActionDescriptor} from './function-action-contract';
export const WORKFORCE_FUNCTIONS:readonly FunctionActionDescriptor[]=[{
 key:'workforceRecords',scope:'company',moduleKey:'workforce',labelKey:'accessConfiguration.capabilities.workforceView',
 kind:'screen',course:'administrative',screenKey:'workforceRecords',href:'/admin/personnel',employeeBearing:true,
 actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'workforce.'+operation,
  delegationFloorFunction:'app.workforce_function_delegation_allowed',bindings:[
   {owner:operation==='view'?'app.access_workforce_projection_company':'app.access_workforce_action_company',operation:'exact-screen-'+operation},
   {owner:'core/workforce-access.ts',operation:'fresh-principal-data-and-company-scope'},
  ]})),
},{key:'profileChanges.maintenance',scope:'company',moduleKey:'workforce',labelKey:'nav.profileChanges',kind:'native_acl',course:'administrative',screenKey:'profileChanges',href:'/admin/personnel/profile-changes',employeeBearing:true,
 actions:(['view','edit'] as const).map(operation=>({operation,parentCapability:'workforce.'+operation,delegationFloorFunction:'app.profile_changes_maintenance_delegation',bindings:[{owner:'app.workforce_profile_maintenance_allowed',operation:'exact-native-maintenance-source-'+operation},{owner:operation==='view'?'app.profile_request_reader':'app.profile_changes_maintenance_write_guard',operation:'actual-maintenance-'+operation},{owner:'core/profile-routing.ts',operation:operation==='view'?'bounded-reroute-candidates':'native-reasoned-reroute'}]})),
}];
