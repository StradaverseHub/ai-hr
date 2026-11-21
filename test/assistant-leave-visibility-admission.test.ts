/** Actual flag-toggled admission/history cases; authored UNRUN. Transport is mocked, never live. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {updateLeaveType} from '../core/admin';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {askAssistant} from '../core/assistant';
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
import {lockLeaveDependencyReadConfigurationTx} from '../core/leave-dependency-lock';
import {assistantQuestionBudgetBinding,completeAssistantQuestionBudgetTx} from '../core/assistant-question-budget';
import {prepareAssistantConversationStrategyTx,completeAssistantConversationStrategyTx,retireAssistantConversationStrategyCapability} from '../core/module-agent-releases';
import {ASSISTANT_PRIVATE_CONTRACT,adjudicatePrivateAssistantTerminal,capturePrivateAssistantTask,privateAssistantCatalogue} from '../lib/ai/provider-assistant-policy';
import {adjudicateAssistantAnswerPlan} from '../lib/ai/assistant-answer-plan';
import {isGroundedToolName,presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
import {AiPrivacyGateError} from '../lib/ai/provider-privacy-error';
import {AiGatewayError} from '../lib/ai/types';
import {resolveActiveAiConfig} from '../core/ai-config';
import {converse} from '../lib/ai';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {ConverseArgs,ConverseResult} from '../lib/ai/types';
import {selectProtectedLeaveCount} from '../scripts/experiments/protected-leave-comparison';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-visible-source-passphrase');vi.stubEnv('OPENAI_API_KEY','fictional-visibility-key');
 for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function fixture(){const admin=adminCtx(base);await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:113.75,validFrom:'2020-01-01'});
 const mine=await hireEmployee(admin,{person:{fullName:'Fictional Mine Visibility',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,
  departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId:base.annualLeaveTypeId,
  entryType:'accrual',days:'113.75',effectiveOn:todayInKualaLumpur()});return {admin,ctx,userId};}
const response:ConverseResult={text:'Fictional response',stop:'end',toolCalls:[],usageReported:true,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0}};
describe('actual Mine flags bind current provider input and historical source disclosure',()=>{
 it('rehearses local leave custody with zero provider calls, native quota and a same-transaction source recheck',async()=>{
  const {admin,ctx,userId}=await fixture();
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
     const valid=await withAssistantAdmissionReadsTx(ctx,tx,read=>assistantSourceReplay(ctx,read)(draft.evidence));
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
  const hideBalance=()=>updateLeaveType(admin,{id:base.annualLeaveTypeId,name:'Annual Leave',essViewConfig:{available:false}});
  const visible=await persistLocalLeave(await prepareLocalLeave(),async()=>{
   await expect(hideBalance()).rejects.toMatchObject({name:'LeaveDependencyUnavailable',reason:'busy'});
  });
  const before=await loadAiWorkspace(ctx,{selectedExchangeId:visible,includeGovernance:false});
  expect(before.history[0].grounded?.mode).toBe('grounded');
  expect(JSON.stringify(before.history[0].grounded)).toContain('113.75');

  const stale=await prepareLocalLeave();
  await hideBalance();
  await expect(persistLocalLeave(stale)).rejects.toThrow('The canonical leave source changed.');
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
