/** ADR-0169 phase B: the Assistant context and capability layer over real owners on fictional data. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {seedGuides} from '../db/seed-guides';
import {loadGuides} from '../lib/guide-catalog';
import {ASSISTANT_TOOLS} from '../core/assistant-tools';
import {ASSISTANT_PROPOSABLE_ACTIONS} from '../lib/ai/assistant-action-proposal-hints';
import {capabilityRegistry,checkProposal,contextToolSpecsFor,runContextTool,suggestAction} from '../core/product-context/tools';
import {ACTION_PURPOSE,SUGGESTABLE_ACTIONS,actionCatalogueFor} from '../core/product-context/actions';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
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
  expect(contextToolSpecsFor(employee).map(spec=>spec.name)).toEqual(['product_destinations','product_guidance','available_actions']);
  expect(contextToolSpecsFor(hr).map(spec=>spec.name)).toEqual(['product_destinations','product_guidance','available_actions','setup_readiness']);
  expect(await runContextTool(employee,'setup_readiness',{},scope())).toEqual({ok:false,refusal:'not_offered'});
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
  expect(registry.filter(row=>row.effect==='context').map(row=>row.name)).toEqual(['product_destinations','product_guidance','setup_readiness','available_actions']);
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
  const {employee,hr}=await people(),actorOf=new Map(SUGGESTABLE_ACTIONS.map(action=>[action.id,action.permission.actor]));
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

