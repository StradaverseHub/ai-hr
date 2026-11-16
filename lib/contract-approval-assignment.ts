import type {ContractApprovalLayer} from './contract-automation';
import type {ContractApprovalAssignment} from './contract-approval-flow';
import {contractAutomationApprovalTarget,type ContractAutomationContext} from './contract-automation-context';
import {routedStepChooser} from './routed-step-assignment';

/** Shared preview/activation resolver. Basic Round robin uses verified assignment history; Any retains group identity. */
export function contractApprovalAssignments(input:{layers:ContractApprovalLayer[];context:ContractAutomationContext;today:string;lastAssigned:Record<string,string|null>},chooser?:ReturnType<typeof routedStepChooser>):ContractApprovalAssignment[]{
 const {context}=input;
 const select=chooser??routedStepChooser({today:input.today,groups:context.groups.map(group=>({...group,limit:0})),users:context.activePeople.map(id=>({id,load:0,lastAssigned:input.lastAssigned[id]??null,onLeave:false}))});
 return input.layers.map(layer=>{
  const target=contractAutomationApprovalTarget(layer.approver,context);
  return {layer,groupId:target.groupId,candidateUserIds:target.userIds,candidatePersonIds:Object.fromEntries(target.userIds.map(id=>[id,context.userPersonIds[id]])),
   selectedUserId:layer.pick==='roundRobin'?select.choose(target.userIds,layer.pick,target.groupId):null,fallbackUsed:target.fallbackUsed,missingReason:target.unresolved.map(item=>item.reason).join(' ')||null};
 });
}
