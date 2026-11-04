/** Explicit hosted retained-data diagnosis only; native row triggers/constraints remain enabled. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {personnelListPage} from '../../core/read';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {withTenant,type SessionContext} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import {personnelNativeAggregatePrototype} from './personnel-native-aggregate-prototype';
const file='test/performance/personnel-split-count-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('compares split exact counts and ordering indexes over fifty thousand retained Personnel records',async()=>{
 const count=50_000,started=performance.now();
 const report:Record<string,unknown>={kind:'PERSONNEL_SPLIT_COUNT_50K_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,queryTargetMs:1000,fixtureBatchRows:5000,nativeTriggers:'unchanged',limitations:'Retained synthetic owner fixture, not hiring/import throughput, browser timing, one-million Personnel or500-user capacity.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-split-count-plan.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};
 try{
  expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
  await resetDb();const b=await seedBase(),foreign=await seedBase();
  const ctx:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
  const expectedFirst:string[]=[],expectedLast:string[]=[],allIds:string[]=[];
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
   for(let n=offset+1;n<=end;n++)allIds.push(employmentPrefix+String(n).padStart(12,'0'));
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
  const [factsOwner]=await owner.client<{body:string;owner:string;columns:string[];ddl:string;acl:string|null}[]>`select prosrc as body,proowner::regrole::text as owner,proargnames as columns,pg_get_functiondef(oid)as ddl,proacl::text as acl from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
  const indexNames=['performance_personnel_order_probe','performance_personnel_current_assignment_probe'];
  const results:unknown[]=[],createdIndexes:string[]=[];
  const normalize=(raw:{rows:unknown[];total:number;status_counts:{status:string;count:number}[]})=>({rows:raw.rows,total:Number(raw.total),headcount:{total:raw.status_counts.reduce((n,row)=>n+Number(row.count),0),byStatus:Object.fromEntries(raw.status_counts.filter(row=>Number(row.count)>0).map(row=>[row.status,Number(row.count)]))}});
  const modes=['initial','selective-search','deep-page','active-page-all-status-facets','company-sort-assignment-filter','zero-page'];
  const runVariant=async(indexed:boolean)=>{
   for(const mode of modes){
    const q=mode==='selective-search'?'PERF000050000':undefined;
    const page:Parameters<typeof personnelListPage>[1]={companyIds:companies,q,limit:mode==='zero-page'?0:25,offset:mode==='deep-page'?count-25:0};
    if(mode==='active-page-all-status-facets')page.status='active';
    if(mode==='company-sort-assignment-filter'){page.sort='company';page.departmentId=b.deptA;page.employmentType='full_time';}
    const facets={companyIds:companies,q};
    phase((indexed?'indexed-':'unindexed-')+mode);const baselineStart=performance.now(),expected=await personnelListPage(ctx,page,facets),baselineMs=performance.now()-baselineStart;
    expect(expected.total).toBe(q?1:page.status==='active'?count*4/5:count);expect(expected.headcount.total).toBe(q?1:count);
    const ids=mode==='zero-page'?[]:q?[allIds.at(-1)!]:page.status==='active'?allIds.filter((_,i)=>(i+1)%5!==0).slice(0,25):page.offset?expectedLast:expectedFirst;
    expect(expected.rows.map(row=>row.employmentId)).toEqual(ids);
    for(const splitCounts of [false,true]){
     const prototype=await personnelNativeAggregatePrototype(page,facets,factsOwner,false,splitCounts);
     try{
      const observed=await withTenant(ctx,async tx=>{
       await lockAccessConfigurationReadTx(tx,ctx.tenantId);const began=performance.now();
       const [raw]=await tx.execute<{rows:typeof expected.rows;total:number;status_counts:{status:string;count:number}[]}>(prototype.query);
       const elapsedMs=performance.now()-began;expect(normalize(raw)).toEqual(expected);
       const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${prototype.query}`));
       return {mode,indexed,splitCounts,baselineMs,elapsedMs,targetMet:elapsedMs<1000,exactRowsCountsFacetsOrder:true,plan};
      });results.push(observed);report.comparisons=results;save();
      await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;
      try{const [denied]=await withTenant(ctx,tx=>tx.execute<{rows:unknown[];total:number;status_counts:unknown[]}>(prototype.query));expect(denied).toEqual({rows:[],total:0,status_counts:[]});}
      finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
      const foreignCtx={...adminCtx(foreign),grants:[{role:'hr_admin' as const,companyId:null}]},foreignExpected=await personnelListPage(foreignCtx,page,facets);
      const [foreignRaw]=await withTenant(foreignCtx,tx=>tx.execute<{rows:typeof expected.rows;total:number;status_counts:{status:string;count:number}[]}>(prototype.query));
      expect(normalize(foreignRaw)).toEqual(foreignExpected);expect(foreignRaw.rows.every(row=>row.companyId===foreign.companyId)).toBe(true);
     }finally{await prototype.drop();}
    }
   }
  };
  try{
   await runVariant(false);
   for(const name of indexNames){const [row]=await owner.client`select to_regclass(${'public.'+name})as relation`;expect(row.relation).toBeNull();}
   await owner.client.unsafe('create index '+indexNames[0]+' on public.person(tenant_id,full_name,id)');
   createdIndexes.push(indexNames[0]);
   await owner.client.unsafe('create index '+indexNames[1]+' on public.assignment(tenant_id,employment_id)where valid_to is null and superseded_at is null');
   createdIndexes.push(indexNames[1]);
   for(const table of ['person','employment','assignment'])await owner.client.unsafe('analyze '+table);
   report.indexBytes=await owner.client`select relname,pg_relation_size(oid)::text as bytes from pg_class where relname=any(${indexNames}::text[])order by relname`;
   await runVariant(true);
   report.purposeRefusals=true;
  }finally{
   for(const name of [...createdIndexes].reverse())await owner.client.unsafe('drop index if exists public.'+name);
   const [after]=await owner.client`select prosrc as body,proowner::regrole::text as owner,proargnames as columns,pg_get_functiondef(oid)as ddl,proacl::text as acl from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
   expect(after).toEqual(factsOwner);report.originalFactsFunctionUnchanged=true;report.prototypeIndexesDropped=true;save();
  }
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{save();}
},600000);
