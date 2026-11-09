/** Fictional historical upgrade and actual owner/app LOGIN, standard hosted native DB only. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {createDb,type SessionContext} from '../db/client';
import {aiCentreSelectedMetadataDiagnosticIntent,aiCentreSelectedMetadataFrontierObservation,constructAiCentreSelectedPrefixOwner,aiCentreSelectedUpgradeSource} from './helpers/ai-centre-compatibility-owner-constructor';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
const admission=admitSingletonTest('test/ai-centre-mandate-write-order-upgrade.test.ts');

const migrationFile='db/migrations/3501_ai_centre_mandate_write_order.sql';
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const historical={
 '0180_profile_option':{when:1781862179000,hash:'ae128e75c9491bd1d39537fdddd18ad9307b2050f813b8a056d473dcfda9d41f',commit:'b33432256168fc67955e5f183bb84c1a444b63ed'},
 '0212_dashboard_card_config':{when:1781862211000,hash:'aa9337028da35cd3816d8d66486455595e36aea709c98405868ca36320c99f41',commit:'b8bb0740d3fa5ef1cf60400eb484fa40399e921c'},
}as const;
async function boundedReady(ready:Promise<void>,running:Promise<unknown>){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([ready,running.then(()=>{throw Error('Native foreign transaction finished before expected entry');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Native foreign transaction never entered')),2500);})]);}finally{clearTimeout(timer);}
}
const oldFunctions=['app.ai_centre_control_lock()','app.teras_bump_version()'];
const newFunctions=['app.ai_centre_mandate_write_order()','app.ai_centre_mandate_bound_tenant()'];
const newTriggers=['aa_ai_centre_mandate_write_order','aaa_ai_centre_bound_tenant'];

it('upgrades actual historical709 through3500 to3501 as the real non-super owner and proves guarded tenant-bound native writes',async context=>{
 const caseStartedAt=performance.now();
 const {journal,boundaries}=aiCentreSelectedUpgradeSource();
 const token=randomUUID().replaceAll('-',''),database='ai_hr_ai_compat_'+token,role='aihr_ai_compat_'+token;
 const directory=mkdtempSync(join(tmpdir(),'aihr-ai-write-order-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(['127.0.0.1','localhost']).toContain(appUrl.hostname);
 expect(ownerUrl.username).toBe('postgres');expect(appUrl.username).toBe('ai_hr_app');expect(appUrl.password).toBe('');
 expect(appUrl.hostname).toBe(ownerUrl.hostname);expect(appUrl.port).toBe(ownerUrl.port);
 const metadataIntent=aiCentreSelectedMetadataDiagnosticIntent();
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{},...metadataIntent?.adminOptions});
 ownerUrl.pathname='/'+database;appUrl.pathname='/'+database;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});
 let migration:ReturnType<typeof createDb>|undefined,created=false,roleCreated=false,primaryFailure:unknown;
 let metadataExternalStop=false,metadataPending=false;
 let databaseOid:string|undefined,roleOid:string|undefined,selectedCourse:Awaited<ReturnType<typeof constructAiCentreSelectedPrefixOwner>>|undefined;
 const report:Record<string,unknown>={kind:'NATIVE_AI_CENTRE_MANDATE_WRITE_ORDER_COMPONENT_ONLY',releaseAuthorized:false,complete:false,cleanupComplete:false,
  historicalOriginals:historical,selectedSourceBoundaries:[boundaries.historical,boundaries.alphaSeven,boundaries.payroll,boundaries.compatibility,boundaries.mandate],phase:'constructor',resourceBound:{caseMs:300000,pools:4,maxPerPool:1,maximumConnections:4,extraOwnerLoginPools:1,
   poolCloseSeconds:5,lockTimeoutMs:5000,statementTimeoutMs:10000,foreignDenialObservationMs:2500,observerPolls:100,observerPollMs:20}};
 const save=()=>{writeFileSync(join(admission.evidenceDirectory,'ai-centre-mandate-write-order-upgrade.json'),JSON.stringify(report,null,2));};
 const tenantId=randomUUID(),foreignTenant=randomUUID(),userId=randomUUID(),foreignUser=randomUUID();
 const ctx:SessionContext={tenantId,userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 const catalogue=async()=>({
  table:await storage.client`select to_jsonb(c)as row from pg_class c where c.oid='public.teras_mandate_control'::regclass`,
  functions:await storage.client`select p.oid,to_jsonb(p)as row,pg_get_functiondef(p.oid)as definition from pg_proc p where p.oid=any(${oldFunctions}::text[]::regprocedure[]) order by p.oid`,
  triggers:await storage.client`select to_jsonb(t)as row,pg_get_triggerdef(t.oid)as definition from pg_trigger t where t.tgrelid='public.teras_mandate_control'::regclass and not t.tgisinternal and not(t.tgname=any(${newTriggers})) order by t.oid`,
  policies:await storage.client`select to_jsonb(p)as row from pg_policy p where p.polrelid='public.teras_mandate_control'::regclass order by p.oid`,
 });
 const facts=()=>storage.client`select to_jsonb(c)as row from teras_mandate_control c order by tenant_id`;
 const guard=readFileSync(migrationFile,'utf8').split('--> statement-breakpoint')[0];
 try{
  await admin.unsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT -1`);roleCreated=true;
  [{oid:roleOid}]=await admin<{oid:string}[]>`select oid::text as oid from pg_roles where rolname=${role}`;
  await admin.unsafe(`CREATE DATABASE "${database}" OWNER "${role}"`);created=true;
  [{oid:databaseOid}]=await admin<{oid:string}[]>`select oid::text as oid from pg_database where datname=${database}`;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries){const original=historical[entry.tag as keyof typeof historical];
   const path=original?'.github/ci/historical-migrations/'+entry.tag+'.sql':'db/migrations/'+entry.tag+'.sql';
   if(original){expect(entry.when).toBe(original.when);expect(sha(readFileSync(path))).toBe(original.hash);}copyFileSync(path,join(directory,entry.tag+'.sql'));
  }
  const stage=(count:number)=>writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,count)}));
  stage(boundaries.historical);await migrate(storage.db,{migrationsFolder:directory});
  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenantId},${randomUUID()},'Fictional write-order group'),(${foreignTenant},${randomUUID()},'Fictional foreign group')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${userId},${tenantId},null,${randomUUID()}),(${foreignUser},${foreignTenant},null,${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenantId},${userId},'hr_admin')`;
  // Before3501 the source constructor can populate both fictional tenants without a binding.
  await storage.client`insert into teras_mandate_control(tenant_id,stopped,version,changed_by_user_id) values(${tenantId},true,7,${userId}),(${foreignTenant},true,11,${foreignUser})`;
  if(metadataIntent){report.metadataFrontier=metadataIntent.pending;save();metadataPending=true;}
  const selected=await constructAiCentreSelectedPrefixOwner(storage.client,admin,database,role,directory,context.signal,caseStartedAt);selectedCourse=selected;migration=selected.migration;
  const construction=selected.construction;report.selectedPrefix=selected.report;
  report.constructor={realm:construction.realm,memberships:construction.memberships,perKind:construction.perKind,transferred:construction.transferred,
   beforeSha256:sha(Buffer.from(JSON.stringify(construction.before))),afterSha256:sha(Buffer.from(JSON.stringify(construction.after)))};
  const [actualOwner]=await migration.client`select current_user as role,session_user as login,current_database()as database,inet_server_addr()='127.0.0.1'::inet as loopback,
   r.rolsuper,r.rolinherit,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolconnlimit from pg_roles r where r.rolname=current_user`;
  expect(actualOwner).toEqual({role,login:role,database,loopback:true,rolsuper:false,rolinherit:true,rolcanlogin:true,rolreplication:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,rolconnlimit:-1});report.migrationOwner=actualOwner;
  const initialLedger=await ledger(),initialCatalogue=await catalogue(),initialFacts=await facts();expect(initialLedger).toHaveLength(boundaries.payroll);
  expect(initialLedger.map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(journal.entries.slice(0,boundaries.payroll).map(entry=>({hash:sha(readFileSync(join(directory,entry.tag+'.sql'))),created_at:String(entry.when)})));
  for(const original of Object.values(historical))expect(initialLedger.find(row=>row.created_at===String(original.when))?.hash).toBe(original.hash);
  const originalVersion=initialCatalogue.functions.find(row=>row.row.proname==='teras_bump_version')!.definition as string;
  await storage.client.unsafe(originalVersion.replace('AS $function$','AS $function$\n-- unknown actual installed version owner'));
  const drifted=await catalogue();stage(boundaries.mandate);report.phase='whole38-pending-rollback';save();
  await expect(migrate(migration.db,{migrationsFolder:directory})).rejects.toMatchObject({cause:{code:'55000',message:'Unexpected AI Centre mandate predecessor: app.teras_bump_version()'}});
  expect(await ledger()).toEqual(initialLedger);expect(await catalogue()).toEqual(drifted);expect(await facts()).toEqual(initialFacts);
  expect((await storage.client`select to_regprocedure('app.ai_centre_mandate_write_order()')as helper,to_regclass('public.notification_event_processing')as queue`)[0]).toEqual({helper:null,queue:null});
  await storage.client.unsafe(originalVersion);report.whole38PendingRollback=true;
  // First observe the complete compatibility phase, then apply only mandate write order.
  stage(boundaries.compatibility);await migrate(migration.db,{migrationsFolder:directory});const beforeLedger=await ledger();expect(beforeLedger).toHaveLength(boundaries.compatibility);
  expect(beforeLedger.slice(0,boundaries.payroll)).toEqual(initialLedger);expect(await catalogue()).toEqual(initialCatalogue);expect(await facts()).toEqual(initialFacts);
  expect(beforeLedger.slice(boundaries.payroll).map(({hash,created_at})=>({hash,created_at}))).toEqual(
   journal.entries.slice(boundaries.payroll,boundaries.compatibility).map(entry=>({hash:sha(readFileSync(join(directory,entry.tag+'.sql'))),created_at:String(entry.when)})));
  stage(boundaries.mandate);await migrate(migration.db,{migrationsFolder:directory});const afterLedger=await ledger();expect(afterLedger).toHaveLength(boundaries.mandate);
  expect(afterLedger.slice(0,boundaries.compatibility)).toEqual(beforeLedger);expect(afterLedger.at(-1)).toMatchObject({created_at:'1793330003737',hash:sha(readFileSync(migrationFile))});
  expect(await catalogue()).toEqual(initialCatalogue);expect(await facts()).toEqual(initialFacts);
  const newCatalogue=await storage.client`select p.oid::regprocedure::text as signature,p.proowner::regrole::text as owner,p.prosecdef,has_function_privilege('ai_hr_app',p.oid,'EXECUTE')as app_execute,
   (select count(*)::integer from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))as acl_count from pg_proc p where p.oid=any(${newFunctions}::text[]::regprocedure[])order by signature`;
  expect(Array.from(newCatalogue)).toEqual(newFunctions.slice().sort().map(signature=>({signature,owner:role,prosecdef:false,app_execute:false,acl_count:1})));
  const triggers=await storage.client`select tgname,tgtype,tgenabled,pg_get_triggerdef(oid)as definition from pg_trigger where tgrelid='public.teras_mandate_control'::regclass and not tgisinternal order by tgname`;
  expect(triggers.map(row=>[row.tgname,row.tgtype,row.tgenabled])).toEqual([['aa_ai_centre_mandate_write_order',22,'O'],['aaa_ai_centre_bound_tenant',23,'O'],['aaa_ai_centre_control_lock',23,'O'],['teras_mandate_control_version',19,'O']]);
  report.positiveStockPhases=[boundaries.historical,boundaries.alphaSeven,boundaries.payroll,boundaries.compatibility,boundaries.mandate];report.ledgerBeforeSha256=sha(Buffer.from(JSON.stringify(initialLedger)));report.ledgerAfterSha256=sha(Buffer.from(JSON.stringify(afterLedger)));
  report.predecessorCatalogueSha256=sha(Buffer.from(JSON.stringify(initialCatalogue)));report.newNativeCatalogue=newCatalogue;report.triggers=triggers;report.phase='guard-drifts';save();
  // Each mutation is real DDL inside its own rollback-only privileged constructor transaction.
  // The actual append guard then runs as the exact non-super native owner.
  const faults=[...oldFunctions.flatMap(signature=>['body','acl','configuration','owner'].map(fault=>({signature,fault}))),
   ...['table-owner','table-acl','table-rls','column-acl','policy','trigger-disabled','trigger-name','extra-trigger','reserved-overload'].map(fault=>({signature:'',fault}))];
  const refused:string[]=[];
  for(const {signature,fault}of faults){
   await expect(storage.client.begin(async tx=>{
    for(const name of newTriggers)await tx.unsafe(`DROP TRIGGER ${name} ON public.teras_mandate_control`);
    for(const signature of newFunctions)await tx.unsafe(`DROP FUNCTION ${signature}`);
    if(fault==='body'){const[{definition}]=await tx`select pg_get_functiondef(${signature}::regprocedure)as definition`;await tx.unsafe(String(definition).replace('AS $function$','AS $function$\n-- unknown writer owner'));}
    if(fault==='acl')await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`);
    if(fault==='configuration')await tx.unsafe(`ALTER FUNCTION ${signature} SET search_path=pg_catalog`);
    if(fault==='owner')await tx.unsafe(`ALTER FUNCTION ${signature} OWNER TO postgres`);
    if(fault==='table-owner')await tx`alter table teras_mandate_control owner to postgres`;
    if(fault==='table-acl')await tx`grant delete on teras_mandate_control to ai_hr_app`;
    if(fault==='table-rls')await tx`alter table teras_mandate_control force row level security`;
    if(fault==='column-acl')await tx`grant update(stopped)on teras_mandate_control to ai_hr_app`;
    if(fault==='policy')await tx`alter policy teras_control_read on teras_mandate_control using(true)`;
    if(fault==='trigger-disabled')await tx`alter table teras_mandate_control disable trigger aaa_ai_centre_control_lock`;
    if(fault==='trigger-name')await tx`alter trigger aaa_ai_centre_control_lock on teras_mandate_control rename to zzz_ai_centre_control_lock`;
    if(fault==='extra-trigger')await tx`create trigger extra_ai_centre_trigger before insert on teras_mandate_control for each row execute function app.ai_centre_control_lock()`;
    if(fault==='reserved-overload')await tx`create function app.ai_centre_mandate_write_order(integer)returns integer language sql as 'select $1'`;
    await tx.unsafe(`SET LOCAL ROLE "${role}"`);await tx.unsafe(guard);
   }),signature+'/'+fault).rejects.toMatchObject({code:'55000'});
   expect(await catalogue()).toEqual(initialCatalogue);expect(await facts()).toEqual(initialFacts);expect(await ledger()).toEqual(afterLedger);refused.push(signature+'/'+fault);
  }
  report.refusedDrifts=refused;report.phase='bound-owner-and-app';save();
  await expect(migration.client`update teras_mandate_control set stopped=false where tenant_id=${tenantId}`).rejects.toMatchObject({code:'42501',message:'Mandate control requires a bound tenant'});
  await expect(migration.client.begin(async tx=>{await tx`select set_config('app.tenant_id','not-a-uuid',true)`;await tx`update teras_mandate_control set stopped=false where tenant_id=${tenantId}`;})).rejects.toMatchObject({code:'42501'});
  await migration.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${tenantId},true)`;await tx`update teras_mandate_control set stopped=false,version=999 where tenant_id=${tenantId}`;});
  expect((await facts()).find(row=>row.row.tenant_id===tenantId)?.row).toMatchObject({stopped:false,version:8,changed_by_user_id:userId});
  await migration.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${tenantId},true)`;await tx`update teras_mandate_control set version=999,changed_at=now()where tenant_id=${tenantId}`;});
  expect((await facts()).find(row=>row.row.tenant_id===tenantId)?.row.version).toBe(8);
  await expect(migration.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${tenantId},true)`;await tx`update teras_mandate_control set tenant_id=${tenantId} where tenant_id=${foreignTenant}`;})).rejects.toMatchObject({code:'42501',message:'Mandate control row differs from bound tenant'});
  const ownerTenant=randomUUID();await storage.client`insert into tenant(id,workos_org_id,name)values(${ownerTenant},${randomUUID()},'Fictional bound owner initialization')`;
  await migration.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${ownerTenant},true)`;await tx`insert into teras_mandate_control(tenant_id,changed_by_user_id)values(${ownerTenant},${userId})`;});
  expect((await facts()).find(row=>row.row.tenant_id===ownerTenant)?.row).toMatchObject({stopped:false,version:1,manager_may_revoke:false});
  const[actualApp]=await application.client`select current_user as role,session_user as login,current_database()as database,inet_server_addr()='127.0.0.1'::inet as loopback`;
  expect(actualApp).toEqual({role:'ai_hr_app',login:'ai_hr_app',database,loopback:true});report.applicationLogin=actualApp;
  await expect(application.client`update teras_mandate_control set stopped=true where tenant_id=${tenantId}`).rejects.toMatchObject({code:'42501'});
  await application.withTenant(ctx,tx=>tx.execute(sql`update teras_mandate_control set stopped=true,changed_by_user_id=${userId} where tenant_id=${tenantId}`));
  await application.withTenant(ctx,tx=>tx.execute(sql`update teras_mandate_control set manager_may_revoke=true,changed_by_user_id=${userId} where tenant_id=${tenantId}`));
  expect((await facts()).find(row=>row.row.tenant_id===tenantId)?.row).toMatchObject({stopped:true,manager_may_revoke:true,version:10});
  const beforeIllegal=await facts(),foreignCourses:unknown[]=[];
  // Independent real foreign AI holder. Illegal row operations must finish denied
  // BEFORE holder release: a blocking acquisition of that key cannot masquerade as denial.
  for(const operation of ['insert','update']as const)for(const first of ['application','foreign-holder']as const){
   let appPid:number|undefined,holderPid:number|undefined,appStarted=()=>{},holderStarted=()=>{},dispatch=()=>{},release=()=>{};
   const appReady=new Promise<void>(resolve=>{appStarted=resolve;}),holderReady=new Promise<void>(resolve=>{holderStarted=resolve;});
   const go=new Promise<void>(resolve=>{dispatch=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
   let appDone=false;let appPromise:Promise<{error?:unknown}>|undefined,holderPromise:Promise<void>|undefined;
   const startApp=()=>application.withTenant(ctx,async tx=>{await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='10s'`);
    const[identity]=await tx.execute<{pid:number}>(sql`select pg_backend_pid()as pid`);appPid=identity.pid;appStarted();await go;
    if(operation==='insert')await tx.execute(sql`insert into teras_mandate_control(tenant_id,changed_by_user_id)values(${foreignTenant},${userId})`);
    else await tx.execute(sql`update teras_mandate_control set tenant_id=${foreignTenant},changed_by_user_id=${userId} where tenant_id=${tenantId}`);
   }).then(()=>({}),error=>({error})).finally(()=>{appDone=true;});
   const startHolder=()=>migration!.client.begin(async tx=>{await tx`set local lock_timeout='5s'`;await tx`set local statement_timeout='10s'`;
    const[identity]=await tx`select pg_backend_pid()as pid,hashtext(${tenantId})<>hashtext(${foreignTenant})as distinct_keys`;expect(identity.distinct_keys).toBe(true);holderPid=identity.pid as number;
    await tx`select pg_advisory_xact_lock(hashtext('ai-control'),hashtext(${foreignTenant}))`;holderStarted();await held;
   }).then(()=>{});
   try{
    if(first==='application'){appPromise=startApp();await boundedReady(appReady,appPromise);holderPromise=startHolder();await boundedReady(holderReady,holderPromise);}
    else{holderPromise=startHolder();await boundedReady(holderReady,holderPromise);appPromise=startApp();await boundedReady(appReady,appPromise);}
    dispatch();const dispatchedAt=Date.now();let sawForeignWait=false;
    for(let poll=0;poll<100&&!appDone;poll++){
     const[state]=await storage.client`select ${holderPid}::integer=any(pg_blocking_pids(${appPid}::integer))as foreign_wait`;
     sawForeignWait||=state.foreign_wait as boolean;await new Promise(resolve=>setTimeout(resolve,20));
    }
    let timer:ReturnType<typeof setTimeout>|undefined,result:{error?:unknown};
    try{result=await Promise.race([appPromise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Foreign row did not deny while foreign AI remained held')),Math.max(1,2500-(Date.now()-dispatchedAt)));})]);}finally{clearTimeout(timer);}
    const[state]=await storage.client`select exists(select 1 from pg_locks where pid=${holderPid} and locktype='advisory'and granted and objsubid=2)as holder_still_locked,
     exists(select 1 from pg_locks where pid=${appPid} and locktype='advisory'and classid::bigint=(hashtext('ai-control')::bigint+4294967296)%4294967296 and objid::bigint=(hashtext(${foreignTenant})::bigint+4294967296)%4294967296 and objsubid=2)as app_foreign_lock`;
    const error=result.error as{cause?:{code?:string;message?:string};code?:string;message?:string}|undefined,native=error?.cause??error;
    foreignCourses.push({operation,first,appPid,holderPid,holderStillLocked:state.holder_still_locked,appForeignLock:state.app_foreign_lock,sawForeignWait,deniedCode:native?.code});report.foreignCourses=foreignCourses;save();
    expect(native).toMatchObject({code:'42501',message:'Mandate control row differs from bound tenant'});expect(state).toEqual({holder_still_locked:true,app_foreign_lock:false});expect(sawForeignWait).toBe(false);
   }finally{dispatch();release();await Promise.all([appPromise,holderPromise]);}
   expect(await facts()).toEqual(beforeIllegal);
  }
  // Original RLS remains an independent authority owner: same-tenant ordinary non-admin cannot write.
  const ordinary=randomUUID();await storage.client`insert into app_user(id,tenant_id,workos_user_id)values(${ordinary},${tenantId},${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role)values(${tenantId},${ordinary},'employee')`;
  await expect(application.withTenant({...ctx,userId:ordinary,roles:['employee'],grants:[{role:'employee',companyId:null}]},tx=>tx.execute(sql`insert into teras_mandate_control(tenant_id,changed_by_user_id)values(${tenantId},${ordinary})`))).rejects.toMatchObject({cause:{code:'42501'}});
  expect(await facts()).toEqual(beforeIllegal);expect(await catalogue()).toEqual(initialCatalogue);
  await migrate(migration.db,{migrationsFolder:directory});expect(await ledger()).toEqual(afterLedger);
  report.ownerBoundMaintenance=true;report.originalRlsDenial=true;await selectedCourse!.verifyPositivePrivateBoundary();report.complete=true;report.phase='cleanup';save();
 }catch(error){
  primaryFailure=error;
  const metadataFrontier=aiCentreSelectedMetadataFrontierObservation(error);
  if(metadataFrontier)report.metadataFrontier=metadataFrontier;
  metadataExternalStop=metadataFrontier?.externalOwnedStopRequired??metadataPending;
  throw error;
 }finally{
  const failures:unknown[]=[];
  if(metadataExternalStop){report.cleanupComplete=false;report.ownedJobCleanupRequired=true;}
  else for(const close of [()=>application.client.end({timeout:5}),async()=>{if(selectedCourse)await selectedCourse.closeMigration();else await migration?.client.end({timeout:5});},()=>storage.client.end({timeout:5}),
   async()=>{if(created){expect(await admin`select oid::text as oid from pg_database where datname=${database}`).toEqual([{oid:databaseOid}]);await admin.unsafe(`DROP DATABASE "${database}" WITH(FORCE)`);}},async()=>{if(roleCreated){expect(await admin`select oid::text as oid from pg_roles where rolname=${role}`).toEqual([{oid:roleOid}]);await admin.unsafe(`DROP ROLE "${role}"`);}},
   async()=>{if(selectedCourse)report.globalNativeCleanup=await selectedCourse.verifyCleanup();},
   async()=>{const[absence]=await admin`select not exists(select 1 from pg_database where datname=${database})as database_absent,not exists(select 1 from pg_roles where rolname=${role})as role_absent`;expect(absence).toEqual({database_absent:true,role_absent:true});report.cleanup=absence;report.cleanupComplete=!primaryFailure&&failures.length===0;},
   ()=>admin.end({timeout:5}),()=>rmSync(directory,{recursive:true,force:true})])try{await close();}catch(error){failures.push(error);}
  report.phase=primaryFailure||failures.length?'failed':'complete';if(primaryFailure||failures.length)report.complete=false;try{save();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError([...(primaryFailure?[primaryFailure]:[]),...failures],'AI mandate write-order fixture cleanup failed');
 }
},300000);
