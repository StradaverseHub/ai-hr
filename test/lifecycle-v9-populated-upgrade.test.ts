/** Ordinary journal rehearsal against an owned populated pre-V9 database. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';

it('preserves populated Native issuance, private data, identity and every applied receipt through the ordinary V9 upgrade',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const boundary=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='0713_lifecycle_v9');
 expect(boundary).toBe(569);expect(journal.entries.slice(boundary)).toHaveLength(8);
 const directory=mkdtempSync(join(tmpdir(),'v9-ordinary-upgrade-')),name='ai_hr_v9_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});let created=false;
 const tenant=randomUUID(),company=randomUUID(),person=randomUUID(),user=randomUUID(),employment=randomUUID(),caseId=randomUUID();
 const native={version:1,id:caseId,number:'OB-UPGRADE-0001',state:'submitted',source:{fullName:'Fictional upgrade employee',company,joinDate:'2026-01-01'},tasks:[{id:'historic-task',status:'done'}],requisitions:[{id:'historic-request',handedAt:'2026-01-01T01:00:00Z',items:[{id:'historic-device',name:'Fictional issued device',state:'handed',employeeReceipt:{status:'received',by:user,at:'2026-01-01T02:00:00Z',note:'Retain this receipt'}}]}],history:[{id:'historic-handover',action:'requisition.handed',by:user}]};
 const tables=['person','app_user','role_assignment','employment','lc_onboarding_config','lc_onboarding_case','lc_onboarding_private','lc_onboarding_case_revision','lc_onboarding_note','domain_event'];
 async function original(){const rows:Record<string,unknown>={};for(const table of tables)rows[table]=await storage.client.unsafe(`select to_jsonb(t) as row from public.${table} t where tenant_id=$1 order by to_jsonb(t)::text`,[tenant]);return rows;}
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(storage.db,{migrationsFolder:directory});
  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional V9 upgrade')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${company},${tenant},'Fictional employer')`;
  await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenant},'Fictional upgrade employee','v9-upgrade@example.invalid')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${tenant},${person},${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant},${user},'hr_admin')`;
  await storage.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on) values(${employment},${tenant},${person},${company},'V9-UPGRADE-001','2026-01-01')`;
  await storage.client`insert into lc_onboarding_config(tenant_id,data) values(${tenant},${JSON.stringify({version:1,groups:[{id:'historic-team',name:'Fictional issuing team',members:[user],limit:8}],access:{onboarding:[user],offboarding:[]}})}::jsonb)`;
  await storage.client`insert into lc_onboarding_case(id,tenant_id,company_id,employment_id,data) values(${caseId},${tenant},${company},${employment},${JSON.stringify(native)}::jsonb)`;
  await storage.client`insert into lc_onboarding_private(case_id,tenant_id,company_id,data) values(${caseId},${tenant},${company},${JSON.stringify({source:{ic:'FICTIONAL-PRIVATE-ID'},local:{},retained:'original private data'})}::jsonb)`;
  await storage.client`insert into lc_onboarding_case_revision(case_id,tenant_id,company_id,revision,data) values(${caseId},${tenant},${company},1,${JSON.stringify(native)}::jsonb)`;
  await storage.client`insert into lc_onboarding_note(tenant_id,case_id,data) values(${tenant},${caseId},${JSON.stringify({context:'case',body:'Retain original note',by:user,mentions:[],deleted:false})}::jsonb)`;
  const before=await original(),prefix=await ledger();expect(prefix).toHaveLength(boundary);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await original()).toEqual(before);
  const after=await ledger();expect(after.slice(0,boundary)).toEqual(prefix);expect(after).toHaveLength(journal.entries.length);
  expect(after.slice(boundary).map(row=>({hash:row.hash,when:row.created_at}))).toEqual(journal.entries.slice(boundary).map((entry:{tag:string;when:number})=>({hash:createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),when:String(entry.when)})));
  expect(await storage.client`select count(*)::int as count from lc_v9_case`).toEqual([{count:0}]);
  expect(await storage.client`select to_regnamespace('v9_test_fixture') as fixture,has_function_privilege('ai_hr_app','app.lc_v9_assigned_item(uuid,integer,text)','EXECUTE') as assigned`).toEqual([{fixture:null,assigned:true}]);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await ledger()).toEqual(after);expect(await original()).toEqual(before);
 }finally{await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});}
},180000);
