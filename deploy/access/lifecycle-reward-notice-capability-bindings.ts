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
