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
 ...decisionCourses.map(({command,operation,labelKey}):FunctionActionDescriptor=>({key:`rewards.decisions.${command}`,scope:'company',moduleKey:'rewards',labelKey,kind:'native_acl',course:'assigned',screenKey:'rewards',href:'/rewards',employeeBearing:false,
  actions:(['view',operation]as readonly FunctionOperation[]).map(action=>({operation:action,parentCapability:null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:'app.reward_decision_admission',operation:`native-${command}-admission`},
   {owner:'app.reward_decision_native',operation:`sealed-${command}-effect`},
   {owner:'app.reward_decision_native_validate',operation:'exact-final-function-denial-and-native-audit'},
  ]}))})),
 {key:'rewards.posting',scope:'company',moduleKey:'rewards',labelKey:'rewards.post',kind:'native_acl',course:'assigned',screenKey:'rewards',href:'/rewards',employeeBearing:true,
  actions:(['view','execute']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
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

/** These include the eventual real production front doors, intentionally absent until review.
 * No private test execution lease or unsupported catalogue shortcut satisfies this contract. */
export const REWARDS_FUNCTION_REQUIRED_OWNERS=[
 'app.rewards_member_fingerprint_for_tenant(uuid,uuid,uuid)',
 'app.rewards_member_state_for_tenant(uuid,uuid)',
 'app.rewards_roles_for_tenant(uuid,uuid,uuid)',
 'app.rewards_function_legacy_allowed(uuid,uuid,text,uuid)',
 'app.rewards_function_current_legacy_allowed(uuid,uuid,text,uuid)',
 'app.reward_decision_command(uuid,integer,text,text,boolean)',
 'app.reward_post_command(uuid,integer,uuid)',
]as const;
