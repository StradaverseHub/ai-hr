/** ADR 0181 read budgets for board 4197534a (docs/architecture/FUTURE-BUILD-CONTRACT.md "Database read cost", rules 2
 * and 3; docs/SCALE-AND-RELEASE-RULES.md rules 2 and 3):
 *  - app/admin/attendance/settings/overtime-patterns/page.tsx — the Overtime Patterns listing (one set-based statement
 *    for the page of patterns, no per-row read) and the editor;
 *  - actions.ts previewOvertimeEligibilityAction, activateOvertimePatternAction, editOvertimePatternAction,
 *    deleteOvertimePatternAction and cancelOvertimeAssignmentAction.
 *
 * On the fictional 71-company / 1,000-employment group fixture (test/helpers/ai-centre-scale-fixture.ts), with a dated
 * assignment and a job grade on every employment, the page is rendered as one server render and each action is called
 * as the browser calls it (real modules; session, company switcher cookie and translations mocked at the Next.js edge
 * only), and their statements and transactions are counted with observeStatements. It proves:
 *  - budget: no measurement exceeds BUDGETS (transactions, statements). Budgets only go down; raising one needs an ADR
 *    note (ADR 0181 or ADR-0057);
 *  - no per-company or per-row loop: the listing over "All companies" costs no more than one company, and Preview over
 *    71 companies costs no more statements than over one;
 *  - one matching logic: Preview's complete matching set (every keyset page) equals the set the pure resolver used by
 *    the overtime calculation selects for the same employees, built from an independent owner query, for All companies
 *    and for one company; the count agrees and the set is nonempty.
 * Every measurement is printed as one `OT4197_BUDGET {json}` line. All names are invented. */
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,cookies:{} as Record<string,string>}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers({'x-pathname':'/admin/attendance/settings/overtime-patterns'}),
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
import OvertimePatternsPage from '../app/admin/attendance/settings/overtime-patterns/page';
import {previewOvertimeEligibilityAction,activateOvertimePatternAction,editOvertimePatternAction,deleteOvertimePatternAction,cancelOvertimeAssignmentAction} from '../app/admin/attendance/settings/overtime-patterns/actions';
import {saveOvertimePatternDraft,activateOvertimePatternWithEligibility,overtimePlannedCandidates,type OvertimeEligibilityPreview} from '../packs/attendance/service';
import {resolveOvertimePattern} from '../lib/overtime-pattern-evaluate';
import {blankOvertimePattern} from '../lib/overtime-pattern-editor-scope';
import {overtimeSettingsToDefinition} from '../lib/overtime-pattern-settings';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {OvertimeFacts} from '../lib/overtime-pattern-model';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

type Key='page'|'previewOvertimeEligibilityAction'|'activateOvertimePatternAction'|'editOvertimePatternAction'|'deleteOvertimePatternAction'|'cancelOvertimeAssignmentAction';
/** Recorded budgets: the largest (transactions, statements) over every persona and scope below. Budgets only go down;
 * raising one needs an ADR note. First values are the ceilings this change was built to; the measured values from the
 * CI runner are printed (OT4197_BUDGET) and recorded here once measured. */
const BUDGETS:Record<Key,{transactions:number;statements:number}>={
 page:{transactions:12,statements:60},
 previewOvertimeEligibilityAction:{transactions:2,statements:16},
 activateOvertimePatternAction:{transactions:2,statements:60},
 editOvertimePatternAction:{transactions:2,statements:30},
 deleteOvertimePatternAction:{transactions:2,statements:24},
 cancelOvertimeAssignmentAction:{transactions:2,statements:24},
};
type Persona='group'|'multi'|'single';
type Scope='all'|'one';
let b:Base,fixture:ScaleFixture,companyId:string,earningId:string,gradeA:string,gradeB:string;
const measured:Record<string,{transactions:number;statements:number}>={};
const today=()=>todayInKualaLumpur();
const plus=(n:number)=>{const d=new Date(today()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');
 fixture=await buildScaleFixture(b,{employments:1000,events:200});
 companyId=fixture.singleCompanyId;
 const grades=await owner.db.insert(schema.jobGrade).values([{tenantId:b.tenantId,code:'FX-G1',name:'Fictional Grade One'},{tenantId:b.tenantId,code:'FX-G2',name:'Fictional Grade Two'}] as never).returning({id:schema.jobGrade.id});
 gradeA=grades[0].id;gradeB=grades[1].id;
 // Every fixture employment gets a job grade (two in three on Grade One) and a dated assignment in its company.
 await owner.db.execute(sql`update employment set grade_id=case when (('x'||substr(md5(id::text),1,6))::bit(24)::int)%3=0 then ${gradeB}::uuid else ${gradeA}::uuid end where tenant_id=${b.tenantId}::uuid`);
 await owner.db.execute(sql`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
  select e.tenant_id,e.id,e.company_id,${b.deptA}::uuid,(case when (('x'||substr(md5(e.id::text),7,6))::bit(24)::int)%4=0 then 'contract' else 'full_time' end)::employment_type,'2022-01-01'
  from employment e where e.tenant_id=${b.tenantId}::uuid and not exists(select 1 from assignment a where a.employment_id=e.id and a.superseded_at is null)`);
 const [earning]=await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'OT-FX',name:'Fictional Overtime Pay',kind:'allowance'}).returning();earningId=earning.id;
 await owner.db.execute(sql`analyze public.employment, public.assignment, public.person, public.company, public.job_grade`);
},300_000);
afterAll(async()=>{console.log('OT4197_BUDGET_SUMMARY '+JSON.stringify(measured));await closeAll();});

const personaCtx=(persona:Persona):SessionContext=>({...fixture.personas[persona]});
async function measure<T>(key:Key,label:string,persona:Persona,scope:Scope,work:()=>Promise<T>){
 state.session=personaCtx(persona);
 state.cookies=scope==='one'?{company_scope:companyId}:{};
 const observed=await observeStatements(()=>work().catch((error:unknown)=>{
  const digest=(error as {digest?:unknown})?.digest;if(typeof digest==='string'&&digest.startsWith('NEXT_'))return {redirect:digest} as T;throw error;}));
 const row={key,label,persona,scope,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
 console.log('OT4197_BUDGET '+JSON.stringify(row));
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
const definition=()=>overtimeSettingsToDefinition(blankOvertimePattern({code:'MYR',minorScale:2}),{rows:[{from:'0:00',to:'2:00',rate:'1.5',restRate:'2',phRate:'3',rounding:'down',roundTo:'0:15'},{from:'2:00',to:'',rate:'2',restRate:'',phRate:'3',rounding:'none',roundTo:''}],monthlyHours:'208',earningItemId:earningId});
const planned=(extra:Record<string,unknown>={})=>({v:1,criteria:{gradeId:[gradeA],employmentType:['full_time']},employmentIds:[],priority:100,from:today(),...extra});
async function draft(code:string,companyIds:readonly string[],extra:Record<string,unknown>={}){
 return saveOvertimePatternDraft(personaCtx('group'),{draft:{code,creationCompanyId:b.companyId,companyIds:[...companyIds],name:`${code} fictional`,description:'',definition:definition(),plannedEligibility:planned(extra)}});
}
/** Independent expectation: the canonical facts of each employment on today's date (owner query, no product SQL),
 * run through the same pure resolver as the calculation. */
async function resolverSet(companyIds:readonly string[],p:ReturnType<typeof planned>){
 const rows=await owner.db.select({id:schema.employment.id,companyId:schema.employment.companyId,gradeId:schema.employment.gradeId,terminatedOn:schema.employment.terminatedOn,hiredOn:schema.employment.hiredOn,
  assignmentCompany:schema.assignment.companyId,departmentId:schema.assignment.departmentId,businessUnitId:schema.assignment.businessUnitId,positionId:schema.assignment.positionId,employmentType:schema.assignment.employmentType,validFrom:schema.assignment.validFrom,validTo:schema.assignment.validTo})
  .from(schema.employment).innerJoin(schema.assignment,and(eq(schema.assignment.employmentId,schema.employment.id),isNull(schema.assignment.supersededAt)))
  .where(and(eq(schema.employment.tenantId,b.tenantId),inArray(schema.employment.companyId,[...companyIds])));
 const day=today(),candidates=overtimePlannedCandidates(p as never,[...companyIds].sort(),day),out=new Set<string>();
 for(const row of rows){
  if(row.validFrom>day||row.validTo&&row.validTo<=day||row.terminatedOn&&row.terminatedOn<day||row.hiredOn&&row.hiredOn>day)continue;
  const known=(value:string|null)=>({state:'known' as const,value,provenance:{owner:'personnel' as const,reference:'independent',asOf:day,basis:'recorded' as const}});
  const facts:OvertimeFacts={companyId:known(row.assignmentCompany??row.companyId),employmentId:known(row.id),departmentId:known(row.departmentId),businessUnitId:known(row.businessUnitId),positionId:known(row.positionId),employmentType:known(row.employmentType),gradeId:known(row.gradeId)};
  if(resolveOvertimePattern(candidates,facts,day).status==='selected')out.add(row.id);
 }
 return out;
}
async function previewAll(input:{companyIds:string[];plannedEligibility:unknown}){
 const ids:string[]=[];let cursor:string|undefined,first:OvertimeEligibilityPreview|null=null;
 for(let guard=0;guard<100;guard++){
  const result=await previewOvertimeEligibilityAction({...input,cursor});
  if(!result.ok)throw new Error(JSON.stringify(result));
  first??=result.value;ids.push(...result.value.rows.map(row=>row.employmentId));
  if(!result.value.nextCursor)break;cursor=result.value.nextCursor;
 }
 return {ids,first:first!};
}

describe('4197534a: Overtime Patterns at group scale',()=>{
 it('previews with one matching logic and a cost that does not grow with the number of companies',async()=>{
  state.session=personaCtx('group');state.cookies={};
  const all=[...fixture.companyIds],one=[companyId];
  // One unmeasured preview first: process-level caches fill once.
  await previewOvertimeEligibilityAction({companyIds:all,plannedEligibility:planned()});
  const wide=await measure('previewOvertimeEligibilityAction','all',  'group','all',()=>previewOvertimeEligibilityAction({companyIds:all,plannedEligibility:planned()}));
  const narrow=await measure('previewOvertimeEligibilityAction','one','group','all',()=>previewOvertimeEligibilityAction({companyIds:one,plannedEligibility:planned()}));
  noWider(wide,narrow);
  await measure('previewOvertimeEligibilityAction','all','multi','all',()=>previewOvertimeEligibilityAction({companyIds:all,plannedEligibility:planned()}));
  for(const companies of [all,one]){
   state.session=personaCtx('group');state.cookies={};
   const expected=await resolverSet(companies,planned());
   const {ids,first}=await previewAll({companyIds:companies,plannedEligibility:planned()});
   expect(expected.size,`${companies.length} companies`).toBeGreaterThan(0);
   expect(new Set(ids).size).toBe(ids.length);
   expect([...ids].sort()).toEqual([...expected].sort());
   expect(first.matched).toEqual({count:expected.size,capped:false});
  }
  // The single-company administrator cannot preview another company.
  state.session=personaCtx('single');state.cookies={};
  expect(await previewOvertimeEligibilityAction({companyIds:all,plannedEligibility:planned()})).toMatchObject({ok:false,code:'permission'});
 },300_000);

 it('lists patterns in one bounded read whatever the company scope, and renders the editor',async()=>{
  const shared=await draft('FX-ALL',fixture.companyIds);
  for(let i=0;i<12;i++)await draft(`FX-${String(i).padStart(2,'0')}`,[fixture.companyIds[i]]);
  const render=(persona:Persona,scope:Scope,sp:Record<string,string>={})=>measure('page',Object.keys(sp).join('+')||'list',persona,scope,
   ()=>serverTreeSnapshot(createElement(OvertimePatternsPage,{searchParams:Promise.resolve(sp)})));
  state.session=personaCtx('group');state.cookies={};await serverTreeSnapshot(createElement(OvertimePatternsPage,{searchParams:Promise.resolve({})}));
  const groupAll=await render('group','all'),groupOne=await render('group','one'),multiAll=await render('multi','all'),single=await render('single','all');
  noWider(groupAll,groupOne);noWider(multiAll,single);
  const text=JSON.stringify(groupAll.result);
  expect(text).toContain('FX-ALL');expect(text).toContain('FX-11');
  await render('group','all',{pattern:shared.patternId,version:shared.versionId});
  await render('group','all',{pattern:shared.patternId,version:shared.versionId,mode:'view'});
 },300_000);

 it('activates, edits, cancels and deletes in a bounded number of reads',async()=>{
  const live=await draft('FX-LIVE',fixture.companyIds,{priority:300});
  const activated=await measure('activateOvertimePatternAction','activate','group','all',()=>activateOvertimePatternAction({patternId:live.patternId,versionId:live.versionId,expectedRevision:live.revision}));
  expect(activated.result).toMatchObject({ok:true,value:{versionId:live.versionId,effectiveFrom:today()}});
  const [pattern]=await owner.db.select({revision:schema.overtimePattern.revision}).from(schema.overtimePattern).where(eq(schema.overtimePattern.id,live.patternId));
  const edited=await measure('editOvertimePatternAction','fork','group','all',()=>editOvertimePatternAction({versionId:live.versionId,expectedPatternRevision:pattern.revision}));
  expect(edited.result).toMatchObject({ok:true});
  const refused=await measure('deleteOvertimePatternAction','refused','group','all',async()=>{
   const [row]=await owner.db.select({revision:schema.overtimePattern.revision}).from(schema.overtimePattern).where(eq(schema.overtimePattern.id,live.patternId));
   return deleteOvertimePatternAction({patternId:live.patternId,expectedRevision:row.revision});
  });
  expect(refused.result).toMatchObject({ok:false,code:'conflict',reason:'deleteBlocked'});
  const unused=await draft(`FX-DEL-${randomUUID().slice(0,4)}`,fixture.companyIds);
  const [unusedRow]=await owner.db.select({revision:schema.overtimePattern.revision}).from(schema.overtimePattern).where(eq(schema.overtimePattern.id,unused.patternId));
  const deleted=await measure('deleteOvertimePatternAction','archive','group','all',()=>deleteOvertimePatternAction({patternId:unused.patternId,expectedRevision:unusedRow.revision}));
  expect(deleted.result).toMatchObject({ok:true});
  const later=await draft('FX-LATER',fixture.companyIds,{priority:301,from:plus(2)});
  await activateOvertimePatternWithEligibility(personaCtx('group'),{versionId:later.versionId,expectedRevision:later.revision});
  const [assignment]=await owner.db.select().from(schema.overtimePatternAssignment).where(eq(schema.overtimePatternAssignment.versionId,later.versionId));
  const cancelled=await measure('cancelOvertimeAssignmentAction','cancel','group','all',()=>cancelOvertimeAssignmentAction({assignmentId:assignment.id,expectedRevision:assignment.revision,reason:'Fictional change of plan'}));
  expect(cancelled.result).toMatchObject({ok:true});
 },300_000);
});
