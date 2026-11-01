/** Real own-exchange source-free help. No HR record lookup or provider call is needed. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as s from '../db/schema';
import type {SessionContext} from '../db/client';
import {askAssistant} from '../core/assistant';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {loadAiWorkspace} from '../core/ai-workspace';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-help-secret');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
function provider(){vi.stubEnv('OPENAI_API_KEY','fictional-help-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');}
async function actor(){const admin=adminCtx(b),employee=await hireEmployee(admin,{person:{fullName:'Fictional help actor',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,employee.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(b,['employee']),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};return{ctx};}
const end={text:'',stop:'end' as const,toolCalls:[],usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0},usageReported:true};
const ownRows=(ctx:SessionContext)=>owner.db.select().from(s.assistantExchange).where(eq(s.assistantExchange.appUserId,ctx.userId!));
describe('source-free help through actual own exchange owners',()=>{
 it('answers help from the actual clarification form without repeating the chooser or calling a provider',async()=>{
  provider();const {ctx}=await actor();const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue(end);
  const first=await askAssistant(ctx,{question:'Please explain how this works'});
  const second=await askAssistant(ctx,{question:'Hello, what can you help me do?',clarificationExchangeId:first.exchangeId});
  const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:second.exchangeId,includeGovernance:false});
  expect(workspace.history.find(row=>row.id===second.exchangeId)?.grounded?.conversation).toEqual({plan:{version:1,mode:'social',code:'help'},facts:[]});
  expect(transport).not.toHaveBeenCalled();for(const row of await ownRows(ctx))expect(row.toolCalls).toEqual([]);
 });

 it('keeps general help and its follow-up entirely local while returning a useful source-free answer',async()=>{
  provider();const {ctx}=await actor();const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue(end);
  const first=await askAssistant(ctx,{question:'What can you help me do? Please keep it simple and do not read personal records or make changes.'});
  expect(first.conversationToken).toBeTruthy();
  const second=await askAssistant(ctx,{question:'I only want a short explanation of what you can help with. Do not retrieve records.',previousExchangeId:first.exchangeId,previousConversationToken:first.conversationToken});
  const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:second.exchangeId,includeGovernance:false});
  expect(workspace.history.find(row=>row.id===second.exchangeId)?.grounded?.conversation).toEqual({plan:{version:1,mode:'social',code:'help'},facts:[]});
  expect(transport).not.toHaveBeenCalled();
  const rows=await ownRows(ctx);expect(rows).toHaveLength(2);for(const row of rows)expect(row.toolCalls).toEqual([]);
 });

});
