/** ADR-0169 §5.1 wiring — one live-chat turn through the production path on fictional data: the real switch and
 * permit, the tenant's configured provider resolved and admitted by the real gateway (allowances, question budget,
 * spend root, the reviewed `teras_harness_turn_v1` privacy binding against the current provider-data digest), the
 * real native owners as tools, the step 5a task-memory store, the outcome record and the retired accounting row.
 * Only the provider adapter's network call is scripted; no provider is contacted. The provider-data review lookup is
 * isolated here, as in test/ai-private-analysis.test.ts: the owner's approval record for the contract is a
 * separate, explicitly approved change, and the real refusal of an unreviewed contract is proved below and by
 * test/provider-data-review-gate.test.ts. No approval is claimed by this file.
 *
 * Proves: the harness runs when the switch is on; history sent back is the model side only; cross-person and
 * cross-tenant reads are refused; a tenant with no compliant provider is refused before any read or model call; a
 * prepared card leaves the request untouched and points only to its review page. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const review=vi.hoisted(()=>({approved:true}));
vi.mock('../lib/ai/provider-data-reviews',async original=>{const actual=await original<typeof import('../lib/ai/provider-data-reviews')>();
 return{...actual,providerDataReviewStatus:(contractId:string)=>contractId==='teras_harness_turn_v1'&&review.approved?'approved':actual.providerDataReviewStatus(contractId),
  assertProviderDataContractReviewed:(contractId:string,digest:string)=>{if(contractId==='teras_harness_turn_v1'&&review.approved)return;actual.assertProviderDataContractReviewed(contractId,digest);}};});
import * as schema from '../db/schema';
import {terasOutcomeRecord,terasTaskMemory} from '../db/teras-schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {conversationRoute} from '../core/teras-wiring/switch';
import {ConversationTurnError,runConversationTurn,type ConversationTurn} from '../core/teras-wiring/turn';
import {encryptSecret} from '../lib/ai/crypto';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import type {ConverseArgs,ConverseResult} from '../lib/ai/types';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

let b:Base,group:SessionContext,employee:SessionContext,manager:SessionContext,applicantRequest:string,otherLeaveType:string;
type Step=(args:ConverseArgs,index:number)=>Partial<ConverseResult>;
const sent:ConverseArgs[]=[];
function script(steps:readonly Step[]){
 sent.length=0;
 return vi.spyOn(openrouterAdapter,'converse').mockImplementation(async(_cfg,args)=>{
  const index=sent.length;sent.push(JSON.parse(JSON.stringify(args)));
  const step=steps[index]??(()=>final('Script ended.'));
  return{text:'',toolCalls:[],stop:'tool_use',usage:{inputTokens:120,outputTokens:30,cachedInputTokens:0},usageReported:true,...step(args,index)};
 });
}
const call=(name:string,input:Record<string,unknown>={}):Partial<ConverseResult>=>({toolCalls:[{id:'p-'+randomUUID().slice(0,8),name,input}],stop:'tool_use'});
const final=(reply:string,mode='answer')=>call('final_answer',{mode,slot:null,reply});
/** The disclosed JSON of the latest tool result the provider was sent. */
function lastTool(args:ConverseArgs):unknown{
 const turn=[...args.turns].reverse().find(row=>row.role==='tool');if(!turn||turn.role!=='tool')throw Error('No tool result sent.');
 return JSON.parse(turn.results.at(-1)!.content.split('\n').slice(1,-1).join('\n'));
}
async function hire(base:Base,name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:userId});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'17.25',effectiveOn:todayInKualaLumpur()});
 return{ctx:{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext,employmentId:hired.employmentId};
}
async function openRouter(tenantId:string){
 await owner.db.insert(schema.aiProviderConfig).values({tenantId,provider:'openrouter',model:'fictional/model',apiKeyCiphertext:encryptSecret('fictional-no-network-key',tenantId),keyLast4:'-key',isActive:true,
  providerOptions:{version:1,routing:{allowedProviders:['azure'],allowFallbacks:false,sort:'latency'}}});
}
async function turn(ctx:SessionContext,question:string,continuation?:string):Promise<ConversationTurn>{
 const route=await conversationRoute(ctx);if(route.route!=='harness')throw Error('Expected the harness route.');
 return runConversationTurn(ctx,route,{question,companyId:b.companyId,locale:'en',...(continuation?{continuation}:{})});
}
const exchanges=(tenantId:string)=>owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.tenantId,tenantId));
const turnRecords=(tenantId:string)=>owner.db.select().from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,tenantId),eq(terasOutcomeRecord.agentIdentity,'teras.assistant')));

beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{vi.restoreAllMocks();});
beforeEach(async()=>{
 review.approved=true;
 vi.stubEnv('AI_CONFIG_SECRET','fictional-wiring-passphrase-0123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-wiring-proposal-secret-0123456789abcdef');
 await resetDb();b=await seedBase();for(const code of ['assistant','claims'])await setModule(b.tenantId,code,'active');
 await seedEntitlement(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});
 group=(await hire(b,'Fictional Wiring Administrator','hr_admin')).ctx;
 const mine=await hire(b,'Fictional Wiring Employee','employee');employee=mine.ctx;
 const boss=await hire(b,'Fictional Wiring Manager','manager');manager=boss.ctx;
 const applicant=await hire(b,'Fictional Wiring Applicant','employee');
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:applicant.employmentId,managerEmploymentId:boss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
 applicantRequest=(await requestLeave(applicant.ctx,{employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:next.toISOString().slice(0,10),endDate:next.toISOString().slice(0,10),durationType:'full_day',reason:'Fictional wiring reason'})).leaveRequestId;
 const [medical]=await owner.db.insert(schema.leaveType).values({tenantId:b.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true}).returning({id:schema.leaveType.id});otherLeaveType=medical.id;
 await setWorkerSwitch(group,{workerId:'conversation',enabled:true});
});

describe('a live-chat turn with the switch on',()=>{
 it('runs the harness through the gateway, restores the figure for the person only, and records the turn',async()=>{
  await openRouter(b.tenantId);
  let placeholder='';
  const adapter=script([()=>call('my_leave_balances'),args=>{
   const row=(lastTool(args) as {employments:{balances:{available:string}[]}[]}).employments[0].balances[0];
   placeholder=/\{\{F\d+\}\}/.exec(row.available)![0];return final(`You have ${placeholder} days of annual leave available.`);}]);
  const first=await turn(employee,'How much annual leave do I have?');
  expect(adapter).toHaveBeenCalledTimes(2);
  expect(first.reply).toBe('You have 17.25 days of annual leave available.');expect(first.reads).toEqual(['my_leave_balances']);
  // The provider saw bands and placeholders, never the exact figure, the employment id or the leave type id.
  const wire=JSON.stringify(sent);
  expect(wire).not.toContain('17.25');expect(wire).not.toContain(b.annualLeaveTypeId);expect(wire).toContain(placeholder);
  expect(sent[0].tools.map(tool=>tool.name)).toContain('final_answer');
  for(const tool of sent[0].tools)expect(tool.inputSchema.additionalProperties).toBe(false);
  // The explainers worker is off: its "Why?" tools are not offered.
  expect(sent[0].tools.map(tool=>tool.name)).not.toContain('explain_leave_entitlement');

  // History: the next turn sends the model side only (the band), never the restored reply.
  script([args=>{expect(JSON.stringify(args.turns)).toContain('[an earlier figure');return final('Ask me about a specific month.');}]);
  const second=await turn(employee,'And how many have I taken?',first.continuation);
  expect(second.reply).toBe('Ask me about a specific month.');
  const historyWire=JSON.stringify(sent[0].turns);
  expect(historyWire).not.toContain('17.25');expect(historyWire).toContain('How much annual leave do I have?');
  expect(sent[0].turns.map(row=>row.role)).toEqual(['user','assistant','user']);

  // One task-memory row for the conversation, one outcome record per turn, and retired accounting rows only.
  const memory=await owner.db.select().from(terasTaskMemory).where(eq(terasTaskMemory.tenantId,b.tenantId));
  expect(memory).toHaveLength(1);expect(memory[0].appUserId).toBe(employee.userId);
  const records=await turnRecords(b.tenantId);
  expect(records).toHaveLength(2);for(const record of records)expect(record).toMatchObject({runKind:'turn',askedByUserId:employee.userId});
  expect(JSON.stringify(records)).not.toContain('17.25');
  const rows=await exchanges(b.tenantId);
  expect(rows).toHaveLength(2);
  for(const row of rows)expect(row).toMatchObject({question:'',answer:null,provider:'openrouter',model:'fictional/model',appUserId:employee.userId});
  expect(rows.every(row=>row.contentRetiredAt!==null)).toBe(true);
  expect(rows.reduce((sum,row)=>sum+row.turnCount,0)).toBe(3);
 },60000);

 it('refuses a read about another person at the gate and an id the turn did not issue',async()=>{
  await openRouter(b.tenantId);
  script([()=>call('my_leave_balances'),()=>final('I can\'t share another person\'s leave.','refuse')]);
  const other=await turn(employee,'How much annual leave does Fictional Wiring Applicant have?');
  expect(other.reads).toEqual([]);
  script([()=>call('leave_entitlement_explain',{leave_type_id:otherLeaveType,as_of:todayInKualaLumpur()}),()=>final('I could not find that.','honest_gap')]);
  await turn(employee,'Explain my medical leave entitlement.');
  const records=await turnRecords(b.tenantId);
  const statuses=records.flatMap(record=>(record.reads as {tool:string;status:string}[]).map(read=>read.tool+':'+read.status)).sort();
  expect(statuses).toEqual(['leave_entitlement_explain:unknown_handle','my_leave_balances:not_offered']);
 },60000);

 it('refuses another tenant\'s continuation and keeps task memory to its own login',async()=>{
  await openRouter(b.tenantId);
  script([()=>final('Hello.','social')]);
  const mine=await turn(employee,'Hello');
  const other=await seedBase();await setModule(other.tenantId,'assistant','active');await openRouter(other.tenantId);
  const otherAdmin=await hire(other,'Fictional Other Administrator','hr_admin');
  await setWorkerSwitch(otherAdmin.ctx,{workerId:'conversation',enabled:true});
  const otherEmployee=(await hire(other,'Fictional Other Employee','employee')).ctx;
  const route=await conversationRoute(otherEmployee);if(route.route!=='harness')throw Error('Expected the harness route.');
  await expect(runConversationTurn(otherEmployee,route,{question:'And then?',companyId:other.companyId,locale:'en',continuation:mine.continuation})).rejects.toMatchObject({code:'continuation_invalid'});
  // Another login in the same tenant cannot continue it either.
  const managerRoute=await conversationRoute(manager);if(managerRoute.route!=='harness')throw Error('Expected the harness route.');
  await expect(runConversationTurn(manager,managerRoute,{question:'And then?',companyId:b.companyId,locale:'en',continuation:mine.continuation})).rejects.toBeInstanceOf(ConversationTurnError);
  expect(await exchanges(other.tenantId)).toEqual([]);
 },60000);

 it('refuses a tenant with no provider, or no compliant provider, before any read or model call',async()=>{
  const adapter=script([()=>final('Should not run.')]);
  await expect(turn(employee,'How much leave do I have?')).rejects.toMatchObject({code:'not_configured'});
  await owner.db.insert(schema.aiProviderConfig).values({tenantId:b.tenantId,provider:'anthropic',model:'fictional-model',apiKeyCiphertext:encryptSecret('fictional-no-network-key',b.tenantId),keyLast4:'-key',isActive:true});
  const direct=vi.spyOn(anthropicAdapter,'converse');
  await expect(turn(employee,'How much leave do I have?')).rejects.toMatchObject({code:'provider_not_compliant'});
  expect(adapter).not.toHaveBeenCalled();expect(direct).not.toHaveBeenCalled();
  expect(await exchanges(b.tenantId)).toEqual([]);expect(await turnRecords(b.tenantId)).toEqual([]);
  // Attested for the active direct provider: admitted.
  await setWorkerSwitch(group,{workerId:'conversation',enabled:true,attestDirectProvider:true});
  direct.mockResolvedValue({text:'',toolCalls:[{id:'d1',name:'final_answer',input:{mode:'social',slot:null,reply:'Hello.'}}],stop:'tool_use',usage:{inputTokens:10,outputTokens:5,cachedInputTokens:0},usageReported:true});
  expect((await turn(employee,'Hello')).reply).toBe('Hello.');expect(direct).toHaveBeenCalledOnce();
 },60000);
});

describe('the provider-data review gate',()=>{
 it('refuses the turn before any provider call while the contract is not reviewed for the current source',async()=>{
  await openRouter(b.tenantId);review.approved=false;
  const adapter=script([()=>final('Should not run.')]);
  await expect(turn(employee,'When is the next public holiday?')).rejects.toMatchObject({code:'protected_input'});
  expect(adapter).not.toHaveBeenCalled();
  // The question was admitted and accounted, with no tokens spent.
  const rows=await exchanges(b.tenantId);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({inputTokens:0,outputTokens:0,stop:'other',question:''});
 },60000);
});

describe('the explainers worker switch',()=>{
 it('offers the "Why?" explainers only while the explainers worker is on',async()=>{
  await openRouter(b.tenantId);
  await setWorkerSwitch(group,{workerId:'explainers',enabled:true});
  script([()=>final('Ask me which leave type.','clarify')]);
  await turn(employee,'Why is my annual leave entitlement 17 days?');
  expect(sent[0].tools.map(tool=>tool.name)).toContain('explain_leave_entitlement');
 },60000);
});

describe('a prepared card confirms only on its review page',()=>{
 it('returns a signed decide card pointing to the approvals review page and leaves the request pending',async()=>{
  await openRouter(b.tenantId);
  script([()=>call('suggest_action',{action:'approvals.leave.decide',details:null}),()=>final('It is ready for you to review on the approvals review page.','propose')]);
  const result=await turn(manager,'Please approve the leave request waiting for me.');
  expect(result.proposals.map(row=>row.body.what.action)).toEqual(['approvals.leave.decide']);
  const card=result.proposals[0].body;
  expect(card.review.route).toBe('/assistant/approvals');expect(card.review.href.startsWith('/assistant/approvals')).toBe(true);
  expect(card.forWhom.subjectId).toBe(applicantRequest);
  const [row]=await owner.db.select({status:schema.leaveRequest.status}).from(schema.leaveRequest).where(eq(schema.leaveRequest.id,applicantRequest));
  expect(row.status).toBe('pending');
  // The proposal's reviewed digest never left the application.
  expect(JSON.stringify(sent)).not.toContain(card.what.reviewedDigest);
 },60000);
});
