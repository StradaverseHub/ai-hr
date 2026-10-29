/** Default installed generic protocol adapter. The shared custody engine owns crypto and lifecycle. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {OwnLeaveSealedReview} from './own-leave-content';
import type {NativeOutcomeAction} from '../../lib/ai/module-native-outcomes';
import {createReviewCustody} from './generic-review-custody';
export type GenericOwnSubject=Readonly<{subjectId:string;employmentId:string;companyId:string}>;
type Schema<T>=z.ZodType<T>;
/** A compatibility repository preserves an installed kind's SQL/verifier and row format. It normalizes
 * only custody metadata; native authority, canonical locks and effects remain in source adapters. */
export type OwnReviewMetadata=Readonly<{actionId:string;action:string;contractVersion:1;binding:{tenantId:string;userId:string;personId:string;employmentId:string;companyId:string};intentDigest:string|null;reviewedDigest:string|null;state:'awaiting_confirmation'|'completed'|'discarded'|'expired'|'refused';createdAt:string;expiresAt:string}>;
export type OwnReviewPersistence=Readonly<{
 assertActor(tx:Tx,ctx:SessionContext):Promise<SessionContext>;
 subject(tx:Tx,id:string):Promise<{employmentId:string;subjectId:string}>;
 read(tx:Tx,id:string):Promise<unknown>;
 prepare(tx:Tx,metadata:OwnReviewMetadata,sealed:z.infer<typeof OwnLeaveSealedReview>):Promise<unknown>;
 complete(tx:Tx,id:string,digest:string,native:{eventId:string;nativeRequestId?:string}):Promise<unknown>;
 discard(tx:Tx,id:string):Promise<unknown>;
 index(tx:Tx):Promise<unknown>;
}>;
/** What a kind must provide. Every callback runs inside the caller's top-level transaction; any throw must
 * roll the whole command back. `confirm` performs the native effect and returns its committed event. */
export type GenericOwnReviewSpec<Human extends {employmentId:string},Review,Receipt,Prepared,Completed,Retired,Index>=Readonly<{
 action:NativeOutcomeAction&string;subjectKind:string;subjectOf(human:Human):string;
 human:Schema<Human>;consequence:string;persistence?:OwnReviewPersistence;
 prepared:Schema<Prepared>;completed:Schema<Completed>;retired:Schema<Retired>;index:Schema<Index>;indexKind:string;
 withSubject<T>(tx:Tx,ctx:SessionContext,subjectId:string,work:(fresh:SessionContext,own:GenericOwnSubject)=>Promise<T>):Promise<T>;
 prepare(tx:Tx,fresh:SessionContext,human:Human):Promise<{content?:Human;review:Review;reviewedDigest:string}>;
 confirm(tx:Tx,fresh:SessionContext,human:Human,reviewedDigest:string):Promise<{receipt:Receipt;eventId:string;nativeRequestId?:string}>;
 reconcile(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string;nativeRequestId?:string}):Promise<Receipt>;
 unavailable():never;
}>;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid(),employmentId:z.guid(),companyId:z.guid()}).strict();
const State=z.enum(['awaiting_confirmation','completed','discarded','expired','refused']);
export function createGenericOwnReviewStore<Human extends {employmentId:string},Review,Receipt,Prepared,Completed,Retired,Index>(spec:GenericOwnReviewSpec<Human,Review,Receipt,Prepared,Completed,Retired,Index>){
 const {action}=spec,fail=():never=>spec.unavailable();
 const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:State,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
 type Meta=z.infer<typeof Metadata>;
 const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),subjectKind:z.literal(spec.subjectKind),subjectId:z.guid(),eventId:z.guid().nullable(),nativeRequestId:z.guid().optional()}).strict().refine(value=>
  (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
  &&(value.metadata.state==='completed')===(value.eventId!==null)
  &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
 type Stored=z.infer<typeof Stored>;

 type Native={content:Human;reviewedDigest:string;review:Review};
 const subject=async(tx:Tx,id:string,ctx:SessionContext)=>{if(spec.persistence){await spec.persistence.assertActor(tx,ctx);return spec.persistence.subject(tx,id);}const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_generic_review_subject(${id}::uuid,${action}) as subject`);return z.object({employmentId:z.guid(),subjectId:z.guid()}).strict().parse(row?.subject);};
 return createReviewCustody<Human,z.infer<typeof Binding>,Stored,GenericOwnSubject,Native,Awaited<ReturnType<typeof spec.confirm>>,Prepared,Completed,Retired,Index>({
 action,tier:'confirm',human:spec.human,metadata:Metadata,stored:Stored,confirmation:z.object({actionId:z.guid(),reviewedDigest:digest}),retirement:z.object({actionId:z.guid()}),retired:spec.retired,index:spec.index,indexKind:spec.indexKind,
 async withInterval(tx,ctx,nomination,work){const subjectId=nomination.human?spec.subjectOf(nomination.human):(await subject(tx,z.guid().parse(nomination.actionId),ctx)).subjectId;return spec.withSubject(tx,ctx,subjectId,work);},
 binding:(ctx,own,human)=>{if(own.employmentId!==human.employmentId)return fail();return Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,employmentId:own.employmentId,companyId:own.companyId});},
 assertSubjectBinding:(binding,own)=>{if(binding.employmentId!==own.employmentId||binding.companyId!==own.companyId)return fail();},assertStoredSubject:(row,own)=>{if(row.subjectId!==own.subjectId)return fail();},
 assertHumanBinding:(binding,human)=>{if(binding.employmentId!==human.employmentId)return fail();},
 async prepareNative(tx,ctx,human){const native=await spec.prepare(tx,ctx,human);if(native.content!==undefined&&JSON.stringify(native.content)!==JSON.stringify(human))return fail();return{...native,content:human};},
 confirmNative:(tx,ctx,body)=>spec.confirm(tx,ctx,body.content,body.nativeReviewedDigest),
 pending:(row,body,current)=>spec.prepared.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review,consequence:spec.consequence}),
 async completed(tx,ctx,row){if(!row.eventId)return fail();const receipt=await spec.reconcile(tx,ctx,{subjectId:row.subjectId,eventId:row.eventId,employmentId:row.metadata.binding.employmentId,nativeRequestId:row.nativeRequestId});return spec.completed.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.eventId,assertCompletion:(row,native)=>{if(row.eventId!==native.eventId||row.nativeRequestId!==native.nativeRequestId)return fail();},targets:own=>[{kind:'employment',id:own.employmentId}],
 async prepareRow(tx,m,sealed,own){if(spec.persistence)return spec.persistence.prepare(tx,Metadata.parse(m),sealed);const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_generic_review_prepare(${action},${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${own.subjectId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){if(spec.persistence)return spec.persistence.read(tx,id);const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_generic_review_read(${id}::uuid,${action}) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){if(spec.persistence)return spec.persistence.complete(tx,id,expected,native);const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_generic_review_complete(${id}::uuid,${action},${expected},${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){if(spec.persistence)return spec.persistence.discard(tx,id);const [raw]=await tx.execute<{review:unknown}>(sql`select app.assistant_generic_review_read(${id}::uuid,${action},true) as review`),row=Stored.parse(raw?.review);if(row.metadata.actionId!==id)return fail();return spec.retired.parse({action,contractVersion:1,actionId:id,state:row.metadata.state});},
 async indexRows(tx){if(spec.persistence)return spec.persistence.index(tx);return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_generic_reviews_index(${action})`));},unavailable:fail,
 });
}
export {createReviewCustody as createGenericOwnCompatibilityStore} from './generic-review-custody';
