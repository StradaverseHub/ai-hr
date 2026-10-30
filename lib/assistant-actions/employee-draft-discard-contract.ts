/** NONMOUNTED contract draft. No completion receipt/proof or native implementation is defined here. */
import {z} from 'zod';
export const EMPLOYEE_DRAFT_DISCARD_ACTION='employees.draft.discard' as const;
export const EMPLOYEE_DRAFT_DISCARD_REVIEW_BYTE_LIMIT=8000;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const display=z.string().max(2000),code=z.string().min(1).max(512);
const base={action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),contractVersion:z.literal(1)};
const consent=z.literal('discard_saved_draft_captured_input');
const Selection=z.object({draftId:uuid,companyId:uuid}).strict();
const Human=z.object({...base,...Selection.shape,consent}).strict();
/** Prospective human display of an actual successful native preview, never inferred counter math. */
const ReservedCodeOutcome=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('no_reservation'),reservedEmployeeCode:z.null()}).strict(),
 z.object({kind:z.literal('released_tip'),reservedEmployeeCode:code}).strict(),
 z.object({kind:z.literal('retained_gap'),reservedEmployeeCode:code}).strict(),
]);
const Review=z.object({...Selection.shape,companyName:display,draftLabel:display,
 scope:z.literal('saved_draft_without_any_linked_onboarding_case'),
 capturedInput:z.literal('saved_draft_row_deleted_without_application_undo'),reservedCodeOutcome:ReservedCodeOutcome,
 consequence:z.literal('native_saved_draft_deleted_not_employee'),
}).strict();
/** PRIVATE, provisional source-binding interface only. No DTO, model input, receipt or hash builder.
 * These commitments must cover the exact complete native row/revision, live counter and owner context. */
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
export const EmployeeDraftDiscard={action:EMPLOYEE_DRAFT_DISCARD_ACTION,maturity:'unmounted_contract_draft',Selection,Human,ReservedCodeOutcome,Review,PrivateSource,Prepared,Confirmation,Retirement,Retired,Handoff} as const;
export type EmployeeDraftDiscardHuman=z.infer<typeof Human>;
export type EmployeeDraftDiscardPrivateSource=z.infer<typeof PrivateSource>;
export const EmployeeDraftDiscardBrowserPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('prepare'),input:Human}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('reopen'),actionId:uuid,selection:Selection}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('confirm'),confirmation:Confirmation}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_DISCARD_ACTION),operation:z.literal('retire'),confirmation:Retirement}).strict(),
]);
export type EmployeeDraftDiscardBrowserPacket=z.infer<typeof EmployeeDraftDiscardBrowserPacket>;
/** No confirmation RESULT exists until native deletion/event/counter proof is independently settled. */
const Result=z.union([z.object({kind:z.literal('prepared'),review:Prepared}).strict(),z.object({kind:z.literal('retired'),review:Retired}).strict(),Handoff]);
export type EmployeeDraftDiscardBrowserResult=z.infer<typeof Result>;
export function parseEmployeeDraftDiscardBrowserResult(packet:unknown,value:unknown){
 const request=EmployeeDraftDiscardBrowserPacket.parse(packet);
 if(request.operation==='confirm')throw Error('Draft discard completion contract is not defined');
 const result=Result.parse(value);
 if(result.kind==='handoff')return result;
 if(request.operation==='prepare'&&result.kind!=='prepared'||request.operation==='retire'&&result.kind!=='retired')throw Error('Draft review unavailable');
 const expectedId=request.operation==='reopen'?request.actionId:request.operation==='retire'?request.confirmation.actionId:null;
 if(expectedId&&result.review.actionId!==expectedId)throw Error('Draft review unavailable');
 if(result.kind==='prepared'){
  const selection=request.operation==='prepare'?request.input:request.operation==='reopen'?request.selection:null;
  if(!selection||result.review.content.draftId!==selection.draftId||result.review.content.companyId!==selection.companyId)throw Error('Draft review unavailable');
 }
 return result;
}
