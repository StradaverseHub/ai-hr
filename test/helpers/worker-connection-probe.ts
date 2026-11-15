/** Child process of test/worker-connection-db.test.ts, started with AIHR_DB_PROCESS_ROLE=worker as the import worker's
 * unit is. It reads, through every connection the worker uses, the session's dead-peer settings and their source:
 * both connections of the HR-transaction pool (db/client.ts) and the queue-owner connection the runner opens
 * (db/worker-connection.ts), once with the owner URL and once with the app URL, a role that is not a superuser.
 * Prints one JSON line. */
import '../../scripts/lib/stub-server-only';
import type postgres from 'postgres';
import {client} from '../../db/client';
import {WORKER_SERVER_SESSION_PARAMETERS,openImportWorkerOwner} from '../../db/worker-connection';

const names=Object.keys(WORKER_SERVER_SESSION_PARAMETERS);
async function probe(sql:postgres.Sql|postgres.ReservedSql){
 const settings=await sql<{name:string;setting:string;source:string}[]>`select name,setting,source from pg_settings where name in ${sql(names)} order by name`;
 const [who]=await sql<{role:string;superuser:boolean;tcp:boolean;pid:number}[]>`select current_user as role,r.rolsuper as superuser,
  inet_client_addr() is not null as tcp,pg_backend_pid() as pid from pg_roles r where r.rolname=current_user`;
 // SHOW, as an operator would read it, for the setting that left staging's backends alive for two hours.
 const [shown]=await sql<{tcp_keepalives_idle:string}[]>`show tcp_keepalives_idle`;
 return {...who,shownIdle:shown.tcp_keepalives_idle,settings:Object.fromEntries(settings.map(s=>[s.name,{setting:s.setting,source:s.source}]))};
}

async function main(){
 const first=await client.reserve(),second=await client.reserve();
 const pool=[await probe(first),await probe(second)];
 first.release();second.release();
 const owner=openImportWorkerOwner(process.env.MIGRATION_DATABASE_URL!);
 const appOwner=openImportWorkerOwner(process.env.DATABASE_URL!);
 const result={
  poolMax:client.options.max,poolKeepAlive:client.options.keep_alive,pool,
  owner:{keepAlive:owner.options.keep_alive,...await probe(owner)},
  appOwner:{keepAlive:appOwner.options.keep_alive,...await probe(appOwner)},
 };
 await Promise.all([owner.end({timeout:5}),appOwner.end({timeout:5}),client.end({timeout:5})]);
 console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('worker connection probe failed',error);process.exit(1);});
