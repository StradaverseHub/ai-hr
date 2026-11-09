/** File-owned verification pools. No shared harness/application default changes. */
import {randomUUID} from 'node:crypto';
import {drizzle} from 'drizzle-orm/postgres-js';
import {vi} from 'vitest';
import * as database from '../../db/client';
import {owner} from '../harness';
import {employeeChoiceOwnedUrl} from './employee-choice-owned-binding';
import {employeeChoiceOwnedSettlement} from './employee-choice-owned-settlement';
export {employeeChoiceOwnedUrl} from './employee-choice-owned-binding';

type Scope='work'|'cleanup';
import {employeeChoiceSqlFrontier,employeeChoiceCloseRegistry,employeeChoiceReadFrontier,employeeChoiceWorkRegistry} from './employee-choice-sql-frontier';
export function employeeChoiceBenchmarkOwner(signal:AbortSignal,record:(phase:string)=>void,admit:()=>void=()=>signal.throwIfAborted(),kind:'work'|'native-control'='work'){
 let scope:Scope='work',stopped=false,closed=false,restoring=false;
 const resources=employeeChoiceCloseRegistry(),callbacks=employeeChoiceWorkRegistry();
 const instance=randomUUID().slice(0,8);
 const original={...owner},originalWithTenant=database.withTenant;
 // Validate BOTH credentials/endpoints before ANY pool constructor.
 const workUrl=employeeChoiceOwnedUrl(process.env.TEST_MIGRATION_DATABASE_URL!,'postgres','employee_benchmark_work_'+instance,kind),appUrl=employeeChoiceOwnedUrl(process.env.TEST_DATABASE_URL!,'ai_hr_app','employee_benchmark_setup_'+instance,kind);
 const cleanupUrl=employeeChoiceOwnedUrl(process.env.TEST_MIGRATION_DATABASE_URL!,'postgres','employee_benchmark_cleanup_'+instance,'cleanup');
 const work=database.createDb(workUrl),app=database.createDb(appUrl),cleanup=database.createDb(cleanupUrl,{max:1});
 const backendNames=new Set([new URL(workUrl).searchParams.get('application_name')!,new URL(appUrl).searchParams.get('application_name')!]);
 let cleanupDeadline=Infinity,cleanupTimer:ReturnType<typeof setTimeout>|undefined,cleanupClose:Promise<void>|undefined;
 const closeCleanup=()=>cleanupClose??=cleanup.client.end({timeout:0});
 const active=()=>{if(stopped||closed||signal.aborted||scope!=='work')throw Error('Employee benchmark SQL frontier closed');admit();};
 const cleanupActive=()=>{if(closed||scope!=='cleanup'||Number(process.hrtime.bigint())/1e6>=cleanupDeadline)throw Error('Employee benchmark cleanup frontier closed');};
 const mount=(which:Scope)=>{const base=which==='work'?work:cleanup,client=employeeChoiceSqlFrontier(base.client,which==='work'?active:cleanupActive,work=>callbacks.own(work,which==='work'?active:cleanupActive),callbacks.watch,callbacks.nativeFailure);owner.client=client;owner.db=drizzle(client);};
 const installCarrier=()=>vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:database.SessionContext,read:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{
  active();return callbacks.watch(app.withTenant(ctx,tx=>callbacks.own(()=>read(employeeChoiceReadFrontier(tx,active)),active),options));
 });
 // All constructors are synchronous/lazy and recorded before any query. Stop
 // closes their sockets even if a later await has not returned its resource.
 for(const client of [work.client,app.client,database.client,original.client])resources.register(()=>client.end({timeout:0}));
 let stoppedPromise:Promise<void>|undefined;
 const stop=()=>{stopped=true;callbacks.stop();return stoppedPromise??=resources.stop();};
 const abort=()=>{void stop().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 mount('work');installCarrier();
 const register=(close:()=>Promise<void>,name?:string)=>{if(name){if(!(/^employee_choice_native_purpose_(timing|plans)$/).test(name))throw Error('Unowned benchmark backend tag');backendNames.add(name);}return resources.register(close);};
 return{active,installCarrier,stop,register,watchWork:callbacks.watch,ownWork:<T>(work:()=>Promise<T>)=>callbacks.own(work,active),
  async beginCleanup(deadline=Number(process.hrtime.bigint())/1e6+26000){
   if(restoring)throw Error('Benchmark cleanup already admitted');restoring=true;
   cleanupDeadline=Math.min(deadline,Number(process.hrtime.bigint())/1e6+26000);
   cleanupTimer=setTimeout(()=>{void closeCleanup().catch(()=>{});},Math.max(0,cleanupDeadline-Number(process.hrtime.bigint())/1e6));
   await employeeChoiceOwnedSettlement({stop,callbacks:()=>callbacks.settle(),resources:()=>resources.settle()});scope='cleanup';cleanupActive();mount('cleanup');
   // A rejected frontend Promise is not native backend quiescence. Observe only
   // this scope's exact registered tags; never cancel or terminate other work.
   for(;;){
    cleanupActive();const [row]=await cleanup.client`select count(*)::int as remaining from pg_stat_activity where datname=current_database() and application_name=any(${[...backendNames]}::text[]) and pid<>pg_backend_pid()`;
    cleanupActive();if(row.remaining===0)break;await new Promise(resolve=>setTimeout(resolve,20));
   }
   record('owned-backends-quiescent');record('cleanup-owner-admitted');
  },
  async close(){
   closed=true;const errors:unknown[]=[];
   try{await employeeChoiceOwnedSettlement({stop,callbacks:()=>callbacks.settle(),resources:()=>resources.settle(),cleanup:closeCleanup});}catch(error){errors.push(error);}
   if(cleanupTimer)clearTimeout(cleanupTimer);
   if(Number(process.hrtime.bigint())/1e6>=cleanupDeadline)errors.push(Error('Benchmark aggregate cleanup deadline exhausted'));
   signal.removeEventListener('abort',abort);
   try{Object.assign(owner,original);}catch(error){errors.push(error);}
   try{vi.spyOn(database,'withTenant').mockRestore();}catch(error){errors.push(error);}
   if(database.withTenant!==originalWithTenant)errors.push(Error('Benchmark carrier restoration differs'));
   if(errors.length)throw new AggregateError(errors,'Benchmark owned pool settlement refused');
  },
 };
}
