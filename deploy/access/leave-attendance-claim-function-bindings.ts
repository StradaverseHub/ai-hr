/** In progress: concrete Claim configuration gates only. Operational Claim/Leave/Attendance and
 * independent employee/assignee courses must be bound before the complete module package publishes. */
import type {FunctionActionDescriptor} from './function-action-contract';
const CLAIM_CONFIGURATION_FUNCTIONS:readonly FunctionActionDescriptor[]=(['types','limits','mileage'] as const).map(key=>({
 key:'claimsConfig.'+key,scope:'tenant',moduleKey:'claims',labelKey:'admin.claimsTabs.'+key,
 kind:'submenu',course:'administrative',screenKey:'claimsConfig',href:key==='types'?'/admin/claims':'/admin/claims/'+key,employeeBearing:false,
 actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'claims_configuration.'+operation,
  delegationFloorFunction:'app.module_action_current_legacy_allowed',bindings:[
   {owner:operation==='view'?'app.module_function_allowed':'app.module_configuration_action_guard',operation:'exact-submenu-'+operation},
   {owner:'core/claims.ts',operation:key==='types'?'native-type-item-form-field':key==='limits'?'native-dated-policy':'native-dated-mileage-bands'},
   ...((operation==='edit'||operation==='delete')&&key!=='types'?[{owner:'app.claim_configuration_range_close',operation:'deferred-logical-dated-operation'}]:[]),
  ]})),
}));

export const LEAVE_ATTENDANCE_CLAIM_FUNCTIONS:readonly FunctionActionDescriptor[]=[...CLAIM_CONFIGURATION_FUNCTIONS,
 {key:'claims.own',scope:'company',moduleKey:'claims',labelKey:'claims.title',kind:'native_acl',course:'own',employeeBearing:false,
  actions:(['view','delete'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.claim_own_current_native_allowed',bindings:[{owner:'app.claim_cancel_native',operation:'actual-self-pending-cancellation'},{owner:'app.claim_native_effect_approved',operation:'same-purpose-final-denial'}]}))},
 {key:'claims.administration',scope:'company',moduleKey:'claims',labelKey:'claims.title',kind:'native_acl',course:'administrative',employeeBearing:true,
  actions:(['view','delete'] as const).map(operation=>({operation,parentCapability:'claims.'+operation,delegationFloorFunction:'app.module_action_current_legacy_allowed',bindings:[{owner:'app.claim_cancel_native',operation:'native-admin-data-and-pending-cancellation'},{owner:'app.claim_native_effect_approved',operation:'same-purpose-final-denial'}]}))},
 {key:'claimsConfig.reimbursements',scope:'company',moduleKey:'claims',labelKey:'admin.claimsTabs.reimbursements',kind:'submenu',course:'administrative',screenKey:'claimsConfig',href:'/admin/claims/reimbursements',employeeBearing:true,
  actions:(['view','execute'] as const).map(operation=>({operation,parentCapability:operation==='view'?'claims.view':'claims.edit',delegationFloorFunction:'app.module_action_current_legacy_allowed',bindings:[{owner:operation==='view'?'core/claims.ts':'app.claim_reimburse_native',operation:operation==='view'?'native-scoped-payment-list-csv':'finite-native-confirmed-reimbursement'},{owner:'app.claim_native_effect_approved',operation:'same-purpose-final-denial'}]}))},
];
