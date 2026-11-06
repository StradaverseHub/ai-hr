/** Disposable hosted qualification for the actual Personnel overview reader. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {hireEmployee,setEmploymentAssignment} from '../../core/org';
import {createPersonnelPrivateSearch} from '../../core/personnel-private-search';
import {readPersonnelOverview} from '../../core/read';
import {withTenant} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {pgSqlState} from '../../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import {seedPersonnelCorrectionFixture,seedPersonnelNativeFixture} from './personnel-native-fixture';
import {provePersonnelSingleAssignmentConstraint} from './personnel-dated-tags-prototype';

const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&
 selected[0]==='test/performance/personnel-narrow-production.test.ts';
beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('preserves the real overview rows, facets, scope, dated assignment and unsupported filter paths',async()=>{
 await resetDb();
 const base=await seedBase();
 const foreign=await seedBase();
 const ctx={...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]};
 const hire=(name:string,employeeCode:string)=>hireEmployee(ctx,{
  person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,
  departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01',employeeCode,
 });
 const first=await hire('Fictional first','A-01');
 const second=await hire('Fictional second','B-02');
 await setEmploymentAssignment(ctx,{employmentId:second.employmentId,effectiveDate:'2099-01-01',departmentId:base.deptB});
 const scope={companyIds:[base.companyId],limit:25,offset:0};
 const privateSearch=await createPersonnelPrivateSearch(ctx,{text:'Fictional second',companyIds:scope.companyIds});
 const mode={hostedNarrowProbe:true} as const;
 const normalize=(data:Awaited<ReturnType<typeof readPersonnelOverview>>)=>({
  ...data,
  organisationChoices:{...data.organisationChoices,rows:data.organisationChoices.rows
   .map(row=>JSON.stringify(row)).sort()},
 });
 const fallbackCases=[
  {name:'private search',input:{...scope,privateSearch},expected:[second.employmentId]},
  {name:'quality',input:{...scope,qualityFlags:['missing_business_unit' as const]},expected:[first.employmentId,second.employmentId]},
  {name:'foreign requested scope',input:{...scope,companyIds:[base.companyId,foreign.companyId]},expected:[first.employmentId,second.employmentId]},
  {name:'unbounded page',input:{...scope,limit:2000},expected:[first.employmentId,second.employmentId]},
 ];
 // Prove these paths use only the old owner by exercising them before either draft function exists.
 for(const {input,expected} of fallbackCases){
  const exact=await readPersonnelOverview(ctx,input,{});
  expect(exact.employees.rows.map(row=>row.employmentId)).toEqual(expected);
  expect(normalize(await readPersonnelOverview(ctx,input,{},mode))).toEqual(normalize(exact));
 }

 await expect(readPersonnelOverview(ctx,scope,{},mode)).rejects.toThrow();
 const assignmentConstraint=await provePersonnelSingleAssignmentConstraint();
 await owner.client.unsafe(readFileSync(new URL('./personnel-narrow-production-draft.sql',import.meta.url),'utf8'));
 try{
  const cases=[
   {name:'first page',input:scope,expected:[first.employmentId,second.employmentId],total:2},
   {name:'literal wildcard and independent facets',input:{...scope,q:'B-02',sort:'company' as const},expected:[second.employmentId],total:1},
   {name:'second page',input:{...scope,limit:1,offset:1},expected:[second.employmentId],total:2},
   {name:'empty page',input:{...scope,offset:10},expected:[],total:2},
  ];
  for(const {input,expected,total} of cases){
   const exact=await readPersonnelOverview(ctx,input,{});
   const narrow=await readPersonnelOverview(ctx,input,{},mode);
   expect(normalize(narrow)).toEqual(normalize(exact));
   expect(narrow.employees.rows.map(row=>row.employmentId)).toEqual(expected);
   expect(narrow.employees.total).toBe(total);
   expect(narrow.headcount.total).toBe(2);
   expect(narrow.employees.rows.every(row=>row.departmentId===base.deptA)).toBe(true);
  }
  const denied=await withTenant(ctx,tx=>tx.execute(sql`
   select value from app.personnel_overview_narrow_rows(${todayInKualaLumpur()}::date, array[${foreign.companyId}::uuid]) r(value)
  `));
  expect(denied).toHaveLength(0);
  const emptySubjects=await withTenant(ctx,tx=>tx.execute(sql`
   select value from app.personnel_overview_page_rows(${todayInKualaLumpur()}::date, array[${base.companyId}::uuid], null) r(value)
  `));
  expect(emptySubjects).toHaveLength(0);

  const corrected=await seedPersonnelCorrectionFixture();
  for(const [day,companyId] of [[corrected.hiredOn,corrected.beforeCompanyId],[todayInKualaLumpur(),corrected.afterCompanyId]]){
   const companyIds=sql`array[${sql.join(corrected.companies.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
   const [parity]=await withTenant(corrected.ctx,tx=>tx.execute<{summaryCompany:string;detailCompany:string;detailsEqual:boolean}>(sql`
    select (select summary.value->>'companyId'
      from app.personnel_overview_narrow_rows(${day}::date,${companyIds}) summary(value)
      where summary.value->>'employmentId'=${corrected.employmentId}::text) as "summaryCompany",
      bounded.value->>'companyId' as "detailCompany", bounded.value=exact.value as "detailsEqual"
    from app.personnel_overview_page_rows(${day}::date,${companyIds},array[${corrected.employmentId}::uuid]) bounded(value)
    join app.personnel_filter_rows(${day}::date,${companyIds}) exact(value)
      on exact.value->>'employmentId'=bounded.value->>'employmentId'
   `));
   expect(parity).toEqual({summaryCompany:companyId,detailCompany:companyId,detailsEqual:true});
  }
  writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-narrow-production-parity.json'),JSON.stringify({
   kind:'PERSONNEL_NARROW_APPLICATION_PARITY_COMPONENT_ONLY',releaseEligible:false,assignmentConstraint,
   exactOverviewCases:cases.map(({name})=>name),exactFallbackCases:fallbackCases.map(({name})=>name),
   foreignScopeDenied:true,emptySubjectsDenied:true,datedCorrectionParity:true,
  },null,2));
 }finally{
  await owner.client.unsafe('drop function app.personnel_overview_narrow_rows(date,uuid[]), app.personnel_overview_page_rows(date,uuid[],uuid[])');
 }
},60000);

it.skipIf(!requested)('times the real Personnel overview at fifty thousand employees', async () => {
 const count = 50_000;
 const started = performance.now();
 const report: Record<string, unknown> = {
  kind:'PERSONNEL_REAL_OVERVIEW_50K_COMPONENT_ONLY',
  releaseEligible:false,
  targetEmployees:count,
  limitations:'Single synthetic tenant and caller. Measures the real application reader, without browser or concurrent traffic.',
 };
 const save = () => writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-real-overview-50k.json'),JSON.stringify(report,null,2));
 const phase = (name:string) => { report.phase=name; report.elapsedMs=performance.now()-started; save(); };
 const {b,ctx,expectedFirst,expectedLast} = await seedPersonnelNativeFixture(count,report,phase,save);
 report.assignmentConstraint = await provePersonnelSingleAssignmentConstraint();
 const base = {companyIds:[b.companyId],limit:25,offset:0};
 const cases = [
  {name:'initial',input:base,ids:expectedFirst,total:count},
  {name:'selective-search',input:{...base,q:'PERF000050000'},ids:expectedLast.slice(-1),total:1},
  {name:'deep-page',input:{...base,offset:count-25},ids:expectedLast,total:count},
 ];
 const results: {name:string;reader:string;ms:number;status:string;rows?:number}[] = [];
 report.results = results;
 await owner.client.unsafe(readFileSync(new URL('./personnel-narrow-production-draft.sql',import.meta.url),'utf8'));
 try {
  for (const {name,input,ids,total} of cases) {
   let baseline: Awaited<ReturnType<typeof readPersonnelOverview>> | undefined;
   for (const reader of ['existing','narrow'] as const) {
    phase(name+'-'+reader);
    const begin = performance.now();
    let overview;
    try {
     overview = await readPersonnelOverview(ctx,input,{},reader==='narrow'?{hostedNarrowProbe:true}:undefined);
    } catch (error) {
     if (reader!=='existing' || pgSqlState(error)!=='57014') throw error;
     results.push({name,reader,ms:performance.now()-begin,status:'statement-timeout'});
     save();
     continue;
    }
    const ms = performance.now()-begin;
    expect(overview.employees.rows.map(row=>row.employmentId)).toEqual(ids);
    expect(overview.employees.total).toBe(total);
    if (reader==='existing') baseline=overview;
    else if (baseline) expect(overview).toEqual(baseline);
    results.push({name,reader,ms,status:'completed',rows:overview.employees.rows.length});
    save();
   }
  }
  phase('completed');
 } finally {
  await owner.client.unsafe('drop function app.personnel_overview_narrow_rows(date,uuid[]), app.personnel_overview_page_rows(date,uuid[],uuid[])');
 }
},600000);
