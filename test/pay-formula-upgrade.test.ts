/** Ordinary journal upgrades on disposable owner-created localhost databases; no fixture schema or ledger rewriting. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
const formulaTables=['pay_formula','pay_formula_revision','pay_formula_test','pay_formula_event','pay_formula_evaluation','pay_formula_accumulation'];
const nativeTables=['tenant','company','person','app_user','role_assignment','employment','compensation','pay_component','pay_period','payroll_batch','payroll_input','payslip','domain_event'];
it.each(['clean','populated'] as const)('rehearses the %s ordinary Formula Builder journal upgrade without changing Native payroll or prior receipts',async mode=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number}[]};
 const boundary=journal.entries.findIndex(entry=>entry.tag==='0741_pay_formula_builder');expect(boundary).toBeGreaterThan(0);
 const directory=mkdtempSync(join(tmpdir(),'formula-ordinary-upgrade-')),name='ai_hr_formula_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(['127.0.0.1','localhost']).toContain(appUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');expect(appUrl.username).toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});ownerUrl.pathname='/'+name;appUrl.pathname='/'+name;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});let created=false;
 const tenant=randomUUID(),company=randomUUID(),person=randomUUID(),user=randomUUID(),employment=randomUUID(),period=randomUUID(),batch=randomUUID(),slip=randomUUID(),component=randomUUID();
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 async function native(){const result:Record<string,unknown>={};for(const table of nativeTables)result[table]=await storage.client.unsafe(`select to_jsonb(t) as row from public.${table} t ${table==='tenant'?'where id=$1':'where tenant_id=$1'} order by to_jsonb(t)::text`,[tenant]);return result;}
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;let before:Record<string,unknown>|undefined,prefix:Awaited<ReturnType<typeof ledger>>|undefined;
  if(mode==='populated'){
   mkdirSync(join(directory,'meta'));for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
   writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));await migrate(storage.db,{migrationsFolder:directory});
   await storage.client`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional formula upgrade')`;
   await storage.client`insert into company(id,tenant_id,legal_name) values(${company},${tenant},'Fictional payroll owner')`;
   await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenant},'Fictional native employee','formula-upgrade@example.invalid')`;
   await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${tenant},${person},${randomUUID()})`;
   await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant},${user},'hr_admin')`;
   await storage.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on) values(${employment},${tenant},${person},${company},'FORMULA-UPGRADE-1','2025-01-01')`;
   await storage.client`insert into compensation(tenant_id,employment_id,basic_salary,currency,valid_from) values(${tenant},${employment},3000.01,'MYR','2025-01-01')`;
   await storage.client`insert into pay_component(id,tenant_id,code,name,kind,rule) values(${component},${tenant},'UPGRADE_OT','Fictional existing hourly item','earning','{"kind":"hourly","rate":1.5,"hoursPerDay":8,"ordinaryRate":26}'::jsonb)`;
   await storage.client`insert into pay_period(id,tenant_id,company_id,period,status) values(${period},${tenant},${company},'2025-01','closed')`;
   await storage.client`insert into payroll_batch(id,tenant_id,company_id,pay_period_id,pay_period,batch_date,status,employee_count,totals) values(${batch},${tenant},${company},${period},'2025-01','2025-01-31','closed',1,'{"gross":3125.51,"net":2770.01}'::jsonb)`;
   await storage.client`insert into payroll_input(tenant_id,batch_id,employment_id,overtime_amount,bonus_amount,tp1_deduction,zakat) values(${tenant},${batch},${employment},125.50,0,12.34,1.25)`;
   await storage.client`insert into payslip(id,tenant_id,batch_id,employment_id,basic_salary,gross_pay,total_deductions,net_pay,employer_cost,statutory) values(${slip},${tenant},${batch},${employment},3000.01,3125.51,355.50,2770.01,3530.51,'{"epfEmployee":330,"epfEmployer":390,"pcb":25.50}'::jsonb)`;
   before=await native();prefix=await ledger();expect(prefix).toHaveLength(boundary);expect(before.pay_component).toHaveLength(1);expect(before.payslip).toHaveLength(1);expect(before.payroll_input).toHaveLength(1);
  }
  await migrate(storage.db,{migrationsFolder:'db/migrations'});const after=await ledger();expect(after).toHaveLength(journal.entries.length);
  expect(after.map(row=>({hash:row.hash,when:row.created_at}))).toEqual(journal.entries.map(entry=>({hash:createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),when:String(entry.when)})));
  if(prefix){expect(after.slice(0,boundary)).toEqual(prefix);expect(await native()).toEqual(before);}
  for(const table of formulaTables){expect(await storage.client.unsafe(`select count(*)::int as count from public.${table}`)).toEqual([{count:0}]);
   expect(await storage.client`select has_table_privilege('ai_hr_app',${table},'SELECT') as readable,has_table_privilege('ai_hr_app',${table},'INSERT') as insertable,has_table_privilege('ai_hr_app',${table},'UPDATE') as mutable,has_table_privilege('ai_hr_app',${table},'DELETE') as deletable,has_table_privilege('ai_hr_app',${table},'TRUNCATE') as truncatable`).toEqual([{readable:true,insertable:true,mutable:false,deletable:false,truncatable:false}]);
   expect(await storage.client`select relrowsecurity from pg_class where oid=${'public.'+table}::regclass`).toEqual([{relrowsecurity:true}]);
  }
  expect(await storage.client`select has_column_privilege('ai_hr_app','pay_formula','formula_id','UPDATE') as rename,has_column_privilege('ai_hr_app','pay_formula','tenant_id','UPDATE') as retenant`).toEqual([{rename:true,retenant:false}]);
  expect(await storage.client`select has_function_privilege('ai_hr_app','app.pay_formula_active(text)','EXECUTE') as safe_accessor,not exists(select 1 from pg_proc p,lateral aclexplode(p.proacl) a where p.oid='app.pay_formula_active(text)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as public_revoked`).toEqual([{safe_accessor:true,public_revoked:true}]);
  const [accessor]=await storage.client`select pg_get_function_result('app.pay_formula_active(text)'::regprocedure) as result,prosecdef from pg_proc where oid='app.pay_formula_active(text)'::regprocedure`;
  expect(accessor.prosecdef).toBe(true);expect(accessor.result).toContain('revision_id uuid');expect(accessor.result).toContain('dependency_fingerprint text');expect(accessor.result).not.toMatch(/context|explanations|read_requirements|payload|amount/);
  // An unbound application session receives no activation metadata or private test/evaluation rows.
  expect(await application.client`select * from app.pay_formula_active('UPGRADE_OT')`).toEqual([]);
  expect(await application.client`select * from pay_formula_test`).toEqual([]);expect(await application.client`select * from pay_formula_evaluation`).toEqual([]);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await ledger()).toEqual(after);if(before)expect(await native()).toEqual(before);
 }finally{await application.client.end();await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});}
},180000);
