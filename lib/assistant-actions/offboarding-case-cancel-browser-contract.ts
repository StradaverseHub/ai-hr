/** Pure unexposed browser packet/result validation. No transport registration or authority. */
import {z} from 'zod';
import {OffboardingCaseCancel as C} from './offboarding-case-cancel-contract';
export const OffboardingCaseCancelPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(C.action),operation:z.literal('choices'),selection:C.Selection}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('list')}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('prepare'),input:C.Human}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('reopen'),actionId:z.guid()}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('confirm'),confirmation:C.Confirmation}).strict(),
 z.object({action:z.literal(C.action),operation:z.literal('discard'),confirmation:C.Retirement}).strict(),
]);
export type OffboardingCaseCancelPacket=z.infer<typeof OffboardingCaseCancelPacket>;
export const OffboardingCaseCancelResult=z.union([C.Choices,C.Index,z.object({kind:z.literal('prepared'),review:C.Prepared}).strict(),z.object({kind:z.literal('completed'),receipt:C.Completed}).strict(),z.object({kind:z.literal('retired'),receipt:C.Retired}).strict()]);
export type OffboardingCaseCancelResult=z.infer<typeof OffboardingCaseCancelResult>;
export function parseOffboardingCaseCancelResult(packet:OffboardingCaseCancelPacket,value:unknown):OffboardingCaseCancelResult{
 const result=OffboardingCaseCancelResult.parse(value),op=packet.operation;
 if(!(op==='choices'?result.kind==='choices'||result.kind==='unavailable':op==='list'?result.kind==='offboarding_case_cancel_review_index':op==='prepare'?result.kind==='prepared':op==='discard'?result.kind==='retired':op==='confirm'?result.kind==='completed'||result.kind==='retired':result.kind==='prepared'||result.kind==='completed'||result.kind==='retired'))throw Error('Case cancellation response unavailable.');
 const expected=op==='reopen'?packet.actionId:op==='confirm'||op==='discard'?packet.confirmation.actionId:null;
 const actual=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null;
 if(expected&&expected!==actual)throw Error('Case cancellation response unavailable.');
 if(op==='prepare'&&result.kind==='prepared'&&JSON.stringify(packet.input)!==JSON.stringify(result.review.content))throw Error('Case cancellation response unavailable.');
 return result;
}
