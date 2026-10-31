/** Authored UNRUN. These are deliberately synthetic custody/FK fixtures, not canonical job,
 * consent, evaluation, promotion, encryption or provider-execution proof. No live provider used.
 */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {retireExpiredAiCustodyTx} from '../core/ai-retention-maintenance';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base,version=0;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();version=0;await hireEmployee(adminCtx(base),{person:{fullName:'Fictional preserved retention employment',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});});
const iso=(offset:number)=>new Date(Date.now()+offset).toISOString();
const day=86400000;
async function candidate(){const id=randomUUID(),promotionId=randomUUID(),digest='a'.repeat(64);await owner.db.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
 values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${base.adminUserId}::uuid,'assistant',${++version},'read_plan_prompt_v1','{"kind":"read_plan_prompt_v1","variant":"concise_v1"}'::jsonb,${digest},${digest},${digest},${digest},${digest},${digest})`);
 await owner.db.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,expires_at)
 values(${promotionId}::uuid,${base.tenantId}::uuid,${id}::uuid,${base.adminUserId}::uuid,'assistant',${base.adminUserId}::uuid,'synthetic-custody-promotion-not-execution-proof',10,now()+interval '1 hour')`);return {id,promotionId};}
async function job(expired:boolean,v1=false){const now=Date.now(),id=randomUUID(),created=new Date(now+(expired?-31*day:-day)).toISOString(),expires=new Date(now+(expired?-day:29*day)).toISOString(),nonce=v1?null:randomUUID();await owner.db.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,request_nonce,requested_plan_digest,expires_at,receipt,created_at)
 values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${nonce}::uuid,${v1?null:'b'.repeat(64)},${v1?null:expires}::timestamptz,'synthetic-job-custody-not-canonical-proof',${created}::timestamptz)`);return id;}
async function feedback(jobId:string,expired:boolean){const now=Date.now(),id=randomUUID(),created=new Date(now+(expired?-31*day:-day)).toISOString(),expires=new Date(now+(expired?-day:day)).toISOString();await owner.db.execute(sql`insert into public.ai_agent_job_feedback(id,tenant_id,user_id,job_id,outcome,consented,receipt,created_at,expires_at)
 values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${jobId}::uuid,'incorrect',true,'synthetic-feedback-custody-not-evaluation-truth',${created}::timestamptz,${expires}::timestamptz)`);return id;}
async function provenance(candidateId:string,expired:boolean){await owner.db.execute(sql`insert into public.ai_agent_candidate_provenance(candidate_id,tenant_id,owner_user_id,refs,receipt,created_at)
 values(${candidateId}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,'[]'::jsonb,'synthetic-provenance-custody-not-authentic-signal-binding',${iso(expired?-31*day:-day)}::timestamptz)`);return candidateId;}
async function plan(promotionId:string,expired:boolean,consumedJobId:string|null=null){const now=Date.now(),id=randomUUID(),created=new Date(now+(expired?-16*60000:0)).toISOString(),expires=new Date(now+(expired?-60000:15*60000)).toISOString();await owner.db.execute(sql`insert into public.ai_agent_plan_proposal(id,tenant_id,user_id,request_nonce,promotion_id,state,receipt,created_at,expires_at,consumed_job_id)
 values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${randomUUID()}::uuid,${promotionId}::uuid,'ready','synthetic-plan-custody-no-question-or-provider-text',${created}::timestamptz,${expires}::timestamptz,${consumedJobId}::uuid)`);return id;}
async function fixture(){const old=await candidate(),fresh=await candidate(),expiredV1=await job(true,true),activeV1=await job(false,true),expiredV2=await job(true),activeV2=await job(false);
 return {expiredV1,activeV1,expiredV2,activeV2,expiredFeedback:await feedback(expiredV2,true),activeFeedback:await feedback(activeV2,false),expiredProvenance:await provenance(old.id,true),activeProvenance:await provenance(fresh.id,false),expiredPlan:await plan(old.promotionId,true,expiredV2),activePlan:await plan(fresh.promotionId,false,activeV2),candidateIds:[old.id,fresh.id]};}
const custody=async()=>({jobs:await owner.db.execute(sql`select * from public.ai_agent_job_receipt order by id`),feedback:await owner.db.execute(sql`select * from public.ai_agent_job_feedback order by id`),provenance:await owner.db.execute(sql`select * from public.ai_agent_candidate_provenance order by candidate_id`),plans:await owner.db.execute(sql`select * from public.ai_agent_plan_proposal order by id`),candidates:await owner.db.execute(sql`select * from public.ai_agent_candidate order by id`),promotions:await owner.db.execute(sql`select * from public.ai_agent_promotion order by id`)});
const hr=async()=>({employment:await owner.db.select().from(schema.employment).orderBy(schema.employment.id),assignments:await owner.db.select().from(schema.assignment).orderBy(schema.assignment.id),requests:await owner.db.select().from(schema.leaveRequest).orderBy(schema.leaveRequest.id),ledger:await owner.db.select().from(schema.leaveLedger).orderBy(schema.leaveLedger.id),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,base.tenantId)).orderBy(schema.domainEvent.id)});
const zero={reviews:0,feedback:0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0};
describe('physical-owner retention of extended AI custody',()=>{
 it('removes expired v1 fallback/v2 jobs and expired graph children first, preserving every active row and all HR facts/events',async()=>{const ids=await fixture(),before=await custody(),facts=await hr(),result=await runAiRetentionTick(owner);expect(result).toEqual({...zero,tenants:1,busy:0,jobs:2,jobFeedback:1,candidateProvenance:1,plans:1,backlog:false,oldestExpiredAgeSeconds:null});
  const after=await custody();expect(after.jobs).toEqual(before.jobs.filter(row=>[ids.activeV1,ids.activeV2].some(id=>id===row.id)));expect(after.feedback).toEqual(before.feedback.filter(row=>row.id===ids.activeFeedback));expect(after.provenance).toEqual(before.provenance.filter(row=>row.candidate_id===ids.activeProvenance));expect(after.plans).toEqual(before.plans.filter(row=>row.id===ids.activePlan));expect(after.candidates).toEqual(before.candidates);expect(after.promotions).toEqual(before.promotions);expect(await hr()).toEqual(facts);
  for(const id of [base.tenantId,...Object.values(ids).flat()])expect(JSON.stringify(result)).not.toContain(id);expect(await runAiRetentionTick(owner)).toEqual({...zero,tenants:0,busy:0,backlog:false,oldestExpiredAgeSeconds:null});
 });
 it('rejects an actual app-role transaction despite administrator claims and rolls all extended custody back',async()=>{await fixture();const before=await custody(),facts=await hr();await expect(withTenant(adminCtx(base),tx=>retireExpiredAiCustodyTx(tx))).rejects.toThrow('AI retention maintenance could not be confirmed');expect(await custody()).toEqual(before);expect(await hr()).toEqual(facts);});
 it('counts direct deletion separately from declared child cascades in deliberately inconsistent synthetic lifetime fixtures',async()=>{const c=await candidate(),expired=await job(true),active=await job(false),cascadedFeedback=await feedback(expired,false),cascadedPlan=await plan(c.promotionId,false,expired);await feedback(active,false);await plan(c.promotionId,false,active);const facts=await hr();const result=await runAiRetentionTick(owner);
  // SQL permits this synthetic active-child/expired-parent graph; normal feedback source caps expiry
  // to its job, and normal proposals outlive no30-day job. Parent FK deletion retires these metadata
  // children too. Result fields count direct bounded rows only, never pretend to count the cascade.
  expect(result).toEqual({...zero,tenants:1,busy:0,jobs:1,backlog:false,oldestExpiredAgeSeconds:null});const after=await custody();expect(after.jobs.map(row=>row.id)).toEqual([active]);expect(after.feedback.some(row=>row.id===cascadedFeedback)).toBe(false);expect(after.plans.some(row=>row.id===cascadedPlan)).toBe(false);expect(after.feedback).toHaveLength(1);expect(after.plans).toHaveLength(1);expect(await hr()).toEqual(facts);
 });
 it('rolls every direct and cascaded retirement back when the actual owner transaction fails',async()=>{await fixture();const before=await custody(),facts=await hr();await expect(owner.db.transaction(async tx=>{await retireExpiredAiCustodyTx(tx as unknown as Tx);throw Error('synthetic extended retention rollback');})).rejects.toThrow('synthetic extended retention rollback');expect(await custody()).toEqual(before);expect(await hr()).toEqual(facts);});
 it('does not let an unrelated SQL login invoke the helper even after copying a real administrator GUC snapshot',async()=>{const jobId=await job(false),name='ai_untrusted_retention_'+randomUUID().replaceAll('-',''),role=sql.identifier(name);await expect(owner.db.transaction(async tx=>{
  await tx.execute(sql`create role ${role} nologin nosuperuser nobypassrls`);await tx.execute(sql`grant usage on schema app,public to ${role}`);await tx.execute(sql`set local session authorization ${role}`);
  await tx.execute(sql`select set_config('app.tenant_id',${base.tenantId},true),set_config('app.user_id',${base.adminUserId},true),set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true)`);
  const [permission]=await tx.execute<{allowed:boolean}>(sql`select has_function_privilege(current_user,'app.agent_signal_custody_visible(text,uuid,uuid,uuid)','EXECUTE') as allowed`);expect(permission.allowed).toBe(false);
  await tx.execute(sql`savepoint helper_execute_refusal`);const refused=await tx.execute(sql`select app.agent_signal_custody_visible('job',${jobId}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid)`).then(()=>null,(error:unknown)=>error);
  let cause:unknown=refused,code:unknown;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){const detail=cause as {code?:unknown;cause?:unknown};if(detail.code!==undefined){code=detail.code;break;}cause=detail.cause;}expect(code).toBe('42501');await tx.execute(sql`rollback to savepoint helper_execute_refusal`);throw Error('untrusted SQL role fixture rollback');
 })).rejects.toThrow('untrusted SQL role fixture rollback');const [left]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from pg_roles where rolname=${name}`);expect(left.n).toBe(0);});
 it('uses a genuine nonsuperuser complete custody owner/session, with no app principal or active-custody visibility',async()=>{await fixture();const before=await custody(),roleName='ai_extended_retention_'+randomUUID().replaceAll('-',''),role=sql.identifier(roleName);
  const payrollCapabilityMetadata=async()=>Array.from(await owner.db.execute(sql`select p.oid,p.proowner,p.proacl::text from pg_proc p where p.oid in ('app._payroll_completion_shape(jsonb,text,text)'::regprocedure,'app._payroll_completion_uuid_array(jsonb)'::regprocedure) order by p.oid`));
  const payrollBefore=await payrollCapabilityMetadata();
  await expect(owner.db.transaction(async tx=>{
   await tx.execute(sql`create role ${role} nologin nosuperuser nobypassrls`);await tx.execute(sql`grant usage on schema app,public to ${role}`);
   await tx.execute(sql`grant execute on function app.current_user_id(),app.current_tenant_id(),app.is_group_admin(),app.principal_snapshot_current() to ${role}`);
   // Narrow dependency of PUBLIC policy expressions; no app membership or candidate SELECT.
   await tx.execute(sql`grant execute on function app.agent_signal_custody_visible(text,uuid,uuid,uuid) to ${role}`);
   // 0650 PUBLIC policies on the FORCE-RLS job receipt and native association tables call this helper;
   // PostgreSQL checks EXECUTE when the policy expression is initialized, even where an earlier conjunct is false.
   await tx.execute(sql`grant execute on function app.agent_native_signal_custody_visible(text,uuid,uuid,uuid) to ${role}`);
   // Same narrow PUBLIC-policy dependencies for conversation metadata and transcript-linked feedback/markers.
   await tx.execute(sql`grant execute on function app._answer_metadata_erasure_authorized(uuid,uuid,uuid),app.assistant_transcript_retirement_visible(uuid,uuid) to ${role}`);
   // The global review CHECK needs only this outer pure predicate. Do not transfer its owner,
   // grant its nested Payroll helpers, or lend this capability to PUBLIC/the application role.
   const [beforeGrant]=await tx.execute<{allowed:boolean}>(sql`select has_function_privilege(${roleName},'app._payroll_completion_shape(jsonb,text,text)','EXECUTE') as allowed`);expect(beforeGrant.allowed).toBe(false);
   await tx.execute(sql`grant execute on function app._payroll_completion_shape(jsonb,text,text) to ${role}`);
   // Complete derived inventory: conversation metadata, raw transcript content and its owner helper.
   for(const table of ['public.ai_assistant_answer_evaluation_arm','public.ai_assistant_answer_strategy_use','public.ai_assistant_answer_evaluation_intent','public.assistant_exchange','app.assistant_transcript_identity','app.assistant_transcript_retirement_scope'])await tx.execute(sql`alter table ${sql.raw(table)} owner to ${role}`);
   for(const fn of ['app.assistant_transcripts_retire_expired(uuid,integer,integer)','app._assistant_transcripts_retire(uuid,uuid[],boolean)','app._assistant_transcript_bounds()'])await tx.execute(sql`alter function ${sql.raw(fn)} owner to ${role}`);
   await tx.execute(sql`alter table app.assistant_own_leave_review owner to ${role}`);await tx.execute(sql`alter table app.assistant_own_leave_review_content owner to ${role}`);await tx.execute(sql`alter table public.ai_agent_feedback owner to ${role}`);await tx.execute(sql`alter table public.ai_agent_job_receipt owner to ${role}`);await tx.execute(sql`alter table public.ai_agent_job_feedback owner to ${role}`);await tx.execute(sql`alter table public.ai_agent_candidate_provenance owner to ${role}`);await tx.execute(sql`alter table public.ai_agent_plan_proposal owner to ${role}`);await tx.execute(sql`alter table public.personnel_import_assistance_attempt owner to ${role}`);await tx.execute(sql`alter table public.employee_import_evaluation_attempt owner to ${role}`);await tx.execute(sql`alter table public.employee_import_evaluation_run_membership owner to ${role}`);
   await tx.execute(sql`alter table public.ai_native_outcome_association owner to ${role}`);await tx.execute(sql`alter table app.native_outcome_source_capture owner to ${role}`);await tx.execute(sql`alter table app.native_outcome_source_target owner to ${role}`);
   await tx.execute(sql`set local session authorization ${role}`);const [identity]=await tx.execute<{role:string;session:string;superuser:boolean;bypass:boolean;principal:string|null;tenant:string|null}>(sql`select current_user as role,session_user as session,r.rolsuper as superuser,r.rolbypassrls as bypass,app.current_user_id()::text as principal,app.current_tenant_id()::text as tenant from pg_roles r where r.rolname=current_user`);expect(identity).toEqual({role:roleName,session:roleName,superuser:false,bypass:false,principal:null,tenant:null});
   const [capability]=await tx.execute<{outer:boolean;grant_option:boolean;nested:boolean;owner_unchanged:boolean;app:boolean;public:boolean;child:boolean}>(sql`select
    has_function_privilege(current_user,p.oid,'EXECUTE') as "outer",
    has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') as grant_option,
    has_function_privilege(current_user,'app._payroll_completion_uuid_array(jsonb)','EXECUTE') as nested,
    p.proowner<>(select oid from pg_roles where rolname=current_user) as owner_unchanged,
    has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as "public",
    has_function_privilege('ai_hr_draft_discard_port',p.oid,'EXECUTE') as child
    from pg_proc p where p.oid='app._payroll_completion_shape(jsonb,text,text)'::regprocedure`);
   expect(capability).toEqual({outer:true,grant_option:false,nested:false,owner_unchanged:true,app:false,public:false,child:true});
   const [visible]=await tx.execute<{jobs:number;feedback:number;provenance:number;plans:number}>(sql`select (select count(*)::int from public.ai_agent_job_receipt) as jobs,(select count(*)::int from public.ai_agent_job_feedback) as feedback,(select count(*)::int from public.ai_agent_candidate_provenance) as provenance,(select count(*)::int from public.ai_agent_plan_proposal) as plans`);expect(visible).toEqual({jobs:2,feedback:1,provenance:1,plans:1});
   await tx.execute(sql`savepoint extended_owner_update_refusal`);await expect(tx.execute(sql`update public.ai_agent_job_feedback set outcome='helpful' where expires_at<=now()`)).rejects.toThrow();await tx.execute(sql`rollback to savepoint extended_owner_update_refusal`);
   const result=await retireExpiredAiCustodyTx(tx as unknown as Tx);expect(result).toEqual({...zero,tenants:1,busy:0,jobs:2,jobFeedback:1,candidateProvenance:1,plans:1});const [left]=await tx.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_job_receipt`);expect(left.n).toBe(0);throw Error('synthetic physical owner rollback');
  })).rejects.toThrow('synthetic physical owner rollback');expect(await payrollCapabilityMetadata()).toEqual(payrollBefore);expect(await custody()).toEqual(before);const [left]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from pg_roles where rolname=${roleName}`);expect(left.n).toBe(0);
 });
});
