/** Reasoned native rejection; no proposal values, model/provider reads, or field applications. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {profileChangeRequest} from '../../db/schema';
import {ProfileRequestRejection as C,type ProfileRequestRejectionHuman as Human} from '../../lib/assistant-actions/profile-request-rejection-contract';
import {canonicalEntitlementsForDigest} from '../../lib/assistant-actions/canonical-entitlements';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {decideProfileChange,profileRequestRejectionContextTx} from '../profile';
export class ProfileRequestRejectionUnavailable extends Error{constructor(){super('Please review this request in Personnel.');this.name='ProfileRequestRejectionUnavailable';}}
export const profileRequestRejectionUnavailable=():never=>{throw new ProfileRequestRejectionUnavailable();};
const fail=profileRequestRejectionUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function actor(tx:Tx,ctx:SessionContext){return withAgentActionGuard(tx,ctx,C.action,'approve');}
async function subject(tx:Tx,ctx:SessionContext,id:string,mode:'pending'|'recorded'){
 const native=await profileRequestRejectionContextTx(tx,ctx,id,mode);return native;
}
export async function withProfileRequestRejectionSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,mode:'pending'|'recorded',work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{const fresh=await actor(tx,ctx),native=await subject(tx,fresh,id,mode);return work(native.ctx,native.subject);}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const native=await subject(tx,ctx,human.subjectId,'pending'),s=native.subject;if(s.employmentId!==human.employmentId)return fail();
 const {employmentVersion,personVersion,companyVersion,companyId,subjectPersonId,...shown}=s;void companyId;void subjectPersonId;
 // The native owner alone trims the reason. The closed Human contract uses the same trim semantics.
 let reason:string|null=null;await tx.execute(sql`savepoint assistant_profile_rejection_preview`);
 try{await decideProfileChange(ctx,{requestId:human.subjectId,decision:'rejected',reason:human.reason},tx);const [saved]=await tx.select({reason:profileChangeRequest.decisionReason}).from(profileChangeRequest).where(and(eq(profileChangeRequest.id,human.subjectId),eq(profileChangeRequest.tenantId,ctx.tenantId)));reason=saved?.reason??null;}finally{await tx.execute(sql`rollback to savepoint assistant_profile_rejection_preview`);await tx.execute(sql`release savepoint assistant_profile_rejection_preview`);}
 if(!reason)return fail();
 const item=C.Item.parse({...shown,before:{status:'pending',reason:null},after:{status:'rejected',reason}});
 return{review:item,reviewedDigest:hash([1,C.action,native.sourceHash,native.revision,employmentVersion,personVersion,companyVersion,native.policyFingerprint,native.authorityHash,canonicalEntitlementsForDigest(native.ctx.entitlements),human,item])};
}
export const prepareProfileRequestRejectionSourceTx=review;
export async function confirmProfileRequestRejectionSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const native=await decideProfileChange(ctx,{requestId:human.subjectId,decision:'rejected',reason:human.reason},tx);if(!native.eventId)return fail();
 const [proof]=await tx.execute<{reason:string}>(sql`select r.decision_reason as reason from profile_change_request r join domain_event d on d.tenant_id=r.tenant_id and d.aggregate_id=r.id where r.id=${human.subjectId}::uuid and r.tenant_id=${ctx.tenantId}::uuid and r.employment_id=${human.employmentId}::uuid and r.status='rejected' and r.xmin=pg_current_xact_id()::xid and d.xmin=pg_current_xact_id()::xid and d.id=${native.eventId}::uuid and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.subject_employment_id=r.employment_id and d.aggregate_type='profile-change' and d.event_type='profile-change.rejected' and d.payload->>'decisionRowHash'=encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')`);
 if(!proof||proof.reason!==current.review.after.reason)return fail();
 return{eventId:native.eventId,receipt:await reconcileProfileRequestRejectionSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId:native.eventId})};
}
export async function reconcileProfileRequestRejectionSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 const current=await subject(tx,ctx,reference.subjectId,'recorded');if(current.subject.employmentId!==reference.employmentId)return fail();
 const [event]=await tx.execute(sql`select d.id from profile_change_request r join domain_event d on d.aggregate_id=r.id and d.tenant_id=r.tenant_id where r.id=${reference.subjectId}::uuid and r.tenant_id=${ctx.tenantId}::uuid and r.employment_id=${reference.employmentId}::uuid and r.status='rejected' and d.id=${reference.eventId}::uuid and d.subject_employment_id=r.employment_id and d.aggregate_type='profile-change' and d.event_type='profile-change.rejected' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.payload->>'decisionRowHash'=encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')`);if(!event)return fail();return C.Receipt.parse({kind:'rejected',...reference});
}
export async function readProfileRequestRejectionChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await actor(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 // Names are not projected until the native selected-request authority has passed. The RLS-scoped
 // scan returns only IDs; at most 26 candidates are examined, never an unbounded proposal queue.
 const ids=await tx.execute<{id:string}>(sql`select r.id from profile_change_request r join employment e on e.id=r.employment_id and e.tenant_id=r.tenant_id join person p on p.id=r.person_id and p.tenant_id=r.tenant_id where r.tenant_id=${fresh.tenantId}::uuid and r.status='pending' and app.profile_request_reader(r.id) and not app.is_self_person(r.person_id) and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by r.created_at desc,r.id limit 26`);
 const candidates=[...new Set([...(pick.subjectId?[pick.subjectId]:[]),...Array.from(ids,row=>row.id)])],requests:unknown[]=[];
 for(const id of candidates){
  // Do not swallow a PostgreSQL failure inside the top-level transaction. Each candidate is either
  // native-authorized and supported, or the entire bounded choice operation hands off.
  const native=await subject(tx,fresh,id,'pending');const {employmentVersion,personVersion,companyVersion,companyId,subjectPersonId,...shown}=native.subject;void employmentVersion;void personVersion;void companyVersion;void companyId;void subjectPersonId;requests.push(C.Subject.parse(shown));if(requests.length===26)break;
 }
 return C.Choices.parse({kind:'choices',requests:requests.slice(0,25),truncated:requests.length>25||ids.length>25});
}
