/** Real populated prefix before5925; ordinary migrator, exact retained rows, no old SQL edit or live database. */
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
import {seedCatalogs} from '../scripts/seed-catalogs';
import {withoutCombinedReleaseNulls} from './helpers/approved-upgrade';
it('retains populated document heads and version bytes with null tombstones and an empty default note',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number}[]};
 const boundary=journal.entries.findIndex(entry=>entry.tag==='5925_contract_template_lifecycle');expect(boundary).toBeGreaterThan(0);
 const directory=mkdtempSync(join(tmpdir(),'document-lifecycle-upgrade-')),name='document_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});let created=false;
 const tenant=randomUUID(),person=randomUUID(),user=randomUUID();
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));await migrate(storage.db,{migrationsFolder:directory});await seedCatalogs(storage.db);
  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional retained document tenant')`;
  await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenant},'Fictional retained author','retained-author@upgrade.invalid')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${tenant},${person},${randomUUID()})`;
  for(const module of ['contract_staff','probation']){
   const template=randomUUID(),definition={id:template,module,name:'Retained '+module,description:'Original fictional bytes',rules:{},blocks:[{id:'intro',type:'text',text:'Fictional retained wording',section:''}],fields:[],routing:[]};
   await storage.client`insert into automation_document_template(tenant_id,id,module,name,revision,retired) values(${tenant},${template},${module},${definition.name},1,false)`;
   await storage.client`insert into automation_document_template_version(tenant_id,template_id,version,definition,saved_by) values(${tenant},${template},1,${JSON.stringify(definition)}::jsonb,${user})`;
   await storage.client`update automation_document_template set live_version=1 where tenant_id=${tenant} and id=${template}`;
  }
  const beforeHeads=await storage.client`select to_jsonb(h) as row from automation_document_template h where tenant_id=${tenant} order by id`,beforeVersions=await storage.client`select to_jsonb(v) as row from automation_document_template_version v where tenant_id=${tenant} order by template_id,version`;
  expect(beforeHeads).toHaveLength(2);expect(beforeVersions).toHaveLength(2);expect(beforeVersions.every(v=>!Object.hasOwn(v.row,'note')&&!Object.hasOwn(v.row,'deleted_at'))).toBe(true);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  const heads=await storage.client`select to_jsonb(h) as row from automation_document_template h where tenant_id=${tenant} order by id`,versions=await storage.client`select to_jsonb(v) as row from automation_document_template_version v where tenant_id=${tenant} order by template_id,version`;
  for(const h of heads)expect(h.row.deleted_at).toBeNull();for(const v of versions){expect(v.row.deleted_at).toBeNull();expect(v.row.note).toBe('');}
  expect(heads.map(h=>({row:withoutCombinedReleaseNulls('automation_document_template',h.row)}))).toEqual(beforeHeads);
  expect(versions.map(v=>({row:withoutCombinedReleaseNulls('automation_document_template_version',v.row)}))).toEqual(beforeVersions);
  const columns=await storage.client`select table_name,column_name,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('automation_document_template','automation_document_template_version') and column_name in ('deleted_at','note') order by table_name,column_name`;
  expect(columns).toMatchObject([{table_name:'automation_document_template',column_name:'deleted_at',is_nullable:'YES',column_default:null},{table_name:'automation_document_template_version',column_name:'deleted_at',is_nullable:'YES',column_default:null},{table_name:'automation_document_template_version',column_name:'note',is_nullable:'NO',column_default:"''::text"}]);
 }finally{await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});}
},180000);
