/** Source ownership inventory. The completion function deliberately remains absent until every
 * specific function/action is enforced by its native owner and exact independent effects are proven.
 * A route or this inventory is never publication authority by itself. */
export const LIFECYCLE_REWARD_NOTICE_FUNCTION_OWNERS = {
 noticeBoard:{domain:'notices',configurationDomain:'notices_global',owners:['core/notice.ts','app.notice_owner_action_allowed','app.notice_action_write_guard'],independent:['own-live-recipient','own-versioned-acknowledgement']},
 onboardingV31:{domain:'lifecycle',owners:['packs/lifecycle/onboarding/service.ts','packs/lifecycle/v9/service.ts'],independent:['exact-own-document','exact-assigned-checklist-task']},
 onboardingChecklists:{domain:'lifecycle_configuration',owners:['packs/lifecycle/onboarding/service.ts','packs/lifecycle/v9/service.ts'],independent:[]},
 onboardingSettings:{domain:'lifecycle_configuration',owners:['packs/lifecycle/onboarding/service.ts','packs/lifecycle/v9/service.ts'],independent:[]},
 onboardingGroups:{domain:'lifecycle_configuration',owners:['packs/lifecycle/onboarding/service.ts'],independent:['own-actual-participating-group-picker']},
 onboardingModuleAccess:{domain:'lifecycle_configuration',owners:['packs/lifecycle/onboarding/service.ts'],independent:[]},
 onboardingRequisitions:{domain:'lifecycle',owners:['packs/lifecycle/onboarding/service.ts','packs/lifecycle/v9/service.ts','core/lifecycle-it.ts'],independent:['exact-current-assigned-approval','exact-current-fulfilment-item','own-device-return']},
 onboardingAcknowledgement:{domain:'lifecycle',owners:['packs/lifecycle/onboarding/service.ts','core/lifecycle-self.ts','app.lc_my_daa_submit_owner','app.onboarding_v9_receipt'],independent:['own-device-acknowledgement']},
 lifecycleConfig:{domain:'lifecycle_configuration',owners:['core/lifecycle-config.ts'],independent:['native-workflow-reference-definitions']},
 rewards:{domain:'rewards',owners:['packs/rewards/service.ts'],independent:['actual-eligible-unit-member-review']},
 rewardsApprovals:{domain:'rewards',owners:['packs/rewards/service.ts'],independent:['actual-current-unit-stage-assignee']},
 rewardsAdmin:{domain:'rewards',configurationDomain:'rewards_configuration',owners:['packs/rewards/service.ts','packs/rewards/policy-groups.ts','packs/rewards/shared-governance.ts'],independent:[]},
 rewardsPolicy:{domain:'rewards',owners:['packs/rewards/service.ts'],independent:['actual-group-rewards-unit-workflow']},
 rewardsAccess:{domain:'rewards',owners:['packs/rewards/maintenance.ts','app.reward_access_request_create','app.reward_access_request_apply'],independent:[]},
} as const;

/** Notice authoring is an actual guarded source slice; other Lifecycle/Rewards bindings remain
 * in progress and this descriptor list is not a complete family publication prerequisite. */
import type {FunctionActionDescriptor} from './function-action-contract';
export const NOTICE_AUTHOR_FUNCTIONS:readonly FunctionActionDescriptor[]=[
 ...(['noticeBoard','noticeBoard.global'] as const).map(key=>({key,scope:key==='noticeBoard'?'company' as const:'tenant' as const,moduleKey:'notices',labelKey:'nav.noticeBoard',kind:key==='noticeBoard'?'screen' as const:'native_acl' as const,course:'administrative' as const,screenKey:'noticeBoard',href:'/admin/notice-board',employeeBearing:true,
  actions:(['view','add','edit','delete'] as const).map(operation=>({operation,parentCapability:(key==='noticeBoard'?'notices.':'notices_global.')+operation,delegationFloorFunction:'app.lifecycle_reward_notice_delegation_allowed',bindings:[{owner:'app.notice_owner_action_allowed',operation},{owner:'app.notice_action_write_guard',operation:'actual-logical-operation'},{owner:'core/notice.ts',operation:'native-current-and-proposed-owner'}]}))})),
];

export const LIFECYCLE_TASK_FUNCTIONS:readonly FunctionActionDescriptor[]=[
 {key:'lifecycle.shared.tasks',scope:'company',moduleKey:'lifecycle',labelKey:'nav.myTasks',kind:'native_acl',course:'assigned',href:'/tasks',employeeBearing:false,
 actions:(['view','execute'] as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.lifecycle_task_function_legacy_allowed',bindings:[{owner:'app.onboarding_checklist_task_rows',operation:'current-native-queue'},{owner:'app.onboarding_delivery_task_detail',operation:'bounded-current-review'},{owner:'app.onboarding_assigned_task_rows',operation:'finite-actual-assignment-read'},{owner:'app.lc_v9_work',operation:'finite-actual-assignment-read'},{owner:'app.lifecycle_native_effect_begin',operation:'same-purpose-admission'},{owner:'app.lifecycle_native_effect_approved',operation:'same-purpose-final-proof'},{owner:'app.lifecycle_native_effect_cleanup',operation:'same-purpose-final-audit'}]}))},
];

export const LIFECYCLE_DELIVERY_FUNCTIONS:readonly FunctionActionDescriptor[]=(['lifecycle.shared.handover','lifecycle.shared.requisitionNotes','lifecycle.self.acknowledgement','lifecycle.shared.fulfilment']as const).map(key=>({key,scope:'company',moduleKey:'lifecycle',labelKey:'nav.myTasks',kind:'native_acl',course:key==='lifecycle.self.acknowledgement'?'own':'assigned',href:'/tasks',employeeBearing:false,
 actions:(['view','execute']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.lifecycle_delivery_function_legacy_allowed',bindings:[{owner:'app.onboarding_delivery_task_rows',operation:'current-native-queue'},{owner:'app.onboarding_delivery_task_detail',operation:'bounded-current-review'},{owner:key==='lifecycle.shared.fulfilment'?'app.onboarding_fulfil_item':'app.onboarding_delivery_update',operation:'native-selected-command'},{owner:'app.lifecycle_native_effect_begin',operation:'same-purpose-admission'},{owner:'app.lifecycle_native_effect_approved',operation:'same-purpose-final-proof'},{owner:'app.lifecycle_native_effect_cleanup',operation:'same-purpose-final-audit'}]}))}));

export const LIFECYCLE_CONVERSATION_FUNCTIONS:readonly FunctionActionDescriptor[]=[{key:'lifecycle.shared.conversations',scope:'company',moduleKey:'lifecycle',labelKey:'nav.myTasks',kind:'native_acl',course:'assigned',href:'/tasks',employeeBearing:false,
 actions:(['view','execute']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.lifecycle_conversation_function_legacy_allowed',bindings:[{owner:'app.onboarding_delivery_task_rows',operation:'current-native-mention-queue'},{owner:'app.onboarding_delivery_task_detail',operation:'bounded-current-conversation-review'},{owner:'app.onboarding_conversation_assigned',operation:'exact-current-task-or-mention'},{owner:'app.onboarding_conversation_rows',operation:'finite-visible-conversation'},{owner:'app.onboarding_conversation_update',operation:'exact-native-command'},{owner:'app.lifecycle_native_effect_cleanup',operation:'same-purpose-final-proof'}]}))}];

export const LIFECYCLE_APPROVAL_FUNCTIONS:readonly FunctionActionDescriptor[]=[{key:'lifecycle.shared.approvals',scope:'company',moduleKey:'lifecycle',labelKey:'nav.myTasks',kind:'native_acl',course:'assigned',href:'/tasks',employeeBearing:false,
 actions:(['view','approve']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.lifecycle_approval_function_legacy_allowed',bindings:[{owner:'app.onboarding_delivery_task_rows',operation:'actual-current-actionable-approval'},{owner:'app.onboarding_delivery_task_detail',operation:'exact-selected-item-review'},{owner:'app.onboarding_approval_decide',operation:'native-current-decision-and-derived-effects'},{owner:'app.lifecycle_native_effect_cleanup',operation:'same-purpose-final-proof'}]}))}];

export const LIFECYCLE_APPROVAL_ASSIGNMENT_FUNCTIONS:readonly FunctionActionDescriptor[]=[{key:'lifecycle.shared.approvalAssignments',scope:'company',moduleKey:'lifecycle',labelKey:'nav.myTasks',kind:'native_acl',course:'assigned',href:'/tasks',employeeBearing:false,
 actions:(['view','execute']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.lifecycle_approval_assignment_legacy_allowed',bindings:[{owner:'app.onboarding_delivery_task_rows',operation:'actual-current-group-approval-assignment'},{owner:'app.onboarding_delivery_task_detail',operation:'exact-selected-group-candidates'},{owner:'app.onboarding_approval_assign',operation:'native-group-assignment-and-derived-effects'},{owner:'app.lifecycle_native_effect_cleanup',operation:'same-purpose-final-proof'}]}))}];
