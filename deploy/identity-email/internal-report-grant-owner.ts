/** All privileged grant checks/mutation/rollback use the exact separately supplied owner endpoint. */
import postgres from 'postgres';
import {internalReportRunnerDatabase} from './internal-report-install-model';
export const internalReportGrantOwnershipSql=`select current_database()=$1::text
 and exists(select 1 from pg_namespace n join pg_roles r on r.oid=n.nspowner where n.nspname='identity_email' and r.rolname=current_user)
 and exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner where n.nspname='public' and c.relname='custom_report_occurrence' and r.rolname=current_user)
 and (select count(*)=3 from pg_proc p join pg_roles r on r.oid=p.proowner where r.rolname=current_user and p.oid in (
  to_regprocedure('identity_email.report_target(uuid,uuid,text)'),
  to_regprocedure('identity_email.start_report(uuid,uuid,text,jsonb)'),
  to_regprocedure('identity_email.finish_report(uuid,uuid,text,text,integer,uuid[])')
 )) as ready`;
export type InternalReportGrantConnectionFactory=(url:string)=>postgres.Sql;
const connect:InternalReportGrantConnectionFactory=url=>postgres(url,{max:1,connect_timeout:5,idle_timeout:5,
 connection:{statement_timeout:5000,lock_timeout:250,application_name:'aihr-internal-report-install'}});
export async function withInternalReportGrantOwner<T>(ownerValue:string,appValue:string,
 work:(owner:postgres.Sql)=>Promise<T>,factory:InternalReportGrantConnectionFactory=connect):Promise<T>{
 const url=internalReportRunnerDatabase(ownerValue,appValue),owner=factory(url.toString());
 try{
  // URL is authenticated and names the same actual host/port/database as all three prior probes.
  // Verify exact touched-object ownership before any callback can mutate a grant. Never fall back
  // to a same-named database on a default local Unix-socket cluster.
  const [proof]=await owner.unsafe(internalReportGrantOwnershipSql,[decodeURIComponent(url.pathname.slice(1))]);
  if(proof?.ready!==true)throw new Error('Privileged report endpoint or canonical ownership mismatch.');
  return await work(owner);
 }finally{await owner.end({timeout:5});}
}
