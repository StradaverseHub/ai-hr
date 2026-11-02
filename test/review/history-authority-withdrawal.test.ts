/** Owner decision, 3 November 2026: restart history when access changes.
 * Fictional native integration fixture: actual role rows, principal refresh, RLS/native tools,
 * gateway allowances/accounting and Postgres task memory. Only adapter network output is scripted.
 * As in teras-conversation-turn.test.ts, the exact harness-contract review lookup is explicitly
 * isolated to reach the native history seam while the combined source binding remains held.
 * This is NOT source approval, provider-quality evidence or a permissions mock. No live provider.
 */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../lib/ai/provider-data-reviews',async original=>{
 const actual=await original<typeof import('../../lib/ai/provider-data-reviews')>();
 return {...actual,
  providerDataReviewStatus:(id:string)=>id==='teras_harness_turn_v1'?'approved':actual.providerDataReviewStatus(id),
  assertProviderDataContractReviewed:(id:string,digest:string)=>{if(id!=='teras_harness_turn_v1')actual.assertProviderDataContractReviewed(id,digest);},
 };
});
import * as schema from '../../db/schema';
import {terasTaskMemory} from '../../db/teras-schema';
import {withTenant,type Grant,type SessionContext} from '../../db/client';
import {grantAssistant} from '../../core/assistant-grant';
import {hireEmployee} from '../../core/org';
import {requestLeave} from '../../packs/leave/service';
import {setWorkerSwitch} from '../../core/agent-registry/controls';
import {conversationRoute} from '../../core/teras-wiring/switch';
import {runConversationTurn} from '../../core/teras-wiring/turn';
import {verifyConversationContinuation} from '../../core/teras-wiring/history';
import {nativeToolProvider} from '../../core/harness/tools';
import {authorityKey} from '../../core/harness/memory';
import {resolveDevPrincipal} from '../../lib/session';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {encryptSecret} from '../../lib/ai/crypto';
import {openrouterAdapter} from '../../lib/ai/providers/openrouter';
import type {ConverseArgs,ConverseResult} from '../../lib/ai/types';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from '../harness';

const B_NAME='Fictional Cedar Colleague';
let b:Base,companyB:string,viewerId:string,subjectB:string,day:string;
let viewer:SessionContext;
const sent:ConverseArgs[]=[];

/** Both callbacks read the actual database principal/login owners, not a claimed roles fixture. */
async function freshSession(userId:string):Promise<SessionContext>{
 const ctx=await resolveDevPrincipal(async id=>{
  const rows=await owner.db.execute<{tenant_id:string;person_id:string|null;grants:Grant[]|null}>(
   sql`select tenant_id,person_id,grants from app.principal(${id}::uuid)`);
  return [...rows];
 },userId,undefined,async id=>{
  const [row]=await owner.db.execute<{blocked:boolean}>(sql`select app.login_blocked(${id}::uuid) as blocked`);
  return row?.blocked!==false;
 });
 return {...ctx,entitlements:(await entitledCtx(b,ctx.roles)).entitlements};
}
async function authority(ctx:SessionContext){
 const [row]=await withTenant(ctx,tx=>tx.execute<{current:boolean;a:boolean;b:boolean}>(sql`
  select app.principal_snapshot_current() as current,
   app.is_admin_for(${b.companyId}::uuid) as a,app.is_admin_for(${companyB}::uuid) as b`));
 return row;
}
const call=(name:string,input:Record<string,unknown>):Partial<ConverseResult>=>({
 toolCalls:[{id:'fixture-'+randomUUID(),name,input}],stop:'tool_use',
});
const final=(reply:string)=>call('final_answer',{mode:'answer',slot:null,reply});
function scriptedAdapter(){
 sent.length=0;
 return vi.spyOn(openrouterAdapter,'converse').mockImplementation(async(_configuration,args)=>{
  const index=sent.length;sent.push(JSON.parse(JSON.stringify(args)));
  let response:Partial<ConverseResult>;
  if(index===0)response=call('who_is_away',{from:day,to:day});
  else if(index===1){
   // Premise: the name came from native authorized disclosure, never the question or fake read data.
   const result=args.turns.findLast(row=>row.role==='tool');
   expect(result).toBeDefined();expect(JSON.stringify(result)).toContain(B_NAME);
   response=final(`${B_NAME} is away.`);
  }else response=final('I can continue with the current context.');
  return {text:'',toolCalls:[],stop:'tool_use',usage:{inputTokens:120,outputTokens:30,cachedInputTokens:0},usageReported:true,...response};
 });
}
async function turn(ctx:SessionContext,question:string,continuation?:string){
 const route=await conversationRoute(ctx);expect(route.route).toBe('harness');
 if(route.route!=='harness')throw Error('Native conversation switch did not admit the fixture');
 return runConversationTurn(ctx,route,{question,companyId:b.companyId,locale:'en',...(continuation?{continuation}:{})});
}
async function nativeAway(ctx:SessionContext){
 const candidates=await nativeToolProvider(ctx,{companyId:b.companyId,locale:'en'},false);
 const binding=candidates.bindings.find(row=>row.name==='who_is_away');expect(binding).toBeDefined();
 const result=await binding!.run({from:day,to:day});expect(result.ok).toBe(true);
 return JSON.stringify(result.content);
}
async function firstTurn(){
 const first=await turn(viewer,`Who is away on ${day}?`);
 expect(sent).toHaveLength(2);expect(first.reply).toBe(`${B_NAME} is away.`);
 expect(first.modelTurn.some(row=>row.role==='assistant'&&row.content.includes(B_NAME))).toBe(true);
 const continuation=verifyConversationContinuation(viewer,first.continuation);
 const [stored]=await owner.db.select().from(terasTaskMemory).where(and(eq(terasTaskMemory.tenantId,b.tenantId),
  eq(terasTaskMemory.appUserId,viewerId),eq(terasTaskMemory.conversationId,continuation.conversationId)));
 expect(stored).toBeDefined();expect(stored.memory).toMatchObject({authorityKey:authorityKey(viewer),turns:1});
 return first;
}

beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-history-config-0123456789abcdef');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-history-secret-0123456789abcdef');
 await resetDb();b=await seedBase();
 // Leave is core and always enabled; the real DB forbids a tenant_module row for it.
 await setModule(b.tenantId,'assistant','active');
 await seedEntitlement(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,annualDays:20,validFrom:'2020-01-01'});
 const [otherCompany]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Cedar Company'}).returning({id:schema.company.id});companyB=otherCompany.id;
 const [departmentB]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:companyB,name:'Fictional Cedar Department'}).returning({id:schema.department.id});
 const actor=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Scope Reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 viewerId=await createAppUser(b.tenantId,actor.personId,'hr_admin');
 await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,viewerId));
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:viewerId,companyId:companyB,role:'hr_admin'});
 await grantAssistant(adminCtx(b),{appUserId:viewerId});viewer=await freshSession(viewerId);
 expect(viewer.personId).toBe(actor.personId);expect(await authority(viewer)).toEqual({current:true,a:true,b:true});
 const subject=await hireEmployee(adminCtx(b),{person:{fullName:B_NAME,primaryEmail:randomUUID()+'@fixture.invalid'},companyId:companyB,departmentId:departmentB.id,employmentType:'full_time',hiredOn:'2020-01-01'});subjectB=subject.employmentId;
 const employeeId=await createAppUser(b.tenantId,subject.personId,'employee');
 await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:subjectB,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'20',effectiveOn:todayInKualaLumpur()});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));day=next.toISOString().slice(0,10);
 await requestLeave(await freshSession(employeeId),{employmentId:subjectB,leaveTypeId:b.annualLeaveTypeId,startDate:day,endDate:day,durationType:'full_day',reason:'Fictional history fixture'});
 await owner.db.insert(schema.aiProviderConfig).values({tenantId:b.tenantId,provider:'openrouter',model:'fictional/history-model',apiKeyCiphertext:encryptSecret('fictional-no-network-key',b.tenantId),keyLast4:'-key',isActive:true,
  providerOptions:{version:1,routing:{allowedProviders:['azure'],allowFallbacks:false,sort:'latency'}}});
 await setWorkerSwitch(await entitledCtx(b),{workerId:'conversation',enabled:true});
 expect(await nativeAway(viewer)).toContain(B_NAME);
 scriptedAdapter();
});

describe('owner rule: restart model-side history after access changes',()=>{
 it('keeps same-access signed history and real database memory for a normal continuation',async()=>{
  const first=await firstTurn(),fresh=await freshSession(viewerId);
  expect(authorityKey(fresh)).toBe(authorityKey(viewer));expect(await authority(fresh)).toEqual({current:true,a:true,b:true});
  const second=await turn(fresh,'And what next?',first.continuation);
  expect(sent).toHaveLength(3);expect(JSON.stringify(sent[2].turns)).toContain(B_NAME);
  expect(second.reply).toBe('I can continue with the current context.');
  const continued=verifyConversationContinuation(fresh,second.continuation);
  const [stored]=await owner.db.select().from(terasTaskMemory).where(and(eq(terasTaskMemory.tenantId,b.tenantId),
   eq(terasTaskMemory.appUserId,viewerId),eq(terasTaskMemory.conversationId,continued.conversationId)));
  expect(stored.memory).toMatchObject({authorityKey:authorityKey(fresh),turns:2});
 });
 it('continues fresh after real company-B grant withdrawal without resending previously authorized B content',async()=>{
  const first=await firstTurn();
  await owner.db.delete(schema.roleAssignment).where(and(eq(schema.roleAssignment.appUserId,viewerId),eq(schema.roleAssignment.companyId,companyB)));
  expect((await authority(viewer)).current).toBe(false); // Old snapshot genuinely lost authority.
  const fresh=await freshSession(viewerId);
  expect(fresh.userId).toBe(viewer.userId);expect(fresh.personId).toBe(viewer.personId);
  expect(fresh.grants).toEqual([{role:'hr_admin',companyId:b.companyId}]);
  expect(await authority(fresh)).toEqual({current:true,a:true,b:false});
  expect(await nativeAway(fresh)).not.toContain(B_NAME);
  const visible=await withTenant(fresh,tx=>tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,subjectB)));
  expect(visible).toEqual([]); // No independent permission/RLS fixture escape.
  const second=await turn(fresh,'And what next?',first.continuation);
  expect(second.reply).toBe('I can continue with the current context.');expect(sent).toHaveLength(3);
  // Intended RED on unchanged source: current tc1 verifier accepts the old same-login history.
  expect(JSON.stringify(sent[2].turns)).not.toContain(B_NAME);
  expect(sent[2].turns.map(row=>row.role)).toEqual(['user']);
 });
});
