/** Saved draft discard uses the existing native owner. All data/counter proof stays SQL-private. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {EmployeeDraftDiscard as C,type EmployeeDraftDiscardHuman as Human} from '../../lib/assistant-actions/employee-draft-discard-contract';
import {canonicalEntitlementsForDigest} from '../../lib/assistant-actions/canonical-entitlements';
import {discardEmployeeDraft,type EmployeeDraftDiscardResult} from '../employee-draft';
import {onboardingDraftDiscardContextTx} from '../../packs/lifecycle/service';
import {withAgentActionGuard} from './agent-action-guard';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';

export class EmployeeDraftDiscardUnavailable extends Error{constructor(){super('Please reopen the saved draft on the native Personnel screen.');this.name='EmployeeDraftDiscardUnavailable';}}
export const employeeDraftDiscardUnavailable=():never=>{throw new EmployeeDraftDiscardUnavailable();};
const fail=employeeDraftDiscardUnavailable,digest=z.string().regex(/^[a-f0-9]{64}$/),hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byteLength=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const State=z.enum(['awaiting_confirmation','completed','discarded','expired','refused']);
export const EmployeeDraftDiscardNativeSource=z.object({draftId:z.guid(),companyId:z.guid(),companyName:z.string().min(1).max(2000),label:z.string().max(2000),reservedEmployeeCode:z.string().max(512).nullable(),reservedNumber:z.number().int().safe().nullable(),sourceDigest:digest,nativeRowDigest:digest,xmin:z.string().regex(/^\d+$/),ctid:z.string().regex(/^\(\d+,\d+\)$/),counterBeforeDigest:digest}).strict().refine(value=>byteLength(value)<=8000);
export type DraftDiscardSelection={draftId:string;companyId:string};
export type DraftDiscardInterval=DraftDiscardSelection&{state:z.infer<typeof State>;nativeSource?:z.infer<typeof EmployeeDraftDiscardNativeSource>};
export async function employeeDraftDiscardActorTx(tx:Tx,supplied:SessionContext){await boundNativeOutcomeTransactionTx(tx);const fresh=await withAgentActionGuard(tx,capture(supplied),C.action,'approve');if(!fresh.userId||!isAdmin(fresh))return fail();return fresh;}
async function nativeSource(tx:Tx,ctx:SessionContext,selection:DraftDiscardSelection){
 const [row]=await tx.execute<{source:unknown}>(sql`select app.assistant_employee_draft_discard_command('source',NULL,${ctx.personId??null}::uuid,${selection.companyId}::uuid,${selection.draftId}::uuid) as source`);
 const source=EmployeeDraftDiscardNativeSource.parse(row?.source);if(source.draftId!==selection.draftId||source.companyId!==selection.companyId)return fail();return source;
}
/** Access -> canonical Lifecycle owner -> draft/config/counter -> custody. A helper/lock refusal
 * escapes the WHOLE transaction. Terminal SQL-authenticated replay needs no now-deleted draft. */
export async function withEmployeeDraftDiscardIntervalTx<T>(tx:Tx,supplied:SessionContext,selection:DraftDiscardSelection,work:(fresh:SessionContext,source:DraftDiscardInterval)=>Promise<T>,state:z.infer<typeof State>='awaiting_confirmation'){
 await boundNativeOutcomeTransactionTx(tx);const selected=C.Selection.parse(structuredClone(selection)),fresh=await employeeDraftDiscardActorTx(tx,supplied);await tx.execute(sql`select app.access_workforce_write_lock()`);
 if(state!=='awaiting_confirmation')return work(fresh,{...selected,state});
 await onboardingDraftDiscardContextTx(fresh,tx,selected,{tryOnly:true});
 const source=await nativeSource(tx,fresh,selected);return work(fresh,{...selected,state,nativeSource:source});
}
/** Outcome is captured from the actual native operation, never guessed from a prefix/increment. */
export function employeeDraftDiscardOutcome(source:Pick<z.infer<typeof EmployeeDraftDiscardNativeSource>,'draftId'|'reservedEmployeeCode'|'reservedNumber'>,actual:EmployeeDraftDiscardResult){
 if(actual.draftId!==source.draftId||actual.reservedEmployeeCode!==source.reservedEmployeeCode)return fail();
 const code=source.reservedEmployeeCode;
 if(!code){if(source.reservedNumber!==null||actual.released)return fail();return C.ReservedCodeOutcome.parse({kind:'no_reservation',reservedEmployeeCode:null});}
 if(source.reservedNumber===null){if(actual.released)return fail();return C.ReservedCodeOutcome.parse({kind:'unreserved_code',reservedEmployeeCode:code});}
 return C.ReservedCodeOutcome.parse({kind:actual.released?'released_tip':'retained_gap',reservedEmployeeCode:code});
}
async function preview(tx:Tx,ctx:SessionContext,draftId:string){
 await tx.execute(sql`savepoint assistant_employee_draft_discard_preview`);
 try{const actual=await discardEmployeeDraft(ctx,draftId,tx,{returnResult:true});await tx.execute(sql`rollback to savepoint assistant_employee_draft_discard_preview`);await tx.execute(sql`release savepoint assistant_employee_draft_discard_preview`);return actual;}
 catch(error){await tx.execute(sql`rollback to savepoint assistant_employee_draft_discard_preview`);await tx.execute(sql`release savepoint assistant_employee_draft_discard_preview`);throw error;}
}
export async function prepareEmployeeDraftDiscardSourceTx(tx:Tx,ctx:SessionContext,input:Human,interval:DraftDiscardInterval){
 const human=C.Human.parse(structuredClone(input));if(interval.state!=='awaiting_confirmation'||!interval.nativeSource||human.draftId!==interval.draftId||human.companyId!==interval.companyId)return fail();
 const source=await nativeSource(tx,ctx,interval);if(source.sourceDigest!==interval.nativeSource.sourceDigest)return fail();
 const actual=await preview(tx,ctx,human.draftId),outcome=employeeDraftDiscardOutcome(source,actual);
 const restored=await nativeSource(tx,ctx,interval);if(JSON.stringify(restored)!==JSON.stringify(source))return fail();
 const review=C.Review.parse({draftId:human.draftId,companyId:human.companyId,companyName:source.companyName,draftLabel:source.label,scope:'saved_draft_without_any_linked_onboarding_case',capturedInput:'saved_draft_row_deleted_without_application_undo',reservedCodeOutcome:outcome,consequence:C.consequence});
 const reviewedDigest=hash([1,C.action,human,source.sourceDigest,source.nativeRowDigest,source.xmin,source.ctid,source.counterBeforeDigest,outcome,{tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null},ctx.entitlements?canonicalEntitlementsForDigest(ctx.entitlements):null]);
 return{content:human,review,reviewedDigest,sourceDigest:source.sourceDigest};
}
/** Return an attempt only. The review store must complete through the SQL proof owner before it
 * exposes this receipt; a same-shaped event/absence or child-savepoint attempt is insufficient. */
export async function confirmEmployeeDraftDiscardSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string,interval:DraftDiscardInterval){
 const current=await prepareEmployeeDraftDiscardSourceTx(tx,ctx,human,interval);if(current.reviewedDigest!==expected)return fail();
 const actual=await discardEmployeeDraft(ctx,human.draftId,tx,{returnResult:true});
 const outcome=employeeDraftDiscardOutcome(interval.nativeSource!,actual);
 if(JSON.stringify(outcome)!==JSON.stringify(current.review.reservedCodeOutcome))return fail();
 return C.Receipt.parse({kind:'discarded',draftId:human.draftId,companyId:human.companyId,eventId:actual.eventId,reservedCodeOutcome:outcome,capturedInput:'saved_draft_row_deleted_without_application_undo',consequence:C.consequence});
}
export async function reconcileEmployeeDraftDiscardSourceTx(tx:Tx,_ctx:SessionContext,reference:{actionId:string;draftId:string;companyId:string;eventId:string}){
 const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_employee_draft_discard_command('read',${reference.actionId}::uuid) as review`);
 // The SQL read owns current retained-author/company admission, exact original event and continued
 // draft absence. It does not require historical counters to remain frozen after later native hires.
 const parsed=z.object({metadata:z.object({state:z.literal('completed'),binding:z.object({draftId:z.guid(),companyId:z.guid()}).passthrough()}).passthrough(),eventId:z.guid(),nativeOutcome:C.ReservedCodeOutcome}).passthrough().parse(row?.review);
 if(parsed.metadata.binding.draftId!==reference.draftId||parsed.metadata.binding.companyId!==reference.companyId||parsed.eventId!==reference.eventId)return fail();
 return C.Receipt.parse({kind:'discarded',draftId:reference.draftId,companyId:reference.companyId,eventId:reference.eventId,reservedCodeOutcome:parsed.nativeOutcome,capturedInput:'saved_draft_row_deleted_without_application_undo',consequence:C.consequence});
}
export async function readEmployeeDraftDiscardChoicesTx(tx:Tx,supplied:SessionContext,selection:unknown){
 const ctx=await employeeDraftDiscardActorTx(tx,supplied),pick=C.ChoiceSelection.parse(selection??{});await tx.execute(sql`select app.access_workforce_write_lock()`);
 // Nomination metadata only. Actual selected membership/absence/counter proof is acquired through
 // the canonical Lifecycle owner during prepare, never inferred from case RLS or module state here.
 const rows=await tx.execute<{draftId:string;companyId:string|null;companyName:string|null;label:string;employeeCode:string|null;reservedNumber:number|null;sourceBytes:number;sourceCompressed:boolean;sourceInvalid:boolean;displayTooLarge:boolean}>(sql`select d.id as "draftId",d.company_id as "companyId",case when pg_catalog.pg_column_compression(c.legal_name) is not null or pg_catalog.pg_column_size(c.legal_name)>8000 then '' else case when pg_catalog.char_length(c.legal_name)>2000 then '' else c.legal_name end end as "companyName",case when pg_catalog.pg_column_compression(d.label) is not null or pg_catalog.pg_column_size(d.label)>8000 then '' else case when pg_catalog.char_length(d.label)>2000 then '' else d.label end end as label,case when pg_catalog.pg_column_compression(d.reserved_employee_code) is not null or pg_catalog.pg_column_size(d.reserved_employee_code)>2048 then null else case when pg_catalog.char_length(d.reserved_employee_code)>512 then null else d.reserved_employee_code end end as "employeeCode",d.reserved_number as "reservedNumber",pg_catalog.pg_column_size(d.data) as "sourceBytes",pg_catalog.pg_column_compression(d.data) is not null as "sourceCompressed",case when pg_catalog.pg_column_compression(d.data) is not null or pg_catalog.pg_column_size(d.data)>65536 then true else pg_catalog.jsonb_path_exists(d.data,'strict $.** ? (@.type() == "number")') end as "sourceInvalid",(case when pg_catalog.pg_column_compression(d.label) is not null or pg_catalog.pg_column_size(d.label)>8000 then true else pg_catalog.char_length(d.label)>2000 end or case when pg_catalog.pg_column_compression(d.reserved_employee_code) is not null or pg_catalog.pg_column_size(d.reserved_employee_code)>2048 then true else coalesce(pg_catalog.char_length(d.reserved_employee_code)>512,false) end or case when pg_catalog.pg_column_compression(c.legal_name) is not null or pg_catalog.pg_column_size(c.legal_name)>8000 then true else coalesce(pg_catalog.char_length(c.legal_name)>2000,false) end) as "displayTooLarge" from public.employee_draft d left join public.company c on c.id=d.company_id and c.tenant_id=d.tenant_id where d.tenant_id=${ctx.tenantId}::uuid and app.access_workforce_draft(d.company_id,d.created_by_person_id,'edit') and (${pick.companyId??null}::uuid is null or d.company_id=${pick.companyId??null}::uuid) order by d.updated_at desc,d.id desc limit 26`);
 const drafts=[];let truncated=rows.length>25;
 for(const row of Array.from(rows).slice(0,25)){
  const reason=!row.companyId?'unassigned_company':row.sourceBytes>65536||row.sourceCompressed||row.sourceInvalid||row.displayTooLarge||row.label.length>2000||(row.employeeCode?.length??0)>512?'source_out_of_bounds':!row.employeeCode&&row.reservedNumber!==null?'unsupported_reservation_shape':null;
  const item={draftId:row.draftId,companyId:row.companyId,companyName:row.companyName??'',label:row.label,employeeCode:row.employeeCode||null,supported:reason===null,unsupportedReason:reason,route:'/admin/personnel/new' as const};
  const candidate={kind:'choices' as const,drafts:[...drafts,item],truncated};
  if(!C.Choices.safeParse(candidate).success){truncated=true;break;}drafts.push(item);
 }
 if(rows.length&&!drafts.length)return{kind:'unavailable' as const};return C.Choices.parse({kind:'choices',drafts,truncated});
}
