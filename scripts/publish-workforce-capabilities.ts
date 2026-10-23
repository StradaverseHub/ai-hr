/** Explicit post-release installation. No runtime route and no new customer grant. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import postgres from 'postgres';
import {publishWorkforceCapabilities} from '../deploy/access/publish-workforce-capabilities';

const intended=[
 {file:'0576_principal_snapshot_current.sql',when:'1791900000056'},
 {file:'0578_ess_photo_approval.sql',when:'1791900000058'},
 {file:'0579_configurable_access.sql',when:'1791900000059'},
 {file:'0580_reward_policy_groups.sql',when:'1791900000060'},
] as const;
async function main(){
 if(process.argv.slice(2).join(' ')!=='--publish')throw new Error('Explicit publication mode required');
 const url=process.env.MIGRATION_DATABASE_URL;if(!url)throw new Error('Restricted owner connection required');
 const db=postgres(url,{max:1,connect_timeout:10,idle_timeout:2});
 try{
  const [role]=await db<{safe:boolean}[]>`select current_user=session_user and not rolsuper
   and not rolbypassrls and not rolcreaterole and not rolcreatedb and not rolreplication
   and not exists(select 1 from pg_auth_members m where m.member=r.oid) as safe
   from pg_roles r where rolname=current_user`;
  if(!role?.safe)throw new Error('Restricted owner required');
  for(const step of intended){
   const hash=createHash('sha256').update(await readFile(new URL('../db/migrations/'+step.file,import.meta.url))).digest('hex');
   const rows=await db<{hash:string}[]>`select hash from drizzle.__drizzle_migrations where created_at=${step.when}::bigint order by id`;
   if(rows.length!==1||rows[0].hash!==hash)throw new Error('Exact installed prerequisite hashes required');
  }
  const result=await publishWorkforceCapabilities(db);console.log(JSON.stringify({kind:'workforce-capability-publication',...result}));
 }finally{await db.end({timeout:3});}
}
main().catch(()=>{console.error('Workforce capability publication refused; no partial publication committed. Review private server state.');process.exitCode=1;});
