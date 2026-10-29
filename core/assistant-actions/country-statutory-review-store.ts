/** WP9: generic ASSIGNED statutory profile custody; native country-pack source owns field authority. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {createGenericAssignedCompatibilityStore} from './generic-assigned-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REVIEWED_COUNTRY_STATUTORY_ACTION as action,ReviewedCountryStatutoryHumanContent as Human} from '../../lib/assistant-actions/reviewed-country-statutory-contract';
import {CountryStatutoryReviewConfirmation,CountryStatutoryReviewRetirement,CountryStatutoryPreparedReview,CountryStatutoryCompletedReview,CountryStatutoryRetiredReview,CountryStatutoryReviewIndex} from '../../lib/assistant-actions/country-statutory-review-contract';
import {assertReviewedCountryStatutoryActorTx,withReviewedCountryStatutoryIntervalTx,prepareReviewedCountryStatutorySourceTx,confirmReviewedCountryStatutorySourceTx,reconcileReviewedCountryStatutorySourceTx} from './reviewed-country-statutory-source';
export class CountryStatutoryReviewUnavailable extends Error{constructor(){super('That statutory handoff needs a fresh look. Please reopen the Personnel review.');this.name='CountryStatutoryReviewUnavailable';}}
const fail=():never=>{throw new CountryStatutoryReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.guid(),companyId:z.guid(),subjectPersonId:z.guid(),statutoryId:z.guid(),country:z.literal('MY')}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
type Source={employmentId:string;personId:string;companyId:string;statutoryId:string;country:'MY'};
export const countryStatutoryReviews=createGenericAssignedCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,
 Awaited<ReturnType<typeof prepareReviewedCountryStatutorySourceTx>>,Awaited<ReturnType<typeof confirmReviewedCountryStatutorySourceTx>>,
 z.infer<typeof CountryStatutoryPreparedReview>,z.infer<typeof CountryStatutoryCompletedReview>,z.infer<typeof CountryStatutoryRetiredReview>,z.infer<typeof CountryStatutoryReviewIndex>
>({
 action,tier:'approve',normalizeActionId:id=>id.toLowerCase(),human:Human,metadata:Metadata,stored:Stored,
 confirmation:CountryStatutoryReviewConfirmation,retirement:CountryStatutoryReviewRetirement,retired:CountryStatutoryRetiredReview,index:CountryStatutoryReviewIndex,indexKind:'country_statutory_review_index',
 async withInterval(tx,ctx,nomination,work){const actor=await assertReviewedCountryStatutoryActorTx(tx,ctx);let employmentId:string;
  if(nomination.human)employmentId=nomination.human.employmentId;else{const id=z.guid().parse(nomination.actionId),[row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_country_statutory_review_subject(${id}::uuid) as subject`);employmentId=z.guid().parse(row?.subject);}
  return withReviewedCountryStatutoryIntervalTx(tx,actor,employmentId,work);
 },
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:source.employmentId,companyId:source.companyId,subjectPersonId:source.personId,statutoryId:source.statutoryId,country:source.country}),
 assertSubjectBinding:(binding,source)=>{if(binding.employmentId!==source.employmentId||binding.subjectPersonId!==source.personId||binding.companyId!==source.companyId||binding.statutoryId!==source.statutoryId||binding.country!==source.country)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.employmentId.toLowerCase()!==binding.employmentId||typeof human.input.personId!=='string'||human.input.personId.toLowerCase()!==binding.subjectPersonId)return fail();},
 prepareNative:(tx,ctx,human)=>prepareReviewedCountryStatutorySourceTx(tx,ctx,human),
 confirmNative:(tx,ctx,body)=>confirmReviewedCountryStatutorySourceTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(row,body,current)=>CountryStatutoryPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review}),
 async completed(tx,ctx,row){if(!row.eventId)return fail();const b=row.metadata.binding,receipt=await reconcileReviewedCountryStatutorySourceTx(tx,ctx,{employmentId:b.employmentId,personId:b.subjectPersonId,statutoryId:b.statutoryId,eventId:row.eventId});return CountryStatutoryCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.eventId,
 assertCompletion:(row,native)=>{const b=row.metadata.binding;if(row.eventId!==native.eventId||native.employmentId!==b.employmentId||native.personId!==b.subjectPersonId||native.companyId!==b.companyId||native.statutoryId!==b.statutoryId)return fail();},
 targets:source=>[{kind:'employment',id:source.employmentId},{kind:'person',id:source.personId}],
 async prepareRow(tx,m,sealed){const b=m.binding;const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_country_statutory_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${b.subjectPersonId}::uuid,${b.statutoryId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_country_statutory_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_country_statutory_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_country_statutory_review_complete(${id}::uuid,${expected},${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_country_statutory_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_country_statutory_reviews_index()`));},unavailable:fail,
});
export const prepareCountryStatutoryReview=countryStatutoryReviews.prepare;
export const confirmCountryStatutoryReview=countryStatutoryReviews.confirm;
export const reopenCountryStatutoryReview=countryStatutoryReviews.reopen;
export const discardCountryStatutoryReview=countryStatutoryReviews.discard;
export const listCountryStatutoryReviews=countryStatutoryReviews.list;
export const readCompletedCountryStatutoryOutcomeTx=countryStatutoryReviews.readCompletedOutcomeTx;
