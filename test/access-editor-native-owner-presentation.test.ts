/** Real restricted-owner component proof. This does NOT replay installed706/707. */
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
import {readAccessEditorPresentationStatus} from '../core/access-editor-presentation';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {setCompensation} from '../core/comp';
import {pgSqlState} from '../lib/db-error';
import {readAccessConfigurationEditor as lockedEditor} from './fixtures/access-editor-locked-baseline';
import {accessEditorNativeOwnerFixture} from './fixtures/access-editor-native-owner';
import {accessNativeMetadataOid} from './fixtures/access-editor-owner-dependencies';
import {accessEditorOwnedWork} from './fixtures/access-editor-owned-work';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
// Registry/controller convergence is REQUIRED before this new selector may run.
// An unregistered or unauthenticated invocation refuses before creating any DB.
const nativeAdmission=admitSingletonTest('test/access-editor-native-owner-presentation.test.ts');
const path='db/migrations/3211_access_editor_native_owner_presentation.sql',source=readFileSync(path,'utf8');
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
type Info={definition:string;body:string;details:Record<string,unknown>};
async function refusal(work:()=>PromiseLike<unknown>,code:string){const error=await Promise.resolve().then(work).then(()=>undefined,(error:unknown)=>error);expect(error).toBeDefined();expect(pgSqlState(error)).toBe(code);}
const ownership=accessEditorOwnedWork();
it('preserves canonical Access behavior under a real restricted native owner and FORCE-RLS without owner/grant waivers',async context=>{
 ownership.beforeCase();return ownership.run(context,async()=>{
 let fixture:Awaited<ReturnType<typeof accessEditorNativeOwnerFixture>>|undefined,restoreSpy:(()=>void)|undefined,releaseHeld:(()=>void)|undefined;
 const abort=()=>{releaseHeld?.();};context.signal.addEventListener('abort',abort,{once:true});
 const active=()=>context.signal.throwIfAborted();
 try{
  fixture=await accessEditorNativeOwnerFixture(context.signal,ownership.poison,nativeAdmission.evidenceDirectory);active();const f=fixture;
  const proofs:unknown[]=[];let revokeBetween:{userId:string;grantId:string}|undefined,betweenRevocations=0;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(async<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{const result=await f.application.withTenant(ctx,async tx=>{
   active();await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
   const [identity]=await tx.execute<{role:string;login:string;database:string;mode:string;isolation:string;advisory:boolean;statement_budget:string;lock_budget:string}>(sql`select current_user as role,session_user as login,current_database()as database,current_setting('transaction_read_only')as mode,current_setting('transaction_isolation')as isolation,current_setting('statement_timeout')as statement_budget,current_setting('lock_timeout')as lock_budget,exists(select 1 from pg_locks where pid=pg_backend_pid()and locktype='advisory'and granted)as advisory`);
   expect(identity.role).toBe('ai_hr_app');expect(identity.login).toBe('ai_hr_app');expect(identity.database).toBe(f.name);expect(identity.statement_budget).toBe('20s');expect(identity.lock_budget).toBe('300ms');proofs.push(identity);return read(tx);
  },options);if(options?.readOnlySnapshot&&revokeBetween?.userId===ctx.userId){const revoke=revokeBetween;revokeBetween=undefined;await f.native.client`delete from role_assignment where id=${revoke.grantId}::uuid`;betweenRevocations++;}return result;});restoreSpy=()=>spy.mockRestore();
  async function actor(firstUse=false,role:'hr_admin'|'employee'='hr_admin',tenantId=randomUUID()){
   active();const userId=randomUUID(),companyId=randomUUID(),grantId=randomUUID();
   await f.native.client.begin(async tx=>{
    await tx`insert into public.tenant(id,workos_org_id,name)values(${tenantId}::uuid,${'org_native_access_'+tenantId},'Fictional native Access owner')on conflict(id)do nothing`;
    await tx`insert into public.company(id,tenant_id,legal_name)values(${companyId}::uuid,${tenantId}::uuid,'Fictional native owner company')`;
    await tx`insert into public.app_user(id,tenant_id,workos_user_id,archived_at)values(${userId}::uuid,${tenantId}::uuid,${'native_access_'+userId},case when ${firstUse} then clock_timestamp()else null end)`;
    await tx`insert into public.role_assignment(id,tenant_id,app_user_id,role,company_id)values(${grantId}::uuid,${tenantId}::uuid,${userId}::uuid,${role},null)`;
   });
   if(firstUse)await f.native.client`update public.app_user set archived_at=null where id=${userId}::uuid`;
   return{ctx:{tenantId,userId,personId:null,roles:[role],grants:[{role,companyId:null}]}satisfies SessionContext,companyId,grantId};
  }
  const root=await actor(),employee=await actor(false,'employee',root.ctx.tenantId),first=await actor(true),between=await actor(true),foreign=await actor();
  const events=(tenantId:string)=>f.native.client`select id,event_type,actor_id,payload,chain_seq,prev_hash,hash from public.domain_event where tenant_id=${tenantId}::uuid order by sequence`;
  const money=()=>f.admin`select to_jsonb(c)as value from public.compensation c where tenant_id=${root.ctx.tenantId}::uuid order by id`;
  const personId=randomUUID(),employmentId=randomUUID();
  await f.native.client`insert into public.person(id,tenant_id,full_name,primary_email)values(${personId}::uuid,${root.ctx.tenantId}::uuid,'Fictional retained salary identity',${personId+'@example.invalid'})`;
  await f.native.client`insert into public.employment(id,tenant_id,person_id,company_id,employee_code,hired_on)values(${employmentId}::uuid,${root.ctx.tenantId}::uuid,${personId}::uuid,${root.companyId}::uuid,'NATIVE-ACCESS-SALARY','2020-01-01')`;
  await setCompensation(root.ctx,{employmentId,basicSalary:5000,effectiveFrom:'2020-01-01'});
  const [salary]=await f.admin`select basic_salary::text as salary,currency,employment_id from public.compensation where employment_id=${employmentId}::uuid`;
  expect(salary).toEqual({salary:'5000.00',currency:'MYR',employment_id:employmentId});const financial=Array.from(await money());expect(financial).toHaveLength(1);
  const apply=async(command:Parameters<typeof previewAccessConfiguration>[1]['command'])=>{
   const state=await database.withTenant(root.ctx,tx=>accessConfigurationStore.loadCurrent(tx,root.ctx)),edit={expectedRevision:state.snapshot.revision,command},review=await previewAccessConfiguration(root.ctx,edit,accessConfigurationStore);
   await saveAccessConfiguration(root.ctx,{...edit,previewFingerprint:review.fingerprint},accessConfigurationStore);
  };
  const groupId=randomUUID();await apply({kind:'createGroup',groupId,name:'Fictional retained native-owner group'});
  await apply({kind:'setMembership',groupId,userId:employee.ctx.userId!,companyId:null,enabled:true});
  await apply({kind:'setOverride',userId:employee.ctx.userId!,capabilityId:'access.configure',companyId:null,effect:'allow'});
  const oldRoot=await lockedEditor(root.ctx),oldEmployee=await lockedEditor(employee.ctx);expect(oldRoot.snapshot.groups).toHaveLength(7);expect(oldEmployee).toEqual(oldRoot);
  expect(oldRoot.history.filter(row=>row.operation!=='initialized')).toHaveLength(3);
  const info=async()=>{const [row]=await f.admin<Info[]>`select pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)as details from pg_proc p where p.oid='app.access_install_defaults(uuid,uuid)'::regprocedure`;return row;};
  const predecessor=await info();expect(createHash('md5').update(predecessor.body).digest('hex')).toBe('3b4bd83bfef3d84a3af43885256e2187');expect(accessNativeMetadataOid(predecessor.details.proowner)).toBe(f.newOwner);
  const before=await f.dataFacts(),catalog=await f.catalog();
  const absent=async()=>expect((await f.admin`select to_regprocedure('app._access_bootstrap_eligible(uuid,uuid)')as helper,to_regprocedure('app.access_editor_presentation_v1()')as projection`)[0]).toEqual({helper:null,projection:null});
  for(const drift of ['body','configuration','owner','cost','app-user-owner','configuration-owner','schema-owner']as const){
   active();
   if(drift==='app-user-owner')await f.admin.unsafe('ALTER TABLE public.app_user OWNER TO '+quote(f.foreignRole));
   else if(drift==='configuration-owner')await f.admin.unsafe('ALTER TABLE public.access_configuration OWNER TO '+quote(f.foreignRole));
   else if(drift==='schema-owner')await f.admin.unsafe('ALTER SCHEMA app OWNER TO '+quote(f.foreignRole));
   else if(drift==='owner')await f.admin.unsafe('ALTER FUNCTION app.access_install_defaults(uuid,uuid)OWNER TO '+quote(f.foreignRole));
   else if(drift==='body')await f.native.client.unsafe(predecessor.definition.replace(predecessor.body,predecessor.body+'\n-- Fictional source drift\n'));
   else if(drift==='configuration')await f.native.client`alter function app.access_install_defaults(uuid,uuid)set search_path=pg_catalog,public`;
   else if(drift==='cost')await f.native.client`alter function app.access_install_defaults(uuid,uuid)cost 101`;
   const drifted=await f.catalog();await refusal(()=>f.native.client.begin(tx=>tx.unsafe(source)),'55000');await absent();expect(await f.catalog()).toEqual(drifted);expect(await f.dataFacts()).toEqual(before);
   if(drift==='app-user-owner')await f.admin.unsafe('ALTER TABLE public.app_user OWNER TO '+quote(f.role));
   if(drift==='configuration-owner')await f.admin.unsafe('ALTER TABLE public.access_configuration OWNER TO '+quote(f.role));
   if(drift==='schema-owner')await f.admin.unsafe('ALTER SCHEMA app OWNER TO '+quote(f.role));
   if(drift==='owner')await f.admin.unsafe('ALTER FUNCTION app.access_install_defaults(uuid,uuid)OWNER TO '+quote(f.role));
   if(drift==='cost')await f.native.client`alter function app.access_install_defaults(uuid,uuid)cost 100`;
   await f.native.client.unsafe(predecessor.definition);expect(await info()).toEqual(predecessor);expect(await f.catalog()).toEqual(catalog);
  }
  active();await f.native.client.begin(tx=>tx.unsafe(source));expect(await f.dataFacts()).toEqual(before);
  const afterCatalog=await f.catalog(),added=afterCatalog.functions.filter(row=>!catalog.functions.some(old=>String(old.oid)===String(row.oid)));
  expect(added.map(row=>row.signature).sort()).toEqual(['app._access_bootstrap_eligible(uuid,uuid)','app.access_editor_presentation_v1()']);
  const {functions:beforeFunctions,dependencies:beforeDependencies,sharedDependencies:beforeShared,...beforeOther}=catalog,{functions:afterFunctions,dependencies:afterDependencies,sharedDependencies:afterShared,...afterOther}=afterCatalog;expect(afterOther).toEqual(beforeOther);
  const procClass=String((await f.admin`select 'pg_proc'::regclass::oid as oid`)[0].oid),addedIds=new Set(added.map(row=>String(row.oid)));
  const newFunctionDependency=(classid:unknown,objid:unknown)=>String(classid)===procClass&&addedIds.has(String(objid));
  expect(afterDependencies.filter(row=>!newFunctionDependency(row.details.classid,row.details.objid))).toEqual(beforeDependencies);expect(afterDependencies.filter(row=>newFunctionDependency(row.details.classid,row.details.objid)).length).toBeGreaterThan(0);
  expect(afterShared.filter(row=>!newFunctionDependency(row.classid,row.objid))).toEqual(beforeShared);expect(afterShared.filter(row=>newFunctionDependency(row.classid,row.objid)).length).toBeGreaterThan(0);
  expect(added.every(row=>accessNativeMetadataOid(row.owner)===f.newOwner)).toBe(true);
  for(const old of beforeFunctions){const next=afterFunctions.find(row=>String(row.oid)===String(old.oid));expect(next).toBeTruthy();if(old.signature!=='app.access_install_defaults(uuid,uuid)')expect(next).toEqual(old);}
  const after=await info(),predicate=predecessor.body.slice(predecessor.body.indexOf(' IF NOT EXISTS(SELECT 1 FROM public.app_user'),predecessor.body.indexOf(' THEN',predecessor.body.indexOf(' IF NOT EXISTS(SELECT 1 FROM public.app_user'))+5);
  expect(predicate).toContain('app.access_recovery_available(a.id)');expect(after.details).toEqual({...predecessor.details,prosrc:predecessor.body.replace(predicate,' IF NOT app._access_bootstrap_eligible(t,u) THEN')});
  const [permissions]=await f.admin`select has_function_privilege('ai_hr_app','app._access_bootstrap_eligible(uuid,uuid)','EXECUTE')as helper,has_function_privilege('ai_hr_app','app.access_editor_presentation_v1()','EXECUTE')as projection,
   (select count(*)::int from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid in('app._access_bootstrap_eligible(uuid,uuid)'::regprocedure,'app.access_editor_presentation_v1()'::regprocedure)and(a.grantee=0 or a.is_grantable))as public_or_grantable`;
  expect(permissions).toEqual({helper:false,projection:true,public_or_grantable:0});
  expect(await readAccessConfigurationEditor(root.ctx)).toEqual(oldRoot);expect(await readAccessConfigurationEditor(employee.ctx)).toEqual(oldEmployee);
  const beforeReads=Array.from(await events(root.ctx.tenantId));
  for(const kind of ['access','history']as const){
   let entered!:()=>void,release!:()=>void,pid=0;const ready=new Promise<void>(r=>{entered=r;}),done=new Promise<void>(r=>{release=r;});releaseHeld=release;
   const writer=f.native.client.begin(async tx=>{await tx`set local statement_timeout='20s'`;await tx`set local lock_timeout='300ms'`;if(kind==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+root.ctx.tenantId},0))`;else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+root.ctx.tenantId}))`;pid=(await tx`select pg_backend_pid()as pid`)[0].pid;entered();await done;});
   try{await Promise.race([ready,writer.then(()=>{throw Error('Writer exited before native barrier');})]);active();expect(await readAccessConfigurationEditor(root.ctx)).toEqual(oldRoot);
    expect((await f.admin`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory'and granted)as held`)[0].held).toBe(true);if(kind==='access')await refusal(()=>lockedEditor(root.ctx),'55P03');
   }finally{release();releaseHeld=undefined;await writer;}
  }
  expect(Array.from(await events(root.ctx.tenantId))).toEqual(beforeReads);expect(Array.from(await money())).toEqual(financial);
  await database.withTenant(root.ctx,async tx=>{await tx.execute(sql`select * from app.access_editor_presentation_v1()`);const [proof]=await tx.execute(sql`select current_user as role,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as mode,exists(select 1 from pg_locks where pid=pg_backend_pid()and locktype='advisory'and granted)as advisory`);expect(proof).toEqual({role:'ai_hr_app',isolation:'repeatable read',mode:'on',advisory:false});},{readOnlySnapshot:true});
  await refusal(()=>database.withTenant(root.ctx,tx=>tx.execute(sql`select * from app.access_editor_presentation_v1()`)),'42501');
  await refusal(()=>database.withTenant(root.ctx,tx=>tx.execute(sql`select app._access_bootstrap_eligible(app.current_tenant_id(),app.current_user_id())`),{readOnlySnapshot:true}),'42501');
  await refusal(()=>database.withTenant(root.ctx,tx=>tx.execute(sql`update app_user set archived_at=now()where id=app.current_user_id()`),{readOnlySnapshot:true}),'25006');
  await refusal(()=>f.application.client.unsafe('SET ROLE '+quote(f.role)),'42501');
  expect(await readAccessEditorPresentationStatus(first.ctx)).toEqual({status:'uninitialized'});expect(await events(first.ctx.tenantId)).toHaveLength(0);
  const [one,two]=await Promise.all([readAccessConfigurationEditor(first.ctx),readAccessConfigurationEditor(first.ctx)]);expect(one).toEqual(two);expect(one.snapshot.groups).toHaveLength(6);
  expect((await events(first.ctx.tenantId)).map(row=>({type:row.event_type,payload:row.payload}))).toEqual([{type:'access-configuration.initialized',payload:{defaultsCreated:true,legacyRolesChanged:false}}]);
  expect((await f.native.client`select id from role_assignment where app_user_id=${first.ctx.userId!}::uuid`)[0].id).toBe(first.grantId);
  expect(await readAccessEditorPresentationStatus(between.ctx)).toEqual({status:'uninitialized'});revokeBetween={userId:between.ctx.userId,grantId:between.grantId};
  await expect(readAccessConfigurationEditor(between.ctx)).rejects.toMatchObject({code:'ceiling'});expect(betweenRevocations).toBe(1);expect(await events(between.ctx.tenantId)).toHaveLength(0);expect(await f.native.client`select 1 from access_configuration where tenant_id=${between.ctx.tenantId}::uuid`).toHaveLength(0);
  await f.native.client`update app_user set archived_at=clock_timestamp()where id=${employee.ctx.userId}::uuid`;await expect(readAccessConfigurationEditor(employee.ctx)).rejects.toMatchObject({code:'ceiling'});
  await f.native.client`update app_user set archived_at=null where id=${employee.ctx.userId}::uuid`;expect(await readAccessConfigurationEditor(employee.ctx)).toEqual(await lockedEditor(employee.ctx));
  await apply({kind:'setOverride',userId:employee.ctx.userId!,capabilityId:'access.configure',companyId:null,effect:'deny'});await expect(readAccessConfigurationEditor(employee.ctx)).rejects.toMatchObject({code:'ceiling'});
  await expect(readAccessConfigurationEditor({...root.ctx,tenantId:foreign.ctx.tenantId})).rejects.toMatchObject({code:'ceiling'});
  expect(Array.from(await money())).toEqual(financial);expect(proofs.length).toBeGreaterThan(10);
 }finally{context.signal.removeEventListener('abort',abort);releaseHeld?.();restoreSpy?.();
  try{const proof=await fixture?.close();if(fixture){expect(proof).toMatchObject({complete:true,databaseAbsent:true,rolesAbsent:true,ownedBackendsAbsent:true});expect(proof?.elapsedMs).toBeLessThan(26000);}}catch(error){ownership.poison(error instanceof Error?error:Error('Access native owner teardown uncertain'));throw error;}
 }
 });
},300000);
