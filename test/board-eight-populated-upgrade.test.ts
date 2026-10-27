import {expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {eq} from 'drizzle-orm';
import {createDb} from '../db/client';
import {payslip} from '../db/schema';

/** Customer-shaped synthetic data, created on the actual upstream schema before either board migration.
 * Pin the board pair at its boundary; later journaled migrations must also preserve the populated rows.
 * Owns one random scratch database in the test container. Never copies customer data or resets a shared DB. */
it('upgrades populated upstream data through both board migrations without changing existing payroll or access',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const start=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='0602_payroll_history_revisions');
 expect(start).toBeGreaterThan(0);expect(journal.entries.slice(start,start+2).map((entry:{tag:string})=>entry.tag)).toEqual(['0602_payroll_history_revisions','0603_letter_lifecycle']);
 const name='ai_hr_board_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'aihr-board-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(appUrl.hostname).toBe(ownerUrl.hostname);expect(appUrl.port).toBe(ownerUrl.port);expect(appUrl.username).toBe('ai_hr_app');expect(ownerUrl.username).not.toBe(appUrl.username);
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});let created=false;
 ownerUrl.pathname='/'+name;appUrl.pathname='/'+name;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;
  mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,start))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,start)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const tenantIds:string[]=[],slips:string[]=[],users:string[]=[];
  for(let index=0;index<2;index++){
   const [tenant]=await storage.client<{id:string}[]>`insert into tenant(workos_org_id,name) values(${randomUUID()},${'Synthetic upgrade tenant '+index}) returning id`;tenantIds.push(tenant.id);
   const [company]=await storage.client<{id:string}[]>`insert into company(tenant_id,legal_name,country,currency) values(${tenant.id},${'Synthetic upgrade employer '+index},'MY','MYR') returning id`;
   const [person]=await storage.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${tenant.id},${'Synthetic upgrade worker '+index},${'upgrade-'+index+'@example.invalid'}) returning id`;
   const [employee]=await storage.client<{id:string}[]>`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) values(${tenant.id},${person.id},${company.id},'0007','2022-01-01') returning id`;
   const [user]=await storage.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id) values(${tenant.id},${randomUUID()}) returning id`;users.push(user.id);
   await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant.id},${user.id},'hr_admin')`;
   const [period]=await storage.client<{id:string}[]>`insert into pay_period(tenant_id,company_id,period,status) values(${tenant.id},${company.id},'2023-01','closed') returning id`;
   const [batch]=await storage.client<{id:string}[]>`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,employee_count,totals) values(${tenant.id},${company.id},${period.id},'2023-01','2023-01-31','closed',1,'{"gross":5000,"net":4500}'::jsonb) returning id`;
   const [slip]=await storage.client<{id:string}[]>`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,total_deductions,net_pay,employer_cost,statutory) values(${tenant.id},${batch.id},${employee.id},5000,5000,500,4500,5600,'{"epfEmployee":500,"epfEmployer":600}'::jsonb) returning id`;slips.push(slip.id);
  }
  const tables=await storage.client<{schema:string;name:string;columns:string[]}[]>`select table_schema as schema,table_name as name,array_agg(column_name::text order by ordinal_position) as columns from information_schema.columns c where table_schema in ('public','app') and exists(select 1 from information_schema.tables t where t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE') group by table_schema,table_name having bool_or(column_name='tenant_id') or table_name='tenant' order by table_schema,table_name`;
  const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
  async function rows(table:typeof tables[number]){
   const field=table.name==='tenant'?'id':'tenant_id';
   return(await storage.client.unsafe<{row:string}[]>(`select (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(t)) where key=any($2::text[]))::text as row from ${quote(table.schema)}.${quote(table.name)} t where ${quote(field)}=any($1::uuid[]) order by 1`,[tenantIds,table.columns])).map(row=>row.row);
  }
  const before=new Map<string,string[]>();
  for(const table of tables){const data=await rows(table);if(data.length)before.set(table.schema+'.'+table.name,data);}
  expect(before.size).toBeGreaterThanOrEqual(8);
  const ledger=()=>storage.client<{hash:string;created_at:string}[]>`select hash,created_at::text as created_at from drizzle.__drizzle_migrations order by created_at,id`;
  const previous=await ledger();expect(previous).toHaveLength(start);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  const upgraded=await ledger();expect(upgraded.slice(0,start)).toEqual(previous);expect(upgraded).toHaveLength(journal.entries.length);
  expect(upgraded.slice(start).map(row=>row.hash)).toEqual(journal.entries.slice(start).map((entry:{tag:string})=>createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex')));
  for(const table of tables)if(before.has(table.schema+'.'+table.name))expect(await rows(table),table.schema+'.'+table.name).toEqual(before.get(table.schema+'.'+table.name));
  for(let index=0;index<2;index++){
   const ctx={tenantId:tenantIds[index],userId:users[index],roles:['hr_admin']};
   expect(await application.withTenant(ctx,tx=>tx.select({id:payslip.id,gross:payslip.grossPay,net:payslip.netPay}).from(payslip))).toEqual([{id:slips[index],gross:'5000.00',net:'4500.00'}]);
   expect(await application.withTenant(ctx,tx=>tx.select({id:payslip.id}).from(payslip).where(eq(payslip.id,slips[1-index])))).toEqual([]);
  }
  await expect(storage.client`update payslip set gross_pay=1 where id=${slips[0]}`).rejects.toMatchObject({code:'23514'});
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await ledger()).toEqual(upgraded);
  for(const table of tables)if(before.has(table.schema+'.'+table.name))expect(await rows(table),table.schema+'.'+table.name).toEqual(before.get(table.schema+'.'+table.name));
  console.info(JSON.stringify({kind:'BOARD_EIGHT_POPULATED_UPGRADE',baselineMigrations:start,appliedMigrations:upgraded.length-start,populatedTables:before.size,comparedRows:[...before.values()].reduce((count,rows)=>count+rows.length,0),tenants:tenantIds.length,physicalRowsUnchanged:true,appRoleIsolation:true,closedPayrollImmutable:true,idempotentMigration:true}));
 }finally{
  await application.client.end();await storage.client.end();
  if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180_000);
