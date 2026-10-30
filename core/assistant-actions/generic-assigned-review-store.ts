/** Default installed generic protocol adapter. The shared custody engine owns crypto and lifecycle. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {OwnLeaveSealedReview} from './own-leave-content';
import type {NativeOutcomeAction} from '../../lib/ai/module-native-outcomes';
import {createReviewCustody} from './generic-review-custody';
export type AssignedSubject=Readonly<{subjectId:string;employmentId:string;companyId:string;subjectPersonId:string}>;
type Schema<T>=z.ZodType<T>;
/** What a kind must provide. Every callback runs inside the caller's top-level transaction; any throw must
 * roll the whole command back. `withSubject` must refuse a subject whose person is the caller's own. */
export type GenericAssignedReviewSpec<Human extends {employmentId:string;subjectId:string},Review,Receipt,Prepared,Completed,Retired,Index>=Readonly<{
 action:NativeOutcomeAction&string;
 human:Schema<Human>;consequence:string;
 prepared:Schema<Prepared>;completed:Schema<Completed>;retired:Schema<Retired>;index:Schema<Index>;indexKind:string;
 withSubject<T>(tx:Tx,ctx:SessionContext,subjectId:string,mode:'pending'|'recorded',work:(fresh:SessionContext,subject:AssignedSubject)=>Promise<T>):Promise<T>;
 prepare(tx:Tx,fresh:SessionContext,human:Human):Promise<{review:Review;reviewedDigest:string}>;
 confirm(tx:Tx,fresh:SessionContext,human:Human,reviewedDigest:string):Promise<{receipt:Receipt;eventId:string}>;
 reconcile(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}):Promise<Receipt>;
 unavailable():never;
}>;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.guid(),companyId:z.guid(),subjectPersonId:z.guid()}).strict();
const State=z.enum(['awaiting_confirmation','completed','discarded','expired','refused']);
export function createGenericAssignedReviewStore<Human extends {employmentId:string;subjectId:string},Review,Receipt,Prepared,Completed,Retired,Index>(spec:GenericAssignedReviewSpec<Human,Review,Receipt,Prepared,Completed,Retired,Index>){
 const {action}=spec,fail=():never=>spec.unavailable();
 const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:State,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
 type Meta=z.infer<typeof Metadata>;
 const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),subjectKind:z.string().min(1).max(64),subjectId:z.guid(),eventId:z.guid().nullable()}).strict().refine(value=>
  (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
  &&(value.metadata.state==='completed')===(value.eventId!==null)
  &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
 type Stored=z.infer<typeof Stored>;

 type Native={content:Human;reviewedDigest:string;review:Review};
 const nominate=async(tx:Tx,id:string)=>{const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_assigned_review_subject(${id}::uuid,${action}) as subject`);return z.object({subjectId:z.guid(),mode:z.enum(['pending','recorded'])}).strict().parse(row?.subject);};
 return createReviewCustody<Human,z.infer<typeof Binding>,Stored,AssignedSubject,Native,Awaited<ReturnType<typeof spec.confirm>>,Prepared,Completed,Retired,Index>({
 action,tier:'approve',human:spec.human,metadata:Metadata,stored:Stored,confirmation:z.object({actionId:z.guid(),reviewedDigest:digest}),retirement:z.object({actionId:z.guid()}),retired:spec.retired,index:spec.index,indexKind:spec.indexKind,
 async withInterval(tx,ctx,nomination,work){const ref=nomination.human?{subjectId:nomination.human.subjectId,mode:'pending' as const}:await nominate(tx,z.guid().parse(nomination.actionId));return spec.withSubject(tx,ctx,ref.subjectId,ref.mode,work);},
 binding:(ctx,subject,human)=>{if(subject.employmentId!==human.employmentId||subject.subjectId!==human.subjectId)return fail();return Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:subject.employmentId,companyId:subject.companyId,subjectPersonId:subject.subjectPersonId});},
 assertSubjectBinding:(binding,subject)=>{if(binding.employmentId!==subject.employmentId||binding.companyId!==subject.companyId||binding.subjectPersonId!==subject.subjectPersonId||binding.subjectPersonId===binding.personId)return fail();},assertStoredSubject:(row,subject)=>{if(row.subjectId!==subject.subjectId)return fail();},
 assertHumanBinding:(binding,human)=>{if(binding.employmentId!==human.employmentId)return fail();},
 async prepareNative(tx,ctx,human){return{...await spec.prepare(tx,ctx,human),content:human};},
 confirmNative:(tx,ctx,body,subject)=>{if(body.content.subjectId!==subject.subjectId)return fail();return spec.confirm(tx,ctx,body.content,body.nativeReviewedDigest);},
 pending:(row,body,current)=>{if(body.content.subjectId!==row.subjectId)return fail();return spec.prepared.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review,consequence:spec.consequence});},
 async completed(tx,ctx,row){if(!row.eventId)return fail();const receipt=await spec.reconcile(tx,ctx,{subjectId:row.subjectId,eventId:row.eventId,employmentId:row.metadata.binding.employmentId});return spec.completed.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.eventId,assertCompletion:(row,native)=>{if(row.eventId!==native.eventId)return fail();},targets:subject=>[{kind:'employment',id:subject.employmentId},{kind:'person',id:subject.subjectPersonId}],
 async prepareRow(tx,m,sealed,subject,human){const b=m.binding;if(action==='attendance.schedule_group.maintain'){const target=(human as Human & {attendanceRuleId?:unknown}).attendanceRuleId;if(target!==null&&typeof target!=='string')return fail();const[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_attendance_schedule_group_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${b.subjectPersonId}::uuid,${target}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;}const[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_assigned_review_prepare(${action},${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${b.subjectPersonId}::uuid,${subject.subjectId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_assigned_review_read(${id}::uuid,${action}) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_assigned_review_complete(${id}::uuid,${action},${expected},${native.eventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [raw]=await tx.execute<{review:unknown}>(sql`select app.assistant_assigned_review_read(${id}::uuid,${action},true) as review`),row=Stored.parse(raw?.review);if(row.metadata.actionId!==id)return fail();return spec.retired.parse({action,contractVersion:1,actionId:id,state:row.metadata.state});},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_assigned_reviews_index(${action})`));},unavailable:fail,
 });
}
export {createReviewCustody as createGenericAssignedCompatibilityStore} from './generic-review-custody';
