/** Native leave admission, retention and history. Provider transport and disclosure review are fictional. */
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NextIntlClientProvider} from 'next-intl';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createCompany,createDepartment,updateLeaveType} from '../core/admin';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {askAssistant} from '../core/assistant';
import {eraseOwnAssistantHistory} from '../core/assistant-history-retention';
import {withAssistantRead,withAssistantAdmissionReadsTx} from '../core/assistant-read-session';
import {ASSISTANT_TOOLS,specsFor} from '../core/assistant-tools';
import {loadAiWorkspace} from '../core/ai-workspace';
import {assistantHistoryReplay,assistantSourceReplay} from '../core/assistant-disclosure-read';
import {assistantSourceDigest,sealAssistantDisclosure} from '../lib/ai/assistant-disclosure';
import {serializeAgentReadResult} from '../lib/ai/agent-read-batch';
import {prepareAssistantConversation} from '../core/assistant-provider-input';
import {preparePrivateAiTask} from '../core/ai-governance';
import {bindAiSpendTaskTx} from '../core/ai-spend-task';
import {assertAiCentreRunningTx} from '../core/ai-centre-control';
import {lockLeaveDependenciesTx,lockLeaveDependencyReadConfigurationTx} from '../core/leave-dependency-lock';
import {applyLeaveAdjustmentBatch} from '../packs/leave/service';
import {assistantQuestionBudgetBinding,completeAssistantQuestionBudgetTx} from '../core/assistant-question-budget';
import {prepareAssistantConversationStrategyTx,completeAssistantConversationStrategyTx,recheckAssistantConversationStrategyTx,retireAssistantConversationStrategyCapability} from '../core/module-agent-releases';
import {agentReviewWorkspaceTx,createConversationAgentCandidate,eraseOwnConversationStrategyMetadata,promoteConversationAgentCandidate,rollbackAssistantPromotion} from '../core/module-agent-releases';
import {leaveEvaluationCaseSetDigest,signPairedLeaveEvaluation} from '../lib/ai/assistant-leave-evaluation-receipt';
import {routingDigest} from '../lib/ai/module-agent-routing';
import {ASSISTANT_LOCAL_LEAVE_VARIANT} from '../lib/ai/assistant-conversation-candidate';
import {ASSISTANT_PRIVATE_CONTRACT,adjudicatePrivateAssistantTerminal,capturePrivateAssistantTask,privateAssistantCatalogue} from '../lib/ai/provider-assistant-policy';
import {adjudicateAssistantAnswerPlan} from '../lib/ai/assistant-answer-plan';
import {isGroundedToolName,presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
import {AiPrivacyGateError} from '../lib/ai/provider-privacy-error';
import * as providerReviews from '../lib/ai/provider-data-reviews';
import {AiGatewayError} from '../lib/ai/types';
import {resolveActiveAiConfig} from '../core/ai-config';
import {converse} from '../lib/ai';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {ConverseArgs,ConverseResult} from '../lib/ai/types';
import {selectProtectedLeaveCount} from '../lib/ai/assistant-leave-count';
import {AiManagementScreen} from '../app/control-tower/agents/screen';
import {enWithAiCentre} from './helpers/ai-centre-messages';

vi.mock('next-intl/server',async()=>{
 const {createFormatter,createTranslator}=await import('next-intl');
 const {enWithAiCentre}=await import('./helpers/ai-centre-messages');
 return {
  getTranslations:async(namespace:'aiManagement'|'aiCentre'|'controlTower')=>createTranslator({locale:'en',messages:enWithAiCentre,namespace}),
  getLocale:async()=> 'en',
  getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'}),
 };
});

async function renderWorkers(session:SessionContext){
 const screen=await AiManagementScreen({session,section:'features',searchParams:Promise.resolve({})});
 return renderToStaticMarkup(createElement(NextIntlClientProvider,{locale:'en',messages:enWithAiCentre,children:screen}));
}
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-visible-source-passphrase');vi.stubEnv('OPENAI_API_KEY','fictional-visibility-key');
 for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 // The proposed build awaits real source review. All provider transports in this file are intercepted.
 vi.spyOn(providerReviews,'assertProviderDataContractReviewed').mockImplementation(contract=>{
  if(contract!==ASSISTANT_PRIVATE_CONTRACT)throw new AiPrivacyGateError('unreviewed');
 });
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function fixture(role: 'employee'|'hr_admin'='employee'){const admin=adminCtx(base);await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:113.75,validFrom:'2020-01-01'});
 const mine=await hireEmployee(admin,{person:{fullName:'Fictional Mine Visibility',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,
  departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,mine.personId,role);await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,[role]),userId,personId:mine.personId,roles:[role],grants:[{role,companyId:null}]};
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId:base.annualLeaveTypeId,
  entryType:'accrual',days:'113.75',effectiveOn:todayInKualaLumpur()});return {admin,ctx,userId,employmentId:mine.employmentId};}
const response:ConverseResult={text:'Fictional response',stop:'end',toolCalls:[],usageReported:true,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0}};
describe('actual Mine flags bind current provider input and historical source disclosure',()=>{
 it('registers, promotes, serves and rolls back the local leave candidate through native owners',async()=>{
  const {admin,ctx,userId:authorId}=await fixture('hr_admin');
  async function participant(name:string,role:'employee'|'hr_admin'='hr_admin'){
   const person=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},
    companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
   const userId=await createAppUser(base.tenantId,person.personId,role);
   await grantAssistant(admin,{appUserId:userId});
   return {...await entitledCtx(base,[role]),userId,personId:person.personId,roles:[role],
    grants:[{role,companyId:null}]} satisfies SessionContext;
  }
  const employee=await participant('Fictional Leave Employee','employee');
  const reviewer=await participant('Fictional Leave Reviewer');
  const second=await participant('Fictional Second Leave Reviewer');
  const promoter=await participant('Fictional Leave Approver');
  const nomination={version:2,configuration:{kind:'assistant_answer_prompt_v1',variant:ASSISTANT_LOCAL_LEAVE_VARIANT}};
  const review=(actor:SessionContext)=>withTenant(actor,tx=>agentReviewWorkspaceTx(tx,actor));
  expect((await review(ctx))?.localLeaveRegistrationAvailable).toBe(false);
  await expect(createConversationAgentCandidate(ctx,nomination)).rejects.toThrow('Agent review could not be confirmed');
  const old=await createConversationAgentCandidate(ctx,{version:1,configuration:{kind:'assistant_answer_prompt_v1',variant:'focused_v1'}});
  const [constraint]=await owner.db.execute<{name:string;definition:string}>(sql`select conname as name,pg_get_constraintdef(oid) as definition
   from pg_constraint where conrelid='public.ai_agent_candidate'::regclass and contype='c'
   and pg_get_constraintdef(oid) like '%focused_v1%'`);
  expect(constraint?.definition).toContain('focused_v1');
  const draft=readFileSync('docs/research/assistant-local-leave-candidate.draft.sql','utf8');
  const activityDraft=readFileSync('docs/research/assistant-model-free-activity.draft.sql','utf8');
  const activity=(actor:SessionContext)=>withTenant(actor,async tx=>{
   const [row]=await tx.execute<{count:number}>(sql`select app.assistant_model_free_answer_activity()::int as count`);
   return row.count;
  },{readOnlySnapshot:true});
  await owner.db.transaction(async tx=>{
   const [original]=await tx.execute<{role:string}>(sql`select pg_get_userbyid(relowner) as role
    from pg_class where oid='public.ai_agent_candidate'::regclass`);
   // The hosted template was migrated by the fixture administrator. Recreate production
   // ownership for this exact DDL, then restore the fixture owner before any application call.
   const [activityOwners]=await tx.execute<{schema:string;tenant:string;quota:string;principal:string}>(sql`
    select pg_get_userbyid(nspowner) as schema,
     (select pg_get_userbyid(relowner) from pg_class where oid='public.tenant'::regclass) as tenant,
     (select pg_get_userbyid(relowner) from pg_class where oid='app.assistant_question_budget'::regclass) as quota,
     (select pg_get_userbyid(proowner) from pg_proc where oid='app.principal_snapshot_current()'::regprocedure) as principal
    from pg_namespace where nspname='app'`);
   await tx.execute(sql`alter table public.ai_agent_candidate owner to ai_hr_owner`);
   await tx.execute(sql`alter schema app owner to ai_hr_owner`);
   await tx.execute(sql`alter table public.tenant owner to ai_hr_owner`);
   await tx.execute(sql`alter table app.assistant_question_budget owner to ai_hr_owner`);
   await tx.execute(sql`set local role ai_hr_owner`);
   const [role]=await tx.execute<{name:string;superuser:boolean;createrole:boolean;bypassrls:boolean}>(sql`
    select current_user as name,rolsuper as superuser,rolcreaterole as createrole,rolbypassrls as bypassrls
    from pg_roles where rolname=current_user`);
   expect(role).toEqual({name:'ai_hr_owner',superuser:false,createrole:false,bypassrls:false});
   await tx.execute(sql.raw(draft));
   for(const statement of activityDraft.split('--> statement-breakpoint'))await tx.execute(sql.raw(statement));
   await tx.execute(sql`reset role`);
   // Match the runtime owner of the existing principal proof in this migrated test database.
   await tx.execute(sql`alter function app.assistant_model_free_answer_activity() owner to ${sql.identifier(activityOwners.principal)}`);
   await tx.execute(sql`alter table public.ai_agent_candidate owner to ${sql.identifier(original.role)}`);
   await tx.execute(sql`alter table app.assistant_question_budget owner to ${sql.identifier(activityOwners.quota)}`);
   await tx.execute(sql`alter table public.tenant owner to ${sql.identifier(activityOwners.tenant)}`);
   await tx.execute(sql`alter schema app owner to ${sql.identifier(activityOwners.schema)}`);
  });
  try{
   const [foreign]=await owner.db.insert(schema.tenant).values({workosOrgId:randomUUID(),name:'Other fictional tenant'}).returning({id:schema.tenant.id});
   await owner.db.execute(sql`insert into app.assistant_model_free_answer_day (tenant_id,question_day,answer_count)
    values (${foreign.id}::uuid,${todayInKualaLumpur()}::date,9),
     (${base.tenantId}::uuid,${todayInKualaLumpur()}::date-30,7),
     (${base.tenantId}::uuid,${todayInKualaLumpur()}::date+1,5)`);
   expect(await activity(promoter)).toBe(0);
   expect(await renderWorkers(promoter)).toContain('No grounded answers without a model recorded');
   const companyHr={...promoter,grants:[{role:'hr_admin',companyId:base.companyId}]} satisfies SessionContext;
   for(const actor of [employee,companyHr]){
    await expect(activity(actor)).rejects.toMatchObject({cause:{code:'42501'}});
   }
   await expect(withTenant(promoter,tx=>tx.execute(sql`select * from app.assistant_model_free_answer_day`)))
    .rejects.toMatchObject({cause:{code:'42501'}});
   expect((await review(ctx))?.localLeaveRegistrationAvailable).toBe(true);
   await expect(createConversationAgentCandidate(employee,nomination)).rejects.toThrow();
   await expect(createConversationAgentCandidate(ctx,{...nomination,signalIds:[randomUUID()]})).rejects.toThrow();
   const created=await createConversationAgentCandidate(ctx,nomination);
   expect(created.state).toBe('unevaluated');
   const [binding]=await owner.db.execute<{baselineDigest:string;sourceDigest:string}>(sql`
    select baseline_digest as "baselineDigest",source_digest as "sourceDigest" from public.ai_agent_candidate where id=${created.candidateId}::uuid`);
   const [legacy]=await owner.db.execute(sql`select candidate_digest from public.ai_agent_candidate where id=${old.candidateId}::uuid`);
   expect(legacy.candidate_digest).toBe(old.candidateDigest);

   const trial=(actor:SessionContext)=>review(actor).then(view=>view?.localLeaveTrials.find(row=>row.id===created.candidateId));
   expect(await review(employee)).toBeNull();
   expect((await review(ctx))?.conversationCandidates.map(row=>row.id)).toEqual([old.candidateId]);
   const request={candidateId:created.candidateId,maxJobs:4,hours:1};
   vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_BUNDLE','');
   vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256','');
   expect(await trial(promoter)).toEqual({id:created.candidateId,version:2,state:'needsEvidence',promotion:null,evaluationBinding:null});
   expect((await trial(ctx))?.evaluationBinding).toEqual({
    tenantId:base.tenantId,authorId,candidateDigest:created.candidateDigest,...binding,
   });
   await expect(promoteConversationAgentCandidate(promoter,request)).rejects.toThrow();
   const keys=[generateKeyPairSync('ed25519'),generateKeyPairSync('ed25519')];
   const now=new Date(),expiresAt=new Date(now.getTime()+15*60_000).toISOString();
   const generationOptions={temperature:0,seed:42,num_predict:512};
   const plan={version:2,trialId:randomUUID(),tenantId:base.tenantId,authorId,approverId:promoter.userId,
    candidateSha:'c'.repeat(40),candidateDigest:created.candidateDigest,...binding,modelDigest:'d'.repeat(64),
    answerFormatDigest:routingDigest('json'),generationOptionsDigest:routingDigest(generationOptions),
    committedAt:now.toISOString(),expiresAt,
    evaluators:[reviewer,second].map((actor,index)=>({id:actor.userId,
     publicKey:keys[index].publicKey.export({format:'jwk'}).x,holdoutDigest:routingDigest(['fictional',index]),
     caseDigests:Array.from({length:4},(_,caseIndex)=>routingDigest(['fictional',index,caseIndex])),minimumSavedCalls:2}))};
   const bytes=Buffer.from(JSON.stringify(plan)),digest=createHash('sha256').update(bytes).digest('hex');
   // Fictional signed aggregates exercise the authorization path. No model quality is inferred from them.
   const receipts=plan.evaluators.map((item,index)=>signPairedLeaveEvaluation(bytes,digest,item.id,{
    evidence:'offline_paired_leave_routing_holdout',scope:'single_active_own_employment',
    candidateSha:plan.candidateSha,modelDigest:plan.modelDigest,answerFormatDigest:plan.answerFormatDigest,
    holdoutDigest:item.holdoutDigest,caseSetDigest:leaveEvaluationCaseSetDigest(item.caseDigests),minimumSavedCalls:2,generationOptions,model:'fictional:fixture',
    cases:4,expectedDirect:2,correctDirect:2,correctDeferrals:2,wrongDirect:0,unexpectedDirect:0,missedDirect:0,
    meetsThreshold:true,releaseAuthorized:false,baselineCalls:2,baselineCorrect:2,baselineRejected:0,
    candidateFallbackCalls:0,candidateCorrect:2,gains:0,regressions:0,savedCalls:2,baselineInputTokens:18,baselineOutputTokens:8,
   },keys[index].privateKey,now));
   const bundle=JSON.stringify({plan:bytes.toString('base64url'),receipts});
   vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_BUNDLE',bundle);
   vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256','0'.repeat(64));
   await expect(promoteConversationAgentCandidate(promoter,request)).rejects.toThrow();
   vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256',digest);
   expect(await trial(reviewer)).toMatchObject({state:'needsApprover'});
   expect(await trial(ctx)).toMatchObject({state:'needsApprover'});
   expect(await trial(promoter)).toMatchObject({state:'ready'});
   await expect(promoteConversationAgentCandidate(ctx,request)).rejects.toThrow();
   await expect(promoteConversationAgentCandidate(reviewer,request)).rejects.toThrow();
   const promotion=await promoteConversationAgentCandidate(promoter,request);
   expect(promotion).toMatchObject({coverage:'paired-offline-leave-routing',maxJobs:4});
   expect(Date.parse(promotion.expiresAt)).toBe(Date.parse(expiresAt));

   const transport=vi.spyOn(openaiAdapter,'converse').mockRejectedValue(Error('Unexpected provider call.'));
   const ask=()=>askAssistant(ctx,{question:'My leave balance'});
   const served=await ask();
   expect(served).toMatchObject({stop:'end',turns:0,toolsUsed:['my_leave_balances']});
   expect(transport).not.toHaveBeenCalled();
   const [exchange]=await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.id,served.exchangeId));
   expect(exchange).toMatchObject({appUserId:authorId,provider:null,model:null,inputTokens:0,outputTokens:0});
   expect(await owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,base.tenantId))).toEqual([]);
   const [quota]=await owner.db.execute<{root_id:string;exchange_id:string;accounted_tokens:number;completed:boolean}>(sql`
    select root_id::text,exchange_id::text,accounted_tokens::int,completed_at is not null as completed
    from app.assistant_question_budget where tenant_id=${base.tenantId}::uuid and user_id=${authorId}::uuid`);
   expect(quota).toMatchObject({exchange_id:served.exchangeId,accounted_tokens:0,completed:true});
   expect(await activity(promoter)).toBe(1);
   const workers=await renderWorkers(promoter);
   expect(workers).toContain('1 grounded answer without a model');
   expect(workers).not.toContain('113.75');
   expect(workers).not.toContain('Fictional Mine Visibility');
   expect(await renderWorkers(companyHr)).not.toContain('grounded answer without a model');
   const transcript=await withTenant(promoter,tx=>tx.select({id:schema.assistantExchange.id}).from(schema.assistantExchange)
    .where(eq(schema.assistantExchange.id,served.exchangeId)));
   expect(transcript).toEqual([]);
   await withTenant(ctx,tx=>tx.execute(sql`
    select app.assistant_question_budget_complete(${quota.root_id}::uuid,${served.exchangeId}::uuid)`));
   expect(await activity(promoter)).toBe(1);
   expect(await trial(promoter)).toMatchObject({state:'windowOpen',
    promotion:{id:promotion.promotionId,used:1,maximum:4,retired:false,ownOutcomes:null}});
   expect((await review(promoter))?.conversationPromotions).toEqual([]);
   expect((await trial(ctx))?.promotion?.ownOutcomes).toEqual({retainedExchanges:1,modelFreeAnswers:1,modelResponses:0});
   const history=await loadAiWorkspace(ctx,{selectedExchangeId:served.exchangeId,includeGovernance:false});
   expect(history.history[0].grounded?.mode).toBe('grounded');
   expect(JSON.stringify(history.history[0].grounded)).toContain('113.75');

   transport.mockImplementationOnce(async(_config,args)=>{
    const turn=args.turns[0];
    if(turn?.role!=='user')throw Error('Expected a protected work catalogue.');
    const {local}=capturePrivateAssistantTask(JSON.parse(turn.content));
    if(local.operation!=='conversation')throw Error('Expected a protected conversation.');
    for(const read of local.reads)for(const card of read.cards){
     const fact=card.facts.find(candidate=>candidate.available);
     if(fact)return {...response,text:JSON.stringify({version:1,mode:'answer',
      blocks:[{kind:'fact',read:read.read,card:card.card,fact:fact.fact}]})};
    }
    throw Error('Expected a fictional capability fact.');
   });
   await expect(askAssistant(ctx,{question:'show assistant capabilities'})).resolves.toMatchObject({turns:1});
   expect((await trial(ctx))?.promotion?.ownOutcomes).toEqual({retainedExchanges:2,modelFreeAnswers:1,modelResponses:1});

   // Capture a native capability before withdrawing the pinned evidence.
   const inflight=await withTenant(ctx,async tx=>{
    const configuration=await resolveActiveAiConfig(tx,ctx,'hr_assistant');
    if(!configuration)throw Error('Expected the fictional Assistant provider.');
    const rooted=await bindAiSpendTaskTx(tx,ctx,configuration,{kind:'assistant_question'});
    return prepareAssistantConversationStrategyTx(tx,ctx,rooted,'My leave balance');
   });
   expect(inflight.provenance.mode).toBe('promoted');
   vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_BUNDLE','');
   expect(await trial(promoter)).toMatchObject({state:'withdrawn',promotion:{used:3,maximum:4}});
   try{
    await expect(withTenant(ctx,tx=>recheckAssistantConversationStrategyTx(tx,ctx,inflight.capability))).rejects.toThrow();
   }finally{retireAssistantConversationStrategyCapability(inflight.capability);}
   expect((await trial(ctx))?.promotion?.ownOutcomes).toEqual({retainedExchanges:2,modelFreeAnswers:1,modelResponses:1});
   transport.mockImplementation(async(_config,args)=>{
    const turn=args.turns[0];
    if(turn?.role!=='user')throw Error('Expected a protected fallback catalogue.');
    const {local}=capturePrivateAssistantTask(JSON.parse(turn.content));
    expect(local.strategy).toBe('baseline_v1');
    const selection=selectProtectedLeaveCount(local);
    if(!selection)throw Error('Expected the fictional canonical leave count.');
    return {...response,text:JSON.stringify({version:1,mode:'answer',blocks:[selection]})};
   });
   await expect(ask()).resolves.toMatchObject({turns:1});
   vi.stubEnv('AIHR_LOCAL_LEAVE_TRIAL_BUNDLE',bundle);
   await rollbackAssistantPromotion(promoter,{promotionId:promotion.promotionId,reason:'human'});
   expect(await trial(promoter)).toMatchObject({state:'rolledBack',promotion:{used:3,retired:true}});
   await expect(promoteConversationAgentCandidate(promoter,request)).rejects.toThrow();
   await expect(ask()).resolves.toMatchObject({turns:1});
   expect(transport).toHaveBeenCalledTimes(3);
   expect((await trial(ctx))?.promotion?.ownOutcomes).toEqual({retainedExchanges:2,modelFreeAnswers:1,modelResponses:1});
   await expect(askAssistant(ctx,{question:'Hello'})).resolves.toMatchObject({turns:0});
   expect(await activity(promoter)).toBe(1);
   const erased=await eraseOwnAssistantHistory(ctx);
   expect(erased.retired).toBeGreaterThan(0);
   expect(await activity(promoter)).toBe(1);
   expect(await renderWorkers(promoter)).toContain('1 grounded answer without a model');
   await eraseOwnConversationStrategyMetadata(ctx);
   expect((await trial(ctx))?.promotion?.ownOutcomes).toEqual({retainedExchanges:0,modelFreeAnswers:0,modelResponses:0});
   const [used]=await owner.db.execute(sql`select used_jobs::int as used from public.ai_agent_promotion where id=${promotion.promotionId}::uuid`);
   expect(used).toEqual({used:3});
  }finally{
   // Vitest can reuse this worker's database. Remove both drafts and restore the exact original CHECK.
   await owner.db.transaction(async tx=>{
    await tx.execute(sql`drop trigger assistant_record_model_free_answer on app.assistant_question_budget`);
    await tx.execute(sql`drop function app._record_assistant_model_free_answer()`);
    await tx.execute(sql`drop function app.assistant_model_free_answer_activity()`);
    await tx.execute(sql`drop table app.assistant_model_free_answer_day`);
   });
   await resetDb();
   await owner.db.transaction(async tx=>{
    const name=sql.identifier(constraint.name);
    await tx.execute(sql`alter table public.ai_agent_candidate drop constraint ai_agent_candidate_assistant_local_leave_configuration_check`);
    await tx.execute(sql`alter table public.ai_agent_candidate add constraint ${name} ${sql.raw(constraint.definition)}`);
   });
  }
 },90_000);

 it.each(['visibility','balance'] as const)('retires in-flight Assistant content after a native %s change and settles the actual usage',async change=>{
  const {admin,ctx,userId,employmentId}=await fixture();
  const transport=vi.spyOn(openaiAdapter,'converse').mockImplementation(async(_config,args)=>{
   const turn=args.turns[0];
   if(turn?.role!=='user')throw Error('Expected a masked Assistant catalogue.');
   const selected=selectProtectedLeaveCount(capturePrivateAssistantTask(JSON.parse(turn.content)).local);
   expect(selected).toMatchObject({kind:'fact',read:0,card:0});
   if(change==='visibility')await updateLeaveType(admin,{id:base.annualLeaveTypeId,name:'Annual Leave',essViewConfig:{available:false}});
   else await applyLeaveAdjustmentBatch(admin,{leaveTypeIds:[base.annualLeaveTypeId],employmentIds:[employmentId],
    targetMode:'individual',effectiveOn:todayInKualaLumpur(),days:5,reason:'Fictional in-flight leave correction'});
   return {...response,text:JSON.stringify({version:1,mode:'answer',blocks:[selected]}),
    usage:{inputTokens:7,outputTokens:5,cachedInputTokens:0}};
  });
  await expect(askAssistant(ctx,{question:'My leave balance'})).rejects.toMatchObject({code:'provider_error'});
  expect(transport).toHaveBeenCalledOnce();
  const [exchange]=await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.appUserId,userId));
  expect(exchange).toMatchObject({question:'',answer:null,disclosureReceipt:null,toolCalls:[],inputTokens:7,outputTokens:5});
  expect(exchange.contentRetiredAt).toBeInstanceOf(Date);
  const [quota]=await owner.db.execute(sql`select exchange_id::text,accounted_tokens::int,completed_at is not null as completed
   from app.assistant_question_budget where tenant_id=${base.tenantId}::uuid and user_id=${userId}::uuid`);
  expect(quota).toEqual({exchange_id:exchange.id,accounted_tokens:12,completed:true});
  const [usage]=await owner.db.select().from(schema.assistantUsage).where(eq(schema.assistantUsage.tenantId,base.tenantId));
  expect(usage).toMatchObject({exchangeCount:1,inputTokens:7,outputTokens:5});
 });

 it.each(['visibility','balance'] as const)('rehearses zero-provider leave accounting across a concurrent %s edit',async change=>{
  const {admin,ctx,userId,employmentId}=await fixture();
  const transport=vi.spyOn(openaiAdapter,'converse').mockRejectedValue(Error('No model request is expected.'));
  await owner.db.insert(schema.assistantBudget).values({
   tenantId:base.tenantId,effectiveFrom:todayInKualaLumpur(),perUserDailyQuestions:2,monthlyTokenCeiling:1000,
  });
  const question='My leave balance';
  const tool=ASSISTANT_TOOLS.find(row=>row.spec.name==='my_leave_balances')!;
  async function prepareLocalLeave(){
   const reservation=await withTenant(ctx,async tx=>{
    const cfg=await resolveActiveAiConfig(tx,ctx,'hr_assistant');
    if(!cfg)throw Error('Missing fictional configured gateway.');
    const rooted=await bindAiSpendTaskTx(tx,ctx,cfg,{kind:'assistant_question'});
    const {period,reservation}=assistantQuestionBudgetBinding(ctx,rooted);
    const strategy=await prepareAssistantConversationStrategyTx(tx,ctx,rooted,question);
    return {period,reservation,strategy};
   });
   const result=await tool.run(ctx,{});
   const presentation=presentGroundedToolOutcome('my_leave_balances',result);
   if(!result.ok||!presentation)throw Error('Missing canonical leave source.');
   const reads=[{read:0,presentation,explanations:[]}];
   const catalogue=privateAssistantCatalogue('leave_available',reads,reservation.strategy.variant);
   const selected=selectProtectedLeaveCount(catalogue);
   if(!selected)throw Error('Expected one visible canonical leave count.');
   const terminal=JSON.stringify({version:1,mode:'answer',blocks:[selected]});
   const plan=adjudicateAssistantAnswerPlan(adjudicatePrivateAssistantTerminal(terminal,catalogue),reads);
   return {...reservation,plan,evidence:[{name:'my_leave_balances',input:{},digest:assistantSourceDigest(result)}]};
  }
  // Model-free rehearsal only. Serving still uses its currently approved admission path.
  async function persistLocalLeave(draft:Awaited<ReturnType<typeof prepareLocalLeave>>,afterReplay?:()=>Promise<void>){
   const exchangeId=randomUUID(),answer=JSON.stringify(draft.plan);
   const binding={tenantId:base.tenantId,userId,exchangeId,question,answer};
   try {
    await withTenant(ctx,async tx=>{
     await assertAiCentreRunningTx(tx,ctx);
     await lockLeaveDependencyReadConfigurationTx(tx,ctx.tenantId);
     const valid=await withAssistantAdmissionReadsTx(ctx,tx,async read=>{
      const [subject,...others]=await read.myEmployments();
      if(!subject||others.length)throw Error('Expected one active own employment.');
      await lockLeaveDependenciesTx(tx,ctx.tenantId,[subject.employmentId]);
      return assistantSourceReplay(ctx,read)(draft.evidence);
     });
     if(!valid)throw Error('The canonical leave source changed.');
     await afterReplay?.();
     const disclosureReceipt=sealAssistantDisclosure(binding,draft.evidence,draft.plan);
     if(!disclosureReceipt)throw Error('The current source did not yield a disclosure receipt.');
     await tx.insert(schema.assistantExchange).values({id:exchangeId,tenantId:base.tenantId,appUserId:userId,
      question,answer,disclosureReceipt,stop:'end',turnCount:0,inputTokens:0,outputTokens:0,cachedInputTokens:0});
     await completeAssistantConversationStrategyTx(tx,ctx,draft.strategy.capability,exchangeId);
     await tx.insert(schema.assistantUsage).values({tenantId:base.tenantId,period:draft.period,
      inputTokens:0,outputTokens:0,cachedInputTokens:0,exchangeCount:1});
     await completeAssistantQuestionBudgetTx(tx,ctx,draft.reservation,exchangeId);
    });
   } finally {retireAssistantConversationStrategyCapability(draft.strategy.capability);}
   return exchangeId;
  }
  const changeSource=()=>change==='visibility'
   ? updateLeaveType(admin,{id:base.annualLeaveTypeId,name:'Annual Leave',essViewConfig:{available:false}})
   : applyLeaveAdjustmentBatch(admin,{leaveTypeIds:[base.annualLeaveTypeId],employmentIds:[employmentId],
    targetMode:'individual',effectiveOn:todayInKualaLumpur(),days:5,reason:'Fictional leave balance correction'});
  const visible=await persistLocalLeave(await prepareLocalLeave(),async()=>{
   await expect(changeSource()).rejects.toMatchObject({name:'LeaveDependencyUnavailable',reason:'busy'});
  });
  const before=await loadAiWorkspace(ctx,{selectedExchangeId:visible,includeGovernance:false});
  expect(before.history[0].grounded?.mode).toBe('grounded');
  expect(JSON.stringify(before.history[0].grounded)).toContain('113.75');

  const stale=await prepareLocalLeave();
  await changeSource();
  await expect(persistLocalLeave(stale)).rejects.toThrow('The canonical leave source changed.');
  if(change==='balance'){
   const current=await tool.run(ctx,{});
   expect(current.ok).toBe(true);
   const facts=presentGroundedToolOutcome('my_leave_balances',current)?.cards.flatMap(card=>card.facts);
   expect(facts).toContainEqual(expect.objectContaining({field:'available',value:118.75}));
  }
  await expect(askAssistant(ctx,{question})).rejects.toMatchObject({code:'budget_daily'});
  expect(transport).not.toHaveBeenCalled();
  expect(await owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,base.tenantId))).toEqual([]);
  const rows=await owner.db.execute(sql`select exchange_id::text,accounted_tokens::int,completed_at is not null as completed from app.assistant_question_budget
   where tenant_id=${base.tenantId}::uuid and user_id=${userId}::uuid order by exchange_id nulls last`);
  expect([...rows]).toEqual([{exchange_id:visible,accounted_tokens:0,completed:true},{exchange_id:null,accounted_tokens:0,completed:false}]);
  const after=await loadAiWorkspace(ctx,{selectedExchangeId:visible,includeGovernance:false});
  expect(after.history.map(row=>({id:row.id,answer:row.answer,mode:row.grounded?.mode})))
   .toEqual([{id:visible,answer:null,mode:'unavailable'}]);
  const [usage]=await owner.db.select().from(schema.assistantUsage).where(eq(schema.assistantUsage.tenantId,base.tenantId));
  expect(usage).toMatchObject({exchangeCount:1,inputTokens:0,outputTokens:0,cachedInputTokens:0});
 });

 it.each(['selected','sibling'] as const)('replays the own employment choice and withdraws it after a %s balance change',async change=>{
  const {admin,ctx,employmentId}=await fixture();
  const companyName='Fictional Second Leave Company';
  const company=await createCompany(admin,{legalName:companyName,country:'MY',currency:'MYR'});
  const department=await createDepartment(admin,{companyId:company.id,name:'Fictional Second Leave Department'});
  const selected=await hireEmployee(admin,{person:{id:ctx.personId!},companyId:company.id,departmentId:department.id,
   employmentType:'full_time',hiredOn:'2020-01-01'});
  await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:selected.employmentId,
   leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'47.25',effectiveOn:todayInKualaLumpur()});

  const transport=vi.spyOn(openaiAdapter,'converse').mockImplementation(async(_configuration,args)=>{
   expect(args.tools).toEqual([]);
   const turn=args.turns[0];
   if(turn?.role!=='user')throw Error('Expected the closed leave catalogue.');
   expect(turn.content).not.toMatch(/Fictional|113\.75|47\.25/);
   const {local}=capturePrivateAssistantTask(JSON.parse(turn.content));
   const fact=selectProtectedLeaveCount(local);
   if(!fact)throw Error('Expected exactly one selected leave balance.');
   return {...response,text:JSON.stringify({version:1,mode:'answer',blocks:[fact]})};
  });
  const history=async(exchangeId:string)=>{
   const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:exchangeId,includeGovernance:false});
   return workspace.history.find(row=>row.id===exchangeId);
  };
  const prompt=await askAssistant(ctx,{question:'My leave balance'});
  expect(prompt.turns).toBe(0);
  expect((await history(prompt.exchangeId))?.grounded?.conversation?.plan).toEqual({version:1,mode:'clarify',slot:'employment'});
  expect(transport).not.toHaveBeenCalled();

  const answered=await askAssistant(ctx,{question:companyName,clarificationExchangeId:prompt.exchangeId});
  expect(answered.turns).toBe(1);
  expect(transport).toHaveBeenCalledOnce();
  const visible=await history(answered.exchangeId);
  expect(visible?.grounded?.mode).toBe('grounded');
  const facts=visible?.grounded?.conversation?.facts;
  expect(facts).toHaveLength(1);
  const selectedFact=facts?.[0];
  if(!selectedFact || !('fact' in selectedFact) || selectedFact.view.state!=='ready')
   throw Error('Expected a resolved answer reference.');
  const selectedCard=selectedFact.view.presentation.cards[selectedFact.card];
  expect(selectedCard.facts).toContainEqual(expect.objectContaining({field:'company',value:companyName}));
  expect(selectedCard.facts[selectedFact.fact]).toMatchObject({field:'available',value:47.25});
  const [stored]=await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.id,answered.exchangeId));
  expect(stored.continuesExchangeId).toBe(prompt.exchangeId);
  expect(stored.disclosureReceipt).toBeTruthy();

  // The historical receipt binds the whole canonical roster, including the unselected sibling.
  await applyLeaveAdjustmentBatch(admin,{leaveTypeIds:[base.annualLeaveTypeId],
   employmentIds:[change==='selected'?selected.employmentId:employmentId],targetMode:'individual',
   effectiveOn:todayInKualaLumpur(),days:5,reason:'Fictional employment balance correction'});
  expect(await history(answered.exchangeId)).toMatchObject({answer:null,grounded:{mode:'unavailable'}});
  expect(transport).toHaveBeenCalledOnce();
 });

 it('evaluates the leave-count candidate on actual Assistant catalogues and declines a newly hidden value',async()=>{
  const {admin,ctx,userId}=await fixture();
  const selections:ReturnType<typeof selectProtectedLeaveCount>[]=[];
  const transport=vi.spyOn(openaiAdapter,'converse').mockImplementation(async(_configuration,args)=>{
   const turn=args.turns[0];
   if(turn?.role!=='user')throw Error('Expected one protected user catalogue.');
   expect(args.turns).toHaveLength(1);
   expect(args.tools).toEqual([]);
   expect(turn.content).not.toContain('Fictional Mine Visibility');
   expect(turn.content).not.toContain('113.75');
   expect(turn.content).not.toContain('My leave balance');
   const {local}=capturePrivateAssistantTask(JSON.parse(turn.content));
   const selection=selectProtectedLeaveCount(local);
   selections.push(selection);
   if(!selection)throw Error('Fictional fallback received no eligible leave count.');
   return {...response,text:JSON.stringify({version:1,mode:'answer',blocks:[selection]})};
  });
  const ask=()=>askAssistant(ctx,{question:'My leave balance'});
  const served=await ask();
  expect(transport).toHaveBeenCalledOnce();
  expect(selections).toEqual([expect.objectContaining({kind:'fact',read:0,card:0})]);
  const before=await loadAiWorkspace(ctx,{selectedExchangeId:served.exchangeId,includeGovernance:false});
  expect(before.history[0].grounded?.mode).toBe('grounded');
  expect(JSON.stringify(before.history[0].grounded)).toContain('113.75');

  await updateLeaveType(admin,{id:base.annualLeaveTypeId,name:'Annual Leave',essViewConfig:{available:false}});
  await expect(ask()).rejects.toMatchObject({code:'provider_error'});
  expect(transport).toHaveBeenCalledTimes(2);
  expect(selections[1]).toBeNull();
  const after=await loadAiWorkspace(ctx,{selectedExchangeId:served.exchangeId,includeGovernance:false});
  expect(after.history.find(row=>row.id===served.exchangeId)).toMatchObject({answer:null,grounded:{mode:'unavailable',views:[]}});

  await revokeAssistant(admin,{appUserId:userId});
  await expect(ask()).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(2);
 });

 it.each(['my_leave_balances','leave_entitlement_explain','my_module_work'] as const)('%s refuses an old visible transcript after the canonical flag is hidden',async name=>{
  const {admin,ctx,userId}=await fixture(),tool=ASSISTANT_TOOLS.find(row=>row.spec.name===name)!;
  const input=name==='leave_entitlement_explain'?{leave_type_id:base.annualLeaveTypeId,as_of:todayInKualaLumpur()}:name==='my_module_work'?{module:'leave'}:{};
  const original=await tool.run(ctx,input);expect(original.ok).toBe(true);
  const configuration=await withTenant(ctx,async tx=>{const cfg=await resolveActiveAiConfig(tx,ctx);if(!cfg)throw Error('Missing fictional configured gateway');return bindAiSpendTaskTx(tx,ctx,cfg,{kind:'assistant_question'});});
  const args:ConverseArgs={system:['Fictional Mine question'],tools:specsFor(ctx),turns:[{role:'user',content:'Show my leave position.'},
   {role:'assistant',content:'',toolCalls:[{id:'c1',name,input}]},{role:'tool',results:[{id:'c1',name,content:serializeAgentReadResult(original)}]}]};
  const evidence=[{name,input,digest:assistantSourceDigest(original)}];
  // The old transcript binder still cannot authorize disclosure of raw facts. A real protected
  // positive below proves that the later negative reaches source replay, not this privacy refusal.
  const legacy=prepareAssistantConversation(ctx,configuration,args,evidence);
  const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue(response);
  await expect(converse(legacy.configuration,legacy.args)).rejects.toBeInstanceOf(AiPrivacyGateError);
  expect(transport).not.toHaveBeenCalled();
  expect(await owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,base.tenantId))).toEqual([]);
  if(!isGroundedToolName(name))throw Error('Expected canonical grounded source');
  const presentation=presentGroundedToolOutcome(name,original);if(!presentation)throw Error('Missing canonical presentation');
  expect(presentation.cards.length).toBeGreaterThan(0);
  const catalogue=privateAssistantCatalogue('leave_available',[{read:0,presentation,explanations:[]}]);
  const prepareProtected=()=>preparePrivateAiTask(configuration,ASSISTANT_PRIVATE_CONTRACT,async(tx,current)=>{
   const valid=await withAssistantAdmissionReadsTx(current,tx,read=>assistantSourceReplay(current,read)(evidence));
   if(!valid)throw new AiGatewayError('The current Assistant source access could not be confirmed.');
   return catalogue;
  });
  const positive=await prepareProtected();
  try{if(positive.operation!=='conversation')throw Error('Expected protected conversation');
   const disclosed=JSON.stringify(positive.args);for(const privateValue of ['113.75','Fictional Mine Visibility','Show my leave position.',base.annualLeaveTypeId])expect(disclosed).not.toContain(privateValue);
   await expect(converse(positive.configuration,positive.args)).resolves.toEqual(response);
  }finally{positive.dispose();}
  expect(transport).toHaveBeenCalledTimes(1);
  const admittedBefore=await owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,base.tenantId));
  expect(admittedBefore).toHaveLength(1);expect(admittedBefore[0].state).toBe('completed');
  const binding={tenantId:base.tenantId,userId,exchangeId:randomUUID(),question:'Show my leave',answer:'Fictional previously visible balance'};
  const receipt=sealAssistantDisclosure(binding,evidence);expect(receipt).toBeTruthy();
  await owner.db.insert(schema.assistantExchange).values({id:binding.exchangeId,tenantId:base.tenantId,appUserId:userId,question:binding.question,answer:binding.answer,disclosureReceipt:receipt,stop:'end'});
  expect((await loadAiWorkspace(ctx,{selectedExchangeId:binding.exchangeId,includeGovernance:false})).history[0].grounded?.mode).toBe('grounded');
  expect(await withAssistantRead(ctx,null,read=>assistantHistoryReplay(ctx,read)(binding,receipt))).toBe(true);
  // A fresh one-use privacy capability exists BEFORE the canonical visibility change.
  const prepared=await prepareProtected();
  try{await updateLeaveType(admin,{id:base.annualLeaveTypeId,name:'Annual Leave',essViewConfig:{available:false}});if(prepared.operation!=='conversation')throw Error('Expected protected conversation');await expect(converse(prepared.configuration,prepared.args)).rejects.toThrow('source access');}finally{prepared.dispose();}
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,base.tenantId))).toEqual(admittedBefore);
  expect(await withAssistantRead(ctx,null,read=>assistantHistoryReplay(ctx,read)(binding,receipt))).toBe(false);
  const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:binding.exchangeId,includeGovernance:false});
  expect(workspace.history[0]).toMatchObject({answer:null,grounded:{mode:'unavailable',views:[]}});
  expect(JSON.stringify(workspace)).not.toContain(binding.answer);
  const current=await tool.run(ctx,input);expect(current.ok).toBe(true);expect(assistantSourceDigest(current)).not.toBe(evidence[0].digest);
  // Spec v23: the entitlement breakdown names what it does not show (notShown), as a balance row does: the hidden line, then
  // the decomposition that could rebuild it, by name; never the values.
  const text=JSON.stringify(current);expect(text).toContain(name==='leave_entitlement_explain'
   ?'"notShown":["totalAvailable","eligibleDays","monthlyAccruedToDate","carriedForward","carryForwardRemaining","configAdjustments","systemAdjustments","balance","transactions"]'
   :'"notShown":["available","sharedPoolName","accrued","balance"]');
  if(name==='leave_entitlement_explain'){expect(text).toContain('"totalAvailable":null');expect(text).not.toContain('"withheld"');}else expect(text).toContain('"available":null');
  expect(text).not.toContain('"transactions":');expect(text).not.toContain('"balance":113.75');
 });
});
