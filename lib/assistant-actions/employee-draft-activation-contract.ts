/** Existing saved drafts only. No model-supplied HR facts or invented draft input. */
import {z} from 'zod';
export const EMPLOYEE_DRAFT_ACTIVATION_ACTION='employees.draft.activate' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().max(4000),base={action:z.literal(EMPLOYEE_DRAFT_ACTIVATION_ACTION),contractVersion:z.literal(1)};
const Human=z.object({...base,draftId:uuid,companyId:uuid}).strict();
const Field=z.object({section:z.enum(['profile','employment','payroll']),key:text,value:text}).strict();
const Item=z.object({draftId:uuid,companyId:uuid,companyName:text,country:text,currency:text,departmentName:text,reservedEmployeeCode:text,fields:z.array(Field).max(30),standingLeaveTypes:z.array(z.object({id:uuid,code:text,name:text}).strict()).max(30),initialBasicSalary:text,initialMonthlyAllowance:text,payMode:text,paymentTerm:text,rateAmount:text,remarks:text}).strict();
const Receipt=z.object({kind:z.literal('activated'),draftId:uuid,companyId:uuid,employmentId:uuid,personId:uuid,employeeCode:text,eventId:uuid,semantics:z.literal('employment_created_not_payroll_processed_or_access_granted')}).strict();
const consequence='employment_created_with_native_initial_compensation_and_standing_leave_not_payroll_or_login' as const;
export const EmployeeDraftActivation={action:EMPLOYEE_DRAFT_ACTIVATION_ACTION,Human,Item,Receipt,consequence,indexKind:'employee_draft_activation_review_index',
 Selection:z.object({companyId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),drafts:z.array(z.object({draftId:uuid,companyId:uuid,label:text,employeeCode:text,supported:z.boolean(),route:z.literal('/admin/personnel/new')}).strict()).max(25),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=48000),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('employee_draft_activation_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type EmployeeDraftActivationHuman=z.infer<typeof Human>;

export const EmployeeDraftActivationBrowserPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(EMPLOYEE_DRAFT_ACTIVATION_ACTION),operation:z.literal('choices'),selection:EmployeeDraftActivation.Selection}).strict(),z.object({action:z.literal(EMPLOYEE_DRAFT_ACTIVATION_ACTION),operation:z.literal('list')}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_ACTIVATION_ACTION),operation:z.literal('prepare'),input:Human}).strict(),z.object({action:z.literal(EMPLOYEE_DRAFT_ACTIVATION_ACTION),operation:z.literal('reopen'),actionId:uuid}).strict(),
 z.object({action:z.literal(EMPLOYEE_DRAFT_ACTIVATION_ACTION),operation:z.literal('confirm'),confirmation:EmployeeDraftActivation.Confirmation}).strict(),z.object({action:z.literal(EMPLOYEE_DRAFT_ACTIVATION_ACTION),operation:z.literal('discard'),confirmation:EmployeeDraftActivation.Retirement}).strict(),
]);
export type EmployeeDraftActivationBrowserPacket=z.infer<typeof EmployeeDraftActivationBrowserPacket>;
const Result=z.union([EmployeeDraftActivation.Choices,EmployeeDraftActivation.Index,z.object({kind:z.literal('prepared'),review:EmployeeDraftActivation.Prepared}).strict(),z.object({kind:z.literal('completed'),receipt:EmployeeDraftActivation.Completed}).strict(),z.object({kind:z.literal('retired'),receipt:EmployeeDraftActivation.Retired}).strict()]);
export type EmployeeDraftActivationBrowserResult=z.infer<typeof Result>;
export function parseEmployeeDraftActivationBrowserResult(packet:EmployeeDraftActivationBrowserPacket,value:unknown){
 const result=Result.parse(value),op=packet.operation,index=result.kind==='employee_draft_activation_review_index';
 if(!(op==='choices'?result.kind==='choices'||result.kind==='unavailable':op==='list'?index:op==='prepare'?result.kind==='prepared':op==='confirm'?result.kind==='completed'||result.kind==='retired':op==='discard'?result.kind==='retired':result.kind==='prepared'||result.kind==='completed'||result.kind==='retired'))throw Error('Draft review unavailable');
 const expected=op==='reopen'?packet.actionId:op==='confirm'||op==='discard'?packet.confirmation.actionId:null,id=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null;if(expected&&id!==expected)throw Error('Draft review unavailable');
 if(result.kind==='prepared'){const review=result.review;if(review.content.draftId!==review.review.draftId||review.content.companyId!==review.review.companyId||Date.parse(review.expiresAt)<=Date.parse(review.createdAt))throw Error('Draft review unavailable');if(op==='prepare'&&JSON.stringify(packet.input)!==JSON.stringify(review.content))throw Error('Draft review unavailable');}
 return result;
}
