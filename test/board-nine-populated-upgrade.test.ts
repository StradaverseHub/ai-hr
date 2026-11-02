/** Exact post-Noveri populated upgrade, on a disposable hosted localhost database only.
 * Source bytes are pinned independently; this supplies no staging acceptance or AI approval. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
import type {EmployeeDraftData} from '../lib/employee-draft-schema';

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const sourceFunction='app._draft_discard_source_snapshot(uuid,uuid)';
const oldNumericPredicate=`pg_catalog.jsonb_path_exists(x.data,'strict $.** ? (@.type() == "number")')`;
const newNumericPredicate=`pg_catalog.jsonb_path_exists(CASE WHEN x.data->'creationDefaultsVersion'='1'::jsonb THEN x.data-'creationDefaultsVersion' ELSE x.data END,'strict $.** ? (@.type() == "number")')`;
type Entry={idx:number;version:string;when:number;tag:string;breakpoints:boolean};
type Source={oid:string;owner:string;acl:string[]|null;config:string[]|null;securityDefiner:boolean;body:string;childCreate:boolean};

it('upgrades the exact 648-entry populated Noveri baseline without rewriting native rows, history or restricted custody',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:Entry[]};
 const boundary=journal.entries.findIndex(row=>row.tag==='0935_password_account_unlock');
 expect(boundary).toBe(648);
 const acceptedEnd=journal.entries.findIndex(row=>row.tag==='0946_draft_creation_cohort_custody')+1;
 expect(acceptedEnd).toBe(650);
 const accepted=journal.entries.slice(0,acceptedEnd);
 const prefix=journal.entries.slice(0,boundary);
 expect(prefix.at(-1)).toEqual({idx:762,version:'7',when:1793330000329,tag:'0929_teras_review_services',breakpoints:true});
 expect(hash(JSON.stringify(prefix))).toBe('e4150da4b1cc41ab75886d96720d5b45382d27f4c197ea6957da159ac306c031');
 const identities=prefix.map(row=>[row.tag,String(row.when),hash(readFileSync('db/migrations/'+row.tag+'.sql'))]);
 expect(hash(JSON.stringify(identities))).toBe('65172aab213aac9a64e2c0149e847d106d2c89fbe2dbd3783562221b1e5a450b');
 expect(accepted.slice(boundary).map(({tag,when})=>({tag,when}))).toEqual([
  {tag:'0935_password_account_unlock',when:1793330000335},
  {tag:'0946_draft_creation_cohort_custody',when:1793330000346},
 ]);
 expect(hash(readFileSync('db/migrations/0935_password_account_unlock.sql'))).toBe('3933f36ffe4ea3d4c0d47a2e0c27f6cf514dc8ba48942af7e241c60e829bafaa');
 expect(hash(readFileSync('db/migrations/0946_draft_creation_cohort_custody.sql'))).toBe('cf06975c936963a98af73b2c602a32d599557a5791f461794564c03af066d390');
 const folder=mkdtempSync(join(tmpdir(),'board-nine-upgrade-')),database='ai_hr_board_nine_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(['127.0.0.1','localhost']).toContain(appUrl.hostname);
 expect(ownerUrl.username).not.toBe('ai_hr_app');expect(appUrl.username).toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+database;appUrl.pathname='/'+database;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});let created=false;
 const tenant=randomUUID(),company=randomUUID(),person=randomUUID(),user=randomUUID(),employment=randomUUID(),draft=randomUUID();
 const issuer='fictional-board-nine-upgrade',subject='fictional-existing-subject';
 const historicalData={profile:{fullName:'Fictional historical draft'},statutory:{subjectToSkbbk:'no'}} satisfies EmployeeDraftData;
 const cohortData={creationDefaultsVersion:1,profile:{fullName:'Fictional new draft'},statutory:{subjectToSkbbk:'yes'}} satisfies EmployeeDraftData & {creationDefaultsVersion:1};
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 const source=async()=>{
  const [row]=await storage.client<Source[]>`select p.oid::text as oid,pg_get_userbyid(p.proowner)::text as owner,p.proacl::text[] as acl,p.proconfig as config,p.prosecdef as "securityDefiner",p.prosrc as body,has_schema_privilege('ai_hr_draft_discard_port','app','CREATE') as "childCreate" from pg_proc p where p.oid=${sourceFunction}::regprocedure`;
  expect(row).toBeDefined();return row;
 };
 const native=async()=>{
  const rows:Record<string,unknown>={};
  for(const table of ['tenant','company','person','app_user','role_assignment','employment','compensation','employee_draft']){
   rows[table]=await storage.client.unsafe(`select to_jsonb(t) as row from public.${table} t where ${table==='tenant'?'id':'tenant_id'}=$1 order by to_jsonb(t)::text`,[tenant]);
  }
  rows.identities=await storage.client`select issuer,subject,app_user_id,revoked_at from public.app_external_identity where app_user_id=${user} order by issuer,subject`;
  return rows;
 };
 const capture=()=>storage.client.begin(async tx=>{
  await tx.unsafe('SET LOCAL ROLE ai_hr_draft_discard_port');
  await tx`select set_config('app.tenant_id',${tenant},true),set_config('app.user_id',${user},true),set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true)`;
  expect(await tx`select app.principal_snapshot_current() as principal,app.is_group_admin() as group_admin`).toEqual([{principal:true,group_admin:true}]);
  return tx`select app._draft_discard_source_snapshot(${draft}::uuid,${company}::uuid) as snapshot`;
 });
 try{
  await admin.unsafe(`CREATE DATABASE "${database}"`);created=true;
  mkdirSync(join(folder,'meta'));for(const row of prefix)copyFileSync('db/migrations/'+row.tag+'.sql',join(folder,row.tag+'.sql'));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));
  await migrate(storage.db,{migrationsFolder:folder});
  const beforeLedger=await ledger();expect(beforeLedger).toHaveLength(648);
  expect(beforeLedger.map(row=>[row.hash,row.created_at])).toEqual(identities.map(([,when,digest])=>[digest,when]));
  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional BOARD upgrade')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${company},${tenant},'Fictional retained company')`;
  await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenant},'Fictional retained employee','board-nine-upgrade@example.invalid')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${tenant},${person},${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant},${user},'hr_admin')`;
  await storage.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on) values(${employment},${tenant},${person},${company},'BOARD-UPGRADE-1','2025-01-01')`;
  await storage.client`insert into compensation(tenant_id,employment_id,basic_salary,currency,valid_from) values(${tenant},${employment},3210.45,'MYR','2025-01-01')`;
  await storage.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuer},${subject},${user})`;
  await storage.client`insert into employee_draft(id,tenant_id,company_id,created_by_person_id,label,data) values(${draft},${tenant},${company},${person},'Fictional retained draft',${JSON.stringify(historicalData)}::jsonb)`;
  expect(await storage.client`select data from employee_draft where id=${draft}`).toEqual([{data:historicalData}]);
  expect(await storage.client`select basic_salary::text as salary,currency from compensation where employment_id=${employment}`).toEqual([{salary:'3210.45',currency:'MYR'}]);
  const beforeNative=await native(),beforeSource=await source();
  for(const rows of Object.values(beforeNative))expect(rows).toHaveLength(1);
  expect(beforeSource.owner).toBe('ai_hr_draft_discard_port');expect(beforeSource.securityDefiner).toBe(true);expect(beforeSource.childCreate).toBe(false);
  expect(hash(beforeSource.body)).toBe('c3a2744b7924ff9e4313c579dc9d831c5101a5d2b265dcad380cbab63b645ca9');
  await storage.client`update employee_draft set data=${JSON.stringify(cohortData)}::jsonb where id=${draft}`;
  await expect(capture()).rejects.toMatchObject({code:'54000'});
  await storage.client`update employee_draft set data=${JSON.stringify(historicalData)}::jsonb where id=${draft}`;
  // The original historical row is present at the upgrade boundary; the mutation above is preflight only.
  const upgradeNative=await native();
  // Rehearse the accepted BOARD upgrade independently of subsequent permissions migrations.
  for(const row of accepted.slice(boundary))copyFileSync('db/migrations/'+row.tag+'.sql',join(folder,row.tag+'.sql'));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:accepted}));
  await migrate(storage.db,{migrationsFolder:folder});
  const afterLedger=await ledger();expect(afterLedger).toHaveLength(650);expect(afterLedger.slice(0,648)).toEqual(beforeLedger);
  expect(afterLedger.slice(648).map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual([
   {hash:'3933f36ffe4ea3d4c0d47a2e0c27f6cf514dc8ba48942af7e241c60e829bafaa',created_at:'1793330000335'},
   {hash:'cf06975c936963a98af73b2c602a32d599557a5791f461794564c03af066d390',created_at:'1793330000346'},
  ]);
  expect(await native()).toEqual(upgradeNative);
  const afterSource=await source();
  expect(afterSource).toEqual({...beforeSource,body:beforeSource.body.replace(oldNumericPredicate,newNumericPredicate).replace('No numeric leaf is serialized; timestamps are UTC.','Only the exact root creation cohort 1 may be numeric; timestamps are UTC.')});
  expect(await application.client`select has_function_privilege(current_user,'app.password_unlock_subject(uuid,text)','EXECUTE') as unlock,has_function_privilege(current_user,${sourceFunction},'EXECUTE') as private_source,has_table_privilege(current_user,'public.app_external_identity','SELECT') as raw_identity`).toEqual([{unlock:true,private_source:false,raw_identity:false}]);
  await expect(application.client`select app.password_unlock_subject(${user}::uuid,${issuer})`).rejects.toMatchObject({code:'42501'});
  const unlocked=await application.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${tenant},true),set_config('app.user_id',${user},true),set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true)`;
   expect(await tx`select app.principal_snapshot_current() as principal,app.is_group_admin() as group_admin`).toEqual([{principal:true,group_admin:true}]);
   return tx`select app.password_unlock_subject(${user}::uuid,${issuer}) as subject`;
  });
  expect(unlocked).toEqual([{subject}]);
  await expect(application.client`select app._draft_discard_source_snapshot(${draft}::uuid,${company}::uuid)`).rejects.toMatchObject({code:'42501'});
  await storage.client`update employee_draft set data=${JSON.stringify(cohortData)}::jsonb where id=${draft}`;
  expect(await storage.client`select data->'statutory'->>'subjectToSkbbk' as skbbk from employee_draft where id=${draft}`).toEqual([{skbbk:'yes'}]);
  const [captured]=await capture();expect(captured.snapshot).toMatchObject({draftId:draft,companyId:company,companyName:'Fictional retained company',label:'Fictional retained draft'});
  await storage.client`update employee_draft set data=${JSON.stringify(historicalData)}::jsonb where id=${draft}`;
  expect(await storage.client`select data->'statutory'->>'subjectToSkbbk' as skbbk from employee_draft where id=${draft}`).toEqual([{skbbk:'no'}]);
  const beforeRerun=await native();await migrate(storage.db,{migrationsFolder:folder});
  expect(await ledger()).toEqual(afterLedger);expect(await native()).toEqual(beforeRerun);expect(await source()).toEqual(afterSource);
 }finally{
  await application.client.end();await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();rmSync(folder,{recursive:true,force:true});
 }
},180000);
