/** Hosted populated-prefix proof: cached target/start callers retain the canonical capability OID. No SMTP. */
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
import {seedCatalogs} from '../scripts/seed-catalogs';
it('keeps prepared target and cached start callers on the native capability after the test-purpose upgrade',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number}[]};
 const boundary=journal.entries.findIndex(entry=>entry.tag==='6336_automation_email_test_self');expect(boundary).toBeGreaterThan(0);
 const directory=mkdtempSync(join(tmpdir(),'automation-test-upgrade-')),name='automation_test_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(appUrl.username).toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});ownerUrl.pathname='/'+name;appUrl.pathname='/'+name;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});let created=false;
 const tenant=randomUUID(),company=randomUUID(),person=randomUUID(),user=randomUUID(),template=randomUUID(),delivery=randomUUID(),token=randomUUID(),origin='https://upgrade-test.invalid';
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));await migrate(storage.db,{migrationsFolder:directory});
  await seedCatalogs(storage.db);
  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional template upgrade')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${company},${tenant},'Fictional retained company')`;
  await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenant},'Fictional retained editor','retained-editor@upgrade.invalid')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${tenant},${person},${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant},${user},'hr_admin')`;
  await storage.client`insert into tenant_module(tenant_id,module_code,status) values(${tenant},'lifecycle','active')`;
  await storage.client`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+tenant},${randomUUID()},${user})`;
  await storage.client`insert into automation_email_template_version(tenant_id,template_id,revision,module,name,active,subject,body,cc,reason,saved_by) values(${tenant},${template},1,'contract_staff','Retained template',true,'Retained subject','Retained body','[]'::jsonb,'Fictional source',${user})`;
  const before=await storage.client`select to_jsonb(v) as row from automation_email_template_version v where tenant_id=${tenant}`;
  const [old]=await storage.client`select 'app.automation_email_target(uuid,uuid,text)'::regprocedure::oid::text as oid`;
  await storage.client.unsafe('PREPARE retained_target(uuid,uuid,text) AS select app.automation_email_target($1,$2,$3) as target');
  await storage.client.unsafe(`EXECUTE retained_target('${delivery}','${token}','${origin}')`);
  expect((await storage.client`select app.automation_email_start(${delivery},${token},${origin},'{}'::jsonb) as ok`)[0].ok).toBe(false);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect((await storage.client`select 'app.automation_email_target(uuid,uuid,text)'::regprocedure::oid::text as oid`)[0].oid).toBe(old.oid);
  expect(await storage.client`select to_jsonb(v) as row from automation_email_template_version v where tenant_id=${tenant}`).toEqual(before);
  const queued=await application.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${tenant},true),set_config('app.user_id',${user},true)`;
   return (await tx`select app.automation_email_test_queue(${template},1,${randomUUID()},'Retained test','{}'::jsonb) as id`)[0].id as string;
  });
  await storage.client`update automation_email_delivery set status='leased',lease_token=${token},lease_until=now()+interval '3 minutes' where id=${queued}`;
  const [view]=await storage.client.unsafe(`EXECUTE retained_target('${queued}','${token}','${origin}')`);expect(view.target?.payload?.purpose).toBe('templateTest');
  const proof={bindings:view.target.bindings,addresses:['retained-editor@upgrade.invalid'],relayRevision:'fixture'};
  expect((await storage.client`select app.automation_email_start(${queued},${token},${origin},${JSON.stringify(proof)}::jsonb) as ok`)[0].ok).toBe(true);
  expect((await storage.client.unsafe(`EXECUTE retained_target('${queued}','${token}','${origin}')`))[0].target).toBeNull();
 }finally{await application.client.end();await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});}
 // Existing populated-prefix rehearsals use a 180-second budget for a complete migration chain (~60 s hosted).
},180000);
