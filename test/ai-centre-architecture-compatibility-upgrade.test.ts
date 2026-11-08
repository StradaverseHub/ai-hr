/** Real disposable historical709 upgrade through the stock migrator; no provider/HR data.
 * Protected constructor custody and actual non-super owner LOGIN are distinct courses. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {createDb,type SessionContext} from '../db/client';
import {constructAiCentreCompatibilityOwner} from './helpers/ai-centre-compatibility-owner-constructor';

const compatibility='db/migrations/3500_ai_centre_architecture_compatibility.sql';
const context='app._ai_control_context(text,boolean)',beforeContext='app._ai_control_context_before_centre(text,boolean)';
const action='app.ai_action_unpaused(text,boolean)',agent='app.ai_agent_action_unpaused(text)',beforeAgent='app.ai_agent_action_unpaused_before_centre(text)';
const helper='app._ai_control_context_for_purpose(text,boolean,boolean)';
const protectedFunctions=['app.ai_centre_assert_running(integer)','app.ai_centre_control_lock()','app.ai_centre_control_state()','app.ai_centre_read_allowed(text)','app.ai_centre_read_controls()'];
const signatures=[context,beforeContext,action,agent,beforeAgent,...protectedFunctions];
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
// Frozen original Git bytes, already retained by the migration-history owner.
// These are execution inputs in the private fixture, NEVER ledger replacements.
const historical={
 '0180_profile_option':{when:1781862179000,hash:'ae128e75c9491bd1d39537fdddd18ad9307b2050f813b8a056d473dcfda9d41f',commit:'b33432256168fc67955e5f183bb84c1a444b63ed'},
 '0212_dashboard_card_config':{when:1781862211000,hash:'aa9337028da35cd3816d8d66486455595e36aea709c98405868ca36320c99f41',commit:'b8bb0740d3fa5ef1cf60400eb484fa40399e921c'},
} as const;
function sourceDefinition(file:string,name:string){
 const source=readFileSync(file,'utf8'),marker=new RegExp('(?:^|\\n)CREATE(?: OR REPLACE)? FUNCTION app\\.'+name+'\\('),match=marker.exec(source);
 if(!match)throw Error('Native definition missing: '+name);
 const start=match.index+(match[0].startsWith('\n')?1:0),end=source.indexOf('$$;',source.indexOf('AS $$',start)+5);
 if(end<start)throw Error('Native definition incomplete: '+name);
 return source.slice(start,end+3).replace(/^CREATE FUNCTION/,'CREATE OR REPLACE FUNCTION');
}
type NativeFunction={signature:string;oid:number;definition:string;body:string;attributes:Record<string,unknown>;owner:string;app_execute:boolean};

it('upgrades populated709 atomically, preserves real native owners/wrappers and refuses drift and raw stopped admissions',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{idx:number;when:number;tag:string}[]};
 // This qualified component owns the exact3500 boundary; the separate3501 fixture
 // executes and checks the later write-order append against its actual747 boundary.
 journal.entries=journal.entries.slice(0,journal.entries.findIndex(row=>row.tag==='3500_ai_centre_architecture_compatibility')+1);
 const boundary=journal.entries.findIndex(row=>row.tag==='2103_system_performance_read_guards');expect(boundary).toBe(709);
 expect(journal.entries.at(-1)).toMatchObject({idx:2800,when:1793330003100,tag:'3500_ai_centre_architecture_compatibility'});
 const token=randomUUID().replaceAll('-',''),database='ai_hr_ai_compat_'+token,role='aihr_ai_compat_'+token;
 const directory=mkdtempSync(join(tmpdir(),'aihr-ai-compat-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(['127.0.0.1','localhost']).toContain(appUrl.hostname);
 expect(ownerUrl.username).toBe('postgres');expect(appUrl.username).toBe('ai_hr_app');
 expect(appUrl.hostname).toBe(ownerUrl.hostname);expect(appUrl.port).toBe(ownerUrl.port);expect(appUrl.password).toBe('');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+database;appUrl.pathname='/'+database;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});
 let migration:ReturnType<typeof createDb>|undefined;
 let created=false,roleCreated=false,primaryFailure:unknown;
 const report:Record<string,unknown>={kind:'NATIVE_AI_CENTRE_HISTORICAL709_COMPATIBILITY_COMPONENT_ONLY',releaseAuthorized:false,
  complete:false,cleanupComplete:false,phase:'constructor',historicalOriginals:historical,
  resourceBound:{caseMs:300000,pools:4,maxPerPool:1,maximumConnections:4,extraOwnerLoginPools:1,poolCloseSeconds:5,raceLockTimeoutMs:5000,raceStatementTimeoutMs:10000}};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'ai-centre-compatibility-populated-upgrade.json'),JSON.stringify(report,null,2));};
 const tenantId=randomUUID(),companyId=randomUUID(),userId=randomUUID(),foreignTenant=randomUUID(),foreignCompany=randomUUID();
 const ctx:SessionContext={tenantId,userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 const catalogue=async():Promise<NativeFunction[]>=>Array.from(await storage.client<NativeFunction[]>`
  select p.oid::regprocedure::text as signature,p.oid,pg_get_functiondef(p.oid) as definition,p.prosrc as body,
   (to_jsonb(p)-'prosrc'-'proconfig'-'proargdefaults')||jsonb_build_object('proargdefaults',pg_get_expr(p.proargdefaults,0)) as attributes,
   p.proowner::regrole::text as owner,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute
  from pg_proc p where p.oid=any(${[...signatures,helper]}::text[]::regprocedure[]) order by p.oid::regprocedure::text`);
 const beforeCatalogue=async():Promise<NativeFunction[]>=>Array.from(await storage.client<NativeFunction[]>`
  select p.oid::regprocedure::text as signature,p.oid,pg_get_functiondef(p.oid) as definition,p.prosrc as body,
   (to_jsonb(p)-'prosrc'-'proconfig'-'proargdefaults')||jsonb_build_object('proargdefaults',pg_get_expr(p.proargdefaults,0)) as attributes,
   p.proowner::regrole::text as owner,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute
  from pg_proc p where p.oid=any(${signatures}::text[]::regprocedure[]) order by p.oid::regprocedure::text`);
 const facts=async()=>({
  tenants:await storage.client`select id,name,status from tenant where id in(${tenantId},${foreignTenant}) order by id`,
  companies:await storage.client`select id,tenant_id,legal_name from company where id in(${companyId},${foreignCompany}) order by id`,
  users:await storage.client`select id,tenant_id,person_id,archived_at from app_user where id=${userId}`,
  grants:await storage.client`select to_jsonb(r) as row from role_assignment r where app_user_id=${userId} order by id`,
  runs:await storage.client`select to_jsonb(r) as row from ai_model_run r where tenant_id=${tenantId} order by id`,
 });
 try{
  await admin.unsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT -1`);roleCreated=true;
  await admin.unsafe(`CREATE DATABASE "${database}" OWNER "${role}"`);created=true;
  mkdirSync(join(directory,'meta'));for(const entry of journal.entries){
   const original=historical[entry.tag as keyof typeof historical];
   const path=original?'.github/ci/historical-migrations/'+entry.tag+'.sql':'db/migrations/'+entry.tag+'.sql';
   if(original){expect(entry.when).toBe(original.when);expect(sha(readFileSync(path))).toBe(original.hash);}
   copyFileSync(path,join(directory,entry.tag+'.sql'));
  }
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(storage.db,{migrationsFolder:directory});
  report.phase='populated709';save();
  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenantId},${randomUUID()},'Fictional AI compatibility'),(${foreignTenant},${randomUUID()},'Fictional foreign group')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${companyId},${tenantId},'Fictional AI employer'),(${foreignCompany},${foreignTenant},'Fictional foreign employer')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${userId},${tenantId},null,${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenantId},${userId},'hr_admin')`;
  await storage.client`insert into ai_model_run(tenant_id,user_id,feature_id,operation,provider,model,state,reserved_tokens) values(${tenantId},${userId},'hr_assistant','conversation','fixture','never-sent','pending',123)`;
  // The privileged constructor is fixed to this newly owned loopback fixture.
  // Then the actual pending stock migrator uses a SEPARATE real owner LOGIN.
  const [{owner}]=await storage.client<{owner:string}[]>`select current_user as owner`;
  expect(owner).toBe('postgres');
  const construction=await constructAiCentreCompatibilityOwner(storage.client,database,role);
  report.constructor={realm:construction.realm,memberships:construction.memberships,perKind:construction.perKind,
   beforeSha256:sha(Buffer.from(JSON.stringify(construction.before))),afterSha256:sha(Buffer.from(JSON.stringify(construction.after))),transferred:construction.transferred};
  // Do not invent a password or an authentication bypass. The existing ordinary
  // app route must be the declared passwordless loopback course. Login failure
  // is a genuine qualification failure; never fall back to SET ROLE.
  const login=new URL(appUrl.toString());login.username=role;
  migration=createDb(login.toString(),{max:1});
  const [actualOwner]=await migration.client`select current_user as role,session_user as login,current_database()as database,inet_server_addr()='127.0.0.1'::inet as loopback,
   r.rolsuper,r.rolinherit,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolconnlimit from pg_roles r where r.rolname=current_user`;
  expect(actualOwner).toEqual({role,login:role,database,loopback:true,rolsuper:false,rolinherit:true,rolcanlogin:true,rolreplication:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,rolconnlimit:-1});
  report.migrationOwner=actualOwner;
  const baseline=await beforeCatalogue(),originalLedger=await ledger(),originalFacts=await facts();expect(originalLedger).toHaveLength(709);
  const tableState=()=>storage.client`select relowner::regrole::text as owner,relacl::text as acl,relrowsecurity as rls,relforcerowsecurity as force from pg_class where oid='public.teras_mandate_control'::regclass`;
  const controlTable=await tableState();expect(controlTable[0]).toMatchObject({owner:role,rls:true,force:false});
  expect(originalLedger.map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(journal.entries.slice(0,709).map(entry=>({
   hash:sha(readFileSync(join(directory,entry.tag+'.sql'))),created_at:String(entry.when),
  })));
  for(const [tag,original]of Object.entries(historical))expect(originalLedger.find(row=>row.created_at===String(original.when))?.hash,tag).toBe(original.hash);
  expect(baseline).toHaveLength(10);expect(baseline.every(row=>row.owner===role)).toBe(true);
  const oldContext=baseline.find(row=>row.signature===beforeContext)!;
  const oldWrapper=baseline.find(row=>row.signature===context)!,oldAgent=baseline.find(row=>row.signature===agent)!;
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify(journal));
  // This private installed owner is not overwritten by2124/2131/2133/2138. A
  // genuine final guard refusal must undo ALL36 earlier pending migrations too.
  await storage.client.unsafe(oldContext.definition.replace('AS $function$','AS $function$\n-- genuine unknown installed private owner'));
  report.phase='whole-batch-rollback';save();
  const drifted=await beforeCatalogue();
  await expect(migrate(migration.db,{migrationsFolder:directory})).rejects.toMatchObject({cause:{code:'55000',
   message:'Unexpected AI Centre compatibility predecessor: app._ai_control_context_before_centre(text,boolean)'}});
  expect(await ledger()).toEqual(originalLedger);expect(await beforeCatalogue()).toEqual(drifted);expect(await facts()).toEqual(originalFacts);
  expect((await storage.client`select to_regprocedure(${helper}) as helper,to_regclass('public.notification_event_processing') as queue`)[0]).toEqual({helper:null,queue:null});
  await storage.client.unsafe(oldContext.definition);
  report.wholePendingBatchRollback=true;report.phase='stock-upgrade';save();
  await migrate(migration.db,{migrationsFolder:directory});
  const upgraded=await catalogue(),afterLedger=await ledger();expect(afterLedger).toHaveLength(746);
  // Compare ACTUAL before rows. The installed staging0180/0212 hash exceptions
  // must never be replaced by a universal source/ledger hash identity assertion.
  expect(afterLedger.slice(0,709)).toEqual(originalLedger);expect(await facts()).toEqual(originalFacts);
  for(const [i,entry]of journal.entries.slice(709).entries())expect(afterLedger[709+i]).toMatchObject({created_at:String(entry.when),hash:sha(readFileSync('db/migrations/'+entry.tag+'.sql'))});
  expect(upgraded.find(row=>row.signature===context)?.definition).toBe(oldWrapper.definition);
  expect(upgraded.find(row=>row.signature===agent)?.definition).toBe(oldAgent.definition);
  for(const previous of baseline){const current=upgraded.find(row=>row.signature===previous.signature)!;expect(current.oid).toBe(previous.oid);expect(current.attributes).toEqual(previous.attributes);expect(current.owner).toBe(role);expect(current.app_execute).toBe(previous.app_execute);}
  for(const signature of protectedFunctions)expect(upgraded.find(row=>row.signature===signature)?.definition).toBe(baseline.find(row=>row.signature===signature)?.definition);
  expect(upgraded.find(row=>row.signature===helper)).toMatchObject({owner:role,app_execute:false});
  expect(await tableState()).toEqual(controlTable);
  report.ledgerBeforeSha256=sha(Buffer.from(JSON.stringify(originalLedger)));report.ledgerAfterSha256=sha(Buffer.from(JSON.stringify(afterLedger)));
  report.catalogueBeforeSha256=sha(Buffer.from(JSON.stringify(baseline)));report.catalogueAfterSha256=sha(Buffer.from(JSON.stringify(upgraded)));
  report.appliedRowsBefore=originalLedger.length;report.appliedRowsAfter=afterLedger.length;report.phase='native-drift-probes';save();
  // Reconstruct only the known final pending catalogue inside a rollback-only
  // transaction, then independently fault EACH guarded body, ACL and config.
  const pending=[oldContext.definition,baseline.find(row=>row.signature===beforeAgent)!.definition,
   sourceDefinition('db/migrations/2138_ai_pause_company_discovery.sql','_ai_control_context_for_purpose'),
   sourceDefinition('db/migrations/2138_ai_pause_company_discovery.sql','_ai_control_context'),
   sourceDefinition('db/migrations/2133_ai_action_read_only_lock.sql','ai_agent_action_unpaused')];
  const guard=readFileSync(compatibility,'utf8').split('--> statement-breakpoint')[0];
  for(const signature of [...signatures,helper])for(const fault of ['body','acl','configuration','owner'] as const){
   await expect(storage.client.begin(async tx=>{
    for(const definition of pending)await tx.unsafe(definition);
    const [{definition}]=await tx<{definition:string}[]>`select pg_get_functiondef(${signature}::regprocedure) as definition`;
    if(fault==='body')await tx.unsafe(definition.replace('AS $function$','AS $function$\n-- genuine unknown body'));
    if(fault==='acl')await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`);
    if(fault==='configuration')await tx.unsafe(`ALTER FUNCTION ${signature} SET search_path=pg_catalog`);
    if(fault==='owner'){
     // Only the privileged fixture constructor mutates ownership. The actual
     // migration guard then executes again as the non-super owner under test.
     await tx.unsafe(`SET LOCAL ROLE "${owner}"`);await tx.unsafe(`ALTER FUNCTION ${signature} OWNER TO "${owner}"`);await tx.unsafe(`SET LOCAL ROLE "${role}"`);
    }
    await tx.unsafe(`SET LOCAL ROLE "${role}"`);await tx.unsafe(guard);
   }),signature+'/'+fault).rejects.toMatchObject({code:'55000'});
   expect(await catalogue()).toEqual(upgraded);expect(await ledger()).toEqual(afterLedger);
  }
  await expect(storage.client.begin(async tx=>{
   for(const definition of pending)await tx.unsafe(definition);
   await tx.unsafe(`SET LOCAL ROLE "${owner}"`);await tx.unsafe(`ALTER TABLE public.teras_mandate_control OWNER TO "${owner}"`);await tx.unsafe(`SET LOCAL ROLE "${role}"`);
   await tx.unsafe(guard);
  })).rejects.toMatchObject({code:'55000'});
  expect(await tableState()).toEqual(controlTable);expect(await catalogue()).toEqual(upgraded);
  report.refusedFunctionDrifts=44;report.refusedTableOwnerDrifts=1;report.phase='raw-native-stop-policy';save();
  const [actualApp]=await application.client`select current_user as role,session_user as login,current_database()as database,inet_server_addr()='127.0.0.1'::inet as loopback`;
  expect(actualApp).toEqual({role:'ai_hr_app',login:'ai_hr_app',database,loopback:true});report.applicationLogin=actualApp;
  const check=()=>application.withTenant(ctx,tx=>tx.execute<{allowed:boolean;agent:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false) as allowed,app.ai_agent_action_unpaused('claims.cancel') as agent`));
  expect((await check())[0]).toEqual({allowed:true,agent:true});
  const full=await migration.withTenant(ctx,tx=>tx.execute<{company_ids:string[];feature_paused:boolean}>(sql`select * from app._ai_control_context('hr_assistant',false)`));
  expect(full[0]).toEqual({company_ids:[companyId],feature_paused:false});
  await application.withTenant(ctx,tx=>tx.execute(sql`insert into teras_mandate_control(tenant_id,stopped,changed_by_user_id) values(${tenantId},true,${userId})`));
  expect((await check())[0]).toEqual({allowed:false,agent:false});
  expect((await application.withTenant(ctx,tx=>tx.execute(sql`select * from app.ai_admit('hr_assistant','conversation','fixture','never-sent',1)`)))[0]).toMatchObject({allowed:false,blocked_reason:'paused'});
  await application.withTenant(ctx,tx=>tx.execute(sql`update teras_mandate_control set stopped=false,changed_by_user_id=${userId} where tenant_id=${tenantId}`));
  expect((await check())[0]).toEqual({allowed:true,agent:true});
  expect((await application.withTenant(ctx,tx=>tx.execute(sql`select app.ai_centre_assert_running(0) as stale,app.ai_centre_assert_running() as generation`)))[0]).toEqual({stale:null,generation:2});
  expect((await application.withTenant(ctx,tx=>tx.execute(sql`select app.ai_action_unpaused('hr_assistant',true) as allowed`)))[0]).toEqual({allowed:false});
  const concurrentPorts:unknown[]=[];
  for(const port of ['feature','agent']as const){
   let reader:Promise<{rows?:{allowed:boolean}[];error?:unknown}>|undefined,writerFailure:unknown,appPid:number|undefined,writerPid:number|undefined,blocked=false;
   let entered=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;});
   try{await migration.client.begin(async writer=>{
    await writer`set local lock_timeout='5s'`;await writer`set local statement_timeout='10s'`;
    await writer`select set_config('app.tenant_id',${tenantId},true)`;
    await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+tenantId},0))`;
    await writer`select pg_advisory_xact_lock(hashtext('ai-control'),hashtext(${tenantId}))`;
    const [identity]=await writer`select pg_backend_pid()as pid`;writerPid=identity.pid as number;
    await writer`update teras_mandate_control set stopped=true,changed_by_user_id=${userId} where tenant_id=${tenantId}`;
    reader=application.withTenant(ctx,async tx=>{
     await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='10s'`);
     const [identity]=await tx.execute<{pid:number}>(sql`select pg_backend_pid()as pid`);appPid=identity.pid;entered();
     return tx.execute<{allowed:boolean}>(port==='feature'?sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`:sql`select app.ai_agent_action_unpaused('claims.cancel')as allowed`);
    }).then(rows=>({rows:Array.from(rows)}),error=>({error}));
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([started,reader.then(result=>{throw result.error??Error('Raw read finished before its expected native stop wait');}),
     new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Raw stop reader never entered its real transaction')),2500);})]);}finally{clearTimeout(timer);}
    for(let poll=0;poll<100;poll++){
     const [state]=await storage.client`select coalesce(${writerPid}=any(pg_blocking_pids(${appPid}::integer)),false)as blocked`;
     if(state.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(blocked,port+' must genuinely wait behind the held stop writer').toBe(true);
   });}catch(error){writerFailure=error;}
   // Every started real query settles after holder COMMIT/rollback, including a
   // failed observation. Never release the owning pool with an unawaited sibling.
   const completion=await reader;
   if(writerFailure)throw writerFailure;if(completion&&'error'in completion)throw completion.error;
   concurrentPorts.push({port,appPid,writerPid,blocked,allowed:completion?.rows?.[0].allowed});
   report.rawConcurrentPorts=concurrentPorts;save();
   expect(completion?.rows?.[0],port+' observes the committed stop').toEqual({allowed:false});
   await application.withTenant(ctx,tx=>tx.execute(sql`update teras_mandate_control set stopped=false,changed_by_user_id=${userId} where tenant_id=${tenantId}`));
  }
  await application.withTenant(ctx,tx=>tx.execute(sql`insert into ai_control_policy(tenant_id,scope_key,kind,subject_id,enabled,updated_by_user_id) values(${tenantId},${'company:'+companyId},'company',${companyId},false,${userId})`));
  expect((await check())[0]).toEqual({allowed:false,agent:true});
  const deniedScope=await migration.withTenant(ctx,tx=>tx.execute<{company_ids:string[]}>(sql`select company_ids from app._ai_control_context('hr_assistant',false)`));expect(deniedScope[0].company_ids).toEqual([companyId]);
  await application.withTenant(ctx,tx=>tx.execute(sql`select app.ai_agent_action_pause_set('claims.cancel',true)`));expect((await check())[0]).toEqual({allowed:false,agent:false});
  await migrate(migration.db,{migrationsFolder:directory});expect(await ledger()).toEqual(afterLedger);expect(await catalogue()).toEqual(upgraded);
  report.complete=true;report.phase='cleanup';save();
 }catch(error){primaryFailure=error;throw error;}finally{
  const failures:unknown[]=[];
  for(const close of [()=>application.client.end({timeout:5}),async()=>{await migration?.client.end({timeout:5});},()=>storage.client.end({timeout:5}),
   async()=>{if(created)await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);},
   async()=>{if(roleCreated)await admin.unsafe(`DROP ROLE "${role}"`);},
   async()=>{const [absence]=await admin`select not exists(select 1 from pg_database where datname=${database}) as database_absent,not exists(select 1 from pg_roles where rolname=${role}) as role_absent`;expect(absence).toEqual({database_absent:true,role_absent:true});report.cleanup=absence;report.cleanupComplete=true;},()=>admin.end({timeout:5}),
   ()=>rmSync(directory,{recursive:true,force:true})])try{await close();}catch(error){failures.push(error);}
  report.phase=primaryFailure||failures.length?'failed':'complete';if(primaryFailure||failures.length)report.complete=false;try{save();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError([...(primaryFailure?[primaryFailure]:[]),...failures],'AI compatibility fixture cleanup failed');
 }
},300000);
