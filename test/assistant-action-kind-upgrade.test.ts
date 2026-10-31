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
// Frozen80 typed additions after the historical68-column registry prefix, traced independently
// in the populated-upgrade fixture and mapped append migrations. Never derive this from live rows.
const ADDED_REVIEW_COLUMNS={
  "allocation_effective_company_id": "uuid",
  "allocation_effective_date": "date",
  "attendance_day_dependencies": "text",
  "attendance_day_proof_version": "integer",
  "attendance_group_after": "uuid",
  "attendance_group_before": "uuid",
  "attendance_group_proof_version": "integer",
  "attendance_group_unchanged": "text",
  "bank_after_hash": "text",
  "bank_audit_preimage": "jsonb",
  "bank_before_hash": "text",
  "bank_event_payload_hash": "text",
  "bank_event_scope_hash": "text",
  "bank_retained_prepare_hash": "text",
  "bank_retained_root_xid": "xid8",
  "bank_retained_version": "integer",
  "catalogue_audit_preimage": "jsonb",
  "catalogue_native_event": "uuid",
  "catalogue_native_phase": "text",
  "catalogue_native_root": "xid8",
  "catalogue_native_tid": "tid",
  "checkin_schedule_birth_hash": "text",
  "checkin_schedule_birth_xact": "text",
  "checkin_schedule_birth_xmin": "text",
  "checkin_schedule_date": "date",
  "checkin_schedule_manager_id": "uuid",
  "checkin_schedule_planned_id": "uuid",
  "checkin_schedule_result_id": "uuid",
  "day_schedule_date": "date",
  "department_archive_desired": "boolean",
  "draft_discard_capture_xid": "xid8",
  "draft_discard_delete_witness": "jsonb",
  "draft_discard_delete_xid": "xid8",
  "draft_discard_source": "jsonb",
  "draft_discard_source_ctid": "tid",
  "draft_discard_source_xmin": "text",
  "employee_id_template_desired_status": "text",
  "offboarding_cancel_case_version": "text",
  "offboarding_cancel_effect_commitment": "text",
  "offboarding_completion_event_id": "uuid",
  "offboarding_expect_completion": "boolean",
  "offboarding_step_case_version": "text",
  "offboarding_step_effect_commitment": "text",
  "offboarding_step_key": "text",
  "offboarding_step_version": "text",
  "offboarding_undo_case_event_id": "uuid",
  "offboarding_undo_expect_reopening": "boolean",
  "offboarding_undo_step_key": "text",
  "payroll_completion_root": "jsonb",
  "payroll_reopen_batch_id": "uuid",
  "payroll_reopen_period_id": "uuid",
  "payroll_reopen_person_ids": "uuid[]",
  "payroll_reopened_event_id": "uuid",
  "payroll_reset_batch_id": "uuid",
  "payroll_reset_event_id": "uuid",
  "payroll_reset_period_id": "uuid",
  "payroll_reset_person_ids": "uuid[]",
  "payroll_reset_proof": "jsonb",
  "people_general_after_email": "boolean",
  "people_general_after_nric": "boolean",
  "people_general_before_email": "boolean",
  "people_general_before_nric": "boolean",
  "people_general_before_revision": "uuid",
  "people_general_native_revision": "uuid",
  "performance_postimage_event_id": "uuid",
  "performance_postimage_mode": "text",
  "performance_postimage_notes": "text",
  "performance_postimage_root_xid": "xid8",
  "performance_postimage_unchanged": "text",
  "performance_postimage_version": "integer",
  "position_archive_desired": "boolean",
  "rewards_calendar_cycle_id": "uuid",
  "rewards_calendar_event_id": "uuid",
  "rewards_calendar_id": "uuid",
  "rewards_calendar_revision": "integer",
  "rewards_calendar_unit_id": "uuid",
  "rewards_return_commitment": "text",
  "rewards_return_completed_xid": "xid8",
  "rewards_return_decision_id": "uuid",
  "rewards_return_snapshot": "jsonb"
} as const;
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
  const retained=await reviews(),newKeys=Object.keys(ADDED_REVIEW_COLUMNS).sort();expect(newKeys).toHaveLength(80);expect(retained).toHaveLength(before.length);
  const catalog=await storage.client<{name:string;type:string}[]>`select a.attname::text name,format_type(a.atttypid,a.atttypmod) type from pg_attribute a where a.attrelid='app.assistant_own_leave_review'::regclass and a.attnum>0 and not a.attisdropped and a.attname::text=any(${newKeys}::text[]) order by a.attname`;
  expect(Array.from(catalog).sort((a,b)=>a.name.localeCompare(b.name))).toEqual(Object.entries(ADDED_REVIEW_COLUMNS).map(([name,type])=>({name,type})).sort((a,b)=>a.name.localeCompare(b.name)));
  for(let index=0;index<before.length;index++){
   const oldRow=before[index],newRow=retained[index],oldKeys=Object.keys(oldRow).sort();expect(oldKeys).toHaveLength(68);
   expect(new Set([...oldKeys,...newKeys]).size).toBe(oldKeys.length+newKeys.length);
   expect(Object.keys(newRow).sort()).toEqual([...oldKeys,...newKeys].sort());
   for(const key of newKeys){expect(oldRow,key+' is absent before the registry migration').not.toHaveProperty(key);expect(newRow[key],key+' is an independently declared SQL NULL addition').toBeNull();}
   expect(Object.fromEntries(oldKeys.map(key=>[key,newRow[key]])),'every old value including every original NULL').toEqual(oldRow);
  }
  const after=await storage.client`select * from drizzle.__drizzle_migrations order by id`;
  expect([...after].slice(0,prefix)).toEqual([...ledger]);
  const current=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number}[]};expect(after).toHaveLength(current.entries.length);
  expect(after.map(row=>({hash:row.hash,created_at:String(row.created_at)}))).toEqual(current.entries.map(entry=>({hash:createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),created_at:String(entry.when)})));
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
