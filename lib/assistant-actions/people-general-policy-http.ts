/** Closed implicit-tenant lane. No posted subject/company/person and no generic subject-check weakening. */
import {z} from 'zod';
import * as C from './people-general-policy-contract';
const action=z.literal(C.PEOPLE_GENERAL_POLICY_ACTION);
export const PeopleGeneralPolicyPacket=z.discriminatedUnion('operation',[
 z.object({action,operation:z.literal('list')}).strict(),
 z.object({action,operation:z.literal('prepare'),input:C.PeopleGeneralPolicyHuman}).strict(),
 z.object({action,operation:z.literal('reopen'),actionId:z.guid()}).strict(),
 z.object({action,operation:z.literal('confirm'),confirmation:C.PeopleGeneralPolicyEnvelopeConfirmation}).strict(),
 z.object({action,operation:z.literal('discard'),confirmation:C.PeopleGeneralPolicyRetirement}).strict(),
]);
export type PeopleGeneralPolicyPacket=z.infer<typeof PeopleGeneralPolicyPacket>;
export const PeopleGeneralPolicyResult=z.discriminatedUnion('kind',[C.PeopleGeneralPolicyIndex,z.object({kind:z.literal('prepared'),review:C.PeopleGeneralPolicyPrepared}).strict(),z.object({kind:z.literal('completed'),receipt:C.PeopleGeneralPolicyCompleted}).strict(),z.object({kind:z.literal('retired'),receipt:C.PeopleGeneralPolicyRetired}).strict()]);
export function parsePeopleGeneralPolicyResult(packet:PeopleGeneralPolicyPacket,value:unknown){
 const result=PeopleGeneralPolicyResult.parse(value),op=packet.operation;
 const allowed=op==='list'?result.kind==='people_general_policy_review_index':op==='prepare'?result.kind==='prepared':op==='confirm'?result.kind==='completed'||result.kind==='retired':op==='discard'?result.kind==='retired':result.kind!=='people_general_policy_review_index';if(!allowed)throw Error('Policy response unavailable.');
 const id=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null,expected=op==='reopen'?packet.actionId:op==='confirm'||op==='discard'?packet.confirmation.actionId:null;
 if(expected&&id!==expected)throw Error('Policy response unavailable.');
 if(op==='prepare'&&(result.kind!=='prepared'||JSON.stringify(result.review.content)!==JSON.stringify(packet.input)))throw Error('Policy response unavailable.');
 if(result.kind==='people_general_policy_review_index'&&result.reviews.some(r=>Date.parse(r.expiresAt)<=Date.parse(r.createdAt)))throw Error('Policy response unavailable.');return result;
}
export type PeopleGeneralPolicyOwner<Session>=Readonly<{
 list(session:Session):Promise<unknown>;prepare(session:Session,input:z.infer<typeof C.PeopleGeneralPolicyHuman>):Promise<unknown>;
 reopen(session:Session,id:string):Promise<unknown>;confirm(session:Session,input:z.infer<typeof C.PeopleGeneralPolicyEnvelopeConfirmation>):Promise<unknown>;
 discard(session:Session,input:z.infer<typeof C.PeopleGeneralPolicyRetirement>):Promise<unknown>;
}>;
/** Called only after the shared authenticated origin/content/body/deadline/pause envelope.
 * This module is not a route and exposes no GET or alternate authentication owner. */
export async function dispatchPeopleGeneralPolicyPacket<Session>(owner:PeopleGeneralPolicyOwner<Session>,session:Session,input:PeopleGeneralPolicyPacket){
 const result=input.operation==='list'?await owner.list(session):input.operation==='prepare'?await owner.prepare(session,input.input):input.operation==='reopen'?await owner.reopen(session,input.actionId):input.operation==='confirm'?await owner.confirm(session,input.confirmation):await owner.discard(session,input.confirmation);
 return parsePeopleGeneralPolicyResult(input,result);
}
