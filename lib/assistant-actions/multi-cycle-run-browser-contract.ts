/** Closed human selection protocol. No actor, salary, provider or model-nominated parameters. */
import {z} from 'zod';
import {REVIEWED_MULTI_CYCLE_RUN_ACTION as action} from './reviewed-multi-cycle-run-contract';
import {MultiCycleRunReviewPrepare,MultiCycleRunReviewConfirmation,MultiCycleRunReviewRetirement,MultiCycleRunPreparedReview,MultiCycleRunCompletedReview,MultiCycleRunRetiredReview,MultiCycleRunReviewIndex} from './multi-cycle-run-review-contract';
export const MULTI_CYCLE_RUN_PREPARE_BYTES=45000;
export const MULTI_CYCLE_RUN_RESPONSE_BYTES=524288;
const period=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const MultiCycleRunCatalogueSelection=z.object({companyId:z.uuid(),payPeriod:period}).strict();
export const MultiCycleRunScopeSelection=MultiCycleRunCatalogueSelection.extend({kind:z.enum(['employees','departments']),query:z.string().trim().min(2).max(80)}).strict();
const employee=z.object({employmentId:z.uuid(),employeeCode:z.string().nullable(),fullName:z.string().nullable()}).strict().refine(r=>!!r.employeeCode?.trim()||!!r.fullName?.trim());
const department=z.object({departmentId:z.uuid(),name:z.string().min(1)}).strict();
export const MultiCycleRunActionChoices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),companies:z.array(z.object({companyId:z.uuid(),name:z.string().min(1)}).strict()).max(20).refine(r=>new Set(r.map(v=>v.companyId)).size===r.length),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict(),
]);export type MultiCycleRunActionChoices=z.infer<typeof MultiCycleRunActionChoices>;
export const MultiCycleRunCatalogue=z.object({kind:z.literal('catalogue'),selection:MultiCycleRunCatalogueSelection,cycles:z.array(z.object({id:z.uuid(),name:z.string().min(1),code:z.string().nullable(),runType:z.enum(['off_cycle','bonus','adjustment']),remarks:z.string().nullable()}).strict()).max(128).refine(r=>new Set(r.map(v=>v.id)).size===r.length),truncated:z.boolean()}).strict();
export const MultiCycleRunScopeResult=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('employee_choices'),selection:MultiCycleRunScopeSelection.refine(r=>r.kind==='employees'),employees:z.array(employee).max(20).refine(r=>new Set(r.map(v=>v.employmentId)).size===r.length),truncated:z.boolean()}).strict(),
 z.object({kind:z.literal('department_choices'),selection:MultiCycleRunScopeSelection.refine(r=>r.kind==='departments'),departments:z.array(department).max(20).refine(r=>new Set(r.map(v=>v.departmentId)).size===r.length),truncated:z.boolean()}).strict(),
]);
export const MultiCycleRunModuleActionBrowserPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(action),operation:z.literal('catalogue'),selection:MultiCycleRunCatalogueSelection}).strict(),
 z.object({action:z.literal(action),operation:z.literal('scope_search'),selection:MultiCycleRunScopeSelection}).strict(),
 z.object({action:z.literal(action),operation:z.literal('list')}).strict(),z.object({action:z.literal(action),operation:z.literal('prepare'),input:MultiCycleRunReviewPrepare}).strict(),
 z.object({action:z.literal(action),operation:z.literal('reopen'),actionId:z.uuid()}).strict(),z.object({action:z.literal(action),operation:z.literal('confirm'),confirmation:MultiCycleRunReviewConfirmation}).strict(),z.object({action:z.literal(action),operation:z.literal('discard'),confirmation:MultiCycleRunReviewRetirement}).strict(),
]);export type MultiCycleRunModuleActionBrowserPacket=z.infer<typeof MultiCycleRunModuleActionBrowserPacket>;
export const MultiCycleRunModuleActionBrowserResult=z.union([MultiCycleRunCatalogue,MultiCycleRunScopeResult,MultiCycleRunReviewIndex,z.object({kind:z.literal('prepared'),review:MultiCycleRunPreparedReview}).strict(),z.object({kind:z.literal('completed'),receipt:MultiCycleRunCompletedReview}).strict(),z.object({kind:z.literal('retired'),receipt:MultiCycleRunRetiredReview}).strict()]);export type MultiCycleRunModuleActionBrowserResult=z.infer<typeof MultiCycleRunModuleActionBrowserResult>;
export function parseMultiCycleRunModuleActionBrowserResult(packet:MultiCycleRunModuleActionBrowserPacket,value:unknown):MultiCycleRunModuleActionBrowserResult{
 const result=MultiCycleRunModuleActionBrowserResult.parse(value),op=packet.operation;
 if(!(op==='catalogue'?result.kind==='catalogue':op==='scope_search'?result.kind===(packet.selection.kind==='employees'?'employee_choices':'department_choices'):op==='list'?result.kind==='multi_cycle_run_review_index':op==='prepare'?result.kind==='prepared':op==='confirm'?result.kind==='completed'||result.kind==='retired':op==='discard'?result.kind==='retired':result.kind==='prepared'||result.kind==='completed'||result.kind==='retired'))throw Error('Payroll run response unavailable.');
 if(op==='catalogue'||op==='scope_search'){if(!('selection'in result)||JSON.stringify(result.selection)!==JSON.stringify(packet.selection))throw Error('Payroll run response unavailable.');}
 const id=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null,expected=op==='reopen'?packet.actionId:op==='confirm'||op==='discard'?packet.confirmation.actionId:null;if(expected&&id!==expected)throw Error('Payroll run response unavailable.');
 if(result.kind==='prepared'){const r=result.review,h=r.content.input,n=r.review,scope=(v:typeof n.scope|typeof h.scope)=>{const departmentIds=[...(v?.departmentIds??[])].map(id=>id.toLowerCase()).sort(),employmentIds=[...(v?.employmentIds??[])].map(id=>id.toLowerCase()).sort();return departmentIds.length||employmentIds.length?JSON.stringify({departmentIds,employmentIds}):null;};if(scope(h.scope)!==scope(n.scope)||n.selection!==(scope(n.scope)?'selected_scope_native_at_processing':'whole_company_dynamic_at_processing'))throw Error('Payroll run response unavailable.');if(h.companyId!==n.companyId||h.payPeriod!==n.payPeriod||h.payrollCycleId!==n.payrollCycleId||h.runType!==n.runType||(h.remarks||null)!==n.remarks||h.paymentDate&&h.paymentDate!==n.paymentDate||Date.parse(r.expiresAt)<=Date.parse(r.createdAt))throw Error('Payroll run response unavailable.');if(op==='prepare'&&JSON.stringify(r.content)!==JSON.stringify(packet.input))throw Error('Payroll run response unavailable.');}
 return result;
}
