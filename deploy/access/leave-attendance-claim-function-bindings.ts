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
 {key:'leave.onBehalf.application',scope:'company',moduleKey:'leave',labelKey:'leave.accessFunctions.onBehalfApplication',kind:'native_acl',course:'administrative',screenKey:'leave',href:'/leave',employeeBearing:true,
  actions:(['view','add'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.leave_on_behalf_application_current_native_allowed',bindings:[{owner:'app.leave_on_behalf_application_allowed',operation:'actual-nonself-native-permission-visibility-and-profile'},{owner:'core/leave.ts',operation:'requestLeave-native-on-behalf-source'},...(operation==='add'?[{owner:'app.leave_pending_application_guard',operation:'actual-pending-source-insert'}]:[])]}))},
 {key:'leave.own.application',scope:'company',moduleKey:'leave',labelKey:'leave.accessFunctions.ownApplication',kind:'native_acl',course:'own',screenKey:'leave',href:'/leave',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.leave_own_application_current_native_allowed',bindings:[{owner:'app.leave_own_application_allowed',operation:'actual-person-owned-employment-'+operation},{owner:'core/leave.ts',operation:'native-request-pending-edit-or-pending-withdrawal'},...(operation==='add'?[{owner:'app.leave_pending_application_guard',operation:'actual-own-pending-source-insert'}]:[])]}))},
 ...(['assignments','escalation'] as const).map(key=>({key:'leaveApproval.'+key,scope:'company' as const,moduleKey:'leave',labelKey:key==='assignments'?'leaveApproval.assignmentTemplateTitle':'leaveApproval.escalationTitle',kind:'native_acl' as const,course:'administrative' as const,screenKey:'leaveApproval',href:'/admin/leave-config/approval-chains',employeeBearing:false,
  actions:(key==='assignments'?['view','add','edit','delete'] as const:['view','edit'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.leave_approval_company_current_native_allowed',bindings:[{owner:key==='assignments'?(operation==='view'?'app.leave_approval_company_allowed':'app.leave_approval_assignment_guard'):operation==='view'?'app.leave_approval_company_allowed':'app.leave_approval_escalation_source_allowed',operation:'actual-company-'+key+'-'+operation},{owner:key==='assignments'?'core/leave-approval-template.ts':'core/leave-approval-policy.ts',operation:'native-source-company-and-logical-operation'}]}))})),
 {key:'leaveApproval.templates',scope:'tenant',moduleKey:'leave',labelKey:'leaveApproval.templateCreationTitle',kind:'native_acl',course:'administrative',screenKey:'leaveApproval',href:'/admin/leave-config/approval-chains',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.leave_approval_template_current_native_allowed',bindings:[{owner:operation==='view'?'app.leave_approval_template_allowed':'app.leave_approval_template_guard',operation:'native-tenant-template-'+operation},{owner:'core/leave-approval-template.ts',operation:'actual-constructor-duplicate-archive-default-and-maintenance-owner'}]}))},
 {key:'attendancePolicy.clockingSites',scope:'tenant',moduleKey:'attendance',labelKey:'nav.locations',kind:'submenu',course:'administrative',screenKey:'locations',href:'/admin/work-locations/clocking',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'attendance_configuration.'+operation,delegationFloorFunction:'app.clocking_site_current_native_allowed',bindings:[{owner:operation==='view'?'app.clocking_site_allowed':'app.clocking_site_guard',operation:'native-shared-clocking-site-'+operation},{owner:'app.clocking_site_company_guard',operation:'real-parent-birth-edit-or-consumed-removal'},{owner:'core/clocking-location.ts',operation:'actual-shared-site-owner-and-independent-reference-reader'}]}))},
 ...(['dutyRoster','exceptions'] as const).map(key=>({key:'attendancePolicy.'+key,scope:'tenant' as const,moduleKey:'attendance',labelKey:key==='dutyRoster'?'boardSchedule.duty':'boardSchedule.exception',kind:'native_acl' as const,course:'administrative' as const,screenKey:'attendancePolicy',href:'/admin/attendance/schedule',employeeBearing:false,
  actions:(['view','edit'] as const).map(operation=>({operation,parentCapability:'function.attendancePolicy.schedule.'+operation,delegationFloorFunction:'app.attendance_schedule_control_current_native_allowed',bindings:[{owner:operation==='view'?'app.attendance_schedule_control_allowed':'app.attendance_schedule_control_guard',operation:'actual-'+key+'-'+operation},{owner:'core/schedule-group-controls.ts',operation:'native-control-setter-and-reference-lookups'}]}))})),
 {key:'attendancePolicy.rotations',scope:'tenant',moduleKey:'attendance',labelKey:'admin.rotation.title',kind:'native_acl',course:'administrative',screenKey:'attendancePolicy',href:'/admin/attendance/schedule',employeeBearing:false,
  actions:(['view','edit'] as const).map(operation=>({operation,parentCapability:'function.attendancePolicy.schedule.'+operation,delegationFloorFunction:'app.attendance_rotation_current_native_allowed',bindings:[{owner:operation==='view'?'app.attendance_rotation_allowed':'app.attendance_rotation_action_guard',operation:'native-dated-rotation-'+operation},{owner:'core/attendance-rotation.ts',operation:'actual-immutable-version-owner-and-role-floor'},{owner:'core/attendance-rule.ts',operation:'actual-Group-copy-initialization-with-group-only-role'}]}))},
 {key:'attendancePolicy.shifts',scope:'tenant',moduleKey:'attendance',labelKey:'nav.shift',kind:'submenu',course:'administrative',screenKey:'attendancePolicy',href:'/admin/attendance',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'attendance_configuration.'+operation,delegationFloorFunction:'app.module_action_current_legacy_allowed',bindings:[{owner:operation==='view'?'app.attendance_shift_allowed':'app.attendance_shift_guard',operation:'native-shift-'+operation},{owner:'app.attendance_shift_window_guard',operation:'parent-birth-replacement-or-actual-removal-course'},{owner:'core/roster.ts',operation:'actual-create-copy-edit-archive-delete-and-pay-settings'},{owner:'app.shift_initial_membership_allowed',operation:'finite-original-first-constructor-membership'}]}))},
 {key:'attendancePolicy.schedule',scope:'tenant',moduleKey:'attendance',labelKey:'nav.workSchedule',kind:'submenu',course:'administrative',screenKey:'attendancePolicy',href:'/admin/attendance/schedule',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'attendance_configuration.'+operation,delegationFloorFunction:'app.module_schedule_delegation_allowed',bindings:[{owner:operation==='view'?'app.module_function_allowed':'app.module_attendance_rule_guard',operation:'native-schedule-'+operation},{owner:'app.attendance_standard_rule_ensure',operation:'finite-canonical-Standard-default'},{owner:'core/attendance-rule.ts',operation:'actual-schedule-owner'}]}))},
 {key:'leaveConfig.gradeGroups',scope:'tenant',moduleKey:'leave',labelKey:'admin.benefitScheme.groupsTitle',kind:'submenu',course:'administrative',screenKey:'leaveConfig',href:'/admin/settings/system-labels',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'leave_configuration.'+operation,delegationFloorFunction:'app.module_action_current_legacy_allowed',bindings:[{owner:operation==='view'?'app.module_function_allowed':'app.module_grade_group_member_guard',operation:'native-grade-group-'+operation},{owner:'core/benefit-scheme.ts',operation:'actual-grade-group-owner'},{owner:'app.module_grade_group_source_record',operation:'actual-parent-birth-or-cascade-deletion'}]}))},
 {key:'leaveConfig.types',scope:'tenant',moduleKey:'leave',labelKey:'admin.leave.typesSectionTitle',kind:'submenu',course:'administrative',screenKey:'leaveConfig',href:'/admin/leave-config/types',employeeBearing:false,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:'leave_configuration.'+operation,delegationFloorFunction:'app.module_action_current_legacy_allowed',bindings:[{owner:operation==='view'?'app.module_function_allowed':'app.module_catalogue_action_guard',operation:'native-leave-type-'+operation},{owner:'core/admin.ts',operation:'actual-leave-type-owner'}]}))},
 ...(['drafts','submit'] as const).map(key=>({key:'claims.own.'+key,scope:'company' as const,moduleKey:'claims',labelKey:'claims.accessFunctions.'+key,kind:'native_acl' as const,course:'own' as const,employeeBearing:false,
  actions:(key==='drafts'?['view','add','edit','delete'] as const:['view','execute'] as const).map(operation=>({operation,parentCapability:'function.claims.own.view',delegationFloorFunction:'app.claim_own_current_native_allowed',bindings:[{owner:operation==='view'?(key==='drafts'?'app.claim_own_read_allowed':'core/claims.ts'):key==='drafts'&&operation==='delete'?'app.claim_draft_delete_native':'app.claim_own_request_guard',operation:'native-own-'+key+'-'+operation},{owner:'core/claims.ts',operation:key==='drafts'?'actual-own-draft-owner':'native-submit-pricing-and-reservation'}]}))})),
 {key:'claims.own.receipts',scope:'company',moduleKey:'claims',labelKey:'claims.accessFunctions.receipts',kind:'native_acl',course:'own',employeeBearing:false,
  actions:(['view','add'] as const).map(operation=>({operation,parentCapability:'function.claims.own.view',delegationFloorFunction:'app.claim_own_current_native_allowed',bindings:[{owner:operation==='view'?'app.claim_own_receipt_read_allowed':'app.claim_own_receipt_native',operation:'actual-own-receipt-'+operation},{owner:'app.claim_own_receipt_guard',operation:'exact-native-source-and-completed-byte-audit'},{owner:'core/claims.ts',operation:'actual-logical-draft-submit-or-receipt-owner'}]}))},
 {key:'claims.own',scope:'company',moduleKey:'claims',labelKey:'claims.accessFunctions.own',kind:'native_acl',course:'own',employeeBearing:false,
  actions:(['view','delete'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.claim_own_current_native_allowed',bindings:[{owner:'app.claim_cancel_native',operation:'actual-self-pending-cancellation'},{owner:'app.claim_native_effect_approved',operation:'same-purpose-final-denial'}]}))},
 ...(['related','administration'] as const).map(key=>({key:'claims.'+key+'.receipts',scope:'company' as const,moduleKey:'claims',labelKey:'claims.accessFunctions.'+key+'Receipts',kind:'native_acl' as const,course:'administrative' as const,employeeBearing:true,
  actions:(['view','add'] as const).map(operation=>({operation,parentCapability:'function.claims.'+key+'.view',delegationFloorFunction:'app.claim_receipt_current_native_allowed',bindings:[{owner:operation==='view'?'app.claim_own_receipt_read_allowed':'app.claim_receipt_native',operation:'native-'+key+'-receipt-'+operation},{owner:'app.claim_own_receipt_guard',operation:'actual-native-byte-source-and-completed-audit'}]}))})),
 {key:'claims.selfDecision',scope:'company',moduleKey:'claims',labelKey:'claims.accessFunctions.selfDecision',kind:'native_acl',course:'own',employeeBearing:true,
  actions:(['view','approve'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.claim_self_decision_current_native_allowed',bindings:[{owner:operation==='view'?'app.claim_source_read_allowed':'app.claim_command_guard',operation:'native-self-super-'+operation},{owner:'app.claim_self_decision_native_allowed',operation:'actual-own-super-and-data-profile-floor'}]}))},
 ...(['related','assigned'] as const).map(key=>({key:'claims.'+key,scope:'company' as const,moduleKey:'claims',labelKey:'claims.accessFunctions.'+key,kind:'native_acl' as const,course:key==='assigned'?'assigned' as const:'administrative' as const,employeeBearing:key!=='assigned',
  actions:(key==='assigned'?['view','approve'] as const:['view','execute','approve'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.claim_nonself_current_native_allowed',bindings:[{owner:operation==='view'?'app.claim_source_read_allowed':'app.claim_command_guard',operation:'actual-'+key+'-claim-'+operation},{owner:'core/claims.ts',operation:'native-source-pricing-decision-and-audit'}]}))})),
 {key:'claims.administration',scope:'company',moduleKey:'claims',labelKey:'claims.accessFunctions.administration',kind:'native_acl',course:'administrative',employeeBearing:true,
  actions:(['view','delete','execute','approve'] as const).map(operation=>({operation,parentCapability:'claims.'+(operation==='execute'?'add':operation==='approve'?'edit':operation),delegationFloorFunction:'app.module_action_delegation_allowed',bindings:[{owner:operation==='execute'||operation==='approve'?'app.claim_command_guard':operation==='view'?'app.claim_source_read_allowed':'app.claim_cancel_native',operation:'native-admin-claim-'+operation},{owner:operation==='execute'||operation==='approve'?'app.claim_command_born':'app.claim_native_effect_approved',operation:'same-purpose-final-source-and-audit'}]}))},
 {key:'claimsConfig.reimbursements',scope:'company',moduleKey:'claims',labelKey:'admin.claimsTabs.reimbursements',kind:'submenu',course:'administrative',screenKey:'claimsConfig',href:'/admin/claims/reimbursements',employeeBearing:true,
  actions:(['view','execute'] as const).map(operation=>({operation,parentCapability:operation==='view'?'claims.view':'claims.edit',delegationFloorFunction:'app.module_action_delegation_allowed',bindings:[{owner:operation==='view'?'core/claims.ts':'app.claim_reimburse_native',operation:operation==='view'?'native-scoped-payment-list-csv':'finite-native-confirmed-reimbursement'},{owner:'app.claim_native_effect_approved',operation:'same-purpose-final-denial'}]}))},
];

export const CLAIM_CONFIGURATION_CAPABILITY_PUBLICATION={
 capabilities:(['view','add','edit','delete'] as const).map(operation=>({
  id:'claims_configuration.'+operation,scope:'tenant' as const,bindings:[
   {owner:'app.module_action_allowed',operation:'native-claim-configuration-'+operation},
   {owner:operation==='view'?'app.module_function_allowed':'app.module_configuration_action_guard',operation:'exact-maintained-source'},
  ],
 })),
 functions:CLAIM_CONFIGURATION_FUNCTIONS,
 legacyParityFunction:'app.module_action_legacy_allowed',
 currentLegacyParityFunction:'app.module_action_current_native_default',
 functionLegacyParityFunction:'app.module_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.module_function_current_legacy_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.claim_configuration_bindings_complete()',
  'app.module_action_allowed(text,text,uuid)',
  'app.module_function_allowed(text,text,uuid)',
  'app.module_configuration_action_guard()',
  'app.claim_configuration_admit(text,uuid,uuid,uuid,text)',
  'app.claim_configuration_range_close()',
 ],
} as const;

export const LEAVE_CONFIGURATION_CAPABILITY_PUBLICATION={
 capabilities:(['view','add','edit','delete'] as const).map(operation=>({
  id:'leave_configuration.'+operation,scope:'tenant' as const,bindings:[
   {owner:'app.module_action_allowed',operation:'native-leave-configuration-'+operation},
   {owner:operation==='view'?'app.module_function_allowed':'app.module_catalogue_action_guard',operation:'exact-maintained-source'},
  ],
 })),
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='leaveConfig.types'||descriptor.key==='leaveConfig.gradeGroups'),
 legacyParityFunction:'app.module_action_legacy_allowed',
 currentLegacyParityFunction:'app.module_action_current_native_default',
 functionLegacyParityFunction:'app.module_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.module_function_current_legacy_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.leave_configuration_bindings_complete()',
  'app.module_action_allowed(text,text,uuid)',
  'app.module_function_allowed(text,text,uuid)',
  'app.module_catalogue_action_guard()',
  'app.module_grade_group_member_guard()',
 ],
} as const;

export const ATTENDANCE_SCHEDULE_CAPABILITY_PUBLICATION={
 capabilities:(['view','add','edit','delete'] as const).map(operation=>({
  id:'attendance_configuration.'+operation,scope:'tenant' as const,bindings:[
   {owner:'app.module_action_allowed',operation:'native-attendance-configuration-'+operation},
  ],
 })),
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='attendancePolicy.schedule'),
 legacyParityFunction:'app.module_action_legacy_allowed',
 currentLegacyParityFunction:'app.module_action_current_native_default',
 functionLegacyParityFunction:'app.module_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.module_function_current_legacy_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.attendance_schedule_bindings_complete()',
  'app.module_attendance_rule_guard()',
  'app.module_attendance_delete_floor()',
  'app.module_configuration_write_lock()',
 ],
} as const;

export const ATTENDANCE_SHIFT_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='attendancePolicy.shifts'),
 functionLegacyParityFunction:'app.module_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.module_function_current_legacy_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.attendance_shift_bindings_complete()',
  'app.attendance_shift_guard()',
  'app.attendance_shift_window_guard()',
  'app.shift_initial_membership_complete()',
 ],
} as const;

export const CLOCKING_SITE_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='attendancePolicy.clockingSites'),
 functionLegacyParityFunction:'app.clocking_site_native_allowed',
 functionCurrentLegacyParityFunction:'app.clocking_site_current_native_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.clocking_site_bindings_complete()',
  'app.clocking_site_allowed(text)',
  'app.clocking_site_guard()',
  'app.clocking_site_company_guard()',
 ],
} as const;

export const ATTENDANCE_ROTATION_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='attendancePolicy.rotations'),
 functionLegacyParityFunction:'app.attendance_rotation_native_allowed',
 functionCurrentLegacyParityFunction:'app.attendance_rotation_current_native_allowed',
 legacyGroups:{},
 requiredFunctions:['app.attendance_schedule_controls_bindings_complete()','app.attendance_rotation_allowed(text)','app.attendance_rotation_action_guard()'],
} as const;

export const ATTENDANCE_SCHEDULE_CONTROL_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='attendancePolicy.dutyRoster'||descriptor.key==='attendancePolicy.exceptions'),
 functionLegacyParityFunction:'app.attendance_schedule_control_native_allowed',
 functionCurrentLegacyParityFunction:'app.attendance_schedule_control_current_native_allowed',
 legacyGroups:{},
 requiredFunctions:['app.attendance_schedule_controls_bindings_complete()','app.attendance_schedule_control_allowed(text,text)','app.attendance_schedule_control_guard()'],
} as const;

export const LEAVE_EMPLOYEE_RECORDS_VIEW_CAPABILITY_PUBLICATION={
 capabilities:[{id:'leave.view',scope:'company',bindings:[
  {owner:'app.module_action_allowed',operation:'native-leave-administrative-view'},
 ]}],
 functions:[{
  key:'leaveEmployeeRecords',scope:'company',moduleKey:'leave',labelKey:'admin.users.screen.leaveEmployeeRecords',
  kind:'screen',course:'administrative',screenKey:'leaveEmployeeRecords',href:'/leave/employee-records',employeeBearing:true,
  actions:[{operation:'view',parentCapability:'leave.view',delegationFloorFunction:'app.module_action_delegation_allowed',bindings:[
   {owner:'app.leave_employee_records_company_allowed',operation:'native-company-view'},
   {owner:'app.leave_employee_records_subject_allowed',operation:'current-employment-and-data-profile-view'},
   {owner:'core/read.ts',operation:'bounded-records-page-export-and-cursor'},
   {owner:'core/leave-inquiry.ts',operation:'bounded-company-and-employee-picker'},
  ]}],
 }],
 legacyParityFunction:'app.module_action_legacy_allowed',
 currentLegacyParityFunction:'app.module_action_current_native_default',
 functionLegacyParityFunction:'app.module_function_legacy_allowed',
 functionCurrentLegacyParityFunction:'app.module_function_current_legacy_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.module_action_allowed(text,text,uuid)',
  'app.leave_employee_records_company_allowed(uuid,text)',
  'app.leave_employee_records_subject_allowed(uuid,text)',
 ],
} as const;

export const LEAVE_OWN_APPLICATION_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='leave.own.application'),
 functionLegacyParityFunction:'app.leave_own_application_native_allowed',
 functionCurrentLegacyParityFunction:'app.leave_own_application_current_native_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.leave_own_application_bindings_complete()',
  'app.leave_own_application_allowed(uuid,text)',
  'app.leave_own_request_view_allowed(uuid)',
  'app.leave_own_withdraw(uuid)',
 ],
} as const;

export const LEAVE_EMPLOYEE_RECORDS_CAPABILITY_PUBLICATION={
 ...LEAVE_EMPLOYEE_RECORDS_VIEW_CAPABILITY_PUBLICATION,
 capabilities:[...LEAVE_EMPLOYEE_RECORDS_VIEW_CAPABILITY_PUBLICATION.capabilities,
  {id:'leave.delete',scope:'company',bindings:[
   {owner:'app.module_action_allowed',operation:'native-leave-administrative-delete'},
  ]},
 ],
 functions:LEAVE_EMPLOYEE_RECORDS_VIEW_CAPABILITY_PUBLICATION.functions.map(descriptor=>({
  ...descriptor,
  actions:[...descriptor.actions,{
   operation:'delete' as const,parentCapability:'leave.delete',delegationFloorFunction:'app.module_action_delegation_allowed',
   bindings:[
    {owner:'app.leave_employee_record_cancel_allowed',operation:'current-subject-status-and-self-exception'},
    {owner:'app.leave_request_mutation_guard',operation:'pending-administrative-cancellation'},
    {owner:'app.leave_approved_cancellation_guard',operation:'approved-administrative-cancellation-and-separate-give-back'},
    {owner:'core/leave.ts',operation:'native-whole-cancellation-ledger-and-audit'},
   ],
  }],
 })),
 requiredFunctions:[...LEAVE_EMPLOYEE_RECORDS_VIEW_CAPABILITY_PUBLICATION.requiredFunctions,
  'app.leave_employee_records_delete_bindings_complete()',
  'app.leave_employee_record_cancel_allowed(uuid)',
 ],
} as const;

export const LEAVE_ON_BEHALF_APPLICATION_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='leave.onBehalf.application'),
 functionLegacyParityFunction:'app.leave_on_behalf_application_native_allowed',
 functionCurrentLegacyParityFunction:'app.leave_on_behalf_application_current_native_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.leave_on_behalf_application_bindings_complete()',
  'app.leave_on_behalf_application_allowed(uuid)',
  'app.leave_on_behalf_native(uuid)',
 ],
} as const;

export const LEAVE_APPROVAL_TEMPLATE_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='leaveApproval.templates'),
 functionLegacyParityFunction:'app.leave_approval_template_native_allowed',
 functionCurrentLegacyParityFunction:'app.leave_approval_template_current_native_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.leave_approval_template_bindings_complete()',
  'app.leave_approval_template_allowed(text)',
  'app.leave_approval_template_guard()',
 ],
} as const;

export const LEAVE_APPROVAL_COMPANY_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:LEAVE_ATTENDANCE_CLAIM_FUNCTIONS.filter(descriptor=>descriptor.key==='leaveApproval.assignments'||descriptor.key==='leaveApproval.escalation'),
 functionLegacyParityFunction:'app.leave_approval_company_native_allowed',
 functionCurrentLegacyParityFunction:'app.leave_approval_company_current_native_allowed',
 legacyGroups:{},
 requiredFunctions:[
  'app.leave_approval_company_bindings_complete()',
  'app.leave_approval_company_allowed(text,text,uuid)',
  'app.leave_approval_assignment_slot(uuid,uuid,uuid,text,integer,integer)',
  'app.leave_approval_assignment_guard()',
  'app.leave_approval_escalation_write_guard()',
 ],
} as const;
