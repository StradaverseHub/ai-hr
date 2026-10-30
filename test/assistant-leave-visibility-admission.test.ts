/** Actual flag-toggled admission/history cases; authored UNRUN. Transport is mocked, never live. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {updateLeaveType} from '../core/admin';
import {grantAssistant} from '../core/assistant-grant';
import {withAssistantRead,withAssistantAdmissionReadsTx} from '../core/assistant-read-session';
import {ASSISTANT_TOOLS,specsFor} from '../core/assistant-tools';
import {loadAiWorkspace} from '../core/ai-workspace';
import {assistantHistoryReplay,assistantSourceReplay} from '../core/assistant-disclosure-read';
import {assistantSourceDigest,sealAssistantDisclosure} from '../lib/ai/assistant-disclosure';
import {serializeAgentReadResult} from '../lib/ai/agent-read-batch';
import {prepareAssistantConversation} from '../core/assistant-provider-input';
import {preparePrivateAiTask} from '../core/ai-governance';
import {bindAiSpendTaskTx} from '../core/ai-spend-task';
import {ASSISTANT_PRIVATE_CONTRACT,privateAssistantCatalogue} from '../lib/ai/provider-assistant-policy';
import {isGroundedToolName,presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
import {AiPrivacyGateError} from '../lib/ai/provider-privacy-error';
import {AiGatewayError} from '../lib/ai/types';
import {resolveActiveAiConfig} from '../core/ai-config';
import {converse} from '../lib/ai';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {ConverseArgs,ConverseResult} from '../lib/ai/types';
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
  const text=JSON.stringify(current);expect(text).toContain('"withheld":true');
  if(name==='leave_entitlement_explain')expect(text).toContain('"totalAvailable":null');else expect(text).toContain('"available":null');
  expect(text).not.toContain('"transactions"');expect(text).not.toContain('"balance":113.75');
 });
});
