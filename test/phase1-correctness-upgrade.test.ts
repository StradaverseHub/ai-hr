/** Real ordinary migrator: the exact 703-entry staging predecessor, populated, then Phase 1. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const TAG='2702_phase1_notification_receipts';
it('preserves the installed ledger and historical delivery while creating least-privilege pending intent',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const boundary=journal.entries.findIndex((e:{tag:string})=>e.tag===TAG);expect(boundary).toBe(703);
 const prefix=journal.entries.slice(0,boundary);
 expect(sha(JSON.stringify(prefix))).toBe('c740a5f20ce331e9e50f9b73fdf71d04678e205b0590fd257b39c2b8554be499');
 expect(sha(JSON.stringify(prefix.map((e:{tag:string})=>[e.tag,sha(readFileSync('db/migrations/'+e.tag+'.sql'))])))).toBe('094d9a054e3da4a143930524b67c59a9b32eb0e6a30d758d7a2184bfac0a2959');
 expect(journal.entries[boundary]).toEqual({idx:2002,version:'7',when:1793330002302,tag:TAG,breakpoints:true});
 expect(sha(readFileSync('db/migrations/'+TAG+'.sql'))).toBe('65fc5542fe398d1e10c5fc76a09aec6999c50c52d76f964d69c48cf3ee6c3c26');
 const name='ai_hr_phase1_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'phase1-upgrade-'));
 const url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);expect(['localhost','127.0.0.1']).toContain(url.hostname);
 url.pathname='/postgres';const admin=postgres(url.toString(),{max:1,onnotice:()=>{}});
 url.pathname='/'+name;const storage=createDb(url.toString(),{max:1});let created=false;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const e of prefix)copyFileSync('db/migrations/'+e.tag+'.sql',join(directory,e.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));
  await migrate(storage.db,{migrationsFolder:directory});
  const [tenant]=await storage.client`insert into tenant(workos_org_id,name) values(${randomUUID()},'Fictional Phase 1 upgrade') returning id`;
  const [person]=await storage.client`insert into person(tenant_id,full_name,primary_email) values(${tenant.id},'Fictional upgrade actor','phase1@example.invalid') returning id`;
  const [user]=await storage.client`insert into app_user(tenant_id,person_id,workos_user_id) values(${tenant.id},${person.id},${randomUUID()}) returning id`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant.id},${user.id},'hr_admin')`;
  async function event(type='phase1.unmapped'){
   const id=randomUUID();const [row]=await storage.client`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload) values(${id}::uuid,${tenant.id}::uuid,'phase1-upgrade',${id}::uuid,${type},'system','{}'::jsonb) returning id,sequence`;
   return row;
  }
  const historical=await event(),pending=await event(),assessment=await event('assessment.reminder-queued');
  await storage.client`insert into notification_cursor(tenant_id,last_sequence,assessment_last_sequence) values(${tenant.id},${historical.sequence},${historical.sequence})`;
  await storage.client`insert into notification(tenant_id,recipient_user_id,kind,title,body,severity,source_event_id) values(${tenant.id},${user.id},'phase1.historical','Preserved title','Preserved body','info',${historical.id})`;
  const snapshot=async()=>({events:await storage.client`select * from domain_event order by id`,notifications:await storage.client`select * from notification order by id`,users:await storage.client`select * from app_user order by id`,roles:await storage.client`select * from role_assignment order by id`,cursors:await storage.client`select * from notification_cursor order by tenant_id`});
  const before=await snapshot(),ledgerBefore=await storage.client`select * from drizzle.__drizzle_migrations order by id`;
  expect(before.events).toHaveLength(3);expect(before.notifications).toHaveLength(1);expect(ledgerBefore).toHaveLength(boundary);
  // Reproduce broad production bootstrap defaults: the migration must explicitly revoke these.
  await storage.client`alter default privileges in schema public grant all on tables to ai_hr_app`;
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await snapshot()).toEqual(before);
  const ledger=await storage.client`select * from drizzle.__drizzle_migrations order by id`;
  expect(ledger.slice(0,boundary)).toEqual(ledgerBefore);expect(ledger).toHaveLength(journal.entries.length);
  expect(ledger[boundary].hash).toBe(sha(readFileSync('db/migrations/'+TAG+'.sql')));
  const receipts=await storage.client`select event_id,consumer,disposition from notification_event_processing order by event_id,consumer`;
  expect(receipts).toHaveLength(4);expect(receipts).toEqual(expect.arrayContaining([
   {event_id:historical.id,consumer:'notifications',disposition:'legacy-cursor'},
   {event_id:pending.id,consumer:'notifications',disposition:null},
   {event_id:assessment.id,consumer:'notifications',disposition:null},
   {event_id:assessment.id,consumer:'assessment-reminders',disposition:null},
  ]));
  expect(await storage.client`select has_table_privilege('ai_hr_app','notification_event_processing','INSERT') as append,has_table_privilege('ai_hr_app','notification_event_processing','DELETE') as remove,has_table_privilege('ai_hr_app','notification_event_processing','UPDATE') as rewrite,has_column_privilege('ai_hr_app','notification_event_processing','event_id','UPDATE') as retarget,has_column_privilege('ai_hr_app','notification_event_processing','disposition','UPDATE') as acknowledge`).toEqual([{append:false,remove:false,rewrite:false,retarget:false,acknowledge:true}]);
  const later=await event();expect(await storage.client`select disposition from notification_event_processing where event_id=${later.id}`).toEqual([{disposition:null}]);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await storage.client`select * from drizzle.__drizzle_migrations order by id`).toEqual(ledger);
  await storage.client`delete from domain_event where id=${historical.id}`;
  expect(await storage.client`select event_id from notification_event_processing where event_id=${historical.id}`).toHaveLength(0);
  expect(await storage.client`select source_event_id from notification where source_event_id=${historical.id}`).toEqual([{source_event_id:historical.id}]);
 }finally{
  await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180_000);
