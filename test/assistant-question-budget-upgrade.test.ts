/** Ordinary Drizzle upgrade on an owned populated localhost database. Never an installation database. */
import {randomUUID,createHash} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
it('preserves existing questions, grants, budget and usage through the ordinary Assistant quota upgrade',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const boundary=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='0687_assistant_question_budget');
 expect(boundary).toBe(562);
 const name='ai_hr_question_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'assistant-question-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['localhost','127.0.0.1']).toContain(ownerUrl.hostname);expect(['localhost','127.0.0.1']).toContain(appUrl.hostname);expect(appUrl.username).toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+name;appUrl.pathname='/'+name;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});let created=false;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const [tenant]=await storage.client`insert into tenant(workos_org_id,name) values(${randomUUID()},'Fictional question upgrade tenant') returning id`;
  const [person]=await storage.client`insert into person(tenant_id,full_name,primary_email) values(${tenant.id},'Fictional quota user','quota-upgrade@example.invalid') returning id`;
  const [user]=await storage.client`insert into app_user(tenant_id,person_id,workos_user_id) values(${tenant.id},${person.id},${randomUUID()}) returning id`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant.id},${user.id},'hr_admin')`;
  await storage.client`insert into assistant_grant(tenant_id,app_user_id,granted_by_user_id) values(${tenant.id},${user.id},${user.id})`;
  const [clock]=await storage.client`select (now() at time zone 'Asia/Kuala_Lumpur')::date::text as day,to_char(now() at time zone 'Asia/Kuala_Lumpur','YYYY-MM') as period`;
  await storage.client`insert into assistant_budget(tenant_id,monthly_token_ceiling,per_user_daily_questions,effective_from) values(${tenant.id},1000000,1,${clock.day})`;
  await storage.client`insert into assistant_usage(tenant_id,period,input_tokens,output_tokens,cached_input_tokens,exchange_count) values(${tenant.id},${clock.period},11,7,2,1)`;
  await storage.client`insert into assistant_exchange(tenant_id,app_user_id,question,tool_calls,content_retired_at,input_tokens,output_tokens,cached_input_tokens) values(${tenant.id},${user.id},'','[]'::jsonb,now(),11,7,2)`;
  const snapshot=async()=>({
   exchanges:await storage.client`select * from assistant_exchange order by id`,usage:await storage.client`select * from assistant_usage order by id`,
   budgets:await storage.client`select * from assistant_budget order by id`,grants:await storage.client`select * from assistant_grant order by id`,
   users:await storage.client`select * from app_user order by id`,roles:await storage.client`select * from role_assignment order by id`,
  });
  const before=await snapshot(),prefix=await storage.client`select * from drizzle.__drizzle_migrations order by id`;
  expect(before.exchanges).toHaveLength(1);expect(before.usage).toHaveLength(1);expect(prefix).toHaveLength(562);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await snapshot()).toEqual(before);expect(await storage.client`select * from app.assistant_question_budget`).toEqual([]);
  const ledger=await storage.client`select * from drizzle.__drizzle_migrations order by id`;
  expect(ledger.slice(0,prefix.length)).toEqual(prefix);expect(ledger).toHaveLength(journal.entries.length);
  expect(ledger[prefix.length].hash).toBe(createHash('sha256').update(readFileSync('db/migrations/0687_assistant_question_budget.sql')).digest('hex'));
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await storage.client`select * from drizzle.__drizzle_migrations order by id`).toEqual(ledger);
  const ctx={tenantId:tenant.id,userId:user.id,personId:person.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  await expect(application.withTenant(ctx,async tx=>{
   const [permissions]=await tx.execute(sql`select current_user as db_role,app.principal_snapshot_current() as current,
    has_table_privilege(current_user,'app.assistant_question_budget','SELECT') as table_read,
    has_function_privilege(current_user,'app.assistant_question_budget_reserve(uuid)','EXECUTE') as reserve`);
   expect(permissions).toMatchObject({db_role:'ai_hr_app',current:true,table_read:false,reserve:true});
   const [issued]=await tx.execute<{root_id:string}>(sql`select app.ai_spend_task_issue('hr_assistant','assistant_question',null,'question') as root_id`);
   const [quota]=await tx.execute(sql`select * from app.assistant_question_budget_reserve(${issued.root_id}::uuid)`);
   expect(quota).toMatchObject({blocked_reason:'budget_daily',period:clock.period});
   throw Error('ROLLBACK_QUOTA_FIXTURE');
  })).rejects.toThrow('ROLLBACK_QUOTA_FIXTURE');
  expect(await snapshot()).toEqual(before);expect(await storage.client`select * from app.assistant_question_budget`).toEqual([]);
 }finally{
  await application.client.end();await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180_000);
