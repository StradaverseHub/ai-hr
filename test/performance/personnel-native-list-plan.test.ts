/** Explicit hosted retained-data diagnosis only; native row triggers/constraints remain enabled. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {personnelListPage,personnelListPageSql,searchWorkforceEmployeesTx,readWorkforcePickRowsTx} from '../../core/read';
import {foldEmployeeCode,EMPLOYEE_SEARCH_RESULT_CAP} from '../../lib/employee-search';
import {lockAccessConfigurationTx,lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {withTenant,type SessionContext} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
const file='test/performance/personnel-native-list-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('profiles initial/search/deep Personnel pages with fifty thousand native retained employees',async()=>{
 const count=50_000,started=performance.now();
 const report:Record<string,unknown>={kind:'PERSONNEL_RETAINED_50K_QUERY_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,queryTargetMs:1000,fixtureBatchRows:5000,nativeTriggers:'unchanged',limitations:'Retained synthetic owner fixture, not hiring/import throughput, browser timing, one-million Personnel or500-user capacity.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-native-list-plan.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};
 const measurements:{mode:string;elapsedMs:number;total:number;pageRows:number;targetMet:boolean}[]=[];
 try{
  expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
  await resetDb();const b=await seedBase(),foreign=await seedBase();
  const ctx:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
  const expectedFirst:string[]=[],expectedLast:string[]=[];
  for(let offset=0;offset<count;offset+=5000){
   const end=offset+5000,personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
   report.currentFixtureBatch={from:offset+1,to:end};phase('fixture');
   await owner.client.begin(async tx=>{
    await tx`insert into person(id,tenant_id,full_name,primary_email)
     select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
      'Fictional retained Personnel '||lpad(n::text,9,'0'),(${personPrefix}||lpad(n::text,12,'0'))||'@example.invalid'
     from generate_series(${offset+1}::integer,${end}::integer)n`;
    await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
     select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,
      ${b.companyId}::uuid,'PERF'||lpad(n::text,9,'0'),'2020-01-01'::date,
      case when n%5=0 then '2024-01-01'::date else null end from generate_series(${offset+1}::integer,${end}::integer)n`;
    await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
     select ${b.tenantId}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,
      ${b.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(${offset+1}::integer,${end}::integer)n`;
   });
   if(offset===0)for(let n=1;n<=25;n++)expectedFirst.push(employmentPrefix+String(n).padStart(12,'0'));
   if(end===count)for(let n=count-24;n<=count;n++)expectedLast.push(employmentPrefix+String(n).padStart(12,'0'));
   report.committedFixtureEmployees=end;save();
  }
  const foreignPerson=randomUUID(),foreignEmployment=randomUUID();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email) values(${foreignPerson}::uuid,${foreign.tenantId}::uuid,'Fictional outside Personnel',${foreignPerson+'@example.invalid'})`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${foreignEmployment}::uuid,${foreign.tenantId}::uuid,${foreignPerson}::uuid,${foreign.companyId}::uuid,'2020-01-01')`;
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  const [counts]=await owner.client`select (select count(*)::int from employment where tenant_id=${b.tenantId}::uuid) as employees,(select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid)as assignments`;
  expect(counts).toEqual({employees:count,assignments:count});report.retainedCounts=counts;report.fixturePreparationMs=performance.now()-started;
  const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');
  const companies=[b.companyId,foreign.companyId];
  for(const mode of ['initial','selective-search','deep-page']){
   const q=mode==='selective-search'?'PERF000050000':undefined,offset=mode==='deep-page'?count-25:0;
   phase(mode);const began=performance.now();
   const result=await personnelListPage(ctx,{companyIds:companies,q,limit:25,offset},{companyIds:companies,q});
   const elapsedMs=performance.now()-began,expectedTotal=q?1:count,expectedIds=q?[expectedLast.at(-1)!]:offset?expectedLast:expectedFirst;
   expect(result.total).toBe(expectedTotal);expect(result.headcount.total).toBe(expectedTotal);
   expect(Object.values(result.headcount.byStatus).reduce((sum,value)=>sum+Number(value??0),0)).toBe(expectedTotal);
   expect(result.rows.map(row=>row.employmentId)).toEqual(expectedIds);expect(result.rows.every(row=>row.employmentId!==foreignEmployment)).toBe(true);
   measurements.push({mode,elapsedMs,total:result.total,pageRows:result.rows.length,targetMet:elapsedMs<1000});report.queries=measurements;save();
  }
  const pickerMeasurements:{mode:string;originalElapsedMs:number;elapsedMs:number;rows:number;targetMet:boolean}[]=[];
  // Frozen original query is an independent oracle. Only native purpose APIs are read under ai_hr_app.
  const originalSearch=(query:string)=>withTenant(ctx,async tx=>{
   await lockAccessConfigurationTx(tx,ctx.tenantId);
   const raw=query.trim().toLowerCase(),folded=foldEmployeeCode(query);
   const rank=sql`case
    when ${folded}<>'' and search_compact<>'' and search_compact=${folded} then 0
    when ${folded}<>'' and search_compact<>'' and left(search_compact,length(${folded}))=${folded} then 1
    when left(search_name,length(${raw}))=${raw} then 2
    when position(${raw} in search_code)>0 or (${folded}<>'' and position(${folded} in search_compact)>0) then 3
    when position(${raw} in search_name)>0 then 4 else 5 end`;
   return tx.execute(sql`with normalized as materialized(
    select value,lower(value->>'name')as search_name,lower(coalesce(value->>'employeeCode',''))as search_code,
     regexp_replace(lower(coalesce(value->>'employeeCode','')),'[[:space:]._-]','','g')as search_compact
    from app.access_workforce_picker_rows(null,null::date,null::date)r(value)
    where (value->>'companyId')::uuid=any(array[${b.companyId}::uuid,${foreign.companyId}::uuid])
   )select (value->>'employmentId')::uuid as "employmentId",value->>'name'as name,value->>'employeeCode'as "employeeCode",
    (value->>'companyId')::uuid as "companyId",value->>'company'as company,value->>'department'as department,value->>'terminatedOn'as "terminatedOn"
    from normalized where ${rank}<5 order by ${rank},value->>'name',(value->>'employmentId')::uuid limit ${EMPLOYEE_SEARCH_RESULT_CAP}`);
  });
  for(const query of ['PERF000050000','PERF','Fictional retained','NOTPRESENT']){
   phase('picker-'+query);const before=performance.now(),reference=await originalSearch(query),originalElapsedMs=performance.now()-before;
   const began=performance.now(),current=await withTenant(ctx,tx=>searchWorkforceEmployeesTx(ctx,tx,companies,query)),elapsedMs=performance.now()-began;
   expect(Array.from(current)).toEqual(Array.from(reference));
   expect(current.map(row=>row.employmentId)).toEqual(query==='PERF000050000'?[expectedLast.at(-1)!]:query==='NOTPRESENT'?[]:expectedFirst.slice(0,8));
   pickerMeasurements.push({mode:query,originalElapsedMs,elapsedMs,rows:current.length,targetMet:elapsedMs<1000});report.pickers=pickerMeasurements;save();
  }
  const selectedIds=[...expectedFirst,expectedFirst[0],foreignEmployment,randomUUID()];
  const beforePoint=performance.now(),referencePoint=await withTenant(ctx,async tx=>{
   await lockAccessConfigurationTx(tx,ctx.tenantId);
   return tx.execute(sql`select (value->>'employmentId')::uuid as "employmentId",value->>'name'as name,value->>'employeeCode'as "employeeCode",
    (value->>'companyId')::uuid as "companyId",value->>'company'as company,value->>'department'as department,value->>'terminatedOn'as "terminatedOn"
    from app.access_workforce_list_rows()r(value)where (value->>'employmentId')::uuid=any(array[${sql.join(selectedIds.map(id=>sql`${id}::uuid`),sql`, `)}])order by (value->>'employmentId')::uuid`);
  }),originalPointElapsedMs=performance.now()-beforePoint;
  const beganPoint=performance.now(),currentPoint=await withTenant(ctx,tx=>readWorkforcePickRowsTx(ctx,tx,selectedIds)),pointElapsedMs=performance.now()-beganPoint;
  expect(Array.from(currentPoint)).toEqual(Array.from(referencePoint));expect(currentPoint.map(row=>row.employmentId)).toEqual([...expectedFirst].sort());
  report.selectedIdentityRead={rows:currentPoint.length,originalElapsedMs:originalPointElapsedMs,elapsedMs:pointElapsedMs,targetMet:pointElapsedMs<1000,duplicateForeignUnknownExcluded:true};save();
  expect(pickerMeasurements.every(row=>row.targetMet),'Each Personnel switcher query under1000ms').toBe(true);expect(pointElapsedMs).toBeLessThan(1000);
  // Reversible native view experiment: same authorized fields/predicate, without opaque SRF spooling.
  const view='app.performance_personnel_facts_view';
  const [absent]=await owner.client`select to_regclass(${view})as relation`;expect(absent.relation).toBeNull();
  const [factsOwner]=await owner.client<{body:string;owner:string;columns:string[];ddl:string;acl:string|null}[]>`select prosrc as body,proowner::regrole::text as owner,proargnames as columns,pg_get_functiondef(oid)as ddl,proacl::text as acl from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
  expect(factsOwner.columns).toHaveLength(16);
  await owner.client.unsafe('create view '+view+'('+factsOwner.columns.map(name=>'"'+name.replaceAll('"','""')+'"').join(',')+')with(security_barrier=true)as '+factsOwner.body);
  try{
   await owner.client.unsafe('revoke all on '+view+' from public;grant select on '+view+' to ai_hr_app');
   const [properties]=await owner.client`select relowner::regrole::text as owner,reloptions as options,has_table_privilege('ai_hr_app',oid,'SELECT')as app_select from pg_class where oid=to_regclass(${view})`;
   expect(properties.owner).toBe(factsOwner.owner);expect(properties.options).toContain('security_barrier=true');expect(properties.app_select).toBe(true);
   const [same]=await withTenant(ctx,tx=>tx.execute<{mismatches:number}>(sql`select count(*)::int as mismatches from(
    (select * from app.access_workforce_list_facts() except all select * from app.performance_personnel_facts_view)
    union all(select * from app.performance_personnel_facts_view except all select * from app.access_workforce_list_facts())
   )difference`));expect(same.mismatches).toBe(0);
   const viewPlans:unknown[]=[];
   for(const mode of ['initial','selective-search','deep-page']){
    const q=mode==='selective-search'?'PERF000050000':undefined,offset=mode==='deep-page'?count-25:0;
    const page={companyIds:companies,q,limit:25,offset},facets={companyIds:companies,q},expected=await personnelListPage(ctx,page,facets);
    const samples:unknown[]=[];
    for(const materialized of [true,false]){
     const began=performance.now();
     const observed=await withTenant(ctx,async tx=>{
      await lockAccessConfigurationReadTx(tx,ctx.tenantId);
      const query=personnelListPageSql(page,facets,{source:sql`app.performance_personnel_facts_view`,materialized});
      const [raw]=await tx.execute<{rows:typeof expected.rows;total:number;status_counts:{status:keyof typeof expected.headcount.byStatus;count:number}[]}>(query);
      const elapsedMs=performance.now()-began,byStatus:typeof expected.headcount.byStatus={};let total=0;
      for(const row of raw.status_counts){byStatus[row.status]=Number(row.count);total+=Number(row.count);}
      expect({rows:raw.rows,total:Number(raw.total),headcount:{total,byStatus}}).toEqual(expected);
      const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`));
      return {materialized,elapsedMs,plan,targetMet:elapsedMs<1000};
     });samples.push(observed);
    }
    const originalPlan=await withTenant(ctx,tx=>tx.execute(sql`explain(analyze,buffers,format json) ${personnelListPageSql(page,facets)}`));
    viewPlans.push({mode,samples,originalPlan:Array.from(originalPlan),exactRowsTotalStatusOrder:true});report.viewExperiment=viewPlans;save();
   }
   await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;
   try{const denied=await withTenant(ctx,tx=>tx.execute(sql`select * from app.performance_personnel_facts_view`));expect(denied).toHaveLength(0);}
   finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
   const foreignRows=await withTenant({...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]},tx=>tx.execute(sql`select * from app.performance_personnel_facts_view where company_id=${b.companyId}::uuid`));expect(foreignRows).toHaveLength(0);
   report.viewPurposeRefusals=true;
  }finally{
   await owner.client.unsafe('drop view '+view);
   const [after]=await owner.client`select prosrc as body,proowner::regrole::text as owner,proargnames as columns,pg_get_functiondef(oid)as ddl,proacl::text as acl from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
   expect(after).toEqual(factsOwner);report.originalFactsFunctionUnchanged=true;report.prototypeViewDropped=true;save();
  }
  phase('measured');
  expect(measurements.every(row=>row.targetMet),'Each observed retained-data Personnel native query under1000ms').toBe(true);
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{report.queries=measurements;save();}
},600000);
