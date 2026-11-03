/** Populated accepted main → permissions; hosted disposable databases only. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb,type SessionContext} from '../db/client';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {publishWorkforceActionPackage} from '../deploy/access/publish-workforce-capabilities';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
type Entry={idx:number;version:string;when:number;tag:string;breakpoints:boolean};

it('preserves existing APP scope, role facts and restricted owner when upgrading accepted main',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:Entry[]};
 const boundary=journal.entries.findIndex(row=>row.tag==='0946_draft_creation_cohort_custody')+1;
 expect(boundary).toBe(650);
 const accepted=journal.entries.slice(0,boundary);
 const digest=(row:Entry)=>hash(readFileSync('db/migrations/'+row.tag+'.sql'));
 expect(hash(JSON.stringify(accepted))).toBe('14a8d7e992e6c1487ca21d1e5bc75f0776bdf6e167120b8ce636f785705d2034');
 expect(hash(JSON.stringify(accepted.map(row=>[row.tag,String(row.when),digest(row)])))).toBe('9c7e672718a886b9aae230a614bea8046baef87dec300464dd8386c39a43e1ab');
 expect(journal.entries.slice(boundary).map(row=>row.tag.slice(0,4))).toEqual(['0947','0948','0949','0950','0951','0952','0953','0954','0955','0956','0957','0958','0959','0960','0961','0962','0963','0964','0965','0966','0967','0968','0969','0970','0971','0972','0973','0974','0975','0976','0977']);
 const folder=mkdtempSync(join(tmpdir(),'permissions-upgrade-')),database='ai_hr_permissions_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);
 expect(['127.0.0.1','localhost']).toContain(appUrl.hostname);
 expect(ownerUrl.username).not.toBe('ai_hr_app');expect(appUrl.username).toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+database;appUrl.pathname='/'+database;
 const storage=createDb(ownerUrl.toString(),{max:1}),app=createDb(appUrl.toString(),{max:1});let created=false;
 const tenantId=randomUUID(),a=randomUUID(),b=randomUUID(),gradeA=randomUUID(),gradeB=randomUUID(),root=randomUUID(),scoped=randomUUID(),own=randomUUID();
 const rootCtx:SessionContext={tenantId,userId:root,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 const scopedCtx:SessionContext={tenantId,userId:scoped,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:a}]};
 const visible=(ctx:SessionContext)=>app.withTenant(ctx,tx=>tx.execute<{code:string}>(sql`select employee_code as code from public.employment order by employee_code`));
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 const native=()=>storage.client`select jsonb_build_object('roles',(select jsonb_agg(to_jsonb(r) order by r.id) from role_assignment r where r.tenant_id=${tenantId}::uuid),
  'people',(select jsonb_agg(to_jsonb(p) order by p.id) from person p where p.tenant_id=${tenantId}::uuid),
  'employment',(select jsonb_agg(to_jsonb(e) order by e.id) from employment e where e.tenant_id=${tenantId}::uuid)) as value`;
 const custody=()=>storage.client`select p.oid, p.prosrc, p.proacl::text[] as acl,p.proconfig,pg_get_userbyid(p.proowner) as owner,
  has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_exec,has_schema_privilege('ai_hr_draft_discard_port','app','CREATE') as child_create
  from pg_proc p where p.oid='app._draft_discard_source_snapshot(uuid,uuid)'::regprocedure`;
 try{
  await admin.unsafe('CREATE DATABASE "'+database+'"');created=true;
  mkdirSync(join(folder,'meta'));for(const row of accepted)copyFileSync('db/migrations/'+row.tag+'.sql',join(folder,row.tag+'.sql'));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:accepted}));
  await migrate(storage.db,{migrationsFolder:folder});
  const oldLedger=await ledger();expect(oldLedger.map(row=>[row.hash,row.created_at])).toEqual(accepted.map(row=>[digest(row),String(row.when)]));
  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenantId},${randomUUID()},'Fictional permissions upgrade')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${a},${tenantId},'Fictional A'),(${b},${tenantId},'Fictional B')`;
  await storage.client`insert into job_grade(id,tenant_id,code,name) values(${gradeA},${tenantId},'UPG_A','A'),(${gradeB},${tenantId},'UPG_B','B')`;
  let ownPerson='';
  for(const [code,company,grade] of [['UPGRADE-A1',a,gradeA],['UPGRADE-A2',a,gradeB],['UPGRADE-B1',b,gradeA]]){
   const person=randomUUID();if(code==='UPGRADE-A2')ownPerson=person;
   await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenantId},${code},${code.toLowerCase()+'@fixture.invalid'})`;
   await storage.client`insert into employment(tenant_id,person_id,company_id,grade_id,employee_code,hired_on) values(${tenantId},${person},${company},${grade},${code},'2025-01-01')`;
  }
  await storage.client`insert into app_user(id,tenant_id,workos_user_id,person_id) values
   (${root},${tenantId},${randomUUID()},null),(${scoped},${tenantId},${randomUUID()},null),(${own},${tenantId},${randomUUID()},${ownPerson})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role,company_id) values
   (${tenantId},${root},'hr_admin',null),(${tenantId},${scoped},'hr_admin',${a}),(${tenantId},${own},'employee',null)`;
  const ownCtx:SessionContext={tenantId,userId:own,personId:ownPerson,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const roles=[rootCtx,scopedCtx,ownCtx],legacy=await Promise.all(roles.map(visible)),rows=await native(),source=await custody();
  expect(legacy.map(list=>list.map(row=>row.code))).toEqual([['UPGRADE-A1','UPGRADE-A2','UPGRADE-B1'],['UPGRADE-A1','UPGRADE-A2'],['UPGRADE-A2']]);
  expect(source).toMatchObject([{owner:'ai_hr_draft_discard_port',app_exec:false,child_create:false}]);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  const updatedLedger=await ledger();expect(updatedLedger.slice(0,boundary)).toEqual(oldLedger);
  expect(updatedLedger.slice(boundary).map(row=>[row.hash,row.created_at])).toEqual(journal.entries.slice(boundary).map(row=>[digest(row),String(row.when)]));
  expect(await native()).toEqual(rows);expect(await custody()).toEqual(source);
  expect(await Promise.all(roles.map(visible))).toEqual(legacy);
  expect(await storage.client`select count(*)::int as assigned from user_data_permission_assignment where tenant_id=${tenantId}::uuid`).toEqual([{assigned:0}]);
  // Test the real installed Workforce component on this disposable upgraded database.
  await app.withTenant(rootCtx,tx=>accessConfigurationStore.loadCurrent(tx,rootCtx));
  await publishWorkforceActionPackage(storage.client);
  const profileId=randomUUID();
  for(const command of [{kind:'create',profileId,name:'Fictional grade scope',enabled:true,rules:{legacyCompany:false,predicates:[{field:'grade',values:[gradeA]}]}},{kind:'assign',userId:scoped,profileId}]){
   await app.withTenant(rootCtx,async tx=>{
    const [state]=await tx.execute<{value:{revision:string}}>(sql`select app.data_permission_state() as value`);
    const [preview]=await tx.execute<{value:{fingerprint:string}}>(sql`select app.data_permission_transition(${JSON.stringify(command)}::jsonb,${state.value.revision},false,null) as value`);
    await tx.execute(sql`select app.data_permission_transition(${JSON.stringify(command)}::jsonb,${state.value.revision},true,${preview.value.fingerprint})`);
   });
  }
  expect(await visible(scopedCtx)).toEqual([{code:'UPGRADE-A1'}]);expect(await visible(ownCtx)).toEqual(legacy[2]);
  expect(await native()).toEqual(rows);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await ledger()).toEqual(updatedLedger);expect(await custody()).toEqual(source);
 }finally{
  await app.client.end();await storage.client.end();if(created)await admin.unsafe('DROP DATABASE "'+database+'" WITH (FORCE)');await admin.end();rmSync(folder,{recursive:true,force:true});
 }
},180000);
