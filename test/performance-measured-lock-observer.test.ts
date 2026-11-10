import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import postgres from 'postgres';
import {expect,it} from 'vitest';
import {workerDb} from './db-names';
import {createMeasuredPreflightAttribution,firstAppLockWaitCategories,measuredPreflightAttribution,originalAdvisoryAttribution} from '../scripts/performance/lock-sample-attribution.mjs';
import {createMeasuredPreflightObserver,measuredDevelopmentLockApplication,measuredDevelopmentLockUrl} from '../scripts/performance/measured-lock-observer.mjs';

const selector='test/performance-measured-lock-observer.test.ts';
const appUrl='postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev';
const hosted=process.env.GITHUB_ACTIONS==='true';

type Lock={pid:number;mode:string;granted:boolean;classid:string;objid:string;objsubid:number;app_session:boolean;blockers?:number[]};
type Probe={failure?:unknown;startedMs:number;locks:Lock[];activity:{kind:string;app_connections:number}[];attributionStart:number;attributionEnd:number;probeMode:string};

async function bounded<T>(work:Promise<T>):Promise<T>{
 const deadline=new AbortController();
 try{return await Promise.race([work,delay(3000,undefined,{signal:deadline.signal}).then(()=>{
  throw Error('Native measured lock edge was not observed in time');
 })]);}finally{deadline.abort();}
}

it.skipIf(!hosted).each(['access-configuration','audit-chain'] as const)(
 'observes and drains a genuine PostgreSQL %s app wait through the dedicated preflight worker',async family=>{
 expect(process.env.CI).toBe('true');
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 expect(process.env.RUNNER_OS).toBe('Linux');
 expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 expect(process.env.GITHUB_REPOSITORY_ID).toBe('1333414856');
 expect(process.env.GITHUB_RUN_ID).toMatch(/^[1-9]\d*$/);
 expect(process.env.AIHR_CI_HEAD).toMatch(/^[a-f0-9]{40}$/);
 if(process.env.GITHUB_JOB==='selected-tests'){
  expect(process.env.GITHUB_WORKFLOW).toBe('alpha-focused-checks');
  expect(process.env.GITHUB_EVENT_NAME).toBe('workflow_dispatch');
  const selection:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'null');
  expect(Array.isArray(selection)&&selection.includes(selector)).toBe(true);
  expect(process.env.TEST_DB_NAMESPACE).toBe('aifocus');
 }else{
  expect(process.env.GITHUB_JOB).toBe('test');
  expect(process.env.GITHUB_WORKFLOW).toBe('alpha-staging-ci');
  expect(process.env.AIHR_CI_UNIT).toMatch(/^db-(?:[1-4]|[0-9a-f]{16})$/);
  expect(process.env.TEST_DB_NAMESPACE??'').toBe('');
  expect(process.env.AIHR_FOCUSED_TESTS).toBeUndefined();
 }
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 expect(poolId).toMatch(/^[1-9]\d{0,2}$/);
 const focusedDb=workerDb(poolId!);
 expect(process.env.TEST_DATABASE_URL).toBe('postgres://ai_hr_app@127.0.0.1:5433/'+focusedDb);
 expect(process.env.TEST_MIGRATION_DATABASE_URL).toBe('postgres://postgres@127.0.0.1:5433/'+focusedDb);

 // The job provisions ai_hr_dev separately from its test workers and full browser.
 // The system-tenant auth event is deliberately rolled back after the native witness.
 const options={max:1,connect_timeout:2,onnotice:()=>{},connection:{statement_timeout:5000}};
 const owner=postgres(measuredDevelopmentLockUrl,options),app=postgres(appUrl,options);
 const proof=Promise.withResolvers<Probe>(),clean=Promise.withResolvers<Probe>(),failed=Promise.withResolvers<never>();
 void failed.promise.catch(()=>{});
 const attribution=createMeasuredPreflightAttribution();
 attribution.setPhase('browser-workflows');
 attribution.setWorkload('personnel-profile');
 const audit=family==='audit-chain';
 const key=audit?'audit-chain:00000000-0000-0000-0000-000000000000':'measured-observer-test:'+randomUUID();
 const auditAggregateId=randomUUID();
 let holder:Awaited<ReturnType<typeof owner.reserve>>|undefined,actor:Awaited<ReturnType<typeof app.reserve>>|undefined;
 let observer:ReturnType<typeof createMeasuredPreflightObserver>|undefined,waiting:Promise<boolean>|undefined,holding=false,actorTransaction=false,releasedAt=Infinity;
 try{
  holder=await owner.reserve();actor=await app.reserve();
  const identity=(sql:typeof holder)=>sql!`select pg_backend_pid() as pid,current_database() as db,
   session_user as login,current_user as role,host(inet_server_addr()) as address,inet_server_port() as port`;
  const [[holderIdentity],[actorIdentity]]=await Promise.all([identity(holder),identity(actor)]);
  expect(holderIdentity).toMatchObject({db:'ai_hr_dev',login:'postgres',role:'postgres',address:'127.0.0.1',port:5433});
  expect(actorIdentity).toMatchObject({db:'ai_hr_dev',login:'ai_hr_app',role:'ai_hr_app',address:'127.0.0.1',port:5433});
  expect(holderIdentity.pid).not.toBe(actorIdentity.pid);
  const [ids]=await holder<{hash:string;lockKey:string}[]>`select key::text as hash,
   concat(((key>>32)&4294967295),':',(key&4294967295),':1') as "lockKey"
   from (select case when ${audit}::boolean then hashtext(${key})::bigint else hashtextextended(${key},0) end as key) k`;
  const lockKey=(row:Lock)=>row.classid+':'+row.objid+':'+row.objsubid;
  observer=createMeasuredPreflightObserver({url:measuredDevelopmentLockUrl,accessLocks:audit?[]:[ids.lockKey],auditLocks:audit?[ids.lockKey]:[],
   categorized:true,token:attribution.token,
   onFailure:failed.reject,onProbe(probe:Probe){
    if(probe.failure){failed.reject(Error('Native measured probe failed'));return;}
    const actorQueued=probe.locks.some(row=>!row.granted&&row.pid===actorIdentity.pid&&lockKey(row)===ids.lockKey);
    if(actorQueued&&probe.activity.some(row=>row.kind==='Lock'&&row.app_connections>0))proof.resolve(probe);
    if(probe.startedMs>=releasedAt&&!probe.locks.some(row=>lockKey(row)===ids.lockKey)
     &&!probe.activity.some(row=>row.kind==='Lock'&&row.app_connections>0))clean.resolve(probe);
   }});
  await observer.ready();
  const [workerSession]=await holder<{pids:number[]}[]>`select coalesce(array_agg(pid),array[]::integer[]) as pids from pg_stat_activity
   where datname=current_database() and usename='postgres' and application_name=${measuredDevelopmentLockApplication}`;
  expect(workerSession.pids).toHaveLength(1);

  expect((await holder`begin`).command).toBe('BEGIN');holding=true;
  const [owned]=await holder<{held:boolean}[]>`select pg_try_advisory_xact_lock(${ids.hash}::bigint) as held`;
  expect(owned.held).toBe(true);
  if(audit){expect((await actor`begin`).command).toBe('BEGIN');actorTransaction=true;}
  const command=audit
   ?actor`select app.append_auth_event(NULL,'internal-login',${auditAggregateId}::uuid,'app-user.login-refused','external',NULL,NULL)`
   :actor`select pg_advisory_xact_lock(${ids.hash}::bigint)`;
  waiting=command.then(result=>result.command==='SELECT',()=>false);
  await observer.start();
  const blocked=await bounded(Promise.race([proof.promise,failed.promise]));
  const [edge]=await holder<{blocked:boolean}[]>`select pg_blocking_pids(${actorIdentity.pid}::int)=array[pg_backend_pid()] as blocked`;
  expect(edge.blocked).toBe(true);
  expect(blocked.probeMode).toBe('combined-statement');
  expect(blocked).not.toHaveProperty('activityCompletedMs');
  expect(blocked).not.toHaveProperty('advisoryStartedMs');
  const waitingOnLock=blocked.activity.filter(row=>row.kind==='Lock').reduce((sum,row)=>sum+row.app_connections,0);
  expect(waitingOnLock).toBeGreaterThan(0);
  expect(firstAppLockWaitCategories(blocked.activity,waitingOnLock)?.advisory).toBeGreaterThan(0);
  expect(measuredPreflightAttribution(blocked.attributionStart,blocked.attributionEnd)).toEqual({phase:'browser-workflows',workloadStage:'personnel-profile'});
  expect(originalAdvisoryAttribution(blocked.locks,new Map([[ids.lockKey,family+':fixture-test']]))).toMatchObject({
   waiters:[{family,mode:'ExclusiveLock',...(audit?{category:'auth-audit-append'}:{})}],
   edges:[{source:'original-sample',family,waiterMode:'ExclusiveLock',blockerMode:'ExclusiveLock',blockerState:'granted',
    waiterCategory:audit?'auth-audit-append':'unknown',blockerCategory:'unknown'}],
  });
  expect((await holder`rollback`).command).toBe('ROLLBACK');holding=false;
  expect(await waiting).toBe(true);
  if(actorTransaction){
   expect((await actor`rollback`).command).toBe('ROLLBACK');actorTransaction=false;
   const [settled]=await holder<{absent:boolean}[]>`select not exists(select 1 from domain_event
    where aggregate_id=${auditAggregateId}::uuid) as absent`;
   expect(settled.absent).toBe(true);
  }
  releasedAt=performance.now();
  await bounded(Promise.race([clean.promise,failed.promise]));
  const stopped=observer.stop();
  expect(observer.stop()).toBe(stopped);
  await stopped;
  const closureDeadline=performance.now()+1000;
  let workerGone=false;
  do{
   const [settled]=await holder<{gone:boolean}[]>`select not exists(select 1 from pg_stat_activity
    where pid=${workerSession.pids[0]} and application_name=${measuredDevelopmentLockApplication}) as gone`;
   workerGone=settled.gone;
   if(!workerGone)await delay(10);
  }while(!workerGone&&performance.now()<closureDeadline);
  expect(workerGone).toBe(true);
 }finally{
  const rollback=holding&&holder?await Promise.allSettled([holder`rollback`]):[];
  await waiting;
  const actorRollback=actorTransaction&&actor?await Promise.allSettled([actor`rollback`]):[];
  actor?.release();holder?.release();
  const outcomes=[...rollback,...actorRollback,...await Promise.allSettled([observer?.stop(),owner.end({timeout:2}),app.end({timeout:2})])];
  if(outcomes.some(outcome=>outcome.status==='rejected'))throw Error('Native measured lock proof did not settle');
 }
});
