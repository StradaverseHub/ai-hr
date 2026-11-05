/** Hosted proof of a data-only ordered projection and exact date-signature counts.
 * This test does not propose a migration, install writers or demonstrate million-row capacity. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {personnelListPage,personnelListPageSql} from '../../core/read';
import {withTenant,type SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import {installDisposableRangeWriter,lifecycleDates,type NativeWriterTx} from './personnel-range-writer-proof';

const file='test/performance/personnel-exact-order-proof.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('measures 50k exact initial and deep Personnel pages across skewed authorized scopes',async()=>{
 const report:Record<string,unknown>={kind:'PERSONNEL_50K_EXACT_ORDER_RANGES_ROLLBACK_WRITER_ONLY',releaseEligible:false,
  limitations:'Disposable owner-driven projection, rollback-only writer and overlapping reader, no live trigger or same-key contention proof, no assignment/text/status filters or retained-million proof.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-exact-order-proof.json'),JSON.stringify(report,null,2));
 const modeNames=['name','company'] as const;
 const typeList='uuid[],uuid[],integer,integer,date';
 const args='page_companies uuid[],facet_companies uuid[],page_size integer,page_offset integer,as_of date';
 const joins='from public.employment e join public.person p on p.id=e.person_id and p.tenant_id=e.tenant_id join public.company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.voided_at is null';
 const dates=lifecycleDates.map(date=>'e.'+date).join(',');
 const ddl:string[]=[];
 const create=async(statement:string,drop:string)=>{await owner.client.unsafe(statement);ddl.unshift(drop);};
 const native=()=>owner.client`select oid::regprocedure::text as signature,prosrc,proowner::regrole::text as owner,proacl::text as acl,proconfig from pg_proc where oid=any(array['app.access_workforce_list_facts()'::regprocedure,'app.access_workforce_list_rows_for_ids(uuid[])'::regprocedure]) order by oid`;
 let before:unknown;
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
  before=Array.from(await native());
  // The second company deliberately ties the first in case-folded company ordering.
  const [other]=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select tenant_id,upper(legal_name) from company where id=${b.companyId}::uuid returning id`;
  const today=todayInKualaLumpur(), p=randomUUID().slice(0,24),e=randomUUID().slice(0,24);
  const count=50_000, blockSize=128, fixtureStarted=performance.now();
  const sparseCount=Math.floor(count/101)-Math.floor(count/404);
  const [sparse]=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name)
   values(${b.tenantId}::uuid,'ZZZ Fictional sparse company') returning id`;
  const department=async(companyId:string)=>{
   const [row]=await owner.client<{id:string}[]>`insert into department(tenant_id,company_id,name)
    values(${b.tenantId}::uuid,${companyId}::uuid,'Fictional scale department') returning id`;
   return row.id;
  };
  const otherDepartment=await department(other.id),sparseDepartment=await department(sparse.id);
  report.fixture={count,blockSize,companies:3,sparseCount,secondCompanyCount:count/4,
   ties:'Case-folded company ties, repeated accented/case-sensitive names; sparse company interleaves in name order'};
  const batches=Array.from({length:count/5000},(_,i)=>({from:i*5000+1,to:(i+1)*5000}));
  for(const {from,to} of batches){
   await owner.client.begin(async tx=>{
    await tx`insert into person(id,tenant_id,full_name,primary_email)
     select (${p}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
      case when n%11=0 then 'Accent Á' when n%7=0 then 'accent á' else 'Person '||lpad(n::text,6,'0') end,
      (${p}||n::text)||'@example.invalid' from generate_series(${from}::integer,${to}::integer)n`;
    await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on,resignation_date,final_confirmation_date,provisional_end_on,blacklisted_at)
     select (${e}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
      (${p}||lpad(n::text,12,'0'))::uuid,case when n%4=0 then ${other.id}::uuid when n%101=0 then ${sparse.id}::uuid else ${b.companyId}::uuid end,
      'ORDER-'||lpad(n::text,8,'0'),date '2020-01-01',case when n%9=0 then ${today}::date end,case when n%10=0 then ${today}::date+1 end,
      case when n%13=0 then ${today}::date when n%19=0 then ${today}::date-(n%547) end,case when n%13<2 then ${today}::date+1 end,case when n%23=0 then ${today}::date end
      from generate_series(${from}::integer,${to}::integer)n`;
    await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
     select ${b.tenantId}::uuid,(${e}||lpad(n::text,12,'0'))::uuid,
      case when n%4=0 then ${other.id}::uuid when n%101=0 then ${sparse.id}::uuid else ${b.companyId}::uuid end,
      case when n%4=0 then ${otherDepartment}::uuid when n%101=0 then ${sparseDepartment}::uuid else ${b.deptA}::uuid end,
      'full_time',date '2020-01-01' from generate_series(${from}::integer,${to}::integer)n where n%23<>0`;
   });
   report.committedFixtureEmployees=to;save();
  }
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment']){
   await owner.client.unsafe('analyze '+table);
  }
  report.fixturePreparationMs=performance.now()-fixtureStarted;
  const projectionStarted=performance.now();
  const fp=randomUUID(),fe=randomUUID();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email) values(${fp}::uuid,${foreign.tenantId}::uuid,'AAA outside',${fp+'@example.invalid'})`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${fe}::uuid,${foreign.tenantId}::uuid,${fp}::uuid,${foreign.companyId}::uuid,date '2020-01-01')`;
  await create('create table app.performance_personnel_order as select e.tenant_id,e.company_id,e.id as employment_id,p.full_name as name,lower(p.full_name) as name_folded,lower(c.legal_name) as company_folded,'+
   '((row_number()over(partition by e.tenant_id order by p.full_name,e.id)-1)/'+blockSize+')::int as name_block,'+
   '((row_number()over(partition by e.tenant_id order by lower(c.legal_name),lower(p.full_name),e.id)-1)/'+blockSize+')::int as company_block,'+dates+' '+joins,'drop table app.performance_personnel_order');
  await create('create table app.performance_personnel_count as select e.tenant_id,e.company_id,'+dates+',count(*) as quantity '+joins+' group by 1,2,3,4,5,6,7,8,9,10','drop table app.performance_personnel_count');
  await owner.client`create index performance_personnel_order_name on app.performance_personnel_order(tenant_id,name,employment_id) include(company_id)`;
  await owner.client`create index performance_personnel_order_company on app.performance_personnel_order(tenant_id,company_folded,name_folded,employment_id) include(company_id)`;
  await create('create table app.performance_personnel_blocks as '+
   "select tenant_id,company_id,'name'::text as sort,name_block as block_no,count(*) as quantity from app.performance_personnel_order group by 1,2,3,4 "+
   "union all select tenant_id,company_id,'company'::text,company_block,count(*) from app.performance_personnel_order group by 1,2,3,4",
   'drop table app.performance_personnel_blocks');
  await owner.client`create index performance_personnel_range_name on app.performance_personnel_order(tenant_id,name_block,name,employment_id) include(company_id)`;
  await owner.client`create index performance_personnel_range_company on app.performance_personnel_order(tenant_id,company_block,company_folded,name_folded,employment_id) include(company_id)`;
  await owner.client`create unique index performance_personnel_block_count on app.performance_personnel_blocks(tenant_id,sort,company_id,block_no) include(quantity)`;
  await owner.client`create unique index performance_personnel_order_subject on app.performance_personnel_order(employment_id)`;
  await owner.client.unsafe('create unique index performance_personnel_signature_key on app.performance_personnel_count(tenant_id,company_id,'+
   lifecycleDates.join(',')+') nulls not distinct');
  const refresh=await installDisposableRangeWriter(create);
  await owner.client`vacuum (analyze) app.performance_personnel_order`;
  await owner.client`analyze app.performance_personnel_blocks`;
  await owner.client`analyze app.performance_personnel_count`;
  const [sizes]=await owner.client`select (select count(*)::int from app.performance_personnel_order) as ordered,(select count(*)::int from app.performance_personnel_count) as signatures,
   (select count(*)::int from app.performance_personnel_blocks) as range_signatures,
   pg_total_relation_size('app.performance_personnel_order'::regclass) as order_bytes,
   pg_total_relation_size('app.performance_personnel_count'::regclass) as count_bytes,
   pg_total_relation_size('app.performance_personnel_blocks'::regclass) as block_bytes,
   pg_total_relation_size('app.performance_personnel_name_bounds'::regclass)+
    pg_total_relation_size('app.performance_personnel_company_bounds'::regclass) as bound_bytes`;
  report.sizes=sizes;report.projectionPreparationMs=performance.now()-projectionStarted;save();
  expect(Number(sizes.ordered)).toBe(count+1);
  expect(Number(sizes.signatures)).toBeLessThan(Number(sizes.ordered)/10);
  const namespace='app.performance_personnel_exact_';
  for(const mode of modeNames)for(const ranged of [false,true]){
   const order=mode==='name'?'o.name,o.employment_id':'o.company_folded,o.name_folded,o.employment_id';
   const block='o.'+mode+'_block', scanOrder=ranged?block+','+order:order;
   // Block numbers follow exact order. Reapply canonical name/ID order after joining details.
   const orderAfter=order.replaceAll('o.','chosen.');
   const blocks=ranged?`ranked_blocks as (
    select b.block_no,sum(b.quantity)::bigint as quantity,
     sum(sum(b.quantity))over(order by b.block_no rows unbounded preceding)::bigint as running_qty
    from app.performance_personnel_blocks b where b.tenant_id=app.current_tenant_id()
     and b.sort='${mode}' and b.company_id=any($1) and b.company_id in(select id from permitted) group by b.block_no
   ), anchor as materialized(
    select block_no,($4-(running_qty-quantity))::int as local_offset from ranked_blocks where running_qty>$4 order by block_no limit 1
   ),`:'';
   const lowerBound=ranged?'and '+block+'>=(select block_no from anchor)':'';
   const offset=ranged?'(select local_offset from anchor)':'$4';
   const sortFields=mode==='name'?'o.name':'o.company_folded,o.name_folded';
   const query=`
    with permitted as materialized(
     select c.id from public.company c where c.tenant_id=app.current_tenant_id() and app.access_workforce_projection_company(c.id)
    ), ${blocks} selected as materialized(
     select o.employment_id,${sortFields} from app.performance_personnel_order o
     where o.tenant_id=app.current_tenant_id() and o.company_id=any($1) and o.company_id in(select id from permitted)
     ${lowerBound} order by ${scanOrder} limit $3 offset ${offset}
    ), details(value) as materialized(
     select value from app.access_workforce_list_rows_for_ids(array(select employment_id from selected))v(value)
    ), totals as materialized(
     select app.employment_status_on(s.blacklisted_at::timestamptz,s.resignation_date,s.last_working_date,s.terminated_on,
      s.final_confirmation_date,s.confirmation_date,s.probation_end_date,s.provisional_end_on,$5) as status,
      sum(s.quantity) filter(where s.company_id=any($1))::int as page_count,
      sum(s.quantity) filter(where s.company_id=any($2))::int as facet_count
     from app.performance_personnel_count s where s.tenant_id=app.current_tenant_id()
      and s.company_id in(select id from permitted) and (s.company_id=any($1) or s.company_id=any($2)) group by 1
    )
    select coalesce((select jsonb_agg(d.value order by ${orderAfter}) from selected chosen
      join details d on (d.value->>'employmentId')::uuid=chosen.employment_id),'[]'::jsonb),
      coalesce((select sum(page_count)::int from totals),0),
      coalesce((select jsonb_agg(jsonb_build_object('status',status,'count',facet_count)) from totals where facet_count>0),'[]'::jsonb)
   `;
   const base=namespace+mode+(ranged?'_range':''), explain=base+'_plan';
   await create('create function '+base+'('+args+') returns table(rows jsonb,total integer,status_counts jsonb) language sql stable security definer set search_path=pg_catalog,public,pg_temp as $q$'+query+'$q$','drop function '+base+'('+typeList+')');
   await create('create function '+explain+'('+args+') returns json language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $fn$ declare result json;begin execute $q$explain(analyze,buffers,format json) '+query+'$q$ into result using page_companies,facet_companies,page_size,page_offset,as_of;return result;end $fn$','drop function '+explain+'('+typeList+')');
   for(const name of [base,explain])await owner.client.unsafe('revoke all on function '+name+'('+typeList+') from public;grant execute on function '+name+'('+typeList+') to ai_hr_app');
  }
  const [acl]=await owner.client`select has_table_privilege('ai_hr_app','app.performance_personnel_order','SELECT') as raw_order,
   has_table_privilege('ai_hr_app','app.performance_personnel_count','SELECT') as raw_count,
   has_table_privilege('ai_hr_app','app.performance_personnel_blocks','SELECT') as raw_blocks,
   not exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a where p.pronamespace='app'::regnamespace and p.proname like 'performance_personnel_exact_%' and a.grantee=0) as no_public`;
  expect(acl).toEqual({raw_order:false,raw_count:false,raw_blocks:false,no_public:true});report.acl=acl;
  const all=[b.companyId,other.id,sparse.id,foreign.companyId], narrow=[b.companyId];
  const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');
  await owner.client`update role_assignment set company_id=${b.companyId}::uuid where app_user_id=${scopedUser}::uuid`;
  const scoped:SessionContext={...ctx,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const comparisons:Record<string,unknown>[]=[];
  type PageResult={rows:unknown[];total:number;status_counts:{status:string;count:number}[]};
  type Comparison={rows:unknown[];total:number;statusCounts:Partial<Record<string,number>>};
  const normalize=(row:PageResult):Comparison=>({
   rows:row.rows,total:Number(row.total),statusCounts:Object.fromEntries(row.status_counts.map(x=>[x.status,Number(x.count)])),
  });
  const uuidArray=(ids:string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  const queryCandidate=async(actor:SessionContext,mode:typeof modeNames[number],pageCompanies:string[],facetCompanies:string[],
    limit:number,offset:number,ranged:boolean,explain=false)=>{
   const params=sql`${uuidArray(pageCompanies)},${uuidArray(facetCompanies)},${limit}::integer,${offset}::integer,${today}::date`;
   const functionName=namespace+mode+(ranged?'_range':'');
   return withTenant(actor,async tx=>{
    await lockAccessConfigurationReadTx(tx,actor.tenantId);
    const [row]=await tx.execute<PageResult>(sql`select * from ${sql.raw(functionName)}(${params})`);
    const [result]=explain?await tx.execute<{plan:unknown}>(sql`select ${sql.raw(functionName+'_plan')}(${params}) as plan`):[];
    return {row,plan:result?.plan};
   });
  };
  const compare=async(actor:SessionContext,mode:typeof modeNames[number],pageCompanies:string[],facetCompanies:string[],limit:number,offset:number,explain:boolean,ranged=false)=>{
   const before=await personnelListPage(actor,{companyIds:pageCompanies,limit,offset,sort:mode},{companyIds:facetCompanies});
   const {row,plan}=await queryCandidate(actor,mode,pageCompanies,facetCompanies,limit,offset,ranged,explain);
   const byStatus=Object.fromEntries(row.status_counts.map(v=>[v.status,Number(v.count)]));
   expect({rows:row.rows,total:Number(row.total),headcount:{byStatus,total:Object.values(byStatus).reduce((n,v)=>n+v,0)}}).toEqual(before);
   comparisons.push({mode,ranged,limit,offset,rows:row.rows.length,total:row.total,plan});report.comparisons=comparisons;save();
  };
  for(const mode of modeNames){
   await compare(ctx,mode,all,all,25,0,true);
   await compare(ctx,mode,all,narrow,25,count-25,true);
   await compare(ctx,mode,narrow,all,25,0,true);
   await compare(ctx,mode,all,all,25,count+1,false);
   await compare(ctx,mode,all,all,0,0,false);
   await compare(ctx,mode,[],all,25,0,false);
   await compare(ctx,mode,all,[],25,0,false);
   await compare(scoped,mode,all,all,25,0,false);
   await compare({...ctx,userId:randomUUID()},mode,all,all,25,0,false);
   await compare(adminCtx(foreign),mode,all,all,25,0,false);
  }
  for(const mode of modeNames){
   await compare(ctx,mode,all,all,25,0,true,true);
   await compare(ctx,mode,all,narrow,25,count-25,true,true);
   await compare(ctx,mode,[other.id],all,25,count/4-25,true,true);
   await compare(ctx,mode,[sparse.id],all,25,sparseCount-25,true,true);
   await compare(ctx,mode,all,all,25,blockSize-1,false,true);
   await compare(ctx,mode,all,all,25,blockSize,false,true);
   await compare(ctx,mode,all,all,25,count+1,false,true);
   await compare(ctx,mode,all,all,0,0,false,true);
   await compare(ctx,mode,[],all,25,0,false,true);
   await compare(scoped,mode,all,all,25,0,false,true);
   await compare({...ctx,userId:randomUUID()},mode,all,all,25,0,false,true);
  }
  await owner.client`update app_user set archived_at=now() where id=${b.adminUserId}::uuid`;
  try{await compare(ctx,'name',all,all,25,0,false);await compare(ctx,'name',all,all,25,0,false,true);}finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
  await owner.client`update role_assignment set company_id=${other.id}::uuid where app_user_id=${scopedUser}::uuid`;
  try{await compare(scoped,'name',all,all,25,0,false);await compare(scoped,'name',all,all,25,0,false,true);}finally{await owner.client`update role_assignment set company_id=${b.companyId}::uuid where app_user_id=${scopedUser}::uuid`;}
  const nodes=(node:unknown):Record<string,unknown>[]=>{
   if(Array.isArray(node))return node.flatMap(nodes);
   if(!node||typeof node!=='object')return [];
   const record=node as Record<string,unknown>;
   return [...(record['Node Type']?[record]:[]),...Object.values(record).flatMap(nodes)];
  };
  const indexVisits=comparisons.filter(c=>c.plan).map(c=>{
   const allNodes=nodes(c.plan),index=allNodes.find(n=>n['Index Name']==='performance_personnel_'+(c.ranged?'range':'order')+'_'+c.mode);
   const countScan=allNodes.find(n=>n['Relation Name']==='performance_personnel_count');
   return {mode:c.mode,ranged:c.ranged,limit:c.limit,offset:c.offset,indexUsed:!!index,indexKind:index?.['Node Type'],
    indexOutputRows:index?.['Actual Rows'],indexFilteredRows:index?.['Rows Removed by Filter'],heapFetches:index?.['Heap Fetches'],countInputRows:countScan?.['Actual Rows'],blockInputRows:allNodes.find(n=>n['Relation Name']==='performance_personnel_blocks')?.['Actual Rows']};
  });
  report.indexVisits=indexVisits;save();
  // The first page must get the expected native index with normal planner settings.
  for(const mode of modeNames){
   expect(indexVisits.find(c=>c.mode===mode&&!c.ranged&&c.offset===0)?.indexUsed).toBe(true);
   const jump=indexVisits.find(c=>c.mode===mode&&c.ranged&&c.offset===count-25);
   expect(jump?.indexUsed,'deep numbered jump uses an ordered range index').toBe(true);
   expect(Number(jump?.indexOutputRows),'deep numbered jump reads only the local offset and requested rows').toBeLessThanOrEqual(blockSize+25);
  }

  // All base and projection mutations below are rolled back. No live trigger or grant is installed.
  const suffix=(n:number)=>String(n).padStart(12,'0');
  const duplicateId=randomUUID(),renameId=p+suffix(count-1),existingRenameEmployment=e+suffix(count-1),
   transferId=e+suffix(count),lifecycleId=e+suffix(count-3);
  const changedIds=[duplicateId,existingRenameEmployment,transferId,lifecycleId];
  const writeSet=async(tx:NativeWriterTx)=>{
   // A person can hold jobs in multiple companies; both ordered keys must reflect a rename.
   await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
    values(${duplicateId}::uuid,${b.tenantId}::uuid,${renameId}::uuid,${other.id}::uuid,'FIXED-RANGE-INSERT',date '2020-01-01')`;
   await tx`update person set full_name='A Writer Reordered Person' where id=${renameId}::uuid`;
   await tx`update employment set company_id=${b.companyId}::uuid where id=${transferId}::uuid`;
   await tx`update employment set resignation_date=${today}::date+2 where id=${lifecycleId}::uuid`;
  };
  const dialect=new PgDialect();
  const asNativeReader=async(tx:NativeWriterTx,run:()=>Promise<void>)=>{
   await tx`set local role ai_hr_app`;
   try{
    await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),
     set_config('app.roles',${ctx.roles?.join(',')??''},true),set_config('app.grants',${JSON.stringify(ctx.grants??ctx.roles?.map(role=>({role,companyId:null}))??[])},true)`;
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+ctx.tenantId},0))`;
    const [role]=await tx`select current_user as role,app.principal_snapshot_current() as allowed`;
    expect(role).toEqual({role:'ai_hr_app',allowed:true});await run();
   }finally{await tx`reset role`;}
  };
  const readWithinWriter=async(tx:NativeWriterTx,expectedTotal:number)=>{
   await asNativeReader(tx,async()=>{
    const [writerAccess]=await tx`select has_function_privilege(current_user,'app.performance_personnel_refresh_order(uuid[])','EXECUTE') as execute`;
    expect(writerAccess.execute).toBe(false);
    for(const mode of modeNames)for(const [pageScope,facets,offset,limit] of [
     [all,narrow,0,25],[all,narrow,count-25,25],[[other.id],narrow,count/4-25,25],[all,all,0,0],
    ] as const){
     const pageIds=[...pageScope],facetIds=[...facets];
     const native=personnelListPageSql({companyIds:pageIds,limit,offset,sort:mode},{companyIds:facetIds},
      {source:sql`app.access_workforce_list_facts()`,materialized:true,projectPageFacts:true});
     const compiled=dialect.sqlToQuery(native);
     type Row={rows:unknown[];total:number;status_counts:{status:string;count:number}[]};
     const [expected]=await tx.unsafe<Row[]>(compiled.sql,compiled.params as (string|number|boolean|null)[]);
     const [actual]=await tx.unsafe<Row[]>('select * from '+namespace+mode+'_range($1::uuid[],$2::uuid[],$3::int,$4::int,$5::date)',
      [pageIds,facetIds,limit,offset,today]);
     expect(normalize(actual)).toEqual(normalize(expected));
     if(pageIds.length===all.length)expect(Number(actual.total)).toBe(expectedTotal);
    }
   });
  };
  const rolled=new Error('rollback only');
  const rollback=async(fn:(tx:NativeWriterTx)=>Promise<void>)=>{
   try{await owner.client.begin(async tx=>{await fn(tx);throw rolled;});}
   catch(error){if(error!==rolled)throw error;}
  };
  const timings:{stage:string;durationsMs:number[]}[]=[];
  for(const stage of ['original','with-deltas','with-deltas-warm','restored']){
   const durationsMs:number[]=[];
   for(let i=0;i<3;i++)await rollback(async tx=>{
    const began=performance.now();
    await writeSet(tx);
    if(stage.startsWith('with-deltas'))await refresh(tx,changedIds);
    durationsMs.push(performance.now()-began);
   });
   timings.push({stage,durationsMs});
  }
  const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
  report.writeTimings=timings;save();
  const entered=barrier(),release=barrier();
  let writerPid:number|undefined;
  const writer=rollback(async tx=>{
   const [identity]=await tx`select pg_backend_pid() as pid`;writerPid=identity.pid;
   await writeSet(tx);await refresh(tx,changedIds);
   await readWithinWriter(tx,count+1);
   report.insideWriterExact=true;save();
   entered.resolve();await release.promise;
  });
  const bounded=async<T>(task:Promise<T>,description:string)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(description)),5000);})]);}
   finally{if(timer)clearTimeout(timer);}
  };
  const readCandidate=()=>withTenant(ctx,async tx=>{
   await lockAccessConfigurationReadTx(tx,ctx.tenantId);
   const array=(ids:string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
   const [row]=await tx.execute<{rows:unknown[];total:number;status_counts:{status:string;count:number}[]}>(sql`
    select * from ${sql.raw(namespace+'name_range')}(${array(all)},${array(narrow)},25,${count-25}::int,${today}::date)
   `);
   return normalize(row);
  });
  const readers:Promise<unknown>[]=[];
  let outsideReader:Promise<void>|undefined,independentWriter:Promise<void>|undefined,outsideReaderMs=0,independentWriterMs=0;
  try{
   await bounded(Promise.race([entered.promise,writer]),'writer did not reach the uncommitted checkpoint');
   // The base employment insert/transfer/lifecycle triggers deliberately hold the exclusive
   // Access key. Verify both actual paths wait on it; do not bypass it to test MVCC.
   readers.push(personnelListPage(ctx,{companyIds:all,limit:25,offset:count-25},{companyIds:narrow}),readCandidate());
   const stop=Date.now()+5000;let waiting=0;
   while(waiting<2&&Date.now()<stop){
    const [row]=await owner.client`select count(*)::int as waiting from pg_locks where locktype='advisory'
     and mode='ShareLock' and not granted and ${writerPid!}::int=any(pg_blocking_pids(pid))`;
    waiting=Number(row.waiting);if(waiting<2)await new Promise(resolve=>setTimeout(resolve,25));
   }
   report.waitingReaders=waiting;save();expect(waiting).toBe(2);
   const [invisible]=await owner.client`select exists(select 1 from employment where id=${duplicateId}::uuid) as base,
    exists(select 1 from app.performance_personnel_order where employment_id=${duplicateId}::uuid) as projection`;
   expect(invisible).toEqual({base:false,projection:false});
   const outsideStart=performance.now();
   outsideReader=compare(adminCtx(foreign),'name',[foreign.companyId],[foreign.companyId],25,0,false,true);
   await bounded(outsideReader,'independent tenant reader did not finish while base/projection writes were uncommitted');
   outsideReaderMs=performance.now()-outsideStart;
   const writerStart=performance.now();
   independentWriter=rollback(async tx=>{
    await tx`update person set full_name='AAA independent writer' where id=${fp}::uuid`;
    await refresh(tx,[fe]);
   });
   await bounded(independentWriter,'independent writer did not finish while first writer held its changes');
   independentWriterMs=performance.now()-writerStart;
  }finally{release.resolve();await Promise.allSettled([writer,...readers,...(outsideReader?[outsideReader]:[]),...(independentWriter?[independentWriter]:[])]);}
  await writer;
  const [ordinary,ranged]=await Promise.all(readers);
  const old=ordinary as Awaited<ReturnType<typeof personnelListPage>>;
  expect(ranged).toEqual({rows:old.rows,total:old.total,statusCounts:old.headcount.byStatus});
  expect(old.total).toBe(count);
  const [restored]=await owner.client`select exists(select 1 from employment where id=${duplicateId}::uuid) as source_insert,
   exists(select 1 from app.performance_personnel_order where employment_id=${duplicateId}::uuid) as projection_insert,
   (select full_name from person where id=${fp}::uuid) as other_name,
   (select full_name from person where id=${renameId}::uuid) as restored_name,
   (select company_id from employment where id=${transferId}::uuid) as restored_company,
   (select resignation_date from employment where id=${lifecycleId}::uuid) as restored_date`;
  expect(restored).toEqual({source_insert:false,projection_insert:false,other_name:'AAA outside',restored_name:'Person '+String(count-1).padStart(6,'0'),restored_company:other.id,restored_date:null});
  for(const mode of modeNames)await compare(ctx,mode,all,narrow,25,count-25,false,true);
  // A company rename can rewrite every owned order key. Measure that amplification on the
  // sparse company and prove both orders against the canonical reader before rolling it back.
  const companyRename:Record<string,unknown>={};
  for(const stage of ['original','with-deltas','restored']){
   await rollback(async tx=>{
    const [subjects]=await tx<{ids:string[]}[]>`select array_agg(id order by id) as ids from employment where company_id=${sparse.id}::uuid`;
    expect(subjects.ids).toHaveLength(sparseCount);
    const started=performance.now();
    await tx`update company set legal_name='AAA Fictional renamed company' where id=${sparse.id}::uuid`;
    if(stage==='with-deltas')await refresh(tx,subjects.ids);
    companyRename[stage]=performance.now()-started;
    if(stage==='with-deltas')await readWithinWriter(tx,count);
   });
  }
  report.companyRename={records:sparseCount,timingsMs:companyRename,exactEightNativeWindows:true,rolledBack:true};
  report.writer={exactEightNativeWindowsDuringWrite:true,bothReadersWaitedOnExistingAccessWriterAndResumedExactly:true,
   independentTenantReaderOverlapped:true,independentTenantWriterOverlapped:true,outsideReaderMs,independentWriterMs,timings,rolledBack:true,
   scope:'Four owner fixture writes + one explicit delta refresh; not actual application write throughput, same-key contention, or live triggers.'};
  save();

  const measured:{scenario:string;stage:string;elapsedMs:number}[]=[];
  const qualifications:{scenario:string;candidateMs:number;baselineMs:number;ratio:number;passed:boolean}[]=[];
  for(const mode of modeNames){
   for(const [shape,scope,offset] of [
    ['initial',all,0],['deep',all,count-25],['sparse-deep',[sparse.id],sparseCount-25],
   ] as const){
    const scenario=mode+'-'+shape;
    let oracle:ReturnType<typeof normalize>|undefined;
    const times:number[]=[];
    for(const stage of ['original','candidate','candidate-warm','restored']){
     const started=performance.now();
     let actual:ReturnType<typeof normalize>;
     if(stage.startsWith('candidate')){
      actual=normalize((await queryCandidate(ctx,mode,[...scope],narrow,25,offset,offset>0)).row);
     }else{
      const result=await personnelListPage(ctx,{companyIds:[...scope],sort:mode,limit:25,offset},{companyIds:narrow});
      actual={rows:result.rows,total:result.total,statusCounts:result.headcount.byStatus};
     }
     const elapsedMs=performance.now()-started;
     if(!oracle)oracle=actual;
     expect(actual).toEqual(oracle);
     expect(actual.rows).toHaveLength(25);
     times.push(elapsedMs);
     measured.push({scenario,stage,elapsedMs});report.readTimings=measured;save();
    }
    const candidateMs=Math.max(times[1],times[2]),baselineMs=Math.min(times[0],times[3]),ratio=candidateMs/baselineMs;
    qualifications.push({scenario,candidateMs,baselineMs,ratio,passed:candidateMs<1000&&ratio<=.8});
    report.readQualifications=qualifications;save();
   }
  }
  report.qualification={allScopedReadScenariosPassed:qualifications.every(row=>row.passed),
   criteria:'Each worst candidate <1000ms and >=20% better than the best fresh canonical control. Isolated native 50k evidence only.',
   writeScope:'Rollback owner timings and writer barrier, including sparse company rename. No production maintenance or throughput claim.',
   excluded:'Arbitrary broad text, assignment and lifecycle status filters keep canonical fallback. Million broad, initial and deep still unqualified.'};
  save();
  expect(qualifications.every(row=>row.passed),'all exact 50k read scenarios must meet the fixed latency gate').toBe(true);
 }finally{
  for(const statement of ddl)await owner.client.unsafe(statement);
  if(before)expect(Array.from(await native())).toEqual(before);
  report.nativeProjectionsUnchanged=!!before;report.prototypeObjectsRemoved=true;save();
 }
},660000);
