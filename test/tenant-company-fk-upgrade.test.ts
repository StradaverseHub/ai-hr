import {PERFORMANCE_MIGRATION_IDENTITIES} from './performance-migration-identities';
import {APPROVED_UPGRADE_TAIL,assertApprovedUpgradeTail,migrateApprovedUpgrade} from './helpers/approved-upgrade';
/** ADR-0174 populated upgrade through 2100–2102, on an owned disposable localhost database only.
 * A cross-tenant row present at the boundary must stop the whole upgrade with a readable report and leave
 * the ledger untouched; once that row is resolved the upgrade validates every key, rewrites no row and
 * changes no table, column or policy grant. This supplies no staging acceptance. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';

type Entry={idx:number;version:string;when:number;tag:string;breakpoints:boolean};
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const TAIL=[
 {idx:1347,version:'7',when:1793330001500,tag:'2100_employment_helper_tenant_pin',breakpoints:true},
 {idx:1348,version:'7',when:1793330001501,tag:'2101_company_tenant_fk_not_valid',breakpoints:true},
 {idx:1349,version:'7',when:1793330001502,tag:'2102_company_tenant_fk_validate',breakpoints:true},
];

it('stops on a cross-tenant row, then validates every company/tenant key without changing data or grants',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:Entry[]};
 const boundary=journal.entries.findIndex(row=>row.tag===TAIL[0].tag);
 expect(boundary).toBe(668);
 assertApprovedUpgradeTail(journal.entries);
 expect(journal.entries.slice(boundary,boundary+TAIL.length)).toEqual(TAIL);
 expect(journal.entries[boundary-1]).toEqual({idx:811,version:'7',when:1793330001411,tag:'2011_payroll_loops_hardening',breakpoints:true});
 const prefix=journal.entries.slice(0,boundary);
 const folder=mkdtempSync(join(tmpdir(),'tenant-company-fk-upgrade-')),database='ai_hr_tenant_fk_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(['127.0.0.1','localhost']).toContain(appUrl.hostname);
 expect(ownerUrl.username).not.toBe('ai_hr_app');expect(appUrl.username).toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+database;appUrl.pathname='/'+database;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});let created=false;
 const tenantA=randomUUID(),tenantB=randomUUID(),root=randomUUID(),child=randomUUID(),foreign=randomUUID();
 const personA=randomUUID(),personB=randomUUID(),userA=randomUUID(),employmentA=randomUUID(),employmentB=randomUUID(),defect=randomUUID();
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 const keys=()=>storage.client`select conrelid::regclass::text as rel,conname,convalidated,confdeltype::text as action from pg_constraint
  where contype='f' and confrelid='public.company'::regclass and conname like '%\\_company\\_tenant\\_fk' order by 1`;
 const native=async()=>{
  const rows:Record<string,unknown>={};
  for(const table of ['tenant','company','person','app_user','role_assignment','department','position','cost_center','location','employment']){
   const facts=table==='company'?"to_jsonb(t)-ARRAY['display_group_field','display_group_option_id']":"to_jsonb(t)";
   rows[table]=await storage.client.unsafe(`select ${facts} as row from public.${table} t where ${table==='tenant'?'id':'tenant_id'}=any($1::uuid[]) order by to_jsonb(t)::text`,[[tenantA,tenantB]]);
  }
  return rows;
 };
 // Everything a grant or policy could change, except the one function ACL 2100 deliberately narrows.
 const privileges=async()=>({
  relations:await storage.client`select c.oid::regclass::text as rel,c.relacl::text as acl,c.relrowsecurity as rls,c.relforcerowsecurity as force
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','p','v','m','S') order by 1`,
  columns:await storage.client`select a.attrelid::regclass::text as rel,a.attname::text as col,a.attacl::text as acl from pg_attribute a
   join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and a.attacl is not null order by 1,2`,
  functions:await storage.client`select p.oid::regprocedure::text as fn,p.proacl::text as acl from pg_proc p
   where p.pronamespace in ('public'::regnamespace,'app'::regnamespace) and p.oid<>'app.company_subtree(uuid)'::regprocedure order by 1`,
  policies:await storage.client`select schemaname::text,tablename::text,policyname::text,permissive::text,roles::text,cmd::text,qual,with_check from pg_policies
   where schemaname in ('public','app') order by 1,2,3`,
 });
 try{
  await admin.unsafe(`CREATE DATABASE "${database}"`);created=true;
  mkdirSync(join(folder,'meta'));for(const row of prefix)copyFileSync('db/migrations/'+row.tag+'.sql',join(folder,row.tag+'.sql'));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));
  await migrate(storage.db,{migrationsFolder:folder});
  const beforeLedger=await ledger();expect(beforeLedger).toHaveLength(668);
  expect(beforeLedger.map(row=>row.hash)).toEqual(prefix.map(row=>hash(readFileSync('db/migrations/'+row.tag+'.sql'))));
  expect(await keys()).toEqual([]);

  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenantA},${randomUUID()},'Fictional upgrade group A'),(${tenantB},${randomUUID()},'Fictional upgrade group B')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${root},${tenantA},'Fictional A holding'),(${foreign},${tenantB},'Fictional B company')`;
  await storage.client`insert into company(id,tenant_id,legal_name,parent_company_id) values(${child},${tenantA},'Fictional A subsidiary',${root})`;
  await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${personA},${tenantA},'Fictional A employee','tenant-fk-a@example.invalid'),(${personB},${tenantB},'Fictional B employee','tenant-fk-b@example.invalid')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${userA},${tenantA},null,${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenantA},${userA},'hr_admin')`;
  await storage.client`insert into department(tenant_id,company_id,name) values(${tenantA},${root},'Fictional finance'),(${tenantA},${child},'Fictional operations'),(${tenantB},${foreign},'Fictional B finance')`;
  await storage.client`insert into position(tenant_id,company_id,title) values(${tenantA},${child},'Fictional executive')`;
  await storage.client`insert into cost_center(tenant_id,company_id,code,name) values(${tenantA},${root},'CC1','Fictional HQ')`;
  await storage.client`insert into location(tenant_id,company_id,code,name) values(${tenantA},${root},'HQ','Fictional head office')`;
  await storage.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${employmentA},${tenantA},${personA},${child},'2024-01-01'),(${employmentB},${tenantB},${personB},${foreign},'2024-01-01')`;

  // The defect the old plain FK accepted: tenant A's row naming tenant B's company.
  await storage.client`insert into location(id,tenant_id,company_id,code,name) values(${defect},${tenantA},${foreign},'XB','Fictional misfiled site')`;
  for(const row of TAIL)copyFileSync('db/migrations/'+row.tag+'.sql',join(folder,row.tag+'.sql'));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:[...prefix,...TAIL]}));
  const withDefect=await native(),beforePrivileges=await privileges();
  const refused=await migrate(storage.db,{migrationsFolder:folder}).then(()=>null,(e:unknown)=>e);
  const chain:{message?:string;detail?:string;code?:string}[]=[];
  for(let cur=refused as {message?:string;detail?:string;code?:string;cause?:unknown}|null,i=0;cur&&i<4;cur=cur.cause as typeof cur,i++)chain.push(cur);
  const report=chain.find(link=>link.code==='23503');
  expect(report?.message).toBe('Rows reference a company of another tenant; review them before validating');
  expect(report?.detail).toMatch(/^public\.location: Key \(company_id, tenant_id\)=\([0-9a-f-]{36}, [0-9a-f-]{36}\) is not present in table "company"\.$/);
  expect(await ledger()).toEqual(beforeLedger);expect(await keys()).toEqual([]);
  expect(await native()).toEqual(withDefect);
  expect(await storage.client`select has_function_privilege('ai_hr_app','app.company_subtree(uuid)','EXECUTE') as callable`).toEqual([{callable:true}]);

  // The owner resolves the defect deliberately; the upgrade itself never rewrites or deletes it.
  // Complete the original exact 2100-2102 proof before later migrations intentionally add
  // private tables/functions and change policies. The forward-to-current phase follows below.
  await storage.client`delete from location where id=${defect}`;
  const upgradeNative=await native();
  await migrate(storage.db,{migrationsFolder:folder});
  const afterLedger=await ledger();
  expect(afterLedger).toHaveLength(668+TAIL.length);expect(afterLedger.slice(0,668)).toEqual(beforeLedger);
  expect(afterLedger.slice(668).map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(
   TAIL.map(row=>({hash:hash(readFileSync('db/migrations/'+row.tag+'.sql')),created_at:String(row.when)})));
  expect(await native()).toEqual(upgradeNative);
  expect(await privileges()).toEqual(beforePrivileges);
  const installed=await keys();
  expect(installed).toHaveLength(148);
  expect(installed.filter(row=>!row.convalidated)).toEqual([]);
  expect(installed.map(row=>row.rel)).toEqual(expect.arrayContaining(['department','employment','location','role_assignment','app.attendance_policy_company_epoch']));
  expect(await storage.client`select has_function_privilege('ai_hr_app','app.company_subtree(uuid)','EXECUTE') as callable`).toEqual([{callable:false}]);

  const asAdmin=<T>(body:(tx:postgres.TransactionSql)=>Promise<T>)=>application.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${tenantA},true),set_config('app.user_id',${userA},true),set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true)`;
   return body(tx);
  });
  expect(await asAdmin(tx=>tx`select app.can_admin_employment(${employmentA}::uuid) as own,app.can_admin_employment(${employmentB}::uuid) as foreign,app.is_admin_for(${foreign}::uuid) as grant_says`))
   .toEqual([{own:true,foreign:false,grant_says:true}]);
  await expect(storage.client`insert into location(tenant_id,company_id,code,name) values(${tenantA},${foreign},'XB','Fictional misfiled site')`)
   .rejects.toMatchObject({code:'23503',constraint_name:'location_company_tenant_fk'});

  const beforeRerun=await native();await migrate(storage.db,{migrationsFolder:folder});
  expect(await ledger()).toEqual(afterLedger);expect(await native()).toEqual(beforeRerun);
  // Rehearse from the combined staging baseline as well as the historical defect boundary.
  const performanceStart=journal.entries.findIndex(row=>row.tag===PERFORMANCE_MIGRATION_IDENTITIES[0].tag);
  expect(performanceStart).toBe(729);
  expect(journal.entries.slice(performanceStart).map(row=>row.tag)).toEqual([
   ...PERFORMANCE_MIGRATION_IDENTITIES.map(row=>row.tag),
   '3500_ai_centre_architecture_compatibility',
   '3501_ai_centre_mandate_write_order',
   '4338_assistant_rewards_return_presentation_snapshot',
   '4339_assistant_rewards_calendar_cancel_presentation_snapshot',
   '4340_ai_management_presentation_snapshot',
   '4341_home_leave_presentation_snapshot',
   '4342_attendance_clock_policy_audit_scope',
   '5000_access_reader_writer_core',
   '5001_access_reader_writer_serialisers',
   '5002_access_reader_writer_profile_values',
   '5003_access_reader_writer_owner_writers',
   '5004_access_reader_writer_payroll_inputs',
   '5005_access_reader_writer_people_values',
   '5006_access_wave4_admin_fair_exclusive',
   '5010_employee_import_staged_job',
   '5011_bulk_job_kernel',
   '5012_import_release_visibility',
   '5013_bulk_job_least_privilege',
   '5014_bulk_job_owner_attribution',
   '5020_personnel_overview_facts',
   '5030_leave_bulk_jobs',
   '5031_leave_ledger_stage',
   '5032_bulk_job_unbounded_kind',
   '5033_leave_follow_up_jobs',
   '5035_leave_stage_digests',
   '5036_leave_type_pending_year_cycle',
   '5040_roster_bulk_jobs',
   '5041_bulk_job_queue_and_watch',
   '5045_attendance_bulk_jobs',
   '5050_payroll_processing_status',
   '5051_payroll_processing_job',
   '5052_payroll_run_group',
   '5053_bulk_job_settle',
   '5054_payroll_partner_point_read',
   '5055_payroll_history_staged_job',
   '5056_payroll_reprocess_job',
   '5060_register_section_import_jobs',
   '5061_register_import_set_release',
   '5062_employee_import_revert_job',
   '5063_register_import_release_key_authority',
   '5064_employee_import_revert_release_hash',
   '5070_system_label_import_staged_job',
   '5071_workforce_capability_tenant_publication',
   '5090_audit_chain_commit_seal',
  ]);
  const stagingPrefix=journal.entries.slice(0,performanceStart);
  expect(stagingPrefix.filter(row=>row.tag==='3900_individual_transaction_calculation_method')).toHaveLength(1);
  for(const row of stagingPrefix.slice(prefix.length+TAIL.length)){
   copyFileSync('db/migrations/'+row.tag+'.sql',join(folder,row.tag+'.sql'));
  }
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:stagingPrefix}));
  await migrateApprovedUpgrade(storage,folder);
  const beforePerformanceLedger=await ledger();
  expect(beforePerformanceLedger).toHaveLength(stagingPrefix.length);
  expect(beforePerformanceLedger.slice(0,afterLedger.length)).toEqual(afterLedger);
  expect(beforePerformanceLedger.slice(afterLedger.length).map(({hash,created_at})=>({hash,created_at}))).toEqual(
   stagingPrefix.slice(afterLedger.length).map(row=>({hash:hash(readFileSync('db/migrations/'+row.tag+'.sql')),created_at:String(row.when)})));
  const clockTable='attendance_clock_policy_revision';
  const clockTableAcl=()=>storage.client`select
   a.grantee::regrole::text as grantee,a.grantor::regrole::text as grantor,a.privilege_type,a.is_grantable
   from pg_class c cross join lateral aclexplode(c.relacl) a
   where c.oid='public.attendance_clock_policy_revision'::regclass order by 1,2,3,4`;
  const beforeClockTableAcl=await clockTableAcl();
  const clockSelectRevoked=(row:(typeof beforeClockTableAcl)[number])=>row.grantee==='ai_hr_app'&&row.privilege_type==='SELECT';
  expect(beforeClockTableAcl.filter(clockSelectRevoked)).toHaveLength(1);
  const beforePerformancePrivileges=await privileges();
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  const afterPerformancePrivileges=await privileges();
  const privateFunctions=['app._access_bootstrap_eligible(uuid,uuid)','app._ai_control_context_for_purpose(text,boolean,boolean)','app._access_workforce_list_rows(uuid[])','app._assistant_assigned_index_login(uuid,boolean)','app.notification_event_processing_enqueue()',
   'app.ai_centre_mandate_write_order()','app.ai_centre_mandate_bound_tenant()',
   'app._ai_control_context_policy_facts(text,boolean,boolean)','app._ai_provider_presentation_actor_valid()',
   'app._assistant_presentation_feature_unpaused_v1()',
   'app._assistant_rewards_return_choice_payload_v1()','app._assert_assistant_rewards_presentation_v1(text)',
   'app._assistant_rewards_calendar_choice_payload_v1()','app._assistant_rewards_cancel_choice_payload_v1()',
   // 5020: the set-wise organisation resolver is owner-only.
   'app._personnel_employment_tags(uuid[],date)',
   // Audit-chain commit seal: trigger functions and the key/seal helpers stay private.
   'app._domain_event_chain_key_held(uuid)','app._domain_event_chain_seal_tenant(uuid)','app.domain_event_chain_arm()','app.domain_event_chain_seal_now()'];
  // The fence triggers' WHEN calls it under whichever role writes an event, and PostgreSQL checks EXECUTE for that
  // role; it answers only whether the caller's own transaction is sealing.
  const publicFunctions=['app.domain_event_chain_sealing()'];
  const addedFunctions=[...privateFunctions,'app.access_editor_presentation_v1()','app.access_profile_policy_read_lock()','app.access_workforce_list_facts()','app.access_workforce_list_rows_for_ids(uuid[])','app.attendance_frozen_actor_identity_keys(jsonb,text)','app.delegated_approval_subjects(uuid[],text,text)',
   'app.may_have_attendance_task_metadata()',
   'app.attendance_pending_visible_headers(uuid)',
   'app.personnel_overview_narrow_rows(date,uuid[])',
   'app.personnel_overview_page_rows(date,uuid[],uuid[])',
   'app.access_workforce_picker_facts(uuid[])',
   'app.personnel_overview_filter_fields(date,uuid[])',
   'app.notification_projection_exists(uuid,uuid,text)',
   'app.assistant_rewards_return_presentation_choices_v1()',
   'app.assistant_rewards_calendar_presentation_choices_v1()',
   'app.assistant_rewards_cancel_presentation_choices_v1()',
   'app.home_leave_presentation_index(text)',
   'app.attendance_clock_policy_history(uuid,uuid)',
   // 5020: Personnel typed facts, search entries and the typed page rows.
   'app.personnel_overview_facts(date,uuid[])','app.personnel_private_search_entries(text,uuid[])',
   'app.personnel_overview_page_rows_typed(date,uuid[],uuid[])','app.personnel_list_rows_for_ids(date,uuid[],uuid[])',
   'app.domain_event_chain_flush(uuid)',...publicFunctions,
  ].sort();
  const beforeFunctions=new Set(beforePerformancePrivileges.functions.map(row=>row.fn));
  expect(afterPerformancePrivileges.functions.filter(row=>!beforeFunctions.has(row.fn)).map(row=>row.fn).sort()).toEqual(addedFunctions);
  for(const fn of addedFunctions){
   const [permission]=await storage.client`select has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc p where p.oid=to_regprocedure(${fn})`;
   expect(permission).toEqual({app_execute:!privateFunctions.includes(fn),public_execute:publicFunctions.includes(fn)});
  }
  // Independently parse both reviewed Claim expressions against this table. No broad policy
  // exception: only this exact USING representation may differ; WITH CHECK and every other field stay.
  const expectedClaimQuals=await storage.client.begin(async tx=>{
   const expressions=[
    "tenant_id=app.current_tenant_id() and employment_id=any((select app.visible_employment_ids())::uuid[])",
    "tenant_id=app.current_tenant_id() and employment_id in(select unnest(app.visible_employment_ids()))",
   ],qualifiers:string[]=[];
   for(const expression of expressions){
    await tx.unsafe('create policy performance_expected_claim_membership on public.claim_request for select to ai_hr_app using ('+expression+')');
    const [row]=await tx<{qual:string}[]>`select qual from pg_policies where schemaname='public' and tablename='claim_request' and policyname='performance_expected_claim_membership'`;
    qualifiers.push(row.qual);await tx.unsafe('drop policy performance_expected_claim_membership on public.claim_request');
   }
   return qualifiers;
  });
  const isClaimPolicy=(row:(typeof beforePerformancePrivileges.policies)[number])=>row.schemaname==='public'&&row.tablename==='claim_request'&&row.policyname==='claim_request_rls';
  expect(beforePerformancePrivileges.policies.find(isClaimPolicy)?.qual).toBe(expectedClaimQuals[0]);
  expect(afterPerformancePrivileges.policies.find(isClaimPolicy)?.qual).toBe(expectedClaimQuals[1]);
  // Independently pin the complete Employment authority graph on BOTH sides of
  // 3001. Only the two positive membership terms change representation; the
  // outer/inner tenant and void guards, Bank CASE and partner arms stay exact.
  const expectedEmploymentQuals=await storage.client.begin(async tx=>{
   const memberships=[
    'id=any((select app.visible_employment_ids())::uuid[])',
    'id in(select unnest((select app.visible_employment_ids())))',
   ],qualifiers:string[]=[];
   for(const membership of memberships){
    const inherited=`(voided_at is null) and ((tenant_id=app.current_tenant_id()) and ((${membership}) or app.can_admin_payroll_for(company_id) or app.can_admin_perfcomp_for(company_id)))`;
    const expression=`(voided_at is null) and (tenant_id=app.current_tenant_id()) and case
     when (select current_setting('app.bank_import_point_read',true))='on'
     then case when app.is_admin_for(company_id) then true else (${inherited}) end
     else (${inherited}) end`;
    await tx.unsafe('create policy performance_expected_employment_membership on public.employment for select to ai_hr_app using ('+expression+')');
    const [row]=await tx<{qual:string}[]>`select qual from pg_policies where schemaname='public' and tablename='employment' and policyname='performance_expected_employment_membership'`;
    qualifiers.push(row.qual);await tx.unsafe('drop policy performance_expected_employment_membership on public.employment');
   }
   return qualifiers;
  });
  const isEmploymentPolicy=(row:(typeof beforePerformancePrivileges.policies)[number])=>row.schemaname==='public'&&row.tablename==='employment'&&row.policyname==='employment_rls';
  const beforeEmployment=beforePerformancePrivileges.policies.find(isEmploymentPolicy),afterEmployment=afterPerformancePrivileges.policies.find(isEmploymentPolicy);
  expect(beforeEmployment?.qual).toBe(expectedEmploymentQuals[0]);
  expect(afterEmployment?.qual).toBe(expectedEmploymentQuals[1]);
  const wrappedMembership='(id IN ( SELECT unnest(( SELECT app.visible_employment_ids() AS visible_employment_ids)) AS unnest))';
  expect(afterEmployment?.qual?.split(wrappedMembership)).toHaveLength(3);
  expect(beforeEmployment).toMatchObject({permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'ALL',with_check:'((tenant_id = app.current_tenant_id()) AND app.is_admin_for(company_id))'});
  expect({...afterEmployment,qual:expectedEmploymentQuals[0]}).toEqual(beforeEmployment);
  // Independently parse the one reviewed Assignment transition from 3102. The
  // same complete tenant/WITH CHECK/role/command metadata must survive replay.
  const expectedAssignmentQuals=await storage.client.begin(async tx=>{
   const expressions=[
    'tenant_id=app.current_tenant_id() and employment_id=any((select app.visible_employment_ids())::uuid[])',
    'tenant_id=app.current_tenant_id() and employment_id in(select unnest((select app.visible_employment_ids())))',
   ],qualifiers:string[]=[];
   for(const expression of expressions){
    await tx.unsafe('create policy performance_expected_assignment_membership on public.assignment for select to ai_hr_app using ('+expression+')');
    const [row]=await tx<{qual:string}[]>`select qual from pg_policies where schemaname='public' and tablename='assignment' and policyname='performance_expected_assignment_membership'`;
    qualifiers.push(row.qual);await tx.unsafe('drop policy performance_expected_assignment_membership on public.assignment');
   }
   return qualifiers;
  });
  const isAssignmentPolicy=(row:(typeof beforePerformancePrivileges.policies)[number])=>row.schemaname==='public'&&row.tablename==='assignment'&&row.policyname==='assignment_rls';
  const beforeAssignment=beforePerformancePrivileges.policies.find(isAssignmentPolicy),afterAssignment=afterPerformancePrivileges.policies.find(isAssignmentPolicy);
  expect(beforeAssignment?.qual).toBe(expectedAssignmentQuals[0]);expect(afterAssignment?.qual).toBe(expectedAssignmentQuals[1]);
  const assignmentMembership='(employment_id IN ( SELECT unnest(( SELECT app.visible_employment_ids() AS visible_employment_ids)) AS unnest))';
  expect(afterAssignment?.qual?.split(assignmentMembership)).toHaveLength(2);
  expect(beforeAssignment).toMatchObject({permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'ALL',with_check:'((tenant_id = app.current_tenant_id()) AND app.can_admin_employment(employment_id))'});
  expect({...afterAssignment,qual:expectedAssignmentQuals[0]}).toEqual(beforeAssignment);
  // Inspect the new receipt table separately, then compare every pre-existing ACL and policy.
  const receiptTable='notification_event_processing';
  const receiptRelation=afterPerformancePrivileges.relations.find(row=>row.rel===receiptTable);
  expect(receiptRelation).toMatchObject({rls:true,force:false});
  const receiptColumns=afterPerformancePrivileges.columns.filter(row=>row.rel===receiptTable);
  expect(receiptColumns.map(row=>row.col)).toEqual(['disposition','processed_at']);
  const receiptPolicies=afterPerformancePrivileges.policies.filter(row=>row.schemaname==='public'&&row.tablename===receiptTable);
  expect(receiptPolicies.map(({policyname,cmd})=>({policyname,cmd}))).toEqual([
   {policyname:'notification_event_processing_complete',cmd:'UPDATE'},
   {policyname:'notification_event_processing_read',cmd:'SELECT'},
  ]);
  expect(await storage.client`select
   has_table_privilege('ai_hr_app','public.notification_event_processing','SELECT') as can_read,
   has_table_privilege('ai_hr_app','public.notification_event_processing','UPDATE') as can_update_all,
   has_table_privilege('ai_hr_app','public.notification_event_processing','INSERT') as can_insert,
   has_table_privilege('ai_hr_app','public.notification_event_processing','DELETE') as can_delete,
   has_column_privilege('ai_hr_app','public.notification_event_processing','disposition','UPDATE') as can_complete,
   has_column_privilege('ai_hr_app','public.notification_event_processing','processed_at','UPDATE') as can_stamp`)
   .toEqual([{can_read:true,can_update_all:false,can_insert:false,can_delete:false,can_complete:true,can_stamp:true}]);
  // 4342 removes only the table-level clock SELECT, replacing it with seven operational columns.
  const beforeClockTable=beforePerformancePrivileges.relations.find(row=>row.rel===clockTable);
  expect(beforeClockTable).toMatchObject({rls:true,force:true});
  expect(await clockTableAcl()).toEqual(beforeClockTableAcl.filter(row=>!clockSelectRevoked(row)));
  const clockReadColumns=['company_id','effective_from','id','ordinal','policy','reason','rule_id','tenant_id'];
  expect(beforePerformancePrivileges.columns.filter(row=>row.rel===clockTable)).toEqual([]);
  expect(afterPerformancePrivileges.columns.filter(row=>row.rel===clockTable).map(row=>row.col)).toEqual(clockReadColumns);
  const clockReads=await storage.client`select a.attname::text as col,
   has_column_privilege('ai_hr_app',a.attrelid,a.attnum,'SELECT') as allowed
   from pg_attribute a where a.attrelid='public.attendance_clock_policy_revision'::regclass
   and a.attnum>0 and not a.attisdropped order by 1`;
  expect(clockReads.filter(row=>row.allowed).map(row=>row.col)).toEqual(clockReadColumns);
  expect(clockReads.filter(row=>!row.allowed).map(row=>row.col)).toEqual(['created_at','created_by_user_id']);
  const clockAuditPolicy=(row:(typeof beforePerformancePrivileges.policies)[number])=>row.schemaname==='public'
   &&row.tablename==='domain_event'&&row.policyname==='attendance_clock_policy_audit_read';
  expect(beforePerformancePrivileges.policies.find(clockAuditPolicy)).toBeUndefined();
  expect(afterPerformancePrivileges.policies.find(clockAuditPolicy)).toMatchObject({
   permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'SELECT',with_check:null,
   qual:expect.stringContaining('attendance-rule.clock-policy.scheduled'),
  });
  // The audit-chain commit seal's private queue tables: RLS on with no policy, and no grant to any client role.
  const sealTables=['app.domain_event_chain_pending','app.domain_event_chain_seal'];
  for(const rel of sealTables){
   const row=afterPerformancePrivileges.relations.find(candidate=>candidate.rel===rel);
   expect(row,rel).toMatchObject({rls:true,force:false});
   expect(String(row?.acl??''),rel).not.toMatch(/(^|[{,])(ai_hr_app)?=/);
   expect(afterPerformancePrivileges.policies.filter(policy=>'app.'+policy.tablename===rel)).toEqual([]);
  }
  expect({
   relations:afterPerformancePrivileges.relations.filter(row=>row.rel!==receiptTable&&!sealTables.includes(row.rel)).map(row=>
    row.rel===clockTable?{...row,acl:beforeClockTable?.acl}:row),
   columns:afterPerformancePrivileges.columns.filter(row=>row.rel!==receiptTable&&row.rel!==clockTable),
   functions:afterPerformancePrivileges.functions.filter(row=>!addedFunctions.includes(row.fn)),
   policies:afterPerformancePrivileges.policies.filter(row=>!receiptPolicies.includes(row)&&!clockAuditPolicy(row)).map(row=>
    isClaimPolicy(row)?{...row,qual:expectedClaimQuals[0]}:isEmploymentPolicy(row)?{...row,qual:expectedEmploymentQuals[0]}:
     isAssignmentPolicy(row)?{...row,qual:expectedAssignmentQuals[0]}:row),
  }).toEqual(beforePerformancePrivileges);
  const complete=await ledger();expect(complete).toHaveLength(671+APPROVED_UPGRADE_TAIL.length);expect(complete.slice(0,671)).toEqual(afterLedger);
  expect(complete.slice(0,performanceStart)).toEqual(beforePerformanceLedger);
  expect(complete.slice(671).map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(APPROVED_UPGRADE_TAIL.map(entry=>({hash:hash(readFileSync('db/migrations/'+entry.tag+'.sql')),created_at:String(entry.when)})));
  expect(await native()).toEqual(beforeRerun);
  // The final 2211 expansion adds validated tenant matches beside the original NO ACTION keys.
  const expansionRelations = [
   'company_registration_classification', 'job_architecture_import_preview', 'job_architecture_jd_publication',
   'job_architecture_position_revision', 'job_architecture_proposal', 'job_architecture_seat',
   'job_architecture_suggestion', 'reward_company_year_review', 'reward_page_grant',
   'reward_pat_version', 'reward_plan_company', 'reward_setup_grant',
  ];
  const expansionNames = new Set(expansionRelations.map(rel => rel + '_company_tenant_fk'));
  const completeKeys = await keys();
  expect(completeKeys.filter(row => !expansionNames.has(row.conname))).toEqual(installed);
  expect(completeKeys.filter(row => expansionNames.has(row.conname))).toEqual(expansionRelations.map(rel => ({
   rel, conname: rel + '_company_tenant_fk', convalidated: true, action: 'a',
  })));
  expect(await asAdmin(tx=>tx`select app.can_admin_employment(${employmentA}::uuid) own,app.can_admin_employment(${employmentB}::uuid) foreign`)).toEqual([{own:true,foreign:false}]);
  const terminalPrivileges=await privileges();
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await ledger()).toEqual(complete);expect(await native()).toEqual(beforeRerun);expect(await privileges()).toEqual(terminalPrivileges);expect(await keys()).toEqual(completeKeys);
 }finally{
  await application.client.end();await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();rmSync(folder,{recursive:true,force:true});
 }
},300000);
