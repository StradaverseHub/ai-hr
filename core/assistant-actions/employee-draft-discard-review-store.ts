/** Human saved-draft custody; SQL owns private source commitments, native proof and replay. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../../db/client';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
import {assertAiPrincipalTx} from '../ai-principal';
import {createReviewCustody} from './generic-review-custody';
import {OwnLeaveSealedReview} from './own-leave-content';
import {PrivateReviewNonce} from './private-review-commitment';
import {EmployeeDraftDiscard as C} from '../../lib/assistant-actions/employee-draft-discard-contract';
import {employeeDraftDiscardActorTx,withEmployeeDraftDiscardIntervalTx,prepareEmployeeDraftDiscardSourceTx,confirmEmployeeDraftDiscardSourceTx,reconcileEmployeeDraftDiscardSourceTx,readEmployeeDraftDiscardChoicesTx,employeeDraftDiscardUnavailable as fail,type DraftDiscardInterval} from './employee-draft-discard-source';
const digest=z.string().regex(/^[a-f0-9]{64}$/),state=z.enum(['awaiting_confirmation','completed','discarded','expired','refused']);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),draftId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(C.action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable(),nativeOutcome:C.ReservedCodeOutcome.nullable()}).strict().refine(row=>{
 const pending=row.metadata.state==='awaiting_confirmation',completed=row.metadata.state==='completed';
 return pending===(row.sealed!==null&&row.metadata.intentDigest!==null&&row.metadata.reviewedDigest!==null)&&completed===(row.eventId!==null&&row.nativeOutcome!==null)&&(pending||row.sealed===null&&row.metadata.intentDigest===null&&row.metadata.reviewedDigest===null)&&(completed||row.eventId===null&&row.nativeOutcome===null);
});
const Body=z.object({reviewNonce:PrivateReviewNonce,content:C.Human,nativeReviewedDigest:digest}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=8000);
const custody=createReviewCustody<z.infer<typeof C.Human>,z.infer<typeof Binding>,z.infer<typeof Stored>,DraftDiscardInterval,Awaited<ReturnType<typeof prepareEmployeeDraftDiscardSourceTx>>,Awaited<ReturnType<typeof confirmEmployeeDraftDiscardSourceTx>>,z.infer<typeof C.Prepared>,z.infer<typeof C.Completed>,z.infer<typeof C.Retired>,z.infer<typeof C.Index>>({
 action:C.action,tier:'approve',human:C.Human,metadata:Metadata,stored:Stored,confirmation:C.Confirmation,retirement:C.Retirement,retired:C.Retired,index:C.Index,indexKind:C.indexKind,
 body:{read:value=>Body.parse(value),write:value=>Body.parse(value),create:(native,reviewNonce)=>Body.parse({reviewNonce,content:native.content,nativeReviewedDigest:native.reviewedDigest}),assertCurrent:(body,current)=>{if(body.nativeReviewedDigest!==current.reviewedDigest)return fail();}},
 async withInterval(tx,ctx,nomination,work){
  await employeeDraftDiscardActorTx(tx,ctx);
  if(nomination.human)return withEmployeeDraftDiscardIntervalTx(tx,ctx,{draftId:nomination.human.draftId,companyId:nomination.human.companyId},work);
  const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_employee_draft_discard_command('subject',${nomination.actionId}::uuid) as subject`);
  const subject=C.Selection.extend({state}).strict().parse(row?.subject);
  return withEmployeeDraftDiscardIntervalTx(tx,ctx,{draftId:subject.draftId,companyId:subject.companyId},work,subject.state);
 },
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:source.companyId,draftId:source.draftId}),
 assertSubjectBinding:(binding,source)=>{if(binding.companyId!==source.companyId||binding.draftId!==source.draftId)return fail();},
 assertHumanBinding:(binding,human)=>{if(binding.companyId!==human.companyId||binding.draftId!==human.draftId)return fail();},
 assertConfirmationBinding:(input,binding,source)=>{const confirmation=C.Confirmation.parse(input);if(confirmation.draftId!==binding.draftId||confirmation.companyId!==binding.companyId||confirmation.draftId!==source.draftId||confirmation.companyId!==source.companyId)return fail();},
 prepareNative:prepareEmployeeDraftDiscardSourceTx,
 confirmNative:(tx,ctx,body,source)=>confirmEmployeeDraftDiscardSourceTx(tx,ctx,body.content,body.nativeReviewedDigest,source),
 pending:(row,body,native)=>C.Prepared.parse({action:C.action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:native.review}),
 async completed(tx,ctx,row){if(!row.eventId||!row.nativeOutcome)return fail();const receipt=await reconcileEmployeeDraftDiscardSourceTx(tx,ctx,{actionId:row.metadata.actionId,draftId:row.metadata.binding.draftId,companyId:row.metadata.binding.companyId,eventId:row.eventId});if(JSON.stringify(receipt.reservedCodeOutcome)!==JSON.stringify(row.nativeOutcome))return fail();return C.Completed.parse({action:C.action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.eventId,assertCompletion:(row,native)=>{if(row.eventId!==native.eventId||JSON.stringify(row.nativeOutcome)!==JSON.stringify(native.reservedCodeOutcome))return fail();},
 // Only actual actor privacy linkage is added by the common SQL target owner. An unborn draft
 // candidate is not an invented PERSON/EMPLOYMENT; DELETE cleanup owns pending draft ciphertexts.
 targets:()=>[],
 async prepareRow(tx,m,sealed,_source,_human,current){const b=m.binding;const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_employee_draft_discard_command('prepare',${m.actionId}::uuid,${b.personId}::uuid,${b.companyId}::uuid,${b.draftId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext},${current.sourceDigest}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_employee_draft_discard_command('read',${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_employee_draft_discard_command('complete',${id}::uuid,NULL,NULL,NULL,NULL,${expected},NULL,NULL,NULL,NULL,${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_employee_draft_discard_command('discard',${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){const [row]=await tx.execute<{rows:unknown}>(sql`select app.assistant_employee_draft_discard_command('index') as rows`);return z.array(z.unknown()).parse(row?.rows);},unavailable:fail,
});
export async function readEmployeeDraftDiscardChoices(supplied:SessionContext,selection?:unknown){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,tx=>readEmployeeDraftDiscardChoicesTx(tx,ctx,selection));}catch{return{kind:'unavailable' as const};}}

/** These two terminal/metadata courses install bounds before the common principal's Access wait,
 * and keep them through COMMIT. They do not decrypt bodies or execute native mutations. */
export const employeeDraftDiscardReviews=Object.freeze({...custody,
 async discard(supplied:SessionContext,input:unknown){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};const parsed=C.Retirement.safeParse(input);if(!parsed.success)return fail();try{return await withTenant(ctx,async tx=>{await boundNativeOutcomeTransactionTx(tx);await assertAiPrincipalTx(tx,ctx);const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_employee_draft_discard_command('discard',${parsed.data.actionId}::uuid) as receipt`);return{kind:'retired' as const,receipt:C.Retired.parse(row?.receipt)};});}catch{return fail();}},
 async list(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,async tx=>{await boundNativeOutcomeTransactionTx(tx);await assertAiPrincipalTx(tx,ctx);const [row]=await tx.execute<{rows:unknown}>(sql`select app.assistant_employee_draft_discard_command('index') as rows`);return C.Index.parse({kind:C.indexKind,reviews:row?.rows});});}catch{return fail();}},
});
