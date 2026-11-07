/** Disposable exact739 component construction, NOT the installed706/707 chain. */
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect} from 'vitest';
import {createDb} from '../../db/client';
import {workerDb} from '../db-names';
import {accessCleanupBounds,accessCleanupLifetime,requireAccessCleanupOid} from './access-editor-cleanup-lifetime';
import {accessEditorCatalogueDiagnostic,writeAccessEditorCatalogueDiagnostic} from './access-editor-catalogue-diagnostic';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export async function accessEditorNativeOwnerFixture(signal:AbortSignal,poison:(error:Error)=>void,evidenceDirectory:string){
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(pool).toMatch(/^[1-9][0-9]*$/);expect(process.env.WORKER_DB).not.toBe('0');
 const source=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),app=new URL(process.env.TEST_DATABASE_URL!);
 for(const url of [source,app]){expect(url.hostname).toBe('127.0.0.1');expect(url.pathname).toBe('/'+workerDb(pool!));expect(url.search).toBe('');expect(url.hash).toBe('');}
 expect(source.username).toBe('postgres');expect(app.username).toBe('ai_hr_app');expect(source.port).toBe(app.port);
 const suffix=randomUUID().replaceAll('-',''),name='aihr_access_'+suffix,role='aihr_access_'+suffix,foreignRole='aihr_access_other_'+suffix,password=randomUUID();
 const folder=mkdtempSync(join(tmpdir(),'aihr-access-native-owner-')),controlName='aihr_access_control_'+suffix;source.pathname='/postgres';const cleanupUrl=source.toString();
 const admin=postgres(source.toString(),{max:1,connect_timeout:2,onnotice:()=>{},connection:{statement_timeout:20000,lock_timeout:300,application_name:controlName}});source.pathname='/'+name;
 const construction=postgres(source.toString(),{max:1,connect_timeout:2,onnotice:()=>{},connection:{statement_timeout:20000,lock_timeout:300}});
 const nativeUrl=new URL(source);nativeUrl.username=role;nativeUrl.password=password;app.pathname='/'+name;
 // Startup limits cover EVERY raw native and application statement, including
 // direct refusal controls; withTenant additionally repeats the same local caps.
 app.searchParams.set('options','-c statement_timeout=20000 -c lock_timeout=300');app.searchParams.set('connect_timeout','2');
 const native={client:postgres(nativeUrl.toString(),{max:4,connect_timeout:2,onnotice:()=>{},connection:{statement_timeout:20000,lock_timeout:300}})},application=createDb(app.toString(),{max:4});let roleOid:number|undefined,foreignRoleOid:number|undefined,databaseOid:number|undefined,controlIdentity:{pid:number;started:string}|undefined;
 let closed:Promise<{complete:true;databaseAbsent:true;rolesAbsent:true;ownedBackendsAbsent:true;elapsedMs:number}>|undefined,interrupting:Promise<void>|undefined,cleanupStartedAt:number|undefined;
 const active=()=>signal.throwIfAborted();
 const interrupt=()=>{
  cleanupStartedAt??=performance.now();
  return interrupting??=Promise.resolve().then(async()=>{
   const settled=await Promise.allSettled([application.client.end({timeout:0}),native.client.end({timeout:0}),construction.end({timeout:0}),admin.end({timeout:0})]);
   const failures=settled.filter(row=>row.status==='rejected');if(failures.length)throw new AggregateError(failures,'Owned Access sockets could not be interrupted');
  });
 };
 const abort=()=>{void interrupt().catch(poison);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const close=()=>{
  cleanupStartedAt??=performance.now();
  return closed??=Promise.resolve().then(async()=>{
   const options={max:1,connect_timeout:accessCleanupBounds.connectSeconds,onnotice:()=>{},connection:{statement_timeout:accessCleanupBounds.statementMs,lock_timeout:accessCleanupBounds.lockMs}};
   const cleanup=postgres(cleanupUrl,options),observer=postgres(cleanupUrl,options);
   let cleanupIdentity:{pid:number;started:string}|undefined,stoppingCleanup:Promise<void>|undefined,stoppingObserver:Promise<void>|undefined,absence=false;
   const stopCleanup=()=>stoppingCleanup??=Promise.resolve().then(()=>cleanup.end({timeout:0}));
   const stopObserver=()=>stoppingObserver??=Promise.resolve().then(()=>observer.end({timeout:0}));
   const life=accessCleanupLifetime(cleanupStartedAt!,async()=>{await Promise.all([interrupt(),stopCleanup()]);},stopObserver,poison);
   try{
    await life.step(interrupt);
    const [identity]=await life.step(()=>cleanup`select current_user as current,session_user as session,current_database()as database,current_setting('statement_timeout')as statement_budget,current_setting('lock_timeout')as lock_budget,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started`);
    expect(identity.statement_budget).toBe('2s');expect(identity.lock_budget).toBe('300ms');expect(identity.current).toBe('postgres');expect(identity.session).toBe('postgres');expect(identity.database).toBe('postgres');cleanupIdentity={pid:identity.pid,started:identity.started};
    // The original control backend may outlive its closed socket. Never terminate
    // a reused PID, foreign start time or an unrecorded/changed control identity.
    if(controlIdentity){
     const old=controlIdentity;const [stopped]=await life.step(()=>cleanup`select case when exists(select 1 from pg_stat_activity where pid=${old.pid} and backend_start=${old.started}::text::timestamptz)then case when exists(select 1 from pg_stat_activity where pid=${old.pid} and backend_start=${old.started}::text::timestamptz and usename='postgres'and datname='postgres'and application_name=${controlName})then pg_terminate_backend(${old.pid},1000)else false end else true end as stopped`);expect(stopped.stopped).toBe(true);
    }else expect((await life.step(()=>cleanup`select count(*)::int as n from pg_stat_activity where application_name=${controlName}`))[0].n).toBe(0);
    const [owned]=await life.step(()=>cleanup`select
     (select oid::int from pg_database where datname=${name})as db_oid,(select datdba::int from pg_database where datname=${name})as db_owner,
     (select datistemplate or not datallowconn from pg_database where datname=${name})as unsafe_database,
     (select jsonb_agg(jsonb_build_object('oid',oid::int,'name',rolname,'login',rolcanlogin,'inherit',rolinherit,'super',rolsuper,'bypass',rolbypassrls,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'limit',rolconnlimit,'until',rolvaliduntil,'config',rolconfig)order by oid)from pg_roles where rolname=any(${[role,foreignRole]}::text[]))as roles,
     (select count(*)::int from pg_auth_members where roleid in(select oid from pg_roles where rolname=any(${[role,foreignRole]}::text[]))or member in(select oid from pg_roles where rolname=any(${[role,foreignRole]}::text[]))or grantor in(select oid from pg_roles where rolname=any(${[role,foreignRole]}::text[])))as memberships`);
    const observedRoles:Array<{oid:number;name:string}>=owned.roles??[];
    for(const observed of observedRoles){const expected=observed.name===role?roleOid:observed.name===foreignRole?foreignRoleOid:undefined;requireAccessCleanupOid(observed.oid,expected,'role');expect(observed).toEqual({oid:expected,name:observed.name,login:observed.name===role,inherit:false,super:false,bypass:false,createdb:false,createrole:false,replication:false,limit:-1,until:null,config:null});}
    expect(owned.memberships).toBe(0);
    if(requireAccessCleanupOid(owned.db_oid,databaseOid,'database')){expect(owned.db_owner).toBe(roleOid);expect(owned.unsafe_database).toBe(false);await life.step(()=>cleanup.unsafe('DROP DATABASE '+quote(name)+' WITH (FORCE)'));}
    if(observedRoles.length){
     const ids=observedRoles.map(row=>row.oid),names=observedRoles.map(row=>row.name);
     // All operands are captured native safe integers or private generated names.
     // Guard and DROP share one native transaction; no broad role reassignment.
     const expected=observedRoles.map(row=>'(oid='+row.oid+' AND rolname=\''+row.name+'\' AND rolcanlogin='+String(row.name===role)+')').join(' OR ');
     await life.step(()=>cleanup.unsafe('DO $cleanup$ BEGIN IF (SELECT count(*) FROM pg_roles WHERE '+expected+')<>'+observedRoles.length+' OR EXISTS(SELECT 1 FROM pg_roles WHERE oid IN('+ids.join(',')+')AND(rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolconnlimit<>-1 OR rolvaliduntil IS NOT NULL OR rolconfig IS NOT NULL))OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid IN('+ids.join(',')+')OR member IN('+ids.join(',')+')OR grantor IN('+ids.join(',')+'))OR EXISTS(SELECT 1 FROM pg_database WHERE datdba IN('+ids.join(',')+'))THEN RAISE EXCEPTION \'Uncertain owned Access role cleanup\' USING ERRCODE=\'55000\';END IF;DROP ROLE '+names.map(quote).join(',')+';END $cleanup$;'));
    }
    const [proof]=await life.step(()=>cleanup`select not exists(select 1 from pg_database where datname=${name})as database_absent,not exists(select 1 from pg_roles where rolname=any(${[role,foreignRole]}::text[]))as roles_absent,not exists(select 1 from pg_stat_activity where datname=${name} or application_name=${controlName})as backends_absent`);
    expect(proof).toEqual({database_absent:true,roles_absent:true,backends_absent:true});absence=true;
   }catch(error){life.refuse(error);}
   finally{
    try{await life.finish(async step=>{
     await step(stopCleanup);
     const targets=[...(controlIdentity?[{...controlIdentity,label:controlName}]:[]),...(cleanupIdentity?[{...cleanupIdentity,label:null}]:[])];
     const [stopped]=await step(()=>observer`select current_user='postgres'and session_user='postgres'and current_database()='postgres'and current_setting('statement_timeout')='2s'and current_setting('lock_timeout')='300ms'as exact_observer,
      coalesce((select bool_and(case when exists(select 1 from pg_stat_activity a where a.pid=t.pid and a.backend_start=t.started::timestamptz)then case when exists(select 1 from pg_stat_activity a where a.pid=t.pid and a.backend_start=t.started::timestamptz and a.usename='postgres'and a.datname='postgres'and(t.label is null or a.application_name=t.label))then pg_terminate_backend(t.pid,500)else false end else true end)from jsonb_to_recordset(${JSON.stringify(targets)}::text::jsonb)t(pid integer,started text,label text)),true)as stopped`);expect(stopped).toEqual({exact_observer:true,stopped:true});
     const [settled]=await step(()=>observer`select not exists(select 1 from pg_stat_activity a join jsonb_to_recordset(${JSON.stringify(targets)}::text::jsonb)t(pid integer,started text,label text)on a.pid=t.pid and a.backend_start=t.started::timestamptz)and not exists(select 1 from pg_stat_activity where application_name=${controlName})as absent`);expect(settled.absent).toBe(true);
     await step(async()=>{rmSync(folder,{recursive:true,force:true});});
    });}finally{signal.removeEventListener('abort',abort);}
   }
   if(!absence){const error=Error('Owned Access cleanup has no complete native absence proof');poison(error);throw error;}
   const proof={complete:true as const,databaseAbsent:true as const,rolesAbsent:true as const,ownedBackendsAbsent:true as const,elapsedMs:life.snapshot().elapsedMs};expect(proof.elapsedMs).toBeLessThan(accessCleanupBounds.totalMs);console.info('Actual Access native-owner cleanup',JSON.stringify(proof));return proof;
  });
 };
 try{
  active();const [control]=await admin`select current_user as current,session_user as session,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started`;expect(control.current).toBe('postgres');expect(control.session).toBe('postgres');controlIdentity={pid:control.pid,started:control.started};
  expect(await admin`select 1 from pg_roles where rolname=any(${[role,foreignRole]}::text[])`).toHaveLength(0);
  active();await admin.unsafe('CREATE ROLE '+quote(role)+" LOGIN PASSWORD '"+password+"' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION");roleOid=Number((await admin`select oid::int as oid from pg_roles where rolname=${role}`)[0].oid);
  active();await admin.unsafe('CREATE ROLE '+quote(foreignRole)+' NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');foreignRoleOid=Number((await admin`select oid::int as oid from pg_roles where rolname=${foreignRole}`)[0].oid);
  active();await admin.unsafe('CREATE DATABASE '+quote(name)+' OWNER '+quote(role));databaseOid=Number((await admin`select oid::int as oid from pg_database where datname=${name}`)[0].oid);
  const journal=JSON.parse(readFileSync('test/fixtures/access-editor-original739-journal.json','utf8')),prefix=journal.entries;expect(prefix).toHaveLength(739);
  expect(sha(JSON.stringify(prefix))).toBe('2f2bf63ad7197b2b9042dee26f1a701539addc7f146cce14914fdc8ec1006a05');
  expect(sha(JSON.stringify(prefix.map((entry:{tag:string})=>[entry.tag,sha(readFileSync('db/migrations/'+entry.tag+'.sql'))])))).toBe('feb775454a5577ca5ec1b8e86a56bf5a57f3b27d7f7b4aa47735142e678a5d00');
  mkdirSync(join(folder,'meta'));for(const entry of prefix){active();copyFileSync('db/migrations/'+entry.tag+'.sql',join(folder,entry.tag+'.sql'));}
  const globalRoles=async()=>({roles:Array.from(await admin`select oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig from pg_roles order by oid`),edges:Array.from(await admin`select * from pg_auth_members order by roleid,member`)});
  const beforePrefixRoles=await globalRoles();
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));active();await migrate(drizzle(construction),{migrationsFolder:folder});active();
  expect(await globalRoles()).toEqual(beforePrefixRoles);
  expect((await construction`select current_database()as database,current_user as current,session_user as session`)[0]).toEqual({database:name,current:'postgres',session:'postgres'});
  const [owners]=await construction`select 'postgres'::regrole::oid as original,(select oid from pg_roles where rolname=${role})as native`;
  const oldOwner=Number(owners.original),newOwner=Number(owners.native);expect(Number.isSafeInteger(newOwner)).toBe(true);
  // Exact public/app inventory plus table-owned TOAST/index dependencies. Exclude
  // extension membership from transfer, not from the complete captured inventory.
  async function catalog(normalizeOwner=false){
   const normalize=normalizeOwner?newOwner:oldOwner;
   // ALTER VIEW OWNER also rewrites native rule permission-owner fields. Normalize
   // ONLY that exact typed node field, not arbitrary OID text or expression bytes.
   const nodeOwner=(value:unknown)=>{if(typeof value!=='string')throw Error('Native rewrite node text required');return normalizeOwner?value.replaceAll(new RegExp(':checkAsUser '+newOwner+'(?=[\\s)])','g'),':checkAsUser '+oldOwner):value;};
   return{
    namespaces:Array.from(await construction`select n.oid,n.nspname,case when n.nspowner=${normalize}::oid then ${oldOwner}::oid else n.nspowner end as owner,to_jsonb(n)-'nspowner'-'nspacl'as details,
     (select jsonb_agg(jsonb_build_array(case when a.grantor=${normalize}::oid then ${oldOwner}::oid else a.grantor end,case when a.grantee=${normalize}::oid then ${oldOwner}::oid else a.grantee end,a.privilege_type,a.is_grantable)order by a.privilege_type,case when a.grantee=${normalize}::oid then ${oldOwner}::oid else a.grantee end,case when a.grantor=${normalize}::oid then ${oldOwner}::oid else a.grantor end)from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a)as acl from pg_namespace n where n.nspname in('public','app')order by n.oid`),
    functions:Array.from(await construction`select p.oid,p.oid::regprocedure::text as signature,case when p.proowner=${normalize}::oid then ${oldOwner}::oid else p.proowner end as owner,to_jsonb(p)-'proowner'-'proacl'as details,
     (select jsonb_agg(jsonb_build_array(case when a.grantor=${normalize}::oid then ${oldOwner}::oid else a.grantor end,case when a.grantee=${normalize}::oid then ${oldOwner}::oid else a.grantee end,a.privilege_type,a.is_grantable)order by a.privilege_type,case when a.grantee=${normalize}::oid then ${oldOwner}::oid else a.grantee end,case when a.grantor=${normalize}::oid then ${oldOwner}::oid else a.grantor end)from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app')order by p.oid`),
    relations:Array.from(await construction`select c.oid,c.relnamespace,c.relname,case when c.relowner=${normalize}::oid then ${oldOwner}::oid else c.relowner end as owner,
     to_jsonb(c)-'relowner'-'relacl'-'relpages'-'reltuples'-'relallvisible'-'relfrozenxid'-'relminmxid'as details,
     (select jsonb_agg(jsonb_build_array(case when a.grantor=${normalize}::oid then ${oldOwner}::oid else a.grantor end,case when a.grantee=${normalize}::oid then ${oldOwner}::oid else a.grantee end,a.privilege_type,a.is_grantable)order by a.privilege_type,case when a.grantee=${normalize}::oid then ${oldOwner}::oid else a.grantee end,case when a.grantor=${normalize}::oid then ${oldOwner}::oid else a.grantor end)from aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S'then 's'else 'r'end::"char",c.relowner)))a)as acl
     from pg_class c where c.relnamespace in('public'::regnamespace,'app'::regnamespace)or c.oid in(select r.reltoastrelid from pg_class r where r.relnamespace in('public'::regnamespace,'app'::regnamespace))or c.oid in(select i.indexrelid from pg_index i join pg_class t on t.oid=i.indrelid where t.oid in(select r.reltoastrelid from pg_class r where r.relnamespace in('public'::regnamespace,'app'::regnamespace)))order by c.oid`),
    sequences:Array.from(await construction`select s.seqrelid,to_jsonb(s)as details,v.last_value from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace join pg_sequences v on v.schemaname=n.nspname and v.sequencename=c.relname where n.nspname in('public','app')order by s.seqrelid`),
    extensionOwners:Array.from(await construction`select d.classid,d.objid,case when d.classid='pg_proc'::regclass then(select p.proowner from pg_proc p where p.oid=d.objid)when d.classid='pg_class'::regclass then(select c.relowner from pg_class c where c.oid=d.objid)when d.classid='pg_type'::regclass then(select t.typowner from pg_type t where t.oid=d.objid)when d.classid='pg_namespace'::regclass then(select n.nspowner from pg_namespace n where n.oid=d.objid)end as owner from pg_depend d where d.deptype='e'order by d.classid,d.objid`),
    types:Array.from(await construction`select t.oid,case when t.typowner=${normalize}::oid then ${oldOwner}::oid else t.typowner end as owner,to_jsonb(t)-'typowner'-'typacl'as details,
     (select jsonb_agg(jsonb_build_array(case when a.grantor=${normalize}::oid then ${oldOwner}::oid else a.grantor end,case when a.grantee=${normalize}::oid then ${oldOwner}::oid else a.grantee end,a.privilege_type,a.is_grantable)order by a.privilege_type,case when a.grantee=${normalize}::oid then ${oldOwner}::oid else a.grantee end,case when a.grantor=${normalize}::oid then ${oldOwner}::oid else a.grantor end)from aclexplode(coalesce(t.typacl,acldefault('T',t.typowner)))a)as acl
     from pg_type t where t.typnamespace in('public'::regnamespace,'app'::regnamespace)order by t.oid`),
    policies:Array.from(await construction`select to_jsonb(p)as details from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace in('public'::regnamespace,'app'::regnamespace)order by p.oid`),
    triggers:Array.from(await construction`select to_jsonb(t)as details from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace in('public'::regnamespace,'app'::regnamespace)order by t.oid`),
    constraints:Array.from(await construction`select to_jsonb(k)as details from pg_constraint k where k.connamespace in('public'::regnamespace,'app'::regnamespace)order by k.oid`),
    attributes:Array.from(await construction`select a.attrelid,a.attnum,to_jsonb(a)-'attacl'as details,
     (select jsonb_agg(jsonb_build_array(case when x.grantor=${normalize}::oid then ${oldOwner}::oid else x.grantor end,case when x.grantee=${normalize}::oid then ${oldOwner}::oid else x.grantee end,x.privilege_type,x.is_grantable)order by x.privilege_type,case when x.grantee=${normalize}::oid then ${oldOwner}::oid else x.grantee end,case when x.grantor=${normalize}::oid then ${oldOwner}::oid else x.grantor end)from aclexplode(a.attacl)x)as acl
     from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace in('public'::regnamespace,'app'::regnamespace)and a.attnum>0 order by a.attrelid,a.attnum`),
    indexes:Array.from(await construction`select to_jsonb(i)as details from pg_index i join pg_class c on c.oid=i.indrelid where c.relnamespace in('public'::regnamespace,'app'::regnamespace)order by i.indexrelid`),
    rules:Array.from(await construction<{details:Record<string,unknown>}[]>`select to_jsonb(r)as details from pg_rewrite r join pg_class c on c.oid=r.ev_class where c.relnamespace in('public'::regnamespace,'app'::regnamespace)order by r.oid`).map(row=>({details:{...row.details,ev_action:nodeOwner(row.details.ev_action),ev_qual:nodeOwner(row.details.ev_qual)}})),
    defaults:Array.from(await construction`select to_jsonb(d)as details from pg_attrdef d join pg_class c on c.oid=d.adrelid where c.relnamespace in('public'::regnamespace,'app'::regnamespace)order by d.oid`),
    dependencies:Array.from(await construction`select to_jsonb(d)as details from pg_depend d order by classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype`),
    sharedDependencies:Array.from(await construction`select dbid,classid,objid,objsubid,refclassid,case when refclassid='pg_authid'::regclass and refobjid=${normalize}::oid then ${oldOwner}::oid else refobjid end as refobjid,deptype from pg_shdepend where dbid=(select oid from pg_database where datname=current_database())order by classid,objid,objsubid,refclassid,case when refclassid='pg_authid'::regclass and refobjid=${normalize}::oid then ${oldOwner}::oid else refobjid end,deptype`),
    defaultPrivileges:Array.from(await construction`select to_jsonb(d)as details from pg_default_acl d order by oid`),
    securityLabels:Array.from(await construction`select to_jsonb(s)as details from pg_seclabel s order by classoid,objoid,objsubid,provider`),
    roleEdges:Array.from(await construction`select * from pg_auth_members order by roleid,member`),
   };
  }
  async function dataFacts(){
   const tables=await construction`select schemaname,tablename from pg_tables where schemaname in('public','app')order by schemaname,tablename`,result:Record<string,{count:number;sha256:string}>={};
   for(const table of tables){active();const rows=await construction.unsafe('select to_jsonb(t)as value from '+quote(table.schemaname)+'.'+quote(table.tablename)+' t order by to_jsonb(t)::text');result[table.schemaname+'.'+table.tablename]={count:rows.length,sha256:sha(JSON.stringify(rows))};}
   return result;
  }
  const before=await catalog(),beforeData=await dataFacts();
  const transfer=await construction.begin(async tx=>{
   active();expect((await tx`select current_database()as database,pg_backend_pid()as pid`)[0].database).toBe(name);
   expect((await tx`select nspowner='postgres'::regrole from pg_namespace where nspname='app'`)[0]['?column?']).toBe(true);
   await tx.unsafe('ALTER SCHEMA app OWNER TO '+quote(role));
   const relations=await tx`select c.oid,n.nspname,c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','app')and c.relowner='postgres'::regrole and c.relkind in('r','p','S','v','m','f')and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')order by case when c.relkind='S'then 1 else 0 end,c.oid`;
   for(const c of relations){active();const kind=c.relkind==='S'?'SEQUENCE':c.relkind==='v'?'VIEW':c.relkind==='m'?'MATERIALIZED VIEW':c.relkind==='f'?'FOREIGN TABLE':'TABLE';await tx.unsafe('ALTER '+kind+' '+quote(c.nspname)+'.'+quote(c.relname)+' OWNER TO '+quote(role));}
   const types=await tx`select t.oid,n.nspname,t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in('public','app')and t.typowner='postgres'::regrole and t.typtype in('e','d')and not exists(select 1 from pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e')order by t.oid`;
   for(const t of types){active();await tx.unsafe('ALTER TYPE '+quote(t.nspname)+'.'+quote(t.typname)+' OWNER TO '+quote(role));}
   const functions=await tx`select p.oid,p.prokind,format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app')and p.proowner='postgres'::regrole and p.prokind in('f','p')and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')order by p.oid`;
   for(const p of functions){active();await tx.unsafe('ALTER '+(p.prokind==='p'?'PROCEDURE':'FUNCTION')+' '+p.signature+' OWNER TO '+quote(role));}
   return{relations:Array.from(relations),types:Array.from(types),functions:Array.from(functions)};
  });
  const afterNormalized=await catalog(true);
  const comparison=accessEditorCatalogueDiagnostic(before,afterNormalized);
  const dependencyFacts=Array.from(await construction`select d.dbid,d.classid::regclass::text as class,d.classid,d.objid,d.objsubid,d.refclassid::regclass::text as reference_class,d.refclassid,d.refobjid,d.deptype,pg_describe_object(d.classid,d.objid,d.objsubid)as object_description from pg_shdepend d where d.dbid=(select oid from pg_database where datname=current_database())order by d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.deptype`);
  const [nativeFacts]=await construction`select current_user as current,session_user as session,current_database()as database,pg_backend_pid()as pid,current_setting('server_version_num')as server_version,(select jsonb_agg(jsonb_build_object('oid',r.oid::int,'name',r.rolname,'super',r.rolsuper,'bypass',r.rolbypassrls,'inherit',r.rolinherit,'login',r.rolcanlogin)order by r.oid)from pg_roles r where r.oid in(${oldOwner}::oid,${newOwner}::oid))as roles`;
  const retained=writeAccessEditorCatalogueDiagnostic(evidenceDirectory,{nativeFacts,kind:'ACTUAL_ACCESS_NATIVE_OWNER_CATALOGUE_DIAGNOSTIC_NOT_ACCEPTANCE',source:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,complete:true,releaseAuthorized:false,point:'after-owned-transfer-before-3211',oldOwner,newOwner,transfer,rawNativeSharedDependencies:dependencyFacts,...comparison});console.info('Retained Access native catalogue diagnostic',JSON.stringify(retained));
  // This original oracle remains unchanged: diagnostics cannot waive a mismatch.
  expect(afterNormalized).toEqual(before);expect(await dataFacts()).toEqual(beforeData);
  const [identity]=await native.client`select current_user as current,session_user as session,current_database()as database,r.rolsuper,r.rolinherit,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
   app.acting_as_owner()as native_owner,row_security_active('public.access_configuration'::regclass)as forced_rls,current_setting('statement_timeout')as statement_budget,current_setting('lock_timeout')as lock_budget from pg_roles r where r.rolname=current_user`;
  expect(identity).toEqual({current:role,session:role,database:name,rolsuper:false,rolinherit:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,native_owner:true,forced_rls:true,statement_budget:'20s',lock_budget:'300ms'});
  return{name,role,foreignRole,admin:construction,native,application,oldOwner,newOwner,catalog,dataFacts,transfer,identity,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Access owner component construction and cleanup failed',{cause:error});}throw error;}
}
