/** Owned disposable controller; neither URL nor native owner crosses a worker boundary. */
import postgres from 'postgres';
import {expect} from 'vitest';
import {z} from 'zod';
import {workerDb} from '../db-names';
import {defaultControllerApplication} from './rewards-audit-default-controller-protocol';
import {rewardsAuditPolicyLifetime} from './rewards-audit-policy-lifetime';
const identitySchema=z.object({pid:z.number().int().positive(),started:z.string().min(20),database:z.string(),session_user:z.string(),current_user:z.string(),loopback:z.literal(true),statement:z.string(),lock:z.string(),isolation:z.string(),readonly:z.string(),native_owner:z.literal(true)}).strict();
type Identity=z.infer<typeof identitySchema>;
export function rewardsAuditPolicyController(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr')throw Error('Authenticated sole hosted policy profile required');
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;if(!pool||!/^[1-9][0-9]*$/.test(pool)||process.env.WORKER_DB==='0')throw Error('Actual canonical owned worker required');
 const database=workerDb(pool),raw=process.env.TEST_MIGRATION_DATABASE_URL;if(!raw)throw Error('Canonical private controller URL required');const url=new URL(raw);
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.pathname!=='/'+database||url.search||url.hash)throw Error('Fixed loopback policy owner source required');
 const work=postgres(url.toString(),{max:1,connect_timeout:2,connection:{statement_timeout:20000,lock_timeout:300,application_name:'owned_rewards_policy_work'}});
 const cleanup=postgres(url.toString(),{max:1,connect_timeout:2,connection:{statement_timeout:2000,lock_timeout:300,application_name:'owned_rewards_policy_cleanup'}});
 const observer=postgres(url.toString(),{max:1,connect_timeout:2,connection:{statement_timeout:2000,lock_timeout:300,application_name:'owned_rewards_policy_observer'}});
 const identities:Identity[]=[],stops=new Set<()=>Promise<void>>(),defaultControllers=new Set<string>();
 const lifetime=rewardsAuditPolicyLifetime({work:async()=>{await Promise.all([work.end({timeout:0}),...[...stops].map(stop=>stop())]);},cleanup:()=>cleanup.end({timeout:0})});
 const owner={get client(){return lifetime.ownerPhase()==='work'?work:cleanup;}};
 async function identity(kind:'work'|'cleanup'){
  const connection=kind==='work'?work:cleanup;
  const [raw]=await connection`select pg_backend_pid()as pid,backend_start::text as started,current_database()as database,session_user,current_user,
   inet_server_addr()='127.0.0.1'::inet as loopback,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock,
   current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as readonly,
   current_user::regrole::oid=(select relowner from pg_class where oid='public.domain_event'::regclass)as native_owner from pg_stat_activity where pid=pg_backend_pid()`;
  const row=identitySchema.parse(raw);expect(row).toMatchObject({database,session_user:decodeURIComponent(url.username),current_user:decodeURIComponent(url.username),statement:kind==='work'?'20s':'2s',lock:'300ms',isolation:'read committed',readonly:'off'});identities.push(row);return row;
 }
 return{
  owner,lifetime,database,
  dependencies:{owner,migrateTestDb:async()=>{await identity('work');},closeAll:async()=>{await Promise.all([work.end({timeout:0}),cleanup.end({timeout:0})]);}},
  registerDefaultController(nonce:string){const name=defaultControllerApplication(nonce);if(defaultControllers.has(name)||defaultControllers.size>=2)throw Error('Only two owned default-controller lifetimes allowed');defaultControllers.add(name);},
  registerStop(stop:()=>Promise<void>){let owned:Promise<void>|undefined;stops.add(()=>owned??=Promise.resolve().then(stop));},
  /** All case work is already drained before this actual bounded restoration. */
  async close(knownOwned:boolean,restore:()=>Promise<void>){
   let failure:unknown;
   try{await lifetime.close(async()=>{await identity('cleanup');await Promise.all([...stops].map(stop=>stop()));await restore();},knownOwned?'known':'uncertain');}catch(error){failure=error;}
   finally{
    await Promise.allSettled([work.end({timeout:0}),cleanup.end({timeout:0})]);
    // Observe exact native identities after the SQL/socket drain; never guess
    // ownership from a role name alone or truncate backend-start precision.
    try{
     const deadline=performance.now()+2000;let absent=false;
     do{
      const [actual]=await observer`select current_database()as database,current_user,inet_server_addr()='127.0.0.1'::inet as loopback,
       not exists(select 1 from pg_stat_activity s join jsonb_to_recordset(${JSON.stringify(identities)}::text::jsonb)as owned(pid integer,started text,session_user text)
        on s.pid=owned.pid and s.backend_start=owned.started::timestamptz and s.usename=owned.session_user where s.datname=${database})
       and not exists(select 1 from pg_stat_activity s where s.datname=${database} and s.usename=${decodeURIComponent(url.username)} and s.application_name=any(${[...defaultControllers]}::text[]))as absent`;
      expect(actual).toMatchObject({database,current_user:decodeURIComponent(url.username),loopback:true});
      if(actual.absent===true){absent=true;break;}if(performance.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,10));
     }while(performance.now()<deadline);
     expect(absent,'all exact owned native controller PID/start identities are absent after drain').toBe(true);
    }catch(error){lifetime.poison(error instanceof Error?error:Error('Owned controller backend absence refused'));failure??=error;}
    finally{await observer.end({timeout:0});}
   }
   if(failure)throw failure;
  },
 };
}
