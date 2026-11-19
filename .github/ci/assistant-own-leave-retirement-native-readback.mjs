/** PRIVATE controller-only readback, UNRUN. No pools, effects, decryption, CLI, session injection,
 * environment changes or fixture provisioning. Physical owner reads only bounded aggregates and
 * exact fixture-owned custody metadata; app principal/index owners independently confirm custody. */
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw Error('own_leave_retirement_native_readback:unavailable');};
const phases=['baseline','prepared','discarded','reopened','reopened_again'];
export async function createAiDeliveryOwnLeaveRetirementNativeReadback({root,owner,fixture}){
 if(typeof root!=='string'||!isAbsolute(root)||root.includes('\0')||!owner?.client)return fail();
 const captured=structuredClone({state:fixture?.state,tenantId:fixture?.tenantId,companyId:fixture?.companyId,self:fixture?.actors?.self,leave:fixture?.workforce?.leave,limits:fixture?.limits});
 if(captured.state!=='native_prerequisites_prepared_not_experienced'||captured.limits?.uiTargetEffects!=='not_executed'||![captured.tenantId,captured.companyId,captured.self?.userId,captured.self?.personId,captured.self?.employmentId,captured.leave?.annualTypeId].every(uuid))return fail();
 const load=path=>import(pathToFileURL(join(root,path)).href),require=createRequire(join(root,'package.json')),{sql}=require('drizzle-orm');
 const [{createAiDeliveryOwnLeaveNativeReadback},{client,withTenant},{listOwnLeaveReviewsTx},{readOwnLeaveActorTx},{boundNativeOutcomeTransactionTx}]=await Promise.all([
  load('scripts/fixtures/ai-delivery-own-leave-native-readback.ts'),load('db/client.ts'),load('core/assistant-actions/own-leave-store.ts'),load('core/assistant-actions/own-leave-actor.ts'),load('core/module-native-outcome-bounds.ts')]);
 // Existing owner verifies maintained loopback disposable target, distinct owner/app roles and
 // actual canonical candidate projection; no fallback to writable/source simulation is allowed.
 const original=await createAiDeliveryOwnLeaveNativeReadback({owner,fixture});
 const env=[process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL],appUrl=new URL(env[0]),ownerUrl=new URL(env[1]),database=appUrl.pathname.slice(1),ownerName=decodeURIComponent(ownerUrl.username);
 const expected={userId:captured.self.userId,employmentId:captured.self.employmentId,leaveTypeId:captured.leave.annualTypeId,date:captured.leave.self.date,humanText:{...captured.leave.self.humanText}};
 let position=0,actionId=null,inFlight=false,baseline=null;
 function physical(row,app){if(!row||row.database!==database||!['127.0.0.1','::1'].includes(row.address)||row.port!==5433||row.readonly!=='on'||row.isolation!=='read committed'||row.name!==(app?'ai_hr_app':ownerName)||row.full!==!app)return fail();}
 async function currentCustody(id){
  const ctx=await client.begin('isolation level read committed read only',async tx=>{
   await tx.unsafe("SET LOCAL statement_timeout='5000ms'");await tx.unsafe("SET LOCAL lock_timeout='500ms'");
   const [role]=await tx`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper or rolbypassrls as full from pg_roles where rolname=current_user`;physical(role,true);
   const rows=await tx`select tenant_id,person_id,grants from app.principal(${expected.userId}::uuid)`;
   if(rows.length!==1||rows[0].tenant_id!==captured.tenantId||rows[0].person_id!==captured.self.personId||!Array.isArray(rows[0].grants)||rows[0].grants.some(g=>!g||typeof g.role!=='string'||g.companyId!==null&&!uuid(g.companyId)))return fail();
   const grants=rows[0].grants.map(g=>({...g}));return{tenantId:captured.tenantId,userId:expected.userId,personId:captured.self.personId,grants,roles:[...new Set(grants.map(g=>g.role))]};
  });
  return withTenant(ctx,async tx=>{
   await tx.execute(sql`SET TRANSACTION READ ONLY`);await boundNativeOutcomeTransactionTx(tx);
   if(!await readOwnLeaveActorTx(tx,ctx))return fail();const index=await listOwnLeaveReviewsTx(tx,ctx),rows=id?index.reviews.filter(row=>row.actionId===id):[];
   if(id&&rows.length!==1)return fail();return rows[0]?.state??null;
  });
 }
 async function countsAndBody(id){return owner.client.begin('isolation level read committed read only',async tx=>{
  await tx.unsafe("SET LOCAL statement_timeout='5000ms'");await tx.unsafe("SET LOCAL lock_timeout='500ms'");
  const [role]=await tx`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper or rolbypassrls as full from pg_roles where rolname=current_user`;physical(role,false);
  const [counts]=await tx`select
   (select count(*)::int from public.leave_request where tenant_id=${captured.tenantId}::uuid) as "totalTenantRequests",
   (select count(*)::int from public.domain_event where tenant_id=${captured.tenantId}::uuid and event_type='leave-request.submitted') as "totalTenantSubmissionEvents",
   (select count(*)::int from public.ai_model_run where tenant_id=${captured.tenantId}::uuid) as "totalTenantModelRuns",
   (select count(*)::int from public.leave_request r where r.tenant_id=${captured.tenantId}::uuid and r.employment_id=${expected.employmentId}::uuid and r.leave_type_id=${expected.leaveTypeId}::uuid and r.start_date=${expected.date}::date and r.end_date=${expected.date}::date and r.duration_type='full_day' and r.reason=${expected.humanText.reason} and r.employee_remark=${expected.humanText.employeeRemark}) as "matchingRequests",
   (select count(*)::int from public.domain_event e join public.leave_request r on r.id=e.aggregate_id and r.tenant_id=e.tenant_id where e.tenant_id=${captured.tenantId}::uuid and e.event_type='leave-request.submitted' and e.aggregate_type='leave-request' and r.employment_id=${expected.employmentId}::uuid and r.leave_type_id=${expected.leaveTypeId}::uuid and r.start_date=${expected.date}::date and r.end_date=${expected.date}::date and r.duration_type='full_day' and r.reason=${expected.humanText.reason} and r.employee_remark=${expected.humanText.employeeRemark}) as "matchingSubmissionEvents"`;
  let custody=null;if(id){const rows=await tx`select state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as "bodyCount",intent_digest is not null and reviewed_digest is not null as "digestsPresent",leave_request_id is not null or submission_event_id is not null as "pairedRefsPresent" from app.assistant_own_leave_review r where r.id=${id}::uuid and r.tenant_id=${captured.tenantId}::uuid and r.user_id=${expected.userId}::uuid and r.person_id=${captured.self.personId}::uuid and r.employment_id=${expected.employmentId}::uuid and r.company_id=${captured.companyId}::uuid and r.action_kind='leave.apply'`;if(rows.length!==1)return fail();custody=rows[0];}
  return{counts,custody};
 });}
 return async invocation=>{
  if(inFlight)return fail();inFlight=true;
  try{
   const p=structuredClone(invocation),allowed=p?.phase==='baseline'?['phase','expected']:p?.phase==='prepared'?['phase','expected','actionId','review']:['phase','expected','actionId','receipt'];
   if(!p||!same(Object.keys(p).sort(),allowed.sort())||p.phase!==phases[position]||!same(p.expected,expected)||!same(env,[process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL])||position>0&&(!uuid(p.actionId)||actionId&&p.actionId!==actionId))return fail();
   if(position>=2&&(!p.receipt||!same(Object.keys(p.receipt).sort(),['actionId','contractVersion','state'])||p.receipt.actionId!==actionId||p.receipt.contractVersion!==1||p.receipt.state!=='discarded'))return fail();
   const native=position<2?await original(p):null,state=await currentCustody(p.actionId),actual=await countsAndBody(p.actionId);
   const desired=position===0?null:position===1?'awaiting_confirmation':'discarded';
   if(state!==desired||actual.custody?.state!==desired&&desired!==null||actual.counts.matchingRequests!==0||actual.counts.matchingSubmissionEvents!==0||actual.counts.totalTenantModelRuns!==0||baseline&&!same(actual.counts,baseline))return fail();
   if(desired&&(!actual.custody||actual.custody.bodyCount!==(position===1?1:0)||actual.custody.digestsPresent!==(position===1)||actual.custody.pairedRefsPresent!==false))return fail();
   if(position===0)baseline=actual.counts;if(p.actionId)actionId=p.actionId;position++;
   return{currentActorUserId:expected.userId,counts:actual.counts,request:null,event:null,custody:actual.custody,...(native?.reviewProjection?{reviewProjection:native.reviewProjection}:{})};
  }catch{return fail();}finally{inFlight=false;}
 };
}
