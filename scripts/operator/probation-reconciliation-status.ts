/** Read-only receipt after independently verifying the installed source/build. Never activates or sends. */
import {sql} from 'drizzle-orm';
import {createDb} from '../../db/client';
async function main(){
const tenant=process.argv[2];
if(!tenant||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tenant))throw new Error('Usage: probation-reconciliation-status.ts TENANT_UUID');
if(!process.env.MIGRATION_DATABASE_URL)throw new Error('Use the verified installation owner environment.');
const owner=createDb(process.env.MIGRATION_DATABASE_URL,{max:1});
try{
 const receipt=await owner.withTenant({tenantId:tenant,roles:[],grants:[]},async tx=>{
  const[allowed]=await tx.execute<{ok:boolean}>(sql`select app.probation_storage_runner() as ok`);if(!allowed?.ok)throw new Error('Physical no-login owner connection required.');
  const[state]=await tx.execute(sql`select pass_count,started_at,last_success_at,next_check_at,cursor_id from probation_reconciliation_schedule where tenant_id=${tenant}::uuid`);
  const[classification]=await tx.execute(sql`select count(*)::integer as missing_cases,count(*) filter(where cardinality(reasons)=0)::integer as ready_for_worker,count(*) filter(where cardinality(reasons)>0)::integer as held from app.probation_reconciliation_population(null,null)`);
  const[queue]=await tx.execute(sql`select count(*) filter(where checked_at is null or checked_at<requested_at)::integer as unchecked,count(*) filter(where failure)::integer as failed_checks from probation_reconciliation_intent where tenant_id=${tenant}::uuid`);
  return{schedule:state??null,classification,queue,readOnly:true,timezone:'Asia/Kuala_Lumpur'};
 },{readOnlySnapshot:true});
 console.log(JSON.stringify(receipt,null,2));
}finally{await owner.client.end({timeout:5});}
}
main().catch(()=>{console.error('The read-only Probation reconciliation receipt could not be read. Verify the tenant, installed migration and owner connection.');process.exitCode=1;});
