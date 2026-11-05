/** Disposable native-owner EXPLAIN wrapper. VOLATILE only because EXPLAIN is a utility command;
 * the original native aggregate remains STABLE. Never expose/install this in a product database. */
import {randomUUID} from 'node:crypto';
import {PgDialect} from 'drizzle-orm/pg-core';
import {sql,type SQL} from 'drizzle-orm';
import {expect} from 'vitest';
import {owner} from '../harness';
export async function nativePersonnelPlanDiagnostic(query:SQL){
 const compiled=new PgDialect().sqlToQuery(query),match=compiled.sql.match(/app\.performance_personnel_aggregate_[a-f0-9]+/);
 expect(match).not.toBeNull();
 const [fn]=await owner.client<{body:string;signature:string;types:string;arguments:string[];owner:string}[]>`select prosrc as body,pg_get_function_identity_arguments(oid)as signature,oidvectortypes(proargtypes)as types,proargnames[1:pronargs]as arguments,proowner::regrole::text as owner from pg_proc where pronamespace='app'::regnamespace and proname=${match![0].slice(4)}`;
 const name='app.performance_personnel_explain_'+randomUUID().replaceAll('-','');
 expect(fn.body).not.toContain('$native_explain_sql$');expect(fn.arguments.every(name=>/^p_\d+$/.test(name))).toBe(true);
 const body='declare result json;begin execute $native_explain_sql$explain(analyze,buffers,format json) '+fn.body+'$native_explain_sql$ into result'+(fn.arguments.length?' using '+fn.arguments.join(','):'')+';return result;end';
 await owner.client.unsafe('create function '+name+'('+fn.signature+')returns json language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $diagnostic_body$'+body+'$diagnostic_body$');
 try{
  await owner.client.unsafe('revoke all on function '+name+'('+fn.types+')from public;grant execute on function '+name+'('+fn.types+')to ai_hr_app');
  const [properties]=await owner.client<{owner:string;definer:boolean}[]>`select proowner::regrole::text as owner,prosecdef as definer from pg_proc where oid=${name+'('+fn.types+')'}::regprocedure`;
  expect(properties).toEqual({owner:fn.owner,definer:true});
 }catch(error){await owner.client.unsafe('drop function '+name+'('+fn.types+')');throw error;}
 return{query:sql`select ${sql.raw(name)}(${sql.join(compiled.params.map(value=>sql`${value}`),sql`, `)})as plan`,drop:()=>owner.client.unsafe('drop function '+name+'('+fn.types+')')};
}
