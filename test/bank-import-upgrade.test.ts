import {expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {createDb} from '../db/client';

/** Normal migrator on an owned populated database; no installation data or shared reset. */
it('adds durable bank imports without changing retained statutory facts, principals or tenant isolation',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const boundary=journal.entries.findIndex((entry:{tag:string})=>entry.tag.endsWith('_bank_import_jobs'));
 expect(boundary).toBeGreaterThan(0);
 const tail=journal.entries.slice(boundary) as {idx:number;when:number}[];
 expect(tail.every((entry,index)=>entry.when>journal.entries[boundary+index-1].when&&entry.idx>journal.entries[boundary+index-1].idx)).toBe(true);
 const directory=mkdtempSync(join(tmpdir(),'bank-import-upgrade-')),name='ai_hr_bank_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['localhost','127.0.0.1']).toContain(ownerUrl.hostname);
 expect(appUrl.hostname).toBe(ownerUrl.hostname);expect(appUrl.port).toBe(ownerUrl.port);expect(appUrl.username).toBe('ai_hr_app');expect(ownerUrl.username).not.toBe(appUrl.username);
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+name;appUrl.pathname='/'+name;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});let created=false;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;
  mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync(`db/migrations/${entry.tag}.sql`,join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const actors:{tenantId:string;userId:string;personId:string;employmentId:string;code:string}[]=[];
  for(let index=0;index<2;index++){
   const [tenant]=await storage.client`insert into tenant(workos_org_id,name) values(${randomUUID()},'Synthetic bank upgrade tenant') returning id`;
   const [company]=await storage.client`insert into company(tenant_id,legal_name,country,currency) values(${tenant.id},'Synthetic bank upgrade employer','MY','MYR') returning id`;
   const [person]=await storage.client`insert into person(tenant_id,full_name,primary_email) values(${tenant.id},'Synthetic retained employee',${'bank-upgrade-'+index+'@example.invalid'}) returning id`;
   const code='RETAIN'+index;
   const [employee]=await storage.client`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) values(${tenant.id},${person.id},${company.id},${code},'2026-01-05') returning id`;
   await storage.client`insert into employee_statutory_my(tenant_id,person_id,tax_number,bank_name,bank_account_no) values(${tenant.id},${person.id},'T-RETAINED','Maybank','0001234567')`;
   const [user]=await storage.client`insert into app_user(tenant_id,workos_user_id) values(${tenant.id},${randomUUID()}) returning id`;
   await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant.id},${user.id},'hr_admin')`;
   actors.push({tenantId:tenant.id,userId:user.id,personId:person.id,employmentId:employee.id,code});
  }
  const ctx=(actor:typeof actors[number])=>({tenantId:actor.tenantId,userId:actor.userId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]});
  const facts=async()=>({
   statutory:await storage.client`select * from employee_statutory_my order by id`,
   employment:await storage.client`select * from employment order by id`,
   people:await storage.client`select * from person order by id`,
   users:await storage.client`select * from app_user order by id`,
   grants:await storage.client`select * from role_assignment order by id`
  });
  const visibility=async()=>Promise.all(actors.map(actor=>application.withTenant(ctx(actor),async tx=>{
   const [proof]=await tx.execute(sql`select app.principal_snapshot_current() as current`);expect(proof.current).toBe(true);
   const rows=await tx.execute(sql`select person_id,tax_number,bank_account_no from employee_statutory_my order by person_id`);
   expect(rows).toEqual([{person_id:actor.personId,tax_number:'T-RETAINED',bank_account_no:'0001234567'}]);return{proof,rows};
  })));
  const before=await facts(),beforeVisibility=await visibility();expect(before.statutory).toHaveLength(2);
  const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by created_at,id`;
  const prior=await ledger();expect(prior).toHaveLength(boundary);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  const applied=await ledger();expect(applied.slice(0,boundary)).toEqual(prior);expect(applied).toHaveLength(journal.entries.length);
  expect(applied.slice(boundary).map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(journal.entries.slice(boundary).map((entry:{tag:string;when:number})=>({hash:createHash('sha256').update(readFileSync(`db/migrations/${entry.tag}.sql`)).digest('hex'),created_at:String(entry.when)})));
  expect(await facts()).toEqual(before);expect(await visibility()).toEqual(beforeVisibility);
  const actor=actors[0],hash=createHash('sha256').update('synthetic-upgrade-source').digest('hex');
  const job=await application.withTenant(ctx(actor),async tx=>{
   const subjects=await tx.execute(sql`select employee_code from app.bank_import_subjects(${JSON.stringify(actors.map(a=>a.code))}::jsonb)`);expect(subjects).toEqual([{employee_code:actor.code}]);
   const [row]=await tx.execute<{id:string;context:unknown}>(sql`insert into bank_import_job(tenant_id,created_by,context,source_name,source_hash,source_bytes) values(${actor.tenantId}::uuid,${actor.userId}::uuid,'{}','upgrade.csv',${hash},10) returning id,context`);
   expect(row.context).toMatchObject({tenantId:actor.tenantId,userId:actor.userId});return row;
  });
  expect(await application.withTenant(ctx(actors[1]),tx=>tx.execute(sql`select id from bank_import_job where id=${job.id}::uuid`))).toHaveLength(0);
  await expect(application.withTenant(ctx(actor),tx=>tx.execute(sql`insert into bank_import_job(tenant_id,created_by,context,source_name,source_hash,source_bytes) values(${actor.tenantId}::uuid,${actor.userId}::uuid,'{}','duplicate.csv',${hash},10)`))).rejects.toThrow();
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await ledger()).toEqual(applied);expect(await facts()).toEqual(before);expect(await visibility()).toEqual(beforeVisibility);
  console.info(JSON.stringify({kind:'BANK_IMPORT_POPULATED_UPGRADE',baselineMigrations:boundary,appliedMigrations:applied.length-boundary,retainedStatutoryRows:before.statutory.length,physicalFactsUnchanged:true,currentPrincipals:true,appRoleIsolation:true,activeFileUnique:true,idempotentMigration:true}));
 }finally{
  await application.client.end();await storage.client.end();
  if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180000);
