/** AI Centre navigation speed (4 November 2026, owner: "the navigation between pages in AI centre, its still slow"): the
 * server work one AI Centre navigation costs, measured the same way before and after the speed fixes.
 *
 * What one navigation runs on the server: the destination page and every async server component it renders, plus, when
 * the navigation enters /assistant or /control-tower from another group, that group's layout (Next keeps a shared layout
 * on soft navigation, so a tab switch inside a group re-renders the page only). This file renders exactly that through the
 * real code on fictional data:
 *  - the session is the real resolver (lib/session.ts, the dev identity path the CI fixture can drive: the principal, the
 *    login block and the entitlement snapshot), selected by the dev identity cookie;
 *  - React's per-request `cache` is stood in by a memo that lives for one navigation, as it does in a real request (outside
 *    a React server request `cache` is a passthrough, which would overcount);
 *  - the element tree is walked the way the server renders it: async components are awaited, sibling subtrees run
 *    together, and elements passed as props to client components are rendered too. A component that needs a browser hook
 *    (useState and the like) is not called; its children and element props still are.
 * Every statement the app pool sends is counted (`client.options.debug`), with the transactions (BEGIN) among them, and
 * the wall time is taken per navigation. Not measured: the Next request pipeline, RSC serialisation, the network and the
 * browser (no browser lane in focused checks). The CI fixture is small, so staging reads are larger.
 *
 * Output: ai-centre-navigation-work.json in the evidence folder and one AIHR_AI_CENTRE_NAVIGATION_WORK line. The only
 * assertions are that every route rendered and that the counts are stable between runs (a measurement, not a budget). */
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isValidElement,type ReactNode} from 'react';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const nav=vi.hoisted(()=>({store:null as null|Map<unknown,Map<string,unknown>>,userId:''}));
// One navigation's request scope: `cache` memoises by function and argument identity until the navigation ends.
vi.mock('react',async importOriginal=>{
 const actual=await importOriginal<typeof import('react')>();
 const ids=new WeakMap<object,number>();let next=0;
 const keyOf=(args:unknown[])=>args.map(arg=>arg!==null&&(typeof arg==='object'||typeof arg==='function')?'o'+(ids.get(arg as object)??(ids.set(arg as object,++next),next)):typeof arg+':'+String(arg)).join('|');
 const cache=<A extends unknown[],R>(fn:(...args:A)=>R)=>(...args:A):R=>{
  if(!nav.store)return fn(...args);
  let memo=nav.store.get(fn);if(!memo)nav.store.set(fn,memo=new Map());
  const key=keyOf(args);if(!memo.has(key))memo.set(key,fn(...args));return memo.get(key) as R;
 };
 return {...actual,default:{...actual,cache},cache};
});
// The dev identity cookie selects the persona; no company-scope cookie means "all allowed", as for a fresh login.
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&nav.userId?{name,value:nav.userId}:undefined,getAll:()=>[],has:(name:string)=>name==='dev_user'&&!!nav.userId}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator,createFormatter}=await import('next-intl');
 const {enWithAiCentre}=await import('./helpers/ai-centre-messages');
 return {getTranslations:async(arg?:string|{namespace?:string})=>createTranslator({locale:'en',messages:enWithAiCentre as never,namespace:(typeof arg==='string'?arg:arg?.namespace) as never,onError:()=>undefined}),
  getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'}),getLocale:async()=>'en',getNow:async()=>new Date(),getTimeZone:async()=>'Asia/Kuala_Lumpur',getMessages:async()=>enWithAiCentre};
});
// Server components that use next-intl's synchronous hooks render as they do on the server.
vi.mock('next-intl',async importOriginal=>{
 const actual=await importOriginal<typeof import('next-intl')>();
 const {enWithAiCentre}=await import('./helpers/ai-centre-messages');
 return {...actual,useTranslations:(namespace?:string)=>actual.createTranslator({locale:'en',messages:enWithAiCentre as never,namespace:namespace as never,onError:()=>undefined}),
  useFormatter:()=>actual.createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'}),useLocale:()=>'en',useNow:()=>new Date(),useTimeZone:()=>'Asia/Kuala_Lumpur'};
});
import * as schema from '../db/schema';
import {client,type SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import AssistantLayout from '../app/assistant/layout';
import AssistantPage from '../app/assistant/page';
import ControlTowerLayout from '../app/control-tower/layout';
import LoopsPage from '../app/control-tower/loops/page';
import LoopPage from '../app/control-tower/loops/[loop]/page';
import PayrollCyclePage from '../app/control-tower/loops/payroll-cycle/page';
import SalaryLoopPage from '../app/control-tower/loops/payroll-cycle/salary/page';
import PayrollLoopSettingsPage from '../app/control-tower/loops/payroll-cycle/settings/page';
import AuditLoopPage from '../app/control-tower/loops/loop_payroll_audit/page';
import ExceptionsPage from '../app/control-tower/exceptions/page';
import ReadinessPage from '../app/control-tower/readiness/page';
import WorkersPage from '../app/control-tower/agents/features/page';
import SetupPage from '../app/control-tower/agents/page';
import SpendPage from '../app/control-tower/agents/allowances/page';
import PoliciesPage from '../app/policies/page';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

const RUNS=5,WARMUP=1;
type Persona='admin'|'employee';
type Page=(props:{searchParams:Promise<Record<string,string>>;params:Promise<Record<string,string>>})=>unknown;
type Route=Readonly<{id:string;personas:readonly Persona[];group:'assistant'|'control-tower'|'policies';page:Page;searchParams?:Record<string,string>;params?:Record<string,string>}>;
const page=(fn:unknown)=>fn as Page;
/** Every AI Centre tab and Operations/Loops/Administration page, as each persona may open it. AI Centre restructure (owner
 * decisions 26–29): Delegated jobs, the Overview, Proposed actions and Opportunities are guarded forward stubs now (not
 * pages to measure), and Insights is an administrator's view. */
const ROUTES:readonly Route[]=[
 {id:'/assistant (Ask)',personas:['admin','employee'],group:'assistant',page:page(AssistantPage)},
 {id:'/assistant?view=insights',personas:['admin'],group:'assistant',page:page(AssistantPage),searchParams:{view:'insights'}},
 {id:'/assistant?view=how',personas:['admin','employee'],group:'assistant',page:page(AssistantPage),searchParams:{view:'how'}},
 {id:'/assistant?view=privacy',personas:['admin'],group:'assistant',page:page(AssistantPage),searchParams:{view:'privacy'}},
 {id:'/assistant?view=tools',personas:['admin'],group:'assistant',page:page(AssistantPage),searchParams:{view:'tools'}},
 {id:'/policies',personas:['admin','employee'],group:'policies',page:page(PoliciesPage)},
 {id:'/control-tower/loops',personas:['admin'],group:'control-tower',page:page(LoopsPage)},
 {id:'/control-tower/loops/loop_payroll_inputs',personas:['admin'],group:'control-tower',page:page(LoopPage),params:{loop:'loop_payroll_inputs'}},
 {id:'/control-tower/loops/payroll-cycle',personas:['admin'],group:'control-tower',page:page(PayrollCyclePage)},
 {id:'/control-tower/loops/payroll-cycle/salary',personas:['admin'],group:'control-tower',page:page(SalaryLoopPage)},
 {id:'/control-tower/loops/payroll-cycle/settings',personas:['admin'],group:'control-tower',page:page(PayrollLoopSettingsPage)},
 {id:'/control-tower/loops/loop_payroll_audit',personas:['admin'],group:'control-tower',page:page(AuditLoopPage)},
 {id:'/control-tower/exceptions',personas:['admin'],group:'control-tower',page:page(ExceptionsPage)},
 {id:'/control-tower/readiness',personas:['admin'],group:'control-tower',page:page(ReadinessPage)},
 {id:'/control-tower/agents/features (Administration)',personas:['admin'],group:'control-tower',page:page(WorkersPage)},
 {id:'/control-tower/agents (Setup)',personas:['admin'],group:'control-tower',page:page(SetupPage)},
 {id:'/control-tower/agents/allowances (Spend)',personas:['admin'],group:'control-tower',page:page(SpendPage)},
];
const LAYOUTS={assistant:AssistantLayout as (props:{children:ReactNode})=>Promise<unknown>,'control-tower':ControlTowerLayout as (props:{children:ReactNode})=>Promise<unknown>};

/** Renders what the server renders for this element tree; returns the names of components that needed a browser hook. */
async function renderTree(node:unknown,skipped:Set<string>):Promise<void>{
 if(node===null||node===undefined||typeof node!=='object')return;
 if(Array.isArray(node)){await Promise.all(node.map(child=>renderTree(child,skipped)));return;}
 if(node instanceof Promise){await renderTree(await node,skipped);return;}
 if(!isValidElement(node))return;
 const {type,props}=node as {type:unknown;props:Record<string,unknown>};
 const elementProps=()=>Promise.all(Object.values(props??{}).filter(value=>Array.isArray(value)||isValidElement(value)||value instanceof Promise).map(value=>renderTree(value,skipped)));
 if(typeof type==='function'&&!(type as {prototype?:{isReactComponent?:unknown}}).prototype?.isReactComponent){
  let out:unknown;
  try{out=(type as (p:unknown)=>unknown)(props);}catch(error){if(isNextControlFlow(error))throw error;skipped.add((type as {name?:string}).name||'anonymous');await elementProps();return;}
  if(out instanceof Promise)out=await out;
  await renderTree(out,skipped);return;
 }
 if(typeof type==='object'&&type!==null&&'render' in type){skipped.add('forwardRef');await elementProps();return;}
 await elementProps();
}
const isNextControlFlow=(error:unknown)=>/^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test(String((error as {digest?:unknown})?.digest??''));

type Sample=Readonly<{statements:number;transactions:number;ms:number}>;
/** A statement's shape without its values, to find the same read issued twice in one navigation. */
const shapeOf=(text:string)=>text.replace(/\s+/g,' ').replace(/\$\d+/g,'$').trim().slice(0,160);
/** One navigation: a fresh request scope, every statement counted, the wall time taken. */
async function navigate(userId:string,run:()=>Promise<void>):Promise<Sample&{outcome:string;shapes:Map<string,number>}>{
 const sqlClient=client as unknown as {options:{debug?:unknown}};
 let statements=0,transactions=0;const shapes=new Map<string,number>();
 nav.store=new Map();nav.userId=userId;
 sqlClient.options.debug=(_id:number,text:string)=>{const s=text.trim().toLowerCase();if(/^begin/.test(s))transactions++;
  if(!/^(begin|commit|rollback|savepoint|release)/.test(s)){statements++;const shape=shapeOf(text);shapes.set(shape,(shapes.get(shape)??0)+1);}};
 const started=performance.now();let outcome='rendered';
 try{await run();}catch(error){const digest=String((error as {digest?:unknown})?.digest??'');if(!isNextControlFlow(error))throw error;outcome=digest.split(';').slice(0,3).join(';');}
 finally{sqlClient.options.debug=undefined;nav.store=null;}
 return {statements,transactions,ms:Math.round((performance.now()-started)*100)/100,outcome,shapes};
}

let b:Base;const people={} as Record<Persona,{ctx:SessionContext;userId:string}>;
async function hire(base:Base,name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:userId});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'17.25',effectiveOn:todayInKualaLumpur()});
 return{ctx:{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext,userId,employmentId:hired.employmentId};
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-navigation-work-passphrase-0123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-navigation-work-proposal-secret-0123456789abcdef');
 await resetDb();b=await seedBase();
 for(const code of ['assistant','claims','notifications','attendance','lifecycle','payroll'])await setModule(b.tenantId,code,'active');
 await seedEntitlement(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});
 const admin=await hire(b,'Fictional Navigation Administrator','hr_admin');people.admin=admin;
 people.employee=await hire(b,'Fictional Navigation Employee','employee');
 for(const name of ['Fictional Navigation Applicant One','Fictional Navigation Applicant Two']){
  const applicant=await hire(b,name,'employee');
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:applicant.employmentId,managerEmploymentId:admin.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
  await requestLeave(applicant.ctx,{employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:next.toISOString().slice(0,10),endDate:next.toISOString().slice(0,10),durationType:'full_day',reason:'Fictional navigation timing'});
 }
});

const median=(values:readonly number[])=>{if(!values.length)return 0;const sorted=[...values].sort((x,y)=>x-y),mid=(sorted.length-1)/2;return Math.round(((sorted[Math.floor(mid)]+sorted[Math.ceil(mid)])/2)*10)/10;};

describe('AI Centre navigation: server work per navigation',()=>{
 it('renders every AI Centre route through the real code and counts its statements, transactions and time',async()=>{
  const samples:Record<string,{page:Sample[];entering:Sample[];outcome:string;skipped:string[];repeated:Record<string,number>}>={};
  for(let run=0;run<RUNS;run++)for(const route of ROUTES)for(const persona of route.personas){
   const key=`${route.id} · ${persona}`,skipped=new Set<string>();
   const props=()=>({searchParams:Promise.resolve(route.searchParams??{}),params:Promise.resolve(route.params??{})});
   // A tab switch inside the group: the page alone. Entering the group: its layout and the page in one request, as Next
   // renders them on that navigation (one request scope, so the layout's and the page's session reads share its cache).
   const pageSample=await navigate(people[persona].userId,async()=>{await renderTree(await route.page(props()),skipped);});
   const layout=route.group==='policies'?null:LAYOUTS[route.group];
   const enteringSample=layout?await navigate(people[persona].userId,async()=>{await renderTree(await layout({children:null}),skipped);await renderTree(await route.page(props()),skipped);}):pageSample;
   const entry=samples[key]??={page:[],entering:[],outcome:pageSample.outcome,skipped:[],repeated:{}};
   entry.skipped=[...skipped].sort();
   entry.repeated=Object.fromEntries([...enteringSample.shapes].filter(([,n])=>n>1).sort((x,y)=>y[1]-x[1]).slice(0,12));
   if(run>=WARMUP){entry.page.push({statements:pageSample.statements,transactions:pageSample.transactions,ms:pageSample.ms});entry.entering.push({statements:enteringSample.statements,transactions:enteringSample.transactions,ms:enteringSample.ms});}
  }
  const summary=(list:readonly Sample[])=>({statements:median(list.map(s=>s.statements)),transactions:median(list.map(s=>s.transactions)),medianMs:median(list.map(s=>s.ms))});
  const report=Object.fromEntries(Object.entries(samples).map(([key,entry])=>[key,{outcome:entry.outcome,tabSwitch:summary(entry.page),enteringGroup:summary(entry.entering),
   statementRange:[Math.min(...entry.page.map(s=>s.statements)),Math.max(...entry.page.map(s=>s.statements))],repeatedStatementShapes:entry.repeated,browserHookComponentsNotCalled:entry.skipped}]));
  const dir=process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,'aihr-focused'):join(process.cwd(),'.review-evidence');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'ai-centre-navigation-work.json'),JSON.stringify({kind:'ai-centre.navigation-work',version:1,runs:RUNS,warmup:WARMUP,
   note:'Server work of one navigation on the CI fixture: the destination page and its async server components (tabSwitch), and the group layout with the page in one request when entering the group (enteringGroup). repeatedStatementShapes: the same statement shape sent more than once in one entering navigation. Real session resolver (dev identity path), one per-request cache per navigation. Request pipeline, RSC serialisation, network and browser are not included.',
   ...(process.env.GITHUB_RUN_ID?{runId:process.env.GITHUB_RUN_ID}:{}),...(process.env.AIHR_CI_HEAD?{sha:process.env.AIHR_CI_HEAD}:{}),report,samples},null,1));
  process.stdout.write('AIHR_AI_CENTRE_NAVIGATION_WORK '+JSON.stringify(Object.fromEntries(Object.entries(report).map(([key,row])=>[key,{q:row.tabSwitch.statements,tx:row.tabSwitch.transactions,ms:row.tabSwitch.medianMs,enterQ:row.enteringGroup.statements,enterMs:row.enteringGroup.medianMs,outcome:row.outcome}])))+'\n');
  // Every route rendered for every persona that may open it (an administrator page never redirected the administrator).
  for(const [key,row] of Object.entries(report)){
   expect(row.outcome,key).toBe('rendered');
   expect(row.tabSwitch.statements,key).toBeGreaterThan(0);
  }
  expect(Object.keys(report).length).toBe(ROUTES.reduce((n,route)=>n+route.personas.length,0));
 },600_000);
});
