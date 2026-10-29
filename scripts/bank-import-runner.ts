/** Dedicated continuous worker. Both credentials are root-provisioned, outside the web environment.
 * MIGRATION_DATABASE_URL only discovers/coordinates the queue; DATABASE_URL owns all HR transactions.
 */
import postgres from 'postgres';
import {runBankImportTick} from '../core/bank-import-worker';
import {client} from '../db/client';
const url=process.env.MIGRATION_DATABASE_URL;
if(!url)throw new Error('MIGRATION_DATABASE_URL is required by the import worker.');
const owner=postgres(url,{max:1,onnotice:()=>{}});
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
async function main(){
 try{do{const worked=await runBankImportTick(owner);if(process.argv.includes('--once'))break;if(!worked)await new Promise(resolve=>setTimeout(resolve,1000));}while(!stopping);}
 finally{await owner.end({timeout:5});await client.end({timeout:5});}
}
main().catch(()=>{console.error('Bank import worker stopped. Check its database access, migrations and runtime configuration.');process.exitCode=1;});
