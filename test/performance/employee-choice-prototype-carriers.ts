/** Private verification metadata carriers. Actual SQL authority is the fixed
 * disposable worker credential; no harness/default mutation or caller mode. */
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {employeeChoiceOwnedUrl} from './employee-choice-owned-binding';
import {employeeChoiceSqlFrontier,employeeChoiceCloseRegistry,employeeChoiceWorkRegistry} from './employee-choice-sql-frontier';
import {employeeChoiceOwnedSettlement} from './employee-choice-owned-settlement';
export function employeeChoicePrototypeCarriers(signal:AbortSignal,admit:()=>void){
 const nonce=randomUUID().slice(0,8),workName='employee_ascii_owner_work_'+nonce,cleanupName='employee_ascii_owner_cleanup_'+nonce;
 employeeChoiceOwnedUrl(process.env.TEST_DATABASE_URL!,'ai_hr_app',workName);
 const endpoint=new URL(employeeChoiceOwnedUrl(process.env.TEST_MIGRATION_DATABASE_URL!,'postgres',workName));endpoint.search='';
 const work=postgres(endpoint.href,{max:1,connect_timeout:2,connection:{application_name:workName,statement_timeout:'20s',lock_timeout:'300ms'}});
 const cleanup=postgres(endpoint.href,{max:1,connect_timeout:2,connection:{application_name:cleanupName,statement_timeout:'1s',lock_timeout:'300ms'}});
 const callbacks=employeeChoiceWorkRegistry(),resources=employeeChoiceCloseRegistry();
 let phase:'work'|'draining'|'probing'|'cleanup'|'closed'='work',stopped:Promise<void>|undefined,cleanupClose:Promise<void>|undefined,closing:Promise<void>|undefined;
 let cleanupDeadline=Infinity,timer:ReturnType<typeof setTimeout>|undefined;
 const closeCleanup=()=>cleanupClose??=cleanup.end({timeout:0});
 const active=()=>{if(phase!=='work'||signal.aborted)throw Error('Prototype metadata work frontier closed');admit();};
 const cleanupActive=()=>{if(phase!=='cleanup'||Number(process.hrtime.bigint())/1e6>=cleanupDeadline)throw Error('Prototype metadata cleanup frontier closed');};
 const workSql=employeeChoiceSqlFrontier(work,active,operation=>callbacks.own(operation,active),callbacks.watch,callbacks.nativeFailure);
 const cleanupSql=employeeChoiceSqlFrontier(cleanup,cleanupActive,operation=>callbacks.own(operation,cleanupActive),callbacks.watch,callbacks.nativeFailure);
 resources.register(()=>work.end({timeout:0}));
 const stop=()=>{if(phase==='work')phase='draining';callbacks.stop();return stopped??=resources.stop();};
 const abort=()=>{void stop().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const getPhase=()=>{if(phase==='work'){active();return phase;}if(phase==='cleanup'){cleanupActive();return phase;}throw Error('Prototype metadata carrier not admitted');};
 const getQuery=()=>getPhase()==='work'?workSql:cleanupSql;
 return{getQuery,getPhase,stop,
  async identity(){active();expect(work.options.max).toBe(1);expect(cleanup.options.max).toBe(1);expect(work.options.connect_timeout).toBe(2);expect(cleanup.options.connect_timeout).toBe(2);
   const [row]=await workSql`select current_database()as database,current_user as role,session_user as login,pg_backend_pid()as pid,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock`;
   expect(row).toMatchObject({database:endpoint.pathname.slice(1),role:'postgres',login:'postgres',statement:'20s',lock:'300ms'});expect(row.pid).toBeGreaterThan(0);return row;
  },
  async beginCleanup(deadline:number){
   if(phase!=='work'&&phase!=='draining')throw Error('Prototype metadata cleanup already admitted');
   cleanupDeadline=Math.min(deadline,Number(process.hrtime.bigint())/1e6+26000);
   timer=setTimeout(()=>{void closeCleanup().catch(()=>{});},Math.max(0,cleanupDeadline-Number(process.hrtime.bigint())/1e6));
   await employeeChoiceOwnedSettlement({stop,callbacks:()=>callbacks.settle(),resources:()=>resources.settle()});phase='probing';
   // Only this FIXED observation may use the private cleanup connection before
   // handoff. Neither getQuery nor getPhase admits a caller during probing.
   for(;;){
    if(Number(process.hrtime.bigint())/1e6>=cleanupDeadline)throw Error('Prototype native quiescence deadline exhausted');
    const [row]=await cleanup`select count(*)::int as remaining from pg_stat_activity where datname=current_database() and application_name=${workName}`;
    if(Number(process.hrtime.bigint())/1e6>=cleanupDeadline)throw Error('Prototype native quiescence deadline exhausted');
    if(row.remaining===0)break;await new Promise(resolve=>setTimeout(resolve,20));
   }
   phase='cleanup';cleanupActive();
  },
  close(){
   if(closing)return closing;phase='closed';
   closing=(async()=>{
    const errors:unknown[]=[];try{await employeeChoiceOwnedSettlement({stop,callbacks:()=>callbacks.settle(),resources:()=>resources.settle(),cleanup:closeCleanup});}catch(error){errors.push(error);}
    if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);
    if(Number(process.hrtime.bigint())/1e6>=cleanupDeadline)errors.push(Error('Prototype metadata complete cleanup deadline exhausted'));
    if(errors.length)throw new AggregateError(errors,'Private prototype metadata settlement refused');
   })();void closing.catch(()=>{});return closing;
  },
 };
}
