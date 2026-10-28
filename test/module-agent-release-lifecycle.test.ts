/** Actual durable routing-candidate lifecycle. Authored UNRUN; requires coordinated drafts. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as canonical from '../core/read';
import { hireEmployee } from '../core/org';
import {decryptSecret} from '../lib/ai/crypto';
import { grantAssistant,revokeAssistant } from '../core/assistant-grant';
import { AGENT_MODULE_CODES } from '../lib/ai/module-agents';
import { createRoutingAgentCandidate,evaluateRoutingAgentCandidate,promoteRoutingAgentCandidate,
 rollbackRoutingAgent,runGovernedModuleReadPlan,reopenGovernedModuleReadJobTx,maintainModuleAgentReleases } from '../core/module-agent-releases';
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
describe('durable measured independent routing evaluation',()=>{
 it('requires real distinct evaluators and authentic evidence, never a posted model score',async()=>{
  const a=await actors(),candidate=await createRoutingAgentCandidate(a.author,{version:1,configuration:configuration()});
  await expect(evaluateRoutingAgentCandidate(a.author,candidate.candidateId)).rejects.toThrow();await expect(promoteRoutingAgentCandidate(a.reviewer,{candidateId:candidate.candidateId,maxJobs:2,hours:1})).rejects.toThrow();
  await owner.db.execute(sql`insert into public.ai_agent_evaluation(tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt) values(${base.tenantId}::uuid,${candidate.candidateId}::uuid,${a.reviewer.userId}::uuid,${'a'.repeat(64)},'posted-model-pass')`);
  await expect(promoteRoutingAgentCandidate(a.second,{candidateId:candidate.candidateId,maxJobs:2,hours:1})).rejects.toThrow();
 });
 it('executes actual paired canonical reads, records timings/read counts and refuses same-work permutation after two real evaluators',async()=>{
  const a=await verified(),rows=await owner.db.execute<{id:string;receipt:string}>(sql`select id,receipt from public.ai_agent_evaluation order by completed_at,id`);
  expect(rows).toHaveLength(2);for(const row of rows){const proof=JSON.parse(decryptSecret(row.receipt,JSON.stringify(['ai-hr.module-agent.v1','evaluation',base.tenantId,row.id])));expect(proof.report).toMatchObject({version:2,comparison:{qualityImproved:false,resourceClaims:'observations-only',baseline:{cases:2,correct:2,readCount:4,tokens:0,costCredits:0},candidate:{cases:2,correct:2,readCount:4,tokens:0,costCredits:0}}});expect(proof.report.comparison.baseline.p50Ms).toBeGreaterThanOrEqual(0);expect(proof.report.comparison.candidate.p95Ms).toBeGreaterThanOrEqual(0);expect(JSON.stringify(proof.report)).not.toContain(a.author.personId!);}
  await expect(promoteRoutingAgentCandidate(a.reviewer,{candidateId:a.candidate.candidateId,maxJobs:2,hours:1})).rejects.toThrow();
  const[count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_promotion`);expect(count.n).toBe(0);
 });
 it('retains actual baseline specialist reads and nonce replay without claiming that a blocked routing candidate improved them',async()=>{
  const a=await verified(),nonce=randomUUID(),plan={version:1,modules:['employees','ess']},first=await runGovernedModuleReadPlan(a.author,plan,{nonce}),again=await runGovernedModuleReadPlan(a.author,plan,{nonce});
  expect(first.mode).toBe('baseline');expect(first.results.map(row=>row.module)).toEqual(plan.modules);expect(first.specialists.every(row=>row.work.mode==='baseline')).toBe(true);expect(again).toMatchObject({jobId:first.jobId,replayed:true});
  const reopened=await withTenant(a.author,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);return reopenGovernedModuleReadJobTx(tx,a.author,first.jobId);});expect(reopened.mode).toBe('baseline');
  const[count]=await owner.db.execute<{n:number;p:number}>(sql`select(select count(*)::int from public.ai_agent_job_receipt) as n,(select count(*)::int from public.ai_agent_promotion) as p`);expect(count).toEqual({n:1,p:0});expect(await maintainModuleAgentReleases(a.reviewer)).toEqual({retired:0});
 });
 it('refuses source-changed or revoked actual evidence without creating a promotion or treating cancelled work as PASS',async()=>{
  const a=await verified();await owner.db.execute(sql`update public.ai_agent_candidate set source_digest=${'0'.repeat(64)} where id=${a.candidate.candidateId}::uuid`);
  await expect(evaluateRoutingAgentCandidate(a.reviewer,a.candidate.candidateId)).rejects.toThrow();await expect(promoteRoutingAgentCandidate(a.second,{candidateId:a.candidate.candidateId,maxJobs:1,hours:1})).rejects.toThrow();
  await revokeAssistant(adminCtx(base),{appUserId:a.author.userId!});await expect(runGovernedModuleReadPlan(a.author,{version:1,modules:['employees']},{nonce:randomUUID()})).rejects.toThrow();
  const[count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_promotion`);expect(count.n).toBe(0);
 });
 it('keeps the actual baseline source interval ordered and releases it only on whole-command completion',async()=>{
  const a=await actors();let entered!:()=>void,release!:()=>void;const start=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;}),original=canonical.myOwnEmploymentSubjectsTx;let once=false;
  const source=vi.spyOn(canonical,'myOwnEmploymentSubjectsTx').mockImplementation(async(tx,ctx,...args)=>{if(!once&&ctx.userId===a.author.userId){once=true;entered();await resume;}return original(tx,ctx,...args);});
  const pending=runGovernedModuleReadPlan(a.author,{version:1,modules:['employees','ess']},{nonce:randomUUID()});void pending.catch(()=>undefined);
  try{await Promise.race([start,pending.then(()=>{throw Error('Expected actual source interval');})]);const owned=await withTenant(a.second,async tx=>{const[row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-release:'+base.tenantId+':'+a.author.userId},0)) as owned`);return row.owned;});expect(owned).toBe(false);}
  finally{release();source.mockRestore();await pending;}
 });
});
