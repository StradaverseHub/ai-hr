/** AI v2 W1 — the capability catalogue per role over the real owners on fictional data: what each person can do, import,
 * report on or open, filtered by the same checks their pages and services use, with independent expected sets, and the
 * harness's product_capabilities read disclosed under its semantic entity. Fictional people and records only. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {capabilityCatalogueFor,productCapabilities,type CatalogueEntry} from '../core/product-context/capability-catalogue';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.unstubAllEnvs();});
/** A fixed module set, so the expected sets below are independent of the suite's entitlement baseline: the core modules,
 * plus payroll, attendance and claims; every other module off. */
const ON=['payroll','attendance','claims'],OFF=['performance','rewards','lifecycle','toil','multi_cycle_payroll','typed_pay_components','country-my','notifications','system_explorer','assistant','system_testing'];
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-catalogue-passphrase');await resetDb();base=await seedBase();
 for(const code of ON)await setModule(base.tenantId,code,'active');for(const code of OFF)await setModule(base.tenantId,code,null);});

type Grant={role:typeof schema.roleAssignment.$inferInsert['role'];companyId:string|null};
/** A login with its own employment and role assignment rows, as the session would carry them. */
async function person(name:string,grants:readonly Grant[]):Promise<SessionContext>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'user_'+randomUUID(),personId:hired.personId}).returning({id:schema.appUser.id});
 for(const grant of grants)await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:grant.companyId,role:grant.role});
 const roles=[...new Set(grants.map(grant=>grant.role))];
 return{...await entitledCtx(base,roles),userId:user.id,personId:hired.personId,roles,grants:[...grants]} as SessionContext;
}
const callers=async()=>({
 employee:await person('Fictional Catalogue Employee',[{role:'employee',companyId:null}]),
 manager:await person('Fictional Catalogue Manager',[{role:'employee',companyId:null},{role:'manager',companyId:null}]),
 hrAdmin:await person('Fictional Catalogue Admin',[{role:'hr_admin',companyId:base.companyId}]),
 payroll:await person('Fictional Catalogue Payroll',[{role:'employee',companyId:null},{role:'payroll_partner',companyId:base.companyId}]),
 groupAdmin:await person('Fictional Catalogue Group Admin',[{role:'hr_admin',companyId:null}]),
});
const ids=(rows:readonly CatalogueEntry[],kind:CatalogueEntry['kind'])=>rows.filter(row=>row.kind===kind).map(row=>row.id).sort();

// ── Independent expected sets, written from the action registry's actor classes and modules by hand ──
/** Own work, for anyone with an employment: leave, profile, attendance and claims (the modules switched on above). */
const SELF=['leave.apply','leave.cancel','leave.edit','ess.profile.request','attendance.correction.request','attendance.overtime.request','claims.draft.save','claims.submit','claims.cancel'];
/** Decisions offered to anyone who could hold an assigned approval (core/product-context/actions.ts; the review page checks). */
const APPROVER=['approvals.leave.decide','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide'];
/** HR administrator actions in the switched-on modules: not employees.import (listed as the employee import), not the
 * Malaysian statutory update (country-my off) and not replacement-leave credit (toil off). */
const HR=['org.position.archive','org.department.archive','org.employee_id_template.status','org.reporting.change','knowledge_base.article.create',
 'leave.adjustment.apply','employees.movement.transfer','employees.compensation.maintain','attendance.schedule_group.maintain','employees.profile_request.reject',
 'attendance.day_schedule.correct','employees.bank.maintain','employees.document_metadata.maintain','employees.fixed_item.archive','employees.cost_allocation.maintain',
 'employees.payment_method.maintain','employees.tp3_opening.maintain','employees.passport.maintain','employees.emergency_contact.maintain','employees.family.maintain',
 'employees.qualification.maintain','employees.draft.discard','employees.draft.activate'];
/** Payroll access: an administrator or a payroll partner (multi-cycle runs off). */
const PAYROLL=['payroll.close','payroll.reopen','payroll.reset'];
/** Group administrators only. */
const GROUP=['org.people_general.change'];
/** Every import is administrator-only except onboarding (lifecycle staff; lifecycle is off here). */
const IMPORTS=['import:employee_records','import:employee_profile','import:employee_movement','import:bank_statutory','import:employee_family',
 'import:employee_qualifications','import:employee_emergency_contacts','import:cost_allocation','import:information_correction','import:leave_balances',
 'import:leave_history','import:leave_brought_forward','import:payroll_history','import:fixed_transactions','import:individual_transactions',
 'import:run_pay_components','import:pay_codes','import:attendance_clockings','import:shift_roster','import:clocking_cards','import:system_labels'];
/** The reports hub is administrator-only; performance reports need the performance module (off). */
const REPORTS=['report:master','report:attendance_ot','report:attendance_daily','report:leave_balances','report:payroll_register','report:payroll_history',
 'report:claim_types','report:payroll_period_comparison'];
const sorted=(...lists:string[][])=>lists.flat().sort();
/** The actions prepared in chat (written by hand): the three leave actions, the AI v2 W2 attendance correction and
 * overtime request, and the own claim submit and cancel and profile change request. Every other action opens its page. */
const PREPARED_HERE=['approvals.leave.decide','attendance.correction.request','attendance.overtime.request','claims.cancel','claims.submit',
 'ess.profile.request','leave.apply','leave.cancel'];

describe('the capability catalogue per role',()=>{
 it('lists for each role exactly the actions, imports and reports its permissions allow',async()=>{
  const who=await callers(),sizes:Record<string,Record<string,number>>={};
  const expected:Record<keyof typeof who,{action:string[];import:string[];report:string[]}>={
   employee:{action:sorted(SELF,APPROVER),import:[],report:[]},
   manager:{action:sorted(SELF,APPROVER),import:[],report:[]},
   hrAdmin:{action:sorted(SELF,APPROVER,HR,PAYROLL),import:[...IMPORTS].sort(),report:[...REPORTS].sort()},
   payroll:{action:sorted(SELF,APPROVER,PAYROLL),import:[],report:[]},
   groupAdmin:{action:sorted(SELF,APPROVER,HR,PAYROLL,GROUP),import:[...IMPORTS].sort(),report:[...REPORTS].sort()},
  };
  for(const [name,ctx] of Object.entries(who) as [keyof typeof who,SessionContext][]){
   const rows=await capabilityCatalogueFor(ctx,{locale:'en'});
   expect(ids(rows,'action'),name).toEqual(expected[name].action);
   expect(ids(rows,'import'),name).toEqual(expected[name].import);
   expect(ids(rows,'report'),name).toEqual(expected[name].report);
   expect(new Set(rows.map(row=>row.id)).size,name+' ids are unique').toBe(rows.length);
   sizes[name]={action:ids(rows,'action').length,import:ids(rows,'import').length,report:ids(rows,'report').length,page:ids(rows,'page').length,total:rows.length};
  }
  // The per-role sizes on this fixture, for the report.
  console.log('AIHR_CAPABILITY_CATALOGUE_SIZES '+JSON.stringify(sizes));
 });
 it('marks prepare only for the actions the semantic model prepares, and nothing else',async()=>{
  const {employee,hrAdmin}=await callers();
  for(const ctx of [employee,hrAdmin]){
   const rows=await capabilityCatalogueFor(ctx);
   expect(rows.filter(row=>row.mode==='prepare').map(row=>row.id).sort()).toEqual(PREPARED_HERE);
   // A surface that offers no action suggestions prepares nothing.
   expect((await capabilityCatalogueFor(ctx,{prepare:false})).filter(row=>row.mode==='prepare')).toEqual([]);
  }
 });
 it('lists pages only where the page guard admits the caller, never an administrator page to anyone else',async()=>{
  const {employee,manager,hrAdmin,payroll,groupAdmin}=await callers();
  const pages=async(ctx:SessionContext)=>(await capabilityCatalogueFor(ctx)).filter(row=>row.kind==='page').map(row=>row.page!);
  const [asEmployee,asManager,asAdmin,asPayroll,asGroup]=await Promise.all([employee,manager,hrAdmin,payroll,groupAdmin].map(pages));
  expect(asEmployee).toEqual(expect.arrayContaining(['/me/payslip','/claims','/attendance/clock']));
  expect(asManager).toContain('/manage/my-team');expect(asEmployee).not.toContain('/manage/my-team');
  for(const list of [asEmployee,asManager,asPayroll])
   expect(list.filter(path=>/^\/(admin|control-tower|payroll|reports|analytics)(\/|\?|$)/.test(path)),'no administrator page').toEqual([]);
  // The payroll pages guard with requireAdmin (scopedAdmin): a payroll partner is not sent there.
  expect(asPayroll).not.toContain('/payroll');expect(asPayroll).not.toContain('/payroll/reports');
  expect(asAdmin).toEqual(expect.arrayContaining(['/payroll','/payroll/reports','/admin/organization','/control-tower/readiness','/admin/security-center']));
  // Creating logins is a group administrator's (requireGroupAdministration); access configuration is never assumed.
  expect(asAdmin).not.toContain('/admin/users/create');expect(asGroup).toContain('/admin/users/create');
  for(const list of [asAdmin,asGroup])expect(list).not.toContain('/admin/users/access');
  // Report and import pages are listed as reports and imports, not again as pages.
  for(const list of [asAdmin,asGroup])for(const path of list)expect(path,path).not.toMatch(/^\/reports(\/|\?|$)|import/);
 });
 it('links an import or report page only where the caller may open it, and names its template',async()=>{
  const {hrAdmin}=await callers(),rows=await capabilityCatalogueFor(hrAdmin);
  const entry=(id:string)=>rows.find(row=>row.id===id);
  expect(entry('import:payroll_history')).toEqual({id:'import:payroll_history',kind:'import',mode:'open',area:'payroll',
   title:'Import payroll history (past payslips from a previous system)',page:'/payroll/history-import'});
  expect(entry('import:pay_codes')).toMatchObject({page:'/admin/pay-components',template:true});
  expect(entry('report:payroll_register')).toMatchObject({kind:'report',mode:'open',area:'payroll',title:'Payroll register',page:'/reports?cat=payroll'});
  for(const row of rows.filter(item=>item.kind==='action'))expect(row.page,row.id).toBeUndefined();
 });
 it('lists the onboarding import by the lifecycle staff level the database holds',async()=>{
  await setModule(base.tenantId,'lifecycle','active');
  const {employee,hrAdmin}=await callers();
  const has=async(ctx:SessionContext)=>(await capabilityCatalogueFor(ctx)).some(row=>row.id==='import:onboarding_new_hires');
  expect(await has(hrAdmin)).toBe(true);expect(await has(employee)).toBe(false);
  // Made a lifecycle agent, the same employee may import new hires (app/lifecycle/_guard.ts lifecycleSession(LEVEL.agent)).
  await owner.db.insert(schema.lcStaff).values({tenantId:base.tenantId,userId:employee.userId!,companyId:base.companyId,level:'agent'});
  const rows=await capabilityCatalogueFor(employee);
  expect(rows.find(row=>row.id==='import:onboarding_new_hires')).toEqual({id:'import:onboarding_new_hires',kind:'import',mode:'open',area:'lifecycle',
   title:'Import new hires into onboarding from Excel',template:true});
  // Still nothing administrator-only for that employee.
  expect(ids(rows,'import')).toEqual(['import:onboarding_new_hires']);
 });
 it('answers the tool: no filter gives areas, a kind lists entries, and nothing for a role that has none',async()=>{
  const {payroll,hrAdmin}=await callers();
  const summary=await productCapabilities(hrAdmin,{},{locale:'en'});
  expect(summary.ok).toBe(true);if(!summary.ok)return;
  expect(summary.entries.map(row=>row.id).sort()).toEqual(PREPARED_HERE);
  expect(summary.areas?.find(row=>row.area==='payroll')).toMatchObject({imports:5,reports:3});
  const imports=await productCapabilities(hrAdmin,{kind:'import',area:'payroll history'},{});
  expect(imports.ok&&imports.entries.map(row=>row.id)).toEqual(['import:payroll_history']);
  const none=await productCapabilities(payroll,{kind:'import',area:'payroll history'},{});
  expect(none).toMatchObject({ok:true,entries:[],totalRows:0});
  expect(await productCapabilities(hrAdmin,{kind:'everything'},{})).toMatchObject({ok:false,refusal:'invalid_input'});
 });
});

/** The disclosed JSON of the latest tool message the model was sent. */
function lastToolResult(request:ModelRequest):Record<string,unknown>{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
}
describe('product_capabilities in a harness turn',()=>{
 const turn=async(ctx:SessionContext,question:string,args:Record<string,unknown>)=>{
  const model=scriptedModel([{calls:[{name:'product_capabilities',args}]},{final:{reply:'Which import do you mean?',mode:'clarify'}}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  return{result,model};
 };
 it('offers it on an ordinary turn and discloses the caller\'s imports under its declared entity',async()=>{
  const {hrAdmin}=await callers();
  const {result,model}=await turn(hrAdmin,'help me import data',{kind:'import'});
  expect(model.requests[0].tools.map(tool=>tool.name)).toContain('product_capabilities');
  expect(result.trace.calls.map(call=>call.status)).toEqual(['ok']);
  expect(result.trace.disclosure).toEqual([expect.objectContaining({tool:'product_capabilities',entity:'product_capability',removed:[],undeclared:[],withheld:[]})]);
  const sent=lastToolResult(model.requests[1]) as {entries:{id:string;title:string}[];totalRows:number};
  const own=(await capabilityCatalogueFor(hrAdmin)).filter(row=>row.kind==='import').map(row=>row.id);
  expect(sent.entries.map(row=>row.id)).toEqual(own);expect(sent.totalRows).toBe(IMPORTS.length);
  expect(sent.entries.map(row=>row.title)).toContain('Import payroll history (past payslips from a previous system)');
  expect(result.reads).toContain('product_capabilities');
  // Spec v13: suggest_action names the purposes of the declared actions this caller holds, so it can be called directly.
  const suggest=model.requests[0].tools.find(tool=>tool.name==='suggest_action')!.description;
  expect(suggest).toContain('What these actions do: leave.apply: Apply for leave for yourself.');
  expect(suggest).toContain('claims.submit: Submit an expense claim for yourself.');
  expect(suggest).not.toContain('payroll.close:');expect(suggest).not.toContain('employees.import:');
 });
 it('is kept on a turn about another person (spec v13), listing only the caller\'s own capabilities and no private read',async()=>{
  // Spec v13: product_capabilities is a public context tool, like available_actions: it lists what the caller may do,
  // never anything about the person named, so "can you …?" can be answered on a gated turn too.
  const {hrAdmin,employee}=await callers();
  const {result,model}=await turn(hrAdmin,'Can you import Siti\'s leave balance?',{kind:'import'});
  expect(result.trace.gate.reason).toBe('other_person');
  const offered=model.requests[0].tools.map(tool=>tool.name);
  expect(offered).toContain('product_capabilities');
  for(const privateRead of ['my_leave_balances','my_leave_requests','approval_queue'])expect(offered,privateRead).not.toContain(privateRead);
  expect(result.trace.calls.map(call=>call.status)).toEqual(['ok']);
  const sent=lastToolResult(model.requests[1]) as {entries:{id:string}[];totalRows:number};
  expect(sent.entries.map(row=>row.id)).toEqual((await capabilityCatalogueFor(hrAdmin)).filter(row=>row.kind==='import').map(row=>row.id));
  expect(sent.totalRows).toBe(IMPORTS.length);expect(JSON.stringify(sent)).not.toMatch(/Siti/);
  expect(result.reads).toEqual(['product_capabilities']);
  // An employee asking the same is told from their own catalogue: no import is theirs.
  const asEmployee=await turn(employee,'Can you import Siti\'s leave balance?',{kind:'import'});
  expect(asEmployee.result.trace.gate.reason).toBe('other_person');
  expect(lastToolResult(asEmployee.model.requests[1])).toMatchObject({ok:true,entries:[],totalRows:0});
 });
});
