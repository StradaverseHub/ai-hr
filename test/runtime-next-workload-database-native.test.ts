/** Actual workload cluster boundary. The browser and business fixture are separate courses. */
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import postgres from 'postgres';
import {expect,it} from 'vitest';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {NATIVE_WORKLOAD_DATABASE_CASE,NATIVE_WORKLOAD_DATABASE_MEMBER,NATIVE_WORKLOAD_OBSERVER,
 validateNativeWorkloadObserverUrl} from '../.github/ci/singleton-protocol.mjs';
import {protectedLockObserverCounts,protectedLockObserverQuery} from '../scripts/performance/protected-lock-observer.mjs';

const admission=admitSingletonTest('test/runtime-next-workload-database-native.test.ts');
if(admission.mode!=='full-ci-singleton'||!admission.workloadDatabase||!admission.workloadContext)throw Error('Native workload database custody binding required');
const custody=admission.workloadDatabase,context=admission.workloadContext;

const client=(url:string)=>postgres(url,{max:1,connect_timeout:3,connection:{statement_timeout:2000,lock_timeout:300}});
type Client=ReturnType<typeof client>;
async function refusalCode(run:()=>PromiseLike<unknown>){
 try{await run();return 'unexpected-success';}
 catch(error){return typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'unclassified';}
}
async function refuseConnection(url:string,code:string){
 const db=client(url);
 try{expect(await refusalCode(()=>db`select 1`)).toBe(code);}
 finally{await db.end({timeout:2});}
}
async function nativeSession(db:Client){
 const [row]=await db`select session_user::text as login,current_user::text as role,current_database() as database,
  (select oid::text from pg_database where datname=current_database()) as oid,
  host(inet_server_addr()) as host,inet_server_port() as port,
  r.rolsuper as superuser,r.rolbypassrls as bypass,r.rolcreatedb as "createDb",r.rolcreaterole as "createRole",
  r.rolreplication as replication,r.rolconnlimit as "connectionLimit",
  current_setting('transaction_read_only')='on' as "readOnly"
  from pg_roles r where r.rolname=current_user`;
 return row;
}

type BackendIdentity={pid:number,backendStart:string,databaseOid:string};
async function lockBackend(db:Client,databaseOid:string,role:string):Promise<BackendIdentity>{
 const [row]=await db<BackendIdentity[]>`select pid,datid::text as "databaseOid",
  extract(epoch from backend_start)::text as "backendStart" from pg_catalog.pg_stat_activity
  where pid=pg_backend_pid() and datname='ai_hr_test_w1' and backend_type='client backend'
   and session_user=${role} and current_user=${role} and host(inet_server_addr())='127.0.0.1' and inet_server_port()=5433
   and (select count(*) from pg_catalog.pg_settings where unit='ms'
    and (name,setting) in (('statement_timeout','2000'),('lock_timeout','300')))=2`;
 if(!row||!Number.isSafeInteger(row.pid)||row.pid<=1||typeof row.backendStart!=='string'
  ||!/^\d+(?:\.\d+)?$/.test(row.backendStart)||row.databaseOid!==databaseOid){
  throw Error('Native workload lock backend refused');
 }
 return row;
}

async function verifyNativeLockObservation(owner:Client,app:Client,observer:Client,databaseOid:string){
 // All three pools are already warm and each admits only one physical connection.
 // Their caller closes them even if a reservation or native settlement refuses.
 const holder=await owner.reserve(),actor=await app.reserve(),reader=await observer.reserve();
 const ownerBackend=await lockBackend(holder,databaseOid,'postgres'),appBackend=await lockBackend(actor,databaseOid,'ai_hr_app');
 const observerBackend=await lockBackend(reader,databaseOid,NATIVE_WORKLOAD_OBSERVER);
 if(new Set([ownerBackend.pid,appBackend.pid,observerBackend.pid]).size!==3)throw Error('Native workload lock backends were not distinct');
 const [identity]=await holder`select system_identifier::text as id from pg_catalog.pg_control_system()`;
 if(typeof identity?.id!=='string'||createHash('sha256').update(identity.id).digest('hex')!==custody.systemIdentifierSha256){
  throw Error('Native workload held cluster identity differed');
 }
 const sample=async()=>protectedLockObserverCounts(await protectedLockObserverQuery(reader),observerBackend);
 const before=await sample();
 if(before.appSessions!==1||before.blockingAppSessions!==0)throw Error('Native workload lock baseline refused');

 // One fixed, synthetic two-int advisory key on the owned worker database.
 const lockClass=1314344014,lockObject=1;
 let waiter:Promise<boolean>|undefined;
 const errors:unknown[]=[];
 try{
  // Explicit commands keep rollback on the reserved backend without an async begin callback.
  if((await holder`begin`).command!=='BEGIN')throw Error('Native workload lock transaction refused');
  const [lock]=await holder`select pg_backend_pid() as pid,
   pg_catalog.pg_try_advisory_xact_lock(${lockClass}::int4,${lockObject}::int4) as acquired`;
  if(lock?.pid!==ownerBackend.pid||lock.acquired!==true)throw Error('Native workload held lock refused');
  // Keep a handler attached from dispatch through rollback. The app's existing
  // 300ms lock_timeout still applies, and this observation must finish earlier.
  const deadline=performance.now()+200;
  waiter=actor`select pg_catalog.pg_advisory_xact_lock(${lockClass}::int4,${lockObject}::int4)`
   .then(result=>result.command==='SELECT'&&result.length===1,()=>false);
  let observed=false;
  for(let attempt=0;attempt<12&&performance.now()<deadline;attempt++){
   const row=await sample();
   if(row.appSessions!==1)throw Error('Native workload app session census differed');
   if(performance.now()>=deadline)break;
   if(row.blockingAppSessions===1){
    // This is the first statistics observation in the held transaction.
    const [edge]=await holder`select pg_backend_pid() as pid,exists(
     select 1 from pg_catalog.pg_stat_activity a where a.pid=${appBackend.pid}::int4
      and a.datid=${databaseOid}::oid and extract(epoch from a.backend_start)::text=${appBackend.backendStart}
      and a.usename='ai_hr_app' and a.wait_event_type='Lock' and a.wait_event='advisory'
      and pg_catalog.pg_blocking_pids(a.pid)=array[pg_backend_pid()]
    ) as blocked`;
    observed=edge?.pid===ownerBackend.pid&&edge.blocked===true&&performance.now()<deadline;
    break;
   }
   if(attempt<11&&performance.now()+10<deadline)await sleep(10);
  }
  if(!observed)throw Error('Native workload lock edge was not observed within its bound');
 }catch(error){errors.push(error);}
 finally{
  // Roll back even if BEGIN acknowledgement was ambiguous. A refused rollback
  // prevents receipt emission, and the parent still has to stop the whole cluster.
  try{
   if((await holder`rollback`).command!=='ROLLBACK')throw Error('Native workload lock rollback refused');
  }catch(error){errors.push(error);}
  if(waiter&&!(await waiter))errors.push(Error('Native workload app lock waiter did not settle successfully'));
 }
 if(errors.length)throw new AggregateError(errors,'Native workload lock observation or settlement refused');

 const [terminal]=await holder`select pg_backend_pid() as pid,not exists(
  select 1 from pg_catalog.pg_locks l where l.database=${databaseOid}::oid and l.locktype='advisory'
   and l.classid=${lockClass}::oid and l.objid=${lockObject}::oid and l.objsubid=2
 ) as released`;
 const after=await sample();
 if(terminal?.pid!==ownerBackend.pid||terminal.released!==true||after.appSessions!==1||after.blockingAppSessions!==0){
  throw Error('Native workload lock release could not be verified');
 }
 reader.release();actor.release();holder.release();
}

it(NATIVE_WORKLOAD_DATABASE_CASE,async()=>{
 const ownerUrl=process.env.MIGRATION_DATABASE_URL!,appUrl=process.env.DATABASE_URL!,observerUrl=validateNativeWorkloadObserverUrl(process.env);
 const owner=client(ownerUrl),app=client(appUrl),observer=client(observerUrl);
 try{
  const ownerSession=await nativeSession(owner),appSession=await nativeSession(app),observerSession=await nativeSession(observer);
  expect(ownerSession).toMatchObject({login:'postgres',role:'postgres',superuser:true});
  expect(appSession).toMatchObject({login:'ai_hr_app',role:'ai_hr_app',superuser:false,bypass:false,createDb:false,createRole:false,replication:false});
  expect(observerSession).toMatchObject({login:NATIVE_WORKLOAD_OBSERVER,role:NATIVE_WORKLOAD_OBSERVER,superuser:false,bypass:false,
   createDb:false,createRole:false,replication:false,connectionLimit:2,readOnly:true});
  expect(ownerSession.oid).toMatch(/^[1-9][0-9]*$/);
  for(const session of [ownerSession,appSession,observerSession])expect(session).toMatchObject({database:'ai_hr_test_w1',oid:ownerSession.oid,host:'127.0.0.1',port:5433});
  const [identity]=await owner`select system_identifier::text as id from pg_control_system()`;
  expect(createHash('sha256').update(identity.id).digest('hex')).toBe(custody.systemIdentifierSha256);
  const [permissions]=await app`select row_security_active('public.employment') as rls,
   has_table_privilege(current_user,'public.employment','SELECT') as readable`;
  expect(permissions).toEqual({rls:true,readable:true});
  const [statistics]=await observer`select pg_has_role(current_user,'pg_read_all_stats','USAGE') as readable`;
  expect(statistics.readable).toBe(true);
  const [statements]=await observer`select count(*)::int as statements from pg_stat_statements`;
  expect(Number.isSafeInteger(statements.statements)&&statements.statements>=0).toBe(true);
  expect(await refusalCode(()=>observer`select pg_stat_statements_reset()`)).toBe('42501');
  expect(await refusalCode(()=>observer`select id from public.employment limit 1`)).toBe('42501');
  expect(await refusalCode(()=>observer`set role postgres`)).toBe('42501');
  expect(await refusalCode(()=>observer`set role pg_read_all_stats`)).toBe('42501');
  expect(await refusalCode(()=>app`set role postgres`)).toBe('42501');

  expect(process.env.PGPASSWORD===undefined).toBe(true);
  for(const raw of [ownerUrl,appUrl,observerUrl]){
   const missing=new URL(raw);missing.password='';await refuseConnection(missing.href,'28P01');
  }
  for(const raw of [appUrl,observerUrl]){
   const crossRole=new URL(raw);crossRole.username='postgres';await refuseConnection(crossRole.href,'28P01');
   const foreignDb=new URL(raw);foreignDb.pathname='/ai_hr_dev';await refuseConnection(foreignDb.href,'28000');
  }
  const foreignOwnerDb=new URL(ownerUrl);foreignOwnerDb.pathname='/template1';await refuseConnection(foreignOwnerDb.href,'28000');
  await verifyNativeLockObservation(owner,app,observer,ownerSession.oid);
 }finally{
  const closures=await Promise.allSettled([owner.end({timeout:2}),app.end({timeout:2}),observer.end({timeout:2})]);
  if(closures.some(row=>row.status==='rejected'))throw Error('Native workload test client closure refused');
 }
 writeFileSync(join(admission.evidenceDirectory,NATIVE_WORKLOAD_DATABASE_MEMBER),JSON.stringify({
  kind:'NATIVE_WORKLOAD_DATABASE_CUSTODY_COMPONENT_ONLY',...context,unit:admission.databaseUnit,
  systemIdentifierSha256:custody.systemIdentifierSha256,containerIdentitySha256:custody.containerIdentitySha256,
  authenticatedRoles:3,connectionRefusals:8,privilegeRefusals:5,clientClosures:3,releaseEligible:false,
 })+'\n',{flag:'wx',mode:0o600});
});
