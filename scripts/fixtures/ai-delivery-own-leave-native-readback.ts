/** Import-safe PRIVATE readback for the real UI journey. No CLI, effect, review-body decryption,
 * session injection, environment mutation, provider call or permission grant. Parent owns target,
 * complete admission and real selected-cookie browser authentication. No pools are created/closed.
 *
 * Native actor/candidate owners require READ COMMITTED. Use the existing withTenant suspension
 * mechanism: FIRST callback statement SET TRANSACTION READ ONLY, before any authority/business read.
 * Never fall back to writable or relax isolation. Runtime readonly/canonical compatibility is UNRUN.
 */
import {and,count,eq,sql} from 'drizzle-orm';
import {client,withTenant,type createDb,type Grant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {resolveEntitlementsTx} from '../../core/entitlements';
import {readOwnLeaveActorTx} from '../../core/assistant-actions/own-leave-actor';
import {readOwnLeaveCandidateTx} from '../../core/assistant-actions/own-leave-candidate';
import {readOwnLeaveSubmissionReferenceTx} from '../../core/read';
import {assertAiActionUnpausedTx} from '../../core/ai-governance';
import type {populateAiDeliveryFullFixture} from './ai-delivery-full-fixture';
type Fixture=Awaited<ReturnType<typeof populateAiDeliveryFullFixture>>;
type Expected={userId:string;employmentId:string;leaveTypeId:string;date:string;humanText:{reason:string;employeeRemark:string}};
type Receipt={actionId:string;contractVersion:1;state:'completed';leaveRequestId:string;submissionEventId:string};
type Invocation={phase:'baseline'|'prepared'|'submitted'|'reopened'|'reopened_again';expected:Expected;actionId?:string;receipt?:Receipt;review?:unknown};
const unavailable=(code='unavailable'):never=>{throw Error('own_leave_native_readback:'+code);};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function urls(){
 const values=[process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL].map(value=>{let u:URL;try{u=new URL(value??'');}catch{return unavailable();}const db=u.pathname.slice(1);if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.port!=='5433'||!(db==='aihr_ai_delivery_browser_v3_20261027'||/^aihr_assistant_browser_[a-f0-9]{16}$/.test(db))||u.hash||[...u.searchParams].some(([key,value])=>key!=='sslmode'||value!=='disable'))return unavailable();return u;});
 if(values[0].pathname!==values[1].pathname||decodeURIComponent(values[0].username)!=='ai_hr_app'||values[0].username===values[1].username)return unavailable();return values;
}
function physical(row:{database:string;address:string;port:number;readonly:string;isolation:string},database:string){if(row.database!==database||!['127.0.0.1','::1'].includes(row.address)||row.port!==5433||row.readonly!=='on'||row.isolation!=='read committed')return unavailable();}
/** Callback facts contain private native IDs/human text. Only the separate browser module's bounded
 * check list may go to a public report. Supply the already-owned schema connection; never a new URL. */
export async function createAiDeliveryOwnLeaveNativeReadback({owner,fixture}:{owner:ReturnType<typeof createDb>;fixture:Fixture}){
 const captured=structuredClone({state:fixture.state,tenantId:fixture.tenantId,companyId:fixture.companyId,self:fixture.actors.self,leave:fixture.workforce.leave,baseline:fixture.expectedNative});
 if(captured.state!=='native_prerequisites_prepared_not_experienced'||![captured.tenantId,captured.companyId,captured.self.userId,captured.self.personId,captured.self.employmentId,captured.leave.annualTypeId].every(uuid))return unavailable();
 const expected:Expected={userId:captured.self.userId,employmentId:captured.self.employmentId,leaveTypeId:captured.leave.annualTypeId,date:captured.leave.self.date,humanText:{...captured.leave.self.humanText}};
 const configured=urls(),database=configured[0].pathname.slice(1),ownerName=decodeURIComponent(configured[1].username);let baseline:{totalTenantRequests:number;totalTenantSubmissionEvents:number}|undefined,actionId:string|undefined,completedReceipt:Receipt|undefined,nextPhase:Invocation['phase']|'complete'='baseline',inFlight=false;
 async function tenantCounts(requestId?:string){return owner.client.begin('isolation level read committed read only',async tx=>{
  const [role]=await tx<{name:string;database:string;address:string;port:number;readonly:string;isolation:string;full:boolean}[]>`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper or rolbypassrls as full from pg_roles where rolname=current_user`;
  physical(role,database);if(role.name!==ownerName||role.name==='ai_hr_app'||role.full!==true)return unavailable();
  // Owner reads are AGGREGATES ONLY, strictly this fixture tenant; never private custody/HR rows.
  const [n]=await tx<{requests:number;events:number}[]>`select (select count(*)::int from public.leave_request where tenant_id=${captured.tenantId}::uuid) as requests,(select count(*)::int from public.domain_event where tenant_id=${captured.tenantId}::uuid and event_type='leave-request.submitted') as events`;
  const [matching]=requestId?await tx<{n:number}[]>`select count(*)::int as n from public.domain_event where tenant_id=${captured.tenantId}::uuid and aggregate_type='leave-request' and aggregate_id=${requestId}::uuid and actor_type='user' and actor_id=${expected.userId}::uuid and subject_employment_id=${expected.employmentId}::uuid and event_type='leave-request.submitted'`:[];
  return{totalTenantRequests:n.requests,totalTenantSubmissionEvents:n.events,matchingSubmissionEvents:matching?.n??0};
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
 return async function verifyOwnLeaveNative(value:Invocation){
  const p=structuredClone(value);if(inFlight)return unavailable('concurrent_readback');inFlight=true;
  try{
   if(p.phase!==nextPhase||!['baseline','prepared','submitted','reopened','reopened_again'].includes(p.phase)||!same(p.expected,expected)||!same(urls().map(u=>u.toString()),configured.map(u=>u.toString())))return unavailable();
   if(p.phase!=='baseline'&&!baseline||p.phase==='baseline'&&baseline)return unavailable('phase_order');
   if(p.phase!=='baseline'&&(!uuid(p.actionId)||actionId&&p.actionId!==actionId))return unavailable('action_binding');
   if(['submitted','reopened','reopened_again'].includes(p.phase)&&(!p.receipt||p.receipt.state!=='completed'||p.receipt.contractVersion!==1||p.receipt.actionId!==p.actionId||!uuid(p.receipt.leaveRequestId)||!uuid(p.receipt.submissionEventId)))return unavailable('receipt_binding');
   const ctx=await currentContext();
   const own=await withTenant(ctx,async tx=>{
    // MUST remain first callback statement, matching db/client.ts's established readonly mechanism.
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [mode]=await tx.execute<{readonly:string;isolation:string;app:string;super:boolean;bypass:boolean}>(sql`select current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,current_user as app,rolsuper as super,rolbypassrls as bypass from pg_roles where rolname=current_user`);
    if(mode.readonly!=='on'||mode.isolation!=='read committed'||mode.app!=='ai_hr_app'||mode.super||mode.bypass)return unavailable();
    const refreshed:SessionContext={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)},actor=await readOwnLeaveActorTx(tx,refreshed);if(!actor)return unavailable('current_actor_refused');await assertAiActionUnpausedTx(tx,actor,'hr_assistant');
    const [subject]=await tx.select({id:s.employment.id,personId:s.employment.personId,companyId:s.employment.companyId}).from(s.employment).where(and(eq(s.employment.tenantId,captured.tenantId),eq(s.employment.id,expected.employmentId),eq(s.employment.personId,captured.self.personId))).limit(1);if(subject?.companyId!==captured.companyId)return unavailable();
    const match=and(eq(s.leaveRequest.tenantId,captured.tenantId),eq(s.leaveRequest.employmentId,expected.employmentId),eq(s.leaveRequest.leaveTypeId,expected.leaveTypeId),eq(s.leaveRequest.startDate,expected.date),eq(s.leaveRequest.endDate,expected.date),eq(s.leaveRequest.durationType,'full_day'),eq(s.leaveRequest.reason,expected.humanText.reason),eq(s.leaveRequest.employeeRemark,expected.humanText.employeeRemark));
    const [requests]=await tx.select({n:count()}).from(s.leaveRequest).where(match);if(requests.n>1)return unavailable('multiple_matching_requests');
    const [request]=await tx.select({id:s.leaveRequest.id,employmentId:s.leaveRequest.employmentId,leaveTypeId:s.leaveRequest.leaveTypeId,startDate:s.leaveRequest.startDate,endDate:s.leaveRequest.endDate,durationType:s.leaveRequest.durationType,days:s.leaveRequest.days,reason:s.leaveRequest.reason,employeeRemark:s.leaveRequest.employeeRemark,status:s.leaveRequest.status}).from(s.leaveRequest).where(match).limit(1);
    // Exact native reference reader owns event visibility/provenance; never treat audit-table
    // RLS hiding as absence, and never project an event row through the schema owner.
    const source=p.receipt?await readOwnLeaveSubmissionReferenceTx(tx,actor,p.receipt.leaveRequestId,p.receipt.submissionEventId):null;
    if(p.receipt&&(!source||source.request.id!==request?.id||source.request.personId!==captured.self.personId||source.request.companyId!==captured.companyId))return unavailable('canonical_submission_reference_refused');
    const event=source?.event??null;
    let reviewProjection;
    if(p.phase==='prepared'){
     const candidate=await readOwnLeaveCandidateTx(tx,actor,{action:'leave.apply',contractVersion:1,employmentId:expected.employmentId,leaveTypeId:expected.leaveTypeId,date:expected.date,durationType:'full_day'},{employmentId:expected.employmentId,leaveTypeId:expected.leaveTypeId},expected.humanText,'en');
     if(candidate.kind!=='candidate')return unavailable('prepared_source_refused_readonly');const c=candidate.candidate;
     reviewProjection={companyName:c.companyName,employeeCode:c.employeeCode,leaveTypeName:c.leaveTypeName,date:c.nomination.date,durationType:c.nomination.durationType,deductionDays:c.deductionDays,availableBalance:c.availableBalance,estimatedAvailableAfter:c.estimatedAvailableAfter,humanText:c.humanText,holidayWarnings:c.holidayWarnings,approvalRouting:c.approvalRouting};
    }
    return{currentActorUserId:actor.userId!,matchingRequests:requests.n,request:request?{...request,days:Number(request.days)}:null,event:event??null,...(reviewProjection?{reviewProjection}:{})};
   });
   const counted=await tenantCounts(own.request?.id),totals={totalTenantRequests:counted.totalTenantRequests,totalTenantSubmissionEvents:counted.totalTenantSubmissionEvents},facts={currentActorUserId:own.currentActorUserId,counts:{...totals,matchingRequests:own.matchingRequests,matchingSubmissionEvents:counted.matchingSubmissionEvents},request:own.request,event:own.event,...('reviewProjection'in own?{reviewProjection:own.reviewProjection}:{})};
   if(p.phase==='baseline'||p.phase==='prepared'){
    if(facts.counts.matchingRequests!==0||facts.counts.matchingSubmissionEvents!==0||facts.request!==null||facts.event!==null)return unavailable('effect_before_confirm');
    if(p.phase==='baseline'){if(totals.totalTenantRequests!==captured.baseline.baselineLeaveRequests||totals.totalTenantSubmissionEvents!==captured.baseline.baselineSubmittedEvents)return unavailable('fixture_changed');baseline=totals;}else if(!same(totals,baseline))return unavailable('prepare_changed_counts');
   }else{
    if(!p.receipt||p.receipt.state!=='completed'||p.receipt.contractVersion!==1||p.receipt.actionId!==p.actionId||!uuid(p.receipt.leaveRequestId)||!uuid(p.receipt.submissionEventId)||completedReceipt&&Object.keys(completedReceipt).some(key=>p.receipt![key as keyof Receipt]!==completedReceipt![key as keyof Receipt])||facts.request?.id!==p.receipt.leaveRequestId||facts.event?.id!==p.receipt.submissionEventId||facts.request.status!=='pending'||!Number.isFinite(facts.request.days)||facts.request.days!==captured.leave.self.deductionDays||facts.counts.matchingRequests!==1||facts.counts.matchingSubmissionEvents!==1||totals.totalTenantRequests!==baseline!.totalTenantRequests+1||totals.totalTenantSubmissionEvents!==baseline!.totalTenantSubmissionEvents+1)return unavailable('native_effect_mismatch');
    completedReceipt=p.receipt;
   }
   if(p.actionId)actionId=p.actionId;nextPhase=({baseline:'prepared',prepared:'submitted',submitted:'reopened',reopened:'reopened_again',reopened_again:'complete'} as const)[p.phase];return facts;
  }catch(error){if(error instanceof Error&&/^own_leave_native_readback:[a-z_]+$/.test(error.message))throw error;return unavailable();}finally{inFlight=false;}
 };
}
