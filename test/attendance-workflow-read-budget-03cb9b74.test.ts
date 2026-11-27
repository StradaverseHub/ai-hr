/** Board 03cb9b74 — Attendance > Settings > Approval Workflow at group scale (ADR 0181 read budgets; FUTURE-BUILD-CONTRACT
 * "Database read cost" rules 6 and 7; docs/SCALE-AND-RELEASE-RULES.md rules 2 and 3).
 *
 * On staging the listing took 15–22 s and Create/Edit 14–29 s because every workflow page ran the Application History
 * filter reader, which listed every eligible approver of every company in scope (a SECURITY DEFINER eligibility check
 * per employment and company) and every employment in scope. The pages now read only what they show. This file proves
 * it on the fictional 71-company group fixture (test/helpers/ai-centre-scale-fixture.ts) built with 3,000 employments,
 * the size of the staging group that reported it (2,959), for the group administrator at "All companies" and at one
 * company (company switcher), an administrator granted all 71 companies one by one, and a one-company administrator:
 *  - the listing page reads the workflows of the tab's type and the company names, and never approver options,
 *    approver availability, approver eligibility or employees (its statements are pinned);
 *  - Create, Copy, Edit and View read the option lists plus the labels of the people the workflow already names;
 *  - budgets (transactions, statements) per page and per search action; database time (EXPLAIN ANALYZE of the captured
 *    statements) under 500 ms for the listing and 1 s for Edit; "All companies" costs no more statements than one;
 *  - equivalence with the previous reader for every persona: the same companies and criteria option lists, the same
 *    selected labels, and the criteria search's first page equal to the first 50 of the previous full list;
 *  - searchAttendanceApprovers with an empty query at this scale is measured (printed as WORKFLOW_BUDGET lines with
 *    its EXPLAIN), as the plan's BUILD NOTES require, beside the old pre-list it replaced;
 *  - the criteria search: keyset pages, escaping of % and _, bounds, company scope and tenant isolation;
 *  - a stored workflow re-saved unchanged keeps its stored definition byte for byte (the form half of that proof is
 *    test/attendance-workflow-editor.dom.test.tsx: the redesigned form posts the stored configuration unchanged).
 * Every measurement is printed as one `WORKFLOW_BUDGET {json}` line. All names are invented. */
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,cookies:{} as Record<string,string>}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers({'x-pathname':'/admin/attendance/approval-workflow'}),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next-intl/server',()=>{
 const translator=(namespace?:string)=>{
  const t=(key:string,values?:Record<string,unknown>)=>`${namespace?namespace+'.':''}${key}${values?JSON.stringify(values):''}`;
  return Object.assign(t,{rich:t,markup:t,raw:(key:string)=>key,has:()=>true});
 };
 return {getLocale:async()=>'en',getTranslations:async(arg?:string|{namespace?:string})=>translator(typeof arg==='string'?arg:arg?.namespace),
  getFormatter:async()=>({dateTime:(value:Date)=>new Date(value).toISOString(),number:(value:number)=>String(value),list:(values:string[])=>values.join(', ')})};
});
vi.mock('next/cache',async importOriginal=>({...await importOriginal<typeof import('next/cache')>(),revalidatePath:vi.fn(),revalidateTag:vi.fn()}));
vi.mock('next/navigation',async importOriginal=>({...await importOriginal<typeof import('next/navigation')>(),
 redirect:vi.fn((url:string)=>{throw Object.assign(new Error(`NEXT_REDIRECT ${url}`),{digest:`NEXT_REDIRECT;replace;${url}`});}),
 notFound:vi.fn(()=>{throw Object.assign(new Error('NEXT_NOT_FOUND'),{digest:'NEXT_HTTP_ERROR_FALLBACK;404'});})}));
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import AttendanceWorkflowPage from '../app/admin/attendance/approval-workflow/page';
import NewAttendanceWorkflowPage from '../app/admin/attendance/approval-workflow/new/page';
import EditAttendanceWorkflowPage from '../app/admin/attendance/approval-workflow/[lineageId]/edit/page';
import ViewAttendanceWorkflowPage from '../app/admin/attendance/approval-workflow/[lineageId]/page';
import {searchAttendanceApproversAction,searchAttendanceWorkflowEmployeesAction} from '../app/admin/attendance/approval-workflow/actions';
import {hireEmployee} from '../core/org';
import {attendanceWorkflowFormOptions,getAttendanceWorkflow,saveAttendanceWorkflow,searchAttendanceApprovers,searchAttendanceWorkflowEmployees} from '../core/attendance-workflow';
import {attendanceApplicationFilterOptions} from '../core/attendance-application-history';
import {attendanceWorkflowConfiguration} from '../lib/attendance-workflow-config';
import type {AttendanceV4WorkflowInput} from '../lib/attendance-workflow-v4';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {explainStatements,observeStatements,type Captured} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

type Key='listPage'|'newPage'|'editPage'|'viewPage'|'searchAttendanceApproversAction'|'searchAttendanceWorkflowEmployeesAction';
/** Recorded budgets: the largest (transactions, statements) measured over every persona and scope below. Budgets only
 * go down; raising one needs an ADR note (ADR 0181). */
const BUDGETS:Record<Key,{transactions:number;statements:number}>={
 // Measured on the CI runner (alpha-focused-checks run 46030110304), the same for every persona and scope:
 // listing 4 transactions and 8 statements (15-43 ms); Edit 3 and 13-15 (24-76 ms); the searches 2 and 5, and 2 and 4.
 listPage:{transactions:4,statements:8},
 newPage:{transactions:4,statements:22},
 editPage:{transactions:3,statements:15},
 viewPage:{transactions:4,statements:26},
 searchAttendanceApproversAction:{transactions:2,statements:5},
 searchAttendanceWorkflowEmployeesAction:{transactions:2,statements:4},
};
/** Database time targets from the plan (board 03cb9b74 BUILD NOTES): EXPLAIN ANALYZE of every captured read. */
const DB_MS={listPage:500,editPage:1000} as const;
/** What the workflow pages must never run again: the all-company approver pre-list and its eligibility/availability. */
const SLOW_READS=/attendance_workflow_v3_approver_options|attendance_workflow_approver_availability|attendance_selected_approver_eligible/i;
type Persona='group'|'multi'|'single';
type Scope='all'|'one';
let b:Base,fixture:ScaleFixture,companyId:string;
const approvers:string[]=[];let criteriaEmployees:string[]=[];
let shared:string,single:string,overtime:string;
const measured:Record<string,unknown>={};

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:3000,events:200});
 companyId=fixture.singleCompanyId;
 const root=adminCtx(b);
 // Three named approvers with logins in the group company, as Personnel hires them.
 for(const name of ['Fictional Approver Aisyah','Fictional Approver Boon','Fictional CC Chandra']){
  const hired=await hireEmployee(root,{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  await createAppUser(b.tenantId,hired.personId,'employee');approvers.push(hired.employmentId);
 }
 criteriaEmployees=fixture.activeEmploymentIds.slice(0,3) as string[];
 const base={applicationType:'irregularity' as const,routingVersion:4 as const,description:'Fictional',active:true};
 const sharedInput:AttendanceV4WorkflowInput={...base,companyId:b.companyId,code:'GROUP_OPS',name:'Fictional group operations',priority:10,
  criteria:{groups:[{employeeIds:criteriaEmployees},{employmentTypes:['contract']}]} as AttendanceV4WorkflowInput['criteria'],
  stages:[{name:'Level 1',mode:'any_one',sources:[{kind:'direct_manager',depth:1},{kind:'specific_employee',employmentIds:[approvers[0],approvers[1]]}],hrAlternative:false,escalateAfterDays:3},
   {name:'Level 2',mode:'sequential',sources:[{kind:'direct_manager',depth:2}],hrAlternative:false}],
  cc:[{kind:'specific_employee',employmentIds:[approvers[2]]},{kind:'custom_email',addresses:['fictional-ops@example.com']}]};
 shared=(await saveAttendanceWorkflow(root,{...sharedInput,companyIds:fixture.companyIds.slice(0,6)})).lineageId;
 single=(await saveAttendanceWorkflow(root,{...base,companyId,code:'ONE_CO',name:'Fictional one company',priority:20,criteria:{},
  stages:[{name:'Level 1',mode:'any_one',sources:[{kind:'direct_manager',depth:1}],hrAlternative:true}],cc:[]})).lineageId;
 overtime=(await saveAttendanceWorkflow(root,{...base,applicationType:'self_overtime',companyId:b.companyId,companyIds:[b.companyId,companyId].sort(),code:'OT_TWO',name:'Fictional overtime',priority:5,criteria:{},
  stages:[{name:'Level 1',mode:'sequential',sources:[{kind:'direct_manager',depth:1}],hrAlternative:false}],cc:[]})).lineageId;
 await owner.db.execute(sql`analyze public.employment, public.person, public.company, public.attendance_workflow_template, public.app_user, public.role_assignment`);
},600_000);
afterAll(async()=>{console.log('WORKFLOW_BUDGET_SUMMARY '+JSON.stringify(measured));await closeAll();});

const personaCtx=(persona:Persona):SessionContext=>({...fixture.personas[persona]});
async function measure<T>(key:Key,label:string,persona:Persona,scope:Scope,work:()=>Promise<T>){
 state.session=personaCtx(persona);
 state.cookies=scope==='one'?{company_scope:companyId}:{};
 const observed=await observeStatements(work);
 const row={key,label,persona,scope,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
 console.log('WORKFLOW_BUDGET '+JSON.stringify(row));
 measured[`${key}|${label}|${persona}|${scope}`]=row;
 expect(row.transactions,`${key} ${label} ${persona} ${scope} transactions`).toBeGreaterThan(0);
 expect(row.transactions,`${key} ${label} ${persona} ${scope} transactions`).toBeLessThanOrEqual(BUDGETS[key].transactions);
 expect(row.statements,`${key} ${label} ${persona} ${scope} statements`).toBeLessThanOrEqual(BUDGETS[key].statements);
 return {...observed,row};
}
const noWider=(wide:{row:{statements:number;transactions:number}},narrow:{row:{statements:number;transactions:number}})=>{
 expect(wide.row.statements,'statements').toBeLessThanOrEqual(narrow.row.statements);
 expect(wide.row.transactions,'transactions').toBeLessThanOrEqual(narrow.row.transactions);
};
/** EXPLAIN ANALYZE of the captured reads; prints each and returns the summed execution time. */
async function databaseMs(label:string,statements:readonly Captured[]){
 const explained=await explainStatements(statements);
 let total=0;
 for(const e of explained){
  if(e.executionMs!==null)total+=e.executionMs+(e.planningMs??0);
  if(e.executionMs!==null&&e.executionMs>5)console.log('WORKFLOW_EXPLAIN '+JSON.stringify({label,sql:e.sql.slice(0,160),executionMs:e.executionMs,planningMs:e.planningMs,hotspots:e.hotspots.slice(0,3)}));
 }
 const rounded=Math.round(total*100)/100;
 console.log('WORKFLOW_BUDGET '+JSON.stringify({label,databaseMs:rounded}));
 measured[`db|${label}`]=rounded;
 return rounded;
}
/** Client islands of a rendered page, recorded with their props, by component name. */
function leaves(tree:unknown,type:string):Record<string,unknown>[]{
 const out:Record<string,unknown>[]=[];
 const walk=(node:unknown)=>{
  if(node===null||typeof node!=='object')return;
  if(Array.isArray(node)){node.forEach(walk);return;}
  const n=node as Record<string,unknown>;
  if(n.type===type&&n.props){out.push(n.props as Record<string,unknown>);return;}
  Object.values(n).forEach(walk);
 };
 walk(tree);return out;
}
const sorted=(ids:readonly string[])=>[...ids].sort();
const ids=(rows:readonly {id:string}[]|undefined)=>(rows??[]).map(row=>row.id);
/** The workflows a persona manages, independently: current versions of the type whose every company it administers. */
async function expectedListing(persona:Persona,applicationType:'irregularity'|'self_overtime'){
 const ctx=personaCtx(persona);
 const rows=await withTenant(ctx,tx=>tx.execute<{lineageId:string}>(sql`select t.lineage_id as "lineageId" from attendance_workflow_template t
  where t.superseded_at is null and t.application_type=${applicationType}
   and not exists(select 1 from unnest(app.attendance_workflow_companies(t.id)) c(id) where not app.is_admin_for(c.id))
  order by t.priority,t.code`));
 return Array.from(rows).map(row=>row.lineageId);
}

describe('03cb9b74: the Approval Workflow listing at group scale',()=>{
 it('reads only the workflows of the tab and the company names, within budget, for every persona and scope',async()=>{
  const render=(persona:Persona,scope:Scope,sp:Record<string,string>={})=>measure('listPage',sp.applicationType??'irregularity',persona,scope,
   ()=>serverTreeSnapshot(createElement(AttendanceWorkflowPage,{searchParams:Promise.resolve(sp)})));
  state.session=personaCtx('group');state.cookies={};await serverTreeSnapshot(createElement(AttendanceWorkflowPage,{searchParams:Promise.resolve({})}));
  const groupAll=await render('group','all'),groupOne=await render('group','one'),multiAll=await render('multi','all'),singleAll=await render('single','all');
  const overtimeTab=await render('group','all',{applicationType:'self_overtime'});
  noWider(groupAll,groupOne);noWider(multiAll,singleAll);
  for(const observed of [groupAll,groupOne,multiAll,singleAll,overtimeTab]){
   const texts=observed.statements.map(s=>s.sql);
   expect(texts.filter(text=>SLOW_READS.test(text)),'no approver options, availability or eligibility').toEqual([]);
   expect(texts.filter(text=>/full_name/i.test(text)),'no employee or approver names').toEqual([]);
  }
  // The rendered rows are the persona's workflows of the tab, in priority order, the same as an independent query.
  const rendered=(observed:{result:unknown})=>leaves(observed.result,'WorkflowRetirementControls').map(props=>props.lineageId);
  expect(await expectedListing('group','irregularity')).toEqual([shared,single]);
  expect(rendered(groupAll)).toEqual([shared,single]);
  expect(rendered(multiAll)).toEqual(await expectedListing('multi','irregularity'));
  expect(rendered(singleAll)).toEqual([single]);
  // The company switcher on one company: only the workflows that cover it (the shared one covers six other companies).
  expect(rendered(groupOne)).toEqual([single]);
  expect(rendered(overtimeTab)).toEqual([overtime]);
  const ms=await databaseMs('listPage group all',groupAll.statements);
  expect(ms,'listing database time (ms)').toBeLessThan(DB_MS.listPage);
  await databaseMs('listPage multi all',multiAll.statements);
 },300_000);
});

describe('03cb9b74: Create, Copy, Edit and View Workflow at group scale',()=>{
 it('read option lists and the chosen labels only, within budget, and the same lists as the previous reader',async()=>{
  const edit=(persona:Persona,scope:Scope,lineageId:string)=>measure('editPage',lineageId===shared?'shared':'single',persona,scope,
   ()=>serverTreeSnapshot(createElement(EditAttendanceWorkflowPage,{params:Promise.resolve({lineageId})})));
  state.session=personaCtx('group');state.cookies={};await serverTreeSnapshot(createElement(EditAttendanceWorkflowPage,{params:Promise.resolve({lineageId:shared})}));
  const groupAll=await edit('group','all',shared),groupOne=await edit('group','one',single),multiAll=await edit('multi','all',shared),singleAll=await edit('single','all',single);
  const form=(observed:{result:unknown})=>{const found=leaves(observed.result,'WorkflowForm');expect(found).toHaveLength(1);return found[0] as {options:{companies:{id:string}[];employees:{id:string}[];approverEmployees:{id:string}[];canManageAllCompanies:boolean}};initial:unknown};
  for(const observed of [groupAll,groupOne,multiAll,singleAll])expect(observed.statements.map(s=>s.sql).filter(text=>SLOW_READS.test(text))).toEqual([]);
  const sharedForm=form(groupAll).options;
  expect(sorted(ids(sharedForm.approverEmployees))).toEqual(sorted(approvers));
  expect(sorted(ids(sharedForm.employees))).toEqual(sorted(criteriaEmployees));
  expect(sharedForm.companies.length).toBeGreaterThanOrEqual(fixture.companyIds.length);
  expect(form(multiAll).options.approverEmployees.length).toBe(3);
  expect(form(singleAll).options.companies.map(c=>c.id)).toEqual([companyId]);
  expect(form(singleAll).options.employees).toEqual([]);
  expect(await databaseMs('editPage group all',groupAll.statements),'Edit database time (ms)').toBeLessThan(DB_MS.editPage);
  await databaseMs('editPage multi all',multiAll.statements);

  const create=await measure('newPage','create',  'group','all',()=>serverTreeSnapshot(createElement(NewAttendanceWorkflowPage,{searchParams:Promise.resolve({applicationType:'irregularity'})})));
  expect(form(create).options.employees).toEqual([]);expect(form(create).options.approverEmployees).toEqual([]);
  const copy=await measure('newPage','copy','group','all',()=>serverTreeSnapshot(createElement(NewAttendanceWorkflowPage,{searchParams:Promise.resolve({applicationType:'irregularity',copyFrom:shared})})));
  expect(sorted(ids(form(copy).options.approverEmployees))).toEqual(sorted(approvers));
  await measure('newPage','create','single','all',()=>serverTreeSnapshot(createElement(NewAttendanceWorkflowPage,{searchParams:Promise.resolve({applicationType:'self_overtime'})})));
  for(const observed of [create,copy])expect(observed.statements.map(s=>s.sql).filter(text=>SLOW_READS.test(text))).toEqual([]);

  const view=await measure('viewPage','shared','group','all',()=>serverTreeSnapshot(createElement(ViewAttendanceWorkflowPage,{params:Promise.resolve({lineageId:shared}),searchParams:Promise.resolve({})})));
  expect(view.statements.map(s=>s.sql).filter(text=>SLOW_READS.test(text))).toEqual([]);
  const viewText=JSON.stringify(view.result);
  expect(viewText).toContain('Fictional Approver Aisyah');
  await measure('viewPage','single','single','all',()=>serverTreeSnapshot(createElement(ViewAttendanceWorkflowPage,{params:Promise.resolve({lineageId:single}),searchParams:Promise.resolve({})})));
 },300_000);

 it('returns the same option lists and selected labels as the previous reader for every role',async()=>{
  const chosen=[...criteriaEmployees,fixture.employmentIds[2999]];
  for(const persona of ['group','multi','single'] as Persona[]){
   const ctx=personaCtx(persona),scope=persona==='single'?[companyId]:[...fixture.companyIds];
   const next=await attendanceWorkflowFormOptions(ctx,scope,{approverIds:approvers,employeeIds:chosen});
   const history=await attendanceApplicationFilterOptions(ctx,scope);
   // The previous workflow reader, as it was on main 240adad5c: the full employee list and the selected-approver read.
   const previous=await withTenant(ctx,async tx=>{
    const companies=history.companies.map(c=>c.id);
    const employees=companies.length?Array.from(await tx.execute<{id:string;name:string;employeeCode:string|null}>(sql`SELECT e.id,p.full_name AS name,e.employee_code AS "employeeCode"
     FROM employment e JOIN person p ON p.id=e.person_id JOIN company co ON co.id=e.company_id
     WHERE e.company_id IN (${sql.join(companies.map(id=>sql`${id}::uuid`),sql`, `)}) AND app.is_admin_for(e.company_id) ORDER BY p.full_name,e.id`)):[];
    const selected=Array.from(await tx.execute<{id:string;name:string;employeeCode:string|null}>(sql`select e.id,p.full_name as name,e.employee_code as "employeeCode" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.tenant_id=${ctx.tenantId}::uuid and e.id in (${sql.join(approvers.map(id=>sql`${id}::uuid`),sql`, `)}) and app.is_admin_for(e.company_id) and app.access_workforce_employment(e.id,'workforce.view')`));
    return {employees,selected};
   });
   for(const key of ['companies','departments','businessUnits','grades','divisions','positions','profileFields','canManageAllCompanies'] as const)expect(next[key],`${persona} ${key}`).toEqual((history as Record<string,unknown>)[key]);
   expect(next.companies.length,persona).toBe(persona==='single'?1:fixture.companyIds.length);
   expect(next.employees,`${persona} criteria labels`).toEqual(previous.employees.filter(row=>chosen.includes(row.id)));
   expect(sorted(ids(next.approverEmployees)),`${persona} approver labels`).toEqual(sorted(ids(previous.selected)));
   expect(next.approverEmployees!.map(row=>row.name).sort()).toEqual(previous.selected.map(row=>row.name).sort());
   // The criteria search's first page is the previous full list's first 50, and a query matches the same people in order.
   const first=await searchAttendanceWorkflowEmployees(ctx,{companyIds:scope,query:''});
   expect(first.rows.map(row=>row.id),`${persona} first page`).toEqual(previous.employees.slice(0,50).map(row=>row.id));
   expect(first.more).toBe(previous.employees.length>50);
   const tan=await searchAttendanceWorkflowEmployees(ctx,{companyIds:scope,query:'tan'});
   expect(tan.rows.map(row=>row.id),`${persona} query`).toEqual(previous.employees.filter(row=>/tan/i.test(row.name)||/tan/i.test(row.employeeCode??'')).slice(0,50).map(row=>row.id));
   if(persona!=='single')expect(previous.employees.length).toBeGreaterThan(3000);
  }
 },300_000);

 it('keeps a stored workflow definition byte for byte when it is saved again unchanged',async()=>{
  const root=adminCtx(b);
  const columns=(row:NonNullable<Awaited<ReturnType<typeof getAttendanceWorkflow>>>)=>JSON.stringify({companyIds:sorted(row.companyIds),allCompanies:row.allCompanies,applicationType:row.applicationType,routingVersion:row.routingVersion,code:row.code,name:row.name,description:row.description,priority:row.priority,criteria:row.criteria,stages:row.stages,cc:row.cc,active:row.active});
  for(const lineageId of [shared,single,overtime]){
   const before=(await getAttendanceWorkflow(root,lineageId,[...fixture.companyIds]))!;
   // What Edit hands the form, and what the redesigned form posts back untouched (the DOM test proves that half).
   const posted=attendanceWorkflowConfiguration(before);
   await saveAttendanceWorkflow(root,{...posted,active:true},lineageId);
   const after=(await getAttendanceWorkflow(root,lineageId,[...fixture.companyIds]))!;
   expect(after.version).toBe(before.version+1);
   expect(columns(after)).toBe(columns(before));
  }
 },300_000);
});

describe('03cb9b74: the people searches at group scale',()=>{
 it('measures the approver search with an empty query beside the pre-list it replaced',async()=>{
  const groupIds=[...fixture.companyIds];
  const call=(persona:Persona,companyIds:string[])=>measure('searchAttendanceApproversAction','empty',persona,'all',()=>searchAttendanceApproversAction({companyIds,query:'',page:0}));
  state.session=personaCtx('group');state.cookies={};await searchAttendanceApproversAction({companyIds:groupIds,query:'',page:0});
  const group=await call('group',groupIds),multi=await call('multi',groupIds),one=await call('single',[companyId]);
  for(const observed of [group,multi,one])expect(observed.result).toMatchObject({ok:true});
  const value=(group.result as {ok:true;value:{rows:{id:string}[];more:boolean}}).value;
  expect(value.rows).toHaveLength(50);expect(value.more).toBe(true);
  noWider(group,one);
  console.log('WORKFLOW_BUDGET '+JSON.stringify({label:'searchAttendanceApprovers empty, 71 companies, wall ms',group:group.row.ms,multi:multi.row.ms,single:one.row.ms}));
  await databaseMs('searchAttendanceApprovers empty group 71 companies',group.statements);
  await databaseMs('searchAttendanceApprovers empty multi 71 companies',multi.statements);
  await databaseMs('searchAttendanceApprovers empty single 1 company',one.statements);
  // Before: the listing and Edit pages' approver pre-list over the same 71 companies (one statement, the old reader).
  const before=await observeStatements(()=>withTenant(personaCtx('group'),tx=>tx.execute(sql`select id from app.attendance_workflow_v3_approver_options(${'{'+groupIds.join(',')+'}'}::uuid[]) limit 50`)));
  console.log('WORKFLOW_BUDGET '+JSON.stringify({label:'before: approver pre-list over 71 companies, wall ms',ms:Math.round(before.ms)}));
  await databaseMs('before: approver pre-list over 71 companies',before.statements);
 },300_000);

 it('returns the same approvers, eligibility, order and pages as the previous statement for every role',async()=>{
  // Ineligible people among them: an archived login (fixture terminations are ineligible too).
  const [archived]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(sql`${schema.employment.id}=${approvers[1]}::uuid`);
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(sql`${schema.appUser.personId}=${archived.personId}::uuid`);
  type Row={id:string;name:string;employeeCode:string|null;company:string;eligible:boolean};
  for(const persona of ['group','multi','single'] as Persona[]){
   const ctx=personaCtx(persona),scope=persona==='single'?[companyId]:[...fixture.companyIds];
   let ineligible=0;
   for(const query of ['','tan','Fictional Approver','FX-00'])for(const page of [0,1,7]){
    const next=await searchAttendanceApprovers(ctx,{companyIds:scope,query,page,selectedIds:approvers});
    // The statement as it was on main 240adad5c.
    const previous=await withTenant(ctx,async tx=>{
     const companies=sql`ARRAY[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
     const pattern='%'+query.trim().replace(/[\\%_]/g,'\\$&')+'%';
     const fields=sql`e.id,p.full_name as name,e.employee_code as "employeeCode",c.legal_name as company,
      not exists(select 1 from unnest(${companies}) target where not app.attendance_selected_approver_eligible(target,e.id)) as eligible`;
     const visible=sql`e.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(e.company_id) and app.access_workforce_employment(e.id,'workforce.view')`;
     const rows=Array.from(await tx.execute<Row>(sql`select ${fields} from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where ${visible} and (p.full_name ilike ${pattern} or e.employee_code ilike ${pattern}) order by e.employee_code nulls last,p.full_name,e.id limit 51 offset ${page*50}`));
     const selected=Array.from(await tx.execute<Row>(sql`select ${fields} from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where ${visible} and e.id in (${sql.join(approvers.map(id=>sql`${id}::uuid`),sql`, `)}) order by e.id`));
     return {rows:rows.slice(0,50),selected,more:rows.length>50};
    });
    expect(next.rows,`${persona} ${query} ${page}`).toEqual(previous.rows);
    expect(next.more,`${persona} ${query} ${page}`).toBe(previous.more);
    expect(Array.from(next.selected),`${persona} selected`).toEqual(previous.selected);
    ineligible+=previous.rows.filter(row=>!row.eligible).length+previous.selected.filter(row=>!row.eligible).length;
    if(persona!=='single'&&query===''&&page===0)expect(previous.rows).toHaveLength(50);
   }
   if(persona!=='single')expect(ineligible,`${persona} compares ineligible people too`).toBeGreaterThan(0);
  }
 },300_000);

 it('pages the criteria search by key, escapes wildcards, refuses bad input and stays in the company scope',async()=>{
  const groupIds=[...fixture.companyIds];
  state.session=personaCtx('group');state.cookies={};await searchAttendanceWorkflowEmployeesAction({companyIds:groupIds,query:''});
  const first=await measure('searchAttendanceWorkflowEmployeesAction','empty',  'group','all',()=>searchAttendanceWorkflowEmployeesAction({companyIds:groupIds,query:''}));
  const page=(first.result as {ok:true;value:{rows:{id:string;name:string}[];more:boolean}}).value;
  expect(page.rows).toHaveLength(50);expect(page.more).toBe(true);
  const last=page.rows[49];
  const second=await measure('searchAttendanceWorkflowEmployeesAction','next page','group','all',()=>searchAttendanceWorkflowEmployeesAction({companyIds:groupIds,query:'',after:{name:last.name,id:last.id}}));
  const multi=await measure('searchAttendanceWorkflowEmployeesAction','empty','multi','all',()=>searchAttendanceWorkflowEmployeesAction({companyIds:groupIds,query:''}));
  const one=await measure('searchAttendanceWorkflowEmployeesAction','empty','single','all',()=>searchAttendanceWorkflowEmployeesAction({companyIds:[companyId],query:''}));
  noWider(first,one);noWider(multi,one);
  // Independent: every employment of the group, by name and id; the second page continues exactly after the first.
  const all=Array.from(await owner.db.execute<{id:string}>(sql`select e.id from employment e join person p on p.id=e.person_id where e.tenant_id=${b.tenantId}::uuid and e.company_id = any(${'{'+groupIds.join(',')+'}'}::uuid[]) order by p.full_name,e.id`)).map(row=>row.id);
  expect(page.rows.map(row=>row.id)).toEqual(all.slice(0,50));
  expect((second.result as {ok:true;value:{rows:{id:string}[]}}).value.rows.map(row=>row.id)).toEqual(all.slice(50,100));
  const singleRows=(one.result as {ok:true;value:{rows:{id:string;company:string}[]}}).value.rows;
  const singleCompany=Array.from(await owner.db.execute<{id:string}>(sql`select e.id from employment e join person p on p.id=e.person_id where e.company_id=${companyId}::uuid order by p.full_name,e.id limit 50`)).map(row=>row.id);
  expect(singleRows.map(row=>row.id)).toEqual(singleCompany);
  expect(singleRows.length).toBeGreaterThan(0);
  await databaseMs('searchAttendanceWorkflowEmployees empty group 71 companies',first.statements);
  // Wildcards are literal: % and _ match only themselves.
  const [percent,underscore]=await owner.db.insert(schema.person).values([{tenantId:b.tenantId,fullName:'Fictional 100% Ready',primaryEmail:`${randomUUID()}@fixture.test`},{tenantId:b.tenantId,fullName:'Fictional A_B Wong',primaryEmail:`${randomUUID()}@fixture.test`}]).returning({id:schema.person.id});
  await owner.db.insert(schema.employment).values([{tenantId:b.tenantId,personId:percent.id,companyId,employeeCode:'PCT-1',hiredOn:'2022-01-01'},{tenantId:b.tenantId,personId:underscore.id,companyId,employeeCode:'UND-1',hiredOn:'2022-01-01'}]);
  const group=personaCtx('group');
  expect((await searchAttendanceWorkflowEmployees(group,{companyIds:groupIds,query:'%'})).rows.map(row=>row.name)).toEqual(['Fictional 100% Ready']);
  expect((await searchAttendanceWorkflowEmployees(group,{companyIds:groupIds,query:'A_B'})).rows.map(row=>row.name)).toEqual(['Fictional A_B Wong']);
  expect((await searchAttendanceWorkflowEmployees(group,{companyIds:groupIds,query:'pct-1'})).rows.map(row=>row.employeeCode)).toEqual(['PCT-1']);
  // Bounds and malformed input are refused before any read.
  for(const bad of [{companyIds:[],query:''},{companyIds:groupIds,query:'x'.repeat(101)},{companyIds:['not-a-company'],query:''},{companyIds:groupIds,query:'',after:{name:'x',id:'not-an-id'}}])
   await expect(searchAttendanceWorkflowEmployees(group,bad as never)).rejects.toMatchObject({code:'invalid'});
  // A one-company administrator: another company's employees are never returned, and the action refuses the company.
  const singleCtx=personaCtx('single'),other=fixture.companyIds.find(id=>id!==companyId)!;
  expect((await searchAttendanceWorkflowEmployees(singleCtx,{companyIds:[other],query:''})).rows).toEqual([]);
  state.session=singleCtx;state.cookies={};
  // The action refuses a company outside the persona's company list; within it, the service returns only administered
  // companies' employees, so a company the persona does not administer yields nobody either way.
  const outside=await searchAttendanceWorkflowEmployeesAction({companyIds:[other],query:''});
  expect(outside.ok?outside.value.rows:[]).toEqual([]);
  // Another tenant's administrator sees none of this tenant's employees.
  const foreign=await seedBase();
  expect((await searchAttendanceWorkflowEmployees(adminCtx(foreign),{companyIds:[companyId],query:''})).rows).toEqual([]);
  expect((await searchAttendanceWorkflowEmployees(adminCtx(foreign),{companyIds:[foreign.companyId],query:'Fictional 100%'})).rows).toEqual([]);
 },300_000);
});

