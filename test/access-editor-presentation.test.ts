/** Native application-owner adoption; normal migrations only, no disposable SQL installation. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {accessConfiguration,appUser,company,employment,person,roleAssignment,tenant} from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
import {pgSqlState} from '../lib/db-error';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {readAccessEditorPresentationStatus} from '../core/access-editor-presentation';
import {readAccessConfigurationEditor as readLockedAccessConfigurationEditor} from './fixtures/access-editor-locked-baseline';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {workerDb} from './db-names';

const reviewedPrototypeSql=readFileSync(new URL('./prototypes/access-editor-presentation.sql',import.meta.url),'utf8');
type FunctionInfo={definition:string;details:unknown};

async function bootstrapInfo():Promise<FunctionInfo>{
 const [row]=await owner.db.execute<FunctionInfo>(sql`select pg_get_functiondef(p.oid) as definition,
  jsonb_build_object('owner',p.proowner::regrole::text,'acl',p.proacl::text,'name',p.proname,'namespace',p.pronamespace::regnamespace::text,
   'language',p.prolang,'argtypes',p.proargtypes::text,'argnames',p.proargnames,'nargs',p.pronargs,'ndefaults',p.pronargdefaults,'allargtypes',p.proallargtypes,'argmodes',p.proargmodes,
   'defaults',p.proargdefaults::text,'result',p.prorettype,'set',p.proretset,'kind',p.prokind,'variadic',p.provariadic,
   'security',p.prosecdef,'strict',p.proisstrict,'leakproof',p.proleakproof,'volatility',p.provolatile,'parallel',p.proparallel,
   'settings',p.proconfig,'cost',p.procost,'rows',p.prorows,'support',p.prosupport::text,'body',p.prosrc,'sqlbody',p.prosqlbody::text) as details
  from pg_proc p where p.oid='app.access_install_defaults(uuid,uuid)'::regprocedure`);
 if(!row)throw Error('Native bootstrap owner missing');return row;
}
beforeAll(async()=>{
 await migrateTestDb();
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(pool).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){const url=new URL(process.env[key]!);expect(url.hostname).toBe('127.0.0.1');expect(url.pathname).toBe('/'+workerDb(pool!));}
 const [names]=await owner.client`select to_regprocedure('app._access_bootstrap_eligible(uuid,uuid)') as helper,to_regprocedure('app.access_editor_presentation_v1()') as projection`;
 expect(names.helper).toBe('app._access_bootstrap_eligible(uuid,uuid)');expect(names.projection).toBe('app.access_editor_presentation_v1()');
});
beforeEach(resetDb);afterAll(closeAll);
const root=async()=>{const b=await seedBase();return{b,ctx:{...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]}satisfies SessionContext};};
const ownerFacts=(state:Awaited<ReturnType<typeof accessConfigurationStore.loadCurrent>>)=>({snapshot:state.snapshot,catalog:state.catalog,scopeFingerprint:state.scopeFingerprint,recoveryUserIds:[...state.recoveryUserIds].sort(),companyIds:[...state.evidence.knownCompanyIds].sort()});
async function events(tenantId:string){return [...await owner.client`select id,event_type,payload,chain_seq,prev_hash,hash from domain_event where tenant_id=${tenantId}::uuid order by id`];}
async function refusal(work:()=>Promise<unknown>,code:string){let failure:unknown;try{await work();}catch(error){failure=error;}expect(failure).toBeDefined();expect(pgSqlState(failure)).toBe(code);}
function budgets(){const native=database.withTenant;return vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,async tx=>{await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);return read(tx);},options));}
async function held(tenantId:string,kind:'access'|'history',signal:AbortSignal,read:(pid:number)=>Promise<void>){
 let enter!:()=>void,release!:()=>void,pid=0;const ready=new Promise<void>(resolve=>{enter=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});
 const writer=owner.client.begin(async tx=>{await tx`set local lock_timeout='300ms'`;await tx`set local statement_timeout='20s'`;if(kind==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+tenantId},0))`;else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+tenantId}))`;const [row]=await tx`select pg_backend_pid() as pid`;pid=row.pid;enter();await done;});
 const abort=()=>release();signal.addEventListener('abort',abort,{once:true});
 try{await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before taking its native barrier');})]);signal.throwIfAborted();await read(pid);}
 finally{release();signal.removeEventListener('abort',abort);await writer;}
}
/** Legitimate first-use fixture: a real archived administrator's role cannot initialize;
 * later unarchive does not replay the deferred role trigger. No configuration deletion/bypass. */
async function uninitialized(role:'hr_admin'|'super_admin'|'employee'|'manager'='hr_admin',scoped=false,futureEnding=false){
 const [t]=await owner.db.insert(tenant).values({workosOrgId:'org_proto_'+randomUUID(),name:'Fictional Access first use'}).returning();
 const [c]=await owner.db.insert(company).values({tenantId:t.id,legalName:'Fictional bootstrap company'}).returning();
 const [p]=await owner.db.insert(person).values({tenantId:t.id,fullName:'Fictional bootstrap actor',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 if(futureEnding)await owner.db.insert(employment).values({tenantId:t.id,personId:p.id,companyId:c.id,hiredOn:'2020-01-01',terminatedOn:addCalendarMonths(todayInKualaLumpur(),1)});
 const [u]=await owner.db.insert(appUser).values({tenantId:t.id,personId:p.id,workosUserId:randomUUID(),archivedAt:new Date()}).returning();
 const [grant]=await owner.db.insert(roleAssignment).values({tenantId:t.id,appUserId:u.id,role,companyId:scoped?c.id:null}).returning();
 await owner.db.update(appUser).set({archivedAt:null}).where(eq(appUser.id,u.id));
 expect(await owner.db.select().from(accessConfiguration).where(eq(accessConfiguration.tenantId,t.id))).toEqual([]);
 const ctx:SessionContext={tenantId:t.id,userId:u.id,personId:p.id,roles:[role],grants:[{role,companyId:scoped?c.id:null}]};
 return{ctx,grant,c};
}

it('uses the ordinary appended native bootstrap with exactly the reviewed eligibility extraction',async()=>{
 const candidate=await bootstrapInfo(),predecessor=reviewedPrototypeSql.split('$predecessor$')[1];
 expect(predecessor).toBeTruthy();
 const expected=predecessor.replace(/IF NOT EXISTS\(SELECT 1 FROM public\.app_user a JOIN public\.role_assignment r ON r\.app_user_id=a\.id AND r\.tenant_id=a\.tenant_id\n  WHERE a\.id=u AND a\.tenant_id=t AND a\.archived_at IS NULL AND NOT app\.login_blocked\(a\.id\) AND app\.access_recovery_available\(a\.id\)\n   AND \(r\.role::text='super_admin' OR \(r\.role::text='hr_admin' AND r\.company_id IS NULL\)\)\) THEN/, 'IF NOT app._access_bootstrap_eligible(t,u) THEN');
 expect(expected).not.toBe(predecessor);expect((candidate.details as Record<string,unknown>).body).toBe(expected);
 const [nativeLanguage]=await owner.client`select oid from pg_language where lanname='plpgsql'`;
 expect(candidate.details).toEqual({body:expected,language:nativeLanguage.oid,nargs:2,ndefaults:0,owner:'postgres',acl:'{postgres=X/postgres}',name:'access_install_defaults',namespace:'app',argtypes:'2950 2950',argnames:['t','u'],allargtypes:null,argmodes:null,defaults:null,result:16,set:false,kind:'f',variadic:0,security:true,strict:false,leakproof:false,volatility:'v',parallel:'u',settings:['search_path=pg_catalog, public, pg_temp'],cost:100,rows:0,support:'0',sqlbody:null});
});
it('returns exact initialized native state/metadata under held Access and History without writing or acquiring advisory locks',async context=>{
 const {b,ctx}=await root(),old=await readLockedAccessConfigurationEditor(ctx),before=await events(b.tenantId),native=database.withTenant,spy=budgets();
 try{for(const kind of ['access','history']as const)await held(b.tenantId,kind,context.signal,async pid=>{
  expect(await readAccessConfigurationEditor(ctx)).toEqual(old);
  const [proof]=await owner.client`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and granted) as held`;expect(proof.held).toBe(true);
  if(kind==='access')await refusal(()=>readLockedAccessConfigurationEditor(ctx),'55P03');
 });expect(await events(b.tenantId)).toEqual(before);}
 finally{spy.mockRestore();}
 await native(ctx,async tx=>{const rows=await tx.execute(sql`select * from app.access_editor_presentation_v1()`);expect(rows).toHaveLength(1);const [proof]=await tx.execute<{role:string;mode:string;isolation:string;advisory:boolean}>(sql`select current_user as role,current_setting('transaction_read_only') as mode,current_setting('transaction_isolation') as isolation,exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) as advisory`);expect(proof).toEqual({role:'ai_hr_app',mode:'on',isolation:'repeatable read',advisory:false});},{readOnlySnapshot:true});
 expect(old.snapshot.groups).toHaveLength(6);expect(old.users.length).toBeGreaterThan(0);expect(old).not.toHaveProperty('recoveryUserIds');expect(old).not.toHaveProperty('evidence');
},30000);
it('requires actual RR/RO, prevents writes, and withholds private bootstrap/helper access',async()=>{
 const {ctx}=await root();
 await refusal(()=>database.withTenant(ctx,tx=>tx.execute(sql`select * from app.access_editor_presentation_v1()`)),'42501');
 await refusal(()=>database.withTenant(ctx,async tx=>{await tx.execute(sql`set transaction read only`);return tx.execute(sql`select * from app.access_editor_presentation_v1()`);}),'42501');
 await refusal(()=>database.withTenant(ctx,tx=>tx.execute(sql`select app._access_bootstrap_eligible(app.current_tenant_id(),app.current_user_id())`),{readOnlySnapshot:true}),'42501');
 await refusal(()=>database.withTenant(ctx,async tx=>{await tx.execute(sql`select * from app.access_editor_presentation_v1()`);return tx.execute(sql`update app_user set archived_at=now() where id=app.current_user_id()`);},{readOnlySnapshot:true}),'25006');
});
it.each(['hr_admin','super_admin']as const)('gives typed uninitialized only to legitimate durable %s then initializes exactly once and reads a fresh snapshot',async role=>{
 const {ctx,grant}=await uninitialized(role),before=await events(ctx.tenantId);expect(before).toEqual([]);
 expect(await readAccessEditorPresentationStatus(ctx)).toEqual({status:'uninitialized'});expect(await events(ctx.tenantId)).toEqual(before);
 const [first,second]=await Promise.all([readAccessConfigurationEditor(ctx),readAccessConfigurationEditor(ctx)]);expect(first).toEqual(second);expect(first.snapshot.groups).toHaveLength(6);
 const after=await events(ctx.tenantId);expect(after).toHaveLength(1);expect(after[0].event_type).toBe('access-configuration.initialized');expect(after[0].payload).toEqual({defaultsCreated:true,legacyRolesChanged:false});
 expect(await owner.db.select().from(roleAssignment).where(eq(roleAssignment.appUserId,ctx.userId!))).toEqual([grant]);
 expect(await readAccessConfigurationEditor(ctx)).toEqual(first);expect(await events(ctx.tenantId)).toEqual(after);
},30000);
it('refuses non-bootstrap and future-undurable actors without creating defaults or returning metadata',async()=>{
 for(const [role,scoped,ending]of [['employee',false,false],['manager',false,false],['hr_admin',true,false],['hr_admin',false,true]]as const){
  const {ctx}=await uninitialized(role,scoped,ending);await expect(readAccessEditorPresentationStatus(ctx)).rejects.toMatchObject({code:'ceiling'});await expect(readAccessConfigurationEditor(ctx)).rejects.toMatchObject({code:'ceiling'});
  expect(await owner.db.select().from(accessConfiguration).where(eq(accessConfiguration.tenantId,ctx.tenantId))).toEqual([]);expect(await events(ctx.tenantId)).toEqual([]);
 }
});
it('freshly refuses a bootstrap actor revoked between the explicit status and existing initialization command',async()=>{
 const {ctx}=await uninitialized(),native=database.withTenant;let presentationReads=0;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(async<T>(supplied:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{
  const result=await native(supplied,read,options);
  if(options?.readOnlySnapshot&&++presentationReads===1)await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,ctx.userId!));
  return result;
 });
 try{await expect(readAccessConfigurationEditor(ctx)).rejects.toMatchObject({code:'ceiling'});}finally{spy.mockRestore();}
 expect(presentationReads).toBe(1);expect(await owner.db.select().from(accessConfiguration).where(eq(accessConfiguration.tenantId,ctx.tenantId))).toEqual([]);expect(await events(ctx.tenantId)).toEqual([]);
});
it('uses actual configure capability instead of an HR-role shortcut and freshly refuses retained revoked/archived/foreign contexts',async()=>{
 const {b,ctx}=await root(),userId=await createAppUser(b.tenantId,null,'employee'),employee:SessionContext={...ctx,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 await expect(readAccessConfigurationEditor(employee)).rejects.toMatchObject({code:'ceiling'});
 const apply=async(effect:'allow'|'deny')=>{const current=await database.withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx)),edit={expectedRevision:current.snapshot.revision,command:{kind:'setOverride' as const,userId,capabilityId:'access.configure',companyId:null,effect}};const preview=await previewAccessConfiguration(ctx,edit,accessConfigurationStore);await saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);};
 await apply('allow');expect(await readAccessConfigurationEditor(employee)).toEqual(await readLockedAccessConfigurationEditor(employee));
 await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,userId));await expect(readAccessConfigurationEditor(employee)).rejects.toMatchObject({code:'ceiling'});
 await owner.db.update(appUser).set({archivedAt:null}).where(eq(appUser.id,userId));expect(await readAccessConfigurationEditor(employee)).toEqual(await readLockedAccessConfigurationEditor(employee));
 const grants=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,userId)).returning();expect(grants).toHaveLength(1);await expect(readAccessConfigurationEditor(employee)).rejects.toMatchObject({code:'ceiling'});
 await owner.db.insert(roleAssignment).values(grants);expect(await readAccessConfigurationEditor(employee)).toEqual(await readLockedAccessConfigurationEditor(employee));
 await apply('deny');await expect(readAccessConfigurationEditor(employee)).rejects.toMatchObject({code:'ceiling'});
 const scoped=await uninitialized('hr_admin',true);await expect(readAccessConfigurationEditor({...scoped.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]})).rejects.toMatchObject({code:'ceiling'});
 await expect(readAccessConfigurationEditor({...ctx,tenantId:scoped.ctx.tenantId})).rejects.toMatchObject({code:'ceiling'});
 expect(await events(scoped.ctx.tenantId)).toEqual([]);
},30000);

it('does not reinterpret a native storage failure as uninitialized or enter bootstrap behind a held writer',async context=>{
 const {b,ctx}=await root(),before=await events(b.tenantId),[originalMetadata]=await owner.client<{definition:string}[]>`select pg_get_functiondef('app.access_configuration_editor_metadata()'::regprocedure) as definition`,spy=budgets();
 try{
  await owner.client.unsafe("CREATE OR REPLACE FUNCTION app.access_configuration_editor_metadata() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Fictional metadata storage failure' USING ERRCODE='55000';END $$");
  await held(b.tenantId,'access',context.signal,async()=>{await refusal(()=>readAccessConfigurationEditor(ctx),'55000');});
  expect(await events(b.tenantId)).toEqual(before);
 }finally{try{await owner.client.unsafe(originalMetadata.definition);}finally{spy.mockRestore();}}
 expect(await readAccessConfigurationEditor(ctx)).toEqual(await readLockedAccessConfigurationEditor(ctx));
},30000);

it('preserves current command CAS, native last-administrator and audit-failure rollback under the factored bootstrap owner',async()=>{
 const {b,ctx}=await root(),load=()=>database.withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx));
 const initial=await load(),groupId=randomUUID(),edit={expectedRevision:initial.snapshot.revision,command:{kind:'createGroup' as const,groupId,name:'Fictional prototype group'}};
 const preview=await previewAccessConfiguration(ctx,edit,accessConfigurationStore);await saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
 await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore)).rejects.toMatchObject({code:'changed'});
 const current=await load(),before=await events(b.tenantId);
 await refusal(()=>database.withTenant(ctx,tx=>tx.execute(sql`select app.access_configuration_commit(${current.snapshot.revision}::uuid,${current.scopeFingerprint},${JSON.stringify({kind:'setOverride',userId:ctx.userId,capabilityId:'access.configure',companyId:null,effect:'deny'})}::jsonb,${randomUUID()}::uuid)`)),'23514');
 expect(ownerFacts(await load())).toEqual(ownerFacts(current));expect(await events(b.tenantId)).toEqual(before);
 let faultInstalled=false;
 try{
  await owner.client.begin(async tx=>{await tx.unsafe("CREATE FUNCTION app.test_access_proto_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='access-configuration.changed' THEN RAISE EXCEPTION 'Fictional Access audit refusal' USING ERRCODE='P0001';END IF;RETURN NEW;END $$");await tx.unsafe('CREATE TRIGGER test_access_proto_audit_failure BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.test_access_proto_audit_failure()');});faultInstalled=true;
  const next={expectedRevision:current.snapshot.revision,command:{kind:'createGroup' as const,groupId:randomUUID(),name:'Must roll back'}},review=await previewAccessConfiguration(ctx,next,accessConfigurationStore);
  await refusal(()=>saveAccessConfiguration(ctx,{...next,previewFingerprint:review.fingerprint},accessConfigurationStore),'P0001');expect(ownerFacts(await load())).toEqual(ownerFacts(current));expect(await events(b.tenantId)).toEqual(before);
 }finally{if(faultInstalled)await owner.client.begin(async tx=>{await tx.unsafe('DROP TRIGGER test_access_proto_audit_failure ON domain_event');await tx.unsafe('DROP FUNCTION app.test_access_proto_audit_failure()');});}
},30000);
