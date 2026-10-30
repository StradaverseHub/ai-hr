/** WP7 (review R3): ordinary Drizzle upgrade through 0693 on owned, populated localhost databases. Never an
 * installation database. Proves existing prepared reviews survive the reference swap unchanged, and that a
 * stored review with an unregistered kind refuses the whole upgrade loudly, changing nothing. */
import {randomUUID,createHash} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';

const TAG='0813_assistant_action_kind';
type Journal={entries:{tag:string}[]};
/** A fresh database migrated to the journal prefix before 0693, populated by `populate`, then upgraded. */
async function rehearse(populate:(client:postgres.Sql)=>Promise<void>,check:(storage:ReturnType<typeof createDb>,upgrade:()=>Promise<void>,prefix:number)=>Promise<void>){
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as Journal;
 const boundary=journal.entries.findIndex(entry=>entry.tag===TAG);expect(boundary).toBeGreaterThan(560);
 const name='ai_hr_action_kind_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'assistant-action-kind-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);expect(['localhost','127.0.0.1']).toContain(ownerUrl.hostname);
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});ownerUrl.pathname='/'+name;
 const storage=createDb(ownerUrl.toString(),{max:1});let created=false;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(storage.db,{migrationsFolder:directory});
  await populate(storage.client);
  await check(storage,()=>migrate(storage.db,{migrationsFolder:'db/migrations'}),boundary);
 }finally{
  await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
}
async function fixtureTenant(client:postgres.Sql){
 const [tenant]=await client`insert into tenant(workos_org_id,name) values(${randomUUID()},'Fictional action kind upgrade tenant') returning id`;
 const [person]=await client`insert into person(tenant_id,full_name,primary_email) values(${tenant!.id},'Fictional reviewer','action-kind-upgrade@example.invalid') returning id`;
 const [user]=await client`insert into app_user(tenant_id,person_id,workos_user_id) values(${tenant!.id},${person!.id},${randomUUID()}) returning id`;
 return {tenantId:tenant!.id as string,userId:user!.id as string};
}

it('keeps existing prepared reviews unchanged and references them through validated foreign keys',async()=>{
 await rehearse(async client=>{
  const {tenantId,userId}=await fixtureTenant(client),event=randomUUID();
  await client`insert into public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${event},${tenantId},'fictional-wp7',${randomUUID()},'fictional-wp7.created','user',${userId},'{}'::jsonb)`;
  await client`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,pay_component_id,pay_component_created_event_id,created_at,expires_at)
   values(${randomUUID()},'typed_pay_components.create',${tenantId},${userId},'completed',${randomUUID()},${event},now(),now()+interval '10 minutes')`;
 },async(storage,upgrade,prefix)=>{
  const reviews=()=>storage.client`select * from app.assistant_own_leave_review order by id`;
  const before=await reviews(),ledger=await storage.client`select * from drizzle.__drizzle_migrations order by id`;
  expect(before).toHaveLength(1);expect(ledger).toHaveLength(prefix);
  await upgrade();
  expect([...await reviews()]).toEqual([...before]);
  const after=await storage.client`select * from drizzle.__drizzle_migrations order by id`;
  expect([...after].slice(0,prefix)).toEqual([...ledger]);
  expect(after[prefix]!.hash).toBe(createHash('sha256').update(readFileSync(`db/migrations/${TAG}.sql`)).digest('hex'));
  const constraints=await storage.client`select conname,convalidated from pg_constraint where conname in ('assistant_review_action_kind_registered','ai_native_outcome_association_action_registered','assistant_review_action_kind','ai_native_outcome_association_action') order by conname`;
  expect([...constraints]).toEqual([{conname:'ai_native_outcome_association_action_registered',convalidated:true},{conname:'assistant_review_action_kind_registered',convalidated:true}]);
  const [kinds]=await storage.client`select count(*)::int as n,count(review_kind)::int as reviews from app.assistant_action_kind`;
  expect(kinds).toEqual({n:AGENT_ACTIONS.length,reviews:AGENT_ACTIONS.filter(action=>action.store!=='human_workflow_only').length});
 });
},300_000);

it('refuses the upgrade loudly when a stored review names an unregistered kind, applying nothing',async()=>{
 await rehearse(async client=>{
  const {tenantId,userId}=await fixtureTenant(client);
  // Only in this throwaway database: remove the closed lists so an unknown kind can exist before 0693.
  await client.unsafe(`DO $$DECLARE c record;BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' LOOP
   EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',c.conname);END LOOP;END$$`);
  await client`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,created_at,expires_at)
   values(${randomUUID()},'legacy.unregistered',${tenantId},${userId},'discarded',now(),now()+interval '10 minutes')`;
 },async(storage,upgrade,prefix)=>{
  let failure:unknown=null;try{await upgrade();}catch(error){failure=error;}
  expect(failure).not.toBeNull();
  const message=[(failure as Error).message,String((failure as {cause?:{message?:string}}).cause?.message??'')].join(' ');
  expect(message).toContain('0693: app.assistant_own_leave_review has action kinds with no app.assistant_action_kind review row: legacy.unregistered');
  expect(await storage.client`select * from drizzle.__drizzle_migrations order by id`).toHaveLength(prefix);
  const [table]=await storage.client`select to_regclass('app.assistant_action_kind') is null as absent`;
  expect(table).toEqual({absent:true});
 });
},300_000);
