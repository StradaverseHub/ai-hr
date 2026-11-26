/** ADR 0181 read budgets and the 7510 access-rule timing (docs/architecture/FUTURE-BUILD-CONTRACT.md, "Database read
 * cost", rules 2, 3 and 6; docs/SCALE-AND-RELEASE-RULES.md rules 2 and 3) for board 038c304b / bc6b5490:
 *  - app/payroll/transactions/cp38/page.tsx, the Payroll > Transaction Entry > CP38 Deduction page;
 *  - app/payroll/transactions/cp38/actions.ts saveCp38DialogAction (Add and Edit) and deleteCp38DialogAction;
 *  - app/admin/personnel/[employmentId]/cp38-actions.ts deleteCp38Action (the Payroll tab's new Delete).
 *
 * On the fictional 71-company / 1,000-employment group fixture (test/helpers/ai-centre-scale-fixture.ts) with CP38
 * records on about 400 employees across the staffed companies and correction history on some, the page is rendered as
 * one server render (server components resolved by test/helpers/server-tree-snapshot.ts) and each action is called as
 * the browser calls it (the real modules; session, company switcher cookie and translations mocked at the Next.js edge
 * only), and their statements and transactions are counted with observeStatements. Personas: the group administrator
 * at "All companies" and at one company (company switcher), an administrator granted all 71 companies one by one, and a
 * company-scoped administrator of one company. It proves:
 *  - budget: no measurement exceeds BUDGETS (transactions, statements). Budgets only go down; raising one needs an ADR
 *    note (ADR 0181 or ADR-0057);
 *  - no per-company or per-row loop: "All companies" costs no more statements than one company, and 71 company grants
 *    no more than one company's grant;
 *  - the reads are real: the list's first page and its count equal an independent owner query of the same population
 *    (records of the companies the persona administers, current, non-voided), in the same order;
 *  - migration 7510's new access rules (employee_cp38_revision_read / _insert, the precomputed visible-employment
 *    answer read once per statement) are timed with EXPLAIN ANALYZE on the page's real statements, "All companies" and
 *    one company, printed as CP38_EXPLAIN lines (explainStatements, test/helpers/statement-observer.ts).
 * Every measurement is printed as one `CP38_BUDGET {json}` line. All names are invented. */
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,cookies:{} as Record<string,string>}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers({'x-pathname':'/payroll/transactions/cp38'}),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next-intl/server',()=>{
 const translator=(namespace?:string)=>{
  const t=(key:string,values?:Record<string,unknown>)=>`${namespace?namespace+'.':''}${key}${values?JSON.stringify(values):''}`;
  return Object.assign(t,{rich:t,markup:t,raw:(key:string)=>key,has:()=>true});
 };
 return {getLocale:async()=>'en',getTranslations:async(arg?:string|{namespace?:string})=>translator(typeof arg==='string'?arg:arg?.namespace)};
});
vi.mock('next/cache',async importOriginal=>({...await importOriginal<typeof import('next/cache')>(),revalidatePath:vi.fn(),revalidateTag:vi.fn()}));
vi.mock('next/navigation',async importOriginal=>({...await importOriginal<typeof import('next/navigation')>(),
 redirect:vi.fn((url:string)=>{throw Object.assign(new Error(`NEXT_REDIRECT ${url}`),{digest:`NEXT_REDIRECT;replace;${url}`});}),
 notFound:vi.fn(()=>{throw Object.assign(new Error('NEXT_NOT_FOUND'),{digest:'NEXT_HTTP_ERROR_FALLBACK;404'});})}));
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import Cp38DeductionPage from '../app/payroll/transactions/cp38/page';
import {deleteCp38DialogAction,saveCp38DialogAction} from '../app/payroll/transactions/cp38/actions';
import {deleteCp38Action} from '../app/admin/personnel/[employmentId]/cp38-actions';
import {listCp38Across,setCp38,updateCp38} from '../core/cp38';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {explainStatements,observeStatements} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

type Key='page'|'saveCp38DialogAction'|'deleteCp38DialogAction'|'deleteCp38Action';
/** Recorded budgets: the largest (transactions, statements) measured over every persona and scope below. Budgets only
 * go down; raising one needs an ADR note. */
const BUDGETS:Record<Key,{transactions:number;statements:number}>={
 // Measured on the CI runner (alpha-focused-checks run 45768875945), the same for every persona and scope: the list
 // is 5 transactions and 17 statements; with an employee chosen, 6 and 22 (the picker's selection and their history).
 page:{transactions:6,statements:22},
 // Add measured 2 and 13; Edit 2 and 15.
 saveCp38DialogAction:{transactions:2,statements:15},
 deleteCp38DialogAction:{transactions:2,statements:14},
 deleteCp38Action:{transactions:1,statements:12},
};
type Persona='group'|'multi'|'single';
type Scope='all'|'one';
let b:Base,fixture:ScaleFixture,a:SessionContext,companyId:string;
const fresh:string[]=[];
const measured:Record<string,{transactions:number;statements:number}>={};
const TODAY_FROM='2026-01-01';

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 await setModule(b.tenantId,'payroll','active');
 fixture=await buildScaleFixture(b,{employments:1000,events:200});
 companyId=fixture.singleCompanyId;
 a=adminCtx(b);
 // CP38 records on ~400 employees spread over the staffed companies: open, ended and upcoming, some with a last month.
 const subjects=fixture.employmentIds.filter((_,i)=>i%5<2);
 const rows=subjects.map((employmentId,i)=>({tenantId:b.tenantId,employmentId,cp38Ref:`CP38/FX/${String(i).padStart(4,'0')}`,amount:String(100+i%50),
  validFrom:i%7===0?'2027-01-01':'2026-01-01',validTo:i%3===0&&i%7!==0?'2026-07-01':null,lastMonthAmount:i%3===0&&i%7!==0&&i%2===0?'12.34':null,remarks:i%4===0?'Fictional letter':null}));
 for(let i=0;i<rows.length;i+=500)await owner.db.insert(schema.employeeCp38).values(rows.slice(i,i+500));
 // Correction history on every tenth record, one edit each, written as the native writer writes it.
 const recs=await owner.db.select({id:schema.employeeCp38.id,employmentId:schema.employeeCp38.employmentId}).from(schema.employeeCp38).where(eq(schema.employeeCp38.tenantId,b.tenantId));
 const history=recs.filter((_,i)=>i%10===0).map(r=>({tenantId:b.tenantId,cp38Id:r.id,employmentId:r.employmentId,action:'edit' as const,
  before:{cp38Ref:'CP38/OLD',amount:'90.00',lastMonthAmount:null,validFrom:'2026-01-01',validTo:null,remarks:null},
  after:{cp38Ref:'CP38/NEW',amount:'100.00',lastMonthAmount:null,validFrom:'2026-01-01',validTo:null,remarks:null},actorUserId:b.adminUserId}));
 await owner.db.insert(schema.employeeCp38Revision).values(history);
 // Twenty fresh fictional employees of the single administrator's company, so each action measurement starts clean.
 const people=await owner.db.insert(schema.person).values(Array.from({length:20},(_,i)=>({tenantId:b.tenantId,fullName:`Fictional CP38 Budget ${i}`,
  primaryEmail:`cp38-budget-${i}-${randomUUID().slice(0,8)}@fixture.test`}))).returning({id:schema.person.id});
 fresh.push(...(await owner.db.insert(schema.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId,
  employeeCode:`FX-CP38-${String(i).padStart(2,'0')}`,hiredOn:'2022-01-01'}))).returning({id:schema.employment.id})).map(r=>r.id));
 await owner.db.execute(sql`analyze public.employee_cp38, public.employee_cp38_revision, public.employment, public.person, public.company`);
},300_000);
afterAll(async()=>{console.log('CP38_BUDGET_SUMMARY '+JSON.stringify(measured));await closeAll();});

const personaCtx=(persona:Persona):SessionContext=>({...fixture.personas[persona]});
async function measure<T>(key:Key,label:string,persona:Persona,scope:Scope,work:()=>Promise<T>){
 state.session=personaCtx(persona);
 state.cookies=scope==='one'?{company_scope:companyId}:{};
 const observed=await observeStatements(()=>work().catch((error:unknown)=>{
  const digest=(error as {digest?:unknown})?.digest;if(typeof digest==='string'&&digest.startsWith('NEXT_'))return {redirect:digest} as T;throw error;}));
 const row={key,label,persona,scope,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
 console.log('CP38_BUDGET '+JSON.stringify(row));
 measured[`${key}|${label}|${persona}|${scope}`]={transactions:row.transactions,statements:row.statements};
 expect(row.transactions,`${key} ${label} ${persona} ${scope} transactions`).toBeGreaterThan(0);
 expect(row.transactions,`${key} ${label} ${persona} ${scope} transactions`).toBeLessThanOrEqual(BUDGETS[key].transactions);
 expect(row.statements,`${key} ${label} ${persona} ${scope} statements`).toBeLessThanOrEqual(BUDGETS[key].statements);
 return {...observed,row};
}
const noWider=(wide:{row:{statements:number;transactions:number}},narrow:{row:{statements:number;transactions:number}})=>{
 expect(wide.row.statements,'statements').toBeLessThanOrEqual(narrow.row.statements);
 expect(wide.row.transactions,'transactions').toBeLessThanOrEqual(narrow.row.transactions);
};
/** The list population, independently: current records of non-voided employments in the persona's companies. */
async function expectedList(companyIds:readonly string[]){
 const rows=await owner.db.execute<{id:string}>(sql`select r.id from employee_cp38 r join employment e on e.id=r.employment_id
  join company c on c.id=e.company_id where r.tenant_id=${b.tenantId}::uuid and r.superseded_at is null and e.voided_at is null
  and e.company_id = any(${'{'+companyIds.join(',')+'}'}::uuid[])
  order by c.legal_name, coalesce(e.employee_code,''), r.valid_from, r.id`);
 return Array.from(rows).map(r=>r.id);
}
/** The Cp38RowActions leaves of a rendered page (client islands are recorded with their props). */
function renderedRecordIds(tree:unknown):string[]{
 const out:string[]=[];
 const walk=(node:unknown)=>{
  if(node===null||typeof node!=='object')return;
  if(Array.isArray(node)){node.forEach(walk);return;}
  const n=node as Record<string,unknown>;
  if(n.type==='Cp38RowActions'&&n.props){out.push(((n.props as {record:{id:string}}).record).id);return;}
  Object.values(n).forEach(walk);
 };
 walk(tree);return out;
}

describe('038c304b: the CP38 Deduction page at group scale',()=>{
 it('renders one keyset page and a capped count, the same rows as an independent query, without a per-company cost',async()=>{
  const render=(persona:Persona,scope:Scope,sp:Record<string,string>={})=>measure('page',Object.keys(sp).join('+')||'list',persona,scope,
   ()=>serverTreeSnapshot(createElement(Cp38DeductionPage,{searchParams:Promise.resolve(sp)})));
  // One unmeasured render first: process-level caches fill once.
  state.session=personaCtx('group');state.cookies={};await serverTreeSnapshot(createElement(Cp38DeductionPage,{searchParams:Promise.resolve({})}));
  const groupAll=await render('group','all'),groupOne=await render('group','one'),multiAll=await render('multi','all'),single=await render('single','all');
  noWider(groupAll,groupOne);
  noWider(multiAll,single);
  const all=await expectedList(fixture.companyIds),one=await expectedList([companyId]);
  expect(all.length).toBeGreaterThan(300);
  expect(one.length).toBeGreaterThan(0);
  expect(renderedRecordIds(groupAll.result)).toEqual(all.slice(0,25));
  expect(renderedRecordIds(multiAll.result)).toEqual(all.slice(0,25));
  expect(renderedRecordIds(groupOne.result)).toEqual(one.slice(0,25));
  expect(renderedRecordIds(single.result)).toEqual(one.slice(0,25));
  // The count is exact below the cap and the same population.
  const read=await listCp38Across(personaCtx('group'),{companyIds:fixture.companyIds,page:{limit:25,size:25,last:false,exactCount:false}});
  expect(read.total).toEqual({count:all.length,capped:false});
  // With an employee chosen: their history read is one more statement, not one per record.
  const chosen=(await owner.db.select({employmentId:schema.employeeCp38.employmentId}).from(schema.employeeCp38)
   .innerJoin(schema.employment,eq(schema.employment.id,schema.employeeCp38.employmentId))
   .where(and(eq(schema.employment.companyId,companyId),isNull(schema.employment.terminatedOn))).limit(1))[0].employmentId;
  const picked=await render('single','all',{employmentId:chosen});
  expect(renderedRecordIds(picked.result).length).toBeGreaterThan(0);
  // A filter by status and company narrows in SQL.
  await render('group','all',{status:'upcoming',company:companyId});

  // Migration 7510: the revision's access rule on the page's real statements, "All companies" and one company.
  for(const [label,observed] of [['all',groupAll],['one',groupOne],['single',single]] as const){
   const explained=await explainStatements(observed.statements);
   const revision=explained.filter(e=>/employee_cp38_revision/.test(e.sql));
   expect(revision.length,`${label} reads the revision`).toBeGreaterThan(0);
   for(const e of explained.filter(x=>/employee_cp38/.test(x.sql))){
    console.log('CP38_EXPLAIN '+JSON.stringify({migration:'7510',label,sql:e.sql.slice(0,120),executionMs:e.executionMs,planningMs:e.planningMs,hotspots:e.hotspots.slice(0,3)}));
    expect(e.error,`${label}: ${e.sql.slice(0,80)}`).toBeUndefined();
   }
  }
 },300_000);
});

describe('038c304b / bc6b5490: the CP38 writers at group scale',()=>{
 let next=0;
 const take=()=>{const id=fresh[next++];expect(id,'enough fresh employees').toBeTruthy();return id;};
 const form=(values:Record<string,string>)=>{const f=new FormData();for(const [k,v] of Object.entries(values))f.set(k,v);return f;};
 const scopes:{persona:Persona;scope:Scope}[]=[{persona:'group',scope:'all'},{persona:'group',scope:'one'},{persona:'multi',scope:'all'},{persona:'single',scope:'all'}];
 const current=(employmentId:string)=>owner.db.select({id:schema.employeeCp38.id,amount:schema.employeeCp38.amount,validTo:schema.employeeCp38.validTo,
  lastMonthAmount:schema.employeeCp38.lastMonthAmount}).from(schema.employeeCp38)
  .where(and(eq(schema.employeeCp38.employmentId,employmentId),isNull(schema.employeeCp38.supersededAt)));

 it('adds, edits and deletes in a bounded number of reads for every scope, and refuses outside the company scope',async()=>{
  // One unmeasured save first.
  state.session=personaCtx('group');state.cookies={};
  expect(await saveCp38DialogAction(form({employmentId:take(),cp38Ref:'CP38/WARM',amount:'10',validFrom:TODAY_FROM}))).toMatchObject({ok:true});
  const sets:Record<string,Record<string,Awaited<ReturnType<typeof measure>>>>={add:{},edit:{},del:{},tab:{}};
  for(const {persona,scope} of scopes){
   const k=`${persona}|${scope}`;
   const addTo=take();
   sets.add[k]=await measure('saveCp38DialogAction','add',persona,scope,()=>saveCp38DialogAction(form({employmentId:addTo,cp38Ref:'CP38/ADD',amount:'300',
    validFrom:'2026-01-01',validTo:'2026-07-01',lastMonthEnabled:'1',lastMonthAmount:'289.35',returnTo:'/payroll/transactions/cp38?status=active'})));
   expect(sets.add[k].result,k).toEqual({ok:true,navigate:expect.stringMatching(/^\/payroll\/transactions\/cp38\?status=active&toast=/)});
   const [added]=await current(addTo);
   expect(added).toMatchObject({amount:'300.00',validTo:'2026-08-01',lastMonthAmount:'289.35'});
   sets.edit[k]=await measure('saveCp38DialogAction','edit',persona,scope,()=>saveCp38DialogAction(form({id:added.id,employmentId:addTo,cp38Ref:'CP38/ADD',
    amount:'310',validFrom:'2026-01-01',validTo:'2026-07-01'})));
   expect(sets.edit[k].result,k).toMatchObject({ok:true});
   expect((await current(addTo))[0]).toMatchObject({amount:'310.00',lastMonthAmount:null});
   sets.del[k]=await measure('deleteCp38DialogAction','delete',persona,scope,()=>deleteCp38DialogAction(form({id:added.id})));
   expect(sets.del[k].result,k).toMatchObject({ok:true});
   expect(await current(addTo)).toEqual([]);
   // The Payroll tab's Delete (redirects back to the tab).
   const tabEmp=take();
   const {id}=await setCp38(a,{employmentId:tabEmp,cp38Ref:'CP38/TAB',amount:20,validFrom:'2026-01-01'});
   await updateCp38(a,{id,amount:21});
   sets.tab[k]=await measure('deleteCp38Action','delete',persona,scope,()=>deleteCp38Action(form({employmentId:tabEmp,id,tab:'payroll'})));
   expect(await current(tabEmp)).toEqual([]);
  }
  for(const set of Object.values(sets)){
   noWider(set['group|all'],set['group|one']);
   noWider(set['multi|all'],set['single|all']);
  }
  // Outside the single administrator's company: refused, nothing written.
  const outside=(await owner.db.select({employmentId:schema.employeeCp38.employmentId,id:schema.employeeCp38.id}).from(schema.employeeCp38)
   .innerJoin(schema.employment,eq(schema.employment.id,schema.employeeCp38.employmentId))
   .where(and(inArray(schema.employment.companyId,fixture.companyIds.filter(id=>id!==companyId)),isNull(schema.employeeCp38.supersededAt))).limit(1))[0];
  state.session=personaCtx('single');state.cookies={};
  expect(await saveCp38DialogAction(form({id:outside.id,employmentId:outside.employmentId,cp38Ref:'CP38/HACK',amount:'1',validFrom:'2026-01-01'})))
   .toMatchObject({ok:false});
  expect(await deleteCp38DialogAction(form({id:outside.id}))).toMatchObject({ok:false});
  expect(await current(outside.employmentId)).toHaveLength(1);
  // The group administrator with the switcher on one company cannot reach another company's record either.
  state.session=personaCtx('group');state.cookies={company_scope:companyId};
  expect(await deleteCp38DialogAction(form({id:outside.id}))).toMatchObject({ok:false,message:'payroll.transactions.cp38.error.outOfScope{"ref":"","from":"","to":"payroll.transactions.cp38.open"}'});
  expect(await current(outside.employmentId)).toHaveLength(1);
 },300_000);
});
