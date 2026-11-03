/** AI v2 Phase 2 (wave 1 integration) — the payroll-cycle loop reads (core/semantic-model/entities-payroll-loops.ts,
 * core/explainers/payroll-loops.ts) over their real owners on fictional data (migrations 0960 and 0963 to 0965).
 *
 *  1. Role access: administrators only. An employee and a manager are not offered any of the four, a direct call refuses
 *     them, and a model that calls one anyway in their turn gets `not_offered` with no read.
 *  2. Company scoping: an HR administrator of one company sees that company only; the group administrator sees both.
 *  3. Isolation: another tenant's administrator sees none of it.
 *  4. Through the harness, every returned field is declared (nothing undeclared, nothing removed), and what the model
 *     receives names no administrator and carries no id.
 *  5. The vocabularies the declarations repeat equal their owners'.
 * Expected values are written out from the fixture, never re-derived from the owners. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {setPayrollLoopSetting,CHECK_INTERVALS} from '../core/loops/payroll-loop-settings';
import {PRE_SALARY_CHECKS} from '../core/loops/pre-salary-checks';
import {PAY_CAUSE_KINDS} from '../core/pay-difference';
import {CHECK_INTERVAL_VALUES,PAY_CAUSES,PRE_SALARY_CHECK_KEYS} from '../core/semantic-model/entities-payroll-loops';
import {TERAS_CAPABILITIES,terasCapabilitiesFor} from '../core/explainers/capabilities';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const READS=['payroll_cycle_status','salary_payroll_checks','payroll_loop_settings','payroll_audit_status'] as const;
type ReadName=(typeof READS)[number];
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ADMIN_NAMES=/Group Administrator|Company Administrator/;
const SECOND='Fictional Payroll Loops Second Sdn Bhd';
type Login=SessionContext&{userId:string;personId:string};
type Out=Record<string,unknown>&{ok:boolean;companies:Record<string,unknown>[]};

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-payroll-loop-reads-passphrase');
 await resetDb();b=await seedBase();
 for(const code of ['assistant','payroll','attendance'])await setModule(b.tenantId,code,'active');
});

async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin'):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:userId});
 return {...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]};
}
/** An HR administrator of one company only. */
async function companyAdmin(base:Base,companyId:string,departmentId:string):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Payroll Company Administrator',primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:hired.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 await grantAssistant(adminCtx(base),{appUserId:user.id});
 return {...await entitledCtx(base,['hr_admin']),userId:user.id,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]};
}
const capability=(name:ReadName)=>TERAS_CAPABILITIES.find(row=>row.name===name)!;
const read=async(name:ReadName,ctx:SessionContext,input:Record<string,unknown>={},companyId=b.companyId)=>await capability(name).run(ctx,input,{companyId}) as unknown as Out;
const names=(out:Out)=>out.companies.map(row=>row.company as string).sort();
const turn=(ctx:SessionContext,question:string,script:readonly ScriptStep[])=>{const model=scriptedModel(script);
 return runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:b.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()}).then(result=>({result,model}));};
function lastToolResult(request:ModelRequest):string{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return tool.content as string;
}

/** Two companies; the second has its own administrator and a changed setting (checked hourly, threshold 20%). */
async function fixture(){
 const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:SECOND}).returning();
 const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:second.id,name:'Fictional Payroll Ops'}).returning();
 const [first]=await owner.db.select({name:schema.company.legalName}).from(schema.company).where(eq(schema.company.id,b.companyId));
 const group=await login(b,'Fictional Payroll Group Administrator','hr_admin');
 const scoped=await companyAdmin(b,second.id,dept.id);
 await setPayrollLoopSetting(group,{companyId:second.id,interval:'hourly',thresholdBp:2000});
 return{group,scoped,first:first.name,second:SECOND};
}

describe('the payroll-cycle loop reads',()=>{
 it('repeat their owners\' vocabularies exactly',()=>{
  expect([...PRE_SALARY_CHECK_KEYS]).toEqual([...PRE_SALARY_CHECKS]);
  expect([...CHECK_INTERVAL_VALUES]).toEqual([...CHECK_INTERVALS]);
  expect([...PAY_CAUSES]).toEqual([...PAY_CAUSE_KINDS]);
 });

 it('are offered to administrators only: an employee and a manager get nothing',async()=>{
  const employee=await login(b,'Fictional Payroll Employee','employee'),manager=await login(b,'Fictional Payroll Manager','manager');
  const group=await login(b,'Fictional Payroll Group Administrator','hr_admin');
  expect((await terasCapabilitiesFor(group)).map(row=>row.name)).toEqual(expect.arrayContaining([...READS]));
  for(const ctx of [employee,manager]){
   const offered=(await terasCapabilitiesFor(ctx)).map(row=>row.name);
   for(const name of READS){
    expect(offered,name).not.toContain(name);
    expect(await read(name,ctx),name).toMatchObject({ok:false,refusal:'not_permitted'});
   }
   const {result,model}=await turn(ctx,'Is this month\'s payroll on track?',[{calls:[{name:'payroll_cycle_status'}]},{final:{reply:'That is for your HR administrator.',mode:'answer'}}]);
   expect(model.requests[0].tools.map(tool=>tool.name)).not.toContain('payroll_cycle_status');
   expect(result.trace.calls).toEqual([expect.objectContaining({tool:'payroll_cycle_status',status:'not_offered'})]);expect(result.reads).toEqual([]);
  }
 },60000);

 it('show each administrator only the companies they administer, and the settings each company keeps',async()=>{
  const {group,scoped,first,second}=await fixture();
  const cycle=await read('payroll_cycle_status',group,{period:'2026-07'});
  expect(cycle).toMatchObject({ok:true,period:'2026-07',statutoryDue:'2026-08-15'});
  expect(names(cycle)).toEqual([first,second].sort());
  // No payroll run: the Audit loop has nothing done for either company.
  for(const row of cycle.companies)expect(row.audit).toEqual({state:'open',openFindings:0});
  expect((cycle.history as unknown[]).length).toBe(3);
  const settings=await read('payroll_loop_settings',group);
  expect(settings.companies.find(row=>row.company===first)).toEqual({company:first,version:0,source:'default',interval:'daily',thresholdPercent:15,exclusions:[],proposals:[]});
  expect(settings.companies.find(row=>row.company===second)).toEqual({company:second,version:1,source:'admin',interval:'hourly',thresholdPercent:20,exclusions:[],proposals:[]});
  const salary=await read('salary_payroll_checks',group,{period:'2026-07'});
  expect(salary.companies.map(row=>[row.company,row.thresholdPercent,row.runs,row.flags]).sort()).toEqual([
   [first,15,[],{open:0,expected:0,problem:0}],[second,20,[],{open:0,expected:0,problem:0}]].sort());
  for(const row of salary.companies)expect(row.cutOff).toMatch(/^2026-07-\d{2}$/);
  const audit=await read('payroll_audit_status',group,{period:'2026-06'});
  expect(audit).toMatchObject({ok:true,period:'2026-06',dueDate:'2026-07-15'});
  expect(names(audit)).toEqual([first,second].sort());
  for(const row of audit.companies)expect(row).toMatchObject({paused:false,done:false,runs:0,payslips:{total:0,released:0,opened:0},bankFiles:0,
   corrections:{count:0,withoutRootCause:0},findings:{open:0,disposed:0},repeatIssues:[],captures:0,
   statutory:['epf','socso_eis','pcb_cp39','hrd'].map(form=>({form,prepared:false,preparedOn:null,beforeDue:null,filed:false,filedOn:null}))});
  // The second company's own administrator: that company only, in every read.
  for(const name of READS)expect(names(await read(name,scoped,{period:'2026-07'})),name).toEqual([second]);
  // Counts, states and configuration only: no person, no id.
  for(const name of READS){const text=JSON.stringify(await read(name,group,{period:'2026-07'}));expect(text,name).not.toMatch(UUID);expect(text,name).not.toMatch(ADMIN_NAMES);}
 },60000);

 it('show another tenant nothing of it',async()=>{
  await fixture();
  const b2=await seedBase();
  await setModule(b2.tenantId,'payroll','active');
  const other=await login(b2,'Fictional Payroll Other Tenant Administrator','hr_admin');
  for(const name of READS){
   const out=await read(name,other,{period:'2026-07'},b2.companyId);
   expect(out.ok,name).toBe(true);
   expect(names(out),name).not.toContain(SECOND);
  }
 },60000);

 it.each([
  ['payroll_cycle_status','payroll_cycle','Is this month\'s payroll on track?'],
  ['salary_payroll_checks','salary_payroll_run','Did the bank files match net pay this month?'],
  ['payroll_loop_settings','payroll_loop_setting','What is our net-swing threshold?'],
  ['payroll_audit_status','payroll_audit_status','Are last month\'s statutory files filed?'],
] as const)('%s reaches the model declared in full, with no administrator and no id',async(name,entity,question)=>{
  const {group,second}=await fixture();
  const {result,model}=await turn(group,question,[{calls:[{name}]},{final:{reply:'Here is what the page shows.',mode:'answer'}}]);
  expect(model.requests[0].tools.map(tool=>tool.name)).toContain(name);
  expect(result.trace.calls).toEqual([expect.objectContaining({tool:name,status:'ok'})]);
  expect(result.trace.disclosure[0]).toMatchObject({tool:name,entity,undeclared:[],removed:[]});
  const sent=lastToolResult(model.requests[1]);
  expect(sent).toContain(second);
  expect(sent).not.toMatch(UUID);expect(sent).not.toMatch(ADMIN_NAMES);
 },60000);
});
