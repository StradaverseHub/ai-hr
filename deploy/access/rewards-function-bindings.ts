/** Exact native courses, not a publication/completion attestation. Public command ACL,
 * consumer cutover, runtime parity and complete raw closure remain held for review. */
import type {FunctionActionDescriptor,FunctionOperation} from './function-action-contract';

const decisionCourses=[
 {command:'submit',operation:'execute',labelKey:'rewards.submit'},
 {command:'approve',operation:'approve',labelKey:'rewards.approve'},
 {command:'return',operation:'execute',labelKey:'rewards.return'},
 {command:'reject',operation:'execute',labelKey:'rewards.reject'},
 {command:'withdraw',operation:'execute',labelKey:'rewards.withdraw'},
]as const;

export const REWARDS_FUNCTIONS:readonly FunctionActionDescriptor[]=[
 {key:'rewards.review',scope:'company',moduleKey:'rewards',labelKey:'nav.rewards',kind:'screen',course:'assigned',screenKey:'rewards',href:'/rewards',employeeBearing:false,
  actions:[{operation:'view',parentCapability:null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:'app.reward_annual_calculation',operation:'actual-visible-annual-review'},
   {owner:'app.reward_offcycle_calculation',operation:'actual-visible-offcycle-review'},
   {owner:'app.reward_calc_projection',operation:'native-self-confidential-Senior-disclosure'},
  ]}]},
 ...(['assigned','administration']as const).map(course=>({key:`rewards.configuration.${course}`,scope:'company' as const,moduleKey:'rewards',labelKey:'rewards.configuration',kind:'native_acl' as const,course:course==='assigned'?'assigned' as const:'administrative' as const,screenKey:course==='assigned'?'rewards':'rewardsAdmin',href:course==='assigned'?'/rewards':'/admin/rewards',employeeBearing:false,
  actions:[{operation:'view' as const,parentCapability:course==='administration'?'rewards.view':null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[{owner:'app.reward_configuration_review',operation:course==='assigned'?'native-GR-configuration-metadata':'native-company-HR-configuration-metadata'}]}]})),
 ...(['assigned','administration']as const).map(course=>({key:`rewards.cancellation.${course}`,scope:'company' as const,moduleKey:'rewards',labelKey:'rewardsConfig.actions.cancel',kind:'native_acl' as const,course:course==='assigned'?'assigned' as const:'administrative' as const,screenKey:course==='assigned'?'rewards':'rewardsAdmin',href:course==='assigned'?'/rewards':'/admin/rewards',employeeBearing:false,
  actions:(['view','execute']as const).map(operation=>({operation,parentCapability:course==='administration'?(operation==='view'?'rewards.view':'rewards.delete'):null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:'app.reward_cancel_command',operation:'fixed-human-actor-only-cancel-frontdoor'},
   {owner:'app.reward_cancel_admission',operation:'actual-native-nonterminal-source-and-course'},
   {owner:'app.reward_cancel_native',operation:'exact-unit-optional-decision-fixed-audit'},
   {owner:'app.reward_cancel_native_validate',operation:'sealed-final-source-native-authority-and-denial'},
   {owner:'app.reward_cancel_authority_changed',operation:'same-root-epoch-recheck'},
  ]}))})),
 ...decisionCourses.map(({command,operation,labelKey}):FunctionActionDescriptor=>({key:`rewards.decisions.${command}`,scope:'company',moduleKey:'rewards',labelKey,kind:'native_acl',course:'assigned',screenKey:'rewards',href:'/rewards',employeeBearing:false,
  actions:(['view',operation]as readonly FunctionOperation[]).map(action=>({operation:action,parentCapability:null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:'app.reward_decision_command',operation:`fixed-human-${command}-frontdoor`},
   {owner:'app.reward_decision_admission',operation:`native-${command}-admission`},
   {owner:'app.reward_decision_native',operation:`sealed-${command}-effect`},
   {owner:'app.reward_decision_native_validate',operation:'exact-final-function-denial-and-native-audit'},
  ]}))})),
 {key:'rewards.posting',scope:'company',moduleKey:'rewards',labelKey:'rewards.post',kind:'native_acl',course:'assigned',screenKey:'rewards',href:'/rewards',employeeBearing:true,
  actions:(['view','execute']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:'app.reward_post_command',operation:'fixed-human-post-frontdoor'},
   {owner:'app.reward_post_admission',operation:'native-payroll-seat-and-company-admin'},
   {owner:'app.reward_post_sources',operation:'exact-locked-native-financial-sources'},
   {owner:'app.reward_post_native',operation:'fixed-salary-grade-input-funding-post'},
   {owner:'app.reward_post_native_validate',operation:'exact-final-function-denial-and-native-audits'},
   {owner:'app.reward_post_authority_changed',operation:'same-transaction-authority-recheck'},
  ]}))},
];

export const REWARDS_FUNCTION_DEFAULTS={
 pure:'app.rewards_function_legacy_allowed',current:'app.rewards_function_current_legacy_allowed',
}as const;

/** These include the real production front doors. Their APP ACL remains held for review.
 * No private test execution lease or unsupported catalogue shortcut satisfies this contract. */
export const REWARDS_FUNCTION_REQUIRED_OWNERS=[
 'app.rewards_member_fingerprint_for_tenant(uuid,uuid,uuid)',
 'app.rewards_member_state_for_tenant(uuid,uuid)',
 'app.rewards_roles_for_tenant(uuid,uuid,uuid)',
 'app.rewards_function_legacy_allowed(uuid,uuid,text,uuid)',
 'app.rewards_function_current_legacy_allowed(uuid,uuid,text,uuid)',
 'app.reward_configuration_review(uuid)',
 'app.reward_decision_command(uuid,integer,text,text,boolean)',
 'app.reward_post_command(uuid,integer,uuid)',
 'app.reward_cancel_command(uuid,integer,text)',
 'app.reward_cancel_admission(uuid,integer,text)',
 'app.reward_cancel_native(uuid,integer,text)',
 'app.reward_cancel_native_validate()',
]as const;
