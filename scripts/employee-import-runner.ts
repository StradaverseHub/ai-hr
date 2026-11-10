/** Dedicated worker for staged employee imports (design B). Separate process and small pool so a long import never
 * competes with the web application's connection budget. MIGRATION_DATABASE_URL only discovers/coordinates the queue
 * and runs discard; DATABASE_URL owns all HR transactions under the initiating user's authority. */
import postgres from 'postgres';
if(!process.env.AIHR_DB_POOL_MAX)process.env.AIHR_DB_POOL_MAX='4';
const url=process.env.MIGRATION_DATABASE_URL;
if(!url)throw new Error('MIGRATION_DATABASE_URL is required by the import worker.');
const pauseMs=Number(process.env.EMPLOYEE_IMPORT_CHUNK_PAUSE_MS??25);
async function main(){
 // db/client reads AIHR_DB_POOL_MAX when imported, so this dynamic import must follow the override above.
 const {runEmployeeImportTick}=await import('../core/employee-import-worker');
 const {client}=await import('../db/client');
 const owner=postgres(url!,{max:1,onnotice:()=>{}});
 let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 try{do{const worked=await runEmployeeImportTick(owner);if(process.argv.includes('--once'))break;await new Promise(resolve=>setTimeout(resolve,worked?pauseMs:1000));}while(!stopping);}
 finally{await owner.end({timeout:5});await client.end({timeout:5});}
}
main().catch(()=>{console.error('Employee import worker stopped. Check its database access, migrations and runtime configuration.');process.exitCode=1;});
