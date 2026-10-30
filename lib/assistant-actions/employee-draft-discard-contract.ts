/** Human saved-draft discard protocol. Native SQL custody owns actual deletion/completion proof. */
import {z} from 'zod';
export const EMPLOYEE_DRAFT_DISCARD_ACTION='employees.draft.discard' as const;
export const EMPLOYEE_DRAFT_DISCARD_REVIEW_BYTE_LIMIT=8000;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const display=z.string().max(2000),code=z.string().min(1).max(512);
const bounded=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=EMPLOYEE_DRAFT_DISCARD_REVIEW_BYTE_LIMIT;
const base={action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),contractVersion:z.literal(1)};
const consent=z.literal('discard_saved_draft_captured_input');
const Selection=z.object({draftId:uuid,companyId:uuid}).strict();
const Human=z.object({...base,...Selection.shape,consent}).strict();
/** Prospective human display of an actual successful native preview, never inferred counter math. */
const ReservedCodeOutcome=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('no_reservation'),reservedEmployeeCode:z.null()}).strict(),
 // Stored code with reserved_number NULL; this does not infer how that code was entered.
 z.object({kind:z.literal('unreserved_code'),reservedEmployeeCode:code}).strict(),
 z.object({kind:z.literal('released_tip'),reservedEmployeeCode:code}).strict(),
 z.object({kind:z.literal('retained_gap'),reservedEmployeeCode:code}).strict(),
]);
const Review=z.object({...Selection.shape,companyName:display,draftLabel:display,
 scope:z.literal('saved_draft_without_any_linked_onboarding_case'),
 capturedInput:z.literal('saved_draft_row_deleted_without_application_undo'),reservedCodeOutcome:ReservedCodeOutcome,
 consequence:z.literal('native_saved_draft_deleted_not_employee'),
}).strict();
/** PRIVATE source-binding interface only; never a DTO/model input or caller-supplied proof. */
const PrivateSource=z.object({tenantId:uuid,userId:uuid,actorPersonId:uuid.nullable(),...Selection.shape,
 draftCommitment:digest,counterCommitment:digest,contextCommitment:digest,
}).strict();
const Prepared=z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Review}).strict().superRefine((v,ctx)=>{
 if(v.content.draftId!==v.review.draftId||v.content.companyId!==v.review.companyId)ctx.addIssue({code:'custom',message:'Draft review subject mismatch'});
 if(Date.parse(v.expiresAt)<=Date.parse(v.createdAt))ctx.addIssue({code:'custom',message:'Draft review interval unavailable'});
 if(new TextEncoder().encode(JSON.stringify(v)).byteLength>EMPLOYEE_DRAFT_DISCARD_REVIEW_BYTE_LIMIT)ctx.addIssue({code:'custom',message:'Draft review exceeds byte budget'});
});
const Confirmation=z.object({...base,...Selection.shape,actionId:uuid,reviewedDigest:digest,consent}).strict();
const Retirement=z.object({...base,actionId:uuid}).strict();
const Retired=z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
const Handoff=z.object({kind:z.literal('handoff'),reason:z.enum(['unassigned_company','linked_onboarding_case','unsupported_reservation_shape','native_discard_refused','source_out_of_bounds']),route:z.literal('/admin/personnel/new')}).strict();
const consequence='native_saved_draft_deleted_not_employee' as const;
const Receipt=z.object({kind:z.literal('discarded'),...Selection.shape,eventId:uuid,reservedCodeOutcome:ReservedCodeOutcome,capturedInput:z.literal('saved_draft_row_deleted_without_application_undo'),consequence:z.literal(consequence)}).strict();
const Completed=z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict().refine(bounded);
const ChoiceSelection=z.object({companyId:uuid.optional()}).strict();
const Choice=z.object({draftId:uuid,companyId:uuid.nullable(),companyName:display,label:display,employeeCode:code.nullable(),supported:z.boolean(),unsupportedReason:z.enum(['unassigned_company','linked_onboarding_case','unsupported_reservation_shape','native_discard_refused','source_out_of_bounds']).nullable(),route:z.literal('/admin/personnel/new')}).strict().refine(value=>value.supported===(value.unsupportedReason===null)&&(!value.supported||value.companyId!==null));
const Choices=z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),drafts:z.array(Choice).max(25),truncated:z.boolean()}).strict().refine(bounded),z.object({kind:z.literal('unavailable')}).strict()]);
const indexKind='employee_draft_discard_review_index' as const;
const Index=z.object({kind:z.literal(indexKind),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict().refine(bounded);
export const EmployeeDraftDiscard={action:EMPLOYEE_DRAFT_DISCARD_ACTION,consequence,indexKind,Selection,ChoiceSelection,Choices,Human,ReservedCodeOutcome,Review,PrivateSource,Prepared,Confirmation,Retirement,Retired,Receipt,Completed,Index,Handoff} as const;
export type EmployeeDraftDiscardHuman=z.infer<typeof Human>;
export type EmployeeDraftDiscardPrivateSource=z.infer<typeof PrivateSource>;
export const EmployeeDraftDiscardBrowserPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('choices'),selection:ChoiceSelection}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('list')}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('prepare'),input:Human}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('reopen'),actionId:uuid}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('confirm'),confirmation:Confirmation}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('retire'),confirmation:Retirement}).strict(),
]);
export type EmployeeDraftDiscardBrowserPacket=z.infer<typeof EmployeeDraftDiscardBrowserPacket>;
const Result=z.union([Choices,Index,z.object({kind:z.literal('prepared'),review:Prepared}).strict(),z.object({kind:z.literal('completed'),receipt:Completed}).strict(),z.object({kind:z.literal('retired'),receipt:Retired}).strict(),Handoff]);
export type EmployeeDraftDiscardBrowserResult=z.infer<typeof Result>;
export function parseEmployeeDraftDiscardBrowserResult(packet:unknown,value:unknown){
 const request=EmployeeDraftDiscardBrowserPacket.parse(packet),result=Result.parse(value),op=request.operation;
 const allowed=op==='choices'?result.kind==='choices'||result.kind==='unavailable':op==='list'?result.kind===indexKind:op==='prepare'?result.kind==='prepared'||result.kind==='handoff':op==='confirm'?result.kind==='completed'||result.kind==='retired':op==='retire'?result.kind==='retired':result.kind==='prepared'||result.kind==='completed'||result.kind==='retired'||result.kind==='handoff';
 if(!allowed)throw Error('Draft review unavailable');
 const expected=op==='reopen'?request.actionId:op==='confirm'||op==='retire'?request.confirmation.actionId:null;
 const actionId=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null;
 if(expected&&actionId&&actionId!==expected)throw Error('Draft review unavailable');
 if(result.kind==='prepared'&&op==='prepare'&&(result.review.content.draftId!==request.input.draftId||result.review.content.companyId!==request.input.companyId))throw Error('Draft review unavailable');
 if(result.kind==='completed'&&op==='confirm'&&(result.receipt.receipt.draftId!==request.confirmation.draftId||result.receipt.receipt.companyId!==request.confirmation.companyId))throw Error('Draft review unavailable');
 return result;
}
