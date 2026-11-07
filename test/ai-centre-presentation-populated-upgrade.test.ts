/** Actual3111 append over its complete populated740-entry prefix, via ordinary migrator only. */
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
import {aiManagementPresentationView,setAiAllowance} from '../core/ai-management';
import {getAiConfigView,getAiConfigPresentationView,saveAiProviderConfig} from '../core/ai-config';
import {setAiSpendBudget} from '../core/ai-spend-management';
import {encryptSecret} from '../lib/ai/crypto';
import {aiManagementView as readLockedManagement} from './fixtures/ai-management-locked-baseline';
import {pgSqlState} from '../lib/db-error';
import {workerDb} from './db-names';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const append={idx:2411,version:'7',when:1793330002711,tag:'3111_ai_centre_presentation_reads',breakpoints:true};
const appendHash='ec9f23c979dfbaf21cb5c8cb09f52662f7f4eafa41fb857837b54ec7dbda5768';
type FunctionRow={signature:string;definition:string;details:Record<string,unknown>};
it('preserves populated AI facts and RC wrapper identities, refuses predecessor drift atomically and replays the actual append and full shadow journal',async context=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(pool).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 const source=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect({host:source.hostname,port:source.port,database:source.pathname,user:source.username,search:source.search,hash:source.hash})
  .toEqual({host:'127.0.0.1',port:'5433',database:'/'+workerDb(pool!),user:'postgres',search:'',hash:''});
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')),prefix=journal.entries.slice(0,740),componentJournal={...journal,entries:journal.entries.slice(0,741)};
 expect(journal.entries.length).toBeGreaterThanOrEqual(741);expect(componentJournal.entries).toHaveLength(741);expect(componentJournal.entries.at(-1)).toEqual(append);
 expect(sha(JSON.stringify(prefix))).toBe('e15c1c8a2af32e937556ade9dce8333d7748749c5f54de7848fbd2c27c71ffb5');
 expect(sha(JSON.stringify(prefix.map((entry:{tag:string})=>[entry.tag,sha(readFileSync('db/migrations/'+entry.tag+'.sql'))])))).toBe('7d90b516af17c2b9979cae1973d9c77d74ba576f716c5681de2a950cebcf8848');
 expect(sha(readFileSync('db/migrations/'+append.tag+'.sql'))).toBe(appendHash);
 const name='ai_hr_ai_upgrade_'+randomUUID().replaceAll('-',''),folder=mkdtempSync(join(tmpdir(),'aihr-ai-upgrade-'));
 source.pathname='/postgres';const admin=postgres(source.toString(),{max:1,onnotice:()=>{}});source.pathname='/'+name;
 const storage=database.createDb(source.toString(),{max:4});let created=false;
 const appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect({host:appUrl.hostname,port:appUrl.port,database:appUrl.pathname,user:appUrl.username,search:appUrl.search,hash:appUrl.hash})
  .toEqual({host:'127.0.0.1',port:'5433',database:'/'+workerDb(pool!),user:'ai_hr_app',search:'',hash:''});appUrl.pathname='/'+name;
 const application=database.createDb(appUrl.toString(),{max:4});
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>application.withTenant(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
  const [identity]=await tx.execute<{role:string;database:string}>(sql`select current_user as role,current_database() as database`);expect(identity).toEqual({role:'ai_hr_app',database:name});return read(tx);
 },options));
 let releaseHeld:(()=>void)|undefined,closing:Promise<unknown>|undefined;
 let shadow:ReturnType<typeof database.createDb>|undefined,shadowCreated=false;const shadowName=name+'_shadow';
 const abort=()=>{releaseHeld?.();closing=Promise.allSettled([application.client.end({timeout:0}),storage.client.end({timeout:0}),...(shadow?[shadow.client.end({timeout:0})]:[])]);};
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
   await tx`insert into tenant(id,workos_org_id,name) values(${tenantId}::uuid,${'org_ai_upgrade_'+tenantId},'Fictional retained AI tenant') on conflict(id) do nothing`;
   await tx`insert into company(id,tenant_id,legal_name) values(${companyId}::uuid,${tenantId}::uuid,'Fictional retained AI company')`;
   await tx`insert into app_user(id,tenant_id,workos_user_id,archived_at) values(${userId}::uuid,${tenantId}::uuid,${'fictional_ai_upgrade_'+userId},case when ${uninitialized} then clock_timestamp() else null end)`;
   await tx`insert into role_assignment(id,tenant_id,app_user_id,role,company_id) values(${grantId}::uuid,${tenantId}::uuid,${userId}::uuid,${role},null)`;
  });
  if(uninitialized)await storage.client`update app_user set archived_at=null where id=${userId}::uuid`;
  return {ctx:{tenantId,userId,personId:null,roles:[role],grants:[{role,companyId:null}]}satisfies SessionContext,companyId,grantId};
 }
 const pending=(async()=>{try{
  vi.stubEnv('AI_CONFIG_SECRET','fictional-ai-upgrade-key');
  const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('No provider/network allowed in migration rehearsal');});
  try{
   context.signal.throwIfAborted();expect((await admin`select current_user as owner`)[0].owner).toBe('postgres');
   await admin.unsafe('CREATE DATABASE "'+name+'"');created=true;mkdirSync(join(folder,'meta'));
   for(const entry of componentJournal.entries)copyFileSync('db/migrations/'+entry.tag+'.sql',join(folder,entry.tag+'.sql'));
   writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));await migrate(storage.db,{migrationsFolder:folder});
   const root=await actor(),foreign=await actor();
   await storage.client`insert into ai_provider_config(tenant_id,provider,model,api_key_ciphertext,key_last4,is_active)
    values(${root.ctx.tenantId}::uuid,'openai','fictional-retained-model',${encryptSecret('fictional-retained-secret',root.ctx.tenantId)},'cret',true)`;
   await saveAiProviderConfig(root.ctx,{provider:'openrouter',model:'fictional/pending',apiKey:'fictional-pending-key',providerOptions:{version:1,routing:{allowedProviders:['approved-fictional'],allowFallbacks:false,sort:'price'}}});
   await setAiAllowance(root.ctx,{kind:'company',subjectId:root.companyId,dailyRequests:3,monthlyTokens:10000,enabled:true});
   await setAiSpendBudget(root.ctx,{kind:'tenant',monthlyUsd:'0',rootUsd:''});
   await storage.client`insert into ai_model_run(tenant_id,user_id,company_ids,feature_id,operation,provider,model,state,actual_tokens,reserved_tokens)
    values(${root.ctx.tenantId}::uuid,${root.ctx.userId!}::uuid,array[${root.companyId}::uuid],'pay_rule_draft','draft','openai','fictional-retained-model','completed',123,200),
    (${foreign.ctx.tenantId}::uuid,${foreign.ctx.userId!}::uuid,array[${foreign.companyId}::uuid],'pay_rule_draft','draft','openai','fictional-foreign','completed',99999,99999)`;
   const expected=await readLockedManagement(root.ctx),expectedConfig=await getAiConfigView(root.ctx);
   expect(expected.provider).toEqual({provider:'openai',model:'fictional-retained-model'});
   expect(expected.usage).toEqual([{feature_id:'pay_rule_draft',daily_requests:'1',monthly_tokens:'123',held_tokens:'0',blocked:'0',failed:'0'}]);
   expect(expected.spend).toMatchObject({budgets:[{scopeKey:'tenant',monthlyNanos:'0',rootNanos:null}],unpricedUnknownRuns:1});
   expect(expectedConfig.providers.find(row=>row.provider==='openrouter')).toMatchObject({configured:true,isActive:false,model:'fictional/pending'});
   const before=await retained(),beforeFunctions=await functions(),beforeLedger=[...await ledger()];expect(beforeLedger).toHaveLength(740);
   expect(before.rows['public.ai_provider_config'].count).toBe(1);expect(before.rows['public.ai_provider_candidate'].count).toBe(1);
   expect(before.rows['public.ai_model_run'].count).toBe(2);expect(before.rows['public.domain_event'].count).toBeGreaterThan(0);
   writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify(componentJournal));
   const predecessors=['app.ai_provider_candidate_view_v1()','app.ai_spend_status()','app.ai_optional_spend_status()','app._ai_provider_evaluation_actor_valid()'];
   for(const signature of predecessors){
    context.signal.throwIfAborted();expect(beforeFunctions.find(row=>row.signature===signature)).toBeTruthy();
    await storage.client.unsafe('alter function '+signature+' cost 101');const drifted=await functions();
    let refusal:unknown;try{await migrate(storage.db,{migrationsFolder:folder});}catch(error){refusal=error;}
    expect(pgSqlState(refusal)).toBe('55000');expect(await functions()).toEqual(drifted);expect(await ledger()).toEqual(beforeLedger);expect(await retained()).toEqual(before);
    expect((await storage.client`select to_regprocedure('app._ai_presentation_actor_valid()') as helper`)[0].helper).toBeNull();
    await storage.client.unsafe('alter function '+signature+' cost 100');expect(await functions()).toEqual(beforeFunctions);
   }
   context.signal.throwIfAborted();await migrate(storage.db,{migrationsFolder:folder});
   const afterLedger=[...await ledger()];expect(afterLedger.slice(0,-1)).toEqual(beforeLedger);expect(afterLedger).toHaveLength(741);
   expect(afterLedger.at(-1)).toMatchObject({hash:appendHash,created_at:String(append.when)});expect(await retained()).toEqual(before);
   const afterFunctions=await functions(),added=afterFunctions.filter(row=>!beforeFunctions.some(old=>old.signature===row.signature));
   expect(added.map(row=>row.signature).sort()).toEqual(['app._ai_presentation_actor_valid()','app._ai_presentation_candidate_rows()',
    'app._ai_presentation_optional_spend_value(jsonb)','app._ai_presentation_spend_value()',
    'app.ai_optional_spend_presentation_status_v1()','app.ai_provider_candidate_presentation_v1()']);
   const bodies:Record<string,string>={
    'app.ai_provider_candidate_view_v1()':"\nBEGIN\n IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;\n RETURN QUERY SELECT * FROM app._ai_presentation_candidate_rows();\nEND ",
    'app.ai_spend_status()':"\nBEGIN\n IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;\n RETURN app._ai_presentation_spend_value();\nEND ",
    'app.ai_optional_spend_status()':"\nDECLARE status jsonb;\nBEGIN\n status:=app.ai_spend_status();\n RETURN app._ai_presentation_optional_spend_value(status);\nEND ",
   };
   for(const old of beforeFunctions){const next=afterFunctions.find(row=>row.signature===old.signature);expect(next).toBeTruthy();
    const body=bodies[old.signature];expect(next).toEqual(body?{...old,definition:old.definition.replace(String(old.details.prosrc),body),details:{...old.details,prosrc:body}}:old);
   }
   const normalize=(value:string)=>value.replace(/\s+/g,'').replace(/;$/,'');
   const prior=(signature:string)=>String(beforeFunctions.find(row=>row.signature===signature)!.details.prosrc);
   const helper=(signature:string)=>String(added.find(row=>row.signature===signature)!.details.prosrc);
   function between(value:string,prefix:string,suffix:string){
    const parts=value.split(prefix);expect(parts).toHaveLength(2);const tail=parts[1];if(tail===undefined)throw Error('Missing native predecessor expression');
    const terms=tail.split(suffix);expect(terms).toHaveLength(2);const expression=terms[0];if(expression===undefined)throw Error('Missing native predecessor expression');return expression;
   }
   const candidate=between(prior('app.ai_provider_candidate_view_v1()'),' RETURN QUERY ',';\nEND');
   expect(normalize(helper('app._ai_presentation_candidate_rows()'))).toBe(normalize(candidate));
   expect(helper('app._ai_presentation_spend_value()')).toBe(prior('app.ai_spend_status()').replace(" IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;\n",''));
   const optional=between(prior('app.ai_optional_spend_status()'),' RETURN ',';\nEND').replace(/^status\|\|/,'status_value||');
   expect(normalize(helper('app._ai_presentation_optional_spend_value(jsonb)'))).toBe(normalize('SELECT '+optional));
   for(const row of added)expect(row.details).toMatchObject({prosecdef:true,proisstrict:false,proleakproof:false,proparallel:'u',procost:100,proconfig:['search_path=public, pg_temp']});
   const acl=await storage.client`select p.proname,grantor.rolname as grantor,coalesce(grantee.rolname,'PUBLIC') as grantee,a.privilege_type,a.is_grantable
    from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a join pg_roles grantor on grantor.oid=a.grantor left join pg_roles grantee on grantee.oid=a.grantee
    where p.pronamespace='app'::regnamespace and (p.proname like '_ai_presentation_%' or p.proname in ('ai_optional_spend_presentation_status_v1','ai_provider_candidate_presentation_v1')) order by p.proname,coalesce(grantee.rolname,'PUBLIC')`;
   const expectedAcl=added.flatMap(row=>[{proname:String(row.details.proname),grantor:'postgres',grantee:'postgres',privilege_type:'EXECUTE',is_grantable:false},
    ...(String(row.details.proname).startsWith('_')?[]:[{proname:String(row.details.proname),grantor:'postgres',grantee:'ai_hr_app',privilege_type:'EXECUTE',is_grantable:false}])])
    .sort((a,b)=>a.proname.localeCompare(b.proname)||a.grantee.localeCompare(b.grantee));
   expect(acl).toEqual(expectedAcl);
   expect(await aiManagementPresentationView(root.ctx)).toEqual(expected);expect(await getAiConfigPresentationView(root.ctx)).toEqual(expectedConfig);
   expect(await readLockedManagement(root.ctx)).toEqual(expected);expect(await retained()).toEqual(before);
   for(const kind of ['access','history']as const){
    let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),done=new Promise<void>(r=>{release=r;});releaseHeld=release;let pid=0;
    const writer=storage.client.begin(async tx=>{await tx`set local statement_timeout='20s'`;
     if(kind==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+root.ctx.tenantId},0))`;else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+root.ctx.tenantId}))`;
     pid=(await tx`select pg_backend_pid() as pid`)[0].pid;entered();await done;
    });
    try{await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before native barrier');})]);
     expect(await aiManagementPresentationView(root.ctx)).toEqual(expected);expect(await getAiConfigPresentationView(root.ctx)).toEqual(expectedConfig);
     if(kind==='access')await expect(setAiSpendBudget(root.ctx,{kind:'tenant',monthlyUsd:'1',rootUsd:''})).rejects.toThrow('Current AI calling authority');
     expect((await storage.client`select exists(select 1 from pg_locks where locktype='advisory' and granted and pid=${pid})as held`)[0].held).toBe(true);
    }finally{release();releaseHeld=undefined;await writer;}
   }
   expect(await retained()).toEqual(before);
   await storage.client`delete from role_assignment where app_user_id=${root.ctx.userId!}::uuid`;
   await expect(aiManagementPresentationView(root.ctx)).rejects.toThrow();await expect(getAiConfigPresentationView(root.ctx)).rejects.toThrow();
   // A separate actual empty database exercises the full ordinary shadow path,
   // never direct installation of the final SQL or reuse of populated ledger rows.
   context.signal.throwIfAborted();await admin.unsafe('CREATE DATABASE "'+shadowName+'"');shadowCreated=true;const shadowUrl=new URL(source);shadowUrl.pathname='/'+shadowName;shadow=database.createDb(shadowUrl.toString(),{max:1});
   context.signal.throwIfAborted();await migrate(shadow.db,{migrationsFolder:folder});
   const shadowLedger=await shadow.client`select hash,created_at::text from drizzle.__drizzle_migrations order by id`;
   expect(shadowLedger).toEqual(componentJournal.entries.map((entry:{tag:string;when:number})=>({hash:sha(readFileSync('db/migrations/'+entry.tag+'.sql')),created_at:String(entry.when)})));
   const shadowAdded=await shadow.client`select proname from pg_proc where pronamespace='app'::regnamespace and (proname like '_ai_presentation_%' or proname in ('ai_optional_spend_presentation_status_v1','ai_provider_candidate_presentation_v1')) order by proname`;
   expect(shadowAdded.map(row=>row.proname)).toEqual(added.map(row=>row.details.proname).sort());
   expect(network).not.toHaveBeenCalled();
  }finally{network.mockRestore();}
 }finally{
  context.signal.removeEventListener('abort',abort);spy.mockRestore();vi.unstubAllEnvs();await closing;
  await Promise.allSettled([application.client.end({timeout:5}),storage.client.end({timeout:5}),...(shadow?[shadow.client.end({timeout:5})]:[])]);
  try{if(shadowCreated)await admin.unsafe('DROP DATABASE "'+shadowName+'" WITH (FORCE)');if(created)await admin.unsafe('DROP DATABASE "'+name+'" WITH (FORCE)');}finally{await admin.end({timeout:5});rmSync(folder,{recursive:true,force:true});}
 }})();
 context.onTestFinished(async()=>{await closing;await pending.catch(()=>{});});await pending;
},300000);
