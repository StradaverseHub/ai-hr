/** Ordinary journal migration over fictional legacy wording; no test-local SQL installer. */
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';

it('migrates existing assessment wording verbatim to all six locales with original history and authorship',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const start=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='0679_email_templates_r2');
 expect(start).toBeGreaterThan(0);
 const name='ai_hr_email_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'aihr-email-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});let created=false;
 ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,start))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,start)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const words={subject:'Fictional hello {first_name}',opening:'Fictional cycle {cycle}, {count} {things} waiting.'},stamp='2026-01-02T03:04:05.000Z';
  const fixtures:{tenantId:string;author:string|null;persistedStamp:string}[]=[];
  for(const knownAuthor of [true,false]){
   const [tenant]=await storage.client`insert into tenant(workos_org_id,name) values(${randomUUID()},'Fictional email upgrade tenant') returning id`;
   const [user]=await storage.client`insert into app_user(tenant_id,workos_user_id) values(${tenant.id},${randomUUID()}) returning id`;
   const author=knownAuthor?user.id as string:null;
   await storage.client`insert into tenant_setting(tenant_id,key,value,updated_by,updated_at) values(${tenant.id},'performance.reminder_words',${JSON.stringify(JSON.stringify(words))}::jsonb,${author},${stamp})`;
   // The canonical BEFORE INSERT trigger owns updated_at; witness what was persisted before upgrade.
   const [persisted]=await storage.client`select updated_at from tenant_setting where tenant_id=${tenant.id} and key='performance.reminder_words'`;
   fixtures.push({tenantId:tenant.id as string,author,persistedStamp:new Date(persisted.updated_at).toISOString()});
  }
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  for(const fixture of fixtures){
   const designs=await storage.client`select locale,revision,document,updated_by,updated_at from email_design where tenant_id=${fixture.tenantId} order by locale`;
   expect(designs.map(row=>row.locale)).toEqual(['en','ms','ta','th','vi','zh']);
   expect(designs).toHaveLength(6);
   for(const row of designs){expect(row.revision).toBe(1);expect(row.document.subject).toBe(words.subject);expect(row.document.blocks[1].runs).toEqual([{text:words.opening}]);expect(row.updated_by).toBe(fixture.author);expect(new Date(row.updated_at).toISOString()).toBe(fixture.persistedStamp);}
   const history=await storage.client`select locale,revision,document,created_by,created_at from email_design_version where tenant_id=${fixture.tenantId} order by locale`;
   expect(history).toHaveLength(6);
   for(const row of history){expect(row.revision).toBe(1);expect(row.document.subject).toBe(words.subject);expect(row.created_by).toBe(fixture.author);expect(new Date(row.created_at).toISOString()).toBe(fixture.persistedStamp);}
   const [legacy]=await storage.client`select value from tenant_setting where tenant_id=${fixture.tenantId} and key='performance.reminder_words'`;
   expect(legacy.value).toBe(JSON.stringify(words));
  }
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect((await storage.client`select count(*)::int as n from email_design_version`)[0].n).toBe(12);
 }finally{
  await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180_000);
