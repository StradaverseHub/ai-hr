import {z} from 'zod';
import {OffboardingStepUndo as C} from './offboarding-step-undo-contract';
export const OffboardingStepUndoPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(C.action),operation:z.literal('choices'),selection:C.Selection}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('list')}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('prepare'),input:C.Human}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('reopen'),actionId:z.guid()}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('confirm'),confirmation:C.Confirmation}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('discard'),confirmation:C.Retirement}).strict(),
]);
export type OffboardingStepUndoPacket=z.infer<typeof OffboardingStepUndoPacket>;
export const OffboardingStepUndoResult=z.union([C.Choices,C.Index,z.object({kind:z.literal('prepared'),review:C.Prepared}).strict(),z.object({kind:z.literal('completed'),receipt:C.Completed}).strict(),z.object({kind:z.literal('retired'),receipt:C.Retired}).strict()]);
export type OffboardingStepUndoResult=z.infer<typeof OffboardingStepUndoResult>;
export function parseOffboardingStepUndoResult(packet:OffboardingStepUndoPacket,value:unknown):OffboardingStepUndoResult{
 const result=OffboardingStepUndoResult.parse(value),op=packet.operation;
 if(!(op==='choices'?result.kind==='choices'||result.kind==='unavailable':op==='list'?result.kind==='offboarding_step_undo_review_index':op==='prepare'?result.kind==='prepared':op==='discard'?result.kind==='retired':op==='confirm'?result.kind==='completed'||result.kind==='retired':result.kind==='prepared'||result.kind==='completed'||result.kind==='retired'))throw Error('Offboarding response unavailable.');
 if(op==='choices'&&result.kind==='choices'&&result.cases.some(c=>c.caseNumber!==packet.selection.caseNumber))throw Error('Offboarding response unavailable.');
 const expected=op==='reopen'?packet.actionId:op==='confirm'||op==='discard'?packet.confirmation.actionId:null;
 const id=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null;
 if(expected&&expected!==id)throw Error('Offboarding response unavailable.');
 if(result.kind==='prepared'){
  const p=result.review;if(Date.parse(p.expiresAt)<=Date.parse(p.createdAt))throw Error('Offboarding response unavailable.');
  for(const key of ['caseId','caseNumber','stepKey','reason'] as const)if(p.content[key]!==p.review[key])throw Error('Offboarding response unavailable.');
  if(p.review.reopensCase&&!p.content.acceptCaseReopening)throw Error('Offboarding response unavailable.');
  if(op==='prepare'&&JSON.stringify(packet.input)!==JSON.stringify(p.content))throw Error('Offboarding response unavailable.');
 }
 return result;
}
