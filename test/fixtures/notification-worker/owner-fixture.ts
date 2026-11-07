/** One serialized test file owns the cluster-wide fixed LOGIN for both native
 * capability stages. Per-worker databases alone do not isolate PostgreSQL roles. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {expect} from 'vitest';
import {closeAll,migrateTestDb,owner} from '../../harness';
import {notificationWorkerFixtureDatabase} from './database';
type RegistryContract=readonly{eventType:string;kind:string;category:string|null;recipientPort:string|null;audience:string;guard:{field:string;equals:true;not?:true}|null;implemented:boolean}[];
type CursorGuardSnapshot={definition:string;details:unknown};
export function notificationWorkerFixtureOwner(){
 const role='ai_hr_notification_worker',password=randomUUID(),sockets=new Set<ReturnType<typeof postgres>>(),jobs=new Set<string>();
 let cursorGuard:CursorGuardSnapshot|undefined;
 let created=false,stageInstalled=false,binding:ReturnType<typeof notificationWorkerFixtureDatabase>|undefined,url:URL|undefined;
 const configured=()=>{if(!binding||!url||!created)throw Error('Owned native notification fixture is not initialized');return binding;};
 async function finishCase(){
  try{if(stageInstalled&&(await owner.client`select to_regclass('notification_worker_private.run') is not null as ready`)[0].ready)
   for(const row of await owner.client`select run_id from notification_worker_private.run`)jobs.add(row.run_id);
  }finally{const owned=[...sockets];sockets.clear();await Promise.all(owned.map(sql=>sql.end({timeout:0})));}
 }
 async function clearStage(){
  await finishCase();
  if(stageInstalled){
   if(cursorGuard){const original=cursorGuard;await owner.client.begin(async tx=>{
    await tx.unsafe(original.definition);
    await tx`drop function app.notification_worker_cursor_admitted(uuid,bigint,bigint,bigint,bigint,boolean)`;
    const [restored]=await tx`select pg_get_functiondef(p.oid) as definition,to_jsonb(p) as details from pg_proc p where p.oid='app.guard_notification_global_cursor()'::regprocedure`;
    expect(restored).toEqual(original);
   });cursorGuard=undefined;}
   await owner.client`drop schema if exists notification_worker cascade`;await owner.client`drop schema if exists notification_worker_private cascade`;
   await owner.client`delete from public.job_run where id=any(${[...jobs]}::uuid[])`;jobs.clear();stageInstalled=false;}
 }
 return {
  jobs,
  get binding(){configured();return binding!;},
  async setup(){
   if(created)throw Error('Duplicate native notification fixture owner');
   binding=notificationWorkerFixtureDatabase();await migrateTestDb();
   const [target]=await owner.client`select current_database() as database,inet_server_addr()='127.0.0.1'::inet as loopback`;
   expect(target).toEqual({database:binding.database,loopback:true});
   expect(await owner.client`select 1 from pg_roles where rolname=${role}`).toHaveLength(0);
   await owner.client.unsafe(`CREATE ROLE ai_hr_notification_worker LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);created=true;
   url=new URL(binding.migrationUrl);url.username=role;url.password=password;
  },
  async install(sources:readonly string[],version:1|2,contract?:RegistryContract){
   const target=configured();
   if(stageInstalled)throw Error('Previous native notification stage is still installed');
   let originalCursorGuard:CursorGuardSnapshot|undefined;
   await owner.client.begin(async tx=>{
    if(version!==1){
     const [existing]=await tx`select to_regprocedure('app.notification_worker_cursor_admitted(uuid,bigint,bigint,bigint,bigint,boolean)') as helper`;expect(existing.helper).toBeNull();
     const [original]=await tx`select pg_get_functiondef(p.oid) as definition,to_jsonb(p) as details from pg_proc p where p.oid='app.guard_notification_global_cursor()'::regprocedure`;
     expect(original).toBeTruthy();originalCursorGuard={definition:original.definition,details:original.details};
    }
    await tx`select set_config('aihr.notification_fixture.database',${target.database},true),set_config('aihr.notification_fixture.namespace',${target.namespace},true),set_config('aihr.notification_fixture.pool_id',${target.poolId},true)`;
    for(const source of sources)await tx.unsafe(source);
    if(contract){
     // owner.client is shared with Drizzle, which installs identity JSON
     // serializers. Bind serialized text; direct worker connections keep theirs.
     await tx`insert into notification_worker_private.registry_contract(event_type,kind,category,recipient_port,audience,guard,implemented)
      select x."eventType",x.kind,x.category,x."recipientPort",x.audience,x.guard,x.implemented from jsonb_to_recordset(${JSON.stringify(contract)}::jsonb) as x("eventType" text,kind text,category text,"recipientPort" text,audience text,guard jsonb,implemented boolean)`;
     const stored=await tx`select event_type as "eventType",kind,category,recipient_port as "recipientPort",audience,guard,implemented
      from notification_worker_private.registry_contract order by event_type collate "C",kind collate "C"`;
     const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
     expect(Array.from(stored)).toEqual([...contract].sort((a,b)=>compare(a.eventType,b.eventType)||compare(a.kind,b.kind)));
    }
   });
   cursorGuard=originalCursorGuard;stageInstalled=true;
   const [identity]=await owner.client`select current_user::regrole::oid as owner,(select oid from pg_roles where rolname=${role}) as login`;
   await owner.client`insert into notification_worker_private.authority(singleton,enabled,login_oid,owner_oid,api_version,max_batch_events,max_run_batches,max_run_seconds,max_tenants)
    values(true,true,${identity.login},${identity.owner},${version},25,10,300,100)`;
  },
  connect(){configured();const connection=postgres(url!.toString(),{max:1,connection:{statement_timeout:20000,lock_timeout:300}});sockets.add(connection);return connection;},
  finishCase,clearStage,
  async close(){try{await clearStage();if(created){await owner.client`drop owned by ai_hr_notification_worker`;await owner.client`drop role ai_hr_notification_worker`;created=false;}}
   finally{await closeAll();}},
 };
}
export type NotificationWorkerFixtureOwner=ReturnType<typeof notificationWorkerFixtureOwner>;
