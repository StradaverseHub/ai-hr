/** Authenticated evaluator-specific management metadata, authored UNRUN. Actual gateway/mock transport. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT} from '../lib/ai/module-agent-prompt-candidate';
import {MODULE_AGENT_SOURCE_DIGEST} from '../lib/ai/module-agent-source-manifest';
import {createPromptAgentCandidate,evaluatePromptAgentCandidate} from '../core/module-agent-releases';
import {loadAiWorkspace} from '../core/ai-workspace';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-evaluator-progress-secret');vi.stubEnv('OPENAI_API_KEY','fictional-evaluator-progress-provider');vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function actors(){const admin=adminCtx(base),make=async(name:string)=>{const person=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,person.personId,'hr_admin');await grantAssistant(admin,{appUserId:userId});return {...await entitledCtx(base,['hr_admin']),userId,personId:person.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;};return {author:await make('Progress author'),reviewer:await make('Progress reviewer'),second:await make('Second progress reviewer')};}
const consent=()=>({synthetic:true as const,maxRequests:PROMPT_HOLDOUT_REQUEST_LIMIT,sourceDigest:MODULE_AGENT_SOURCE_DIGEST});
const transport=(failFirst=false)=>vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{const fixture=PROMPT_HOLDOUTS.find(row=>row.question===args.prompt);if(!fixture)throw Error('Only fixed synthetic input permitted');args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return JSON.stringify(failFirst&&fixture.id===PROMPT_HOLDOUTS[0].id?{decision:'read',modules:['employees']}:{decision:fixture.decision,modules:fixture.modules});});
async function progress(ctx:SessionContext,id:string){return (await loadAiWorkspace(ctx,{includeHistory:false})).agentReview?.candidates.find(row=>row.id===id)?.progress??null;}
describe('current independently authenticated evaluation progress',()=>{
 it('shows actual partial coverage for this evaluator, never defaults another or missing evaluator to zero',async()=>{
  const a=await actors(),candidate=await createPromptAgentCandidate(a.author,{version:1,configuration:{kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}}),sent=transport();
  expect(await progress(a.reviewer,candidate.candidateId)).toBeNull();
  await evaluatePromptAgentCandidate(a.reviewer,{candidateId:candidate.candidateId,consent:consent()});
  expect(await progress(a.reviewer,candidate.candidateId)).toEqual({completedCases:Math.min(PROMPT_HOLDOUT_REQUEST_LIMIT,PROMPT_HOLDOUTS.length),totalCases:PROMPT_HOLDOUTS.length,state:PROMPT_HOLDOUTS.length>PROMPT_HOLDOUT_REQUEST_LIMIT?'incomplete':'complete',retainedFailures:0,knownFailures:0});
  expect(await progress(a.author,candidate.candidateId)).toBeNull();expect(await progress(a.second,candidate.candidateId)).toBeNull();expect(sent).toHaveBeenCalledTimes(PROMPT_HOLDOUT_REQUEST_LIMIT);
  const view=await loadAiWorkspace(a.reviewer,{includeHistory:false});for(const privateText of [PROMPT_HOLDOUTS[0].question,'fictional-evaluator-progress-provider','receipt','providerFingerprint'])expect(JSON.stringify(view.agentReview)).not.toContain(privateText);
 });
 it('keeps known failed outputs visible while completing previously unrun coverage, without calling them aggregate PASS',async()=>{
  const a=await actors(),candidate=await createPromptAgentCandidate(a.author,{version:1,configuration:{kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}});transport(true);
  await evaluatePromptAgentCandidate(a.reviewer,{candidateId:candidate.candidateId,consent:consent()});expect(await progress(a.reviewer,candidate.candidateId)).toMatchObject({knownFailures:1,retainedFailures:0,state:'incomplete'});
  await evaluatePromptAgentCandidate(a.reviewer,{candidateId:candidate.candidateId,consent:consent()});expect(await progress(a.reviewer,candidate.candidateId)).toMatchObject({completedCases:2*PROMPT_HOLDOUT_REQUEST_LIMIT,knownFailures:1,retainedFailures:1,state:'incomplete'});
 });
 it('withholds stale-provider or forged receipt progress rather than turning missing evidence into zero',async()=>{
  const a=await actors(),candidate=await createPromptAgentCandidate(a.author,{version:1,configuration:{kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}});const sent=transport();
  await evaluatePromptAgentCandidate(a.reviewer,{candidateId:candidate.candidateId,consent:consent()});expect(await progress(a.reviewer,candidate.candidateId)).not.toBeNull();
  vi.stubEnv('OPENAI_API_KEY','fictional-changed-progress-provider');expect(await progress(a.reviewer,candidate.candidateId)).toBeNull();vi.stubEnv('OPENAI_API_KEY','fictional-evaluator-progress-provider');
  await owner.db.execute(sql`update public.ai_agent_evaluation set receipt='POSTED_MODEL_SELF_RATING_PASS' where candidate_id=${candidate.candidateId}::uuid and evaluator_user_id=${a.reviewer.userId}::uuid`);
  expect(await progress(a.reviewer,candidate.candidateId)).toBeNull();expect(sent).toHaveBeenCalledTimes(PROMPT_HOLDOUT_REQUEST_LIMIT);
 });
});
