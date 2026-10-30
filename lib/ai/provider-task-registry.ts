/** Closed SOURCE-OWNED contract registry. No custom descriptor/prompt/review flag is accepted. */
import {ASSISTANT_PRIVATE_CONTRACT,capturePrivateAssistantTask,fingerprintPrivateAssistantTask} from './provider-assistant-policy';
import {SNAPSHOT_ANALYSIS_CONTRACT,SNAPSHOT_ANALYSIS_DESCRIPTOR} from './provider-snapshot-policy';
import {getProviderWorkloadDescriptor} from './provider-workload-policy';
import type {AiFeatureId} from './features';
import type {PrivateTaskDescriptor} from './provider-task-contract';
import {privatePolicyRefusal} from './provider-policy-shape';
export function privateTaskDescriptor(contractId:string,feature:AiFeatureId,source:unknown):PrivateTaskDescriptor{
 if(contractId===SNAPSHOT_ANALYSIS_CONTRACT){if(!SNAPSHOT_ANALYSIS_DESCRIPTOR.features.includes(feature))return privatePolicyRefusal();return SNAPSHOT_ANALYSIS_DESCRIPTOR;}
 if(contractId===ASSISTANT_PRIVATE_CONTRACT){
  const captured=capturePrivateAssistantTask(source),operation=Array.isArray(captured.args.system)?'conversation':'draft';
  if(feature!==(operation==='conversation'?'hr_assistant':'module_agent_planning'))return privatePolicyRefusal();
  return Object.freeze({features:[feature],operation,fingerprint:fingerprintPrivateAssistantTask,capture:capturePrivateAssistantTask});
 }
 const descriptor=getProviderWorkloadDescriptor(contractId);
 if(!descriptor||!descriptor.features.includes(feature))return privatePolicyRefusal();return descriptor;
}
