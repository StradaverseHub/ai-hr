/** Retained-data component experiment. Native constraints, triggers and authority stay enabled. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql,type SQL} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {personnelListPage} from '../../core/read';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import {personnelNativeAggregatePrototype} from './personnel-native-aggregate-prototype';
import {nativePersonnelPlanDiagnostic} from './personnel-native-plan-diagnostic';
import {witnessCurrentAssignmentCardinality} from './assignment-current-cardinality-witness';
import {personnelUnusedAssignmentFacts} from './personnel-unused-assignment-prototype';
const file='test/performance/personnel-unused-assignment-retained.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('measures no-assignment initial and deep Personnel pages over fifty thousand native retained people',async()=>{
 const count=50_000,started=performance.now(),index='performance_personnel_retained_name_order';let indexCreated=false,beforeFunctions:unknown;
 const report:Record<string,unknown>={kind:'PERSONNEL_UNUSED_ASSIGNMENT_50K_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,nativeTriggers:'unchanged',
  acceptance:'>=20% gain for both initial and deep, no >10% regression in company-sort or independent-status/facet control; no million/browser/500 acceptance'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-unused-assignment-retained.json'),JSON.stringify(report,null,2));
 const phase=(value:string)=>{report.phase=value;report.elapsedMs=performance.now()-started;save();};
 const functions=()=>owner.client`select oid::regprocedure::text as identity,prosrc,proowner::regrole::text as owner,proacl::text as acl,proconfig,procost,prorows from pg_proc where oid=any(array['app.access_workforce_list_facts()'::regprocedure,'app.access_workforce_list_rows_for_ids(uuid[])'::regprocedure,'app._access_workforce_list_rows(uuid[])'::regprocedure])order by oid`;
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);await witnessCurrentAssignmentCardinality(foreign,b,report,save);beforeFunctions=Array.from(await functions());
  const writePeople:string[]=[];
  // Same proven native fixture shape as the successful search benchmark; repeated names exercise
  // the canonical employment-ID tie-break on deep pages rather than rewarding artificial uniqueness.
  for(let offset=0;offset<count;offset+=5000){
   const end=offset+5000,pp=randomUUID().slice(0,24),ep=randomUUID().slice(0,24);phase('native-fixture');
   await owner.client.begin(async tx=>{
    await tx`insert into person(id,tenant_id,full_name,primary_email)select(${pp}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,case when n%250=0 then 'Repeated retained name'else 'Fictional retained Personnel '||lpad(n::text,9,'0')end,(${pp}||lpad(n::text,12,'0'))||'@example.invalid'from generate_series(${offset+1}::int,${end}::int)n`;
    await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)select(${ep}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${pp}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'PERF'||lpad(n::text,9,'0'),'2020-01-01'::date,case when n%5=0 then '2024-01-01'::date else null end from generate_series(${offset+1}::int,${end}::int)n`;
    await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)select ${b.tenantId}::uuid,(${ep}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,case when n%10=0 then ${b.deptB}::uuid else ${b.deptA}::uuid end,'full_time','2020-01-01'::date from generate_series(${offset+1}::int,${end}::int)n`;
   });
   if(end===count)for(let n=end-99;n<=end;n++)writePeople.push(pp+String(n).padStart(12,'0'));
   report.committedFixtureEmployees=end;save();
  }
  const foreignPerson=randomUUID(),foreignEmployment=randomUUID();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email)values(${foreignPerson}::uuid,${foreign.tenantId}::uuid,'Foreign owner fixture',${foreignPerson+'@example.invalid'})`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on)values(${foreignEmployment}::uuid,${foreign.tenantId}::uuid,${foreignPerson}::uuid,${foreign.companyId}::uuid,'2020-01-01')`;
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  report.fixturePreparationMs=performance.now()-started;
  const [facts]=await owner.client<{body:string;owner:string;columns:string[]}[]>`select prosrc as body,proowner::regrole::text as owner,proargnames as columns from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
  const base={companyIds:[b.companyId,foreign.companyId]};type Page=Parameters<typeof personnelListPage>[1];type Facets=Parameters<typeof personnelListPage>[2];
  const cases:{name:string;page:Page;facets:Facets;total:number}[]=[
   {name:'initial',page:{...base,limit:25,offset:0},facets:base,total:count},
   {name:'deep',page:{...base,limit:25,offset:count-25},facets:base,total:count},
   {name:'company-sort',page:{...base,sort:'company',limit:25,offset:count-25},facets:base,total:count},
   {name:'independent-status',page:{...base,status:'active',limit:25,offset:count*4/5-25},facets:base,total:count*4/5},
  ];
  const fallbackPage={...base,limit:25,offset:0},fallbackFacets={...base,departmentId:b.deptB};
  expect(personnelUnusedAssignmentFacts(fallbackPage,fallbackFacets,facts).pruned).toBe(false);
  const fallback=await personnelListPage(ctx,fallbackPage,fallbackFacets);expect(fallback.total).toBe(count);expect(fallback.headcount.total).toBe(count/10);report.actualAssignmentFacetFallback=true;
  const readNative=(query:SQL)=>withTenant(ctx,async tx=>{
   await lockAccessConfigurationReadTx(tx,ctx.tenantId);
   const [row]=await tx.execute<{rows:unknown[];total:number;status_counts:{status:string;count:number}[]}>(query);
   return{rows:row.rows,total:Number(row.total),headcount:{total:row.status_counts.reduce((n,v)=>n+Number(v.count),0),byStatus:Object.fromEntries(row.status_counts.map(v=>[v.status,Number(v.count)]))}};
  });
  const measurements:{indexed:boolean;mode:string;phase:string;reads:number;elapsedMs:number}[]=[],plans:unknown[]=[];
  const benchmark=async(indexed:boolean)=>{
   for(const value of cases){
    phase((indexed?'indexed-':'unindexed-')+value.name);
    const expected=await personnelListPage(ctx,value.page,value.facets);expect(expected.total).toBe(value.total);expect(expected.headcount.total).toBe(count);expect(expected.rows.some(row=>row.employmentId===foreignEmployment)).toBe(false);
    const selected=personnelUnusedAssignmentFacts(value.page,value.facets,facts);expect(selected.pruned).toBe(true);
    const inline=await personnelNativeAggregatePrototype(value.page,value.facets,facts,false);let candidate:Awaited<ReturnType<typeof personnelNativeAggregatePrototype>>|undefined;
    try{
     candidate=await personnelNativeAggregatePrototype(value.page,value.facets,selected.facts,false);
     for(const variant of ['original','native-inline-control','candidate','candidate-warm','restored']){
      const began=performance.now();
      for(let n=0;n<3;n++){
       const observed=variant==='native-inline-control'?await readNative(inline.query):variant.startsWith('candidate')?await readNative(candidate.query):await personnelListPage(ctx,value.page,value.facets);
       expect(observed).toEqual(expected);
      }
      measurements.push({indexed,mode:value.name,phase:variant,reads:3,elapsedMs:performance.now()-began});report.measurements=measurements;save();
     }
     if(value.name==='initial'||value.name==='deep'){
      for(const [kind,query] of [['inline',inline.query],['omitted',candidate.query]] as const){
       const diagnostic=await nativePersonnelPlanDiagnostic(query);
       try{const plan=await withTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);return Array.from(await tx.execute(diagnostic.query));});plans.push({indexed,mode:value.name,kind,plan});report.plans=plans;save();}
       finally{await diagnostic.drop();}
      }
     }
    }finally{if(candidate)await candidate.drop();await inline.drop();}
   }
  };
  const writes:unknown[]=[];
  const writeProbe=async(indexed:boolean)=>{
   const previous=await owner.client`select id,full_name from person where id=any(${writePeople}::uuid[])`;expect(previous).toHaveLength(100);const began=performance.now();
   await owner.client`update person set full_name='Write probe '||id::text where id=any(${writePeople}::uuid[])`;
   const elapsedMs=performance.now()-began;
   await owner.client.begin(async tx=>{for(const row of previous)await tx`update person set full_name=${row.full_name} where id=${row.id}::uuid`;});
   writes.push({indexed,rows:100,elapsedMs,kind:'OWNER_FIXTURE_NAME_UPDATE_NOT_APP_CRUD'});report.writeProbe=writes;save();
  };
  await benchmark(false);await writeProbe(false);
  const [absent]=await owner.client`select to_regclass(${'public.'+index})as relation`;expect(absent.relation).toBeNull();
  phase('name-index-build');const build=performance.now();await owner.client.unsafe('create index '+index+' on public.person(tenant_id,full_name,id)');indexCreated=true;
  report.indexBuildMs=performance.now()-build;const [size]=await owner.client`select pg_relation_size(${'public.'+index}::regclass)::text as bytes`;report.indexBytes=size.bytes;
  await owner.client`analyze person`;await benchmark(true);await writeProbe(true);
  const comparisons=[false,true].map(indexed=>{
   const ratios=Object.fromEntries(cases.map(({name})=>{const rows=measurements.filter(r=>r.indexed===indexed&&r.mode===name);return [name,Math.max(rows[2].elapsedMs,rows[3].elapsedMs)/Math.min(rows[0].elapsedMs,rows[4].elapsedMs)];}));
   return{indexed,ratios,qualified:ratios.initial<.8&&ratios.deep<.8&&ratios['company-sort']<=1.1&&ratios['independent-status']<=1.1};
  });report.comparisons=comparisons;phase('complete');expect(comparisons.some(row=>row.qualified),'Measured initial+deep must improve20%, with other supported modes within10%').toBe(true);
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{if(indexCreated)await owner.client.unsafe('drop index public.'+index);if(beforeFunctions)expect(Array.from(await functions())).toEqual(beforeFunctions);report.prototypeObjectsRemoved=true;report.originalNativeFunctionsUnchanged=true;save();}
},600000);
