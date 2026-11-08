/** File-owned verification pools. No shared harness/application default changes. */
import {randomUUID} from 'node:crypto';
import {drizzle} from 'drizzle-orm/postgres-js';
import {vi} from 'vitest';
import * as database from '../../db/client';
import {owner} from '../harness';
import {workerDb} from '../db-names';

type Scope='work'|'cleanup';
import {employeeChoiceSqlFrontier,employeeChoiceCloseRegistry,employeeChoiceReadFrontier} from './employee-choice-sql-frontier';
export function employeeChoiceOwnedUrl(raw:string,role:'postgres'|'ai_hr_app',name:string){
 const url=new URL(raw),pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 if(!pool||!(/^[1-9][0-9]*$/).test(pool)||url.hostname!=='127.0.0.1'||url.pathname!=='/'+workerDb(pool)||url.username!==role||url.password||url.search||url.hash)throw Error('Exact owned employee benchmark worker required');
 url.searchParams.set('connect_timeout','3');url.searchParams.set('statement_timeout','20000');url.searchParams.set('lock_timeout','300');url.searchParams.set('application_name',name);
 return url.href;
}
export function employeeChoiceBenchmarkOwner(signal:AbortSignal,record:(phase:string)=>void,admit:()=>void=()=>signal.throwIfAborted()){
 let scope:Scope='work',stopped=false,closed=false,restoring=false;
 const resources=employeeChoiceCloseRegistry();
 const instance=randomUUID().slice(0,8);
 const original={...owner},originalWithTenant=database.withTenant;
 const work=database.createDb(employeeChoiceOwnedUrl(process.env.TEST_MIGRATION_DATABASE_URL!,'postgres','employee_benchmark_work_'+instance));
 const app=database.createDb(employeeChoiceOwnedUrl(process.env.TEST_DATABASE_URL!,'ai_hr_app','employee_benchmark_setup_'+instance));
 const cleanup=database.createDb(employeeChoiceOwnedUrl(process.env.TEST_MIGRATION_DATABASE_URL!,'postgres','employee_benchmark_cleanup_'+instance),{max:1});
 const active=()=>{if(stopped||closed||signal.aborted||scope!=='work')throw Error('Employee benchmark SQL frontier closed');admit();};
 const cleanupActive=()=>{if(closed||scope!=='cleanup')throw Error('Employee benchmark cleanup frontier closed');};
 const mount=(which:Scope)=>{const base=which==='work'?work:cleanup,client=employeeChoiceSqlFrontier(base.client,which==='work'?active:cleanupActive);owner.client=client;owner.db=drizzle(client);};
 const installCarrier=()=>vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:database.SessionContext,read:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{
  active();return app.withTenant(ctx,tx=>{active();return read(employeeChoiceReadFrontier(tx,active));},options);
 });
 // All constructors are synchronous/lazy and recorded before any query. Stop
 // closes their sockets even if a later await has not returned its resource.
 for(const client of [work.client,app.client,database.client,original.client])resources.register(()=>client.end({timeout:0}));
 let stoppedPromise:Promise<void>|undefined;
 const stop=()=>{stopped=true;return stoppedPromise??=resources.stop();};
 const abort=()=>{void stop().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 mount('work');installCarrier();
 return{active,installCarrier,stop,register:resources.register,
  async beginCleanup(){if(restoring)throw Error('Benchmark cleanup already admitted');restoring=true;await stop();await resources.settle();scope='cleanup';record('cleanup-owner-admitted');mount('cleanup');},
  async close(){
   const errors:unknown[]=[];try{await resources.settle();}catch(error){errors.push(error);}for(const client of [cleanup.client])try{await client.end({timeout:0});}catch(error){errors.push(error);}
   closed=true;signal.removeEventListener('abort',abort);Object.assign(owner,original);
   vi.spyOn(database,'withTenant').mockRestore();
   if(database.withTenant!==originalWithTenant)throw Error('Benchmark carrier restoration differs');
   if(errors.length)throw new AggregateError(errors,'Benchmark owned pool settlement refused');
  },
 };
}
