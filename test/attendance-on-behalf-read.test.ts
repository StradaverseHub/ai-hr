/** 96a54ed2 (owner decision, 12 November 2026) — the attendance_on_behalf_subjects and attendance_on_behalf_approvers reads
 * (core/semantic-model/entities-attendance-on-behalf.ts, core/explainers/attendance-on-behalf.ts), served as operations_status
 * topics, over the real capabilities, tool provider and AI Centre controls on fictional data.
 *
 *  - a caller without the on-behalf permission key is refused not_permitted before anything is read;
 *  - out-of-scope people never appear: another company's employees for HR scoped to one company, and a superior's own
 *    manager, peers and other teams;
 *  - for an in-scope caller the read returns the same people, in the same order, as the page's own owner lists them, with
 *    only the declared fields (no employment id, no employee code);
 *  - through operations_status a person's name leaves as a placeholder and no id or code leaves at all;
 *  - the AI Centre control read:attendance_on_behalf_subjects (migration 5145) switches the read off on its own;
 *  - nothing here can file or decide on behalf: no semantic or agent action is declared for it. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {searchAttendanceOnBehalfSubjects,type AttendanceOnBehalfPurpose} from '../core/attendance-on-behalf';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {nativeToolProvider} from '../core/harness/tools';
import {DisclosureLedger,discloseToolOutput} from '../core/harness/disclosure';
import {setAiCentreReadControl} from '../core/ai-centre-inventory';
import {ATTENDANCE_ON_BEHALF_ENTITIES,ATTENDANCE_ON_BEHALF_READS} from '../core/semantic-model/entities-attendance-on-behalf';
import {SEMANTIC_ACTIONS} from '../core/semantic-model/entities';
import {TOIL_ACTIONS} from '../core/semantic-model/entities-toil';
import {DECISION_ACTIONS} from '../core/semantic-model/entities-decisions';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import {AGENT_CAPABILITY_INVENTORY} from '../lib/ai/agent-capability-inventory';
import type {SemanticField} from '../core/semantic-model/types';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const READS={request:'attendance_on_behalf_subjects',approve:'attendance_on_behalf_approvers'} as const;
const walk=(fields:readonly SemanticField[]):SemanticField[]=>fields.flatMap(field=>[field,...(field.of?walk(field.of):[])]);

describe('the declaration',()=>{
 it('is two read-only attendance reads with no handle input, names as placeholders and no id or code',()=>{
  expect(ATTENDANCE_ON_BEHALF_READS.map(read=>[read.name,read.entity,read.input.length])).toEqual([
   ['attendance_on_behalf_subjects','attendance_on_behalf_subject',0],['attendance_on_behalf_approvers','attendance_on_behalf_approver',0]]);
  for(const entity of ATTENDANCE_ON_BEHALF_ENTITIES){
   expect(entity).toMatchObject({module:'attendance',audience:'admin',rls:'visible_employments'});
   const fields=walk(entity.fields);
   expect(fields.filter(field=>['id','code','text'].includes(field.type))).toEqual([]);
   expect(fields.find(field=>field.name==='name')).toMatchObject({type:'name',disclosure:'minimum'});
   for(const name of ['company','department','position'])expect(fields.find(field=>field.name===name)).toMatchObject({type:'label',disclosure:'minimum'});
  }
  for(const read of Object.values(READS)){
   expect(TERAS_CAPABILITIES.find(row=>row.name===read)).toMatchObject({module:'attendance',admin:false,access:'team',worker:null});
   expect(KIT_CAPABILITIES.find(row=>row.read.name===read)?.binding).toMatchObject({module:'attendance',admin:false,access:'team'});
  }
 });
 it('registers no way to file or decide on behalf: no semantic or agent action, and the server actions stay classified as before',()=>{
  const semantic=[...new Set([...SEMANTIC_ACTIONS,...TOIL_ACTIONS,...DECISION_ACTIONS])];
  const ids=semantic.map(action=>action.id).concat(AGENT_ACTIONS.map(action=>action.id));
  expect(ids.filter(id=>/behalf/i.test(id))).toEqual([]);
  // The registered own-request and assigned-decision actions act only as the person themselves or as the assigned approver.
  const attendance=semantic.filter(row=>row.id==='attendance.correction.request'||row.id==='approvals.attendance.decide');
  expect(attendance.map(row=>row.id).sort()).toEqual(['approvals.attendance.decide','attendance.correction.request']);
  for(const action of attendance)expect(['self','assigned_approver']).toContain(action.actor);
  expect(JSON.stringify(AGENT_ACTIONS)).not.toMatch(/OnBehalf|on_behalf/);
  expect(AGENT_CAPABILITY_INVENTORY['app/attendance/actions.ts']).toEqual({decideCorrectionAction:'registered:approvals.attendance.decide'});
  // The kit's generated turns for these reads are answers and refusals; none proposes an action.
  for(const read of Object.values(READS))for(const turn of KIT_CAPABILITIES.find(row=>row.read.name===read)!.corpus)expect(turn.ideal.mode).not.toBe('propose');
 });
});

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-on-behalf-read-passphrase');await resetDb();base=await seedBase();
 for(const code of ['assistant','attendance'])await setModule(base.tenantId,code,'active');});

type Role='employee'|'manager'|'hr_admin';
type Actor=Readonly<{employmentId:string;personId:string;ctx:SessionContext}>;
async function company(name:string){
 const [row]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:name}).returning();
 const [department]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:row.id,name:`${name} department`}).returning();
 return {id:row.id,departmentId:department.id};
}
async function actor(name:string,options:{role?:Role;companyId?:string;departmentId?:string;roleCompanyId?:string|null}={}):Promise<Actor>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:options.companyId??base.companyId,departmentId:options.departmentId??base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const role=options.role??'employee',companyId=options.roleCompanyId===undefined?null:options.roleCompanyId;
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'user_'+randomUUID(),personId:hired.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role});
 await grantAssistant(adminCtx(base),{appUserId:user.id});
 const ctx={...await entitledCtx(base,[role]),userId:user.id,personId:hired.personId,roles:[role],grants:[{role,companyId}]} as SessionContext;
 return{employmentId:hired.employmentId,personId:hired.personId,ctx};
}
const reports=(subordinate:Actor,manager:Actor)=>setReportingLine(adminCtx(base),{subordinateEmploymentId:subordinate.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
const capability=(purpose:AttendanceOnBehalfPurpose)=>TERAS_CAPABILITIES.find(row=>row.name===READS[purpose])!;
const read=async(ctx:SessionContext,purpose:AttendanceOnBehalfPurpose)=>capability(purpose).run(ctx,{},{companyId:base.companyId});
/** What the page lists, from its own owner, projected to the read's declared fields. */
const page=async(ctx:SessionContext,purpose:AttendanceOnBehalfPurpose)=>{
 const found=await searchAttendanceOnBehalfSubjects(ctx,{purpose,query:'',page:0});
 return{people:found.rows.map(row=>({name:row.name,company:row.company,department:row.department,position:row.position})),more:found.more,ids:found.rows.map(row=>row.employmentId)};
};
const names=(outcome:unknown)=>((outcome as {people?:{name:string}[]}).people??[]).map(row=>row.name);

describe('who is refused',()=>{
 it('refuses a caller without the permission key before reading anything, for both reads',async()=>{
  const employee=await actor('Fictional On-Behalf Employee');
  await actor('Fictional Colleague Visible To HR');
  for(const purpose of ['request','approve'] as const){
   const refused=await read(employee.ctx,purpose);
   expect(refused).toMatchObject({ok:false,refusal:'not_permitted'});
   expect(JSON.stringify(refused)).not.toContain('Fictional Colleague');
  }
  // An HR administrator whose request key is switched off is refused that read and still answered the other.
  const hr=await actor('Fictional HR Without Request Key',{role:'hr_admin',roleCompanyId:base.companyId});
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,permissionKey:'attendance.request_on_behalf',role:'hr_admin',allowed:false,companyId:null});
  expect(await read(hr.ctx,'request')).toMatchObject({ok:false,refusal:'not_permitted'});
  expect(await read(hr.ctx,'approve')).toMatchObject({ok:true});
 },60000);

 it('never lists another company\'s employees to HR scoped to one company',async()=>{
  const other=await company('Fictional Other Company');
  const hr=await actor('Fictional Company HR',{role:'hr_admin',roleCompanyId:base.companyId});
  const mine=await actor('Fictional In-Company Employee');
  const outside=await actor('Fictional Other-Company Employee',{companyId:other.id,departmentId:other.departmentId});
  for(const purpose of ['request','approve'] as const){
   const outcome=await read(hr.ctx,purpose);
   expect(outcome.ok,purpose).toBe(true);
   expect(names(outcome)).toContain('Fictional In-Company Employee');
   expect(names(outcome)).not.toContain('Fictional Other-Company Employee');
   expect(names(outcome)).not.toContain('Fictional Company HR');
   expect((await page(hr.ctx,purpose)).ids).not.toContain(outside.employmentId);
   expect((await page(hr.ctx,purpose)).ids).toContain(mine.employmentId);
  }
 },60000);

 it('lists only people beneath a superior: never their own manager, a peer or another team',async()=>{
  const top=await actor('Fictional Top Manager',{role:'manager'}),mid=await actor('Fictional Middle Manager',{role:'manager'}),peer=await actor('Fictional Peer Manager',{role:'manager'});
  const report=await actor('Fictional Direct Report'),indirect=await actor('Fictional Indirect Report'),otherTeam=await actor('Fictional Other Team Member');
  await reports(mid,top);await reports(peer,top);await reports(report,mid);await reports(indirect,report);await reports(otherTeam,peer);
  for(const purpose of ['request','approve'] as const){
   const outcome=await read(mid.ctx,purpose);
   expect(outcome.ok,purpose).toBe(true);
   expect([...names(outcome)].sort()).toEqual(['Fictional Direct Report','Fictional Indirect Report']);
  }
  void otherTeam;
 },60000);
});

describe('what operations_status offers',()=>{
 const offered=async(ctx:SessionContext)=>(await nativeToolProvider(ctx,{companyId:base.companyId,locale:'en'},true)).bindings.find(row=>row.name==='operations_status');
 const topicsOf=(spec:{description:string;inputSchema:unknown})=>({
  listed:[...spec.description.matchAll(/\[([a-z_]+)\]/g)].map(match=>match[1]),
  callable:(spec.inputSchema as {properties:{topic:{enum:string[]}}}).properties.topic.enum});
 it('offers an employee nothing, and a manager only the on-behalf topics whose keys they hold',async()=>{
  const employee=await actor('Fictional Offer Employee'),manager=await actor('Fictional Offer Manager',{role:'manager'});
  expect(await offered(employee.ctx)).toBeUndefined();
  const both=await offered(manager.ctx);
  expect(topicsOf(both!.spec)).toEqual({listed:['attendance_on_behalf_subjects','attendance_on_behalf_approvers'],callable:['attendance_on_behalf_subjects','attendance_on_behalf_approvers']});
  expect(both!.spec.description).not.toMatch(/Administrators only|AI Centre|shared leave|payroll/i);
  // Every administrators' topic stays refused, before any runner, even when named directly.
  for(const topic of ['loops','payroll_cycle','salary_payroll','payroll_loop_settings','payroll_audit','ai_quality','payroll_learning','shared_leave_groups'])
   expect(await both!.run({topic}),topic).toMatchObject({ok:false,refusal:'not_permitted'});
  // Without the approve key, only the request topic; without either key, no tool at all.
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,permissionKey:'attendance.approve_on_behalf',role:'manager',allowed:false,companyId:null});
  expect(topicsOf((await offered(manager.ctx))!.spec)).toEqual({listed:['attendance_on_behalf_subjects'],callable:['attendance_on_behalf_subjects']});
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,permissionKey:'attendance.request_on_behalf',role:'manager',allowed:false,companyId:null});
  expect(await offered(manager.ctx)).toBeUndefined();
 },60000);
 it('offers an administrator holding every topic the full, unchanged declaration',async()=>{
  const hr=await actor('Fictional Offer Group HR',{role:'hr_admin',roleCompanyId:null});
  for(const code of ['payroll'])await setModule(base.tenantId,code,'active');
  const ctx={...hr.ctx,entitlements:(await entitledCtx(base,['hr_admin'])).entitlements} as SessionContext;
  const spec=(await offered(ctx))!.spec;
  expect(topicsOf(spec).callable).toEqual(expect.arrayContaining(['loops','shared_leave_groups','attendance_on_behalf_subjects','attendance_on_behalf_approvers']));
 },60000);
});

describe('an in-scope caller',()=>{
 it('gets the same people, in the same order, as the page lists them, with only the declared fields',async()=>{
  const other=await company('Fictional Second Company');
  const hr=await actor('Fictional Group HR',{role:'hr_admin',roleCompanyId:null});
  for(const name of ['Fictional Zed Employee','Fictional Amir Employee','Fictional Mei Employee'])await actor(name);
  await actor('Fictional Second-Company Employee',{companyId:other.id,departmentId:other.departmentId});
  for(const purpose of ['request','approve'] as const){
   const outcome=await read(hr.ctx,purpose),expected=await page(hr.ctx,purpose);
   expect(outcome.ok).toBe(true);
   expect(expected.people.length).toBeGreaterThanOrEqual(4);
   expect((outcome as unknown as {people:unknown[]}).people).toEqual(expected.people);
   expect((outcome as unknown as {more:boolean}).more).toBe(expected.more);
   expect(Object.keys(outcome).sort()).toEqual(['more','ok','people','provenance']);
   expect((outcome as unknown as {provenance:{page:string}}).provenance.page).toBe(purpose==='request'?'/attendance/on-behalf/request':'/attendance/on-behalf/approve');
   const text=JSON.stringify(outcome);
   for(const id of expected.ids)expect(text).not.toContain(id);
   const codes=(await owner.db.select({code:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.tenantId,base.tenantId))).flatMap(row=>row.code?[row.code]:[]);
   for(const code of codes)expect(text).not.toContain(`"${code}"`);
  }
 },60000);

 it('through operations_status: names leave as placeholders, no id or code leaves, and the AI Centre control switches it off',async()=>{
  const hr=await actor('Fictional Asking Group HR',{role:'hr_admin',roleCompanyId:null});
  const subject=await actor('Fictional Placeholder Employee');
  const operations=(await nativeToolProvider(hr.ctx,{companyId:base.companyId,locale:'en'},true)).bindings.find(row=>row.name==='operations_status');
  expect(operations).toBeDefined();
  const run=await operations!.run({topic:'attendance_on_behalf_subjects'});
  expect(run.ok).toBe(true);
  expect(operations!.entityOf!({topic:'attendance_on_behalf_subjects'})).toBe('attendance_on_behalf_subject');
  const ledger=new DisclosureLedger('fictional-on-behalf-read');
  const disclosed=JSON.stringify(discloseToolOutput('operations_status','attendance_on_behalf_subject',run.content,ledger).value);
  expect(disclosed).not.toContain('Fictional Placeholder Employee');
  expect(disclosed).not.toContain(subject.employmentId);
  await setAiCentreReadControl(hr.ctx,'read:attendance_on_behalf_subjects',false);
  const off=await operations!.run({topic:'attendance_on_behalf_subjects'}).then(result=>result,()=>({ok:false}));
  expect(off.ok).toBe(false);
  expect(await operations!.run({topic:'attendance_on_behalf_approvers'})).toMatchObject({ok:true});
  await setAiCentreReadControl(hr.ctx,'read:attendance_on_behalf_subjects',true);
  expect(await operations!.run({topic:'attendance_on_behalf_subjects'})).toMatchObject({ok:true,content:{ok:true}});
 },60000);
});
