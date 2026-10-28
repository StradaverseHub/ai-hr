/** Import-safe PRIVATE fictional profile-request browser readback. No CLI, writes, custody
 * decryption, grants, provider, pool creation/closure or session injection. Parent owns admission.
 * READ COMMITTED + FIRST callback SET TRANSACTION READ ONLY preserves actual principal readers.
 * Native prepare/workspace take FOR UPDATE/write-mode dependency ownership and are deliberately NOT
 * called here. This checks current permitted fixture-field facts, exact human input and native
 * submission provenance/counts; it does NOT independently rebuild the private preparation digest.
 */
import {and,count,eq,sql} from 'drizzle-orm';
import {client,withTenant,type createDb,type Grant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {resolveEntitlementsTx,assertModuleEnabled,getSetting} from '../../core/entitlements';
import {readOwnLeaveActorTx} from '../../core/assistant-actions/own-leave-actor';
import {resolveEssEditableIds} from '../../lib/personnel-ess-contract';
import {resolveEssVisibleIds} from '../../lib/personnel-ess-visibility';
import {myOwnEmploymentSubjectsTx} from '../../core/read';
import {readOwnProfileChangeSubmissionReferenceTx} from '../../core/profile';
import {assertAiActionUnpausedTx} from '../../core/ai-governance';
import {OwnProfileChangeHumanContent} from '../../lib/assistant-actions/own-profile-change-contract';
import type {populateAiDeliveryFullFixture} from './ai-delivery-full-fixture';
type Fixture=Awaited<ReturnType<typeof populateAiDeliveryFullFixture>>;
type Human=ReturnType<typeof OwnProfileChangeHumanContent.parse>;
type Expected={userId:string;human:Human};
type Receipt={action:'ess.profile.request';contractVersion:1;actionId:string;state:'completed';requestId:string;requestedEventId:string;employmentId:string;currentStatus:'pending'|'approved'|'rejected';semantics:'submitted_not_approved'};
type Invocation={phase:'baseline'|'prepared'|'submitted'|'reopened'|'reopened_again';expected:Expected;actionId?:string;receipt?:Receipt;review?:unknown};
const unavailable=(code='unavailable'):never=>{throw Error('profile_native_readback:'+code);};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function urls(){
 const values=[process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL].map(value=>{let u:URL;try{u=new URL(value??'');}catch{return unavailable();}const db=u.pathname.slice(1);if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.port!=='5433'||!(db==='aihr_ai_delivery_browser_v4_20261027'||/^aihr_assistant_browser_[a-f0-9]{16}$/.test(db))||u.hash||[...u.searchParams].some(([key,value])=>key!=='sslmode'||value!=='disable'))return unavailable();return u;});
 if(values[0].pathname!==values[1].pathname||decodeURIComponent(values[0].username)!=='ai_hr_app'||values[0].username===values[1].username)return unavailable();return values;
}
function physical(row:{database:string;address:string;port:number;readonly:string;isolation:string},database:string){if(row.database!==database||!['127.0.0.1','::1'].includes(row.address)||row.port!==5433||row.readonly!=='on'||row.isolation!=='read committed')return unavailable();}
/** Native/private callback only. Return bounded browser checks separately, never these facts. */
export async function createAiDeliveryProfileNativeReadback({owner,fixture}:{owner:ReturnType<typeof createDb>;fixture:Fixture}){
 const captured=structuredClone({state:fixture.state,tenantId:fixture.tenantId,companyId:fixture.companyId,self:fixture.actors.self,human:fixture.workforce.ess.human});
 const human=OwnProfileChangeHumanContent.parse(captured.human),field=human.proposal.fields[0];
 if(captured.state!=='native_prerequisites_prepared_not_experienced'||![captured.tenantId,captured.companyId,captured.self.userId,captured.self.personId,captured.self.employmentId].every(uuid)||human.employmentId!==captured.self.employmentId||human.proposal.fields.length!==1||human.proposal.registers.length!==0||field.fieldId!=='profile.personal_details.preferredname'||typeof field.value!=='string')return unavailable();
 const expected:Expected={userId:captured.self.userId,human},configured=urls(),database=configured[0].pathname.slice(1),ownerName=decodeURIComponent(configured[1].username);
 let baseline:{totalTenantRequests:number;totalTenantRequestedEvents:number}|undefined,originalValue:string|null|undefined,actionId:string|undefined,receipt:Receipt|undefined,next:Invocation['phase']|'complete'='baseline',inFlight=false;
 async function tenantCounts(requestId?:string){return owner.client.begin('isolation level read committed read only',async tx=>{
  const [role]=await tx<{name:string;database:string;address:string;port:number;readonly:string;isolation:string;full:boolean}[]>`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper or rolbypassrls as full from pg_roles where rolname=current_user`;
  physical(role,database);if(role.name!==ownerName||role.name==='ai_hr_app'||role.full!==true)return unavailable();
  // Schema-owner access is aggregate-only, never proposal/person/custody/event row projection.
  const [totals]=await tx<{totalTenantRequests:number;totalTenantRequestedEvents:number}[]>`select (select count(*)::int from public.profile_change_request where tenant_id=${captured.tenantId}::uuid) as "totalTenantRequests",(select count(*)::int from public.domain_event where tenant_id=${captured.tenantId}::uuid and event_type='profile-change.requested') as "totalTenantRequestedEvents"`;
  const [events]=requestId?await tx<{n:number}[]>`select count(*)::int as n from public.domain_event where tenant_id=${captured.tenantId}::uuid and aggregate_type='profile-change' and aggregate_id=${requestId}::uuid and event_type='profile-change.requested' and actor_type='user' and actor_id=${expected.userId}::uuid and subject_employment_id=${human.employmentId}::uuid`:[];
  return{...totals,matchingRequestedEvents:events?.n??0};
 });}
 async function currentContext(){return client.begin('isolation level read committed read only',async tx=>{
  const [role]=await tx<{name:string;database:string;address:string;port:number;readonly:string;isolation:string;super:boolean;bypass:boolean}[]>`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper as super,rolbypassrls as bypass from pg_roles where rolname=current_user`;
  physical(role,database);if(role.name!=='ai_hr_app'||role.super||role.bypass)return unavailable();
  // SAME maintained local dev principal lookup used by lib/session; no fallback identity or role union.
  const rows=await tx<{tenant_id:string;person_id:string|null;grants:Grant[]|null}[]>`select tenant_id,person_id,grants from app.principal(${expected.userId}::uuid)`;
  if(rows.length!==1||rows[0].tenant_id!==captured.tenantId||rows[0].person_id!==captured.self.personId||!Array.isArray(rows[0].grants)||rows[0].grants.some(g=>!g||typeof g.role!=='string'||g.companyId!==null&&!uuid(g.companyId)))return unavailable();
  const grants=rows[0].grants.map(g=>({...g}));return{tenantId:rows[0].tenant_id,userId:expected.userId,personId:rows[0].person_id,grants,roles:[...new Set(grants.map(g=>g.role))]} satisfies SessionContext;
 });}
 try{await tenantCounts();await currentContext();}catch{return unavailable();}
 return async function verifyProfileNative(value:Invocation){
  const p=structuredClone(value);if(inFlight)return unavailable('concurrent');inFlight=true;
  try{
   if(p.phase!==next||!same(p.expected,expected)||!same(urls().map(u=>u.toString()),configured.map(u=>u.toString())))return unavailable('binding');
   if(p.phase!=='baseline'&&(!uuid(p.actionId)||actionId&&p.actionId!==actionId))return unavailable('action');
   const ctx=await currentContext();
   const own=await withTenant(ctx,async tx=>{
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [mode]=await tx.execute<{readonly:string;isolation:string}>(sql`select current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation`);if(mode.readonly!=='on'||mode.isolation!=='read committed')return unavailable();
    const actor=await readOwnLeaveActorTx(tx,{...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)});if(!actor)return unavailable('actor');assertModuleEnabled(actor,'ess');await assertAiActionUnpausedTx(tx,actor,'hr_assistant');
    // Native freshProfileEditPolicyTx also takes physical FOR SHARE, so reuse its pure canonical
    // setting resolvers under the already-held fresh Access interval without a writable fallback.
    const rawPolicy=getSetting(actor,'ess.profile_change_fields');if(!resolveEssVisibleIds(rawPolicy).has(field.fieldId)||!resolveEssEditableIds(rawPolicy).has(field.fieldId))return unavailable('field');
    const subjects=await myOwnEmploymentSubjectsTx(tx,actor,{profileEdit:true});if(!subjects.some(row=>row.employmentId===human.employmentId&&row.personId===captured.self.personId&&row.currentCompanyId===captured.companyId))return unavailable('own_subject');
    // Exactly the one already-authorized fixture field; no full Person/workspace row or hidden data.
    const [current]=await tx.select({value:s.person.preferredName}).from(s.person).where(and(eq(s.person.tenantId,captured.tenantId),eq(s.person.id,captured.self.personId))).limit(1);if(!current)return unavailable();
    const match=and(eq(s.profileChangeRequest.tenantId,captured.tenantId),eq(s.profileChangeRequest.personId,captured.self.personId),eq(s.profileChangeRequest.employmentId,human.employmentId),sql`${s.profileChangeRequest.proposed}=${JSON.stringify(human.proposal)}::jsonb`);
    const [matching]=await tx.select({n:count()}).from(s.profileChangeRequest).where(match);
    const [request]=await tx.select({id:s.profileChangeRequest.id,employmentId:s.profileChangeRequest.employmentId,status:s.profileChangeRequest.status}).from(s.profileChangeRequest).where(match).limit(1);
    const reference=p.receipt?await readOwnProfileChangeSubmissionReferenceTx(tx,actor,p.receipt.requestId,p.receipt.requestedEventId):null;
    if(p.receipt&&(!reference||reference.requestId!==request?.id||reference.employmentId!==human.employmentId))return unavailable('reference');
    return{currentActorUserId:actor.userId!,currentValue:current.value,matchingRequests:matching.n,request:request??null,reference};
   });
   const totals=await tenantCounts(own.request?.id),facts={...own,counts:{...totals,matchingRequests:own.matchingRequests}};
   if(p.phase==='baseline'||p.phase==='prepared'){
    if(facts.matchingRequests!==0||facts.counts.matchingRequestedEvents!==0||facts.request!==null||facts.reference!==null)return unavailable('effect_before_confirm');
    const observed={totalTenantRequests:totals.totalTenantRequests,totalTenantRequestedEvents:totals.totalTenantRequestedEvents};
    if(p.phase==='baseline'){baseline=observed;originalValue=own.currentValue;if(originalValue===field.value)return unavailable('unchanged_fixture');}
    else if(!same(baseline,observed)||own.currentValue!==originalValue)return unavailable('prepare_effect');
   }else{
    const r=p.receipt;if(!r||r.action!=='ess.profile.request'||r.contractVersion!==1||r.state!=='completed'||r.actionId!==p.actionId||r.employmentId!==human.employmentId||r.semantics!=='submitted_not_approved'||r.currentStatus!=='pending'||!uuid(r.requestId)||!uuid(r.requestedEventId)||receipt&&!same(receipt,r)||facts.reference?.requestId!==r.requestId||facts.reference.requestedEventId!==r.requestedEventId||facts.reference.status!=='pending'||own.currentValue!==originalValue||facts.counts.matchingRequests!==1||facts.counts.matchingRequestedEvents!==1||totals.totalTenantRequests!==baseline!.totalTenantRequests+1||totals.totalTenantRequestedEvents!==baseline!.totalTenantRequestedEvents+1)return unavailable('native_effect');receipt=r;
   }
   if(p.actionId)actionId=p.actionId;next=({baseline:'prepared',prepared:'submitted',submitted:'reopened',reopened:'reopened_again',reopened_again:'complete'} as const)[p.phase];return facts;
  }catch(error){if(error instanceof Error&&/^profile_native_readback:[a-z_]+$/.test(error.message))throw error;return unavailable();}finally{inFlight=false;}
 };
}
