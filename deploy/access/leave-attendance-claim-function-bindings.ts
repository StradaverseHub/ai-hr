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
 {key:'attendancePolicy.schedule',scope:'tenant',moduleKey:'attendance',labelKey:'nav.workSchedule',kind:'submenu',course:'administrative',screenKey:'attendancePolicy',href:'/admin/attendance/schedule',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'attendance_configuration.'+operation,delegationFloorFunction:'app.module_schedule_delegation_allowed',bindings:[{owner:operation==='view'?'app.module_function_allowed':'app.module_attendance_rule_guard',operation:'native-schedule-'+operation},{owner:'app.attendance_standard_rule_ensure',operation:'finite-canonical-Standard-default'},{owner:'core/attendance-rule.ts',operation:'actual-schedule-owner'}]}))},
 {key:'leaveConfig.gradeGroups',scope:'tenant',moduleKey:'leave',labelKey:'admin.benefitScheme.groupsTitle',kind:'submenu',course:'administrative',screenKey:'leaveConfig',href:'/admin/settings/system-labels',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'leave_configuration.'+operation,delegationFloorFunction:'app.module_action_current_legacy_allowed',bindings:[{owner:operation==='view'?'app.module_function_allowed':'app.module_grade_group_member_guard',operation:'native-grade-group-'+operation},{owner:'core/benefit-scheme.ts',operation:'actual-grade-group-owner'},{owner:'app.module_grade_group_source_record',operation:'actual-parent-birth-or-cascade-deletion'}]}))},
 {key:'leaveConfig.types',scope:'tenant',moduleKey:'leave',labelKey:'admin.leave.typesSectionTitle',kind:'submenu',course:'administrative',screenKey:'leaveConfig',href:'/admin/leave-config/types',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'leave_configuration.'+operation,delegationFloorFunction:'app.module_action_current_legacy_allowed',bindings:[{owner:operation==='view'?'app.module_function_allowed':'app.module_catalogue_action_guard',operation:'native-leave-type-'+operation},{owner:'core/admin.ts',operation:'actual-leave-type-owner'}]}))},
 {key:'claims.own',scope:'company',moduleKey:'claims',labelKey:'claims.title',kind:'native_acl',course:'own',employeeBearing:false,
  actions:(['view','delete'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.claim_own_current_native_allowed',bindings:[{owner:'app.claim_cancel_native',operation:'actual-self-pending-cancellation'},{owner:'app.claim_native_effect_approved',operation:'same-purpose-final-denial'}]}))},
 {key:'claims.administration',scope:'company',moduleKey:'claims',labelKey:'claims.title',kind:'native_acl',course:'administrative',employeeBearing:true,
  actions:(['view','delete'] as const).map(operation=>({operation,parentCapability:'claims.'+operation,delegationFloorFunction:'app.module_action_delegation_allowed',bindings:[{owner:'app.claim_cancel_native',operation:'native-admin-data-and-pending-cancellation'},{owner:'app.claim_native_effect_approved',operation:'same-purpose-final-denial'}]}))},
 {key:'claimsConfig.reimbursements',scope:'company',moduleKey:'claims',labelKey:'admin.claimsTabs.reimbursements',kind:'submenu',course:'administrative',screenKey:'claimsConfig',href:'/admin/claims/reimbursements',employeeBearing:true,
  actions:(['view','execute'] as const).map(operation=>({operation,parentCapability:operation==='view'?'claims.view':'claims.edit',delegationFloorFunction:'app.module_action_delegation_allowed',bindings:[{owner:operation==='view'?'core/claims.ts':'app.claim_reimburse_native',operation:operation==='view'?'native-scoped-payment-list-csv':'finite-native-confirmed-reimbursement'},{owner:'app.claim_native_effect_approved',operation:'same-purpose-final-denial'}]}))},
];
