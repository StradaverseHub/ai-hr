/** Hosted disposable DB experiment only. Native purpose/guards are copied unchanged from the
 * actual facts owner. A26th raw hit always chooses the complete old query; no partial count exists.
 */
import {randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {expect} from 'vitest';
import {personnelListPageSql,type personnelListPage} from '../../core/read';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {withTenant,type SessionContext} from '../../db/client';
import {owner} from '../harness';

type Page=Parameters<typeof personnelListPage>[1];type Facets=Parameters<typeof personnelListPage>[2];
export type SearchProbe={name:string;drop:()=>Promise<void>};
export async function installPersonnelSearchProbe(sampleOverflow=false):Promise<SearchProbe>{
 const [facts]=await owner.client<{body:string;owner:string}[]>`select prosrc as body,proowner::regrole::text as owner from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
 const marker=' SELECT e.id,p.full_name',start=facts.body.indexOf(marker);expect(start).toBeGreaterThan(0);
 const guard=facts.body.slice(0,start);expect(guard).toContain('app.access_workforce_projection_company(c.id)');
 const name='app.performance_personnel_search_'+randomUUID().replaceAll('-','');
 // UNION ALL intentionally retains duplicate field hits.26raw hits is a conservative overflow;
 // <=25 proves all hits were enumerated, then identity deduplication is safe. No new field grants.
 const indexed=`
 SELECT candidate.id FROM(
  SELECT e.id FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
  JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
  WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
   AND (company_scope IS NULL OR e.company_id=ANY(company_scope)) AND e.employee_code ILIKE search_pattern
  UNION ALL
  SELECT e.id FROM public.person p JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
  JOIN permitted allowed ON allowed.id=e.company_id JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
  WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
   AND (company_scope IS NULL OR e.company_id=ANY(company_scope)) AND(p.full_name ILIKE search_pattern OR p.primary_email ILIKE search_pattern)
 )candidate LIMIT 26`;
 // A sample is sufficient only to prove overflow. All incomplete samples still run the
 // full candidate probe. No sample result is ever used as the bounded population.
 const body=sampleOverflow?guard+`, sampled as materialized(
  SELECT e.id,e.employee_code,p.full_name,p.primary_email FROM permitted allowed
  JOIN LATERAL (
   SELECT e.id,e.tenant_id,e.company_id,e.person_id,e.employee_code
   FROM public.employment e WHERE e.company_id=allowed.id AND e.tenant_id=app.current_tenant_id()
    AND e.voided_at IS NULL LIMIT 128
  ) e ON true
  JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
  WHERE company_scope IS NULL OR allowed.id=ANY(company_scope)
  LIMIT 128
 ),sample_hits as materialized(
  SELECT s.id FROM sampled s
  CROSS JOIN LATERAL (VALUES (s.employee_code ILIKE search_pattern),
   (s.full_name ILIKE search_pattern OR s.primary_email ILIKE search_pattern)) matched(hit)
  WHERE matched.hit LIMIT 26
 ),sample_state as materialized(SELECT count(*)=26 AS overflow FROM sample_hits),
 indexed_hits as materialized(${indexed})
 SELECT sample_hits.id,true FROM sample_hits WHERE (SELECT overflow FROM sample_state)
 UNION ALL SELECT indexed_hits.id,false FROM indexed_hits WHERE NOT (SELECT overflow FROM sample_state)
 `:guard+' SELECT full_probe.id,false FROM ('+indexed+') full_probe';
 await owner.client.unsafe('create function '+name+'(search_pattern text,company_scope uuid[]) returns table(id uuid,sample_overflow boolean) language sql stable security definer set search_path=pg_catalog,public,pg_temp as $probe$'+body+'$probe$');
 try{
  await owner.client.unsafe('revoke all on function '+name+'(text,uuid[]) from public;grant execute on function '+name+'(text,uuid[]) to ai_hr_app');
  const [properties]=await owner.client<{owner:string;definer:boolean;app:boolean;public_execute:boolean}[]>`select proowner::regrole::text as owner,prosecdef as definer,has_function_privilege('ai_hr_app',oid,'EXECUTE')as app,exists(select 1 from aclexplode(proacl)where grantee=0 and privilege_type='EXECUTE')as public_execute from pg_proc where oid=${name+'(text,uuid[])'}::regprocedure`;
  expect(properties).toEqual({owner:facts.owner,definer:true,app:true,public_execute:false});
 }catch(error){await owner.client.unsafe('drop function '+name+'(text,uuid[])');throw error;}
 return {name,drop:async()=>{await owner.client.unsafe('drop function '+name+'(text,uuid[])');}};
}

function boundedFacts():SQL{
 return sql`(select (value->>'employmentId')::uuid as employment_id,value->>'name' as name,value->>'email' as email,
  value->>'employeeCode' as employee_code,value->>'company' as company,(value->>'companyId')::uuid as company_id,
  (value->>'departmentId')::uuid as department_id,value->>'employmentType' as employment_type,
  (value->>'terminatedOn')::date as terminated_on,(value->>'finalConfirmationDate')::date as final_confirmation_date,
  (value->>'confirmationDate')::date as confirmation_date,(value->>'probationEndDate')::date as probation_end_date,
  (value->>'provisionalEndOn')::date as provisional_end_on,(value->>'resignationDate')::date as resignation_date,
  (value->>'lastWorkingDate')::date as last_working_date,(value->>'blacklistedAt')::date as blacklisted_at
  from bounded_native_rows r(value))`;
}

export async function readWithPersonnelSearchProbe(actor:SessionContext,page:Page,facets:Facets,probe:SearchProbe,
 augment?:(source:SQL)=>SQL,explain=false){
 return withTenant(actor,async tx=>{
  await lockAccessConfigurationReadTx(tx,actor.tenantId);
  const q=page.q?.trim(),fq=facets.q?.trim(),eligible=Boolean(q&&q===fq);
  let source:SQL=sql`app.access_workforce_list_facts()`,probeQuery:SQL|undefined,prefix:SQL|undefined;
  if(eligible){
   const scope=page.companyIds&&facets.companyIds?[...new Set([...page.companyIds,...facets.companyIds])]:null;
   const scopeSql=scope?sql`array[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`:sql`null::uuid[]`;
   probeQuery=sql`select id,sample_overflow from ${sql.raw(probe.name)}(${'%'+q+'%'},${scopeSql})`;
   prefix=sql`search_probe as materialized(${probeQuery}),probe_state as materialized(
    select count(*)::int as raw_hits,count(*)<=25 as bounded,coalesce(bool_or(sample_overflow),false) as sample_overflow from search_probe
   ),bounded_native_rows(value)as materialized(
    select value from app.access_workforce_list_rows_for_ids(case when(select bounded from probe_state)
     then array(select id from search_probe)else null::uuid[]end)r(value)
   )`;
   source=sql`(select * from app.access_workforce_list_facts()where not(select bounded from probe_state)
    union all select * from ${boundedFacts()}bounded_facts where(select bounded from probe_state))`;
  }
  if(augment)source=augment(source);
  let query=personnelListPageSql(page,facets,{source,materialized:true,projectPageFacts:true});
  if(prefix){
   // One snapshot for candidate enumeration, exact counts/facets and detail rows. No RR workaround
   // or gap between the probe and projection; Access configuration still joins before this statement.
   const dialect=new PgDialect(),compiled=dialect.sqlToQuery(query),leading=dialect.sqlToQuery(prefix);
   const params=[...compiled.params,...leading.params];
   const projection='select value from app.access_workforce_list_rows_for_ids(array(select employment_id from selected_page))r(value)';
   expect(compiled.sql.split(projection)).toHaveLength(2);expect(compiled.sql.match(/with workforce_facts as/g)).toHaveLength(1);
   const prefixText=leading.sql.replace(/\$(\d+)/g,(_,number)=>'$'+(compiled.params.length+Number(number)));
   const text=compiled.sql.replace('with workforce_facts as','with '+prefixText+',workforce_facts as')
    .replace(projection,"select value from bounded_native_rows where(value->>'employmentId')::uuid=any(array(select employment_id from selected_page)) union all select value from app.access_workforce_list_rows_for_ids(case when(select bounded from probe_state)then null::uuid[]else array(select employment_id from selected_page)end)r(value)")
    +', (select raw_hits from probe_state)as probe_hits,(select bounded from probe_state)as probe_bounded,(select sample_overflow from probe_state)as probe_sample';
   const pieces:SQL[]=[];let previous=0;
   for(const match of text.matchAll(/\$(\d+)/g)){
    pieces.push(sql.raw(text.slice(previous,match.index)),sql`${params[Number(match[1])-1]}`);previous=match.index!+match[0].length;
   }
   pieces.push(sql.raw(text.slice(previous)));query=sql.join(pieces,sql.raw(''));
  }
  const [row]=await tx.execute<{rows:Awaited<ReturnType<typeof personnelListPage>>['rows'];total:number;status_counts:{status:string;count:number}[];probe_hits?:number;probe_bounded?:boolean;probe_sample?:boolean}>(query);
  const dto={rows:row.rows,total:Number(row.total),headcount:{total:row.status_counts.reduce((sum,bucket)=>sum+Number(bucket.count),0),byStatus:Object.fromEntries(row.status_counts.map(bucket=>[bucket.status,Number(bucket.count)]))}};
  const plans=explain?{probe:probeQuery?Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${probeQuery}`)):null,page:Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`))}:undefined;
  return {dto,rawHits:row.probe_hits??null,usedBounded:row.probe_bounded??false,usedSampleOverflow:row.probe_sample??false,plans};
 });
}
