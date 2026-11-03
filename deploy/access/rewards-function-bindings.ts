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
   {owner:'app.reward_unit_verification_counts',operation:'native-seated-counts-only'},
   {owner:'app.reward_senior_membership_metadata',operation:'native-Group-Rewards-pay-free-membership'},
   {owner:'app.reward_senior_evidence_read',operation:'native-selected-evidence-with-self-exclusion'},
   {owner:'app.reward_governance_review',operation:'native-GR-PAT-and-visible-Senior-governance'},
  ]}]},
 ...(['entries','facts']as const).map(course=>({key:`rewards.${course}`,scope:'company' as const,moduleKey:'rewards',labelKey:course==='entries'?'rewards.recommendation':'rewards.import',kind:'native_acl' as const,course:'assigned' as const,screenKey:'rewards',href:'/rewards',employeeBearing:false,
  actions:(['view','edit']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:course==='entries'?'app.reward_save_entry':'app.reward_import_facts',operation:course==='entries'?'fixed-entry-save':'fixed-atomic-facts-import'},
   {owner:'app.reward_entry_published_write_guard',operation:'exact-fixed-source-write-admission'},
   {owner:'app.reward_entry_prepare_source',operation:'locked-native-OLD-and-proposed-subject'},
   {owner:'app.reward_entry_native',operation:'exact-entry-unit-fixed-audit'},
   {owner:'app.reward_entry_native_assert',operation:'native-course-physical-receipts-authority-audit'},
   {owner:'app.reward_entry_native_validate',operation:'ordered-unit-and-entry-final-source'},
   {owner:'app.reward_entry_authority_changed',operation:'same-root-authority-recheck'},
  ]}))})),
 ...(['assigned','administration']as const).map(course=>({key:`rewards.configuration.${course}`,scope:'company' as const,moduleKey:'rewards',labelKey:'rewards.configuration',kind:'native_acl' as const,course:course==='assigned'?'assigned' as const:'administrative' as const,screenKey:course==='assigned'?'rewards':'rewardsAdmin',href:course==='assigned'?'/rewards':'/admin/rewards',employeeBearing:false,
  actions:[{operation:'view' as const,parentCapability:course==='administration'?'rewards.view':null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[{owner:'app.reward_configuration_review',operation:course==='assigned'?'native-GR-configuration-metadata':'native-company-HR-configuration-metadata'}]}]})),
 ...(['assigned','administration']as const).map(course=>({key:`rewards.cancellation.${course}`,scope:'company' as const,moduleKey:'rewards',labelKey:'rewardsConfig.actions.cancel',kind:'native_acl' as const,course:course==='assigned'?'assigned' as const:'administrative' as const,screenKey:course==='assigned'?'rewards':'rewardsAdmin',href:course==='assigned'?'/rewards':'/admin/rewards',employeeBearing:false,
  actions:(['view','execute']as const).map(operation=>({operation,parentCapability:course==='administration'?(operation==='view'?'rewards.view':'rewards.delete'):null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:'app.reward_cancel_review',operation:'fixed-human-actor-only-cancel-frontdoor'},
   {owner:'app.reward_cancellation_published_source_guard',operation:'exact-native-cancellation-and-retained-history-guard'},
   {owner:'app.reward_cancel_admission',operation:'actual-native-nonterminal-source-and-course'},
   {owner:'app.reward_cancel_native',operation:'exact-unit-optional-decision-fixed-audit'},
   {owner:'app.reward_cancel_native_validate',operation:'sealed-final-source-native-authority-and-denial'},
   {owner:'app.reward_cancel_authority_changed',operation:'same-root-epoch-recheck'},
  ]}))})),
 ...decisionCourses.map(({command,operation,labelKey}):FunctionActionDescriptor=>({key:`rewards.decisions.${command}`,scope:'company',moduleKey:'rewards',labelKey,kind:'native_acl',course:'assigned',screenKey:'rewards',href:'/rewards',employeeBearing:false,
  actions:(['view',operation]as readonly FunctionOperation[]).map(action=>({operation:action,parentCapability:null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:'app.reward_decide',operation:`fixed-human-${command}-frontdoor`},
   {owner:'app.reward_decision_published_source_guard',operation:'exact-decision-source-and-transition-proof'},
   {owner:'app.reward_decision_admission',operation:`native-${command}-admission`},
   {owner:'app.reward_decision_native',operation:`sealed-${command}-effect`},
   {owner:'app.reward_decision_native_validate',operation:'exact-final-function-denial-and-native-audit'},
   {owner:'app.reward_unit_native_chain_closed',operation:'same-root-actor-unit-ordered-closed-effects'},
  ]}))})),
 {key:'rewards.posting',scope:'company',moduleKey:'rewards',labelKey:'rewards.post',kind:'native_acl',course:'assigned',screenKey:'rewards',href:'/rewards',employeeBearing:true,
  actions:(['view','execute']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.rewards_function_legacy_allowed',bindings:[
   {owner:'app.reward_post_command',operation:'fixed-human-post-frontdoor'},
   {owner:'app.reward_post_receipt_command',operation:'fixed-human-post-own-event-receipt'},
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
 'app.reward_unit_native_readable(uuid)',
 'app.reward_entry_native_unit(uuid,integer,text)',
 'app.reward_entry_prepare_source(uuid,integer,uuid,jsonb,jsonb,text)',
 'app.reward_entry_save_admission(uuid,integer,uuid,jsonb,jsonb)',
 'app.reward_entry_course_allowed(text,text,jsonb,jsonb,text[],uuid)',
 'app.reward_entry_native(uuid,integer,text,jsonb)',
 'app.reward_entry_native_assert(uuid)',
 'app.reward_entry_native_validate()',
 'app.reward_entry_authority_changed()',
 'app.reward_entry_source_changed()',
 'app.reward_entry_save_command(uuid,integer,uuid,jsonb,jsonb)',
 'app.reward_facts_import_command(uuid,integer,jsonb)',
 'app.reward_decision_unit_shape(jsonb,jsonb,jsonb)',
 'app.reward_decision_native_assert(uuid)',
 'app.reward_post_native_assert(uuid)',
 'app.reward_cancel_native_assert(uuid)',
 'app.reward_unit_native_chain_closed(text,uuid)',
 'app.rewards_member_fingerprint_for_tenant(uuid,uuid,uuid)',
 'app.rewards_member_state_for_tenant(uuid,uuid)',
 'app.rewards_roles_for_tenant(uuid,uuid,uuid)',
 'app.rewards_function_legacy_allowed(uuid,uuid,text,uuid)',
 'app.rewards_function_current_legacy_allowed(uuid,uuid,text,uuid)',
 'app.reward_unit_verification_counts(uuid)',
 'app.reward_senior_membership_metadata(uuid)',
 'app.reward_senior_evidence_read(uuid,uuid)',
 'app.reward_governance_review(uuid)',
 'app.reward_configuration_review(uuid)',
 'app.reward_decision_command(uuid,integer,text,text,boolean)',
 'app.reward_post_command(uuid,integer,uuid)',
 'app.reward_post_receipt_command(uuid,integer,uuid)',
 'app.reward_cancel_command(uuid,integer,text)',
 'app.reward_cancel_admission(uuid,integer,text)',
 'app.reward_cancel_native(uuid,integer,text)',
 'app.reward_cancel_native_validate()',
]as const;

export const REWARDS_READ_CAPABILITY_PUBLICATION={
 capabilities:[{id:'rewards.view',scope:'company',bindings:[
  {owner:'app.lifecycle_reward_notice_action',operation:'native-administrative-configuration-view'},
  {owner:'app.reward_configuration_review',operation:'bounded-company-configuration-projection'},
 ]}],
 functions:REWARDS_FUNCTIONS.filter(descriptor=>descriptor.key==='rewards.review'||descriptor.key.startsWith('rewards.configuration.')),
 legacyParityFunction:'app.lifecycle_reward_notice_legacy_allowed',
 currentLegacyParityFunction:'app.rewards_configuration_current_legacy_allowed',
 functionLegacyParityFunction:REWARDS_FUNCTION_DEFAULTS.pure,
 functionCurrentLegacyParityFunction:REWARDS_FUNCTION_DEFAULTS.current,
 legacyGroups:{},
 requiredFunctions:[
  'app.rewards_read_bindings_complete()',
  'app.reward_annual_calculation(uuid,integer)',
  'app.reward_offcycle_calculation(uuid,integer)',
  'app.reward_configuration_review(uuid)',
  'app.reward_governance_review(uuid)',
 ],
} as const;

export const REWARDS_ENTRY_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:REWARDS_FUNCTIONS.filter(descriptor=>descriptor.key==='rewards.entries'||descriptor.key==='rewards.facts'),
 functionLegacyParityFunction:REWARDS_FUNCTION_DEFAULTS.pure,
 functionCurrentLegacyParityFunction:REWARDS_FUNCTION_DEFAULTS.current,
 legacyGroups:{},
 requiredFunctions:[
  'app.rewards_entry_bindings_complete()',
  'app.reward_save_entry(uuid,integer,uuid,jsonb,jsonb)',
  'app.reward_import_facts(uuid,integer,jsonb)',
  'app.reward_entry_published_write_guard()',
 ],
} as const;

export const REWARDS_DECISION_CAPABILITY_PUBLICATION={
 capabilities:[],
 functions:REWARDS_FUNCTIONS.filter(descriptor=>descriptor.key.startsWith('rewards.decisions.')),
 functionLegacyParityFunction:REWARDS_FUNCTION_DEFAULTS.pure,
 functionCurrentLegacyParityFunction:REWARDS_FUNCTION_DEFAULTS.current,
 legacyGroups:{},
 requiredFunctions:[
  'app.rewards_decision_bindings_complete()',
  'app.reward_decide(uuid,integer,text,text,boolean)',
  'app.reward_decision_published_source_guard()',
 ],
} as const;

export const REWARDS_CANCELLATION_CAPABILITY_PUBLICATION={
 capabilities:[{id:'rewards.delete',scope:'company' as const,bindings:[
  {owner:'app.reward_cancellation_published_source_guard',operation:'scoped-unused-review-deletion'},
  {owner:'app.reward_cancel_admission',operation:'scoped-company-administrative-cancellation'},
 ]}],
 functions:REWARDS_FUNCTIONS.filter(descriptor=>descriptor.key.startsWith('rewards.cancellation.')),
 legacyParityFunction:'app.lifecycle_reward_notice_legacy_allowed',
 currentLegacyParityFunction:'app.rewards_delete_current_legacy_allowed',
 functionLegacyParityFunction:REWARDS_FUNCTION_DEFAULTS.pure,
 functionCurrentLegacyParityFunction:REWARDS_FUNCTION_DEFAULTS.current,
 legacyGroups:{},
 requiredFunctions:[
  'app.rewards_cancellation_bindings_complete()',
  'app.reward_cancel_review(uuid,integer,text)',
  'app.rewards_delete_current_legacy_allowed(uuid,uuid,text,uuid)',
 ],
} as const;
