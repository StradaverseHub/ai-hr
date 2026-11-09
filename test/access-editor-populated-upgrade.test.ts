/** Historical3103 component over its exact archived739 prefix; NOT actual706/707 installation proof. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
import {readAccessConfigurationEditor as readLockedEditor} from './fixtures/access-editor-locked-baseline';
import {pgSqlState} from '../lib/db-error';
import {workerDb} from './db-names';
import {historicalMigrationSourcePath} from './fixtures/historical-migrations/source-path';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const append={idx:2403,version:'7',when:1793330002703,tag:'3103_access_editor_presentation',breakpoints:true};
const appendHash='bb171333ef940c173ac9ca0a647398116dfd8ee8dd87d77c8f59e92b0281fe47';
type FunctionRow={signature:string;definition:string;details:Record<string,unknown>};
it('preserves populated permissions/history and atomically refuses a drifted predecessor before the real append',async context=>{
 expect(historicalMigrationSourcePath('0000_init')).toBe('db/migrations/0000_init.sql');
 expect(historicalMigrationSourcePath('2301_attendance_workflow_submission_shared_lock')).toBe('test/fixtures/historical-migrations/2301_attendance_workflow_submission_shared_lock.sql');
 expect(historicalMigrationSourcePath(append.tag)).toBe('test/fixtures/historical-migrations/3103_access_editor_presentation.sql');
 for(const invalid of [undefined,null,0,{},[],false,'','0000_init\n','0000_init\r\n','0000_init\r','0000_init\u2028','0000_init\u2029','0000_é','0000_😀','../0000_init','0000_nested/tag','0000_nested\\tag','0000_init.sql',' 0000_init','0000_init ','0000_'+''.padEnd(176,'a')]){
  expect(()=>historicalMigrationSourcePath(invalid)).toThrow(TypeError);
 }
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(pool).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 const source=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);expect(source.hostname).toBe('127.0.0.1');expect(source.pathname).toBe('/'+workerDb(pool!));expect(source.username).not.toBe('ai_hr_app');
 const journal=JSON.parse(readFileSync('test/fixtures/access-editor-original739-journal.json','utf8')),prefix=journal.entries,componentJournal={...journal,entries:[...prefix,append]};
 expect(prefix).toHaveLength(739);expect(componentJournal.entries).toHaveLength(740);expect(componentJournal.entries.at(-1)).toEqual(append);
 expect(sha(JSON.stringify(prefix))).toBe('2f2bf63ad7197b2b9042dee26f1a701539addc7f146cce14914fdc8ec1006a05');
 expect(sha(JSON.stringify(prefix.map((entry:{tag:string})=>[entry.tag,sha(readFileSync(historicalMigrationSourcePath(entry.tag)))])))).toBe('feb775454a5577ca5ec1b8e86a56bf5a57f3b27d7f7b4aa47735142e678a5d00');
 expect(sha(readFileSync(historicalMigrationSourcePath(append.tag)))).toBe(appendHash);
 const name='ai_hr_access_upgrade_'+randomUUID().replaceAll('-',''),folder=mkdtempSync(join(tmpdir(),'aihr-access-upgrade-'));
 source.pathname='/postgres';const admin=postgres(source.toString(),{max:1,onnotice:()=>{}});source.pathname='/'+name;
 const storage=database.createDb(source.toString(),{max:4});let created=false;
 const appUrl=new URL(process.env.TEST_DATABASE_URL!);expect(appUrl.hostname).toBe('127.0.0.1');expect(appUrl.pathname).toBe('/'+workerDb(pool!));expect(appUrl.username).toBe('ai_hr_app');appUrl.pathname='/'+name;
 const application=database.createDb(appUrl.toString(),{max:4});
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>application.withTenant(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
  const [identity]=await tx.execute<{role:string;database:string}>(sql`select current_user as role,current_database() as database`);expect(identity).toEqual({role:'ai_hr_app',database:name});return read(tx);
 },options));
 let releaseHeld:(()=>void)|undefined,closing:Promise<unknown>|undefined;
 const abort=()=>{releaseHeld?.();closing=Promise.allSettled([application.client.end({timeout:0}),storage.client.end({timeout:0})]);};
 context.signal.addEventListener('abort',abort,{once:true});
 const ledger=()=>storage.client`select id,hash,created_at::text from drizzle.__drizzle_migrations order by id`;
 const functions=()=>storage.client<FunctionRow[]>`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,to_jsonb(p) as details
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app') and p.prokind in ('f','p') order by p.oid::regprocedure::text`;
 async function retained(){
  const tables=await storage.client`select schemaname,tablename from pg_tables where schemaname in ('public','app') order by schemaname,tablename`;
  const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"',rows:Record<string,{count:number;hash:string}>={};
  for(const table of tables){context.signal.throwIfAborted();
   const key=String(table.schemaname)+'.'+String(table.tablename),values=await storage.client.unsafe('select to_jsonb(t) as value from '+quote(String(table.schemaname))+'.'+quote(String(table.tablename))+' t order by to_jsonb(t)::text');
   rows[key]={count:values.length,hash:sha(JSON.stringify(values))};
  }
  const policies=await storage.client`select * from pg_policies where schemaname in ('public','app') order by schemaname,tablename,policyname`;
  const grants=await storage.client`select * from information_schema.role_table_grants where table_schema in ('public','app') order by table_schema,table_name,grantor,grantee,privilege_type`;
  const schemas=await storage.client`select nspname,nspowner,nspacl::text from pg_namespace where nspname in ('public','app') order by nspname`;
  const sequences=await storage.client`select * from pg_sequences where schemaname in ('public','app') order by schemaname,sequencename`;
  return {rows,policies,grants,schemas,sequences};
 }
 async function actor(uninitialized=false,role:'hr_admin'|'employee'='hr_admin',tenantId=randomUUID()){
  const userId=randomUUID(),companyId=randomUUID(),grantId=randomUUID();
  await storage.client.begin(async tx=>{
   await tx`insert into tenant(id,workos_org_id,name) values(${tenantId}::uuid,${'org_access_upgrade_'+tenantId},'Fictional retained Access tenant') on conflict(id) do nothing`;
   await tx`insert into company(id,tenant_id,legal_name) values(${companyId}::uuid,${tenantId}::uuid,'Fictional retained Access company')`;
   await tx`insert into app_user(id,tenant_id,workos_user_id,archived_at) values(${userId}::uuid,${tenantId}::uuid,${'fictional_access_upgrade_'+userId},case when ${uninitialized} then clock_timestamp() else null end)`;
   await tx`insert into role_assignment(id,tenant_id,app_user_id,role,company_id) values(${grantId}::uuid,${tenantId}::uuid,${userId}::uuid,${role},null)`;
  });
  if(uninitialized)await storage.client`update app_user set archived_at=null where id=${userId}::uuid`;
  return {ctx:{tenantId,userId,personId:null,roles:[role],grants:[{role,companyId:null}]}satisfies SessionContext,companyId,grantId};
 }
 const pending=(async()=>{try{
  context.signal.throwIfAborted();const [identity]=await admin`select current_user as owner`;expect(identity.owner).toBe('postgres');
  context.signal.throwIfAborted();await admin.unsafe('CREATE DATABASE "'+name+'"');created=true;mkdirSync(join(folder,'meta'));
  for(const entry of componentJournal.entries)copyFileSync(historicalMigrationSourcePath(entry.tag),join(folder,entry.tag+'.sql'));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));context.signal.throwIfAborted();await migrate(storage.db,{migrationsFolder:folder});
  const [databaseIdentity]=await storage.client`select current_database() as name,current_user as owner`;expect(databaseIdentity).toEqual({name,owner:'postgres'});
  context.signal.throwIfAborted();const root=await actor(),delegated=await actor(false,'employee',root.ctx.tenantId),firstUse=await actor(true);
  const apply=async(command:Parameters<typeof previewAccessConfiguration>[1]['command'])=>{
   const current=await database.withTenant(root.ctx,tx=>accessConfigurationStore.loadCurrent(tx,root.ctx)),edit={expectedRevision:current.snapshot.revision,command};
   const preview=await previewAccessConfiguration(root.ctx,edit,accessConfigurationStore);await saveAccessConfiguration(root.ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
  };
  const groupId=randomUUID();await apply({kind:'createGroup',groupId,name:'Fictional retained group'});
  await apply({kind:'setMembership',groupId,userId:delegated.ctx.userId!,companyId:null,enabled:true});
  await apply({kind:'setOverride',userId:delegated.ctx.userId!,capabilityId:'access.configure',companyId:null,effect:'allow'});
  const oldRoot=await readLockedEditor(root.ctx),oldDelegated=await readLockedEditor(delegated.ctx);
  expect(oldRoot.snapshot.groups).toHaveLength(7);expect(oldRoot.history.filter(row=>row.operation!=='initialized')).toHaveLength(3);
  expect(oldDelegated).toEqual(oldRoot);expect(oldRoot.snapshot.memberships.some(row=>row.groupId===groupId&&row.userId===delegated.ctx.userId)).toBe(true);
  const before=await retained(),beforeFunctions=await functions(),beforeLedger=[...await ledger()];
  expect(beforeLedger).toHaveLength(prefix.length);expect(before.rows['public.role_assignment'].count).toBe(3);expect(before.rows['public.access_configuration'].count).toBe(1);expect(before.rows['public.domain_event'].count).toBeGreaterThanOrEqual(4);
  const installer=beforeFunctions.find(row=>row.signature==='app.access_install_defaults(uuid,uuid)');expect(installer).toBeTruthy();
  expect(sha(String(installer!.details.prosrc))).toBe('e0021fafd029ed723bfb97e7af52c80595eefd4188b887f6fcf70248b8a9ba2c');
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify(componentJournal));
  await storage.client`alter function app.access_install_defaults(uuid,uuid) cost 101`;const drifted=await functions();
  let refused:unknown;try{context.signal.throwIfAborted();await migrate(storage.db,{migrationsFolder:folder});}catch(error){refused=error;}
  expect(pgSqlState(refused)).toBe('55000');expect(await ledger()).toEqual(beforeLedger);expect(await functions()).toEqual(drifted);expect(await retained()).toEqual(before);
  const [absent]=await storage.client`select to_regprocedure('app._access_bootstrap_eligible(uuid,uuid)') as helper,to_regprocedure('app.access_editor_presentation_v1()') as projection`;expect(absent).toEqual({helper:null,projection:null});
  await storage.client`alter function app.access_install_defaults(uuid,uuid) cost 100`;expect(await functions()).toEqual(beforeFunctions);
  context.signal.throwIfAborted();await migrate(storage.db,{migrationsFolder:folder});
  const afterLedger=[...await ledger()];expect(afterLedger.slice(0,-1)).toEqual(beforeLedger);expect(afterLedger).toHaveLength(beforeLedger.length+1);expect(afterLedger.at(-1)).toMatchObject({hash:appendHash,created_at:String(append.when)});
  expect(await retained()).toEqual(before);
  const afterFunctions=await functions(),added=afterFunctions.filter(row=>!beforeFunctions.some(old=>old.signature===row.signature));
  expect(added.map(row=>row.signature).sort()).toEqual(['app._access_bootstrap_eligible(uuid,uuid)','app.access_editor_presentation_v1()']);
  const oldBody=String(installer!.details.prosrc),predicate=oldBody.slice(oldBody.indexOf(' IF NOT EXISTS(SELECT 1 FROM public.app_user'),oldBody.indexOf(' THEN',oldBody.indexOf(' IF NOT EXISTS(SELECT 1 FROM public.app_user'))+5);
  expect(predicate).toContain('app.access_recovery_available(a.id)');expect(oldBody.split(predicate)).toHaveLength(2);
  const newBody=oldBody.replace(predicate,' IF NOT app._access_bootstrap_eligible(t,u) THEN');
  for(const old of beforeFunctions){
   const next=afterFunctions.find(row=>row.signature===old.signature);expect(next).toBeTruthy();
   if(old.signature===installer!.signature)expect(next).toEqual({...old,definition:old.definition.replace(oldBody,newBody),details:{...old.details,prosrc:newBody}});else expect(next).toEqual(old);
  }
  for(const row of added)expect(row.details).toMatchObject({proowner:installer!.details.proowner,prosecdef:true,provolatile:'s',proisstrict:false,proleakproof:false,proparallel:'u',procost:100,proconfig:['search_path=pg_catalog, public, pg_temp']});
  const [acl]=await storage.client`select has_function_privilege('ai_hr_app','app._access_bootstrap_eligible(uuid,uuid)','EXECUTE') as helper,
   has_function_privilege('ai_hr_app','app.access_editor_presentation_v1()','EXECUTE') as projection,
   exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid in('app._access_bootstrap_eligible(uuid,uuid)'::regprocedure,'app.access_editor_presentation_v1()'::regprocedure) and a.grantee=0) as public`;
  expect(acl).toEqual({helper:false,projection:true,public:false});
  const completeAcl=await storage.client`select p.proname,grantor.rolname as grantor,coalesce(grantee.rolname,'PUBLIC') as grantee,a.privilege_type,a.is_grantable
   from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   join pg_roles grantor on grantor.oid=a.grantor left join pg_roles grantee on grantee.oid=a.grantee
   where p.oid in('app._access_bootstrap_eligible(uuid,uuid)'::regprocedure,'app.access_editor_presentation_v1()'::regprocedure)
   order by p.proname,grantee.rolname nulls first`;
  expect(completeAcl).toEqual([
   {proname:'_access_bootstrap_eligible',grantor:'postgres',grantee:'postgres',privilege_type:'EXECUTE',is_grantable:false},
   {proname:'access_editor_presentation_v1',grantor:'postgres',grantee:'ai_hr_app',privilege_type:'EXECUTE',is_grantable:false},
   {proname:'access_editor_presentation_v1',grantor:'postgres',grantee:'postgres',privilege_type:'EXECUTE',is_grantable:false},
  ]);
  expect(await readAccessConfigurationEditor(root.ctx)).toEqual(oldRoot);expect(await readAccessConfigurationEditor(delegated.ctx)).toEqual(oldDelegated);
  for(const kind of ['access','history']as const){
   let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),done=new Promise<void>(r=>{release=r;});releaseHeld=release;let writerPid=0;
   const writer=storage.client.begin(async tx=>{
    await tx`set local statement_timeout='20s'`;if(kind==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+root.ctx.tenantId},0))`;else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+root.ctx.tenantId}))`;
    const [row]=await tx`select pg_backend_pid() as pid`;writerPid=row.pid;entered();await done;
   });
   try{await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before native barrier');})]);
    expect(await readAccessConfigurationEditor(root.ctx)).toEqual(oldRoot);
    const [held]=await storage.client`select exists(select 1 from pg_locks where locktype='advisory' and granted and pid=${writerPid}) as held`;expect(held.held).toBe(true);
   }finally{release();releaseHeld=undefined;await writer;}
  }
  expect(await retained()).toEqual(before);
  const [a,b]=await Promise.all([readAccessConfigurationEditor(firstUse.ctx),readAccessConfigurationEditor(firstUse.ctx)]);expect(a).toEqual(b);expect(a.snapshot.groups).toHaveLength(6);
  const initialization=await storage.client`select payload from domain_event where tenant_id=${firstUse.ctx.tenantId}::uuid and event_type='access-configuration.initialized'`;
  expect(initialization).toEqual([{payload:{defaultsCreated:true,legacyRolesChanged:false}}]);
  const [role]=await storage.client`select id from role_assignment where app_user_id=${firstUse.ctx.userId!}::uuid`;expect(role.id).toBe(firstUse.grantId);
  await storage.client`update app_user set archived_at=now() where id=${delegated.ctx.userId!}::uuid`;
  await expect(readAccessConfigurationEditor(delegated.ctx)).rejects.toMatchObject({code:'ceiling'});
 }finally{
  context.signal.removeEventListener('abort',abort);spy.mockRestore();await closing;await Promise.allSettled([application.client.end({timeout:5}),storage.client.end({timeout:5})]);
  try{if(created)await admin.unsafe('DROP DATABASE "'+name+'" WITH (FORCE)');}finally{await admin.end({timeout:5});rmSync(folder,{recursive:true,force:true});}
 }})();
 context.onTestFinished(async()=>{await closing;await pending.catch(()=>{});});
 await pending;
},300000);
