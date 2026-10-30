/** Ordinary journal upgrade of an owned populated localhost database. No application data is reconstructed. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
it('preserves populated closed payroll and the complete applied prefix through the ordinary correction upgrade',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const boundary=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='0698_information_only_corrections');expect(boundary).toBe(567);
 const directory=mkdtempSync(join(tmpdir(),'information-correction-upgrade-')),name='ai_hr_info_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(['127.0.0.1','localhost']).toContain(appUrl.hostname);expect(appUrl.username).toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});ownerUrl.pathname='/'+name;appUrl.pathname='/'+name;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});let created=false;
 const t=randomUUID(),co=randomUUID(),p=randomUUID(),u=randomUUID(),e=randomUUID(),d=randomUUID(),pp=randomUUID(),batch=randomUUID(),slip=randomUUID();
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(storage.db,{migrationsFolder:directory});
  await storage.client`insert into tenant(id,workos_org_id,name) values(${t},${randomUUID()},'Fictional correction upgrade')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${co},${t},'Fictional employer')`;
  await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${p},${t},'Fictional employee','correction-upgrade@example.invalid')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${u},${t},${p},${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${t},${u},'hr_admin')`;
  await storage.client`insert into department(id,tenant_id,company_id,name) values(${d},${t},${co},'Fictional department')`;
  await storage.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on) values(${e},${t},${p},${co},'UPGRADE-001','2025-01-01')`;
  await storage.client`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from) values(${t},${e},${co},${d},'full_time','2025-01-01')`;
  await storage.client`insert into pay_period(id,tenant_id,company_id,period,status) values(${pp},${t},${co},'2025-01','closed')`;
  await storage.client`insert into payroll_batch(id,tenant_id,company_id,pay_period_id,pay_period,batch_date,status) values(${batch},${t},${co},${pp},'2025-01','2025-01-25','closed')`;
  await storage.client`insert into payslip(id,tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost) values(${slip},${t},${batch},${e},3000,3000,'{"epfEmployee":330,"epfEmployer":390}'::jsonb,330,2670,3390)`;
  const tables=['employment','assignment','pay_period','payroll_batch','payslip','role_assignment','domain_event'];
  async function original(){const rows:Record<string,unknown>={};for(const table of tables)rows[table]=await storage.client.unsafe(`select to_jsonb(t) as row from ${table} t where tenant_id=$1 order by to_jsonb(t)::text`,[t]);return rows;}
  const before=await original(),prefix=await storage.client`select id,hash,created_at from drizzle.__drizzle_migrations order by id`;
  expect(prefix).toHaveLength(boundary);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await original()).toEqual(before);expect(await storage.client`select * from information_payslip_snapshot`).toHaveLength(0);
  const receipts=await storage.client`select id,hash,created_at from drizzle.__drizzle_migrations order by id`;
  expect(receipts.slice(0,prefix.length)).toEqual(prefix);expect(receipts).toHaveLength(journal.entries.length);
  // Later ordinary migrations may follow the correction; its own receipt stays at the known boundary.
  expect(receipts[boundary]!.hash).toBe(createHash('sha256').update(readFileSync('db/migrations/0698_information_only_corrections.sql')).digest('hex'));
  expect(receipts.slice(boundary).map(row=>({hash:row.hash,when:String(row.created_at)}))).toEqual(
   journal.entries.slice(boundary).map((entry:{tag:string;when:number})=>({hash:createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),when:String(entry.when)})));
  const ctx={tenantId:t,userId:u,personId:p,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  await application.withTenant(ctx,async tx=>{const [principal]=await tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`);expect(principal.current).toBe(true);const [result]=await tx.execute<{count:number}>(sql`select app.preserve_information_payroll(${e}::uuid) as count`);expect(result.count).toBe(1);});
  expect(await storage.client`select payslip_id,employment_type,grade,hired_on::text from information_payslip_snapshot`).toEqual([{payslip_id:slip,employment_type:'full_time',grade:null,hired_on:'2025-01-01'}]);
  expect(await original()).toEqual(before);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await storage.client`select id,hash,created_at from drizzle.__drizzle_migrations order by id`).toEqual(receipts);
 }finally{await application.client.end();await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});}
},180000);
