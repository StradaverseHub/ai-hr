import {z} from 'zod';
import {OffboardingStepCompletion as C} from './offboarding-step-completion-contract';
export const OffboardingStepPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(C.action),operation:z.literal('choices'),selection:C.Selection}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('list')}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('prepare'),input:C.Human}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('reopen'),actionId:z.guid()}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('confirm'),confirmation:C.Confirmation}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('discard'),confirmation:C.Retirement}).strict(),
]);
export type OffboardingStepPacket=z.infer<typeof OffboardingStepPacket>;
export const OffboardingStepResult=z.union([C.Choices,C.Index,z.object({kind:z.literal('prepared'),review:C.Prepared}).strict(),z.object({kind:z.literal('completed'),receipt:C.Completed}).strict(),z.object({kind:z.literal('retired'),receipt:C.Retired}).strict()]);
export type OffboardingStepResult=z.infer<typeof OffboardingStepResult>;
export function parseOffboardingStepResult(packet:OffboardingStepPacket,value:unknown):OffboardingStepResult{
 const result=OffboardingStepResult.parse(value),op=packet.operation;
 if(!(op==='choices'?result.kind==='choices'||result.kind==='unavailable':op==='list'?result.kind==='offboarding_step_review_index':op==='prepare'?result.kind==='prepared':op==='discard'?result.kind==='retired':op==='confirm'?result.kind==='completed'||result.kind==='retired':result.kind==='prepared'||result.kind==='completed'||result.kind==='retired'))throw Error('Offboarding response unavailable.');
 const expected=op==='reopen'?packet.actionId:op==='confirm'||op==='discard'?packet.confirmation.actionId:null;
 const id=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null;
 if(expected&&expected!==id)throw Error('Offboarding response unavailable.');
 if(result.kind==='prepared'){
  const p=result.review;if(Date.parse(p.expiresAt)<=Date.parse(p.createdAt))throw Error('Offboarding response unavailable.');
  for(const key of ['caseId','caseNumber','stepKey','reference','notes'] as const)if(p.content[key]!==p.review[key])throw Error('Offboarding response unavailable.');
  if(p.review.after.caseStatus==='completed'&&!p.content.acceptDerivedCaseCompletion)throw Error('Offboarding response unavailable.');
  if(op==='prepare'&&JSON.stringify(packet.input)!==JSON.stringify(p.content))throw Error('Offboarding response unavailable.');
 }
 return result;
}
