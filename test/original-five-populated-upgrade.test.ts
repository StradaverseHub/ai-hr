/** Populated ordinary-journal upgrade of the original EPF/profile/OCBC changes.
 * Disposable localhost database only; original guards stay active and Drizzle owns its ledger. */
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';

type Journal={entries:{tag:string;when:number}[];[key:string]:unknown};
function identities(){return {tenant:randomUUID(),company:randomUUID(),department:randomUUID(),employeePerson:randomUUID(),employeeUser:randomUUID(),employeeEmployment:randomUUID(),hrPerson:randomUUID(),hrUser:randomUUID(),hrEmployment:randomUUID(),otherPerson:randomUUID(),otherUser:randomUUID(),otherEmployment:randomUUID(),statutory:randomUUID(),bank:randomUUID()};}

it('preserves existing EPF elections and pending profile custody through the ordinary original-feature journal tail',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as Journal;
 const find=(suffix:string)=>journal.entries.findIndex(entry=>entry.tag.endsWith('_'+suffix));
 const start=find('epf_manual_percentage'),profile=find('profile_field_approvals'),bank=find('ocbc_bank_payment_exports');
 expect(start).toBeGreaterThan(0);expect(profile).toBeGreaterThan(start);expect(bank).toBeGreaterThan(profile);
 for(const suffix of ['epf_manual_percentage','profile_field_approvals','ocbc_bank_payment_exports'])expect(journal.entries.filter(entry=>entry.tag.endsWith('_'+suffix))).toHaveLength(1);
 const name='ai_hr_original_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'aihr-original-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});let created=false;
 ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});
 const enabled=identities(),legacy=identities();
 const assignedId=randomUUID(),blockedUnassignedId=randomUUID(),malformedId=randomUUID(),legacyId=randomUUID(),routeId=randomUUID(),revision=randomUUID(),unknownId=randomUUID();
 const proposed={preferredName:'Fictional pending preference'},history=[{before:{approverUserId:enabled.otherUser},after:{approverUserId:enabled.hrUser},reason:'Fictional historical reassignment'}];
 async function actor(tx:Pick<typeof storage.client,'unsafe'>,fixture:ReturnType<typeof identities>,user:string,role:string,appRole=false){
  await tx.unsafe("select set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.roles',$3,true),set_config('app.grants',$4,true),set_config('app.agent_principal_id','',true),set_config('app.profile_route_maintenance','off',true)",[fixture.tenant,user,role,JSON.stringify([{role,companyId:null}])]);
  if(appRole)await tx.unsafe('SET LOCAL ROLE ai_hr_app');
 }
 async function unchangedRows(){return {
  people:await storage.client`select * from person where tenant_id in (${enabled.tenant},${legacy.tenant}) order by id`,
  statutory:await storage.client`select * from employee_statutory_my where tenant_id in (${enabled.tenant},${legacy.tenant}) order by id`,
  requests:await storage.client`select * from profile_change_request where tenant_id in (${enabled.tenant},${legacy.tenant}) order by id`,
  settings:await storage.client`select * from tenant_setting where tenant_id in (${enabled.tenant},${legacy.tenant}) order by tenant_id,key`,
  audit:await storage.client`select * from domain_event where tenant_id in (${enabled.tenant},${legacy.tenant}) order by sequence`,
  // The OCBC migration adds four nullable/default columns; every pre-existing bank column is compared.
  banks:await storage.client`select id,to_jsonb(b)-array['file_contact_name','file_contact_phone','file_state_code','require_payee_id_check'] as legacy from company_bank_profile b where tenant_id in (${enabled.tenant},${legacy.tenant}) order by id`,
 };}
 async function custody(fixture:ReturnType<typeof identities>,user:string,expected:string[],denied:string[]=[]){
  await storage.client.begin(async tx=>{
   await actor(tx,fixture,user,'hr_admin',true);
   const [principal]=await tx`select current_user as db_role,app.principal_snapshot_current() as snapshot_current,app.can_admin_employment(${fixture.employeeEmployment}::uuid) as scope,app.access_profile_review_permitted(${fixture.employeeEmployment}::uuid) as reviewer`;
   expect(principal).toMatchObject({db_role:'ai_hr_app',snapshot_current:true,scope:true,reviewer:true});
   const visible=await tx`select id from profile_change_request where tenant_id=${fixture.tenant} order by id`;
   expect(visible.map(row=>row.id)).toEqual([...expected].sort());
   for(const id of expected){const [proof]=await tx`select app.profile_request_assignee(${id}::uuid) as assigned`;expect(proof.assigned).toBe(true);}
   for(const id of [...denied,unknownId]){const [proof]=await tx`select app.profile_request_assignee(${id}::uuid) as assigned`;expect(proof.assigned).toBe(false);}
  });
 }
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,start))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,start)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const [clock]=await storage.client`select (now() at time zone 'Asia/Kuala_Lumpur')::date::text as day`;
  const day=clock.day as string,hiredOn=String(Number(day.slice(0,4))-1)+'-01-01';
  // Seed a historical installation as its storage owner. No trigger, RLS or principal guard is disabled.
  for(const fixture of [enabled,legacy])await storage.client.begin(async tx=>{
   await tx`insert into tenant(id,workos_org_id,name) values(${fixture.tenant},${randomUUID()},'Fictional original-feature upgrade tenant')`;
   await tx`insert into company(id,tenant_id,legal_name,country) values(${fixture.company},${fixture.tenant},'Fictional upgrade company','MY')`;
   await tx`insert into department(id,tenant_id,company_id,name) values(${fixture.department},${fixture.tenant},${fixture.company},'Fictional upgrade department')`;
   const principals=[[fixture.employeePerson,fixture.employeeUser,fixture.employeeEmployment,'employee','Employee'],[fixture.hrPerson,fixture.hrUser,fixture.hrEmployment,'hr_admin','Assigned HR'],[fixture.otherPerson,fixture.otherUser,fixture.otherEmployment,'hr_admin','Unrelated HR']];
   for(const [person,user,,role,label] of principals){
    await tx`insert into person(id,tenant_id,full_name,primary_email) values(${person},${fixture.tenant},${'Fictional '+label},${randomUUID()+'@upgrade.test'})`;
    await tx`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${fixture.tenant},${person},${randomUUID()})`;
    await tx`insert into role_assignment(tenant_id,app_user_id,role) values(${fixture.tenant},${user},${role})`;
   }
   await actor(tx,fixture,fixture.hrUser,'hr_admin');
   for(const [person,,employment] of principals){
    await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${employment},${fixture.tenant},${person},${fixture.company},${hiredOn})`;
    await tx`insert into assignment(tenant_id,employment_id,department_id,employment_type,valid_from) values(${fixture.tenant},${employment},${fixture.department},'full_time',${hiredOn})`;
   }
   await tx`insert into employee_statutory_my(id,tenant_id,person_id,epf_mode,epf_employee_rate,epf_employer_rate) values(${fixture.statutory},${fixture.tenant},${fixture.employeePerson},${fixture===enabled?'auto':'voluntary_excess'},${fixture===enabled?null:'0.1450'},${fixture===enabled?null:'0.1600'})`;
   await tx`insert into company_bank_profile(id,tenant_id,company_id,bank,corporate_id,debit_account_no,org_name,txn_type) values(${fixture.bank},${fixture.tenant},${fixture.company},'ocbc','FICTIONAL-OCBC','100000000000001','Fictional payroll account','IBG')`;
   await tx`insert into tenant_setting(tenant_id,key,value) values(${fixture.tenant},'ess.profile_change_routing',${JSON.stringify({version:2,enabled:false,revision,rules:[]})}::jsonb)`;
   const request=fixture===enabled?blockedUnassignedId:legacyId;
   await tx`insert into profile_change_request(id,tenant_id,employment_id,person_id,proposed) values(${request},${fixture.tenant},${fixture.employeeEmployment},${fixture.employeePerson},${JSON.stringify(proposed)}::jsonb)`;
   await tx`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) values(${fixture.tenant},'profile-change',${request},'profile-change.requested','user',${fixture.employeeUser},${fixture.employeeEmployment},'{"fields":["preferredName"]}'::jsonb)`;
  });
  await storage.client.begin(async tx=>{
   await actor(tx,enabled,enabled.hrUser,'hr_admin');
   const rule={id:routeId,name:'Fictional historical HR route',approverEmploymentId:enabled.hrEmployment,employmentIds:[enabled.employeeEmployment],criteria:{},excludedEmploymentIds:[],excludedCriteria:{},requestTypes:['fields']};
   await tx`update tenant_setting set value=${JSON.stringify({version:2,enabled:true,revision,rules:[rule]})}::jsonb where tenant_id=${enabled.tenant} and key='ess.profile_change_routing'`;
   const [snapshot]=await tx`select app.access_profile_route_fingerprint(${enabled.employeeEmployment}::uuid) as fingerprint`;
   expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
   const context={asOf:day,companyId:enabled.company,fingerprint:snapshot.fingerprint};
   await tx`insert into profile_change_request(id,tenant_id,employment_id,person_id,proposed,route_id,route_revision,route_approver_user_id,route_approver_employment_id,route_context,route_history) values(${assignedId},${enabled.tenant},${enabled.employeeEmployment},${enabled.employeePerson},${JSON.stringify(proposed)}::jsonb,${routeId},${revision},${enabled.hrUser},${enabled.hrEmployment},${JSON.stringify(context)}::jsonb,${JSON.stringify(history)}::jsonb)`;
   // A pre-existing malformed context must not become an authorization grant after the adapter upgrade.
   await tx`insert into profile_change_request(id,tenant_id,employment_id,person_id,proposed,route_id,route_revision,route_approver_user_id,route_approver_employment_id,route_context) values(${malformedId},${enabled.tenant},${enabled.employeeEmployment},${enabled.employeePerson},${JSON.stringify(proposed)}::jsonb,${routeId},${revision},${enabled.hrUser},${enabled.hrEmployment},${JSON.stringify({...context,version:3,decisionMode:'any',approvers:[{userId:enabled.hrUser,employmentId:'not-a-uuid'}]})}::jsonb)`;
  });
  const before=await unchangedRows();expect(before.people).toHaveLength(6);expect(before.statutory).toHaveLength(2);expect(before.requests).toHaveLength(4);expect(before.banks).toHaveLength(2);expect(before.audit.length).toBeGreaterThanOrEqual(2);
  expect(before.requests.map(row=>row.id).sort()).toEqual([assignedId,blockedUnassignedId,malformedId,legacyId].sort());
  expect(before.requests.find(row=>row.id===assignedId)).toMatchObject({status:'pending',proposed,route_history:history,route_approver_user_id:enabled.hrUser});
  const [originalMode]=await storage.client`select count(*)::integer as count from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='epf_mode' and e.enumlabel='manual_percentage'`;expect(originalMode.count).toBe(0);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await unchangedRows()).toEqual(before);
  const elections=await storage.client`select id,epf_mode::text as mode,epf_employee_rate::text as employee_rate,epf_employer_rate::text as employer_rate from employee_statutory_my where tenant_id in (${enabled.tenant},${legacy.tenant}) order by id`;
  expect(elections).toEqual(expect.arrayContaining([{id:enabled.statutory,mode:'auto',employee_rate:null,employer_rate:null},{id:legacy.statutory,mode:'voluntary_excess',employee_rate:'0.1450',employer_rate:'0.1600'}]));expect(elections).toHaveLength(2);
  const [addedMode]=await storage.client`select count(*)::integer as count from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='epf_mode' and e.enumlabel='manual_percentage'`;expect(addedMode.count).toBe(1);
  // b6dbadc5 (0697) — the additive Top-up mode is added; the legacy total-rate row above is NOT converted by the migration.
  const [topupMode]=await storage.client`select count(*)::integer as count from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='epf_mode' and e.enumlabel='topup_percentage'`;expect(topupMode.count).toBe(1);
  const markers=await storage.client`select request_id from app.profile_legacy_unassigned_request order by request_id`;expect(markers.map(row=>row.request_id)).toEqual([legacyId]);
  await custody(enabled,enabled.hrUser,[assignedId],[blockedUnassignedId,malformedId,legacyId]);
  await custody(enabled,enabled.otherUser,[],[assignedId,blockedUnassignedId,malformedId]);
  await custody(legacy,legacy.hrUser,[legacyId],[assignedId]);
  const bankDefaults=await storage.client`select id,file_contact_name,file_contact_phone,file_state_code,require_payee_id_check from company_bank_profile order by id`;
  expect(bankDefaults).toEqual([enabled.bank,legacy.bank].sort().map(id=>({id,file_contact_name:null,file_contact_phone:null,file_state_code:null,require_payee_id_check:false})));
  expect(await storage.client`select id from bank_payment_export`).toEqual([]);expect(await storage.client`select tenant_id from bank_payment_sequence`).toEqual([]);
  const ledger=await storage.client`select * from drizzle.__drizzle_migrations order by id`;expect(ledger).toHaveLength(journal.entries.length);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await unchangedRows()).toEqual(before);expect(await storage.client`select * from drizzle.__drizzle_migrations order by id`).toEqual(ledger);
  expect(await storage.client`select request_id from app.profile_legacy_unassigned_request order by request_id`).toEqual(markers);
  expect(await storage.client`select id,file_contact_name,file_contact_phone,file_state_code,require_payee_id_check from company_bank_profile order by id`).toEqual(bankDefaults);
  await custody(enabled,enabled.hrUser,[assignedId],[blockedUnassignedId,malformedId]);await custody(legacy,legacy.hrUser,[legacyId]);
 }finally{
  await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180_000);
