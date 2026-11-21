/** Cached native guard identity across the real migration boundary; actual held positive controls live in recovery-db. */
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {it,expect} from 'vitest';
import {createDb} from '../db/client';

it('keeps pre-upgrade prepared and PLpgSQL worker/effect callers on the strict compatibility dispatchers',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number}[]};
 const boundary=journal.entries.findIndex(entry=>entry.tag==='6399_contract_email_prerequisite_recovery');expect(boundary).toBeGreaterThan(0);
 const directory=mkdtempSync(join(tmpdir(),'contract-email-recovery-upgrade-')),name='contract_email_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});ownerUrl.pathname='/'+name;
 const storage=createDb(ownerUrl.toString(),{max:1});let created=false;
 const caseId=randomUUID(),runId=randomUUID(),eventId=randomUUID();
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));await migrate(storage.db,{migrationsFolder:directory});
  const [before]=await storage.client<{worker:string;effect:string}[]>`select 'app.contract_shared_worker_event_held(uuid,integer)'::regprocedure::oid::text as worker,'app.contract_shared_effect_held(uuid,uuid,text,text)'::regprocedure::oid::text as effect`;
  await storage.client.unsafe('PREPARE retained_worker(uuid,integer) AS select app.contract_shared_worker_event_held($1,$2) as allowed');
  await storage.client.unsafe('PREPARE retained_effect(uuid,uuid,text,text) AS select app.contract_shared_effect_held($1,$2,$3,$4) as allowed');
  await storage.client.unsafe('CREATE FUNCTION app.fixture_retained_effect(uuid,uuid,text,text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN app.contract_shared_effect_held($1,$2,$3,$4); END $$');
  const retained=async(type:string)=>(await storage.client.unsafe(`EXECUTE retained_effect('${caseId}','${runId}','actual-email','${type}')`))[0].allowed;
  expect((await storage.client.unsafe(`EXECUTE retained_worker('${caseId}',0)`))[0].allowed).toBe(false);
  expect(await retained('sendEmail')).toBe(false);expect((await storage.client`select app.fixture_retained_effect(${caseId}::uuid,${runId}::uuid,'actual-email','notify') as allowed`)[0].allowed).toBe(false);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  const [after]=await storage.client<{worker:string;effect:string;currentWorker:string;currentEffect:string;baseWorker:string;baseEffect:string}[]>`select 'app.contract_shared_worker_event_held_before_email_recovery(uuid,integer)'::regprocedure::oid::text as worker,'app.contract_shared_effect_held_before_email_recovery(uuid,uuid,text,text)'::regprocedure::oid::text as effect,'app.contract_shared_worker_event_held(uuid,integer)'::regprocedure::oid::text as "currentWorker",'app.contract_shared_effect_held(uuid,uuid,text,text)'::regprocedure::oid::text as "currentEffect",'app.contract_shared_worker_event_held_recovery_base(uuid,integer)'::regprocedure::oid::text as "baseWorker",'app.contract_shared_effect_held_recovery_base(uuid,uuid,text,text)'::regprocedure::oid::text as "baseEffect"`;
  expect(after.worker).toBe(before.worker);expect(after.effect).toBe(before.effect);expect(new Set([after.worker,after.currentWorker,after.baseWorker]).size).toBe(3);expect(new Set([after.effect,after.currentEffect,after.baseEffect]).size).toBe(3);
  await storage.client`select set_config('app.contract_event',${eventId},false)`;
  for(const type of['sendEmail','notify','generateDocument','requestApproval','createPosting','startOffboarding']){
   expect(await retained(type)).toBe(false);expect((await storage.client`select app.fixture_retained_effect(${caseId}::uuid,${runId}::uuid,'actual-email',${type}) as allowed`)[0].allowed).toBe(false);
  }
  const flags=await storage.client<{name:string;rls:boolean;forced:boolean}[]>`select relname as name,relrowsecurity as rls,relforcerowsecurity as forced from pg_class where oid in('app.contract_email_prerequisite_origin'::regclass,'app.contract_email_prerequisite_resume'::regclass,'app.contract_email_upload_observation'::regclass,'app.contract_email_upload_seen'::regclass) order by relname`;
  expect(flags).toHaveLength(4);expect(flags.every(row=>row.rls&&row.forced)).toBe(true);
  const [access]=await storage.client<{table:boolean;worker:boolean;effect:boolean}[]>`select has_table_privilege('ai_hr_app','app.contract_email_prerequisite_resume','SELECT,INSERT,UPDATE,DELETE') as table,has_function_privilege('ai_hr_app','app.contract_shared_worker_event_held_before_email_recovery(uuid,integer)','EXECUTE') as worker,has_function_privilege('ai_hr_app','app.contract_shared_effect_held_before_email_recovery(uuid,uuid,text,text)','EXECUTE') as effect`;
  expect(access).toEqual({table:false,worker:false,effect:false});
 }finally{await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});}
 // A complete prefix+forward migration rehearsal takes ~60seconds on standard hosted runners.
},180_000);
