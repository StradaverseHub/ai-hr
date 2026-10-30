/** Real DB custody and gateway admission with mocked transport only. All cases authored UNRUN. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {installSyntheticSpendCapability} from './ai-spend-fixture';
import {defaultModelFor} from '../lib/ai/registry';
import * as spend from '../lib/ai/spend-allocation';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT,promptCandidateSystem,PROMPT_BASELINE} from '../lib/ai/module-agent-prompt-candidate';
import {MODULE_AGENT_SOURCE_DIGEST} from '../lib/ai/module-agent-source-manifest';
import {createPromptAgentCandidate,evaluatePromptAgentCandidate,promotePromptAgentCandidate,runPromptPlannedSyntheticJob} from '../core/module-agent-releases';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
afterEach(()=>vi.restoreAllMocks());
beforeAll(migrateTestDb);afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
beforeEach(async()=>{
 vi.restoreAllMocks();vi.stubEnv('AI_CONFIG_SECRET','fictional-prompt-receipt-passphrase');vi.stubEnv('OPENAI_API_KEY','fictional-active-key');
 vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
});
async function actors(){const admin=adminCtx(base);const make=async(name:string)=>{
 const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,'hr_admin');await grantAssistant(admin,{appUserId:userId});
 return {...await entitledCtx(base,['hr_admin']),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;
};return {author:await make('Fictional Prompt Author'),reviewer:await make('Fictional Prompt Reviewer'),second:await make('Fictional Second Prompt Reviewer')};}
const consent=(maxRequests=PROMPT_HOLDOUT_REQUEST_LIMIT)=>({synthetic:true as const,maxRequests,sourceDigest:MODULE_AGENT_SOURCE_DIGEST});
const transport=async(ctx:SessionContext,fictionalBaselineFailure=false)=>{const mocked=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{
 const fixture=PROMPT_HOLDOUTS.find(row=>row.question===args.prompt);if(!fixture)throw Error('Non-synthetic provider input');
 args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});if(fictionalBaselineFailure&&args.system===promptCandidateSystem(PROMPT_BASELINE)&&fixture.id==='own-leave')return JSON.stringify({decision:'read',modules:['employees']});return JSON.stringify({decision:fixture.decision,modules:fixture.modules});
});await installSyntheticSpendCapability(ctx,{provider:'openai',model:defaultModelFor('openai')});return mocked;};
async function candidate(){const a=await actors();const row=await createPromptAgentCandidate(a.author,{version:1,configuration:{kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}});return {...a,...row};}
async function completeEvaluation(ctx:SessionContext,input:Parameters<typeof evaluatePromptAgentCandidate>[1]){
 for(let batch=0;batch<=Math.ceil(2*PROMPT_HOLDOUTS.length/PROMPT_HOLDOUT_REQUEST_LIMIT);batch++){
  const result=await evaluatePromptAgentCandidate(ctx,input);if(result.state==='complete')return result;
 }throw Error('Synthetic evaluation did not complete the fixed fixture set.');
}
const expectedModelRuns=()=>PROMPT_HOLDOUTS.length*4+1;
describe('actual independent prompt-to-plan evaluation custody',()=>{
 it('requires human synthetic consent before transport, then uses real admission and a bounded promoted synthetic consumer',async()=>{
  const a=await candidate(),sent=await transport(a.author,true);
  // Deliberately wrong MOCKED baseline response exercises promotion policy; it is not real provider quality evidence.
  await expect(evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:{...consent(),synthetic:false} as never})).rejects.toThrow();
  expect(sent).not.toHaveBeenCalled();
  const first=await completeEvaluation(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(first).toMatchObject({state:'complete',completedCases:PROMPT_HOLDOUTS.length,securityFailures:0,qualityFailures:0});
  await completeEvaluation(a.second,{candidateId:a.candidateId,consent:consent()});
  await promotePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,maxJobs:1,hours:1});
  const result=await runPromptPlannedSyntheticJob(a.author,{fixtureId:'own-leave',consent:consent(1)});
  expect(result.decision).toBe('read');expect(result.results.map(row=>row.module)).toEqual(['leave']);expect(sent).toHaveBeenCalledTimes(expectedModelRuns());
  expect(sent.mock.lastCall?.[1]).toMatchObject({system:promptCandidateSystem({kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}),prompt:PROMPT_HOLDOUTS.find(row=>row.id==='own-leave')!.question,maxTokens:384,timeoutMs:15000});
  await expect(runPromptPlannedSyntheticJob(a.author,{fixtureId:'own-leave',consent:consent(1)})).rejects.toThrow();expect(sent).toHaveBeenCalledTimes(expectedModelRuns());
  const [runs]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_model_run where tenant_id=${base.tenantId}::uuid and feature_id='module_agent_evaluation' and state='completed'`);
  expect(runs.n).toBe(expectedModelRuns());
  const[allocation]=await owner.db.execute<{roots:number;reservations:number;held:number;reserved:string}>(sql`select(select count(*)::int from app.ai_spend_root where tenant_id=${base.tenantId}::uuid) as roots,count(*)::int as reservations,count(*) filter(where state='held')::int as held,sum(reserved_nanos)::text as reserved from app.ai_spend_reservation where tenant_id=${base.tenantId}::uuid and root_id=${a.candidateId}::uuid`);
  // Unknown USD reconciliation stays held even with zero normalized tokens. Both reviewers and
  // the author trial share the same actual root; no retry/arm/principal mints a fresh allowance.
  expect(allocation).toEqual({roots:1,reservations:expectedModelRuns(),held:expectedModelRuns(),reserved:(BigInt(expectedModelRuns())*BigInt("1000000")).toString()});
 });
 it('retains authentic passing cases and reruns only a failed exact-input case',async()=>{
  const a=await candidate(),sent=await transport(a.author);const normal=sent.getMockImplementation()!;
  sent.mockImplementation(async(cfg,args)=>args.system!==promptCandidateSystem(PROMPT_BASELINE)&&args.prompt===PROMPT_HOLDOUTS.find(row=>row.id==='reject-peer')!.question?JSON.stringify({decision:'read',modules:['payroll']}):normal(cfg,args));
  const failed=await completeEvaluation(a.reviewer,{candidateId:a.candidateId,consent:consent()});expect(failed.securityFailures).toBe(1);
  sent.mockImplementation(normal);sent.mockClear();
  const repaired=await completeEvaluation(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(repaired).toMatchObject({retainedPasses:2*PROMPT_HOLDOUTS.length-1,retainedFailures:0,attemptedRequests:1,completedRequests:1,securityFailures:0,qualityFailures:0});expect(sent).toHaveBeenCalledTimes(1);
  const [evidence]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_evaluation where candidate_id=${a.candidateId}::uuid`);expect(evidence.n).toBe(Math.ceil(2*PROMPT_HOLDOUTS.length/PROMPT_HOLDOUT_REQUEST_LIMIT)+1);
 });
 it('does not convert incomplete or changed-provider evidence into promotable quality',async()=>{
  const a=await candidate(),sent=await transport(a.author);const normal=sent.getMockImplementation()!;
  let count=0;sent.mockImplementation(async(cfg,args)=>{if(++count===2)throw Error('fictional transport failed');return normal(cfg,args);});
  const incomplete=await evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(incomplete).toMatchObject({state:'incomplete',attemptedRequests:2,completedRequests:1,securityFailures:null,qualityFailures:null});
  await expect(promotePromptAgentCandidate(a.second,{candidateId:a.candidateId,maxJobs:1,hours:1})).rejects.toThrow();
  sent.mockImplementation(normal);await completeEvaluation(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  await completeEvaluation(a.second,{candidateId:a.candidateId,consent:consent()});
  vi.stubEnv('OPENAI_API_KEY','fictional-changed-active-key');
  await expect(promotePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,maxJobs:1,hours:1})).rejects.toThrow();
 });
 it('rolls back promotion on a schema-valid wrong synthetic plan before canonical facts are read',async()=>{
  const a=await candidate(),sent=await transport(a.author,true);await completeEvaluation(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  await completeEvaluation(a.second,{candidateId:a.candidateId,consent:consent()});
  await promotePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,maxJobs:2,hours:1});
  sent.mockResolvedValue(JSON.stringify({decision:'read',modules:['employees']}));
  await expect(runPromptPlannedSyntheticJob(a.author,{fixtureId:'own-leave',consent:consent(1)})).rejects.toThrow();
  // A valid protected request must actually reach transport and adjudication. A privacy
  // preparation failure cannot masquerade as a successful wrong-plan safety check.
  expect(sent).toHaveBeenCalledTimes(expectedModelRuns());
  const [row]=await owner.db.execute<{reason:string;used:number;completed:number;receipts:number}>(sql`select r.reason,p.used_jobs as used,
   (select count(*)::int from public.ai_model_run where tenant_id=${base.tenantId}::uuid and feature_id='module_agent_evaluation' and state='completed') as completed,
   (select count(*)::int from public.ai_agent_job_receipt j where j.tenant_id=p.tenant_id and j.promotion_id=p.id) as receipts
   from public.ai_agent_rollback r join public.ai_agent_promotion p on p.id=r.promotion_id and p.tenant_id=r.tenant_id
   where p.tenant_id=${base.tenantId}::uuid and p.candidate_id=${a.candidateId}::uuid`);
  expect(row).toEqual({reason:'quality_regression',used:1,completed:expectedModelRuns(),receipts:2});
  await expect(runPromptPlannedSyntheticJob(a.author,{fixtureId:'own-leave',consent:consent(1)})).rejects.toThrow();
  expect(sent).toHaveBeenCalledTimes(expectedModelRuns());
 });
 it('refuses equal perfect baseline/candidate plans after two authentic independent paired evaluations, regardless of zero reported tokens',async()=>{
  const a=await candidate();await transport(a.author);for(const ctx of [a.reviewer,a.second]){const report=await completeEvaluation(ctx,{candidateId:a.candidateId,consent:consent()});expect(report.comparison).toMatchObject({qualityImproved:false,baseline:{correct:144,tokens:0,costCredits:null},candidate:{correct:144,tokens:0,costCredits:null}});}
  await expect(promotePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,maxJobs:1,hours:1})).rejects.toThrow();const[rows]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_promotion`);expect(rows.n).toBe(0);
 });

 it('reaches the actual unmocked missing-capability guard and sends no request or token/spend reservation',async()=>{
  const a=await candidate(),selected=vi.spyOn(spend,'certifiedAiSpendEnvelope'),sent=vi.spyOn(openaiAdapter,'generate').mockResolvedValue('MUST_NOT_SEND');
  // 0654 makes USD limits optional: the certified capability is required only where a USD limit applies.
  // Configure one (operator provisioning, as the shared spend fixture does) and certify no capability.
  await owner.db.execute(sql`insert into app.ai_spend_budget(tenant_id,scope_key,kind,monthly_nanos,root_nanos,updated_by) values(${base.tenantId}::uuid,'tenant','tenant',1000000000,1000000000,${a.reviewer.userId}::uuid)`);
  const report=await evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});expect(report).toMatchObject({state:'incomplete',attemptedRequests:1,completedRequests:0,qualityFailures:null});
  expect(selected).toHaveBeenCalledTimes(1);expect(sent).not.toHaveBeenCalled();const[rows]=await owner.db.execute<{runs:number;spend:number}>(sql`select(select count(*)::int from public.ai_model_run where tenant_id=${base.tenantId}::uuid) as runs,(select count(*)::int from app.ai_spend_reservation where tenant_id=${base.tenantId}::uuid) as spend`);expect(rows).toEqual({runs:0,spend:0});
 });

});
