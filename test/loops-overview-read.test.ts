/** AI v2 W8 — the loops overview read (loops_overview, core/semantic-model/entities-loops.ts) over its real owners on
 * fictional data (migration 0960, core/loops/views.ts).
 *
 *  1. Role access: administrators only. An employee and a manager are not offered it, a direct call refuses them, and a
 *     model that calls it anyway in their turn gets `not_offered` with no read.
 *  2. Company scoping: an HR administrator of one company counts that company's cards and sees that company's pauses
 *     and levels only; the group administrator sees both companies. Each loop reports its level in each company (AI v2
 *     Phase 2 P2-1, migration 0963) and the highest level it may reach: Prepare for the pay, employment status and
 *     passport loops, Act and audit for missed clock-outs and missing employee data.
 *  3. Isolation: another tenant's administrator sees none of it.
 *  4. Through the harness, every returned field is declared (nothing undeclared, nothing removed), and what the model
 *     receives names no employee, no sponsor and no id.
 * Expected values are written out from the fixture, never re-derived from the owners. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {runLoop} from '../core/loops/run';
import {setLoopPause} from '../core/loops/controls';
import {setLoopLevel} from '../core/loops/levels';
import {TERAS_CAPABILITIES,terasCapabilitiesFor} from '../core/explainers/capabilities';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

/** The HR day the run is for: Thursday 2 July 2026; the probation of each fixture employee ends ten days later. */
const TODAY='2026-07-02',PROBATION_ENDS='2026-07-12';
const LOOPS=['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry','loop_salary_payroll'];
/** The highest level each loop may reach (core/loops/autonomy.ts), written out: the six loops in page order. */
const CEILINGS=['prepare','prepare','act_audit','act_audit','prepare','prepare'];
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
type Login=SessionContext&{userId:string;personId:string;employmentId:string};
type LoopOut={loop:string;ceiling:string;levels:{company:string;level:string}[];on:boolean;stopped:boolean;running:boolean;lastRun:{at:string;status:string;capped:boolean}|null;openNow:number;waitingNow:number;pausedIn:{company:string}[]};
type Overview={ok:true;canSwitch:boolean;loops:LoopOut[];provenance:{owner:string;page:string}};

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-loops-overview-passphrase');
 await resetDb();b=await seedBase();
 for(const code of ['assistant','payroll','attendance'])await setModule(b.tenantId,code,'active');
});

async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin',companyId=base.companyId,departmentId=base.deptA):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:userId});
 return {...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}],employmentId:hired.employmentId};
}
/** An HR administrator of one company only. */
async function companyAdmin(base:Base,companyId:string,departmentId:string):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Second Company Administrator',primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:hired.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 return {...await entitledCtx(base,['hr_admin']),userId:user.id,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}],employmentId:hired.employmentId};
}
const capability=TERAS_CAPABILITIES.find(row=>row.name==='loops_overview')!;
const overview=async(ctx:SessionContext)=>await capability.run(ctx,{},{companyId:b.companyId}) as unknown as Overview;
const loop=(out:Overview,id:string)=>out.loops.find(row=>row.loop===id)!;
const turn=(ctx:SessionContext,question:string,script:readonly ScriptStep[])=>{const model=scriptedModel(script);
 return runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:b.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()}).then(result=>({result,model}));};
function lastToolResult(request:ModelRequest):string{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return tool.content as string;
}

/** Two companies, one probationer in each, the probation loop on and run once; the group administrator pauses it in the
 * first company, and the second company's own administrator pauses the passport loop there. The group administrator
 * then moves the missed clock-outs loop down to Watch in the second company (a level change needs no certificate
 * downwards). */
async function fixture(){
 const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Loops Second Sdn Bhd'}).returning();
 const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:second.id,name:'Fictional Loops Ops'}).returning();
 const [first]=await owner.db.select({name:schema.company.legalName}).from(schema.company).where(eq(schema.company.id,b.companyId));
 const group=await login(b,'Fictional Loops Group Administrator','hr_admin');
 const scoped=await companyAdmin(b,second.id,dept.id);
 const probationers=[await login(b,'Fictional Loops First Probationer','employee'),await login(b,'Fictional Loops Second Probationer','employee',second.id,dept.id)];
 for(const who of probationers)await owner.db.update(schema.employment).set({probationEndDate:PROBATION_ENDS}).where(eq(schema.employment.id,who.employmentId));
 await setWorkerSwitch(group,{workerId:'loop_probation_ending',enabled:true});
 const principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
 expect(await runLoop('loop_probation_ending',{tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,today:TODAY})).toMatchObject({status:'ran',companies:2});
 await setLoopPause(group,{workerId:'loop_probation_ending',companyId:b.companyId,paused:true});
 await setLoopPause(scoped,{workerId:'loop_document_expiry',companyId:second.id,paused:true});
 expect(await setLoopLevel(group,{workerId:'loop_missed_clock_outs',companyId:second.id,toLevel:0,expectedLevel:1})).toMatchObject({companyId:second.id,level:0});
 return{group,scoped,probationers,firstName:first.name,secondName:'Fictional Loops Second Sdn Bhd'};
}

describe('loops_overview',()=>{
 it('is offered to administrators only: an employee and a manager get nothing',async()=>{
  const employee=await login(b,'Fictional Loops Employee','employee'),manager=await login(b,'Fictional Loops Manager','manager');
  const group=await login(b,'Fictional Loops Administrator','hr_admin');
  expect((await terasCapabilitiesFor(group)).map(row=>row.name)).toContain('loops_overview');
  for(const ctx of [employee,manager]){
   expect((await terasCapabilitiesFor(ctx)).map(row=>row.name)).not.toContain('loops_overview');
   expect(await capability.run(ctx,{},{companyId:b.companyId})).toEqual({ok:false,refusal:'not_permitted',message:'The loops overview is available to administrators only.'});
   const {result,model}=await turn(ctx,'Which loops are switched on?',[{calls:[{name:'loops_overview'}]},{final:{reply:'That is for your HR administrator.',mode:'answer'}}]);
   expect(model.requests[0].tools.map(tool=>tool.name)).not.toContain('loops_overview');
   expect(result.trace.calls).toEqual([expect.objectContaining({tool:'loops_overview',status:'not_offered'})]);expect(result.reads).toEqual([]);
  }
 },60000);

 it('counts and pauses only within the companies the administrator administers',async()=>{
  const {group,scoped,firstName,secondName}=await fixture();
  const all=await overview(group);
  expect(all.ok).toBe(true);expect(all.canSwitch).toBe(true);
  expect(all.loops.map(row=>row.loop)).toEqual(LOOPS);
  expect(all.loops.map(row=>row.ceiling)).toEqual(CEILINGS);
  expect(all.loops.every(row=>!row.stopped&&row.waitingNow===0)).toBe(true);
  const both=[{company:firstName,level:'prepare'},{company:secondName,level:'prepare'}];
  for(const id of LOOPS.filter(id=>id!=='loop_missed_clock_outs'))expect(loop(all,id).levels,id).toEqual(both);
  expect(loop(all,'loop_probation_ending')).toMatchObject({on:true,running:true,openNow:2,lastRun:{status:'ran',capped:false},pausedIn:[{company:firstName}]});
  expect(Number.isNaN(Date.parse(loop(all,'loop_probation_ending').lastRun!.at))).toBe(false);
  expect(loop(all,'loop_document_expiry')).toEqual({loop:'loop_document_expiry',ceiling:'prepare',levels:both,on:false,stopped:false,running:false,lastRun:null,openNow:0,waitingNow:0,pausedIn:[{company:secondName}]});
  expect(loop(all,'loop_missed_clock_outs')).toEqual({loop:'loop_missed_clock_outs',ceiling:'act_audit',levels:[{company:firstName,level:'prepare'},{company:secondName,level:'watch'}],
   on:false,stopped:false,running:false,lastRun:null,openNow:0,waitingNow:0,pausedIn:[]});
  expect(loop(all,'loop_salary_payroll')).toEqual({loop:'loop_salary_payroll',ceiling:'prepare',levels:both,on:false,stopped:false,running:false,lastRun:null,openNow:0,waitingNow:0,pausedIn:[]});
  expect(all.provenance).toMatchObject({owner:'core/loops/views.ts#loopsOverview',page:'/control-tower/loops'});
  // The second company's administrator: its own card and run, its own pause, never the first company's pause.
  const mine=await overview(scoped);
  expect(mine.canSwitch).toBe(false);
  expect(loop(mine,'loop_probation_ending')).toMatchObject({on:true,running:true,openNow:1,lastRun:{status:'ran'},pausedIn:[]});
  expect(loop(mine,'loop_document_expiry').pausedIn).toEqual([{company:secondName}]);
  // Its own company's levels only: Watch for missed clock-outs there, Prepare for every other loop.
  expect(mine.loops.map(row=>[row.loop,row.levels])).toEqual(LOOPS.map(id=>[id,[{company:secondName,level:id==='loop_missed_clock_outs'?'watch':'prepare'}]]));
  // Counts and states only: no person, no sponsor, no id.
  for(const out of [all,mine]){const text=JSON.stringify(out);expect(text).not.toMatch(UUID);expect(text).not.toMatch(/Probationer|Group Administrator|Company Administrator/);}
 },60000);

 it('shows another tenant nothing of it',async()=>{
  const {secondName}=await fixture();
  const b2=await seedBase();
  const other=await login(b2,'Fictional Loops Other Tenant Administrator','hr_admin');
  const out=await capability.run(other,{},{companyId:b2.companyId}) as unknown as Overview;
  expect(out.loops.map(row=>[row.loop,row.on,row.running,row.lastRun,row.openNow,row.waitingNow,row.pausedIn])).toEqual(LOOPS.map(id=>[id,false,false,null,0,0,[]]));
  // Its own single company, at Prepare for every loop: the first tenant's Watch level and company never reach it.
  expect(out.loops.map(row=>row.levels.map(item=>item.level))).toEqual(LOOPS.map(()=>['prepare']));
  expect(JSON.stringify(out)).not.toContain(secondName);
 },60000);

 it('reaches the model declared in full, with no employee, sponsor or id',async()=>{
  const {group,firstName}=await fixture();
  const {result,model}=await turn(group,'Which loops are switched on, and where is any paused?',[{calls:[{name:'loops_overview'}]},{final:{reply:'The probation loop is on.',mode:'answer'}}]);
  expect(model.requests[0].tools.map(tool=>tool.name)).toContain('loops_overview');
  expect(result.trace.calls).toEqual([expect.objectContaining({tool:'loops_overview',status:'ok'})]);
  expect(result.trace.disclosure[0]).toMatchObject({tool:'loops_overview',entity:'loop_overview',undeclared:[],removed:[]});
  const sent=lastToolResult(model.requests[1]);
  expect(sent).toContain('loop_probation_ending');expect(sent).toContain(firstName);expect(sent).toContain('watch');expect(sent).toContain('loop_salary_payroll');
  expect(sent).not.toMatch(UUID);expect(sent).not.toMatch(/Probationer|Group Administrator|Company Administrator/);
 },60000);
});
