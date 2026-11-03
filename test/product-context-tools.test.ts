/** ADR-0169 phase B: the Assistant context and capability layer over real owners on fictional data. */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
import * as schema from '../db/schema';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {seedGuides} from '../db/seed-guides';
import {loadGuides} from '../lib/guide-catalog';
import {ASSISTANT_TOOLS} from '../core/assistant-tools';
import {ASSISTANT_PROPOSABLE_ACTIONS} from '../lib/ai/assistant-action-proposal-hints';
import {capabilityRegistry,checkProposal,contextToolSpecsFor,runContextTool,suggestAction} from '../core/product-context/tools';
import {ACTION_PURPOSE,SUGGESTABLE_ACTIONS,actionCatalogueFor} from '../core/product-context/actions';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.unstubAllEnvs();});
beforeEach(async()=>{await resetDb();base=await seedBase();await seedGuides(owner.db,base.tenantId);});
const NAMES=['Fictional Context Employee','Fictional Context Admin'];
async function people(){
 const admin=adminCtx(base),employee=await hireEmployee(admin,{person:{fullName:NAMES[0],primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const hrPerson=await hireEmployee(admin,{person:{fullName:NAMES[1],primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const employeeUser=await createAppUser(base.tenantId,employee.personId,'employee'),adminUser=await createAppUser(base.tenantId,hrPerson.personId,'hr_admin');
 return{employee:{...await entitledCtx(base,['employee']),userId:employeeUser,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext,
  hr:{...await entitledCtx(base,['hr_admin']),userId:adminUser,personId:hrPerson.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext};
}
const scope=()=>({companyId:base.companyId,locale:'en'});

describe('Assistant context layer tools',()=>{
 it('offers setup readiness to administrators only and refuses it otherwise',async()=>{
  const {employee,hr}=await people();
  expect(contextToolSpecsFor(employee).map(spec=>spec.name)).toEqual(['product_destinations','product_guidance','available_actions','approval_queue']);
  expect(contextToolSpecsFor(hr).map(spec=>spec.name)).toEqual(['product_destinations','product_guidance','available_actions','approval_queue','setup_readiness','company_setup']);
  expect(await runContextTool(employee,'setup_readiness',{},scope())).toEqual({ok:false,refusal:'not_offered'});
  expect(await runContextTool(employee,'company_setup',{},scope())).toEqual({ok:false,refusal:'not_offered'});
  expect(await runContextTool(hr,'unknown_tool',{},scope())).toEqual({ok:false,refusal:'not_offered'});
 });
 it('returns setup counts and statuses without employee names or codes',async()=>{
  const {hr}=await people(),result=await runContextTool(hr,'setup_readiness',{},scope());
  expect(result.ok).toBe(true);if(!result.ok)return;
  const content=result.content as {payroll:{ready:boolean;checks:{key:string;href:string}[]}|null;records:{employees:number;gaps:{id:string;count:number}[]}|null};
  expect(content.payroll?.ready).toBe(false);expect(content.payroll?.checks.length).toBeGreaterThan(3);
  for(const check of content.payroll!.checks)expect(check.href.startsWith('/')).toBe(true);
  expect(content.records?.employees).toBeGreaterThanOrEqual(2);expect(content.records?.gaps.find(gap=>gap.id==='no_compensation')?.count).toBeGreaterThanOrEqual(2);
  const body=JSON.stringify(content);for(const name of NAMES)expect(body.includes(name),name).toBe(false);expect(body).not.toMatch(/EMP-\d+/);
 });
 it('lists configured leave types and schedule groups with real setup pages, and no people',async()=>{
  const {hr}=await people(),result=await runContextTool(hr,'company_setup',{},scope());
  expect(result.ok).toBe(true);if(!result.ok)return;
  const content=result.content as {leaveTypes:{code:string;name:string;paid:boolean}[];attendance:{scheduleGroups:{name:string;isDefault:boolean}[]}|null;pages:{leaveTypes:string;scheduleGroups:string|null}};
  const [annual]=await owner.db.select({code:schema.leaveType.code}).from(schema.leaveType).where(eq(schema.leaveType.id,base.annualLeaveTypeId));
  expect(content.leaveTypes.map(row=>row.code)).toContain(annual.code);
  for(const row of content.leaveTypes){expect(Object.keys(row).sort()).toEqual(['code','name','paid']);expect(typeof row.paid).toBe('boolean');}
  for(const page of [content.pages.leaveTypes,content.pages.scheduleGroups].filter((page):page is string=>Boolean(page)))expect(existsSync(join(process.cwd(),'app',page,'page.tsx')),page).toBe(true);
  const body=JSON.stringify(content);for(const name of NAMES)expect(body.includes(name),name).toBe(false);
 });
 // After spec v20's scored run 41641279562 (grp-zh-1, "我们集团有哪些公司？"): no read named the administrator's companies, so
 // a group administrator was told only her own employment's company and sent to the org chart.
 it('lists the active companies an administrator administers, by name, with the Organization page',async()=>{
  const {hr}=await people();
  await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional Sister Sdn Bhd'});
  await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional Closed Sdn Bhd',archivedAt:new Date('2025-01-01T00:00:00Z')});
  const companies=async(ctx:SessionContext)=>{const result=await runContextTool(ctx,'company_setup',{},scope());if(!result.ok)throw Error('company_setup refused');
   return result.content as {companies:{name:string}[];pages:{companies:string}};};
  // A group-wide HR administrator (createAppUser grants hr_admin for every company): every active company, by legal name.
  const group=await companies(hr);
  expect(group.companies).toEqual([{name:'Acme Sdn Bhd'},{name:'Fictional Sister Sdn Bhd'}]);
  expect(group.pages.companies).toBe('/admin/organization');expect(existsSync(join(process.cwd(),'app/admin/organization/page.tsx'))).toBe(true);
  const destinations=await runContextTool(hr,'product_destinations',{},scope());if(!destinations.ok)throw Error('destinations unavailable');
  expect((destinations.content as {href:string}[]).map(row=>row.href)).toContain(group.pages.companies);
  // A company-scoped HR administrator: their own company only (the database's app.is_admin_for, as the Organization listing).
  const scopedPerson=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Scoped Admin',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
  const [scopedUser]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'user_'+randomUUID(),personId:scopedPerson.personId}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:scopedUser.id,companyId:base.companyId,role:'hr_admin'});
  const scoped={...await entitledCtx(base,['hr_admin']),userId:scopedUser.id,personId:scopedPerson.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]} as SessionContext;
  expect((await companies(scoped)).companies).toEqual([{name:'Acme Sdn Bhd'}]);
  // Never to someone who is not an administrator.
  const {employee}=await people();expect(await runContextTool(employee,'company_setup',{},scope())).toEqual({ok:false,refusal:'not_offered'});
 });
 it('answers "我们集团有哪些公司？" from company_setup on the ordinary path, linking the companies page, not the org chart',async()=>{
  vi.stubEnv('AI_CONFIG_SECRET','fictional-context-companies-passphrase');
  const {hr}=await people();
  await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional Sister Sdn Bhd'});
  const reply='集团有两家公司：\n- Acme Sdn Bhd\n- Fictional Sister Sdn Bhd\n\n可在[组织](/admin/organization)查看。';
  const model=scriptedModel([{calls:[{name:'company_setup'}]},{final:{reply,mode:'answer'}}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:hr,conversationId:randomUUID(),question:'我们集团有哪些公司？',scope:{companyId:base.companyId,locale:'zh'},model,memory:new InMemoryTaskMemoryStore()});
  // The Chinese question takes the ordinary path: open gate, company_setup offered, no capability catalogue (not a "can you" ask).
  expect(result.trace.gate.reason).toBeNull();
  const offered=model.requests[0].tools.map(tool=>tool.name);
  expect(offered).toContain('company_setup');expect(offered).not.toContain('product_capabilities');
  expect(result.trace.calls.map(call=>[call.tool,call.status])).toEqual([['company_setup','ok']]);
  const tool=[...model.requests[1].messages].reverse().find(message=>message.role==='tool')!.content as string;
  for(const name of ['Acme Sdn Bhd','Fictional Sister Sdn Bhd','/admin/organization'])expect(tool,name).toContain(name);
  // The companies page passes the reply's link check: the reply is shown as written, no fallback and no retry.
  expect(result.reply).toBe(reply);expect(model.requests).toHaveLength(2);
 },60000);
 it('finds authored guide sections within the caller\'s audience clearance',async()=>{
  const {employee,hr}=await people(),adminOnly=new Set(loadGuides().filter(guide=>guide.meta.audience==='hr_admin').map(guide=>guide.meta.title));
  const forAdmin=await runContextTool(hr,'product_guidance',{query:'payroll setup statutory'},scope());
  expect(forAdmin.ok).toBe(true);if(!forAdmin.ok)return;
  const adminRows=forAdmin.content as {title:string;href:string;excerpt:string}[];
  expect(adminRows.length).toBeGreaterThan(0);for(const row of adminRows){expect(row.href).toMatch(/^\/knowledge-base\//);expect(row.excerpt.length).toBeGreaterThan(20);}
  const forEmployee=await runContextTool(employee,'product_guidance',{query:'payroll setup statutory payslip'},scope());
  expect(forEmployee.ok).toBe(true);if(!forEmployee.ok)return;
  for(const row of forEmployee.content as {title:string}[])expect(adminOnly.has(row.title),row.title).toBe(false);
  expect(await runContextTool(hr,'product_guidance',{query:''},scope())).toEqual({ok:false,refusal:'invalid_input'});
 });
 it('lists only destinations the role may be shown',async()=>{
  const {employee,hr}=await people();
  const forEmployee=await runContextTool(employee,'product_destinations',{},scope()),forAdmin=await runContextTool(hr,'product_destinations',{},scope());
  if(!forEmployee.ok||!forAdmin.ok)throw Error('destinations unavailable');
  const employeeHrefs=(forEmployee.content as {href:string}[]).map(row=>row.href),adminHrefs=(forAdmin.content as {href:string}[]).map(row=>row.href);
  expect(employeeHrefs).toContain('/me/payslip');expect(employeeHrefs).not.toContain('/admin/organization');
  expect(adminHrefs).toContain('/admin/organization');expect(adminHrefs.length).toBeGreaterThan(employeeHrefs.length);
 });
 it('classifies every existing Assistant read and proposable action exactly once',()=>{
  const registry=capabilityRegistry(),names=registry.map(row=>row.name);
  expect(new Set(names).size).toBe(names.length);
  for(const tool of ASSISTANT_TOOLS)expect(registry.find(row=>row.name===tool.spec.name)?.effect).toBe('read');
  for(const action of ASSISTANT_PROPOSABLE_ACTIONS){const row=registry.find(item=>item.name===action);expect(row?.effect).toBe('prepare_review');expect(row?.reviewRoute).toMatch(/^\/assistant\//);}
  expect(registry.filter(row=>row.effect==='context').map(row=>row.name)).toEqual(['product_destinations','product_guidance','setup_readiness','company_setup','available_actions','approval_queue']);
  expect(registry.filter(row=>row.effect==='prepare_review').map(row=>row.name)).toEqual(SUGGESTABLE_ACTIONS.map(action=>action.id));
 });
 it('names missing required details before any proposal can be shown',()=>{
  expect(checkProposal('attendance.overtime.request',{})).toEqual({valid:false,missing:['date','plannedStartTime','plannedEndTime']});
  expect(checkProposal('attendance.overtime.request',{date:'2026-12-01'})).toEqual({valid:false,missing:['plannedStartTime','plannedEndTime']});
  expect(checkProposal('attendance.overtime.request',{date:'2026-12-01',plannedStartTime:'18:00',plannedEndTime:'20:00'})).toEqual({valid:true,action:'attendance.overtime.request'});
  expect(checkProposal('approvals.claim.decide',{})).toEqual({valid:true,action:'approvals.claim.decide'});
  expect(checkProposal('employment.terminate',{})).toEqual({valid:false,missing:[]});
 });
 it('makes every human-confirmed parity action suggestable, never an automatic reminder',()=>{
  expect(SUGGESTABLE_ACTIONS.length).toBeGreaterThanOrEqual(60);
  expect(SUGGESTABLE_ACTIONS.some(action=>action.policy.tier==='automatic'||action.permission.actor==='agent_principal')).toBe(false);
  expect(AGENT_ACTIONS.filter(action=>action.policy.tier==='automatic').every(action=>!SUGGESTABLE_ACTIONS.includes(action))).toBe(true);
  expect(Object.keys(ACTION_PURPOSE).sort()).toEqual(SUGGESTABLE_ACTIONS.map(action=>action.id).sort());
  for(const action of SUGGESTABLE_ACTIONS)expect(action.review.route.startsWith('/'),action.id).toBe(true);
 });
 it('offers each person only the parity actions their role and modules allow',async()=>{
  const {employee,hr}=await people(),actorOf=new Map<string,string>(SUGGESTABLE_ACTIONS.map(action=>[action.id,action.permission.actor]));
  const forEmployee=await actionCatalogueFor(employee),forAdmin=await actionCatalogueFor(hr);
  const employeeIds=forEmployee.map(row=>row.id),adminIds=forAdmin.map(row=>row.id);
  expect(employeeIds).toContain('leave.apply');
  expect(employeeIds.filter(id=>['hr_admin','payroll_admin','tenant_admin','rewards_admin'].includes(actorOf.get(id)!))).toEqual([]);
  expect(adminIds).toEqual(expect.arrayContaining(['org.position.archive','employees.bank.maintain']));
  expect(adminIds.length).toBeGreaterThan(employeeIds.length);
  for(const row of [...forEmployee,...forAdmin])expect(['lifecycle_staff','workforce_maintainer','agent_principal']).not.toContain(actorOf.get(row.id));
  expect(suggestAction(forEmployee,'org.position.archive')).toEqual({suggested:false,reason:'not_available'});
  expect(suggestAction(forAdmin,'org.position.archive')).toEqual({suggested:true,action:'org.position.archive',reviewRoute:'/assistant/org-positions',inlineCard:false});
  expect(suggestAction(forEmployee,'attendance.overtime.request',{date:'2026-12-01'})).toEqual({suggested:false,reason:'missing_details',missing:['plannedStartTime','plannedEndTime']});
  const listed=await runContextTool(hr,'available_actions',{},scope());expect(listed.ok).toBe(true);
  if(listed.ok)expect((listed.content as {id:string}[]).map(row=>row.id)).toEqual(adminIds);
 });
});

