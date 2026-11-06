/** Explicit hosted retained-data diagnosis only; native row triggers/constraints remain enabled. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {explainPersonnelOverview,personnelListPage,personnelListPageSql,readPersonnelOverview,searchWorkforceEmployeesTx,readWorkforcePickRowsTx} from '../../core/read';
import {foldEmployeeCode,EMPLOYEE_SEARCH_RESULT_CAP} from '../../lib/employee-search';
import {pgSqlState} from '../../lib/db-error';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {withPersonnelRead} from '../../core/personnel-read-bounds';
import {lockAccessConfigurationTx,lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {withTenant} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner} from '../harness';
import {personnelNativeAggregatePrototype} from './personnel-native-aggregate-prototype';
import {personnelDatedTagsPrototype} from './personnel-dated-tags-prototype';
import {seedPersonnelCorrectionFixture,seedPersonnelNativeFixture} from './personnel-native-fixture';
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
  const {b,foreign,ctx,foreignEmployment,expectedFirst,expectedLast,organisationTagSample}=
   await seedPersonnelNativeFixture(count,report,phase,save);
  report.fixturePreparationMs=performance.now()-started;
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
  const overviewMeasurements:typeof measurements=[];
  const overviewPlans:{mode:string;role:string;plan:unknown}[]=[];
  type OverviewStep='native-read'|'explain-estimate'|'explain-analyze'|'projection-stage';
  const overviewFailures:{mode:string;step:OverviewStep;elapsedMs:number;errorType:string;sqlState:string|null}[]=[];
  const liveOverviewCases=[
   {mode:'initial',offset:0,expectedIds:expectedFirst},
   {mode:'selective-search',q:'PERF000050000',offset:0,expectedIds:[expectedLast.at(-1)!]},
   {mode:'deep-page',offset:count-25,expectedIds:expectedLast},
  ];
  const recordOverviewFailure=(mode:string,step:OverviewStep,began:number,error:unknown)=>{
   overviewFailures.push({mode,step,elapsedMs:performance.now()-began,errorType:error instanceof Error?error.name:typeof error,sqlState:pgSqlState(error)??null});
   report.liveOverviewFailures=overviewFailures;save();
  };
  for(const {mode,q,offset,expectedIds} of liveOverviewCases){
   const expectedTotal=q?1:count;
   const input={companyIds:[b.companyId],q,limit:25,offset};
   phase('live-overview-'+mode);
   const began=performance.now();
   let result;
   try{result=await readPersonnelOverview(ctx,input,{q});}
   catch(error){recordOverviewFailure(mode,'native-read',began,error);continue;}
   const elapsedMs=performance.now()-began;
   expect(result.employees.total).toBe(expectedTotal);
   expect(result.headcount.total).toBe(expectedTotal);
   expect(result.employees.rows.map(row=>row.employmentId)).toEqual(expectedIds);
   expect(result.organisationChoices.companies.map(company=>company.id)).toEqual([b.companyId]);
   overviewMeasurements.push({mode,elapsedMs,total:result.employees.total,pageRows:result.employees.rows.length,targetMet:elapsedMs<1000});
   report.liveOverview=overviewMeasurements;save();
  }
  const overviewEstimatedPlans:typeof overviewPlans=[];
  for(const {mode,q,offset} of liveOverviewCases){
   phase('live-overview-estimate-'+mode);
   const began=performance.now();
   let explained;
   try{explained=await explainPersonnelOverview(ctx,{companyIds:[b.companyId],q,limit:25,offset},{q},'estimate');}
   catch(error){recordOverviewFailure(mode,'explain-estimate',began,error);continue;}
   const {role,plan}=explained;
   expect(role).toBe('ai_hr_app');
   expect(plan).toEqual([expect.objectContaining({Plan:expect.any(Object)})]);
   overviewEstimatedPlans.push({mode,role,plan});report.liveOverviewEstimatedPlans=overviewEstimatedPlans;save();
  }
  // Time the production source and its guarded per-employee tag dependency separately. This
  // exposes time spent inside the opaque SECURITY DEFINER function even if EXPLAIN ANALYZE times out.
  const asOf=todayInKualaLumpur();
  const projectionStages:{mode:string;elapsedMs:number;rows:number}[]=[];
  const measureProjectionStage=async(mode:string,query:ReturnType<typeof sql>,expectedRows:number)=>{
   phase('live-overview-stage-'+mode);
   const began=performance.now();
   let observed;
   try{
    observed=await withPersonnelRead(ctx,async tx=>{
     const [identity]=await tx.execute<{role:string}>(sql`select current_user as role`);
     expect(identity.role).toBe('ai_hr_app');
     const [result]=await tx.execute<{rows:number}>(query);
     return result.rows;
    },{sharedAccessLock:true});
   }catch(error){recordOverviewFailure(mode,'projection-stage',began,error);return;}
   const elapsedMs=performance.now()-began;
   expect(observed).toBe(expectedRows);
   projectionStages.push({mode,elapsedMs,rows:observed});report.liveOverviewProjectionStages=projectionStages;save();
  };
  await measureProjectionStage('base-workforce-json',sql`
   select count(*)::int as rows from app.access_workforce_list_rows() r(value)
   where (r.value->>'companyId')::uuid=${b.companyId}::uuid
  `,count);
  for(const sampleSize of [25,500]){
   const ids=sql.join(organisationTagSample.slice(0,sampleSize).map(id=>sql`${id}::uuid`),sql`, `);
   await measureProjectionStage('dated-organisation-tags-'+sampleSize,sql`
    select count(app.employment_organisation_tags(s.id,${asOf}::date)->>'companyId')::int as rows
    from unnest(array[${ids}]) s(id)
   `,sampleSize);
  }
  await measureProjectionStage('dated-directory-json',sql`
   select count(*)::int as rows from app.personnel_filter_rows(${asOf}::date,array[${b.companyId}::uuid])
  `,count);
  phase('live-overview-batched-dated-tags');
  const prototype=await personnelDatedTagsPrototype();
  try{
   const sample=organisationTagSample.slice(0,25);
   const parityCases=[
    {mode:'current',date:asOf,scope:[b.companyId],ids:sample,expected:sample},
    {mode:'historical',date:'2020-01-01',scope:[b.companyId],ids:sample,expected:sample},
    {mode:'requested-foreign',date:asOf,scope:[b.companyId,foreign.companyId],ids:[...sample,foreignEmployment],expected:sample},
    {mode:'foreign-only',date:asOf,scope:[foreign.companyId],ids:[foreignEmployment],expected:[]},
   ];
   const parity:{mode:string;baselineMs:number;candidateMs:number;effectiveCompanyMs:number;rows:number}[]=[];
   for(const {mode,date,scope,ids,expected} of parityCases){
    const read=(variant:'baseline'|'candidate'|'effectiveCompany')=>withPersonnelRead(ctx,tx=>tx.execute<{role:string;value:{employmentId:string}}>(sql`
     select current_user as role,value from ${prototype.source(variant,date,scope,ids)}
     order by value->>'employmentId'
    `),{sharedAccessLock:true});
    const baselineStart=performance.now(),original=Array.from(await read('baseline')),baselineMs=performance.now()-baselineStart;
    const candidateStart=performance.now(),candidate=Array.from(await read('candidate')),candidateMs=performance.now()-candidateStart;
    const effectiveStart=performance.now(),effective=Array.from(await read('effectiveCompany')),effectiveCompanyMs=performance.now()-effectiveStart;
    expect(candidate).toEqual(original);
    expect(effective).toEqual(original);
    expect(candidate.map(row=>row.value.employmentId)).toEqual([...expected].sort());
    expect(candidate.every(row=>row.role==='ai_hr_app')).toBe(true);
    parity.push({mode,baselineMs,candidateMs,effectiveCompanyMs,rows:candidate.length});report.liveOverviewDatedPrototypeParity=parity;save();
   }
   await measureProjectionStage('batched-dated-directory-json',sql`
    select count(*)::int as rows from ${prototype.source('candidate',asOf,[b.companyId],null)}
   `,count);
   await measureProjectionStage('set-effective-company-directory-json',sql`
    select count(*)::int as rows from ${prototype.source('effectiveCompany',asOf,[b.companyId],null)}
   `,count);
  }finally{await prototype.drop();}
  report.liveOverviewExplainStatementTimeoutMs=45000;
  for(const {mode,q,offset} of liveOverviewCases){
   phase('live-overview-plan-'+mode);
   const began=performance.now();
   let explained;
   try{explained=await explainPersonnelOverview(ctx,{companyIds:[b.companyId],q,limit:25,offset},{q});}
   catch(error){recordOverviewFailure(mode,'explain-analyze',began,error);continue;}
   const {role,plan}=explained;
   expect(role).toBe('ai_hr_app');
   expect(plan).toEqual([expect.objectContaining({Plan:expect.any(Object),'Execution Time':expect.any(Number)})]);
   overviewPlans.push({mode,role,plan});report.liveOverviewPlans=overviewPlans;save();
  }
  phase('live-overview-foreign-company');
  const denied=await readPersonnelOverview(ctx,{companyIds:[foreign.companyId],limit:25,offset:0},{});
  expect(denied.employees).toEqual({rows:[],total:0});
  expect(denied.headcount).toEqual({total:0,byStatus:{}});
  expect(denied.organisationChoices).toEqual({companies:[],canInspectDuplicates:false,rows:[]});
  report.liveOverviewForeignCompanyExcluded=true;save();
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
   for(const mode of ['initial','selective-search','deep-page','active-page-all-status-facets','company-sort','zero-page']){
    const q=mode==='selective-search'?'PERF000050000':undefined,offset=mode==='deep-page'?count-25:0;
    const page:Parameters<typeof personnelListPage>[1]={companyIds:companies,q,limit:mode==='zero-page'?0:25,offset};
    if(mode==='active-page-all-status-facets')page.status='active';
    if(mode==='company-sort'){page.sort='company';page.departmentId=b.deptA;page.employmentType='full_time';}
    const facets={companyIds:companies,q},expected=await personnelListPage(ctx,page,facets);
    const samples:unknown[]=[];
    for(const variant of [
     {source:'view',materialized:true,projectPageFacts:false},
     {source:'view',materialized:true,projectPageFacts:true},
     {source:'native-function',materialized:true,projectPageFacts:true},
    ]){
     const {materialized,projectPageFacts}=variant;
     const began=performance.now();
     const observed=await withTenant(ctx,async tx=>{
      await lockAccessConfigurationReadTx(tx,ctx.tenantId);
      const query=personnelListPageSql(page,facets,{source:variant.source==='view'?sql`app.performance_personnel_facts_view`:sql`app.access_workforce_list_facts()`,materialized,projectPageFacts});
      const [raw]=await tx.execute<{rows:typeof expected.rows;total:number;status_counts:{status:keyof typeof expected.headcount.byStatus;count:number}[]}>(query);
      const elapsedMs=performance.now()-began,byStatus:typeof expected.headcount.byStatus={};let total=0;
      for(const row of raw.status_counts){byStatus[row.status]=Number(row.count);total+=Number(row.count);}
      expect({rows:raw.rows,total:Number(raw.total),headcount:{total,byStatus}}).toEqual(expected);
      const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`));
      return {source:variant.source,materialized,projectPageFacts,elapsedMs,plan,targetMet:elapsedMs<1000};
     });samples.push(observed);
    }
    const originalPlan=await withTenant(ctx,tx=>tx.execute(sql`explain(analyze,buffers,format json) ${personnelListPageSql(page,facets)}`));
    for(const materialized of [true,false]){
     const prototype=await personnelNativeAggregatePrototype(page,facets,factsOwner,materialized);
     try{
      const observed=await withTenant(ctx,async tx=>{
       await lockAccessConfigurationReadTx(tx,ctx.tenantId);
       const began=performance.now(),[raw]=await tx.execute<{rows:typeof expected.rows;total:number;status_counts:{status:keyof typeof expected.headcount.byStatus;count:number}[]}>(prototype.query),elapsedMs=performance.now()-began;
       const byStatus:typeof expected.headcount.byStatus={};let total=0;
       for(const row of raw.status_counts){byStatus[row.status]=Number(row.count);total+=Number(row.count);}
       expect({rows:raw.rows,total:Number(raw.total),headcount:{total,byStatus}}).toEqual(expected);
       return {source:'native-aggregate-prototype',materialized,elapsedMs,targetMet:elapsedMs<1000,exactRowsCountsFacetsOrder:true};
      });samples.push(observed);
      await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;
      try{
       const [denied]=await withTenant(ctx,tx=>tx.execute<{rows:unknown[];total:number;status_counts:unknown[]}>(prototype.query));
       expect(denied).toEqual({rows:[],total:0,status_counts:[]});
      }finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
      const foreignCtx={...adminCtx(foreign),grants:[{role:'hr_admin' as const,companyId:null}]};
      const foreignExpected=await personnelListPage(foreignCtx,page,facets);
      const [foreignObserved]=await withTenant(foreignCtx,tx=>tx.execute<{rows:typeof expected.rows;total:number;status_counts:{status:keyof typeof expected.headcount.byStatus;count:number}[]}>(prototype.query));
      const foreignByStatus:typeof expected.headcount.byStatus={};let foreignTotal=0;
      for(const row of foreignObserved.status_counts){foreignByStatus[row.status]=Number(row.count);foreignTotal+=Number(row.count);}
      expect({rows:foreignObserved.rows,total:Number(foreignObserved.total),headcount:{total:foreignTotal,byStatus:foreignByStatus}}).toEqual(foreignExpected);
      expect(foreignObserved.rows.every(row=>row.companyId===foreign.companyId)).toBe(true);
     }finally{await prototype.drop();}
    }
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
  expect(overviewFailures,'Live Personnel reads and independent plan captures').toEqual([]);
  expect(measurements.every(row=>row.targetMet),'Each observed retained-data Personnel native query under1000ms').toBe(true);
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{report.queries=measurements;save();}
},600000);

it.skipIf(!requested)('preserves the first future information correction for a dated Personnel read',async()=>{
 const {ctx,companies,employmentId,hiredOn,beforeCompanyId,afterCompanyId}=await seedPersonnelCorrectionFixture();
 const prototype=await personnelDatedTagsPrototype();
 try{
  for(const [date,companyId] of [[hiredOn,beforeCompanyId],[todayInKualaLumpur(),afterCompanyId]]){
   const read=(variant:'baseline'|'effectiveCompany')=>withPersonnelRead(ctx,tx=>tx.execute<{value:{companyId:string}}>(sql`
    select value from ${prototype.source(variant,date,companies,[employmentId])}
   `),{sharedAccessLock:true});
   const baseline=await read('baseline'),batched=await read('effectiveCompany');
   expect(baseline.map(row=>row.value.companyId)).toEqual([companyId]);
   expect(Array.from(batched)).toEqual(Array.from(baseline));
  }
 }finally{await prototype.drop();}
},60000);
