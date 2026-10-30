/** Actual app-role custody/admission with mocked provider transport only. Authored UNRUN. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {installSyntheticSpendCapability} from './ai-spend-fixture';
import {defaultModelFor} from '../lib/ai/registry';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {PROMPT_HOLDOUTS,promptCandidateSystem,PROMPT_BASELINE} from '../lib/ai/module-agent-prompt-candidate';
import {HUMAN_PLAN_HOLDOUTS,HUMAN_PLAN_SUITE_DIGEST,humanQuestionPrompt} from '../lib/ai/human-plan-holdouts';
import * as ai from '../lib/ai';
import {resolveActiveAiConfig} from '../core/ai-config';
import {bindStrictAiSpendRoot,preparePrivateAiTask} from '../core/ai-governance';
import {setAiFeature} from '../core/ai-management';
import type {AiFeatureId} from '../lib/ai/features';
import type {ResolvedAiConfig} from '../lib/ai/types';
import {MODULE_AGENT_SOURCE_DIGEST} from '../lib/ai/module-agent-source-manifest';
import {issueOwnModulePlanPermitTx,createPromptAgentCandidate,evaluatePromptAgentCandidate,evaluateHumanQuestionPlannerCandidate,promotePromptAgentCandidate,proposeOwnModuleReadPlan,reopenOwnModulePlanTx,runGovernedModuleReadPlan,eraseOwnModulePlanProposals,rollbackRoutingAgent} from '../core/module-agent-releases';
import {decryptSecret,encryptSecret} from '../lib/ai/crypto';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
afterEach(()=>vi.restoreAllMocks());
beforeAll(migrateTestDb);afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
beforeEach(async()=>{vi.restoreAllMocks();vi.stubEnv('AI_CONFIG_SECRET','fictional-human-plan-receipt-passphrase');vi.stubEnv('OPENAI_API_KEY','fictional-active-key');vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
const consent=()=>({synthetic:true as const,maxRequests:12,sourceDigest:MODULE_AGENT_SOURCE_DIGEST});
const input=async(ctx:SessionContext,question='my work profile')=>({permit:await withTenant(ctx,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);return issueOwnModulePlanPermitTx(tx,ctx);}),question,locale:'en',consent:{questionOnly:true as const,oneRequest:true as const,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});
const reopen=(ctx:SessionContext,id:string)=>withTenant(ctx,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);return reopenOwnModulePlanTx(tx,ctx,id);});
async function makeActor(name:string){const admin=adminCtx(base),hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});const userId=await createAppUser(base.tenantId,hired.personId,'hr_admin');await grantAssistant(admin,{appUserId:userId});return {...await entitledCtx(base,['hr_admin']),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;}
async function fixture(human=true){
 const author=await makeActor('PRIVATE_AUTHOR_HR_RECORD'),reviewer=await makeActor('PRIVATE_REVIEWER_RECORD'),second=await makeActor('PRIVATE_SECOND_RECORD');
 const sent=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{let proposed:{question?:string;locale?:string;version?:number;operation?:string;intent?:string;modules?:string[]}|undefined;try{proposed=JSON.parse(args.prompt);}catch{}const f=proposed?.question?HUMAN_PLAN_HOLDOUTS.find(row=>row.question===proposed!.question&&row.locale===proposed!.locale):PROMPT_HOLDOUTS.find(row=>row.question===args.prompt);args.onUsage?.({inputTokens:3,outputTokens:4,cachedInputTokens:0});if(!proposed&&f?.id==='own-leave'&&args.system===promptCandidateSystem(PROMPT_BASELINE))return JSON.stringify({decision:'read',modules:['employees']});if(proposed?.operation==='draft'){expect(proposed).toEqual({version:1,operation:'draft',intent:'work_profile',strategy:'explicit_scope_v1',modules:['employees']});return JSON.stringify({decision:'read',modules:proposed.modules});}return JSON.stringify(f?{decision:f.decision,modules:f.modules}:{decision:'read',modules:['employees']});});
 // This fictional counterexample exercises the quality-gain gate; it is not live provider quality evidence.
 await installSyntheticSpendCapability(author,{provider:'openai',model:defaultModelFor('openai')});
 const candidate=await createPromptAgentCandidate(author,{version:1,configuration:{kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}});
 for(const actor of [reviewer,second]){let progress;for(let n=0;n<Math.ceil(2*PROMPT_HOLDOUTS.length/12);n++){progress=await evaluatePromptAgentCandidate(actor,{candidateId:candidate.candidateId,consent:consent()});}expect(progress?.state).toBe('complete');if(human)expect(await evaluateHumanQuestionPlannerCandidate(actor,{candidateId:candidate.candidateId,consent:consent()})).toMatchObject({state:'complete',completedCases:HUMAN_PLAN_HOLDOUTS.length,totalCases:HUMAN_PLAN_HOLDOUTS.length,knownFailures:0});}
 const promotion=await promotePromptAgentCandidate(reviewer,{candidateId:candidate.candidateId,maxJobs:10,hours:1});sent.mockClear();return {author,reviewer,second,sent,...candidate,...promotion};
}
async function counts(){const [row]=await owner.db.execute<{proposals:number;jobs:number}>(sql`select (select count(*)::int from public.ai_agent_plan_proposal) as proposals,(select count(*)::int from public.ai_agent_job_receipt where request_nonce is not null) as jobs`);return row;}
describe('consented human-question planner with human-reviewed canonical jobs',()=>{
 it('keeps no-promotion baseline deterministic and never sends an untested prompt',async()=>{const admin=adminCtx(base);const sent=vi.spyOn(openaiAdapter,'generate');await grantAssistant(admin,{appUserId:admin.userId!});expect(await proposeOwnModuleReadPlan(admin,await input(admin))).toEqual({state:'chooser'});expect(sent).not.toHaveBeenCalled();expect(await counts()).toEqual({proposals:0,jobs:0});});
 it('keeps unsupported private wording local without a proposal, admission or provider call',async()=>{const a=await fixture();expect(await proposeOwnModuleReadPlan(a.author,await input(a.author,'QUESTION_PRIVATE_TOKEN'))).toEqual({state:'chooser'});expect(a.sent).not.toHaveBeenCalled();expect(await counts()).toEqual({proposals:0,jobs:0});const [runs]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_model_run where tenant_id=${base.tenantId}::uuid and feature_id='module_agent_planning'`);expect(runs.n).toBe(0);});
 it('requires the independent human-question suite beyond the original all-module promotion',async()=>{const a=await fixture(false);await expect(proposeOwnModuleReadPlan(a.author,await input(a.author))).rejects.toThrow();expect(a.sent).not.toHaveBeenCalled();expect(await counts()).toEqual({proposals:0,jobs:0});});
 it('sends only closed intent references once; stores no question or HR records; canonical reads require a second exact human command',async()=>{const a=await fixture(),p=await input(a.author,'my work profile'),first=await proposeOwnModuleReadPlan(a.author,p);expect('proposalId' in first).toBe(true);if(!('proposalId' in first))throw Error();const id=first.proposalId;expect(a.sent).toHaveBeenCalledTimes(1);expect(JSON.parse(a.sent.mock.calls[0][1].prompt)).toEqual({version:1,operation:'draft',intent:'work_profile',strategy:'explicit_scope_v1',modules:['employees']});const outbound=JSON.stringify(a.sent.mock.calls[0][1]);expect(outbound).not.toContain(p.question);expect(outbound).not.toContain('PRIVATE_AUTHOR_HR_RECORD');expect(outbound).not.toContain(a.author.userId!);expect(await counts()).toEqual({proposals:1,jobs:0});
  const view=await reopen(a.author,id);expect(view).toMatchObject({state:'ready',modules:['employees'],consumedJobId:null});const [row]=await owner.db.execute<{receipt:string}>(sql`select receipt from public.ai_agent_plan_proposal where id=${id}::uuid`);const plain=decryptSecret(row.receipt,JSON.stringify(['ai-hr.module-agent.v1','human-plan',base.tenantId,id]));expect(plain).not.toContain(p.question);expect(plain).not.toContain('PRIVATE_AUTHOR_HR_RECORD');const proof=JSON.parse(plain);expect(proof.runId).toMatch(/^[a-f0-9-]{36}$/i);expect(proof.tokens).toBe(7);expect(proof.cost).toBeNull();expect(proof.settled).toBe(true);expect(proof.elapsedMs).toBeGreaterThanOrEqual(0);expect(proof.duplicateReplays).toBe(0);
  const[roots]=await owner.db.execute<{roots:number;runtime:number;other_roots:number}>(sql`select(select count(*)::int from app.ai_spend_root where tenant_id=${base.tenantId}::uuid) as roots,count(*) filter(where feature_id='module_agent_planning')::int as runtime,count(*) filter(where root_id<>${a.candidateId}::uuid)::int as other_roots from app.ai_spend_reservation where tenant_id=${base.tenantId}::uuid`);expect(roots).toEqual({roots:1,runtime:1,other_roots:0});
  await expect(runGovernedModuleReadPlan(a.author,{version:1,modules:['org']},{nonce:randomUUID(),proposalId:id})).rejects.toThrow();expect((await counts()).jobs).toBe(0);const nonce=randomUUID(),job=await runGovernedModuleReadPlan(a.author,{version:1,modules:['employees']},{nonce,proposalId:id});expect(job.results.map(row=>row.module)).toEqual(['employees']);expect((await runGovernedModuleReadPlan(a.author,{version:1,modules:['employees']},{nonce,proposalId:id})).jobId).toBe(job.jobId);await expect(runGovernedModuleReadPlan(a.author,{version:1,modules:['employees']},{nonce:randomUUID(),proposalId:id})).rejects.toThrow();expect(await counts()).toEqual({proposals:1,jobs:1});expect(a.sent).toHaveBeenCalledTimes(1);
 });
 it('replays completed or failed nonces without another request and refuses retargeting retained input',async()=>{const a=await fixture(),p=await input(a.author),first=await proposeOwnModuleReadPlan(a.author,p);expect('proposalId' in first).toBe(true);expect(await proposeOwnModuleReadPlan(a.author,p)).toMatchObject({state:'replayed'});await expect(proposeOwnModuleReadPlan(a.author,{...p,question:'my leave balance'})).rejects.toThrow();expect(a.sent).toHaveBeenCalledTimes(1);a.sent.mockRejectedValue(Error('PRIVATE_PROVIDER_EXCEPTION'));const failedInput=await input(a.author),failed=await proposeOwnModuleReadPlan(a.author,failedInput);if(!('proposalId' in failed))throw Error();expect(await reopen(a.author,failed.proposalId)).toMatchObject({state:'failed'});await proposeOwnModuleReadPlan(a.author,failedInput);expect(a.sent).toHaveBeenCalledTimes(2);});
 it('has no cross-owner oracle; rechecks grant/provider/promotion and permits personal erase after grant loss',async()=>{const a=await fixture(),first=await proposeOwnModuleReadPlan(a.author,await input(a.author));if(!('proposalId' in first))throw Error();const id=first.proposalId;expect(await reopen(a.second,id).catch(e=>e.message)).toBe(await reopen(a.second,randomUUID()).catch(e=>e.message));await revokeAssistant(adminCtx(base),{appUserId:a.author.userId!});await expect(reopen(a.author,id)).rejects.toThrow();expect(await eraseOwnModulePlanProposals(a.author)).toEqual({erased:1});expect((await counts()).proposals).toBe(0);});
 it('blocks schema-valid model scopes/effects and malformed output before any canonical read or public raw prose',async()=>{const a=await fixture();a.sent.mockResolvedValue(JSON.stringify({decision:'read',modules:['employees'],employeeId:randomUUID(),answer:'PRIVATE_HALLUCINATION'}));const result=await proposeOwnModuleReadPlan(a.author,await input(a.author));if(!('proposalId' in result))throw Error();const view=await reopen(a.author,result.proposalId);expect(view.state).toBe('refused');expect(JSON.stringify(view)).not.toContain('PRIVATE_HALLUCINATION');expect((await counts()).jobs).toBe(0);});
 it('rejects declined consent before transport and rechecks a changed active provider',async()=>{const a=await fixture();await expect(proposeOwnModuleReadPlan(a.author,{...await input(a.author),consent:{questionOnly:false,oneRequest:true,sourceDigest:MODULE_AGENT_SOURCE_DIGEST} as never})).rejects.toThrow();expect(a.sent).not.toHaveBeenCalled();const result=await proposeOwnModuleReadPlan(a.author,await input(a.author));if(!('proposalId' in result))throw Error();vi.stubEnv('OPENAI_API_KEY','fictional-changed-provider-key');await expect(reopen(a.author,result.proposalId)).rejects.toThrow();await expect(runGovernedModuleReadPlan(a.author,{version:1,modules:['employees']},{nonce:randomUUID(),proposalId:result.proposalId})).rejects.toThrow();expect((await counts()).jobs).toBe(0);expect(a.sent).toHaveBeenCalledTimes(1);});
 it('expires authentic proposals without an automatic request or record read',async()=>{const a=await fixture(),result=await proposeOwnModuleReadPlan(a.author,await input(a.author));if(!('proposalId' in result))throw Error();const [row]=await owner.db.execute<{receipt:string}>(sql`select receipt from public.ai_agent_plan_proposal where id=${result.proposalId}::uuid`);const aad=JSON.stringify(['ai-hr.module-agent.v1','human-plan',base.tenantId,result.proposalId]),proof=JSON.parse(decryptSecret(row.receipt,aad)),expires=new Date(Date.now()-1000).toISOString(),created=new Date(Date.now()-901000).toISOString();proof.expiresAt=expires;proof.createdAt=created;await owner.db.execute(sql`update public.ai_agent_plan_proposal set created_at=${created}::timestamptz,expires_at=${expires}::timestamptz,receipt=${encryptSecret(JSON.stringify(proof),aad)} where id=${result.proposalId}::uuid`);await expect(reopen(a.author,result.proposalId)).rejects.toThrow();expect((await counts()).jobs).toBe(0);expect(a.sent).toHaveBeenCalledTimes(1);});
 it('revoked promotion cannot reopen or consume a previously ready proposal',async()=>{const a=await fixture(),result=await proposeOwnModuleReadPlan(a.author,await input(a.author));if(!('proposalId' in result))throw Error();await rollbackRoutingAgent(a.reviewer,{promotionId:a.promotionId,reason:'human'});await expect(reopen(a.author,result.proposalId)).rejects.toThrow();await expect(runGovernedModuleReadPlan(a.author,{version:1,modules:['employees']},{nonce:randomUUID(),proposalId:result.proposalId})).rejects.toThrow();expect((await counts()).jobs).toBe(0);});
 it('physically erases a genuinely expired short permit/proposal, then refuses the exact retained POST without another admission or provider call',async()=>{const a=await fixture(),permit=await withTenant(a.author,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);return issueOwnModulePlanPermitTx(tx,a.author,2);}),request={...await input(a.author),permit},first=await proposeOwnModuleReadPlan(a.author,request);if(!('proposalId' in first))throw Error();expect(a.sent).toHaveBeenCalledTimes(1);const [before]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_model_run where tenant_id=${base.tenantId}::uuid and feature_id='module_agent_planning'`);expect(before.n).toBe(1);
  // The real database clock advances; neither a posted timestamp nor a mocked clock creates expiry.
  await owner.db.execute(sql`select pg_sleep(2.1)`);const cleanup=await runAiRetentionTick(owner);expect(cleanup.plans).toBe(1);const [gone]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_plan_proposal where id=${first.proposalId}::uuid`);expect(gone.n).toBe(0);await expect(proposeOwnModuleReadPlan(a.author,request)).rejects.toThrow();const [after]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_model_run where tenant_id=${base.tenantId}::uuid and feature_id='module_agent_planning'`);expect(after.n).toBe(before.n);expect(a.sent).toHaveBeenCalledTimes(1);expect((await counts()).proposals).toBe(0);
 });
 it('refuses forged, cross-user and already-expired AEAD permits before any row insertion or provider admission',async()=>{const a=await fixture(),request=await input(a.author);await expect(proposeOwnModuleReadPlan(a.second,request)).rejects.toThrow();await expect(proposeOwnModuleReadPlan(a.author,{...request,permit:'forged-client-nonce-or-time'})).rejects.toThrow();const aad=JSON.stringify(['ai-hr.module-agent.v1','human-plan-permit',base.tenantId,a.author.userId]),proof=JSON.parse(decryptSecret(request.permit,aad)),clock=Date.now();proof.issuedAt=new Date(clock-10000).toISOString();proof.expiresAt=new Date(clock-1000).toISOString();await expect(proposeOwnModuleReadPlan(a.author,{...request,permit:encryptSecret(JSON.stringify(proof),aad)})).rejects.toThrow();expect(a.sent).not.toHaveBeenCalled();expect((await counts()).proposals).toBe(0);const [runs]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_model_run where tenant_id=${base.tenantId}::uuid and feature_id='module_agent_planning'`);expect(runs.n).toBe(0);
 });
 it('does not let a duplicate POST retire or alter the first invocation while its actual provider request is in flight',async()=>{const a=await fixture(),request=await input(a.author);let entered!:()=>void,failed!:(error:unknown)=>void,release!:()=>void;const started=new Promise<void>((yes,no)=>{entered=yes;failed=no;}),resume=new Promise<void>(yes=>{release=yes;}),watchdog=setTimeout(()=>{failed(Error('planner provider handshake timed out'));release();},10000);a.sent.mockImplementation(async(_cfg,args)=>{entered();await resume;args.onUsage?.({inputTokens:3,outputTokens:4,cachedInputTokens:0});return JSON.stringify({decision:'read',modules:['employees']});});const first=proposeOwnModuleReadPlan(a.author,request);void first.catch(failed);let duplicateId:string|null=null;
  try{await started;const duplicate=await proposeOwnModuleReadPlan(a.author,request);expect(duplicate.state).toBe('replayed');if(!('proposalId' in duplicate))throw Error();duplicateId=duplicate.proposalId;const [reserved]=await owner.db.execute<{state:string}>(sql`select state from public.ai_agent_plan_proposal where id=${duplicateId}::uuid`);expect(reserved.state).toBe('reserved');expect(a.sent).toHaveBeenCalledTimes(1);}finally{release();clearTimeout(watchdog);await first;}
  expect(await reopen(a.author,duplicateId!)).toMatchObject({state:'ready'});expect(a.sent).toHaveBeenCalledTimes(1);const [runs]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_model_run where tenant_id=${base.tenantId}::uuid and feature_id='module_agent_planning'`);expect(runs.n).toBe(1);
 });
 it('concurrent duplicate commands never issue two requests',async()=>{const a=await fixture(),p=await input(a.author),outcomes=await Promise.allSettled([proposeOwnModuleReadPlan(a.author,p),proposeOwnModuleReadPlan(a.author,p)]);expect(outcomes.some(row=>row.status==='fulfilled')).toBe(true);expect(a.sent).toHaveBeenCalledTimes(1);expect((await counts()).proposals).toBe(1);});
});


// Genuine issued admission for the exact fixed human suite. Only adapter transport is fictional;
// no provider-privacy/governance/review/candidate authorization is mocked or bypassed.
async function finiteHumanFixture(){
 const author=await makeActor('PRIVATE_FINITE_AUTHOR'),reviewer=await makeActor('PRIVATE_FINITE_REVIEWER');
 await installSyntheticSpendCapability(author,{provider:'openai',model:defaultModelFor('openai')});
 const candidate=await createPromptAgentCandidate(author,{version:1,configuration:{kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}});
 const sent=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_configuration,args)=>{
  const fixed=HUMAN_PLAN_HOLDOUTS.find(row=>humanQuestionPrompt(row.question,row.locale)===args.prompt);
  if(!fixed)throw Error('Only exact checked-in human holdouts may reach this transport');
  expect(args.system).toBe(promptCandidateSystem({kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'}));
  expect(args.maxTokens).toBe(384);expect(args.timeoutMs).toBe(15000);
  expect(args.prompt).not.toContain('PRIVATE_FINITE');expect(args.prompt).not.toContain(author.userId!);expect(args.prompt).not.toContain(reviewer.userId!);
  args.onUsage?.({inputTokens:3,outputTokens:4,cachedInputTokens:0});return JSON.stringify({decision:fixed.decision,modules:fixed.modules});
 });
 const configuration=async(feature:AiFeatureId='module_agent_evaluation')=>withTenant(reviewer,async tx=>{
  const cfg=await resolveActiveAiConfig(tx,reviewer,feature);if(!cfg)throw Error('Missing actual issued configuration');
  return bindStrictAiSpendRoot(cfg,{rootTaskId:candidate.candidateId,kind:'evaluation'});
 });
 let sourceReads=0;
 const source=async(tx:Tx,current:SessionContext)=>{
  sourceReads++;const [row]=await tx.execute<{configuration:unknown;candidate_digest:string;source_digest:string;author_user_id:string}>(sql`select configuration,candidate_digest,source_digest,author_user_id from public.ai_agent_candidate where id=${candidate.candidateId}::uuid and tenant_id=${current.tenantId}::uuid`);
  if(!row||row.author_user_id===current.userId||row.candidate_digest!==candidate.candidateDigest||row.source_digest!==MODULE_AGENT_SOURCE_DIGEST)throw Error('Current finite candidate source changed');
  return {version:1,suite:'human_plan_holdouts_v1',suiteDigest:HUMAN_PLAN_SUITE_DIGEST,candidate:row.configuration,fixtureId:'en-pair'};
 };
 const prepare=async()=>preparePrivateAiTask(await configuration(),'synthetic_read_plan_v1',source);
 return {author,reviewer,sent,...candidate,configuration,source,prepare,sourceReads:()=>sourceReads};
}
// Carry the grant actually seeded for this login; flattened roles alone cannot authorize controls.
async function fixtureControlOwner():Promise<SessionContext>{
 const grants=await owner.db.execute<{role:'hr_admin';company_id:string|null}>(sql`select role,company_id from public.role_assignment where tenant_id=${base.tenantId}::uuid and app_user_id=${base.adminUserId}::uuid order by role,company_id`);
 expect([...grants]).toEqual([{role:'hr_admin',company_id:null}]);
 const ctx:SessionContext={...adminCtx(base),grants:grants.map(grant=>({role:grant.role,companyId:grant.company_id}))};
 await withTenant(ctx,async tx=>{const [proof]=await tx.execute<{current:boolean;group_admin:boolean}>(sql`select app.principal_snapshot_current() as current,app.is_group_admin() as group_admin`);expect(proof).toEqual({current:true,group_admin:true});});
 return ctx;
}
async function pauseFixtureFeature(ctx:SessionContext,feature:'hr_assistant'|'module_agent_evaluation'){
 await setAiFeature(ctx,feature,false);
 await withTenant(ctx,async tx=>{
  const rows=await tx.execute<{tenant_id:string;scope_key:string;feature_id:string;enabled:boolean;current:boolean;group_admin:boolean;unpaused:boolean}>(sql`select tenant_id,scope_key,feature_id,enabled,app.principal_snapshot_current() as current,app.is_group_admin() as group_admin,app.ai_action_unpaused(${feature}) as unpaused from public.ai_control_policy where tenant_id=${ctx.tenantId}::uuid and scope_key=${'feature:'+feature} and kind='feature' and feature_id=${feature}`);
  expect([...rows]).toEqual([{tenant_id:ctx.tenantId,scope_key:'feature:'+feature,feature_id:feature,enabled:false,current:true,group_admin:true,unpaused:false}]);
 });
}
async function finiteUsage(){const [row]=await owner.db.execute<{runs:number;reservations:number;roots:number}>(sql`select (select count(*)::int from public.ai_model_run where tenant_id=${base.tenantId}::uuid) as runs,(select count(*)::int from app.ai_spend_reservation where tenant_id=${base.tenantId}::uuid) as reservations,(select count(*)::int from app.ai_spend_root where tenant_id=${base.tenantId}::uuid) as roots`);return row;}

describe('fixed human holdout protected preparation and actual evaluation',()=>{
 it('refuses the roles-only control fixture without changing policy, then accepts its actual seeded group grant',async()=>{
  const control=await fixtureControlOwner(),policy=()=>owner.db.execute(sql`select * from public.ai_control_policy where tenant_id=${base.tenantId}::uuid and scope_key='feature:module_agent_evaluation'`),before=await policy();
  await expect(setAiFeature(adminCtx(base),'module_agent_evaluation',false)).rejects.toThrow('Only a group administrator');expect(await policy()).toEqual(before);
  await pauseFixtureFeature(control,'module_agent_evaluation');expect(await finiteUsage()).toEqual({runs:0,reservations:0,roots:0});
 });
 it('admits one genuine finite draft on its candidate root, replays its actual source and refuses one-use replay',async()=>{
  const a=await finiteHumanFixture(),task=await a.prepare();
  try{
   if(task.operation!=='draft')throw Error('Expected protected finite draft');
   expect(a.sourceReads()).toBe(1);expect(task.args.prompt).toBe('{"locale":"en","question":"I need my claim progress and my attendance status, please."}');
   expect(await finiteUsage()).toEqual({runs:0,reservations:0,roots:0});
   await expect(ai.generateDraft(task.configuration,task.args)).resolves.toBe('{"decision":"read","modules":["claims","attendance"]}');
   expect(a.sourceReads()).toBe(2);expect(a.sent).toHaveBeenCalledTimes(1);expect(await finiteUsage()).toEqual({runs:1,reservations:1,roots:1});
   await expect(ai.generateDraft(task.configuration,task.args)).rejects.toThrow();expect(a.sent).toHaveBeenCalledTimes(1);expect(await finiteUsage()).toEqual({runs:1,reservations:1,roots:1});
   const [accounting]=await owner.db.execute<{state:string;actual_tokens:number;root_id:string}>(sql`select r.state,r.actual_tokens::int as actual_tokens,s.root_id from public.ai_model_run r join app.ai_spend_reservation s on s.run_id=r.id where r.tenant_id=${base.tenantId}::uuid`);
   expect(accounting).toEqual({state:'completed',actual_tokens:7,root_id:a.candidateId});
  }finally{task.dispose();}
 });
 it('refuses raw, forged and copied configs, wrong feature/operation and changed exact input without transport or reservation',async()=>{
  const a=await finiteHumanFixture(),cfg=await a.configuration(),forgedRun=vi.fn();
  for(const copy of [{provider:cfg.provider,model:cfg.model,apiKey:'fictional'}, {...cfg,governance:{run:forgedRun}},{...cfg},JSON.parse(JSON.stringify(cfg))] as ResolvedAiConfig[])await expect(preparePrivateAiTask(copy,'synthetic_read_plan_v1',a.source)).rejects.toThrow();
  await expect(preparePrivateAiTask(await a.configuration('hr_assistant'),'synthetic_read_plan_v1',a.source)).rejects.toThrow();
  const task=await a.prepare();try{
   if(task.operation!=='draft')throw Error('Expected protected finite draft');
   await expect(ai.generateDraft({...task.configuration},task.args)).rejects.toThrow();
   await expect(ai.converse(task.configuration,{system:[task.args.system],turns:[{role:'user',content:task.args.prompt}],tools:[]})).rejects.toThrow();
   await expect(ai.generateDraft(task.configuration,{...task.args,prompt:task.args.prompt+' PRIVATE_CHANGED_INPUT'})).rejects.toThrow();
   expect(a.sent).not.toHaveBeenCalled();expect(forgedRun).not.toHaveBeenCalled();expect(await finiteUsage()).toEqual({runs:0,reservations:0,roots:0});
   // Invalid attempts cannot consume or replace the genuine capability.
   await expect(ai.generateDraft(task.configuration,task.args)).resolves.toContain('"decision":"read"');expect(a.sent).toHaveBeenCalledTimes(1);
  }finally{task.dispose();}
 });
 it.each(['disposed','expired'] as const)('refuses a genuinely prepared %s finite request before any admission',async state=>{
  const a=await finiteHumanFixture(),task=await a.prepare();try{
   if(task.operation!=='draft')throw Error('Expected protected finite draft');
   if(state==='disposed')task.dispose();else{const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+300001);}
   await expect(ai.generateDraft(task.configuration,task.args)).rejects.toThrow();expect(a.sent).not.toHaveBeenCalled();expect(await finiteUsage()).toEqual({runs:0,reservations:0,roots:0});
  }finally{vi.restoreAllMocks();task.dispose();}
 });
 it('detects actual candidate source drift after finite preparation at source replay, without admission',async()=>{
  const a=await finiteHumanFixture(),task=await a.prepare();try{
   if(task.operation!=='draft')throw Error('Expected protected finite draft');expect(a.sourceReads()).toBe(1);
   await owner.db.execute(sql`update public.ai_agent_candidate set source_digest=${'0'.repeat(64)} where id=${a.candidateId}::uuid`);
   await expect(ai.generateDraft(task.configuration,task.args)).rejects.toThrow();expect(a.sourceReads()).toBe(2);expect(a.sent).not.toHaveBeenCalled();expect(await finiteUsage()).toEqual({runs:0,reservations:0,roots:0});
  }finally{task.dispose();}
 });
 it('evaluates all twelve genuine fixed cases and retains only passed cases when retrying malformed and schema-valid wrong outcomes',async()=>{
  const a=await finiteHumanFixture(),normal=a.sent.getMockImplementation()!;
  a.sent.mockImplementation(async(cfg,args)=>{const valid=await normal(cfg,args);return args.prompt===humanQuestionPrompt(HUMAN_PLAN_HOLDOUTS[0].question,'en')?'not a plan':args.prompt===humanQuestionPrompt(HUMAN_PLAN_HOLDOUTS[1].question,'en')?JSON.stringify({decision:'read',modules:['claims','attendance']}):valid;});
  const failed=await evaluateHumanQuestionPlannerCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(failed).toMatchObject({state:'complete',attempted:12,completedCases:12,totalCases:12,knownFailures:2,retainedPasses:0});expect(a.sent).toHaveBeenCalledTimes(12);
  expect(await finiteUsage()).toEqual({runs:12,reservations:12,roots:1});
  a.sent.mockImplementation(normal);a.sent.mockClear();
  const repaired=await evaluateHumanQuestionPlannerCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(repaired).toMatchObject({state:'complete',attempted:2,completedCases:12,totalCases:12,knownFailures:0,retainedPasses:10});expect(a.sent).toHaveBeenCalledTimes(2);
  expect(a.sent.mock.calls.map(([,args])=>args.prompt)).toEqual(HUMAN_PLAN_HOLDOUTS.slice(0,2).map(row=>humanQuestionPrompt(row.question,row.locale)));expect(await finiteUsage()).toEqual({runs:14,reservations:14,roots:1});
  const [accounting]=await owner.db.execute<{completed:number;tokens:number;foreign_roots:number;held:number}>(sql`select count(*) filter(where r.state='completed')::int as completed,coalesce(sum(r.actual_tokens),0)::int as tokens,count(*) filter(where s.root_id<>${a.candidateId}::uuid)::int as foreign_roots,count(*) filter(where s.state='held')::int as held from public.ai_model_run r join app.ai_spend_reservation s on s.run_id=r.id where r.tenant_id=${base.tenantId}::uuid`);expect(accounting).toEqual({completed:14,tokens:98,foreign_roots:0,held:14});
  await expect(evaluateHumanQuestionPlannerCandidate(a.author,{candidateId:a.candidateId,consent:consent()})).rejects.toThrow();expect(a.sent).toHaveBeenCalledTimes(2);expect(await finiteUsage()).toEqual({runs:14,reservations:14,roots:1});
 });
 it('retains the native blocked ledger when evaluation itself is paused after finite preparation',async()=>{
  const a=await finiteHumanFixture(),control=await fixtureControlOwner(),original=ai.generateDraft;let afterPreparation=false,setupFailure:unknown;
  vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{if(!afterPreparation){try{await pauseFixtureFeature(control,'module_agent_evaluation');afterPreparation=true;}catch(error){setupFailure=error;throw error;}}return original(cfg,args);});
  const result=await evaluateHumanQuestionPlannerCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
  expect(setupFailure).toBeUndefined();expect(afterPreparation).toBe(true);expect(result).toMatchObject({state:'incomplete',attempted:12,completedCases:0,knownFailures:0});expect(a.sent).not.toHaveBeenCalled();
  // The canonical admission owner records refusals; these are not provider calls or spend roots.
  expect(await finiteUsage()).toEqual({runs:12,reservations:0,roots:0});
  const [blocked]=await owner.db.execute<{paused:number;admitted:number}>(sql`select count(*) filter(where state='blocked' and reason='paused')::int as paused,count(*) filter(where state<>'blocked')::int as admitted from public.ai_model_run where tenant_id=${base.tenantId}::uuid`);expect(blocked).toEqual({paused:12,admitted:0});
 });
 it.each(['candidate','provider','principal','assistant','pause'] as const)('refuses actual evaluator %s drift after real preparation and before provider dispatch',async change=>{
  const a=await finiteHumanFixture(),control=change==='pause'?await fixtureControlOwner():null,original=ai.generateDraft;let afterPreparation=false,setupFailure:unknown;
  vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{
   if(!afterPreparation){try{
    if(change==='candidate')await owner.db.execute(sql`update public.ai_agent_candidate set source_digest=${'0'.repeat(64)} where id=${a.candidateId}::uuid`);
    if(change==='provider')vi.stubEnv('OPENAI_API_KEY','fictional-rotated-after-preparation');
    if(change==='principal')await owner.db.execute(sql`update public.app_user set archived_at=now() where id=${a.reviewer.userId}::uuid`);
    if(change==='assistant')await revokeAssistant(adminCtx(base),{appUserId:a.reviewer.userId!});
    if(change==='pause')await pauseFixtureFeature(control!,'hr_assistant');
    afterPreparation=true;
   }catch(error){setupFailure=error;throw error;}}
   return original(cfg,args);
  });
  const outcome=await evaluateHumanQuestionPlannerCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()}).then(value=>value,()=>null);
  expect(setupFailure).toBeUndefined();expect(afterPreparation).toBe(true);if(outcome)expect(outcome).toMatchObject({state:'incomplete',completedCases:0});
  expect(a.sent).not.toHaveBeenCalled();expect(await finiteUsage()).toEqual({runs:0,reservations:0,roots:0});
 });
});
