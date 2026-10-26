/** Actual durable routing-candidate lifecycle. Authored UNRUN; requires coordinated drafts. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { grantAssistant } from '../core/assistant-grant';
import { AGENT_MODULE_CODES } from '../lib/ai/module-agents';
import { createRoutingAgentCandidate,evaluateRoutingAgentCandidate,promoteRoutingAgentCandidate,
 rollbackRoutingAgent,runGovernedModuleReadPlan,maintainModuleAgentReleases } from '../core/module-agent-releases';
import { adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base } from './harness';
let base:Base,oldSecret:string|undefined;
beforeAll(async()=>{oldSecret=process.env.AI_CONFIG_SECRET;process.env.AI_CONFIG_SECRET='fictional-agent-receipt-unit-passphrase';await migrateTestDb();});
afterAll(async()=>{if(oldSecret===undefined)delete process.env.AI_CONFIG_SECRET;else process.env.AI_CONFIG_SECRET=oldSecret;await closeAll();});
beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function actors(){
 const admin=adminCtx(base);const make=async(name:string)=>{
  const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,
   departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(base.tenantId,hired.personId,'hr_admin');await grantAssistant(admin,{appUserId:userId});
  return {...await entitledCtx(base,['hr_admin']),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;
 };
 return {author:await make('Fictional Candidate Author'),reviewer:await make('Fictional Independent Reviewer'),second:await make('Fictional Second Reviewer')};
}
const configuration=()=>({kind:'typed_route_priority_v1',priority:[...AGENT_MODULE_CODES].reverse()});
async function verified(){const a=await actors();const candidate=await createRoutingAgentCandidate(a.author,{version:1,configuration:configuration()});
 const first=await evaluateRoutingAgentCandidate(a.reviewer,candidate.candidateId),second=await evaluateRoutingAgentCandidate(a.second,candidate.candidateId);
 expect(first).toMatchObject({state:'passed-contract',coverage:'typed-routing-contract-only',securityFailures:0,qualityFailures:0});
 expect(second.state).toBe('passed-contract');return {...a,candidate};}
describe('durable non-vacuous independent routing evaluation',()=>{
 it('requires real distinct evaluators and authentic evidence, never a posted model score',async()=>{
  const a=await actors(),candidate=await createRoutingAgentCandidate(a.author,{version:1,configuration:configuration()});
  await expect(evaluateRoutingAgentCandidate(a.author,candidate.candidateId)).rejects.toThrow();
  await expect(promoteRoutingAgentCandidate(a.reviewer,{candidateId:candidate.candidateId,maxJobs:2,hours:1})).rejects.toThrow();
  await owner.db.execute(sql`insert into public.ai_agent_evaluation(tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt)
   values(${base.tenantId}::uuid,${candidate.candidateId}::uuid,${a.reviewer.userId}::uuid,${'a'.repeat(64)},'posted-model-pass')`);
  await expect(promoteRoutingAgentCandidate(a.second,{candidateId:candidate.candidateId,maxJobs:2,hours:1})).rejects.toThrow();
 });
 it('actually consumes the candidate order, atomically bounds jobs, records receipts and restores baseline',async()=>{
  const a=await verified();await promoteRoutingAgentCandidate(a.reviewer,{candidateId:a.candidate.candidateId,maxJobs:1,hours:1});
  const plan={version:1,modules:['employees','ess']};
  const first=await runGovernedModuleReadPlan(a.author,plan);
  expect(first.mode).toBe('promoted');expect(first.results.map(row=>row.module)).toEqual(['ess','employees']);
  const second=await runGovernedModuleReadPlan(a.author,plan);
  expect(second.mode).toBe('baseline');expect(second.results.map(row=>row.module)).toEqual(['employees','ess']);
  const [rows]=await owner.db.execute<{jobs:number;used:number}>(sql`select(select count(*)::int from public.ai_agent_job_receipt) as jobs,(select used_jobs from public.ai_agent_promotion limit 1) as used`);
  expect(rows).toEqual({jobs:1,used:1});expect(await maintainModuleAgentReleases(a.reviewer)).toEqual({retired:1});
 });
 it('persists human rollback and never lets a source-changed receipt remain active',async()=>{
  const a=await verified();const promotion=await promoteRoutingAgentCandidate(a.reviewer,{candidateId:a.candidate.candidateId,maxJobs:4,hours:1});
  await rollbackRoutingAgent(a.second,{promotionId:promotion.promotionId,reason:'security_regression'});
  expect((await runGovernedModuleReadPlan(a.author,{version:1,modules:['employees','ess']})).mode).toBe('baseline');
  const next=await createRoutingAgentCandidate(a.author,{version:2,configuration:configuration()});
  await evaluateRoutingAgentCandidate(a.reviewer,next.candidateId);await evaluateRoutingAgentCandidate(a.second,next.candidateId);
  await promoteRoutingAgentCandidate(a.reviewer,{candidateId:next.candidateId,maxJobs:2,hours:1});
  await owner.db.execute(sql`update public.ai_agent_candidate set source_digest=${'0'.repeat(64)} where id=${next.candidateId}::uuid`);
  expect((await runGovernedModuleReadPlan(a.author,{version:1,modules:['employees','ess']})).mode).toBe('baseline');
  const reasons=await owner.db.execute<{reason:string}>(sql`select reason from public.ai_agent_rollback order by created_at,id`);
  expect(reasons.map(row=>row.reason)).toEqual(['security_regression','source_changed']);
 });
 it('rolls back permit reservation if a selected module is revoked before canonical execution',async()=>{
  const a=await verified();await promoteRoutingAgentCandidate(a.reviewer,{candidateId:a.candidate.candidateId,maxJobs:2,hours:1});
  await setModule(base.tenantId,'attendance','disabled');
  await expect(runGovernedModuleReadPlan(a.author,{version:1,modules:['attendance']})).rejects.toThrow();
  const [row]=await owner.db.execute<{used:number}>(sql`select used_jobs as used from public.ai_agent_promotion limit 1`);
  expect(row.used).toBe(0);
 });
});
