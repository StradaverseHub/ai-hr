/** ADR-0170 step 1 — the turn harness over the REAL native owners on fictional data, with a scripted model.
 * Pure harness rules (budgets, retries, checks, restoration, memory) are in test/teras-harness-units.test.ts;
 * this file proves the native tool provider: the gate removes the caller's private reads, every call runs as
 * the caller, the semantic model's disclosure applies to real owner output, handles round-trip to the real
 * owner, and figures come back exact for the person. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {ASSISTANT_TOOLS} from '../core/assistant-tools';
import {todayInKualaLumpur} from '../lib/hr-date';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-harness-passphrase');await resetDb();base=await seedBase();for(const code of ['assistant','claims'])await setModule(base.tenantId,code,'active');});
async function people(){
 const admin=adminCtx(base);
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});
 const mine=await hireEmployee(admin,{person:{fullName:'Fictional Harness Employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'17.25',effectiveOn:todayInKualaLumpur()});
 const employeeUser=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:employeeUser});
 const employee:SessionContext={...await entitledCtx(base,['employee']),userId:employeeUser,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const person=await hireEmployee(admin,{person:{fullName:'Fictional Harness Admin',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const adminUser=await createAppUser(base.tenantId,person.personId,'hr_admin');await grantAssistant(admin,{appUserId:adminUser});
 const hr:SessionContext={...await entitledCtx(base,['hr_admin']),userId:adminUser,personId:person.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 return{employee,hr,mine};
}
const turn=(ctx:SessionContext,question:string,script:readonly ScriptStep[])=>{const model=scriptedModel(script);
 return runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()}).then(result=>({result,model}));};
/** The disclosed JSON of the latest tool message the model was sent. */
function lastToolResult(request:ModelRequest):unknown{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
}
type Balances={employments:{employmentId:string;balances:{leaveTypeId:string;leaveType:string;available:string|null}[]}[]};

describe('turn harness over native owners',()=>{
 it('gives a turn about another person no private reads and no caller-private context',async()=>{
  const {employee}=await people();
  const {result,model}=await turn(employee,'How much annual leave does Siti Fictional have?',[{calls:[{name:'my_leave_balances'},{name:'approval_queue'}]},{final:{reply:'I can\'t share another person\'s leave.',mode:'refuse'}}]);
  const offered=model.requests[0].tools.map(tool=>tool.name);
  for(const tool of ASSISTANT_TOOLS)expect(offered,tool.spec.name).not.toContain(tool.spec.name);
  expect(offered).not.toContain('approval_queue');expect(result.trace.gate.reason).toBe('other_person');
  expect(result.trace.calls.map(call=>call.status)).toEqual(['not_offered','not_offered']);expect(result.reads).toEqual([]);
 });
 it('runs the real read as the caller, sends bands and handles, and shows the person the exact figure',async()=>{
  const {employee,mine}=await people();
  // The owner's own figure, read directly: the harness must hand the person exactly this value.
  const direct=await ASSISTANT_TOOLS.find(tool=>tool.spec.name==='my_leave_balances')!.run(employee,{}) as unknown as {ok:true}&Balances;
  const index=direct.employments[0].balances.findIndex(row=>typeof row.available==='number');expect(index).toBeGreaterThanOrEqual(0);
  const exact=direct.employments[0].balances[index].available as unknown as number;
  let placeholder='';
  const {result,model}=await turn(employee,'How much annual leave do I have?',[{calls:[{name:'my_leave_balances'}]},
   request=>{const row=(lastToolResult(request) as Balances).employments[0].balances[index];placeholder=/\{\{F\d+\}\}/.exec(row.available!)![0];
    return{calls:[{name:'leave_entitlement_explain',args:{leave_type_id:row.leaveTypeId,as_of:todayInKualaLumpur()}}]};},
   ()=>({final:{reply:`You have ${placeholder} days available.`,mode:'answer'}})]);
  const sentText=JSON.stringify(model.requests.map(request=>request.messages));
  expect(sentText).not.toContain(mine.employmentId);expect(sentText).not.toContain(base.annualLeaveTypeId);expect(sentText).not.toMatch(/\\"available\\":-?\d/);
  expect(result.trace.calls[0]).toMatchObject({tool:'my_leave_balances',status:'ok'});
  // The handle went back to the real leave type: the owner answered (or refused for its own reason), never an unknown handle.
  expect(result.trace.calls[1].tool).toBe('leave_entitlement_explain');expect(['ok','refused']).toContain(result.trace.calls[1].status);
  expect(result.trace.disclosure[0]).toMatchObject({tool:'my_leave_balances',entity:'leave_balance'});expect(result.trace.disclosure[0].banded.length).toBeGreaterThan(0);
  expect(result.reply).toBe(`You have ${exact} days available.`);expect(result.trace.restoration).toEqual({restored:1,refused:[]});
 });
 it('offers administrator context only to administrators, and suggests a change as a pointer only',async()=>{
  const {employee,hr}=await people();
  const asEmployee=await turn(employee,'Is payroll ready this month?',[{calls:[{name:'setup_readiness'}]},{final:{reply:'I cannot see that.'}}]);
  expect(asEmployee.result.trace.calls[0].status).toBe('not_offered');
  const asAdmin=await turn(hr,'Is payroll ready this month?',[{calls:[{name:'setup_readiness'}]},{final:{reply:'Here is what is still needed.',mode:'guide'}}]);
  expect(asAdmin.result.trace.calls[0].status).toBe('ok');expect(asAdmin.result.reads).toEqual(['setup_readiness']);
  const date=todayInKualaLumpur(new Date(Date.now()+20*86400000));
  const suggest=await turn(employee,'Apply annual leave for me on '+date+'.',[{calls:[{name:'suggest_action',args:{action:'leave.apply',details:{date}}}]},
   {final:{reply:'Open /assistant/leave to choose the details and confirm.',mode:'propose'}}]);
  expect(suggest.result.suggestion).toMatchObject({action:'leave.apply',reviewRoute:'/assistant/leave'});expect(suggest.result.proposals).toEqual([]);
  expect(suggest.result.trace.outcome.fallback).toBe(false);
 });
});
