/** ADR 0181 read budgets (docs/architecture/FUTURE-BUILD-CONTRACT.md, "Database read cost") for the Form TP3 Excel
 * import (board 5084d02e): its three server actions (app/payroll/transactions/tp3/import-actions.ts: check, follow,
 * confirm) and its two pages (the Import Log and one import).
 *
 * Each action is called and each page function is run as the request runs it (the real modules; the session, the
 * company switcher cookie and the translator mocked at the Next.js edge only) on the fictional 71-company / 1,000-
 * employment group fixture (test/helpers/ai-centre-scale-fixture.ts), and its statements and transactions are counted
 * with observeStatements (test/helpers/statement-observer.ts). Personas: the group administrator at "All companies"
 * and at one company (company switcher), an administrator granted all 71 companies one by one, and a company-scoped
 * administrator of one company. It proves, for each:
 *  - budget: no measurement exceeds the recorded BUDGETS (transactions, statements). Budgets only go down; raising one
 *    needs an ADR note;
 *  - no per-company or per-row loop: "All companies" (71 companies, a 300-row file resolved against 1,000 employees)
 *    costs no more than one company, and 71 company-by-company grants no more than one company's grant;
 *  - the measurement is real: each call succeeds with the expected outcome, read back independently.
 * Every measurement is printed as one `ACTION_BUDGET {json}` line. All names are invented. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,cookies:{} as Record<string,string>}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers(),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next/cache',async importOriginal=>({...await importOriginal<typeof import('next/cache')>(),revalidatePath:vi.fn(),revalidateTag:vi.fn()}));
vi.mock('next/navigation',async importOriginal=>({...await importOriginal<typeof import('next/navigation')>(),
 notFound:vi.fn(()=>{throw new Error('NEXT_NOT_FOUND');}),
 redirect:vi.fn((url:string)=>{throw Object.assign(new Error(`NEXT_REDIRECT ${url}`),{digest:`NEXT_REDIRECT;replace;${url}`});})}));
vi.mock('next-intl/server',()=>{
 const translator=(namespace?:string)=>{
  const t=(key:string,values?:Record<string,unknown>)=>`${namespace?namespace+'.':''}${key}${values?JSON.stringify(values):''}`;
  return Object.assign(t,{rich:t,markup:t,raw:(key:string)=>key,has:()=>true});
 };
 return {getLocale:async()=>'en',getTranslations:async(arg?:string|{namespace?:string})=>translator(typeof arg==='string'?arg:arg?.namespace),
  getFormatter:async()=>({dateTime:(value:unknown)=>new Date(value as string).toISOString(),number:(value:unknown)=>String(value)})};
});
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {checkTp3ImportAction,confirmTp3ImportAction,readTp3ImportAction} from '../app/payroll/transactions/tp3/import-actions';
import Tp3ImportLogPage from '../app/payroll/transactions/tp3/imports/page';
import Tp3ImportPage from '../app/payroll/transactions/tp3/imports/[id]/page';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {readTp3Import,tp3ImportJobHandler} from '../core/tp3-import-job';
import {bulkJobActive} from '../lib/bulk-job';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

type Budgeted='checkTp3ImportAction'|'readTp3ImportAction'|'confirmTp3ImportAction'|'logPage'|'importPage';
/** Recorded budgets: the largest (transactions, statements) measured over every persona and scope below. Budgets only
 * go down; raising one needs an ADR note (docs/adr/0181-database-read-cost-architecture.md). */
const BUDGETS:Record<Budgeted,{transactions:number;statements:number}>={
 checkTp3ImportAction:{transactions:3,statements:16},
 readTp3ImportAction:{transactions:3,statements:12},
 confirmTp3ImportAction:{transactions:3,statements:17},
 logPage:{transactions:3,statements:12},
 importPage:{transactions:3,statements:12},
};
type Persona='group'|'multi'|'single';
type Scope='all'|'one';
const SCOPES:{persona:Persona;scope:Scope}[]=[{persona:'group',scope:'all'},{persona:'group',scope:'one'},{persona:'multi',scope:'all'},{persona:'single',scope:'all'}];
let b:Base,fixture:ScaleFixture,codes:string[];
const measured:Record<string,{transactions:number;statements:number}>={};

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 // Before the fixture: its personas' entitlement snapshots are resolved from the tenant's rows when it is built.
 await setModule(b.tenantId,'payroll','active');
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 // 300 of the fixture's Employee IDs across its companies, including the one-company personas' company: the file every
 // persona checks.
 const all=(await owner.db.select({code:schema.employment.employeeCode,company:schema.employment.companyId}).from(schema.employment)
  .where(eq(schema.employment.tenantId,b.tenantId))).filter(r=>/^FX-\d{4}$/.test(r.code??'')).sort((x,y)=>x.code!.localeCompare(y.code!));
 const own=all.filter(r=>r.company===fixture.singleCompanyId).slice(0,60).map(r=>r.code!);
 codes=[...own,...all.filter(r=>r.company!==fixture.singleCompanyId).map(r=>r.code!)].slice(0,300);
 expect(own.length).toBeGreaterThan(0);
},300_000);
afterAll(async()=>{console.log('ACTION_BUDGET_SUMMARY '+JSON.stringify(measured));await closeAll();});

const personaCtx=(persona:Persona):SessionContext=>({...fixture.personas[persona]});
const csv=()=>['Employee ID,Assessment Year,Deduction Month,C1,C3,C5',...codes.map(code=>`${code},2026,4,24000.00,2640.00,310.00`)].join('\n')+'\n';
function use(persona:Persona,scope:Scope){state.session=personaCtx(persona);state.cookies=scope==='one'?{company_scope:fixture.singleCompanyId}:{};}
async function measure<T>(what:Budgeted,persona:Persona,scope:Scope,work:()=>Promise<T>){
 use(persona,scope);
 const observed=await observeStatements(work);
 const row={action:what,persona,scope,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
 console.log('ACTION_BUDGET '+JSON.stringify(row));
 const key=`${what}|${persona}|${scope}`;
 measured[key]={transactions:row.transactions,statements:row.statements};
 expect(observed.transactions,`${key} transactions`).toBeGreaterThan(0);
 expect(observed.transactions,`${key} transactions`).toBeLessThanOrEqual(BUDGETS[what].transactions);
 expect(observed.statements.length,`${key} statements`).toBeLessThanOrEqual(BUDGETS[what].statements);
 return {...observed,key};
}
function expectNoWiderCost(wide:{transactions:number;statements:unknown[];key:string},narrow:{transactions:number;statements:unknown[];key:string}){
 expect(wide.transactions,`${wide.key} vs ${narrow.key} transactions`).toBeLessThanOrEqual(narrow.transactions);
 expect(wide.statements.length,`${wide.key} vs ${narrow.key} statements`).toBeLessThanOrEqual(narrow.statements.length);
}
async function settle(ctx:SessionContext,id:string,scopeIds:string[]){
 let job=await readTp3Import(ctx,id,scopeIds);
 for(let tick=0;tick<200&&bulkJobActive(job.state);tick++){await runBulkJobTick(owner.client,{handlers:[tp3ImportJobHandler]});job=await readTp3Import(ctx,id,scopeIds);}
 return job;
}
const scopeOf=(persona:Persona,scope:Scope)=>persona==='single'||scope==='one'?[fixture.singleCompanyId]:[...fixture.companyIds];

describe('5084d02e: the Form TP3 import actions and pages at group scale',()=>{
 it('checks, follows and confirms a 300-row file, and lists and opens imports, in a bounded number of reads for every scope',async()=>{
  expect(codes).toHaveLength(300);
  // One unmeasured check first: process-level caches (tenant facts the first transaction learns) fill once.
  use('group','all');
  const warm=await checkTp3ImportAction({csv:csv(),fileName:'warm.xlsx',operationKey:randomUUID()});
  expect(warm.ok).toBe(true);
  if(warm.ok)await settle(personaCtx('group'),warm.id,scopeOf('group','all'));
  const checks:Record<string,Awaited<ReturnType<typeof measure>>>={},reads:Record<string,Awaited<ReturnType<typeof measure>>>={},
   confirms:Record<string,Awaited<ReturnType<typeof measure>>>={},logs:Record<string,Awaited<ReturnType<typeof measure>>>={},pages:Record<string,Awaited<ReturnType<typeof measure>>>={};
  for(const {persona,scope} of SCOPES){
   const k=`${persona}|${scope}`,scopeIds=scopeOf(persona,scope),file=`tp3-${persona}-${scope}.xlsx`,text=csv();
   checks[k]=await measure('checkTp3ImportAction',persona,scope,()=>checkTp3ImportAction({csv:text,fileName:file,operationKey:randomUUID()}));
   const queued=checks[k].result as Awaited<ReturnType<typeof checkTp3ImportAction>>;
   expect(queued.ok,checks[k].key).toBe(true);
   if(!queued.ok)return;
   reads[k]=await measure('readTp3ImportAction',persona,scope,()=>readTp3ImportAction(queued.id));
   expect(reads[k].result,reads[k].key).toMatchObject({ok:true,job:{id:queued.id,mode:'check'}});
   const checked=await settle(personaCtx(persona),queued.id,scopeIds);
   // The file's Employee IDs resolve within the persona's companies only.
   const inScope=(await owner.db.select({code:schema.employment.employeeCode,company:schema.employment.companyId}).from(schema.employment)
    .where(eq(schema.employment.tenantId,b.tenantId))).filter(r=>codes.includes(r.code!)&&scopeIds.includes(r.company)).length;
   expect(checked,k).toMatchObject({state:'completed',total:300,ready:expect.any(Number)});
   expect(checked.ready+checked.failed,k).toBe(300);
   expect(checked.rows.filter(row=>row.reason==='employeeNotFound').length,k).toBe(300-inScope);
   if(checked.ready===0)continue;
   confirms[k]=await measure('confirmTp3ImportAction',persona,scope,()=>confirmTp3ImportAction({checkJobId:queued.id,csv:text,fileName:file}));
   const saved=confirms[k].result as Awaited<ReturnType<typeof confirmTp3ImportAction>>;
   expect(saved.ok,confirms[k].key).toBe(true);
   if(!saved.ok)return;
   const done=await settle(personaCtx(persona),saved.id,scopeIds);
   expect(done,k).toMatchObject({state:'completed',mode:'save'});
   logs[k]=await measure('logPage',persona,scope,()=>Tp3ImportLogPage({searchParams:Promise.resolve({})}));
   expect(logs[k].result,logs[k].key).toBeTruthy();
   pages[k]=await measure('importPage',persona,scope,()=>Tp3ImportPage({params:Promise.resolve({id:saved.id})}));
   expect(pages[k].result,pages[k].key).toBeTruthy();
  }
  for(const set of [checks,reads,confirms,logs,pages]){
   if(set['group|all']&&set['group|one'])expectNoWiderCost(set['group|all'],set['group|one']);
   if(set['multi|all']&&set['single|all'])expectNoWiderCost(set['multi|all'],set['single|all']);
  }
  expect(Object.keys(confirms).length).toBeGreaterThanOrEqual(3);
 },600_000);
});
