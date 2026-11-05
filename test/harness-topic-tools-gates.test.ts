/** Spec v23 — each topic of a topic tool keeps exactly its capability's own gate, over the real tool provider, the real
 * capabilities and real module and worker switches on fictional data (core/harness/tools.ts topicBindings,
 * core/explainers/capabilities.ts terasCapabilitiesFor).
 *
 *  - operations_status is bound for administrators only; a topic whose module is off for them (the payroll topics with
 *    Payroll disabled) is refused not_permitted while the others still answer, and answers again once it is on;
 *  - explain_why is bound only while the explainers worker may run, for anyone; a topic whose module is off is refused;
 *  - the conversation wiring withholds explain_why itself while the explainers switch is off.
 * The recorder-level checks (what reaches a runner, the disclosure entity) are test/harness-topic-tools.test.ts. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {nativeToolProvider} from '../core/harness/tools';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {conversationTools} from '../core/teras-wiring/turn';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const MODULES=['assistant','payroll','attendance','claims'];
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-topic-gates-passphrase');await resetDb();base=await seedBase();
 for(const code of MODULES)await setModule(base.tenantId,code,'active');});

type Grant={role:typeof schema.roleAssignment.$inferInsert['role'];companyId:string|null};
async function person(name:string,grants:readonly Grant[]):Promise<SessionContext>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'user_'+randomUUID(),personId:hired.personId}).returning({id:schema.appUser.id});
 for(const grant of grants)await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:grant.companyId,role:grant.role});
 await grantAssistant(adminCtx(base),{appUserId:user.id});
 const roles=[...new Set(grants.map(grant=>grant.role))];
 return{...await entitledCtx(base,roles),userId:user.id,personId:hired.personId,roles,grants:[...grants]} as SessionContext;
}
/** The same login with its entitlements resolved again, after a module switch. */
const again=async(ctx:SessionContext)=>({...ctx,entitlements:(await entitledCtx(base,[...(ctx.roles??[])])).entitlements}) as SessionContext;
const scope=()=>({companyId:base.companyId,locale:'en'});
const bound=async(ctx:SessionContext,provider=nativeToolProvider)=>(await provider(ctx,scope(),true)).bindings;
const named=async(ctx:SessionContext,name:string)=>{const binding=(await bound(ctx)).find(row=>row.name===name);if(!binding)throw Error(name+' is not bound');return binding;};

describe('operations_status',()=>{
 it('is bound for administrators only',async()=>{
  const employee=await person('Fictional Topic Employee',[{role:'employee',companyId:null}]);
  const manager=await person('Fictional Topic Manager',[{role:'employee',companyId:null},{role:'manager',companyId:null}]);
  const partner=await person('Fictional Topic Payroll',[{role:'employee',companyId:null},{role:'payroll_partner',companyId:base.companyId}]);
  const hr=await person('Fictional Topic Admin',[{role:'hr_admin',companyId:base.companyId}]);
  for(const ctx of [employee,manager,partner])expect((await bound(ctx)).map(row=>row.name)).not.toContain('operations_status');
  expect((await bound(hr)).map(row=>row.name)).toContain('operations_status');
 },60000);
 it('refuses the payroll topics while Payroll is off for the administrator, answers the others, and answers them again once it is on',async()=>{
  const hr=await person('Fictional Topic Payroll-Off Admin',[{role:'hr_admin',companyId:base.companyId}]);
  await setModule(base.tenantId,'payroll','disabled');
  const off=await named(await again(hr),'operations_status');
  for(const topic of ['payroll_cycle','salary_payroll','payroll_loop_settings','payroll_audit','payroll_learning'])
   expect(await off.run({topic}),topic).toMatchObject({ok:false,refusal:'not_permitted',content:{ok:false,refusal:'not_permitted'}});
  const loops=await off.run({topic:'loops'});
  expect(loops.ok).toBe(true);expect(Array.isArray((loops.content as {loops:unknown[]}).loops)).toBe(true);
  expect((loops.content as {provenance:{page:string}}).provenance.page).toBe('/control-tower/loops');
  expect(await off.run({topic:'ai_quality'})).toMatchObject({ok:true,content:{ok:true}});
  await setModule(base.tenantId,'payroll','active');
  const on=await named(await again(hr),'operations_status');
  const cycle=await on.run({topic:'payroll_cycle',period:'2026-07'});
  expect(cycle).toMatchObject({ok:true,content:{ok:true,period:'2026-07'}});
  // Its own page link, as the payroll cycle page.
  expect(JSON.stringify(cycle.content)).toContain('/control-tower/loops/payroll-cycle');
  // Payroll history learning (P2): its own topic, with learning off as seeded: the mode and zero counts, never an amount.
  const learning=await on.run({topic:'payroll_learning',period:'2026-07'});
  expect(learning).toMatchObject({ok:true,content:{ok:true,period:'2026-07'}});
  expect((learning.content as {companies:{mode:string;people:Record<string,number|null>}[]}).companies.map(c=>[c.mode,c.people]))
   .toEqual([['off',{stable:0,provisional:0,notYet:0,rebasing:0,contradicted:0}]]);
 },60000);
});

describe('explain_why',()=>{
 it('is bound only while the explainers worker may run, and the conversation wiring withholds it while the switch is off',async()=>{
  const employee=await person('Fictional Topic Explainee',[{role:'employee',companyId:null}]);
  const group=await person('Fictional Topic Group Admin',[{role:'hr_admin',companyId:null}]);
  expect((await bound(employee)).map(row=>row.name)).not.toContain('explain_why');
  await setWorkerSwitch(group,{workerId:'explainers',enabled:true});
  expect((await bound(employee)).map(row=>row.name)).toContain('explain_why');
  // The wiring's own second layer: with the switch read as off, explain_why is withheld even when the provider binds it.
  expect((await bound(employee,conversationTools(false))).map(row=>row.name)).not.toContain('explain_why');
  expect((await bound(employee,conversationTools(true))).map(row=>row.name)).toContain('explain_why');
 },60000);
 it('refuses a topic whose module is off for the person, and runs the others as their own explainer',async()=>{
  const employee=await person('Fictional Topic Late Explainee',[{role:'employee',companyId:null}]);
  const group=await person('Fictional Topic Switcher',[{role:'hr_admin',companyId:null}]);
  await setWorkerSwitch(group,{workerId:'explainers',enabled:true});
  await setModule(base.tenantId,'attendance','disabled');
  const why=await named(await again(employee),'explain_why');
  expect(await why.run({topic:'attendance_day',date:'2026-07-01'})).toMatchObject({ok:false,refusal:'not_permitted'});
  // The claims explainer ran: its own refusal for a claim type the person does not hold.
  expect(await why.run({topic:'claim_limit',claim_type:'Fictional Sabbatical'})).toMatchObject({ok:false,refusal:'no_data'});
  // The pay difference explainer ran: no released payslip of the person's own.
  expect(await why.run({topic:'pay_difference'})).toMatchObject({ok:false,refusal:'no_data'});
 },60000);
});
