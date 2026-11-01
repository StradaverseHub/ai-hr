/** Independent provisioning capability. Never invokes holiday reconciliation or report dispatch. */
import {createDb,client} from '../db/client';
import {runProvisionTick} from './provision-runner';
async function main(){
 const url=process.env.MIGRATION_DATABASE_URL;
 if(!url)throw new Error('provision-only requires MIGRATION_DATABASE_URL.');
 const owner=createDb(url,{max:2});
 try {await runProvisionTick(owner);}finally{await owner.client.end({timeout:5});await client.end({timeout:5});}
}
main().catch(()=>{console.error('Provisioning-only tick failed; check its protected maintenance logs.');process.exitCode=1;});
