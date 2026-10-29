/** WP11 (R5, S8; ADR-0151 §4.6d): the Assistant learning loop against the LIVE owner
 * (core/module-agent-releases.ts) and migration 0695. Fictional fixtures only; no provider or model.
 *  - a candidate is refused without two independent evaluations;
 *  - a promoter who is also an evaluator is refused;
 *  - a tenant-scoped promotion affects another user of the tenant (and no other tenant);
 *  - a company-scoped promotion respects company isolation;
 *  - a measured outcome regression retires a live promotion through the scheduled agent principal. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {setReportingLine} from '../core/workforce-commands';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {grantAssistant} from '../core/assistant-grant';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {createCanonicalSpecialistCandidate,evaluateCanonicalSpecialistCandidate,promoteCanonicalSpecialistCandidate,runGovernedSpecialistJob,
 recordOwnGovernedJobFeedback,maintainModuleAgentReleases,maintainModuleAgentReleasesAsScheduledAgent} from '../core/module-agent-releases';
import {MODULE_CATALOG} from '../packs/catalog';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person=Readonly<{ctx:SessionContext;employmentId:string;personId:string}>;
let b:Base,a:SessionContext,author:Person,reviewer:Person,second:Person,promoter:Person,manager:{employmentId:string};
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{scope:boolean;covers:boolean}>(sql`select exists(select 1 from information_schema.columns where table_schema='public' and table_name='ai_agent_promotion' and column_name='scope') as scope,to_regprocedure('app.ai_agent_scope_covers_current_user(uuid,text,uuid)') is not null as covers`);expect(installed,'Install migration 0695 through the normal migration owner').toEqual({scope:true,covers:true});});
afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function tenantAdmin(base:Base):Promise<SessionContext>{for(const module of MODULE_CATALOG.filter(row=>!row.isCore))await setModule(base.tenantId,module.code,'active');return{...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]};}
async function person(base:Base,admin:SessionContext,name:string,role:'hr_admin'|'employee',companyId=base.companyId,departmentId=base.deptA):Promise<Person>{
 const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(admin,{appUserId:userId});
 return{employmentId:hired.employmentId,personId:hired.personId,ctx:{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]}};
}
const line=(admin:SessionContext,subordinate:string,managerEmploymentId:string)=>setReportingLine(admin,{subordinateEmploymentId:subordinate,managerEmploymentId,lineType:'functional',validFrom:todayInKualaLumpur()});
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-wp11-learning-loop-key-1234567');await resetDb();b=await seedBase();a=await tenantAdmin(b);
 author=await person(b,a,'Fictional WP11 author','hr_admin');reviewer=await person(b,a,'Fictional WP11 reviewer','hr_admin');second=await person(b,a,'Fictional WP11 second reviewer','hr_admin');
 promoter=await person(b,a,'Fictional WP11 independent promoter','hr_admin');manager=await person(b,a,'Fictional WP11 functional manager','hr_admin');
 for(const row of [author,reviewer,second])await line(a,row.employmentId,manager.employmentId);
});
const create=(signalIds?:string[])=>createCanonicalSpecialistCandidate(author.ctx,{module:'org',version:1,playbook:'canonical_followup_v1',...(signalIds?{signalIds}:{})});
async function evaluated(signalIds?:string[]){const candidate=await create(signalIds);for(const row of [reviewer,second])expect(await evaluateCanonicalSpecialistCandidate(row.ctx,candidate.candidateId)).toMatchObject({state:'complete',securityFailures:0,qualityFailures:0});return candidate;}
async function promotions(){return owner.db.execute<{id:string;scope:string;company_id:string|null;used_jobs:number}>(sql`select id,scope,company_id,used_jobs from public.ai_agent_promotion order by created_at,id`);}
async function consumer(name:string,companyId=b.companyId,departmentId=b.deptA,managerEmployment=manager.employmentId){const row=await person(b,a,name,'employee',companyId,departmentId);await line(a,row.employmentId,managerEmployment);return row;}

describe('WP11 promotion integrity (R5, S8)',()=>{
 it('refuses a candidate without two independent evaluations, including self-evaluation by its author',async()=>{
  const candidate=await create(),promote=()=>promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:2,hours:1});
  await expect(promote()).rejects.toThrow();
  await expect(evaluateCanonicalSpecialistCandidate(author.ctx,candidate.candidateId)).rejects.toThrow();
  await evaluateCanonicalSpecialistCandidate(reviewer.ctx,candidate.candidateId);await expect(promote()).rejects.toThrow();
  expect(Array.from(await promotions())).toEqual([]);
  await evaluateCanonicalSpecialistCandidate(second.ctx,candidate.candidateId);
  expect(await promote()).toMatchObject({module:'org',scope:'user',companyId:null});
 });
 it('refuses a promoter who evaluated the candidate (S8) and the author, and admits an independent approver',async()=>{
  const candidate=await evaluated(),input={candidateId:candidate.candidateId,maxJobs:2,hours:1};
  for(const actor of [reviewer,second,author])await expect(promoteCanonicalSpecialistCandidate(actor.ctx,input)).rejects.toThrow();
  expect(Array.from(await promotions())).toEqual([]);
  const promotion=await promoteCanonicalSpecialistCandidate(promoter.ctx,input);
  const [row]=await owner.db.execute<{approver:string}>(sql`select approver_user_id::text as approver from public.ai_agent_promotion where id=${promotion.promotionId}::uuid`);expect(row.approver).toBe(promoter.ctx.userId);
 });
});

describe('WP11 promotion scope chosen by the approver (R5)',()=>{
 it('a tenant-scoped promotion affects another user of the tenant; a user-scoped one does not, and no other tenant sees it',async()=>{
  const candidate=await evaluated(),other=await consumer('Fictional WP11 other employee');
  const own=await promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:5,hours:1});
  const before=await runGovernedSpecialistJob(other.ctx,{module:'org'},{nonce:randomUUID()});expect(before.mode).toBe('baseline');
  const tenant=await promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:5,hours:1,scope:'tenant'});expect(tenant).toMatchObject({scope:'tenant',companyId:null});
  // The same scope target cannot hold two live promotions of one module.
  await expect(promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:5,hours:1,scope:'tenant'})).rejects.toThrow();
  const after=await runGovernedSpecialistJob(other.ctx,{module:'org'},{nonce:randomUUID()});expect(after.mode).toBe('promoted');
  const [receipt]=await owner.db.execute<{promotion:string}>(sql`select promotion_id::text as promotion from public.ai_agent_job_receipt where id=${after.jobId}::uuid`);expect(receipt.promotion).toBe(tenant.promotionId);
  // The owner keeps the most specific (own) promotion.
  const mine=await runGovernedSpecialistJob(author.ctx,{module:'org'},{nonce:randomUUID()});expect(mine.mode).toBe('promoted');
  const [ownReceipt]=await owner.db.execute<{promotion:string}>(sql`select promotion_id::text as promotion from public.ai_agent_job_receipt where id=${mine.jobId}::uuid`);expect(ownReceipt.promotion).toBe(own.promotionId);
  expect(Array.from(await promotions()).map(row=>[row.scope,row.used_jobs])).toEqual([['user',1],['tenant',1]]);
  // The covered employee reads the shared promotion, never another person's feedback or job custody.
  const seen=await withTenant(other.ctx,tx=>tx.execute<{id:string}>(sql`select id from public.ai_agent_promotion`));expect(Array.from(seen).map(row=>row.id)).toEqual([tenant.promotionId]);
  // Cross-tenant: another tenant's employee is never covered and runs the baseline.
  const foreign=await seedBase(),foreignAdmin=await tenantAdmin(foreign),stranger=await person(foreign,foreignAdmin,'Fictional WP11 foreign employee','employee',foreign.companyId,foreign.deptA);
  const covered=await withTenant(stranger.ctx,async tx=>{const [row]=await tx.execute<{covers:boolean;visible:number}>(sql`select app.ai_agent_scope_covers_current_user(${b.tenantId}::uuid,'tenant',null) as covers,(select count(*)::int from public.ai_agent_promotion) as visible`);return row;});
  expect(covered).toEqual({covers:false,visible:0});
  expect((await runGovernedSpecialistJob(stranger.ctx,{module:'org'},{nonce:randomUUID()})).mode).toBe('baseline');
 });
 it('a company-scoped promotion applies inside that company only and refuses another tenant\'s company',async()=>{
  const candidate=await evaluated(),inside=await consumer('Fictional WP11 company A employee');
  const {id:companyC}=await createCompany(a,{legalName:'Fictional WP11 Company C',country:'MY'}),deptC=await createDepartment(a,{companyId:companyC,name:'Fictional WP11 C department'});
  const managerC=await person(b,a,'Fictional WP11 company C manager','hr_admin',companyC,deptC.id),outside=await consumer('Fictional WP11 company C employee',companyC,deptC.id,managerC.employmentId);
  const foreign=await seedBase();
  await expect(promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:5,hours:1,scope:'company',companyId:foreign.companyId})).rejects.toThrow();
  await expect(promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:5,hours:1,scope:'company'})).rejects.toThrow();
  const promotion=await promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:5,hours:1,scope:'company',companyId:b.companyId});expect(promotion).toMatchObject({scope:'company',companyId:b.companyId});
  expect((await runGovernedSpecialistJob(inside.ctx,{module:'org'},{nonce:randomUUID()})).mode).toBe('promoted');
  expect((await runGovernedSpecialistJob(outside.ctx,{module:'org'},{nonce:randomUUID()})).mode).toBe('baseline');
  const visible=await withTenant(outside.ctx,tx=>tx.execute<{id:string}>(sql`select id from public.ai_agent_promotion`));expect(Array.from(visible)).toEqual([]);
 });
 it('admits a wider scope only for a candidate without personal signal provenance',async()=>{
  const job=await runGovernedSpecialistJob(author.ctx,{module:'org'},{nonce:randomUUID()}),feedback=await recordOwnGovernedJobFeedback(author.ctx,{jobId:job.jobId,outcome:'needs_correction',consented:true});
  const candidate=await evaluated([feedback.feedbackId]);
  for(const scope of ['tenant','company'] as const)await expect(promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:2,hours:1,scope,...(scope==='company'?{companyId:b.companyId}:{})})).rejects.toThrow();
  // The database refuses it too, independently of the owner's check.
  const [source]=await owner.db.execute<{receipt:string}>(sql`select receipt from public.ai_agent_promotion limit 1`);expect(source).toBeUndefined();
  await expect(withTenant(promoter.ctx,tx=>tx.execute(sql`insert into public.ai_agent_promotion(tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,expires_at,scope)
   values(${b.tenantId}::uuid,${candidate.candidateId}::uuid,${author.ctx.userId}::uuid,'org',${promoter.ctx.userId}::uuid,'forged',1,now()+interval '1 hour','tenant')`))).rejects.toThrow();
  expect(await promoteCanonicalSpecialistCandidate(promoter.ctx,{candidateId:candidate.candidateId,maxJobs:2,hours:1})).toMatchObject({scope:'user'});
 });
});

describe('WP11 scheduled maintenance and measured outcome rollback (R5)',()=>{
 const minutesAgo=(n:number)=>new Date(Date.now()-n*60_000);
 async function liveAssistantPromotion(){
  // The measured rule reads only promotion metadata; a sealed receipt is not consulted, so a fictional
  // Assistant-wide promotion (module 'assistant' => every action kind) is inserted on the owner connection.
  const candidateId=randomUUID(),promotionId=randomUUID(),hex=(c:string)=>c.repeat(64);
  await owner.db.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
   values(${candidateId}::uuid,${b.tenantId}::uuid,${author.ctx.userId}::uuid,${author.ctx.userId}::uuid,'assistant',1,'read_plan_prompt_v1','{"kind":"read_plan_prompt_v1","variant":"explicit_scope_v1"}'::jsonb,${hex('a')},${hex('b')},${hex('c')},${hex('d')},${hex('e')},${hex('f')})`);
  await owner.db.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,created_at,expires_at)
   values(${promotionId}::uuid,${b.tenantId}::uuid,${candidateId}::uuid,${author.ctx.userId}::uuid,'assistant',${promoter.ctx.userId}::uuid,'fictional-sealed-receipt',50,now()-interval '1 hour',now()+interval '1 hour')`);
  return promotionId;
 }
 async function outcome(state:'completed'|'discarded',created:Date){
  const id=randomUUID();let leaveRequestId:string|null=null;
  if(state==='completed'){const [row]=await owner.db.insert(s.leaveRequest).values({tenantId:b.tenantId,employmentId:author.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:'2026-01-05',endDate:'2026-01-05',days:'1',status:'approved',createdAt:created,decidedAt:new Date(created.getTime()+60_000)}).returning({id:s.leaveRequest.id});leaveRequestId=row.id;}
  await owner.db.execute(sql`insert into app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,intent_digest,reviewed_digest,state,created_at,expires_at,leave_request_id,submission_event_id,receipt_subject_kind,receipt_subject_id,receipt_event_id)
   values('leave.apply',${id},${b.tenantId},${author.ctx.userId},${author.personId},${author.employmentId},${b.companyId},null,null,${state},${created.toISOString()}::timestamptz,${new Date(created.getTime()+600_000).toISOString()}::timestamptz,${leaveRequestId},${state==='completed'?randomUUID():null},null,null,null)`);
 }
 async function scheduled(){const principalId=await ensureAgentPrincipal(owner.db,b.tenantId);return{principalId,run:()=>maintainModuleAgentReleasesAsScheduledAgent(agentContext(b.tenantId,principalId,a.entitlements!))};}
 it('waits for the minimum measured sample, then retires the live promotion as the scheduled principal on a regression',async()=>{
  const promotionId=await liveAssistantPromotion(),agent=await scheduled();
  for(let n=0;n<10;n++)await outcome('completed',minutesAgo(90));   // before: 0 of 10 unsuccessful
  for(let n=0;n<6;n++)await outcome('discarded',minutesAgo(30));    // during: 6 settled < minimum 10
  expect(await agent.run()).toEqual({retired:0,outcomeRegressed:0});
  for(let n=0;n<6;n++)await outcome('completed',minutesAgo(20));    // during: 6 of 12 unsuccessful = +50 points
  expect(await agent.run()).toEqual({retired:1,outcomeRegressed:1});
  const [row]=await owner.db.execute<{reason:string;user:string|null;agent:string|null}>(sql`select reason,actor_user_id::text as user,actor_agent_principal_id::text as agent from public.ai_agent_rollback where promotion_id=${promotionId}::uuid`);
  expect(row).toEqual({reason:'outcome_regression',user:null,agent:agent.principalId});
  // Idempotent: a re-run retires nothing more.
  expect(await agent.run()).toEqual({retired:0,outcomeRegressed:0});
 });
 it('keeps a promotion whose measured outcomes did not regress, and the administrator path agrees',async()=>{
  await liveAssistantPromotion();const agent=await scheduled();
  for(let n=0;n<10;n++)await outcome('completed',minutesAgo(90));
  for(let n=0;n<11;n++)await outcome('completed',minutesAgo(30));
  await outcome('discarded',minutesAgo(25));                        // during: 1 of 12 = +8 points < 20
  expect(await agent.run()).toEqual({retired:0,outcomeRegressed:0});
  expect(await maintainModuleAgentReleases(promoter.ctx)).toEqual({retired:0,outcomeRegressed:0});
 });
 it('the scheduled principal can retire but cannot read feedback, jobs or provenance, and a login cannot pose as it',async()=>{
  const agent=await scheduled(),ctx=agentContext(b.tenantId,agent.principalId,a.entitlements!);
  const counts=await withTenant(ctx,async tx=>{const [row]=await tx.execute<{feedback:number;jobs:number;provenance:number}>(sql`select (select count(*)::int from public.ai_agent_job_feedback) as feedback,(select count(*)::int from public.ai_agent_job_receipt) as jobs,(select count(*)::int from public.ai_agent_candidate_provenance) as provenance`);return row;});
  await runGovernedSpecialistJob(author.ctx,{module:'org'},{nonce:randomUUID()});
  expect(counts).toEqual({feedback:0,jobs:0,provenance:0});
  const after=await withTenant(ctx,async tx=>{const [row]=await tx.execute<{jobs:number}>(sql`select count(*)::int as jobs from public.ai_agent_job_receipt`);return row.jobs;});expect(after).toBe(0);
  await expect(maintainModuleAgentReleasesAsScheduledAgent({...author.ctx,agent:{principalId:agent.principalId,enablements:[]}})).rejects.toThrow();
 });
});
