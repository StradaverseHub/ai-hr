/** Hosted proof of a data-only ordered projection and exact date-signature counts.
 * This test does not propose a migration, install writers or demonstrate million-row capacity. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {personnelListPage} from '../../core/read';
import {withTenant,type SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';

const file='test/performance/personnel-exact-order-proof.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('preserves native unfiltered Personnel pages/counts using ordered index entries and compact date signatures',async()=>{
 const report:Record<string,unknown>={kind:'SMALL_PERSONNEL_STATIC_ORDERED_PROJECTION_ONLY',releaseEligible:false,
  limitations:'Disposable static projection, no writers, no assignment/text/status filters, no concurrency or retained-million proof.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-exact-order-proof.json'),JSON.stringify(report,null,2));
 const modeNames=['name','company'] as const;
 const typeList='uuid[],uuid[],integer,integer,date';
 const args='page_companies uuid[],facet_companies uuid[],page_size integer,page_offset integer,as_of date';
 const joins='from public.employment e join public.person p on p.id=e.person_id and p.tenant_id=e.tenant_id join public.company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.voided_at is null';
 const dates='e.resignation_date,e.last_working_date,e.terminated_on,e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,e.blacklisted_at';
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
  const count=2_000;
  await owner.client`insert into person(id,tenant_id,full_name,primary_email)
   select (${p}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
    case when n%11=0 then 'Accent Á' when n%7=0 then 'accent á' else 'Person '||lpad(n::text,6,'0') end,
    (${p}||n::text)||'@example.invalid' from generate_series(1,${count}::integer)n`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on,terminated_on,resignation_date,final_confirmation_date,provisional_end_on,blacklisted_at)
   select (${e}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
    (${p}||lpad(n::text,12,'0'))::uuid,case when n%4=0 then ${other.id}::uuid else ${b.companyId}::uuid end,
    date '2020-01-01',case when n%9=0 then ${today}::date end,case when n%10=0 then ${today}::date+1 end,
    case when n%13=0 then ${today}::date end,case when n%13<2 then ${today}::date+1 end,case when n%23=0 then ${today}::date end
    from generate_series(1,${count}::integer)n`;
  const fp=randomUUID(),fe=randomUUID();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email) values(${fp}::uuid,${foreign.tenantId}::uuid,'AAA outside',${fp+'@example.invalid'})`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${fe}::uuid,${foreign.tenantId}::uuid,${fp}::uuid,${foreign.companyId}::uuid,date '2020-01-01')`;
  await create('create table app.performance_personnel_order as select e.tenant_id,e.company_id,e.id as employment_id,p.full_name as name,lower(p.full_name) as name_folded,lower(c.legal_name) as company_folded '+joins,'drop table app.performance_personnel_order');
  await create('create table app.performance_personnel_count as select e.tenant_id,e.company_id,'+dates+',count(*) as quantity '+joins+' group by 1,2,3,4,5,6,7,8,9,10','drop table app.performance_personnel_count');
  await owner.client`create index performance_personnel_order_name on app.performance_personnel_order(tenant_id,name,employment_id) include(company_id)`;
  await owner.client`create index performance_personnel_order_company on app.performance_personnel_order(tenant_id,company_folded,name_folded,employment_id) include(company_id)`;
  await owner.client`vacuum (analyze) app.performance_personnel_order`;
  await owner.client`analyze app.performance_personnel_count`;
  const [sizes]=await owner.client`select (select count(*)::int from app.performance_personnel_order) as ordered,(select count(*)::int from app.performance_personnel_count) as signatures,
   pg_total_relation_size('app.performance_personnel_order'::regclass) as order_bytes,pg_total_relation_size('app.performance_personnel_count'::regclass) as count_bytes`;
  expect(Number(sizes.signatures)).toBeLessThan(Number(sizes.ordered)/10);
  report.sizes=sizes;save();
  const namespace='app.performance_personnel_exact_';
  for(const mode of modeNames){
   const order=mode==='name'?'o.name,o.employment_id':'o.company_folded,o.name_folded,o.employment_id';
   const orderAfter=order.replaceAll('o.','chosen.');
   const sortFields=mode==='name'?'o.name':'o.company_folded,o.name_folded';
   const query=`
    with permitted as materialized(
     select c.id from public.company c where c.tenant_id=app.current_tenant_id() and app.access_workforce_projection_company(c.id)
    ), selected as materialized(
     select o.employment_id,${sortFields} from app.performance_personnel_order o
     where o.tenant_id=app.current_tenant_id() and o.company_id=any($1) and o.company_id in(select id from permitted)
     order by ${order} limit $3 offset $4
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
   const base=namespace+mode, explain=base+'_plan';
   await create('create function '+base+'('+args+') returns table(rows jsonb,total integer,status_counts jsonb) language sql stable security definer set search_path=pg_catalog,public,pg_temp as $q$'+query+'$q$','drop function '+base+'('+typeList+')');
   await create('create function '+explain+'('+args+') returns json language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $fn$ declare result json;begin execute $q$explain(analyze,buffers,format json) '+query+'$q$ into result using page_companies,facet_companies,page_size,page_offset,as_of;return result;end $fn$','drop function '+explain+'('+typeList+')');
   for(const name of [base,explain])await owner.client.unsafe('revoke all on function '+name+'('+typeList+') from public;grant execute on function '+name+'('+typeList+') to ai_hr_app');
  }
  const [acl]=await owner.client`select has_table_privilege('ai_hr_app','app.performance_personnel_order','SELECT') as raw_order,
   has_table_privilege('ai_hr_app','app.performance_personnel_count','SELECT') as raw_count,
   not exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a where p.pronamespace='app'::regnamespace and p.proname like 'performance_personnel_exact_%' and a.grantee=0) as no_public`;
  expect(acl).toEqual({raw_order:false,raw_count:false,no_public:true});report.acl=acl;
  const all=[b.companyId,other.id,foreign.companyId], narrow=[b.companyId];
  const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');
  await owner.client`update role_assignment set company_id=${b.companyId}::uuid where app_user_id=${scopedUser}::uuid`;
  const scoped:SessionContext={...ctx,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const comparisons:Record<string,unknown>[]=[];
  const compare=async(actor:SessionContext,mode:typeof modeNames[number],pageCompanies:string[],facetCompanies:string[],limit:number,offset:number,explain:boolean)=>{
   const before=await personnelListPage(actor,{companyIds:pageCompanies,limit,offset,sort:mode},{companyIds:facetCompanies});
   const uuidArray=(ids:string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
   const params=sql`${uuidArray(pageCompanies)},${uuidArray(facetCompanies)},${limit}::integer,${offset}::integer,${today}::date`;
   const {row,plan}=await withTenant(actor,async tx=>{
    await lockAccessConfigurationReadTx(tx,actor.tenantId);
    const [row]=await tx.execute<{rows:unknown[];total:number;status_counts:{status:string;count:number}[]}>(sql`select * from ${sql.raw(namespace+mode)}(${params})`);
    const [result]=explain?await tx.execute<{plan:unknown}>(sql`select ${sql.raw(namespace+mode+'_plan')}(${params}) as plan`):[];
    return {row,plan:result?.plan};
   });
   const byStatus=Object.fromEntries(row.status_counts.map(v=>[v.status,Number(v.count)]));
   expect({rows:row.rows,total:Number(row.total),headcount:{byStatus,total:Object.values(byStatus).reduce((n,v)=>n+v,0)}}).toEqual(before);
   comparisons.push({mode,limit,offset,rows:row.rows.length,total:row.total,plan});report.comparisons=comparisons;save();
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
  await owner.client`update app_user set archived_at=now() where id=${b.adminUserId}::uuid`;
  try{await compare(ctx,'name',all,all,25,0,false);}finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
  await owner.client`update role_assignment set company_id=${other.id}::uuid where app_user_id=${scopedUser}::uuid`;
  try{await compare(scoped,'name',all,all,25,0,false);}finally{await owner.client`update role_assignment set company_id=${b.companyId}::uuid where app_user_id=${scopedUser}::uuid`;}
  const nodes=(node:unknown):Record<string,unknown>[]=>{
   if(Array.isArray(node))return node.flatMap(nodes);
   if(!node||typeof node!=='object')return [];
   const record=node as Record<string,unknown>;
   return [...(record['Node Type']?[record]:[]),...Object.values(record).flatMap(nodes)];
  };
  const indexVisits=comparisons.filter(c=>c.plan).map(c=>{
   const allNodes=nodes(c.plan),index=allNodes.find(n=>n['Index Name']==='performance_personnel_order_'+c.mode);
   const countScan=allNodes.find(n=>n['Relation Name']==='performance_personnel_count');
   return {mode:c.mode,limit:c.limit,offset:c.offset,indexUsed:!!index,indexKind:index?.['Node Type'],
    indexOutputRows:index?.['Actual Rows'],heapFetches:index?.['Heap Fetches'],countInputRows:countScan?.['Actual Rows']};
  });
  report.indexVisits=indexVisits;save();
  // The first page must get the expected native index with normal planner settings.
  for(const mode of modeNames)expect(indexVisits.find(c=>c.mode===mode&&c.offset===0)?.indexUsed).toBe(true);
 }finally{
  for(const statement of ddl)await owner.client.unsafe(statement);
  if(before)expect(Array.from(await native())).toEqual(before);
  report.nativeProjectionsUnchanged=!!before;report.prototypeObjectsRemoved=true;save();
 }
},120000);
