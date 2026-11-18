/** Populated pre6501 proof: real morning admission, human no-workflow decision and native digest.
 * Retained provenance/flags/mail come only from those owners; constraint clones are rolled back. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import type {SessionContext} from '../db/client';

it('retains genuine scheduled Contract provenance and its scoped company without changing the native retention identity or granting private reads',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number}[]};
 const tag='6501_contract_company_scope_retention',boundary=journal.entries.findIndex(entry=>entry.tag===tag);
 expect(journal.entries.filter(entry=>entry.tag===tag)).toHaveLength(1);expect(boundary).toBeGreaterThan(0);
 const priorSource=readFileSync('db/migrations/0953_lifecycle_service_info_intents.sql','utf8');
 const oldBody=priorSource.split('CREATE FUNCTION app.replan_retained_company_in_use(wanted_company uuid) RETURNS boolean')[1].split('AS $$')[1].split('$$;')[0];
 const digestBranch='   OR EXISTS(SELECT 1 FROM app.contract_system_digest h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)\n';
 const newBody=oldBody.replace('  );\n',digestBranch+'  );\n');
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 expect(hash(oldBody)).toBe('40f101a574fce8bb7c3631545db0f963040971b6118564af4132bd01f497fa92');
 expect(hash(newBody)).toBe('01ce52f540bce675ee5abcb0010323c01e32ac68d23d716cf7cc9bfd43ee9707');
 const keys=['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL','DATABASE_URL','MIGRATION_DATABASE_URL'] as const;
 const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);expect(['localhost','127.0.0.1']).toContain(url.hostname);expect(url.username).not.toBe('ai_hr_app');
 const name='ai_hr_contract_company_scope_'+randomUUID().replaceAll('-','');url.pathname='/postgres';
 const adminConnection=postgres(url.toString(),{max:1,onnotice:()=>{}});url.pathname='/'+name;
 const directory=mkdtempSync(join(tmpdir(),'contract-company-scope-'));
 let created=false,storage:postgres.Sql|undefined,close:(()=>Promise<unknown>)|undefined;
 try{
  await adminConnection.unsafe(`CREATE DATABASE "${name}"`);created=true;
  storage=postgres(url.toString(),{max:1,onnotice:()=>{}});
  await storage.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO ai_hr_app`);
  await storage.unsafe('GRANT USAGE, CREATE ON SCHEMA public TO ai_hr_app');
  await storage.unsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app');
  await storage.unsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app');
  mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(drizzle(storage),{migrationsFolder:directory});
  // The application and harness singleton must first resolve against this owned disposable database.
  for(const key of keys){const target=new URL(original[key]!);target.pathname='/'+name;process.env[key]=target.toString();}
  const h=await import('./harness');close=h.closeAll;
  const {seedCatalogs}=await import('../scripts/seed-catalogs');await seedCatalogs(h.owner.db);
  const {withTenant}=await import('../db/client');
  const {hireEmployee,setEmploymentInfo}=await import('../core/org');
  const {v9Setup,v9Workspace,v9SaveConfig}=await import('../packs/lifecycle/service');
  const contracts=await import('../packs/contracts/service');
  const {runBulkJobTick}=await import('../core/bulk-job-worker');
  const {readBulkJob}=await import('../core/bulk-job');
  const {companyDeleteStatus}=await import('../core/read');
  const {deleteCompany}=await import('../core/admin');
  const {todayInKualaLumpur,addCalendarMonths}=await import('../lib/hr-date');
  const {addDaysIso}=await import('../lib/roster-month');
  const {pgSqlState}=await import('../lib/db-error');
  const b=await h.seedBase();await h.setModule(b.tenantId,'lifecycle','active');
  const [person]=await h.owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId},'Fictional native retention administrator',${randomUUID()+'@retention.invalid'}) returning id`;
  await h.owner.client`update app_user set person_id=${person.id} where tenant_id=${b.tenantId} and id=${b.adminUserId}`;
  const admin:SessionContext={...await h.entitledCtx(b),personId:person.id};
  const origin='https://contract-retention-fixture.invalid',identitySubject=randomUUID();
  await h.owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+b.tenantId},${identitySubject},${admin.userId!})`;
  expect(await h.owner.client`select issuer,subject,app_user_id,revoked_at from app_external_identity where issuer=${origin+'/auth/'+b.tenantId} and subject=${identitySubject}`).toEqual([{issuer:origin+'/auth/'+b.tenantId,subject:identitySubject,app_user_id:admin.userId,revoked_at:null}]);
  await v9Setup(admin);const cfg=(await v9Workspace(admin)).config!,groupId=randomUUID();
  await v9SaveConfig(admin,cfg.revision,{...cfg,groups:[...cfg.groups,{id:groupId,name:'Native retention People Ops',members:[admin.userId!],limit:0}],peopleOpsGroup:groupId});
  const settings=await contracts.contractSharedSettings(admin,b.companyId);
  await contracts.saveContractSharedSettings(admin,{companyId:b.companyId,expectedRevision:settings.revision,settings:{...settings.settings,fallbackGroupId:groupId,postingApproverGroupId:groupId}});
  const roleId=randomUUID(),memberId=randomUUID(),tenantMemberId=randomUUID(),today=todayInKualaLumpur(),start=addCalendarMonths(today,-12),end=addDaysIso(today,-1);
  await contracts.saveContractSharedRole(admin,{id:roleId,name:'Native scoped retention viewer',permissions:['view'],expectedRevision:0});
  for(const [id,companyId] of [[memberId,b.companyId],[tenantMemberId,null]] as const)await contracts.saveContractSharedMember(admin,{id,roleId,userId:admin.userId,companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:false,expectedRevision:0});
  const employee=await hireEmployee(admin,{person:{fullName:'Fictional retention fixed-term subject',primaryEmail:randomUUID()+'@retention.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end});
  await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});
  const scheduleId=await h.owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id','',true)`;return(await tx<{id:string}[]>`select app.contract_shared_system_enqueue('contract_schedule',${randomUUID()}::uuid,jsonb_build_object('day',${today}::text),'morning',${today}::date) as id`)[0].id;});
  let caseId:string|undefined;
  for(let n=0;n<20&&!caseId;n++){await runBulkJobTick(h.owner.client,{handlers:[contracts.contractScheduleJobHandler]});caseId=(await h.owner.client<{id:string}[]>`select id from contract_case where tenant_id=${b.tenantId} and employment_id=${employee.employmentId}`)[0]?.id;}
  if(!caseId)throw Error('Actual scheduled period did not open');
  const openingEvents=await h.owner.client<{job_id:string;actor_type:string;actor_user_id:string|null;actor_person_id:string|null}[]>`select job_id,actor_type,actor_user_id,actor_person_id from contract_shared_event where tenant_id=${b.tenantId} and case_id=${caseId} and trigger_event='caseOpened'`;
  expect(openingEvents).toHaveLength(1);expect(openingEvents[0]).toMatchObject({actor_type:'system',actor_user_id:null,actor_person_id:null});
  // Finish the genuinely admitted opening event before a human changes its decision revision.
  // The original morning job remains live; it has not reached its later digest phase yet.
  for(let n=0;n<150;n++){
   const [opening]=await h.owner.client<{state:string;error:string|null}[]>`select state,error from bulk_job where id=${openingEvents[0].job_id}`;
   if(opening.state==='failed')throw Error(opening.error??'Native opening job failed');if(opening.state==='completed')break;
   if(!await runBulkJobTick(h.owner.client,{handlers:[contracts.contractScheduledAutomationJobHandler]}))await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect((await h.owner.client`select state from bulk_job where id=${openingEvents[0].job_id}`)[0].state).toBe('completed');
  const view=await contracts.contractSharedContext(admin,caseId);expect(view.flow).not.toBeNull();
  const revision=view.flow!.revision;
  const preview=await contracts.previewContractSharedDecision(admin,{caseId,revision,draft:{kind:'renew',months:6,payChanges:false,reason:'Genuine no-workflow retention proof'}});
  async function finishHuman(jobId:string,kind:'contract_preview'|'contract_automation'){
   const handler=kind==='contract_preview'?contracts.contractPreviewJobHandler:contracts.contractAutomationJobHandler;
   for(let n=0;n<150;n++){const job=await readBulkJob(admin,jobId,kind);if(job.state==='failed')throw Error(job.error??'Native human job failed');if(job.state==='completed')return;if(!await runBulkJobTick(h.owner.client,{handlers:[handler]}))await new Promise(resolve=>setTimeout(resolve,20));}
   throw Error('Native human job did not finish');
  }
  await finishHuman(preview.jobId,'contract_preview');
  const submitted=await contracts.submitContractSharedDecision(admin,{caseId,revision,previewId:preview.previewId});await finishHuman(submitted.jobId,'contract_automation');
  expect((await contracts.contractSharedContext(admin,caseId)).flow!.flags).toContain('no_workflow');
  for(let n=0;n<150;n++){
   const [job]=await h.owner.client<{state:string;error:string|null}[]>`select state,error from bulk_job where id=${scheduleId}`;
   if(job.state==='failed')throw Error(job.error??'Native morning job failed');if(job.state==='completed')break;
   if(!await runBulkJobTick(h.owner.client,{handlers:[contracts.contractScheduleJobHandler,contracts.contractScheduledAutomationJobHandler]}))await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect((await h.owner.client`select state,created_by from bulk_job where id=${scheduleId}`)[0]).toEqual({state:'completed',created_by:null});
  const digest=await h.owner.client`select * from app.contract_system_digest where tenant_id=${b.tenantId}`;
  expect(digest).toHaveLength(1);expect(digest[0]).toMatchObject({job_id:scheduleId,company_id:b.companyId,case_id:caseId,recipient_ids:[admin.userId]});
  const deliveries=await h.owner.client<{payload:{mail:{to:string[]};context:{recipientPeople:Record<string,string>}}}[]>`select payload from automation_email_delivery where tenant_id=${b.tenantId}`;
  expect(deliveries).toHaveLength(1);expect(deliveries[0].payload.mail.to).toEqual([admin.userId]);
  expect(deliveries[0].payload.context.recipientPeople[admin.userId!]).toBe(person.id);
  expect(await h.owner.client`select id from personnel_posting where tenant_id=${b.tenantId}`).toHaveLength(0);
  const snapshot=async()=>({
   settings:await h.owner.client`select to_jsonb(s) as row from contract_shared_settings s where tenant_id=${b.tenantId} order by company_id`,
   members:await h.owner.client`select to_jsonb(m) as row from contract_access_member m where tenant_id=${b.tenantId} order by id`,
   digest:await h.owner.client`select to_jsonb(d) as row from app.contract_system_digest d where tenant_id=${b.tenantId} order by mail_key`,
   sources:await h.owner.client`select to_jsonb(s) as row from app.contract_system_job_source s where tenant_id=${b.tenantId} order by job_id`,
   seals:await h.owner.client`select to_jsonb(s) as row from app.bulk_job_seal s where tenant_id=${b.tenantId} order by job_id`,
   jobs:await h.owner.client`select to_jsonb(j) as row from bulk_job j where tenant_id=${b.tenantId} order by id`,
   events:await h.owner.client`select to_jsonb(e) as row from contract_shared_event e where tenant_id=${b.tenantId} order by id`,
   flows:await h.owner.client`select to_jsonb(f) as row from contract_shared_case f where tenant_id=${b.tenantId} order by case_id`,
   cases:await h.owner.client`select to_jsonb(c) as row from contract_case c where tenant_id=${b.tenantId} order by id`,
   mail:await h.owner.client`select to_jsonb(d) as row from automation_email_delivery d where tenant_id=${b.tenantId} order by id`,
   identity:await h.owner.client`select to_jsonb(i) as row from app_external_identity i where issuer=${origin+'/auth/'+b.tenantId} order by subject`,
   audit:await h.owner.client`select to_jsonb(e) as row from domain_event e where tenant_id=${b.tenantId} order by id`,
  });
  const proc=async()=>(await h.owner.client<{metadata:Record<string,unknown>;body:string;definition:string}[]>`select to_jsonb(p)-'prosrc' as metadata,prosrc as body,pg_get_functiondef(p.oid) as definition from pg_proc p where p.oid='app.replan_retained_company_in_use(uuid)'::regprocedure`)[0];
  const foreign=await h.seedBase();
  const before=await snapshot(),functionBefore=await proc(),ledger=await storage`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`;
  expect(functionBefore.body).toBe(oldBody);expect(ledger).toHaveLength(boundary);expect(before.sources.length).toBeGreaterThan(0);
  const code=async(work:()=>Promise<unknown>)=>{try{await work();return 'accepted';}catch(error){return pgSqlState(error);}};
  // Explicit negative legacy-data injection: an existing globally valid company UUID belongs to
  // another tenant. Ordinary VALIDATE must reject it and roll back both function and journal changes.
  for(const table of ['app.contract_system_digest','public.contract_access_member','public.contract_shared_settings'] as const){
   const key=table==='app.contract_system_digest'?'mail_key':table==='public.contract_access_member'?'id':'company_id';
   const selected=table==='app.contract_system_digest'?digest[0].mail_key:table==='public.contract_access_member'?memberId:b.companyId;
   await h.owner.client.unsafe(`update ${table} set company_id=$1::uuid where tenant_id=$2::uuid and ${key}=$3`,[foreign.companyId,b.tenantId,selected]);
   const corrupted=await snapshot();
   expect(await code(()=>migrate(drizzle(storage!),{migrationsFolder:'db/migrations'}))).toBe('23503');
   expect(await snapshot()).toEqual(corrupted);expect(await proc()).toEqual(functionBefore);
   expect(await storage`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`).toEqual(ledger);
   const restoreKey=key==='company_id'?foreign.companyId:selected;
   await h.owner.client.unsafe(`update ${table} set company_id=$1::uuid where tenant_id=$2::uuid and ${key}=$3`,[b.companyId,b.tenantId,restoreKey]);
   expect(await snapshot()).toEqual(before);
  }
  // Ordinary journal migration, not executing the proposal body in a bespoke installer.
  await migrate(drizzle(storage),{migrationsFolder:'db/migrations'});
  expect(await snapshot()).toEqual(before);
  const functionAfter=await proc();expect(functionAfter.metadata).toEqual(functionBefore.metadata);expect(functionAfter.body).toBe(newBody);
  expect(functionAfter.definition).toBe(functionBefore.definition.replace(oldBody,newBody));
  expect((await storage`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`).slice(0,ledger.length)).toEqual(ledger);
  const constraints=await h.owner.client`select conname,convalidated,confdeltype,pg_get_constraintdef(oid) as definition from pg_constraint where conname in('contract_system_digest_company_tenant_fk','contract_access_member_company_tenant_fk','contract_shared_settings_company_tenant_fk') order by conname`;
  expect(constraints).toHaveLength(3);for(const constraint of constraints){expect(constraint.convalidated).toBe(true);expect(constraint.confdeltype).toBe('a');expect(constraint.definition).toBe('FOREIGN KEY (company_id, tenant_id) REFERENCES company(id, tenant_id)');}
  const [emptyCompany]=await h.owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) values(${b.tenantId},'Fictional unretained employer') returning id`;
  const rollback=Symbol('constraint probe rollback');
  for(const table of ['app.contract_system_digest','public.contract_access_member','public.contract_shared_settings'] as const){
   for(const operation of ['insert','update'] as const){
    const probe=async(companyId:string)=>h.owner.client.begin(async tx=>{
     const patch={company_id:companyId,...(operation==='insert'&&table==='app.contract_system_digest'?{mail_key:'constraint-probe:'+randomUUID()}:{}),...(operation==='insert'&&table==='public.contract_access_member'?{id:randomUUID()}:{}),...(operation==='insert'&&table==='public.contract_shared_settings'?{company_id:companyId===b.companyId?emptyCompany.id:companyId}:{})};
     const key=table==='app.contract_system_digest'?'mail_key':table==='public.contract_access_member'?'id':'company_id';
     const selected=table==='app.contract_system_digest'?digest[0].mail_key:table==='public.contract_access_member'?memberId:b.companyId;
     if(operation==='insert')await tx.unsafe(`insert into ${table} select (jsonb_populate_record(null::${table},to_jsonb(t)||$1::jsonb)).* from ${table} t where tenant_id=$2::uuid and ${key}=$3`,[JSON.stringify(patch),b.tenantId,selected]);
     else await tx.unsafe(`update ${table} set company_id=$1::uuid where tenant_id=$2::uuid and ${key}=$3`,[companyId,b.tenantId,selected]);
     throw rollback;
    });
    // Only rollback sentinel means the genuine same-tenant constraint accepted the cloned source image.
    await expect(probe(b.companyId)).rejects.toBe(rollback);
    await expect(probe(foreign.companyId)).rejects.toMatchObject({code:'23503'});
   }
  }
  expect(await snapshot()).toEqual(before);
  const postUpgradeTenantMember=randomUUID();
  await contracts.saveContractSharedMember(admin,{id:postUpgradeTenantMember,roleId,userId:admin.userId,companyId:null,businessGroupId:null,validFrom:start,validTo:null,revoked:false,expectedRevision:0});
  expect((await h.owner.client`select company_id from contract_access_member where tenant_id=${b.tenantId} and id=${postUpgradeTenantMember}`)[0].company_id).toBeNull();
  const retained=(ctx:SessionContext,id:string|null)=>withTenant(ctx,async tx=>(await tx.execute<{used:boolean}>(sql`select app.replan_retained_company_in_use(${id}::uuid) as used`))[0].used);
  expect(await retained(admin,b.companyId)).toBe(true);expect(await retained(admin,emptyCompany.id)).toBe(false);
  expect(await retained(admin,foreign.companyId)).toBe(false);expect(await retained(admin,null)).toBe(false);
  const scopedId=await h.createAppUser(b.tenantId,person.id,'hr_admin');
  await h.owner.client`update role_assignment set company_id=${emptyCompany.id} where tenant_id=${b.tenantId} and app_user_id=${scopedId}`;
  const scoped:SessionContext={...admin,userId:scopedId,grants:[{role:'hr_admin',companyId:emptyCompany.id}]};
  expect(await withTenant(scoped,async tx=>(await tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`))[0].current)).toBe(true);
  expect(await retained(scoped,b.companyId)).toBe(false);
  const ordinaryId=await h.createAppUser(b.tenantId,employee.personId,'employee');
  const ordinary:SessionContext={...admin,userId:ordinaryId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  expect(await withTenant(ordinary,async tx=>(await tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`))[0].current)).toBe(true);
  expect(await retained(ordinary,b.companyId)).toBe(false);
  expect(await retained(await h.entitledCtx(foreign),b.companyId)).toBe(false);
  expect(await code(()=>withTenant(admin,tx=>tx.execute(sql`select * from app.contract_system_digest`)))).toBe('42501');
  const [acl]=await h.owner.client`select has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public,has_table_privilege('ai_hr_app','app.contract_system_digest','SELECT') as digest_read from pg_proc p where p.oid='app.replan_retained_company_in_use(uuid)'::regprocedure`;
  expect(acl).toEqual({app:true,public:false,digest_read:false});
  expect(await companyDeleteStatus(admin,b.companyId)).toEqual({canDelete:true,blockedBy:'employees'});
  await expect(deleteCompany(admin,{id:b.companyId})).rejects.toMatchObject({name:'CompanyInUseError',reason:'employees'});
  await h.setModule(b.tenantId,'lifecycle','disabled');expect(await retained(admin,b.companyId)).toBe(true);
  expect(await companyDeleteStatus(admin,b.companyId)).toEqual({canDelete:true,blockedBy:'employees'});
  expect((await h.owner.client`select company_id from contract_access_member where tenant_id=${b.tenantId} and id=${tenantMemberId}`)[0].company_id).toBeNull();
  await h.owner.client`update role_assignment set role='employee' where tenant_id=${b.tenantId} and app_user_id=${admin.userId!}`;
  expect(await withTenant(admin,async tx=>(await tx.execute<{current:boolean;used:boolean}>(sql`select app.principal_snapshot_current() as current,app.replan_retained_company_in_use(${b.companyId}::uuid) as used`))[0])).toEqual({current:false,used:false});
 }finally{
  if(close)await close();if(storage)await storage.end({timeout:5});
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  if(created)await adminConnection.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await adminConnection.end();rmSync(directory,{recursive:true,force:true});
 }
 // Isolated full-prefix rehearsal plus genuine kernel units; no local execution is permitted.
},300000);
