/** Explicit hosted retained-data experiment; all native row triggers and authority remain enabled. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {personnelListPage,personnelListPageSql} from '../../core/read';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {withTenant,type SessionContext} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import {personnelReverseTailPrototype} from './personnel-reverse-tail-prototype';
const file='test/performance/personnel-reverse-tail.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('compares reverse tail selection with exact native counts, independent facets and assignment fanout',async()=>{
 const count=50_000,started=performance.now();
 const report:Record<string,unknown>={kind:'PERSONNEL_REVERSE_TAIL_50K_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,
  nativeTriggers:'unchanged',concurrentUsers:1,limitations:'Component experiment only; not million-Personnel or500-user/browser acceptance.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-reverse-tail.json'),JSON.stringify(report,null,2));
 const phase=(value:string)=>{report.phase=value;report.elapsedMs=performance.now()-started;save();};
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase();
  const ctx:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
  const allIds:string[]=[];
  for(let offset=0;offset<count;offset+=5000){
   const end=offset+5000,personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);phase('fixture');
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
   for(let n=offset+1;n<=end;n++)allIds.push(employmentPrefix+String(n).padStart(12,'0'));
   report.committedFixtureEmployees=end;save();
  }
  const foreignPerson=randomUUID(),foreignEmployment=randomUUID();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email)values(${foreignPerson}::uuid,${foreign.tenantId}::uuid,'Foreign reverse tail',${foreignPerson+'@example.invalid'})`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on)values(${foreignEmployment}::uuid,${foreign.tenantId}::uuid,${foreignPerson}::uuid,${foreign.companyId}::uuid,'2020-01-01')`;
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  const [counts]=await owner.client`select (select count(*)::int from employment where tenant_id=${b.tenantId}::uuid)as employees,(select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid)as assignments`;
  expect(counts).toEqual({employees:count,assignments:count});report.retainedCounts=counts;report.fixturePreparationMs=performance.now()-started;
  const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');
  type Page=Parameters<typeof personnelListPage>[1];type Facets=Parameters<typeof personnelListPage>[2];
  const read=(actor:SessionContext,page:Page,facets:Facets,candidate:boolean)=>withTenant(actor,async tx=>{
   await lockAccessConfigurationReadTx(tx,actor.tenantId);
   const [row]=await tx.execute<{rows:Awaited<ReturnType<typeof personnelListPage>>['rows'];total:number;status_counts:{status:string;count:number}[]}>(
    candidate?personnelReverseTailPrototype(page,facets):personnelListPageSql(page,facets,{source:sql`app.access_workforce_list_facts()`,materialized:true,projectPageFacts:true}));
   const byStatus=Object.fromEntries(row.status_counts.map(bucket=>[bucket.status,Number(bucket.count)]));
   return {rows:row.rows,total:Number(row.total),headcount:{total:row.status_counts.reduce((sum,bucket)=>sum+Number(bucket.count),0),byStatus}};
  });
  const companies=[b.companyId,foreign.companyId],base={companyIds:companies};
  const cases:{name:string;page:Page;facets:Facets;ids?:string[];total?:number}[]=[
   {name:'initial',page:{...base,limit:25,offset:0},facets:base,ids:allIds.slice(0,25),total:count},
   {name:'selective-search',page:{...base,q:'PERF000050000',limit:25,offset:0},facets:{...base,q:'PERF000050000'},ids:allIds.slice(-1),total:1},
   {name:'deep-page',page:{...base,limit:25,offset:count-25},facets:base,ids:allIds.slice(-25),total:count},
   {name:'partial-tail',page:{...base,limit:25,offset:count-7},facets:base,ids:allIds.slice(-7),total:count},
   {name:'beyond-end',page:{...base,limit:25,offset:count+1},facets:base,ids:[],total:count},
   {name:'zero-limit',page:{...base,limit:0,offset:count-1},facets:base,ids:[],total:count},
   {name:'company-sort',page:{...base,sort:'company',limit:25,offset:count-25},facets:base,ids:allIds.slice(-25),total:count},
   {name:'independent-status',page:{...base,status:'active',limit:25,offset:count*4/5-25},facets:base,ids:allIds.filter((_,index)=>(index+1)%5!==0).slice(-25),total:count*4/5},
   {name:'empty-scope',page:{companyIds:[],limit:25,offset:1},facets:{companyIds:[]},ids:[],total:0},
  ];
  const controls:unknown[]=[];
  for(const value of cases){
   phase(value.name);const reference=await personnelListPage(ctx,value.page,value.facets),observed=await read(ctx,value.page,value.facets,true);
   expect(observed).toEqual(reference);if(value.total!==undefined)expect(observed.total).toBe(value.total);
   if(value.ids)expect(observed.rows.map(row=>row.employmentId)).toEqual(value.ids);
   expect(observed.rows.some(row=>row.employmentId===foreignEmployment)).toBe(false);controls.push({name:value.name,exactRowsCountsFacetsOrder:true});
  }
  report.controls=controls;save();
  const timings:{mode:string;phase:string;reads:number;elapsedMs:number}[]=[];
  for(const name of ['initial','selective-search','deep-page','company-sort']){
   const value=cases.find(value=>value.name===name)!;const expected=await personnelListPage(ctx,value.page,value.facets);
   for(const namePhase of ['original','candidate','candidate-warm','restored']){
    const began=performance.now();for(let n=0;n<3;n++)expect(await read(ctx,value.page,value.facets,namePhase.startsWith('candidate'))).toEqual(expected);
    timings.push({mode:name,phase:namePhase,reads:3,elapsedMs:performance.now()-began});
   }
  }
  report.measurements=timings;save();
  // A duplicate current assignment changes raw page cardinality, never the DISTINCT employment total.
  await owner.client`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   values(${b.tenantId}::uuid,${allIds[count-5]}::uuid,${b.companyId}::uuid,${b.deptB}::uuid,'part_time','2021-01-01')`;
  for(const offset of [count-25,count-7,count-1,count,count+1]){
   const page={...base,limit:25,offset},expected=await personnelListPage(ctx,page,base);
   expect(expected.total).toBe(count);expect(await read(ctx,page,base,true)).toEqual(expected);
  }
  const independentPage={...base,departmentIds:[b.deptB],limit:25,offset:0},independentFacets={...base,departmentIds:[b.deptA]};
  expect(await read(ctx,independentPage,independentFacets,true)).toEqual(await personnelListPage(ctx,independentPage,independentFacets));
  report.assignmentFanoutAndIndependentFilters=true;
  const deep=cases.find(value=>value.name==='deep-page')!;
  await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;
  try{expect(await read(ctx,deep.page,deep.facets,true)).toEqual(await personnelListPage(ctx,deep.page,deep.facets));}
  finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
  const forged={...ctx,userId:randomUUID()};expect(await read(forged,deep.page,deep.facets,true)).toEqual(await personnelListPage(forged,deep.page,deep.facets));
  const foreignCtx={...adminCtx(foreign),grants:[{role:'hr_admin' as const,companyId:null}]};
  expect(await read(foreignCtx,deep.page,deep.facets,true)).toEqual(await personnelListPage(foreignCtx,deep.page,deep.facets));
  report.archivedForgedAndForeignResultsMatch=true;
  const plans:unknown[]=[];
  for(const candidate of [false,true])plans.push({candidate,plan:Array.from(await withTenant(ctx,async tx=>{
   await lockAccessConfigurationReadTx(tx,ctx.tenantId);
   return tx.execute(sql`explain(analyze,buffers,format json) ${candidate?personnelReverseTailPrototype(deep.page,deep.facets):personnelListPageSql(deep.page,deep.facets,{source:sql`app.access_workforce_list_facts()`,materialized:true,projectPageFacts:true})}`);
  }))});
  report.deepPlans=plans;
  const deepTimes=timings.filter(value=>value.mode==='deep-page');
  const ratio=Math.max(deepTimes[1].elapsedMs,deepTimes[2].elapsedMs)/Math.min(deepTimes[0].elapsedMs,deepTimes[3].elapsedMs);
  report.deepImprovementRatio=ratio;phase('complete');
  expect(ratio,'Both reverse-tail phases must improve at least20% against the faster native control').toBeLessThan(.8);
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{save();}
},600000);
