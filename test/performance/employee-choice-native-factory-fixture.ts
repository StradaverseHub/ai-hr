/** Real private max1 carriers for factory qualification only; no global harness
 * mutation, provider, installation target or self-issued release capability. */
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {employeeChoiceOwnedUrl} from './employee-choice-owned-binding';
import {employeeChoiceSqlFrontier,employeeChoiceWorkRegistry,employeeChoiceCloseRegistry} from './employee-choice-sql-frontier';
import {workerDb} from '../db-names';
export const employeeChoiceFactoryNativeFile='test/employee-choice-native-owner-factory.test.ts';
export function admitEmployeeChoiceNativeFactory(){
 const files:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'null');
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'
  ||process.env.GITHUB_JOB!=='selected-tests'||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_RUN_ATTEMPT!=='1'
  ||!(/^[1-9][0-9]{0,19}$/).test(process.env.GITHUB_RUN_ID??'')||!(/^[0-9a-f]{40}$/).test(process.env.AIHR_CI_HEAD??'')||!(/^[0-9a-f]{40}$/).test(process.env.AIHR_CI_CONTROL_HEAD??'')
  ||process.env.WORKER_DB==='0'||!Array.isArray(files)||files.length!==1||files[0]!==employeeChoiceFactoryNativeFile)throw Error('Sole standard hosted native factory qualification required');
 employeeChoiceOwnedUrl(process.env.TEST_DATABASE_URL!,'ai_hr_app','factory-admission','native-control');
 employeeChoiceOwnedUrl(process.env.TEST_MIGRATION_DATABASE_URL!,'postgres','factory-admission','native-control');
}
export type FactoryStatement={carrier:'work'|'tx'|'cleanup';text:string;values:unknown[]};
export function employeeChoiceNativeFactoryFixture(signal:AbortSignal,deadline:number){
 const url=new URL(employeeChoiceOwnedUrl(process.env.TEST_MIGRATION_DATABASE_URL!,'postgres','factory','work'));url.search='';
 const id=randomUUID().slice(0,8),workName='employee_factory_work_'+id,cleanupName='employee_factory_cleanup_'+id;
 const work=postgres(url.href,{max:1,connect_timeout:2,connection:{application_name:workName,statement_timeout:'20s',lock_timeout:'300ms'}});
 const cleanup=postgres(url.href,{max:1,connect_timeout:2,connection:{application_name:cleanupName,statement_timeout:'1s',lock_timeout:'300ms'}});
 const callbacks=employeeChoiceWorkRegistry(),resources=employeeChoiceCloseRegistry(),statements:FactoryStatement[]=[];
 let phase:'work'|'cleanup'='work',stopped=false,closed=false,transactionDepth=0,closeCleanup:Promise<void>|undefined;
 const cleanupClose=()=>closeCleanup??=cleanup.end({timeout:0});
 const cleanupTimer=setTimeout(()=>{void cleanupClose().catch(()=>{});},Math.max(0,deadline-Number(process.hrtime.bigint())/1e6));
 const active=()=>{if(closed||stopped||signal.aborted||phase!=='work')throw Error('Native factory work frontier closed');};
 const cleanupActive=()=>{if(closed||phase!=='cleanup'||Number(process.hrtime.bigint())/1e6>=deadline)throw Error('Native factory cleanup frontier closed');};
 const observe=<T extends object>(client:T,carrier:FactoryStatement['carrier']):T=>new Proxy(client,{
  apply(target,self,args){
   if(typeof target!=='function')throw Error('Native query carrier required');
   if(Array.isArray(args[0])&&Object.hasOwn(args[0],'raw')){const strings:unknown[]=args[0];statements.push({carrier,text:strings.map((text,index)=>String(text)+(index<strings.length-1?'$'+(index+1):'')).join(''),values:args.slice(1)});}
   return Reflect.apply(target,self,args);
  },
  get(target,key,receiver){const value=Reflect.get(target,key,receiver);if(typeof value!=='function')return value;
   if(key==='unsafe')return(...args:unknown[])=>{if(typeof args[0]!=='string')throw Error('Native fixed SQL required');statements.push({carrier,text:args[0],values:Array.isArray(args[1])?args[1]:[]});return Reflect.apply(value,target,args);};
   if(key==='begin')return(...args:unknown[])=>Reflect.apply(value,target,args.map(arg=>typeof arg==='function'?async(tx:postgres.TransactionSql)=>{transactionDepth++;try{return await Reflect.apply(arg,undefined,[observe(tx,carrier==='cleanup'?'cleanup':'tx')]);}finally{transactionDepth--;}}:arg));
   return value;
  },
 });
 const workSql=employeeChoiceSqlFrontier(observe(work,'work'),active,operation=>callbacks.own(operation,active),callbacks.watch,callbacks.nativeFailure);
 const cleanupSql=employeeChoiceSqlFrontier(observe(cleanup,'cleanup'),cleanupActive,operation=>callbacks.own(operation,cleanupActive),callbacks.watch,callbacks.nativeFailure);
 resources.register(()=>work.end({timeout:0}));
 const stop=()=>{stopped=true;callbacks.stop();return resources.stop();};
 const abort=()=>{void stop().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const getQuery=()=>{if(transactionDepth)throw Error('Native factory attempted an outer checkout during its actual transaction');return phase==='work'?workSql:cleanupSql;};
 return{statements,workSql,getQuery,
  async identity(){active();expect(work.options.max).toBe(1);expect(work.options.connect_timeout).toBe(2);expect(cleanup.options.max).toBe(1);expect(cleanup.options.connect_timeout).toBe(2);
   const [actual]=await workSql`select pg_backend_pid() as pid,current_database() as database,current_user as role,session_user as login,current_setting('statement_timeout') as statement,current_setting('lock_timeout') as lock,
    inet_server_addr()='127.0.0.1'::inet as loopback,(select count(*)::int from pg_stat_activity where datname=current_database() and application_name=${workName}) as connections`;
   expect(actual).toMatchObject({database:workerDb(process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID!),role:'postgres',login:'postgres',statement:'20s',lock:'300ms',loopback:true,connections:1});return actual;
  },
  async heldTransactionRefusal(){
   await workSql.begin(async tx=>{const [native]=await tx`select pg_backend_pid() as pid`;expect(native.pid).toBeGreaterThan(0);expect(transactionDepth).toBe(1);expect(()=>getQuery()).toThrow('outer checkout');});
  },
  async beginCleanup(){
   await stop();await callbacks.settle();phase='cleanup';cleanupActive();
   for(;;){const [row]=await cleanupSql`select count(*)::int as remaining from pg_stat_activity where datname=current_database() and application_name=${workName}`;cleanupActive();if(row.remaining===0)break;await new Promise(resolve=>setTimeout(resolve,20));}
  },
  async close(){
   const errors:unknown[]=[];try{await stop();await callbacks.settle();}catch(error){errors.push(error);}
   try{await cleanupClose();}catch(error){errors.push(error);}clearTimeout(cleanupTimer);closed=true;signal.removeEventListener('abort',abort);
   if(Number(process.hrtime.bigint())/1e6>=deadline)errors.push(Error('Native factory complete cleanup deadline exhausted'));
   if(errors.length)throw new AggregateError(errors,'Native factory ownership settlement refused');
  },
 };
}
