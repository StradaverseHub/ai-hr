/** Display-only disclosure of implemented serializers. No source, privacy approval or egress grant. */
import type {AiFeatureId} from './features';
import {ASSISTANT_PRIVATE_CONTRACT} from './provider-assistant-policy';
import {SNAPSHOT_ANALYSIS_CONTRACT,SNAPSHOT_ANALYSIS_DESCRIPTOR} from './provider-snapshot-policy';
import {PROVIDER_ANALYSIS_COVERAGE,BLOCKED_ANALYSIS_VARIANTS} from './provider-analysis-coverage';
import {PROVIDER_ANALYSIS_CONTRACT,ATTENDANCE_ANALYSIS_CONTRACT} from './provider-analysis-policy';
import {PROVIDER_DATA_CONTRACT} from './provider-data-policy';
import {providerDataReviewStatus} from './provider-data-reviews';
import {PROVIDER_WORKLOAD_CONTRACT_IDS,PROVIDER_WORKLOAD_AVAILABILITY,getProviderWorkloadDescriptor,type ProviderWorkloadContractId} from './provider-workload-policy';
export const PROVIDER_OUTGOING_FIELDS=['closed_references','coarse_aggregate_bands','pseudonymous_person_bands','synthetic_only'] as const;
export type ProviderOutgoingField=typeof PROVIDER_OUTGOING_FIELDS[number];
/** Exhaustive reviewed classification of actual captures, NOT the raw native input or legacy prompt.
 * New descriptor IDs must receive an explicit disclosure classification; there is no default. */
export const WORKLOAD_DISCLOSURE_FIELDS=Object.freeze({
 performance_native_outline_v1:'closed_references',
 performance_explicit_commands_v1:'closed_references',
 performance_starter_selection_v1:'closed_references',
 synthetic_protocol_echo_v1:'synthetic_only',
 synthetic_protocol_tools_v1:'synthetic_only',
 synthetic_read_plan_v1:'synthetic_only',
 synthetic_assistant_conversation_v1:'synthetic_only',
 readiness_message_v1:'closed_references',
 claim_detail_triage_v1:'closed_references',
 payroll_feature_hypothesis_v1:'closed_references',
 payroll_detector_explanation_v1:'closed_references',
 authored_pay_rule_v1:'closed_references',
 authored_report_plan_v1:'closed_references',
 feedback_task_outline_v1:'closed_references',
 personnel_header_mapping_v1:'closed_references',
 performance_narrative_selection_v1:'closed_references',
 performance_text_layout_v1:'closed_references',
 performance_fact_selection_v1:'closed_references',
 performance_calibration_read_v1:'closed_references',
 performance_admin_selection_v1:'closed_references',
 performance_literal_command_v1:'closed_references',
} satisfies Record<ProviderWorkloadContractId,ProviderOutgoingField>);
type Disclosure=Readonly<{id:string;features:readonly AiFeatureId[];fields:readonly ProviderOutgoingField[];anchor:string}>;
const workloads:readonly Disclosure[]=Object.freeze(PROVIDER_WORKLOAD_CONTRACT_IDS.map(id=>{
 const descriptor=getProviderWorkloadDescriptor(id);if(!descriptor)throw Error('Provider disclosure descriptor missing.');
 return Object.freeze({id,features:descriptor.features,fields:Object.freeze([WORKLOAD_DISCLOSURE_FIELDS[id]]),anchor:'lib/ai/provider-workload-policy.ts'});
}));
const analysis=PROVIDER_ANALYSIS_COVERAGE.filter(row=>row.domains.length>0&&row.operations.length>0);
const disclosures:readonly Disclosure[]=Object.freeze([...workloads,
 {id:ASSISTANT_PRIVATE_CONTRACT,features:['hr_assistant','module_agent_planning'],fields:['closed_references'],anchor:'lib/ai/provider-assistant-policy.ts'},
 {id:SNAPSHOT_ANALYSIS_CONTRACT,features:SNAPSHOT_ANALYSIS_DESCRIPTOR.features,fields:['coarse_aggregate_bands'],anchor:'lib/ai/provider-snapshot-policy.ts'},
 {id:PROVIDER_ANALYSIS_CONTRACT,features:analysis.map(row=>row.feature),fields:['coarse_aggregate_bands'],anchor:'lib/ai/provider-analysis-policy.ts'},
 {id:PROVIDER_DATA_CONTRACT,features:['hr_assistant'],fields:['closed_references'],anchor:'lib/ai/provider-data-policy.ts'},
 {id:ATTENDANCE_ANALYSIS_CONTRACT,features:['hr_assistant'],fields:['pseudonymous_person_bands'],anchor:'lib/ai/provider-analysis-policy.ts'},
]);
/** Current source-bound review status comes from the SAME owner as gateway admission, never a UI flag.
 * A listed shape remains unavailable until native source replay and every runtime gate also pass. */
export function providerDisclosureForFeature(feature:AiFeatureId){
 const entries=disclosures.filter(row=>row.features.includes(feature));
 return Object.freeze({fields:Object.freeze([...new Set(entries.flatMap(row=>row.fields))]),
  contracts:Object.freeze(entries.map(row=>Object.freeze({id:row.id,reviewStatus:providerDataReviewStatus(row.id)}))),
  anchors:Object.freeze([...new Set(entries.map(row=>row.anchor))]),
  remaining:Object.freeze([...new Set([...PROVIDER_WORKLOAD_AVAILABILITY.filter(row=>row.feature===feature).flatMap(row=>row.remaining),...(analysis.some(row=>row.feature===feature)?BLOCKED_ANALYSIS_VARIANTS:[])])])});
}
