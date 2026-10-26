/** Real DB custody and gateway admission with mocked transport only. All cases authored UNRUN. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {PROMPT_HOLDOUTS} from '../lib/ai/module-agent-prompt-candidate';
import {MODULE_AGENT_SOURCE_DIGEST} from '../lib/ai/module-agent-source-manifest';
import {createPromptAgentCandidate,evaluatePromptAgentCandidate,promotePromptAgentCandidate,runPromptPlannedSyntheticJob} from '../core/module-agent-releases';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
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
const consent=(maxRequests=12)=>({synthetic:true as const,maxRequests,sourceDigest:MODULE_AGENT_SOURCE_DIGEST});
const transport=()=>vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{
 const fixture=PROMPT_HOLDOUTS.find(row=>row.question===args.prompt);if(!fixture)throw Error('Non-synthetic provider input');
 args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return JSON.stringify({decision:fixture.decision,modules:fixture.modules});
});
async function candidate(){const a=await actors();const row=await createPromptAgentCandidate(a.author,{version:1,configuration:{kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}});return {...a,...row};}
describe('actual independent prompt-to-plan evaluation custody',()=>{
 it('requires human synthetic consent before transport, then uses real admission and a bounded promoted synthetic consumer',async()=>{
  const a=await candidate(),sent=transport();
  await expect(evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:{...consent(),synthetic:false} as never})).rejects.toThrow();
  expect(sent).not.toHaveBeenCalled();
  const first=await evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(first).toMatchObject({state:'complete',completedRequests:12,securityFailures:0,qualityFailures:0});
  await evaluatePromptAgentCandidate(a.second,{candidateId:a.candidateId,consent:consent()});
  await promotePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,maxJobs:1,hours:1});
  const result=await runPromptPlannedSyntheticJob(a.author,{fixtureId:'own-leave',consent:consent(1)});
  expect(result.decision).toBe('read');expect(result.results.map(row=>row.module)).toEqual(['leave']);expect(sent).toHaveBeenCalledTimes(25);
  await expect(runPromptPlannedSyntheticJob(a.author,{fixtureId:'own-leave',consent:consent(1)})).rejects.toThrow();expect(sent).toHaveBeenCalledTimes(25);
  const [runs]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_model_run where tenant_id=${base.tenantId}::uuid and feature_id='module_agent_evaluation' and state='completed'`);
  expect(runs.n).toBe(25);
 });
 it('retains authentic passing cases and reruns only a failed exact-input case',async()=>{
  const a=await candidate(),sent=transport();const normal=sent.getMockImplementation()!;
  sent.mockImplementation(async(cfg,args)=>args.prompt===PROMPT_HOLDOUTS[9].question?JSON.stringify({decision:'read',modules:['payroll']}):normal(cfg,args));
  const failed=await evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});expect(failed.securityFailures).toBe(1);
  sent.mockImplementation(normal);sent.mockClear();
  const repaired=await evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(repaired).toMatchObject({retainedPasses:11,attemptedRequests:1,completedRequests:1,securityFailures:0,qualityFailures:0});expect(sent).toHaveBeenCalledTimes(1);
  const [evidence]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_evaluation where candidate_id=${a.candidateId}::uuid`);expect(evidence.n).toBe(2);
 });
 it('does not convert incomplete or changed-provider evidence into promotable quality',async()=>{
  const a=await candidate(),sent=transport();const normal=sent.getMockImplementation()!;
  let count=0;sent.mockImplementation(async(cfg,args)=>{if(++count===2)throw Error('fictional transport failed');return normal(cfg,args);});
  const incomplete=await evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(incomplete).toMatchObject({state:'incomplete',attemptedRequests:2,completedRequests:1,securityFailures:null,qualityFailures:null});
  await expect(promotePromptAgentCandidate(a.second,{candidateId:a.candidateId,maxJobs:1,hours:1})).rejects.toThrow();
  sent.mockImplementation(normal);await evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  await evaluatePromptAgentCandidate(a.second,{candidateId:a.candidateId,consent:consent()});
  vi.stubEnv('OPENAI_API_KEY','fictional-changed-active-key');
  await expect(promotePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,maxJobs:1,hours:1})).rejects.toThrow();
 });
 it('rolls back promotion on a schema-valid wrong synthetic plan before canonical facts are read',async()=>{
  const a=await candidate(),sent=transport();await evaluatePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  await evaluatePromptAgentCandidate(a.second,{candidateId:a.candidateId,consent:consent()});
  await promotePromptAgentCandidate(a.reviewer,{candidateId:a.candidateId,maxJobs:2,hours:1});
  sent.mockResolvedValue(JSON.stringify({decision:'read',modules:['employees']}));
  await expect(runPromptPlannedSyntheticJob(a.author,{fixtureId:'own-leave',consent:consent(1)})).rejects.toThrow();
  const [row]=await owner.db.execute<{reason:string}>(sql`select reason from public.ai_agent_rollback limit 1`);expect(row.reason).toBe('quality_regression');
 });
});
