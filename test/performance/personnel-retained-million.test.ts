/** Explicit focused benchmark only. Synthetic retained rows do not measure hiring/import throughput. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {personnelListPage} from '../../core/read';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';
const file='test/performance/personnel-retained-million.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.includes(file);
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('measures a native Personnel page with one million retained employees and exact scope/count/order',async()=>{
 const count=1_000_000,started=performance.now();
 const report:Record<string,unknown>={kind:'RETAINED_PERSONNEL_QUERY_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,pageRows:25,limitations:'Synthetic retained owner fixture, not canonical hiring/import throughput, HTTP/browser timing or 500-user capacity.'};
 expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-retained-million.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};
 const definitions:{signature:string;ddl:string}[]=[];
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
  for(const signature of ['app.own_home_dashboard_role(uuid)','app.visible_employment_ids()']){
   const [row]=await owner.client<{ddl:string}[]>`select pg_get_functiondef(${signature}::regprocedure) as ddl`;
   definitions.push({signature,ddl:row.ddl});
  }
  // Match the pending load candidate's qualified, disposable native guards; restore every DDL below.
  for(const name of ['home-role-reporting-guard.sql','visible-employment-company-guard.sql','visible-employment-plan-cache.sql'])await owner.client.unsafe(readFileSync(new URL('./'+name,import.meta.url),'utf8'));
  async function population(base:Base,size:number){
   return owner.client.begin(async tx=>{
    await tx`create temporary table perf_personnel_rows on commit drop as
     select n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id from generate_series(1,${size}::integer) as n`;
    await tx`insert into person(id,tenant_id,full_name,primary_email)
     select person_id,${base.tenantId}::uuid,'Fictional retained Personnel '||lpad(n::text,9,'0'),person_id::text||'@example.invalid'
     from perf_personnel_rows order by person_id`;
    phase('retained-people-loaded');
    await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
     select employment_id,${base.tenantId}::uuid,person_id,${base.companyId}::uuid,'PERF'||lpad(n::text,9,'0'),'2020-01-01'::date,
      case when n%5=0 then '2024-01-01'::date else null end from perf_personnel_rows order by employment_id`;
    phase('retained-employments-loaded');
    await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
     select ${base.tenantId}::uuid,employment_id,${base.companyId}::uuid,${base.deptA}::uuid,'full_time','2020-01-01'::date
     from perf_personnel_rows order by employment_id`;
    return (await tx<{employment_id:string}[]>`select employment_id from perf_personnel_rows order by n limit 25`).map(row=>row.employment_id);
   });
  }
  phase('retained-fixture-loading');const expected=await population(b,count);await population(foreign,1);
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  const [sizes]=await owner.client`select
   (select count(*)::int from person where tenant_id=${b.tenantId}::uuid) as people,
   (select count(*)::int from employment where tenant_id=${b.tenantId}::uuid) as employees,
   (select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid) as assignments`;
  expect(sizes.employees).toBe(count);expect(sizes.assignments).toBe(count);report.retainedCounts=sizes;
  report.settings=await owner.client`select current_setting('fsync') as fsync,current_setting('synchronous_commit') as synchronous_commit,current_setting('shared_buffers') as shared_buffers,current_setting('work_mem') as work_mem`;
  const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');
  phase('first-page-query');const queryStarted=performance.now(),companies=[b.companyId,foreign.companyId];
  const page=await personnelListPage(ctx,{companyIds:companies,limit:25,offset:0},{companyIds:companies});
  const elapsedMs=performance.now()-queryStarted;
  expect(page.total).toBe(count);expect(page.headcount.total).toBe(count);
  expect(Object.values(page.headcount.byStatus).reduce((sum,value)=>sum+Number(value??0),0)).toBe(count);
  expect(page.rows.map(row=>row.employmentId)).toEqual(expected);
  report.query={elapsedMs,targetMs:1000,targetMet:elapsedMs<1000,total:page.total,pageRows:page.rows.length,exactOrder:true,foreignScopeExcluded:true};
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{
  for(const {signature,ddl} of definitions.reverse()){
   await owner.client.unsafe(ddl);
   const [restored]=await owner.client<{ddl:string}[]>`select pg_get_functiondef(${signature}::regprocedure) as ddl`;
   expect(restored.ddl).toBe(ddl);
  }
  report.nativeFunctionsRestored=definitions.length===2;save();
 }
},480000);
