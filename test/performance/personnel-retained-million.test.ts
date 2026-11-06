import {randomUUID} from 'node:crypto';
/** Explicit focused benchmark only. Synthetic retained rows do not measure hiring/import throughput. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {personnelListPage} from '../../core/read';
import {deriveEmploymentStatus} from '../../core/employment-status';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';
const file='test/performance/personnel-retained-million.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&process.env.AIHR_RETAINED_PERSONNEL_MILLION==='true'&&Array.isArray(selected)&&selected.length===1&&selected.includes(file);
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('measures a native Personnel page with one million retained employees and exact scope/count/order',async()=>{
 const count=1_000_000,started=performance.now();
 const report:Record<string,unknown>={kind:'RETAINED_PERSONNEL_QUERY_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,pageRows:25,fixtureBatchRows:5_000,fixturePreparationBudgetMs:2_700_000,queryTargetMs:1000,fixtureUuidLocality:'random v4 namespace per batch with ordered suffix; domains use distinct namespaces',limitations:'Synthetic retained owner fixture, not canonical hiring/import throughput, HTTP/browser timing or 500-user capacity.'};
 expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-retained-million.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};
 const triggers:{name:string;ddl:string}[]=[];
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
  const existing=await owner.client<{name:string;ddl:string}[]>`select c.relname as name,pg_get_triggerdef(t.oid)as ddl from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.oid=any(array['public.person'::regclass,'public.employment'::regclass]) and t.tgname='assessment_reminder_touch' order by c.relname`;
  expect(existing.map(row=>row.name)).toEqual(['employment','person']);triggers.push(...existing);
  // Separately measured fixture optimization: exact per-row epoch increments are grouped
  // per statement. All other row triggers, FK checks and native constraints remain enabled.
  await owner.client.unsafe(readFileSync(new URL('./personnel-fixture-reminder-batch.sql',import.meta.url),'utf8'));
  report.fixtureCounterGuard='exact statement aggregation, independently verified under restricted owner in41785596183';
  async function population(base:Base,size:number){
   const expected:string[]=[],last:string[]=[];
   // Bound deferred-trigger/FK queues and transaction memory. Every row retains every native check.
   for(let offset=0;offset<size;offset+=5_000){
    const end=Math.min(size,offset+5_000),personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
    expect(performance.now()-started,'bounded retained fixture preparation').toBeLessThan(2_700_000);
    report.fixtureCurrentBatch={from:offset+1,to:end};
    await owner.client.begin(async tx=>{
     phase('retained-fixture-person');
     await tx`insert into person(id,tenant_id,full_name,primary_email)
      select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${base.tenantId}::uuid,
       'Fictional retained Personnel '||lpad(n::text,9,'0'),(${personPrefix}||lpad(n::text,12,'0'))||'@example.invalid'
      from generate_series(${offset+1}::integer,${end}::integer) as n`;
     phase('retained-fixture-employment');
     await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
      select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${base.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,
       ${base.companyId}::uuid,'PERF'||lpad(n::text,9,'0'),'2020-01-01'::date,
       case when n%5=0 then '2024-01-01'::date else null end from generate_series(${offset+1}::integer,${end}::integer) as n`;
     phase('retained-fixture-assignment');
     await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
      select ${base.tenantId}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${base.companyId}::uuid,
       ${base.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(${offset+1}::integer,${end}::integer) as n`;
    });
    if(offset===0)for(let n=1;n<=Math.min(size,25);n++)expected.push(employmentPrefix+String(n).padStart(12,'0'));
    if(end===size)for(let n=Math.max(1,size-24);n<=size;n++)last.push(employmentPrefix+String(n).padStart(12,'0'));
    if(base.tenantId===b.tenantId)report.committedFixtureEmployees=end;else report.committedForeignEmployees=end;phase('retained-fixture-batch-committed');
   }
   return {first:expected,last};
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
  report.fixturePreparationMs=performance.now()-started;const companies=[b.companyId,foreign.companyId];
  const queries:{mode:string;elapsedMs:number;targetMs:number;targetMet:boolean;total:number;pageRows:number;exactOrder:boolean;foreignScopeExcluded:boolean}[]=[];
  const today=todayInKualaLumpur(),activeStatus=deriveEmploymentStatus({},today),endedStatus=deriveEmploymentStatus({terminatedOn:'2024-01-01'},today);
  const allStatuses:Record<string,number>={};allStatuses[activeStatus]=(allStatuses[activeStatus]??0)+count-count/5;allStatuses[endedStatus]=(allStatuses[endedStatus]??0)+count/5;
  for(const mode of ['initial','selective-search','deep-page']){
   phase(mode+'-query');const q=mode==='selective-search'?'PERF'+String(count).padStart(9,'0'):undefined;
   const offset=mode==='deep-page'?count-25:0,queryStarted=performance.now();
   const page=await personnelListPage(ctx,{companyIds:companies,q,limit:25,offset},{companyIds:companies,q});
   const elapsedMs=performance.now()-queryStarted,total=q?1:count;
   expect(page.total).toBe(total);expect(page.headcount.total).toBe(total);
   expect(page.headcount.byStatus).toEqual(q?{[endedStatus]:1}:allStatuses);
   expect(page.rows.map(row=>row.employmentId)).toEqual(q?[expected.last.at(-1)!]:offset?expected.last:expected.first);
   queries.push({mode,elapsedMs,targetMs:1000,targetMet:elapsedMs<1000,total:page.total,pageRows:page.rows.length,exactOrder:true,foreignScopeExcluded:true});
   report.queries=queries;report.query=queries[0];save();
  }
  phase('queries-measured');expect(queries.every(query=>query.targetMet),'Each one-million retained Personnel page/search/deep query under1000ms').toBe(true);phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{
  for(const trigger of triggers){
   for(const event of ['insert','update','delete'])await owner.client.unsafe('DROP TRIGGER IF EXISTS performance_fixture_reminder_'+event+' ON public.'+trigger.name);
   await owner.client.unsafe('DROP TRIGGER IF EXISTS assessment_reminder_touch ON public.'+trigger.name);await owner.client.unsafe(trigger.ddl);
   const [restored]=await owner.client`select pg_get_triggerdef(oid)as ddl from pg_trigger where tgrelid=${'public.'+trigger.name}::regclass and tgname='assessment_reminder_touch'`;
   expect(restored.ddl).toBe(trigger.ddl);
  }
  await owner.client.unsafe('DROP FUNCTION IF EXISTS app.performance_fixture_reminder_batch()');
  report.fixtureTriggersRestored=triggers.length===2;save();
 }
},3000000);
