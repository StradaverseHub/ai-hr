/** Approved 989bdb77. Report first; --apply FILE only admits a checkpointed job.
 * Run on the verified target with its private environment loaded, --tenant UUID --user HR_UUID.
 * No SMTP call or live recovery is part of deployment. Keep the exact report privately.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { SessionContext, Grant } from '../db/client';
const arg=(key:string)=>{const i=process.argv.indexOf(key);return i<0?undefined:process.argv[i+1];};
async function main(){
 process.env.AIHR_DB_PROCESS_ROLE='worker';process.env.AIHR_DB_POOL_MAX='2';
 const tenantId=z.uuid().parse(arg('--tenant')),userId=z.uuid().parse(arg('--user'));
 const url=process.env.MIGRATION_DATABASE_URL;if(!url)throw new Error('The verified target owner connection is required.');
 const [{createDb,client},{resolveEntitlementsTx},{managerEmailRecoveryPage,requestManagerEmailRecovery}]=await Promise.all([import('../db/client'),import('../core/entitlements'),import('../core/lifecycle-manager-recovery')]);
 const owner=createDb(url);
 try{
  const rows=await owner.client`select u.person_id,r.role,r.company_id from app_user u join role_assignment r on r.app_user_id=u.id and r.tenant_id=u.tenant_id where u.id=${userId}::uuid and u.tenant_id=${tenantId}::uuid and u.archived_at is null`;
  if(!rows.length)throw new Error('An existing authorised HR user is required.');
  const grants:Grant[]=rows.map(r=>({role:r.role,companyId:r.company_id}));
  const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId));
  const ctx:SessionContext={tenantId,userId,personId:rows[0].person_id,grants,entitlements};
  const apply=arg('--apply');
  if(apply){const manifest=JSON.parse(readFileSync(apply,'utf8'));const admitted=await requestManagerEmailRecovery(ctx,manifest.items??manifest);console.log(JSON.stringify({apply:true,jobId:admitted.row.id,existing:admitted.existing}));}
  else{const items=[];let after='';for(;;){const page=await managerEmailRecoveryPage(ctx,after);items.push(...page.items);if(page.items.length<100||!page.after)break;after=page.after;}
   console.log(JSON.stringify({apply:false,tenantId,items,counts:items.reduce<Record<string,number>>((out,item)=>(out[item.classification]=(out[item.classification]??0)+1,out),{}),note:'Manager identity and addresses are revalidated by the protected worker. Future holds rejoin scheduling; late holds require HR.'},null,2));}
 }finally{await owner.client.end();await client.end();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Recovery failed.');process.exitCode=1;});
