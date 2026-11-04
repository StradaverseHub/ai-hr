import {randomUUID} from 'node:crypto';
/** Explicit focused benchmark only. Synthetic retained rows do not measure hiring/import throughput. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {personnelListPage,personnelListPageSql} from '../../core/read';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
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
  const observedPages=new Map<string,Awaited<ReturnType<typeof personnelListPage>>>();
  for(const mode of ['initial','selective-search','deep-page']){
   phase(mode+'-query');const q=mode==='selective-search'?'PERF'+String(count).padStart(9,'0'):undefined;
   const offset=mode==='deep-page'?count-25:0,queryStarted=performance.now();
   const page=await personnelListPage(ctx,{companyIds:companies,q,limit:25,offset},{companyIds:companies,q});
   const elapsedMs=performance.now()-queryStarted,total=q?1:count;
   expect(page.total).toBe(total);expect(page.headcount.total).toBe(total);
   expect(page.headcount.byStatus).toEqual(q?{[endedStatus]:1}:allStatuses);
   expect(page.rows.map(row=>row.employmentId)).toEqual(q?[expected.last.at(-1)!]:offset?expected.last:expected.first);
   observedPages.set(mode,page);
   queries.push({mode,elapsedMs,targetMs:1000,targetMet:elapsedMs<1000,total:page.total,pageRows:page.rows.length,exactOrder:true,foreignScopeExcluded:true});
   report.queries=queries;report.query=queries[0];save();
  }
  // Amortize the expensive retained fixture across reversible plan comparisons. The current app's
  // strict measurements above remain the acceptance signal; alternative queries cannot turn it green.
  const view='app.performance_personnel_million_facts',tenantView='app.performance_personnel_million_tenant_facts';
  const [absence]=await owner.client`select to_regclass(${view})as relation`;expect(absence.relation).toBeNull();
  const [factsOwner]=await owner.client<{body:string;owner:string;columns:string[];ddl:string;acl:string|null}[]>`
   select prosrc as body,proowner::regrole::text as owner,proargnames as columns,pg_get_functiondef(oid)as ddl,proacl::text as acl
   from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
  expect(factsOwner.columns).toHaveLength(16);
  const tenantKeys=[
   ['SELECT c.id FROM public.company c','SELECT c.id,c.tenant_id FROM public.company c'],
   ['JOIN permitted allowed ON allowed.id=e.company_id','JOIN permitted allowed ON allowed.id=e.company_id AND allowed.tenant_id=e.tenant_id'],
   ['WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL','WHERE e.voided_at IS NULL'],
  ];
  let tenantBody=factsOwner.body;
  for(const [before,after]of tenantKeys){expect(tenantBody.split(before)).toHaveLength(2);tenantBody=tenantBody.replace(before,after);}
  const [tenantAbsence]=await owner.client`select to_regclass(${tenantView})as relation`;expect(tenantAbsence.relation).toBeNull();
  let tenantViewCreated=false;
  await owner.client.unsafe('create view '+view+'('+factsOwner.columns.map(name=>'"'+name+'"').join(',')+') with(security_barrier=true)as '+factsOwner.body);
  try{
   await owner.client.unsafe('create view '+tenantView+'('+factsOwner.columns.map(name=>'"'+name+'"').join(',')+') with(security_barrier=true)as '+tenantBody);tenantViewCreated=true;
   await owner.client.unsafe('revoke all on '+tenantView+' from public;grant select on '+tenantView+' to ai_hr_app');
   await owner.client.unsafe('revoke all on '+view+' from public;grant select on '+view+' to ai_hr_app');
   for(const relation of [view,tenantView]){
    const [properties]=await owner.client`select relowner::regrole::text as owner,reloptions as options,
     has_table_privilege('ai_hr_app',oid,'SELECT')as app_select from pg_class where oid=to_regclass(${relation})`;
    expect(properties.owner).toBe(factsOwner.owner);expect(properties.options).toContain('security_barrier=true');expect(properties.app_select).toBe(true);
   }
   const comparisons:unknown[]=[];report.planComparisons=comparisons;
   for(const mode of ['initial','selective-search','deep-page']){
    const q=mode==='selective-search'?'PERF'+String(count).padStart(9,'0'):undefined;
    const offset=mode==='deep-page'?count-25:0,page={companyIds:companies,q,limit:25,offset},facets={companyIds:companies,q};
    for(const variant of ['wide-native-control','narrow-view','narrow-view-tenant-key']){
     phase(mode+'-'+variant);
     const observed=await withTenant(ctx,async tx=>{
      await lockAccessConfigurationReadTx(tx,ctx.tenantId);
      const source=variant==='wide-native-control'?sql`app.access_workforce_list_facts()`:variant==='narrow-view'?sql`app.performance_personnel_million_facts`:sql`app.performance_personnel_million_tenant_facts`;
      const query=personnelListPageSql(page,facets,{source,materialized:true,projectPageFacts:variant!=='wide-native-control'});
      const began=performance.now(),[raw]=await tx.execute<{rows:unknown[];total:number;status_counts:{status:string;count:number}[]}>(query),elapsedMs=performance.now()-began;
      const byStatus:Record<string,number>={};let total=0;
      for(const row of raw.status_counts){byStatus[row.status]=Number(row.count);total+=Number(row.count);}
      expect({rows:raw.rows,total:Number(raw.total),headcount:{total,byStatus}}).toEqual(observedPages.get(mode));
      const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`));
      return{mode,variant,elapsedMs,targetMet:elapsedMs<1000,exactRowsCountsFacetsOrder:true,plan};
     });comparisons.push(observed);save();
    }
   }
   await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;
   try{for(const relation of [view,tenantView])expect(await withTenant(ctx,tx=>tx.execute(sql`select * from ${sql.raw(relation)}`))).toHaveLength(0);}
   finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
   for(const relation of [view,tenantView])expect(await withTenant(adminCtx(foreign),tx=>tx.execute(sql`select * from ${sql.raw(relation)} where company_id=${b.companyId}::uuid`))).toHaveLength(0);
   report.prototypePurposeRefusals=true;
  }finally{
   if(tenantViewCreated)await owner.client.unsafe('drop view '+tenantView);
   await owner.client.unsafe('drop view '+view);
   const [after]=await owner.client`select prosrc as body,proowner::regrole::text as owner,proargnames as columns,pg_get_functiondef(oid)as ddl,proacl::text as acl from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
   expect(after).toEqual(factsOwner);report.prototypeViewRemoved=true;report.nativeFactsUnchanged=true;save();
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
