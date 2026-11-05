/** Hosted-only native lifecycle proof. Small actual writers and disposable projection objects. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {hireEmployee,updatePerson} from '../../core/org';
import {personnelListPage,personnelListPageSql} from '../../core/read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';

const file='test/performance/personnel-range-generation-proof.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const enabled=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
const schema='perf_personnel_generation';
const api='app.performance_personnel_generation_page(uuid[],uuid[],integer,integer,date)';
beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!enabled)('keeps a dirty Personnel generation hidden through real hire/profile writes, repair and revocation',async()=>{
 const evidence:Record<string,unknown>={kind:'PERSONNEL_GENERATION_LIFECYCLE_NATIVE_PROOF',releaseEligible:false,
  limits:'Tiny synthetic fixture. Row triggers, explicit owner builds and repairs. No write performance, production activation, online backfill, purge, bulk/import coverage or browser evidence.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-range-generation-proof.json'),JSON.stringify(evidence,null,2));
 const native=()=>owner.client`select oid::regprocedure::text,md5(prosrc) as body,proowner,proacl::text,proconfig from pg_proc where oid in
  ('app.access_workforce_list_facts()'::regprocedure,'app.access_workforce_list_rows_for_ids(uuid[])'::regprocedure) order by oid`;
 let before:unknown,installed=false;
 try{
  await resetDb();
  before=Array.from(await native());
  const base=await seedBase(),outside=await seedBase(),actor=adminCtx(base),foreignActor=adminCtx(outside),today=todayInKualaLumpur();
  const hire=(name:string,ctx=actor,companyId=base.companyId,departmentId=base.deptA,tx?:Tx)=>hireEmployee(ctx,{
   person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId,departmentId,employmentType:'full_time',hiredOn:today,
  },tx);
  const [other]=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name)
   values(${base.tenantId}::uuid,'Fictional separate company') returning id`;
  const [department]=await owner.client<{id:string}[]>`insert into department(tenant_id,company_id,name)
   values(${base.tenantId}::uuid,${other.id}::uuid,'Fictional department') returning id`;
  const target=await hire('Fictional Zulu');
  await hireEmployee(actor,{person:{id:target.personId},companyId:other.id,departmentId:department.id,
   employmentType:'full_time',hiredOn:today});
  await hire('Fictional Alpha');await hire('Fictional Equal');await hire('Fictional Equal');
  await hire('Fictional Separate',actor,other.id,department.id);
  await hire('Fictional Foreign',foreignActor,outside.companyId,outside.deptA);
  const scopedId=await createAppUser(base.tenantId,null,'hr_admin');
  await owner.client`update role_assignment set company_id=${base.companyId}::uuid where app_user_id=${scopedId}::uuid`;
  const scoped:SessionContext={...actor,userId:scopedId,grants:[{role:'hr_admin',companyId:base.companyId}]};

  const [collision]=await owner.client`select to_regnamespace(${schema}) as schema,to_regprocedure(${api}) as api`;
  expect(collision).toEqual({schema:null,api:null});
  await owner.client.begin(tx=>tx.unsafe(readFileSync(new URL('./personnel-range-generation-proof.sql',import.meta.url),'utf8')));
  installed=true;
  const [acl]=await owner.client`select has_schema_privilege('ai_hr_app',${schema},'USAGE') as raw_schema,
   has_function_privilege('ai_hr_app','perf_personnel_generation.repair(uuid,integer)','EXECUTE') as repair,
   has_function_privilege('ai_hr_app',${api},'EXECUTE') as read,
   not exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a
    where p.oid=to_regprocedure(${api}) and a.grantee=0) as no_public`;
  expect(acl).toEqual({raw_schema:false,repair:false,read:true,no_public:true});

  const generation=randomUUID();
  await owner.client`insert into perf_personnel_generation.head values(${base.tenantId}::uuid,${generation}::uuid,'building')`;
  const build=async()=>owner.client.begin(async tx=>{
   await tx`select generation from perf_personnel_generation.head where tenant_id=${base.tenantId}::uuid for update nowait`;
   await tx`delete from perf_personnel_generation.dirty where generation=${generation}::uuid`;
   await tx`delete from perf_personnel_generation.fact where generation=${generation}::uuid`;
   await tx`delete from perf_personnel_generation.boundary where generation=${generation}::uuid`;
   await tx`delete from perf_personnel_generation.range_count where generation=${generation}::uuid`;
   await tx`delete from perf_personnel_generation.lifecycle_count where generation=${generation}::uuid`;
   await tx`insert into perf_personnel_generation.fact
    select ${generation}::uuid,id,person_id,company_id,name,lifecycle,((row_number() over(order by name,id)-1)/2)::int
    from perf_personnel_generation.source where tenant_id=${base.tenantId}::uuid`;
   await tx`insert into perf_personnel_generation.boundary
    select distinct on (generation,block) generation,block,name,id from perf_personnel_generation.fact
    where generation=${generation}::uuid order by generation,block,name,id`;
   await tx`insert into perf_personnel_generation.range_count
    select generation,block,company_id,count(*) from perf_personnel_generation.fact where generation=${generation}::uuid group by 1,2,3`;
   await tx`insert into perf_personnel_generation.lifecycle_count
    select generation,company_id,lifecycle,count(*) from perf_personnel_generation.fact where generation=${generation}::uuid group by 1,2,3`;
  });
  const activate=async()=>owner.client.begin(async tx=>{
   await tx`select generation from perf_personnel_generation.head where tenant_id=${base.tenantId}::uuid for update nowait`;
   const changed=await tx`update perf_personnel_generation.head h set state='active' where h.tenant_id=${base.tenantId}::uuid
    and h.generation=${generation}::uuid and state='building'
    and not exists(select 1 from perf_personnel_generation.dirty d where d.generation=h.generation) returning h.generation`;
   return changed.length===1;
  });
  const state=async()=>{
   const [row]=await owner.client<{pending:number;facts:number}[]>`select
    (select count(*)::int from perf_personnel_generation.dirty where generation=${generation}::uuid) as pending,
    (select count(*)::int from perf_personnel_generation.fact where generation=${generation}::uuid) as facts`;
   return row;
  };
  const repair=async(cap:number)=>{
   const [row]=await owner.client<{repaired:number}[]>`select perf_personnel_generation.repair(${base.tenantId}::uuid,${cap}::int) as repaired`;
   return row.repaired;
  };
  const windows:{label:string;mode:string;offset:number;rows:number;total:number}[]=[];
  const array=(ids:string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  const compare=async(label:string,ctx:SessionContext,mode:'range'|'canonical',companies:string[],facets:string[],offset:number,limit=2)=>{
   const options={companyIds:companies,offset,limit};
   const facetOptions={companyIds:facets};
   const expected=await personnelListPage(ctx,options,facetOptions);
   const result=await withTenant(ctx,async tx=>{
    await lockAccessConfigurationReadTx(tx,ctx.tenantId);
    const original=personnelListPageSql(options,facetOptions,{source:sql`app.access_workforce_list_facts()`,materialized:true,projectPageFacts:true});
    const [row]=await tx.execute<{rows:unknown[];total:number;status_counts:{status:string;count:number}[];mode:string}>(sql`
     with candidate as materialized(
      select * from app.performance_personnel_generation_page(${array(companies)},${array(facets)},${limit}::int,${offset}::int,${today}::date)
     )
     select candidate.*,'range' as mode from candidate
     union all
     select baseline.*,'canonical' as mode from (${original}) baseline where not exists(select 1 from candidate)
    `);
    return row;
   });
   expect(result.mode).toBe(mode);
   expect({rows:result.rows,total:result.total,headcount:{total:result.status_counts.reduce((n,x)=>n+x.count,0),
    byStatus:Object.fromEntries(result.status_counts.map(x=>[x.status,x.count]))}}).toEqual(expected);
   windows.push({label,mode,offset,rows:result.rows.length,total:result.total});evidence.windows=windows;save();
   return result;
  };
  const all=[base.companyId,other.id,outside.companyId],main=[base.companyId],otherOnly=[other.id];
  await build();
  await compare('building remains canonical',actor,'canonical',all,main,0);
  await hire('Fictional Mutation During Build');
  expect(await activate()).toBe(false);
  expect((await state()).pending).toBeGreaterThan(0);
  await compare('changed build remains canonical',actor,'canonical',all,main,2);
  await build();
  expect(await activate()).toBe(true);
  await compare('initial active',actor,'range',all,main,0);
  await compare('independent facets',actor,'range',main,otherOnly,2);
  await compare('empty page scope',actor,'range',[],otherOnly,0);
  await compare('beyond end',actor,'range',all,main,100);
  await compare('zero limit',actor,'range',all,main,0,0);
  await compare('scoped before revoke',scoped,'range',all,all,0);
  await compare('foreign fallback',foreignActor,'canonical',all,all,0);
  evidence.activation={changeRefused:true,rebuiltAndActivated:true};save();

  const renamed='Fictional Aardvark';
  const rename=(fullName:string,tx?:Tx)=>updatePerson(actor,{personId:target.personId,fullName,primaryEmail:'person-proof@example.invalid'},tx);
  let entered!:()=>void,release!:()=>void;
  const enteredWriter=new Promise<void>(resolve=>{entered=resolve;});
  const holdWriter=new Promise<void>(resolve=>{release=resolve;});
  const writer=withTenant(actor,async tx=>{await rename(renamed,tx);entered();await holdWriter;});
  try{
   await Promise.race([enteredWriter,writer]);
   expect((await state()).pending).toBe(0);
   await expect(repair(1)).rejects.toMatchObject({code:'55P03'});
  }finally{release();await writer;}
  expect((await state()).pending).toBe(1);
  const dirty=await compare('committed rename uses canonical',actor,'canonical',all,main,0);
  expect(dirty.rows.some(row=>row&&typeof row==='object'&&'name' in row&&row.name===renamed)).toBe(true);
  const [oldName]=await owner.client`select name from perf_personnel_generation.fact where id=${target.employmentId}::uuid`;
  expect(oldName.name).toBe('Fictional Zulu');
  expect(await repair(1)).toBe(-1);
  expect((await state()).pending).toBe(1);
  const undo=new Error('rollback repair');
  await expect(owner.client.begin(async tx=>{
   const [row]=await tx<{repaired:number}[]>`select perf_personnel_generation.repair(${base.tenantId}::uuid,2) as repaired`;
   expect(row.repaired).toBe(1);
   throw undo;
  })).rejects.toBe(undo);
  expect((await state()).pending).toBe(1);
  const [rollbackName]=await owner.client`select name from perf_personnel_generation.fact where id=${target.employmentId}::uuid`;
  expect(rollbackName).toEqual(oldName);
  expect(await repair(2)).toBe(1);
  await updatePerson(actor,{personId:target.personId,fullName:renamed,primaryEmail:'person-proof@example.invalid',homePhone:'03-90000101'});
  expect((await state()).pending).toBe(0);
  await compare('repaired rename',actor,'range',all,main,0);
  await compare('repaired deep page',actor,'range',all,main,2);
  evidence.rename={uncommittedMarkerInvisible:true,repairRefusedBusyHead:true,multipleEmploymentsExceededCap:true,rollbackPreservedMarkerAndFact:true,nonOrderingEditDidNotDirty:true};save();

  const hired=await hire('Fictional New Employee');
  expect((await state()).pending).toBeGreaterThan(0);
  await compare('committed hire uses canonical',actor,'canonical',all,main,0);
  const [projectedBefore]=await owner.client`select exists(select 1 from perf_personnel_generation.fact where id=${hired.employmentId}::uuid) as present`;
  expect(projectedBefore.present).toBe(false);
  const firstBatch=await repair(1);
  expect(firstBatch).toBe(1);
  expect((await state()).pending).toBeGreaterThan(0);
  await compare('one batch leaves unresolved markers canonical',actor,'canonical',all,main,2);
  expect(await repair(8)).toBeGreaterThan(0);
  expect((await state()).pending).toBe(0);
  await compare('repaired hire deep page',actor,'range',all,main,2);
  await compare('repaired hire independent facets',actor,'range',otherOnly,main,0);

  await owner.client`delete from role_assignment where app_user_id=${scopedId}::uuid`;
  expect((await state()).pending).toBe(0);
  const denied=await compare('revoked stale scope clean generation',scoped,'range',all,all,0);
  expect(denied.rows).toEqual([]);expect(denied.total).toBe(0);expect(denied.status_counts).toEqual([]);
  await rename('Fictional Dirty After Revocation');
  expect((await compare('revoked stale scope dirty generation',scoped,'canonical',all,all,0)).total).toBe(0);
  expect(await repair(8)).toBeGreaterThan(0);
  expect((await state()).pending).toBe(0);
  await compare('final exact parity',actor,'range',all,main,2);
  evidence.completed=true;save();
 }finally{
  if(installed){
   await owner.client.begin(async tx=>{
    await tx.unsafe('drop function '+api);
    await tx.unsafe('drop trigger perf_personnel_generation_company on public.company');
    await tx.unsafe('drop trigger perf_personnel_generation_employment on public.employment');
    await tx.unsafe('drop trigger perf_personnel_generation_person on public.person');
    await tx.unsafe('drop schema '+schema+' cascade');
   });
   const [remaining]=await owner.client`select to_regnamespace(${schema}) as schema,to_regprocedure(${api}) as api`;
   expect(remaining).toEqual({schema:null,api:null});
  }
  if(before)expect(Array.from(await native())).toEqual(before);
  evidence.prototypeObjectsRemoved=installed;evidence.nativePredecessorsUnchanged=Boolean(before);save();
 }
},120_000);
