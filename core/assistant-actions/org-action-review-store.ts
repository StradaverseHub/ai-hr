/** WP9: generic ASSIGNED reporting custody, retaining the original manager snapshots and org AAD. */
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx,SessionContext} from '../../db/client';
import {employment} from '../../db/schema';
import {createGenericAssignedCompatibilityStore} from './generic-assigned-review-store';
import {withAgentActionGuard} from './agent-action-guard';
import {PrivateReviewNonce,privateReviewCommitment} from './private-review-commitment';
import {OwnLeaveSealedReview} from './own-leave-content';
import {lockLeaveDependencyConfigurationTx} from '../../packs/leave/service';
import {prepareReviewedReportingLineSourceTx,confirmReviewedReportingLineSourceTx,reconcileReviewedReportingLineSourceTx} from './reviewed-reporting-line-source';
import {REVIEWED_REPORTING_LINE_ACTION as ACTION,ReviewedReportingLineHumanContent as Human,ReviewedReportingLineReview as Review} from '../../lib/assistant-actions/reviewed-reporting-line-contract';
import {OrgActionConfirmation,OrgActionRetirement,OrgActionPreparedReview,OrgActionCompletedReceipt,OrgActionRetirementReceipt,OrgActionReviewIndexResult} from '../../lib/assistant-actions/org-action-review-contract';
export class OrgActionReviewUnavailable extends Error{constructor(){super('That reporting review needs another look. Please use the employee record.');this.name='OrgActionReviewUnavailable';}}
const fail=():never=>{throw new OrgActionReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.guid(),companyId:z.guid(),subjectPersonId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(ACTION),binding:Binding,managerPersonId:z.guid().nullable(),previousManagerPersonId:z.guid().nullable(),intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),reportingLineId:z.guid().nullable(),setEventId:z.guid().nullable()}).strict().refine(r=>
 (r.metadata.state==='awaiting_confirmation')===(r.sealed!==null&&r.metadata.intentDigest!==null&&r.metadata.reviewedDigest!==null&&r.metadata.managerPersonId!==null)
 &&(r.metadata.state==='completed')===(r.reportingLineId!==null&&r.setEventId!==null)
 &&((r.reportingLineId===null)===(r.setEventId===null))
 &&(r.metadata.state==='awaiting_confirmation'||(r.sealed===null&&r.metadata.intentDigest===null&&r.metadata.reviewedDigest===null&&r.metadata.managerPersonId===null&&r.metadata.previousManagerPersonId===null)));

const Body=z.object({reviewNonce:PrivateReviewNonce,content:Human,review:Review,nativeReviewedDigest:digest}).strict().refine(b=>b.review.subordinateEmploymentId===b.content.subordinateEmploymentId&&b.content.managerEmploymentId===b.review.after.managerEmploymentId);
type Stored=z.infer<typeof Stored>;
type Source={subjectId:string};
type NativePrepared=Awaited<ReturnType<typeof prepareReviewedReportingLineSourceTx>>&{targetPersonId:string;targetCompanyId:string;managerPersonId:string;previousManagerPersonId:string|null};
async function ownInterval(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,ACTION,'approve');await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,fresh.tenantId);return fresh;}
async function nativePrepare(tx:Tx,ctx:SessionContext,human:z.infer<typeof Human>):Promise<NativePrepared>{
 const native=await prepareReviewedReportingLineSourceTx(tx,ctx,human);
 // The native preflight has already established subordinate maintenance and both manager views.
 const lookup=async(id:string)=>{const [row]=await tx.select({personId:employment.personId,companyId:employment.companyId}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.id,id))).limit(1);if(!row)return fail();return row;};
 const target=await lookup(human.subordinateEmploymentId),manager=await lookup(human.managerEmploymentId),prior=native.review.before?await lookup(native.review.before.managerEmploymentId):null;
 return{...native,targetPersonId:target.personId,targetCompanyId:target.companyId,managerPersonId:manager.personId,previousManagerPersonId:prior?.personId??null};
}
export const orgActionReviews=createGenericAssignedCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,NativePrepared,Awaited<ReturnType<typeof confirmReviewedReportingLineSourceTx>>,
 z.infer<typeof OrgActionPreparedReview>,z.infer<typeof OrgActionCompletedReceipt>,z.infer<typeof OrgActionRetirementReceipt>,z.infer<typeof OrgActionReviewIndexResult>
>({
 action:ACTION,tier:'approve',human:Human,metadata:Metadata,stored:Stored,
 confirmation:OrgActionConfirmation,retirement:OrgActionRetirement,retired:OrgActionRetirementReceipt,index:OrgActionReviewIndexResult,indexKind:'org_module_review_index',
 metadataInput:(common,_source,native)=>{const{contractVersion,...metadata}=common;void contractVersion;return{...metadata,managerPersonId:native.managerPersonId,previousManagerPersonId:native.previousManagerPersonId};},
 crypto:{identity:m=>JSON.stringify([1,ACTION,m.actionId,m.binding,m.managerPersonId,m.previousManagerPersonId,m.intentDigest,m.reviewedDigest]),commitment:(m,wire)=>privateReviewCommitment([1,ACTION,m.binding,m.managerPersonId,m.previousManagerPersonId],wire),keyPurpose:'assistant:org-review:key:',bodyPurpose:'assistant:org-review:body:'},
 body:{read:value=>Body.parse(value),write:body=>Body.parse(body),create:(native,reviewNonce)=>Body.parse({reviewNonce,content:native.content,review:native.review,nativeReviewedDigest:native.reviewedDigest}),assertCurrent:(body,current)=>{if(JSON.stringify(Body.parse(body).review)!==JSON.stringify(current.review))return fail();}},
 async withInterval(tx,ctx,nomination,work){const actor=await ownInterval(tx,ctx);let subjectId:string;if(nomination.human)subjectId=nomination.human.subordinateEmploymentId;else{const id=z.guid().parse(nomination.actionId),[row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_org_review_subject(${id}::uuid) as subject`);subjectId=z.guid().parse(row?.subject);}return work(actor,{subjectId});},
 binding:(ctx,source,_human,native)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:source.subjectId,companyId:native.targetCompanyId,subjectPersonId:native.targetPersonId}),
 assertSubjectBinding:(binding,source)=>{if(binding.employmentId!==source.subjectId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.subordinateEmploymentId!==binding.employmentId)return fail();},
 prepareNative:nativePrepare,
 confirmNative:(tx,ctx,body)=>confirmReviewedReportingLineSourceTx(tx,ctx,body.content,{action:ACTION,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(row,body)=>OrgActionPreparedReview.parse({action:ACTION,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:Body.parse(body).review,consequence:'structural_reporting_change_not_delegation'}),
 async completed(tx,ctx,row){if(!row.reportingLineId||!row.setEventId)return fail();const receipt=await reconcileReviewedReportingLineSourceTx(tx,ctx,{reportingLineId:row.reportingLineId,setEventId:row.setEventId,subordinateEmploymentId:row.metadata.binding.employmentId});return OrgActionCompletedReceipt.parse({action:ACTION,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.setEventId,nativeEvent:native=>native.setEventId,
 assertCompletion:(row,native)=>{if(row.reportingLineId!==native.reportingLineId||row.setEventId!==native.setEventId)return fail();},
 targets:(_source,_native,_current,body)=>{const saved=Body.parse(body);return[{kind:'employment',id:saved.content.subordinateEmploymentId},{kind:'employment',id:saved.content.managerEmploymentId},...(saved.review.before?[{kind:'employment' as const,id:saved.review.before.managerEmploymentId}]:[])];},
 async prepareRow(tx,m,sealed,_source,human,current){const b=m.binding;const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_org_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${b.subjectPersonId}::uuid,${human.managerEmploymentId}::uuid,${current.review.before?.managerEmploymentId??null}::uuid,${human.lineType},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_org_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_org_review_complete(${id}::uuid,${expected},${native.reportingLineId}::uuid,${native.setEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_org_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){await tx.execute(sql`select app.assistant_own_leave_reviews_expire_own(100)`);const rows=await tx.execute(sql`select * from app.assistant_org_reviews_index()`);return Array.from(rows).map(row=>({action:ACTION,...row}));},unavailable:fail,
});
export const prepareOrgActionReview=orgActionReviews.prepare;
export const confirmOrgActionReview=orgActionReviews.confirm;
export const reopenOrgActionReview=orgActionReviews.reopen;
export const discardOrgActionReview=orgActionReviews.discard;
export const listOrgActionReviews=orgActionReviews.list;
export const readCompletedOrgOutcomeTx=orgActionReviews.readCompletedOutcomeTx;
