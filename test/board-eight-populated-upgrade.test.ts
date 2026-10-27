import {expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {eq,sql} from 'drizzle-orm';
import {createDb} from '../db/client';
import {payslip} from '../db/schema';

/** Authored changed-input upgrade witness: the real schema up to the board pair, then every later journaled
 * migration (board pair, Reports/P1, the forwarded AI entries and the AI groups). Pin the board pair at its
 * boundary; later journaled migrations may follow and must also preserve the populated rows and access.
 * Owner-created fictional rows prove physical preservation, NOT canonical business effect/AI confirmation
 * provenance. Normal Drizzle migrators only; no test-local function installer, customer data or shared reset.
 * Actual application-role principal, scoped grants and permitted reads are compared before/after. */
it('upgrades a populated pre-board baseline through every later journaled migration without changing retained facts or access',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const start=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='0602_payroll_history_revisions');
 expect(start).toBeGreaterThan(0);expect(journal.entries[start-1].tag).toBe('0611_performance_partner_access');
 expect(journal.entries.slice(start,start+2).map((entry:{tag:string})=>entry.tag)).toEqual(['0602_payroll_history_revisions','0603_letter_lifecycle']); // the board pair, adjacent; later migrations may follow
 const tail=journal.entries.slice(start) as {idx:number;when:number}[];
 expect(tail.every((entry,index)=>index===0||entry.idx>tail[index-1].idx&&entry.when>tail[index-1].when)).toBe(true); // strictly ascending, or Drizzle silently skips
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
  const tenantIds:string[]=[],slips:string[]=[],users:string[]=[],subjects:{tenantId:string;companyId:string;otherCompanyId:string;personId:string;employmentId:string;employeeUserId:string;scopedUserId:string;providerId:string}[]=[];
  for(let index=0;index<2;index++){
   const [tenant]=await storage.client<{id:string}[]>`insert into tenant(workos_org_id,name) values(${randomUUID()},${'Synthetic upgrade tenant '+index}) returning id`;tenantIds.push(tenant.id);
   const [company]=await storage.client<{id:string}[]>`insert into company(tenant_id,legal_name,country,currency) values(${tenant.id},${'Synthetic upgrade employer '+index},'MY','MYR') returning id`;
   const [person]=await storage.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${tenant.id},${'Synthetic upgrade worker '+index},${'upgrade-'+index+'@example.invalid'}) returning id`;
   const [employee]=await storage.client<{id:string}[]>`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) values(${tenant.id},${person.id},${company.id},'0007','2022-01-01') returning id`;
   const [user]=await storage.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id) values(${tenant.id},${randomUUID()}) returning id`;users.push(user.id);
   await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant.id},${user.id},'hr_admin')`;
   const [otherCompany]=await storage.client<{id:string}[]>`insert into company(tenant_id,legal_name,country,currency) values(${tenant.id},${'Synthetic scoped employer '+index},'MY','MYR') returning id`;
   const [employeeUser]=await storage.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id,person_id) values(${tenant.id},${randomUUID()},${person.id}) returning id`;
   await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant.id},${employeeUser.id},'employee')`;
   const [scopedUser]=await storage.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id) values(${tenant.id},${randomUUID()}) returning id`;
   await storage.client`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${tenant.id},${scopedUser.id},'hr_admin',${company.id}),(${tenant.id},${scopedUser.id},'payroll_partner',${otherCompany.id})`;
   const [leaveType]=await storage.client<{id:string}[]>`insert into leave_type(tenant_id,code,name,paid) values(${tenant.id},'UPGRADE','Fictional retained annual leave',true) returning id`;
   await storage.client`insert into leave_request(tenant_id,employment_id,leave_type_id,start_date,end_date,days,status,reason) values(${tenant.id},${employee.id},${leaveType.id},'2023-02-01','2023-02-02',2,'pending','Fictional retained pending leave')`;
   await storage.client`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on,reason) values(${tenant.id},${employee.id},${leaveType.id},'accrual',12,'2023-01-01','Fictional retained accrual'),(${tenant.id},${employee.id},${leaveType.id},'adjustment',-2,'2023-01-02','Fictional retained adjustment')`;
   await storage.client`insert into compensation(tenant_id,employment_id,basic_salary,currency,valid_from,valid_to) values(${tenant.id},${employee.id},4800,'MYR','2022-01-01','2022-12-31'),(${tenant.id},${employee.id},5000,'MYR','2023-01-01',null)`;
   await storage.client`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) values(${tenant.id},'upgrade-fixture',${employee.id},'upgrade-fixture.physical-witness','user',${user.id},${employee.id},'{"fixture":true,"notCanonicalCommandProvenance":true}'::jsonb)`;
   // Inactive inert ciphertext is a storage witness, not a usable key/provider activation.
   const provider=await application.withTenant({tenantId:tenant.id,userId:user.id,roles:['hr_admin']},tx=>tx.execute<{id:string}>(sql`insert into public.ai_provider_config(tenant_id,provider,model,api_key_ciphertext,key_last4,is_active,created_by_user_id,updated_by_user_id) values(${tenant.id}::uuid,'openai','fictional-inactive-model','FICTIONAL_INERT_CIPHERTEXT','FAKE',false,${user.id}::uuid,${user.id}::uuid) returning id`));
   subjects.push({tenantId:tenant.id,companyId:company.id,otherCompanyId:otherCompany.id,personId:person.id,employmentId:employee.id,employeeUserId:employeeUser.id,scopedUserId:scopedUser.id,providerId:provider[0].id});
   const [period]=await storage.client<{id:string}[]>`insert into pay_period(tenant_id,company_id,period,status) values(${tenant.id},${company.id},'2023-01','closed') returning id`;
   const [batch]=await storage.client<{id:string}[]>`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,employee_count,totals) values(${tenant.id},${company.id},${period.id},'2023-01','2023-01-31','closed',1,'{"gross":5000,"net":4500}'::jsonb) returning id`;
   const [slip]=await storage.client<{id:string}[]>`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,total_deductions,net_pay,employer_cost,statutory) values(${tenant.id},${batch.id},${employee.id},5000,5000,500,4500,5600,'{"epfEmployee":500,"epfEmployer":600}'::jsonb) returning id`;slips.push(slip.id);
  }
  const tables=await storage.client<{schema:string;name:string;columns:string[]}[]>`select table_schema as schema,table_name as name,array_agg(column_name::text order by ordinal_position) as columns from information_schema.columns c where table_schema in ('public','app') and exists(select 1 from information_schema.tables t where t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE') group by table_schema,table_name having bool_or(column_name='tenant_id') or table_name='tenant' order by table_schema,table_name`;
  const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
  async function rows(table:typeof tables[number]){
   const field=table.name==='tenant'?'id':'tenant_id';
   const captured:string[]=[];
   for(let index=0;index<tenantIds.length;index++){
    const actual=await storage.withTenant({tenantId:tenantIds[index],userId:users[index],roles:['hr_admin']},tx=>tx.execute<{row:string}>(sql`select (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(t)) where key=any(ARRAY[${sql.join(table.columns.map(column=>sql`${column}`),sql`, `)}]::text[]))::text as row from ${sql.raw(quote(table.schema)+'.'+quote(table.name))} t where ${sql.raw(quote(field))}=${tenantIds[index]}::uuid order by 1`));
    captured.push(...actual.map(row=>row.row));
   }
   return captured.sort();
  }
  const before=new Map<string,string[]>();
  for(const table of tables){const data=await rows(table);if(data.length)before.set(table.schema+'.'+table.name,data);}
  expect(before.size).toBeGreaterThanOrEqual(13);
  for(const table of ['public.leave_type','public.leave_request','public.leave_ledger','public.compensation','public.domain_event','public.ai_provider_config'])expect(before.get(table)?.length,table+' must be a nonempty physical preservation witness').toBeGreaterThan(0);
  async function applicationWitness(){
   const observations:unknown[]=[];
   for(let index=0;index<subjects.length;index++){
    const subject=subjects[index],contexts=[
     {tenantId:subject.tenantId,userId:users[index],personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
     {tenantId:subject.tenantId,userId:subject.employeeUserId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]},
     {tenantId:subject.tenantId,userId:subject.scopedUserId,personId:null,roles:['hr_admin','payroll_partner'],grants:[{role:'hr_admin',companyId:subject.companyId},{role:'payroll_partner',companyId:subject.otherCompanyId}]}
    ];
    for(let kind=0;kind<contexts.length;kind++)observations.push(await application.withTenant(contexts[kind],async tx=>{
     const [proof]=await tx.execute<{current:boolean;ownPerson:boolean;targetHr:boolean;otherHr:boolean;targetPayroll:boolean;otherPayroll:boolean;ciphertextReadable:boolean;principal:unknown}>(sql`select app.principal_snapshot_current() as current,app.is_self_person(${subject.personId}::uuid) as "ownPerson",app.has_role_for('hr_admin',${subject.companyId}::uuid) as "targetHr",app.has_role_for('hr_admin',${subject.otherCompanyId}::uuid) as "otherHr",app.can_admin_payroll_for(${subject.companyId}::uuid) as "targetPayroll",app.can_admin_payroll_for(${subject.otherCompanyId}::uuid) as "otherPayroll",has_column_privilege(current_user,'public.ai_provider_config','api_key_ciphertext','SELECT') as "ciphertextReadable",(select jsonb_build_object('tenantId',p.tenant_id,'personId',p.person_id,'grants',(select jsonb_agg(g order by g::text) from jsonb_array_elements(p.grants) g)) from app.principal(app.current_user_id()) p) as principal`);
     expect(proof.current).toBe(true);expect(proof.ciphertextReadable).toBe(false);expect(proof.ownPerson).toBe(kind===1);
     expect(proof.targetHr).toBe(kind!==1);expect(proof.otherHr).toBe(kind===0);expect(proof.targetPayroll).toBe(kind!==1);expect(proof.otherPayroll).toBe(kind!==1);
     const ownPayslips=await tx.select({id:payslip.id,gross:payslip.grossPay,net:payslip.netPay}).from(payslip);expect(ownPayslips).toEqual([{id:slips[index],gross:'5000.00',net:'4500.00'}]);
     const foreign=await tx.select({id:payslip.id}).from(payslip).where(eq(payslip.id,slips[1-index]));expect(foreign).toEqual([]);
     const leave=await tx.execute(sql`select entry_type,days::text as days,effective_on::text as effective_on,reason from public.leave_ledger where employment_id=${subject.employmentId}::uuid order by effective_on,id`);expect(leave).toHaveLength(2);
     const provider=await tx.execute(sql`select id,provider::text as provider,model,key_last4,is_active from public.ai_provider_config order by id`);expect(provider).toHaveLength(1);expect(provider[0]).toMatchObject({id:subject.providerId,provider:'openai',is_active:false});
     return {proof,ownPayslips,foreign,leave,provider};
    }));
   }
   return observations;
  }
  const actualGrantsBefore=await applicationWitness();
  const ledger=()=>storage.client<{id:number;hash:string;created_at:string}[]>`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by created_at,id`;
  const previous=await ledger();expect(previous).toHaveLength(start);
  expect(previous.map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(journal.entries.slice(0,start).sort((a:{idx:number;when:number},b:{idx:number;when:number})=>a.when-b.when||a.idx-b.idx).map((entry:{tag:string;when:number})=>({hash:createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),created_at:String(entry.when)})));
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  const upgraded=await ledger();expect(upgraded.slice(0,start)).toEqual(previous);expect(upgraded).toHaveLength(journal.entries.length);
  expect(upgraded.slice(start).map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(journal.entries.slice(start).map((entry:{tag:string;when:number})=>({hash:createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),created_at:String(entry.when)})));
  expect(await applicationWitness()).toEqual(actualGrantsBefore);
  for(const subject of subjects){const options=await application.withTenant({tenantId:subject.tenantId,userId:subject.employeeUserId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]},tx=>tx.execute(sql`select provider_options from public.ai_provider_config where id=${subject.providerId}::uuid`));expect(options).toEqual([{provider_options:{}}]);}
  for(const table of tables)if(before.has(table.schema+'.'+table.name))expect(await rows(table),table.schema+'.'+table.name).toEqual(before.get(table.schema+'.'+table.name));
  for(let index=0;index<2;index++){
   const ctx={tenantId:tenantIds[index],userId:users[index],roles:['hr_admin']};
   expect(await application.withTenant(ctx,tx=>tx.select({id:payslip.id,gross:payslip.grossPay,net:payslip.netPay}).from(payslip))).toEqual([{id:slips[index],gross:'5000.00',net:'4500.00'}]);
   expect(await application.withTenant(ctx,tx=>tx.select({id:payslip.id}).from(payslip).where(eq(payslip.id,slips[1-index])))).toEqual([]);
  }
  await expect(storage.client`update payslip set gross_pay=1 where id=${slips[0]}`).rejects.toMatchObject({code:'23514'});
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await ledger()).toEqual(upgraded);expect(await applicationWitness()).toEqual(actualGrantsBefore);
  for(const table of tables)if(before.has(table.schema+'.'+table.name))expect(await rows(table),table.schema+'.'+table.name).toEqual(before.get(table.schema+'.'+table.name));
  console.info(JSON.stringify({kind:'COMBINED_POPULATED_UPGRADE',physicalWitnessNotCommandProvenance:true,scopedPrincipalWitnesses:subjects.length*3,providerActivated:false,baselineMigrations:start,appliedMigrations:upgraded.length-start,populatedTables:before.size,comparedRows:[...before.values()].reduce((count,rows)=>count+rows.length,0),tenants:tenantIds.length,physicalRowsUnchanged:true,appRoleIsolation:true,closedPayrollImmutable:true,idempotentMigration:true}));
 }finally{
  await application.client.end();await storage.client.end();
  if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180_000);
