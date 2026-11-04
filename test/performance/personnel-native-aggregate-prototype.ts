/** Hosted disposable-database diagnosis only. Never install this generated prototype.
 * Move the SAME server-owned query inside a native purpose boundary, allowing PostgreSQL
 * to plan its filters/joins/aggregation together instead of spooling a set-returning API.
 * Parameters stay typed parameters; do not benchmark fixture values embedded as constants.
 */
import {randomUUID} from 'node:crypto';
import {PgDialect} from 'drizzle-orm/pg-core';
import {sql,type SQL} from 'drizzle-orm';
import {expect} from 'vitest';
import {personnelListPageSql} from '../../core/read';
import {owner} from '../harness';

export async function personnelNativeAggregatePrototype(
 page:Parameters<typeof personnelListPageSql>[0],facets:Parameters<typeof personnelListPageSql>[1],
 facts:{body:string;owner:string;columns:string[]},materialized:boolean,splitCounts=false,
):Promise<{query:SQL;drop:()=>Promise<void>}>{
 const name='app.performance_personnel_aggregate_'+randomUUID().replaceAll('-','');
 const source=sql.raw('(select * from ('+facts.body.trim().replace(/;$/,'')+') native_facts('+facts.columns.map(c=>'"'+c.replaceAll('"','""')+'"').join(',')+'))');
 const composed=personnelListPageSql(page,facets,{source,materialized,projectPageFacts:true});
 const dialect=new PgDialect(),compiled=dialect.sqlToQuery(composed);
 if(splitCounts){
  if(materialized)throw Error('Split-count prototype requires independently planned facts');
  const needsAssignment=(filters:Parameters<typeof personnelListPageSql>[1])=>Boolean(filters.departmentId||filters.departmentIds?.length||filters.employmentType);
  if(!needsAssignment(page)&&!needsAssignment(facets)){
   // DISTINCT employment counts do not depend on LEFT assignment fanout when neither
   // predicate references assignment. Keep the person/company tenant joins and every
   // native purpose guard; the selected page still uses the complete original source.
   const join=' LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL';
   expect(facts.body.split(join)).toHaveLength(2);
   const countBody=facts.body.replace(join,'').replace('a.department_id,a.employment_type::text','NULL::uuid,NULL::text');
   expect(countBody).not.toContain('a.department_id');expect(countBody).not.toContain('a.employment_type');
   const countSource=sql.raw('(select * from ('+countBody.trim().replace(/;$/,'')+') native_facts('+facts.columns.map(c=>'"'+c.replaceAll('"','""')+'"').join(',')+'))');
   const countCompiled=dialect.sqlToQuery(personnelListPageSql(page,facets,{source:countSource,materialized:false,projectPageFacts:true}));
   expect(countCompiled.params).toEqual(compiled.params);
   const startMarker='with workforce_facts as not materialized(',endMarker='),\n      selected_page as materialized(';
   const begin=countCompiled.sql.indexOf(startMarker),end=countCompiled.sql.indexOf(endMarker,begin);
   expect(begin).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(begin);
   const countFacts=countCompiled.sql.slice(begin+startMarker.length,end);
   const target='from workforce_facts workforce_row group by 1';
   expect(compiled.sql.split(target)).toHaveLength(2);
   compiled.sql=compiled.sql.replace(target,'from ('+countFacts+') workforce_row group by 1');
  }
 }

 const prepare='performance_personnel_parameter_types';
 let signature='';
 await owner.client.begin(async tx=>{
  await tx.unsafe('prepare '+prepare+' as '+compiled.sql);
  let types:string[];
  try{
   const [prepared]=await tx<{types:string[]}[]>`select parameter_types::text[] as types from pg_prepared_statements where name=${prepare}`;
   types=prepared.types;
  }finally{await tx.unsafe('deallocate '+prepare);}
  expect(types).toHaveLength(compiled.params.length);
  expect(types.every(type=>['uuid','text','date','integer','bigint','boolean','numeric'].includes(type))).toBe(true);
  signature=types.join(',');
  // The native body is built only from tracked SQL, the canonical live facts owner and
  // parameter references. No request can supply SQL, a relation, predicate or function name.
  await tx.unsafe('create function '+name+'('+types.map((type,index)=>'p_'+index+' '+type).join(',')+') returns table(rows jsonb,total integer,status_counts jsonb) language sql stable security definer set search_path=pg_catalog,public,pg_temp as $performance_native_body$'+compiled.sql+'$performance_native_body$');
  await tx.unsafe('revoke all on function '+name+'('+signature+') from public;grant execute on function '+name+'('+signature+') to ai_hr_app');
  const [properties]=await tx<{owner:string;definer:boolean;app:boolean;public_execute:boolean}[]>`select proowner::regrole::text as owner,prosecdef as definer,has_function_privilege('ai_hr_app',oid,'EXECUTE')as app,exists(select 1 from aclexplode(proacl)where grantee=0 and privilege_type='EXECUTE')as public_execute from pg_proc where oid=${name+'('+signature+')'}::regprocedure`;
  expect(properties).toEqual({owner:facts.owner,definer:true,app:true,public_execute:false});
 });
 return {
  query:sql`select * from ${sql.raw(name)}(${sql.join(compiled.params.map(value=>sql`${value}`),sql`, `)})`,
  drop:async()=>{await owner.client.unsafe('drop function '+name+'('+signature+')');},
 };
}
