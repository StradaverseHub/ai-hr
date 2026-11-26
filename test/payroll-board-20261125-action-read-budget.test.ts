/** ADR 0181 read budgets (docs/architecture/FUTURE-BUILD-CONTRACT.md, "Database read cost") for the four server actions
 * board batch 20261125c added before the standard existed:
 *  - app/payroll/outstanding-actions.ts requestPayrollOutstandingRefreshAction and readPayrollOutstandingRefreshAction
 *    (a1a80747 r2: the Payroll Process list asks for its processed runs' "still owed" answers and follows the job);
 *  - app/payroll/transactions/fixed/actions.ts saveFixedTransactionDialogAction and removeFixedTransactionDialogAction
 *    (cc8bd87f: the Fixed Transaction View / Edit pop-up's save and remove).
 *
 * Each action is called as the browser calls it (the real module, the session and company switcher cookie mocked at
 * the Next.js edge only) on the fictional 71-company / 1,000-employment group fixture (test/helpers/ai-centre-scale-
 * fixture.ts, the one test/route-read-budget.test.ts uses), and its statements and transactions are counted with
 * observeStatements (test/helpers/statement-observer.ts). Personas: the group administrator at "All companies" and at
 * one company (company switcher), an administrator granted all 71 companies one by one, and a company-scoped
 * administrator of one company. It proves, for every action:
 *  - budget: no measurement exceeds the recorded BUDGETS (transactions, statements), the largest measured value.
 *    Budgets only go down; raising one needs an ADR note;
 *  - no per-company or per-row loop: "All companies" (71 companies, 1,000 employees in the scope check, 70 runs asked
 *    for) costs no more than one company (24 employees, 10 runs), and 71 company-by-company grants cost no more than
 *    one company's grant, in statements and transactions;
 *  - the measurement is real: each call succeeds with the expected outcome (runs claimed, job followed, row ended,
 *    versioned or removed), read back independently.
 * Every measurement is printed as one `ACTION_BUDGET {json}` line. All names are invented. */
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,isNotNull,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,cookies:{} as Record<string,string>}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers(),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next/cache',async importOriginal=>({...await importOriginal<typeof import('next/cache')>(),revalidatePath:vi.fn(),revalidateTag:vi.fn()}));
vi.mock('next/navigation',async importOriginal=>({...await importOriginal<typeof import('next/navigation')>(),
 redirect:vi.fn((url:string)=>{throw Object.assign(new Error(`NEXT_REDIRECT ${url}`),{digest:`NEXT_REDIRECT;replace;${url}`});})}));
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {readPayrollOutstandingRefreshAction,requestPayrollOutstandingRefreshAction} from '../app/payroll/outstanding-actions';
import {removeFixedTransactionDialogAction,saveFixedTransactionDialogAction} from '../app/payroll/transactions/fixed/actions';
import {listPayComponents,seedPayComponentCatalog,setEmploymentPayComponent} from '../packs/payroll/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

type Action='requestPayrollOutstandingRefreshAction'|'readPayrollOutstandingRefreshAction'|'saveFixedTransactionDialogAction'|'removeFixedTransactionDialogAction';
/** Recorded budgets per action: the largest (transactions, statements) measured over every persona and scope below, and
 * for the save over both of its writing paths (end date only, and a new version). Budgets only go down; raising one
 * needs an ADR note (docs/adr/0181-database-read-cost-architecture.md). */
const BUDGETS:Record<Action,{transactions:number;statements:number}>={
 // Measured on the CI runner (alpha-focused-checks run 45648541265), the same for every persona and scope.
 requestPayrollOutstandingRefreshAction:{transactions:1,statements:5},
 readPayrollOutstandingRefreshAction:{transactions:1,statements:2},
 // The new-version path; the end-date-only path measured 3 transactions and 15 statements.
 saveFixedTransactionDialogAction:{transactions:3,statements:27},
 // 124a979e: 21 -> 22, the pending-mark INSERT ... SELECT every recalculation mark makes (ADR 0181 note, run 45770342651).
 removeFixedTransactionDialogAction:{transactions:3,statements:22},
};

type Persona='group'|'multi'|'single';
type Scope='all'|'one';
let b:Base,fixture:ScaleFixture,a:SessionContext;
/** The company-scoped administrator's company (a leaf operating company of the fixture), its 10 processed runs, every
 * processed run of the fixture (60 in six companies, plus those 10), and fresh employees of it for the pop-up. */
let companyId:string,companyRuns:string[],allRuns:string[],allowanceId:string;
const freshEmployments:string[]=[];
const measured:Record<string,{transactions:number;statements:number}>={};

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 // Before the fixture: its personas' entitlement snapshots are resolved from the tenant's rows when it is built.
 await setModule(b.tenantId,'payroll','active');
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 companyId=fixture.singleCompanyId;
 // Ten processed runs for the company-scoped administrator's company, written as the fixture writes its runs.
 companyRuns=[];
 for(let month=1;month<=10;month++){
  const period=`2026-${String(month).padStart(2,'0')}`;
  const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId,period,status:'open'} as never).returning({id:schema.payPeriod.id});
  const [run]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId,payPeriodId:pp.id,payPeriod:period,batchDate:`${period}-28`,status:'processed',employeeCount:10} as never)
   .returning({id:schema.payrollBatch.id});
  companyRuns.push(run.id);
 }
 allRuns=(await owner.db.select({id:schema.payrollBatch.id}).from(schema.payrollBatch)
  .where(and(eq(schema.payrollBatch.tenantId,b.tenantId),eq(schema.payrollBatch.status,'processed'))).orderBy(schema.payrollBatch.id)).map(r=>r.id);
 // Sixteen fictional employees of that company, so every pop-up measurement starts from its own untouched line.
 const people=await owner.db.insert(schema.person).values(Array.from({length:16},(_,i)=>({tenantId:b.tenantId,fullName:`Fictional Budget Person ${i}`,
  primaryEmail:`budget-${i}-${randomUUID().slice(0,8)}@fixture.test`}))).returning({id:schema.person.id});
 freshEmployments.push(...(await owner.db.insert(schema.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId,
  employeeCode:`FX-BUD-${String(i).padStart(2,'0')}`,hiredOn:'2022-01-01'}))).returning({id:schema.employment.id})).map(r=>r.id));
 await owner.db.execute(sql`analyze public.payroll_batch, public.pay_period, public.employment, public.person`);
 a=adminCtx(b);
 await seedPayComponentCatalog(a);
 allowanceId=(await listPayComponents(a)).find(c=>c.code==='ALLOWANCE')!.id;
},300_000);
afterAll(closeAll);

const personaCtx=(persona:Persona):SessionContext=>({...fixture.personas[persona]});
async function measure<T>(action:Action,label:string,persona:Persona,scope:Scope,work:()=>Promise<T>){
 // A fresh session object for every call, so nothing is reused from an earlier measurement by identity.
 state.session=personaCtx(persona);
 state.cookies=scope==='one'?{company_scope:companyId}:{};
 const observed=await observeStatements(work);
 const row={action,label,persona,scope,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
 console.log('ACTION_BUDGET '+JSON.stringify(row));
 const key=`${action}|${label}|${persona}|${scope}`;
 measured[key]={transactions:row.transactions,statements:row.statements};
 return {...observed,key};
}
function expectWithinBudget(action:Action,observed:{transactions:number;statements:unknown[];key:string}){
 expect(observed.transactions,`${observed.key} transactions`).toBeGreaterThan(0);
 expect(observed.transactions,`${observed.key} transactions`).toBeLessThanOrEqual(BUDGETS[action].transactions);
 expect(observed.statements.length,`${observed.key} statements`).toBeLessThanOrEqual(BUDGETS[action].statements);
}
/** No per-company or per-row loop: the wider measurement costs no more than the narrower one. */
function expectNoWiderCost(wide:{transactions:number;statements:unknown[];key:string},narrow:{transactions:number;statements:unknown[];key:string}){
 expect(wide.transactions,`${wide.key} vs ${narrow.key} transactions`).toBeLessThanOrEqual(narrow.transactions);
 expect(wide.statements.length,`${wide.key} vs ${narrow.key} statements`).toBeLessThanOrEqual(narrow.statements.length);
}

describe('a1a80747 r2: the Payroll Process list refresh actions at group scale',()=>{
 const group=()=>personaCtx('group');
 /** Forget every claim and stored answer (as the group administrator: the table forces row security). */
 const forgetAll=()=>withTenant(group(),tx=>tx.delete(schema.payrollRunOutstanding));
 /** Runs with a claim, read back as the group administrator. */
 const claimed=async()=>(await withTenant(group(),tx=>tx.select({id:schema.payrollRunOutstanding.batchId}).from(schema.payrollRunOutstanding)
  .where(isNotNull(schema.payrollRunOutstanding.requestedAt)))).map(r=>r.id).sort();

 it('claims and queues in one transaction whatever the number of runs or companies, and follows the job in one',async()=>{
  expect(allRuns.length).toBe(70);
  expect(companyRuns.length).toBe(10);
  const sorted=(ids:readonly string[])=>[...ids].sort();
  const cases:{persona:Persona;scope:Scope;ask:string[];expect:string[]}[]=[
   {persona:'group',scope:'all',ask:allRuns,expect:allRuns},
   {persona:'group',scope:'one',ask:companyRuns,expect:companyRuns},
   {persona:'multi',scope:'all',ask:allRuns,expect:allRuns},
   // The company-scoped administrator asked for every run claims only their company's: authorised first, in the same
   // one statement.
   {persona:'single',scope:'all',ask:allRuns,expect:companyRuns},
   {persona:'single',scope:'one',ask:companyRuns,expect:companyRuns},
  ];
  // One unmeasured call first: process-level caches (tenant facts the first transaction learns) fill once.
  await forgetAll();
  state.session=group();state.cookies={};
  expect((await requestPayrollOutstandingRefreshAction(allRuns)).jobId).toBeTruthy();
  const requests:Record<string,Awaited<ReturnType<typeof measure>>>={},reads:Record<string,Awaited<ReturnType<typeof measure>>>={};
  for(const c of cases){
   await forgetAll();
   const request=await measure('requestPayrollOutstandingRefreshAction','claim',c.persona,c.scope,()=>requestPayrollOutstandingRefreshAction(c.ask));
   const jobId=(request.result as {jobId:string|null}).jobId;
   expect(jobId,request.key).toBeTruthy();
   expect(await claimed(),request.key).toEqual(sorted(c.expect));
   expectWithinBudget('requestPayrollOutstandingRefreshAction',request);
   requests[`${c.persona}|${c.scope}`]=request;
   const read=await measure('readPayrollOutstandingRefreshAction','follow',c.persona,c.scope,()=>readPayrollOutstandingRefreshAction(jobId));
   expect(read.result,read.key).toBe('running');
   expectWithinBudget('readPayrollOutstandingRefreshAction',read);
   reads[`${c.persona}|${c.scope}`]=read;
  }
  for(const set of [requests,reads]){
   expectNoWiderCost(set['group|all'],set['group|one']);
   expectNoWiderCost(set['multi|all'],set['single|all']);
   expectNoWiderCost(set['single|all'],set['single|one']);
  }
  // Within the freshness window nothing is due: a repeated ask claims nothing and queues nothing.
  state.session=group();state.cookies={};
  expect(await requestPayrollOutstandingRefreshAction(companyRuns)).toEqual({jobId:null});
 },300_000);
});

describe('cc8bd87f: the Fixed Transaction pop-up save and remove at group scale',()=>{
 let next=0;
 /** A fresh, untouched open-ended allowance line of 500 from 1 January 2026 on its own fictional employee. */
 async function freshLine(){
  const employmentId=freshEmployments[next++];
  expect(employmentId,'enough fresh employees').toBeTruthy();
  const {id}=await setEmploymentPayComponent(a,{employmentId,componentId:allowanceId,amount:500,effectiveFrom:'2026-01-01',effectiveTo:null,
   remarks:'Fictional phone',prorateOverride:false});
  return {employmentId,id};
 }
 const form=(values:Record<string,string>)=>{const f=new FormData();for(const [k,v] of Object.entries(values))f.set(k,v);return f;};
 const saveForm=(line:{employmentId:string;id:string},over:Record<string,string>)=>form({employmentId:line.employmentId,id:line.id,effectiveFrom:'2026-01-01',
  amount:'500',remarks:'Fictional phone',effectiveTo:'',cycleTouched:'',payrollCycleId:'',...over});
 const live=(employmentId:string)=>owner.db.select({id:schema.employmentPayComponent.id,validFrom:schema.employmentPayComponent.validFrom,
  validTo:schema.employmentPayComponent.validTo,amount:schema.employmentPayComponent.amount}).from(schema.employmentPayComponent)
  .where(and(eq(schema.employmentPayComponent.employmentId,employmentId),eq(schema.employmentPayComponent.componentId,allowanceId),
   isNull(schema.employmentPayComponent.supersededAt))).orderBy(schema.employmentPayComponent.validFrom);
 const scopes:{persona:Persona;scope:Scope}[]=[{persona:'group',scope:'all'},{persona:'group',scope:'one'},{persona:'multi',scope:'all'},{persona:'single',scope:'all'}];

 it('ends a line in place, versions a line and removes a line in a bounded number of reads, for every scope',async()=>{
  // One unmeasured save first: process-level caches fill once.
  {const line=await freshLine();state.session=personaCtx('group');state.cookies={};
   expect(await saveFixedTransactionDialogAction(null,saveForm(line,{effectiveTo:'2026-12-31'}))).toEqual({ok:true,changed:true});}
  const ended:Record<string,Awaited<ReturnType<typeof measure>>>={},versioned:Record<string,Awaited<ReturnType<typeof measure>>>={},removed:Record<string,Awaited<ReturnType<typeof measure>>>={};
  for(const {persona,scope} of scopes){
   const k=`${persona}|${scope}`;
   // Only the end date changed: the same row is updated in place.
   const endLine=await freshLine();
   ended[k]=await measure('saveFixedTransactionDialogAction','end date only',persona,scope,
    ()=>saveFixedTransactionDialogAction(null,saveForm(endLine,{effectiveTo:'2026-12-31'})));
   expect(ended[k].result,ended[k].key).toEqual({ok:true,changed:true});
   expect(await live(endLine.employmentId)).toEqual([{id:endLine.id,validFrom:'2026-01-01',validTo:'2026-12-31',amount:'500.00'}]);
   expectWithinBudget('saveFixedTransactionDialogAction',ended[k]);
   // The amount from a later start: the line closes the day before and a new version starts.
   const versionLine=await freshLine();
   versioned[k]=await measure('saveFixedTransactionDialogAction','new version',persona,scope,
    ()=>saveFixedTransactionDialogAction(null,saveForm(versionLine,{amount:'600',effectiveFrom:'2026-03-01'})));
   expect(versioned[k].result,versioned[k].key).toEqual({ok:true,changed:true});
   expect((await live(versionLine.employmentId)).map(r=>[r.validFrom,r.validTo,r.amount])).toEqual([['2026-01-01','2026-02-28','500.00'],['2026-03-01',null,'600.00']]);
   expectWithinBudget('saveFixedTransactionDialogAction',versioned[k]);
   // Remove from inside the pop-up.
   const removeLine=await freshLine();
   removed[k]=await measure('removeFixedTransactionDialogAction','remove',persona,scope,
    ()=>removeFixedTransactionDialogAction(null,form({employmentId:removeLine.employmentId,id:removeLine.id})));
   expect(removed[k].result,removed[k].key).toEqual({ok:true,changed:true});
   expect(await live(removeLine.employmentId)).toEqual([]);
   expectWithinBudget('removeFixedTransactionDialogAction',removed[k]);
  }
  for(const set of [ended,versioned,removed]){
   // 71 companies and 1,000 employees in the scope check against one company's 24.
   expectNoWiderCost(set['group|all'],set['group|one']);
   // 71 company-by-company grants against one company's grant.
   expectNoWiderCost(set['multi|all'],set['single|all']);
  }
  // Outside the administrator's company scope nothing is read past the scope check and nothing is written.
  const outside=await owner.db.select({id:schema.employment.id}).from(schema.employment)
   .where(and(inArray(schema.employment.companyId,fixture.companyIds.filter(id=>id!==companyId)),isNull(schema.employment.terminatedOn))).limit(1);
  state.session=personaCtx('single');state.cookies={};
  expect(await saveFixedTransactionDialogAction(null,saveForm({employmentId:outside[0].id,id:randomUUID()},{effectiveTo:'2026-12-31'})))
   .toEqual({ok:false,error:'outOfScope',args:{}});
 },300_000);
});

afterAll(()=>{console.log('ACTION_BUDGET_SUMMARY '+JSON.stringify(measured));});
