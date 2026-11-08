/** Fixed disposable pre-migration allocation only. No caller SQL/object/count,
 * public capability, live install, expected profile or worker activation. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {catalogueReplayMode,CATALOGUE_REPLAY_SOURCES,validateCatalogueReplayReceipt,catalogueReplayRoleHash} from '../../../.github/ci/notification-catalogue-replay.mjs';
import {nativePreparationEnvironment} from '../../../.github/ci/candidate-environment.mjs';
import type {FullCiRoleAdmission} from '../../../scripts/lib/discard-premigration';
import {assertDisposableDraftDiscardFixture,readDraftDiscardRoleCatalog,assertDraftDiscardRoleCatalog} from '../../helpers/personnel-draft-discard-ci-role-fixture';
import {nativeInventoryCanonical} from './canonical-inventory';
import {ownCatalogueReplayPrefix} from './replay-prefix-ownership';
const digest=(value:unknown)=>createHash('sha256').update(nativeInventoryCanonical(value)).digest('hex');
const oid=(value:unknown)=>{assert(typeof value==='string'&&/^[1-9][0-9]{0,9}$/.test(value));const n=Number(value);assert(Number.isSafeInteger(n)&&n>=16384&&n<=4294967295);return n;};
const objectQuery=`with objects as (
 select 'pg_namespace'::regclass::oid as classid,n.oid as objid,0 as objsubid,to_jsonb(n) as raw,'namespace'::text as kind from pg_namespace n where n.nspname='aihr_catalogue_replay_private'
 union all select 'pg_type'::regclass::oid,t.oid,0,to_jsonb(t),'type' from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='aihr_catalogue_replay_private'
 union all select 'pg_class'::regclass::oid,c.oid,0,to_jsonb(c),'relation' from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='aihr_catalogue_replay_private'
 union all select 'pg_attribute'::regclass::oid,a.attrelid,a.attnum,to_jsonb(a),'attribute' from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='aihr_catalogue_replay_private'
 union all select 'pg_enum'::regclass::oid,e.oid,0,to_jsonb(e),'enum' from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='aihr_catalogue_replay_private'
), edges as(select to_jsonb(d) as raw from pg_depend d where exists(select 1 from objects o where (d.classid=o.classid and d.objid=o.objid) or(d.refclassid=o.classid and d.refobjid=o.objid))), shared as(select to_jsonb(d) as raw from pg_shdepend d where d.dbid=(select oid from pg_database where datname=current_database()) and exists(select 1 from objects o where d.classid=o.classid and d.objid=o.objid))
select coalesce((select jsonb_agg(to_jsonb(o) order by kind,classid,objid,objsubid) from objects o),'[]'::jsonb) as objects,
 coalesce((select jsonb_agg(raw order by raw::text) from edges),'[]'::jsonb) as dependencies,
 coalesce((select jsonb_agg(raw order by raw::text) from shared),'[]'::jsonb) as shared`;
function guardedSql<T extends object>(client:T,active:()=>void):T{
 const pending=(value:unknown)=>value&&typeof value==='object'?new Proxy(value,{get(target,key){const member=Reflect.get(target,key,target);if(key!=='then'||typeof member!=='function')return member;return(...args:unknown[])=>{active();return Reflect.apply(member,target,args);};}}):value;
 return new Proxy(client,{apply(target,self,args){active();assert(typeof target==='function');return pending(Reflect.apply(target,self,args));},get(target,key){const member=Reflect.get(target,key,target);if(key==='unsafe'&&typeof member==='function')return(...args:unknown[])=>{active();return pending(Reflect.apply(member,target,args));};if(['begin','savepoint','reserve','notify','file'].includes(String(key)))throw Error('Unowned replay prefix SQL carrier refused');return member;}});
}
export async function prepareNotificationCatalogueReplay(admission:FullCiRoleAdmission){
 assertDisposableDraftDiscardFixture(admission.admin,admission.binding);
 const mode=catalogueReplayMode(admission.binding.batchFiles);assert(mode,'Actual sole catalogue replay required');
 const url=new URL(admission.admin);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');assert.equal(url.pathname,'/postgres');assert.equal(url.username,'postgres');assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');
 const sourceHashes=Object.fromEntries(Object.entries(CATALOGUE_REPLAY_SOURCES).map(([key,path])=>{
  const bytes=readFileSync(path);assert(bytes.length>0&&bytes.length<=4*1024*1024);
  const committed=execFileSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','show','HEAD:'+path],{env:nativePreparationEnvironment(process.env),maxBuffer:4*1024*1024});assert(bytes.equals(committed));
  return[key,createHash('sha256').update(bytes).digest('hex')];
 }));
 const connection=postgres(admission.admin,{max:1,connect_timeout:2,idle_timeout:2,onnotice:()=>{},connection:{application_name:'aihr-catalogue-replay-prerequisite',statement_timeout:'20s',lock_timeout:'300ms',search_path:'pg_catalog'}});
 let observer:ReturnType<typeof postgres>|undefined,observerClose:Promise<void>|undefined,closeWork:Promise<void>|undefined;
 let identity:{pid:number;backendStart:string;postmasterStart:string}|undefined,draft:Record<string,unknown>|undefined;
 const close=()=>closeWork??=connection.end({timeout:0});
 const closeObserver=()=>observer?(observerClose??=observer.end({timeout:0})):Promise.resolve();
 const result=await ownCatalogueReplayPrefix((active,callback)=>connection.begin(raw=>callback(async()=>{
  const tx=guardedSql(raw,active);
  const [session]=await tx<{database:string;pid:number;backendStart:string;postmasterStart:string;versionNumber:number;versionText:string;session:string;current:string;loopback:boolean}[]>`select current_database()as database,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as "backendStart",
   to_char(pg_postmaster_start_time() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')as "postmasterStart",current_setting('server_version_num')::int as "versionNumber",version()as "versionText",session_user::text as session,current_user::text as current,inet_server_addr()='127.0.0.1'::inet as loopback`;
  assert(session);identity={pid:session.pid,backendStart:session.backendStart,postmasterStart:session.postmasterStart};assert.equal(session.database,'postgres');assert.equal(session.session,'postgres');assert.equal(session.current,'postgres');assert.equal(session.loopback,true);
  const roles=await readDraftDiscardRoleCatalog(tx);assertDraftDiscardRoleCatalog(roles);
  const [initial]=await tx.unsafe<{objects:unknown[];dependencies:unknown[];shared:unknown[]}[]>(objectQuery);assert(initial);assert.deepEqual(initial,{objects:[],dependencies:[],shared:[]});
  let allocation:unknown=null;
  if(mode==='oid-shift'){
   await tx.unsafe('create schema aihr_catalogue_replay_private authorization postgres');
   await tx.unsafe('revoke all on schema aihr_catalogue_replay_private from public,ai_hr_app,ai_hr_owner,ai_hr_draft_discard_port');
   await tx.unsafe("create type aihr_catalogue_replay_private.replay_enum as enum ('fixed-ci-only')");
   await tx.unsafe('revoke all on type aihr_catalogue_replay_private.replay_enum from public,ai_hr_app,ai_hr_owner,ai_hr_draft_discard_port');
   await tx.unsafe('create table aihr_catalogue_replay_private.replay_heap(id bigint, value aihr_catalogue_replay_private.replay_enum)');
   await tx.unsafe('revoke all on aihr_catalogue_replay_private.replay_heap from public,ai_hr_app,ai_hr_owner,ai_hr_draft_discard_port');
   const [ids]=await tx<{namespaceOid:string;enumOid:string;enumArrayOid:string;heapOid:string;rowTypeOid:string;rowArrayOid:string;closed:boolean}[]>`select n.oid::text as "namespaceOid",e.oid::text as "enumOid",e.typarray::text as "enumArrayOid",c.oid::text as "heapOid",r.oid::text as "rowTypeOid",r.typarray::text as "rowArrayOid",
    n.nspowner='postgres'::regrole and e.typowner=n.nspowner and r.typowner=n.nspowner and c.relowner=n.nspowner and c.relkind='r' and c.relpersistence='p' and c.relrowsecurity=false and c.relforcerowsecurity=false
    and (select count(*)=1 from pg_class k where k.relnamespace=n.oid)
    and (select count(*)=4 from pg_type t where t.typnamespace=n.oid)
    and not exists(select 1 from pg_proc p where p.pronamespace=n.oid)
    and not exists(select 1 from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a where a.grantee<>n.nspowner or a.grantor<>n.nspowner or a.is_grantable)
    and not exists(select 1 from aclexplode(coalesce(e.typacl,acldefault('T',e.typowner)))a where a.grantee<>e.typowner or a.grantor<>e.typowner or a.is_grantable)
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a where a.grantee<>c.relowner or a.grantor<>c.relowner or a.is_grantable)
    as closed
    from pg_namespace n join pg_type e on e.typnamespace=n.oid and e.typname='replay_enum'
    join pg_class c on c.relnamespace=n.oid and c.relname='replay_heap' join pg_type r on r.oid=c.reltype
    where n.nspname='aihr_catalogue_replay_private'`;
   assert(ids?.closed,'Exact private allocation ownership/shape/ACL required');
   const [witness]=await tx.unsafe<{objects:unknown[];dependencies:unknown[];shared:unknown[]}[]>(objectQuery);assert(witness);assert(witness.objects.length>0&&witness.dependencies.length>0);
   allocation={namespaceOid:oid(ids.namespaceOid),enumOid:oid(ids.enumOid),enumArrayOid:oid(ids.enumArrayOid),heapOid:oid(ids.heapOid),rowTypeOid:oid(ids.rowTypeOid),rowArrayOid:oid(ids.rowArrayOid),nativeRowsSha256:digest(witness.objects),dependenciesSha256:digest({dependencies:witness.dependencies,shared:witness.shared}),facts:witness};
   // Same transaction owns all created objects. Re-read full native incident
   // facts immediately before the closed RESTRICT drop sequence, never CASCADE.
   const [again]=await tx.unsafe(objectQuery);assert.equal(nativeInventoryCanonical(again),nativeInventoryCanonical(witness));
   await tx.unsafe('drop table aihr_catalogue_replay_private.replay_heap restrict');
   await tx.unsafe('drop type aihr_catalogue_replay_private.replay_enum restrict');
   await tx.unsafe('drop schema aihr_catalogue_replay_private restrict');
  }
  const [final]=await tx.unsafe(objectQuery);assert.deepEqual(final,initial);
  const after=await readDraftDiscardRoleCatalog(tx);assertDraftDiscardRoleCatalog(after);assert.equal(nativeInventoryCanonical(after),nativeInventoryCanonical(roles));
  const receipt={version:1,kind:'NATIVE_CATALOGUE_REPLAY_PREREQUISITE_NOT_PROFILE',mode,...Object.fromEntries(['candidate','controller','runId','attempt','unit','planFingerprint'].map(key=>[key,Reflect.get(admission.binding,key)])),sourceHashes,session,roleCatalogSha256:catalogueReplayRoleHash(roles),allocation,objectsAbsent:true,releaseAuthorized:false};
  assert(Buffer.byteLength(JSON.stringify(receipt,null,2)+'\n')<=32768);draft=receipt;return receipt;
 })),close,async active=>{
  assert(identity,'Native replay backend identity missing');active();
  observer=postgres(admission.admin,{max:1,connect_timeout:2,idle_timeout:2,onnotice:()=>{},connection:{application_name:'aihr-catalogue-replay-absence',statement_timeout:'20s',lock_timeout:'300ms',search_path:'pg_catalog',default_transaction_read_only:'on'}});active();
  for(;;){
   active();const [proof]=await observer<{sameCluster:boolean;ownedPresent:boolean;observerPid:number;observerStart:string;observedAt:string;postmasterStart:string}[]>`select current_database()='postgres' and session_user='postgres' and current_user='postgres' and inet_server_addr()='127.0.0.1'::inet and current_setting('transaction_read_only')='on' and current_setting('statement_timeout')='20s' and current_setting('lock_timeout')='300ms'
    and to_char(pg_postmaster_start_time() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=${identity.postmasterStart} as "sameCluster",
    exists(select 1 from pg_stat_activity where pid=${identity.pid} and backend_start::text=${identity.backendStart})as "ownedPresent",pg_backend_pid()as "observerPid",(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as "observerStart",clock_timestamp()::text as "observedAt",to_char(pg_postmaster_start_time() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')as "postmasterStart"`;
   active();assert(proof?.sameCluster,'Replay absence observation changed native cluster');if(!proof.ownedPresent){assert(draft);Object.assign(draft,{quiescence:proof});assert(Buffer.byteLength(JSON.stringify(draft,null,2)+'\n')<=32768);validateCatalogueReplayReceipt(draft,admission.binding,sourceHashes);active();break;}await new Promise(resolve=>setTimeout(resolve,20));
  }
 },undefined,closeObserver);
 return result;
}
