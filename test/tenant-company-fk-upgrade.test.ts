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
 // The combined block adds the staged-import marker column (5010, 5070) to some of these tables. It is null on every
 // row no import staged, and only then is the row compared without it.
 const withoutImportMarker=(rows:Record<string,unknown>)=>Object.fromEntries(Object.entries(rows).map(([table,list])=>[table,
  (list as {row:Record<string,unknown>}[]).map(({row})=>{
   if(!('import_pending_attempt_id' in row))return {row};
   expect(row.import_pending_attempt_id,table+' staged-import marker').toBeNull();
   const rest={...row};delete rest.import_pending_attempt_id;return {row:rest};
  })]));
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
   '5075_bulk_job_movement_import',
   '5076_workforce_employment_access_set',
   '5077_bulk_job_movement_check',
   '5078_bulk_job_movement_import_revert',
   '5079_movement_revert_capture',
   '5080_access_administrator_coalesced_assert',
   '5081_reward_access_observation_due',
   '5082_home_own_clock_day',
   '5083_home_own_schedule_range',
   '5090_audit_chain_commit_seal',
   '5120_access_review_custody_held_mode',
   '5121_personnel_search_set_mapping',
   // Board staging window 3 (ccd3a65c), renumbered above release candidate 3 and PR 240's 5122.
   '5123_import_history_kind',
   // Board staging window 4 (4452ba3c).
   '5124_attendance_workflow_skipped_levels',
   // Board item 792053e5, renumbered at the Irwin board integration onto release candidate 3.
   '5125_individual_txn_pricing_marker',
   // Board item 2260a06b, renumbered at the Irwin board integration onto release candidate 3.
   '5126_contract_internship_end_dates',
   // Board item 8d02748a, renumbered at the Irwin board integration onto release candidate 3.
   '5127_import_log_actor_labels',
   // Payroll history effective reads (12 November 2026), above PR 240's 5128.
   '5129_payroll_history_effective_reads',
   // Background AI Formula Generator draft job (12 November 2026), above 5129.
   '5130_pay_formula_ai_draft_job',
   // Board release 12 November 2026 (docs/MIGRATION-ALLOCATION.md): Rewards, dashboard and On/Off Boarding block.
   '5400_rewards_direct_configuration',
   '5420_rewards_dashboard_preparation_notices',
   '5460_lifecycle_v9_email_recipients',
   '5480_offboarding_items_assignment_load',
   '5500_rewards_limit_controls',
   '5520_rewards_role_permission_grid',
   '5540_rewards_offcycle_company_balance',
   '5560_rewards_limit_controls_role_level',
   '5580_rewards_config_owner_paths',
   '5600_rewards_config_editor_role_levels',
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
  // Every function the forward migrations add, with its reviewed EXECUTE privileges: private functions are not
  // callable by the application role, and none is callable by PUBLIC. The policy-side and trigger-WHEN helpers are
  // granted to exactly the roles their policies or the domain_event writers are (test/policy-helper-function-grants).
  const privateFunctions=[
   // Board window 4 (5124): a trigger function, never granted to the application role.
   // 5129: the set-wise effective-snapshot owner, inlined into app.payroll_history_effective and the batch aggregate.
   // Board release block 5400-5560: three trigger functions, owner only.
   // 5580/5600: owner-only readers, trigger functions, the PAT repricing chain and the review creator's source copies.
   'app._access_bootstrap_eligible(uuid,uuid)','app._access_workforce_list_rows(uuid[])','app._ai_control_context_for_purpose(text,boolean,boolean)',
   'app._ai_control_context_policy_facts(text,boolean,boolean)','app._ai_provider_presentation_actor_valid()','app._assert_assistant_rewards_presentation_v1(text)',
   'app._assistant_assigned_index_login(uuid,boolean)','app._assistant_presentation_feature_unpaused_v1()','app._assistant_rewards_calendar_choice_payload_v1()',
   'app._assistant_rewards_cancel_choice_payload_v1()','app._assistant_rewards_return_choice_payload_v1()','app._domain_event_chain_key_held(uuid)',
   'app._domain_event_chain_seal_tenant(uuid)','app._personnel_company_tags(uuid[],date)','app._personnel_employment_tags(uuid[],date)',
   'app.access_administrator_assert_run()','app.access_administrator_guard_tenant()','app.access_capability_effective(uuid)',
   'app.access_lock_assert_strict(uuid,text,text)','app.ai_centre_mandate_bound_tenant()','app.ai_centre_mandate_write_order()',
   'app.attendance_workflow_preview_bind()','app.bulk_job_capability_held(uuid)','app.bulk_job_clear_inputs(uuid,boolean)',
   'app.bulk_job_event_attribution()','app.bulk_job_held(uuid)','app.bulk_job_input_conforms(jsonb,integer,jsonb)',
   'app.bulk_job_input_shape_valid(jsonb)','app.bulk_job_lease_capability(uuid,uuid,text)','app.bulk_job_seal_verify(uuid,text)',
   'app.bulk_job_step_digest(text,integer,jsonb,text,jsonb,text)','app.bulk_job_value_digest(jsonb)','app.domain_event_chain_arm()',
   'app.domain_event_chain_seal_now()','app.employee_import_revert_release(uuid,boolean)','app.employment_void_reference_blockers(uuid[])',
   'app.import_discard_batch(uuid,uuid,uuid,text,integer)','app.import_marker_visible(uuid)','app.import_settle(uuid,uuid,integer)',
   'app.label_import_marker_visible(uuid)','app.leave_ledger_stage_stamp()','app.movement_revert_capture_never_commits()',
   'app.movement_revert_capture_row()','app.notification_event_processing_enqueue()','app.org_structure_statement_lock()',
   'app.payroll_history_effective_ids(uuid[])','app.payroll_history_row_visible(text,uuid)','app.register_import_release(uuid,boolean)',
   'app.reward_access_self_change_guard()','app.reward_config_apply_confirmed_pat(uuid,uuid)','app.reward_config_architecture_for_source(uuid,uuid,uuid,date)',
   'app.reward_config_identity_guard()','app.reward_config_library_capture_revision()','app.reward_config_library_input_guard()',
   'app.reward_config_pat_confirm_apply()','app.reward_config_pat_input_guard()','app.reward_config_planned_policy_snapshot(jsonb,jsonb,jsonb,jsonb)',
   'app.reward_config_policy_source(uuid)','app.reward_config_reprice_draft_pat(uuid,uuid)','app.reward_config_snapshot_pay_change_kind(uuid)',
   'app.reward_config_source_org_tags(uuid,date)','app.reward_config_uploaded_binding()','app.reward_limit_version_guard()',
   'app.system_label_import_discard_batch(uuid,uuid,uuid,uuid,integer)',
  ];
  // 5580: the configuration editor predicates are read by row-security policies that apply to every role (purpose
  // readers included), and the creating flag by the annual-admission guard, so PUBLIC may execute them.
  const publicFunctions:string[]=['app.reward_config_creating()','app.reward_config_editor(uuid)','app.reward_config_editor_anywhere()','app.reward_config_library_viewer()','app.reward_config_viewer(uuid)'];
  const addedFunctions=[
   // Board window 4 (5124): the preview binding trigger (owner only) and the superior diagnostic.
   // Board release block 5400-5560 (12 November 2026): the Rewards, dashboard and On/Off Boarding functions. Kept sorted.
   'app._access_bootstrap_eligible(uuid,uuid)','app._access_workforce_list_rows(uuid[])','app._ai_control_context_for_purpose(text,boolean,boolean)',
   'app._ai_control_context_policy_facts(text,boolean,boolean)','app._ai_provider_presentation_actor_valid()','app._assert_assistant_rewards_presentation_v1(text)',
   'app._assistant_assigned_index_login(uuid,boolean)','app._assistant_presentation_feature_unpaused_v1()','app._assistant_rewards_calendar_choice_payload_v1()',
   'app._assistant_rewards_cancel_choice_payload_v1()','app._assistant_rewards_return_choice_payload_v1()','app._domain_event_chain_key_held(uuid)',
   'app._domain_event_chain_seal_tenant(uuid)','app._personnel_company_tags(uuid[],date)','app._personnel_employment_tags(uuid[],date)',
   'app.access_administrator_assert_run()','app.access_administrator_guard_tenant()','app.access_administrator_set_lock(uuid)',
   'app.access_capability_effective(uuid)','app.access_configuration_exclusive_wait(uuid,integer)','app.access_configuration_write_lock()',
   'app.access_editor_presentation_v1()','app.access_lock_assert_strict(uuid,text,text)','app.access_lock_mode_held(uuid)',
   'app.access_profile_policy_read_lock()','app.access_profile_policy_value_lock()','app.access_workforce_employment_permitted(uuid,uuid,timestamp with time zone,uuid,uuid[])',
   'app.access_workforce_list_facts()','app.access_workforce_list_rows_for_ids(uuid[])','app.access_workforce_permitted_companies(text)',
   'app.access_workforce_picker_facts(uuid[])','app.ai_centre_mandate_bound_tenant()','app.ai_centre_mandate_write_order()',
   'app.assistant_rewards_calendar_presentation_choices_v1()','app.assistant_rewards_cancel_presentation_choices_v1()','app.assistant_rewards_return_presentation_choices_v1()',
   'app.attendance_clock_policy_history(uuid,uuid)','app.attendance_frozen_actor_identity_keys(jsonb,text)','app.attendance_pending_visible_headers(uuid)',
   'app.attendance_workflow_preview_bind()','app.attendance_workflow_superior_diagnostic(uuid,integer)','app.bulk_job_access(uuid)',
   'app.bulk_job_admit()','app.bulk_job_attribution()','app.bulk_job_capability_held(uuid)',
   'app.bulk_job_clear_inputs(uuid,boolean)','app.bulk_job_enqueue(text,uuid,uuid[],text,bytea,jsonb)','app.bulk_job_event_attribution()',
   'app.bulk_job_fence(uuid,text)','app.bulk_job_held(uuid)','app.bulk_job_input_conforms(jsonb,integer,jsonb)',
   'app.bulk_job_input_shape_valid(jsonb)','app.bulk_job_lease_capability(uuid,uuid,text)','app.bulk_job_mark_watched(uuid)',
   'app.bulk_job_notice_recipients(uuid)','app.bulk_job_pending_steps(uuid,integer)','app.bulk_job_request_cancel(uuid,text)',
   'app.bulk_job_scope_current(text,uuid[])','app.bulk_job_seal_verify(uuid,text)','app.bulk_job_step_digest(text,integer,jsonb,text,jsonb,text)',
   'app.bulk_job_step_update(uuid,integer[],jsonb)','app.bulk_job_steps_put(uuid,boolean,jsonb)','app.bulk_job_value_digest(jsonb)',
   'app.bulk_job_waiting(uuid)','app.bulk_job_worker_ready(text)','app.bulk_job_worker_update(uuid,jsonb)',
   'app.contract_renewal_open(uuid)','app.delegated_approval_subjects(uuid[],text,text)','app.domain_event_chain_arm()',
   'app.domain_event_chain_flush(uuid)','app.domain_event_chain_seal_now()','app.domain_event_chain_sealing()',
   'app.employee_import_revert_release(uuid,boolean)','app.employment_void_reference_blockers(uuid[])','app.home_leave_presentation_index(text)',
   'app.home_own_clock_day(uuid,date,date)','app.home_own_schedule_range(uuid,date,date)','app.import_activation_conflicts(uuid)',
   'app.import_discard_batch(uuid,uuid,uuid,text,integer)','app.import_hidden_attempt_ids()','app.import_log_actor_facts(text,uuid[])',
   'app.import_marker_released(uuid)','app.import_marker_visible(uuid)','app.import_pending_employment_ids()',
   'app.import_pending_guard()','app.import_pending_person_ids()','app.import_pending_stamp()',
   'app.import_release(uuid)','app.import_released_attempt_ids()','app.import_settle(uuid,uuid,integer)',
   'app.label_import_marker_visible(uuid)','app.leave_ledger_stage_stamp()','app.leave_stage_digests(uuid[],uuid[],boolean)',
   'app.leave_stage_release(uuid,uuid)','app.leave_stage_released_ids()','app.may_have_attendance_task_metadata()',
   'app.movement_revert_capture_never_commits()','app.movement_revert_capture_row()','app.notification_event_processing_enqueue()',
   'app.notification_projection_exists(uuid,uuid,text)','app.org_structure_statement_lock()','app.payroll_batch_period_required()',
   'app.payroll_history_batch_admin_totals(uuid)','app.payroll_history_batch_visible_totals(uuid)','app.payroll_history_effective_ids(uuid[])',
   'app.payroll_history_hidden_rows(text)','app.payroll_history_row_visible(text,uuid)','app.payroll_history_self_employment_ids()',
   'app.payroll_history_stage_busy(uuid)','app.payroll_history_stage_open(uuid,uuid,text)','app.payroll_history_stage_release(uuid)',
   'app.payroll_history_stage_stamp()','app.payroll_input_lock_keys(uuid[],uuid)','app.personnel_list_rows_for_ids(date,uuid[],uuid[])',
   'app.personnel_overview_facts(date,uuid[])','app.personnel_overview_filter_fields(date,uuid[])','app.personnel_overview_narrow_rows(date,uuid[])',
   'app.personnel_overview_page_rows(date,uuid[],uuid[])','app.personnel_overview_page_rows_typed(date,uuid[],uuid[])','app.personnel_private_search_entries(text,uuid[])',
   'app.personnel_search_candidates(uuid[],boolean,boolean,text,text,text,text,text[])','app.register_import_release(uuid,boolean)','app.reward_access_observation_due(uuid)',
   'app.reward_access_self_change_guard()','app.reward_actor_holds_role(text)','app.reward_actor_page_level(text)',
   'app.reward_config_apply_confirmed_pat(uuid,uuid)','app.reward_config_architecture_for_source(uuid,uuid,uuid,date)','app.reward_config_change_recipients(uuid)',
   'app.reward_config_change_record(text,text,uuid,text,uuid[],text,text,boolean,integer,jsonb,uuid,uuid[],text)','app.reward_config_change_visible(text,uuid[])','app.reward_config_companies(integer)',
   'app.reward_config_company_eligible(uuid,integer)','app.reward_config_company_structure(uuid,date)','app.reward_config_create_planned_unit(uuid,uuid,uuid)',
   'app.reward_config_creating()','app.reward_config_editor(uuid)','app.reward_config_editor_anywhere()',
   'app.reward_config_grade_choices()','app.reward_config_identity_guard()','app.reward_config_library_capture_revision()',
   'app.reward_config_library_input_guard()','app.reward_config_library_locked(uuid)','app.reward_config_library_used_by(uuid)',
   'app.reward_config_library_viewer()','app.reward_config_page_allowed(uuid,text,text)','app.reward_config_pat_affected_units(uuid,integer)',
   'app.reward_config_pat_confirm_apply()','app.reward_config_pat_history(uuid,integer)','app.reward_config_pat_input_guard()',
   'app.reward_config_planned_policy_snapshot(jsonb,jsonb,jsonb,jsonb)','app.reward_config_policy_source(uuid)','app.reward_config_reprice_draft_pat(uuid,uuid)',
   'app.reward_config_snapshot_pay_change_kind(uuid)','app.reward_config_source_org_tags(uuid,date)','app.reward_config_uploaded_binding()',
   'app.reward_config_uploaded_binding_check(text,text,jsonb,jsonb)','app.reward_config_viewer(uuid)','app.reward_level_rank(text)',
   'app.reward_limit_controls_access()','app.reward_limit_pin_on_submit(uuid,uuid)','app.reward_limit_reapply(uuid[],uuid,text)',
   'app.reward_limit_version_guard()','app.reward_offcycle_balances(uuid)','app.reward_offcycle_company_funding(uuid,boolean)',
   'app.reward_offcycle_cycle_readiness(uuid)','app.reward_offcycle_limit_pin(uuid,uuid)','app.reward_offcycle_limit_version(uuid)',
   'app.reward_offcycle_year_save(uuid,integer,date,date)','app.reward_preparation_notices_v2()','app.reward_role_default_level(text,text)',
   'app.reward_role_level(text,text)','app.reward_role_level_options(text,text)','app.reward_role_permission_immediate()',
   'app.reward_role_permission_level_shape()','app.reward_role_permission_locked(text,text)','app.reward_role_permission_reader()',
   'app.reward_role_permission_request_shape()','app.reward_role_permission_seat()','app.reward_setup_page_allowed(uuid,text,text)',
   'app.reward_unit_level(uuid,text)','app.reward_unit_limit_version(uuid)','app.system_label_import_conflicts(uuid)',
   'app.system_label_import_discard_batch(uuid,uuid,uuid,uuid,integer)','app.system_label_import_release_attempt(uuid,uuid)',
  ];
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
   // The third shape is 5054's reviewed rewrite of the 3001 policy: the point-read arm also answers for a payroll
   // partner (app.can_admin_payroll_for), which the original predicate already admitted.
   const shapes:[string,string][]=[[memberships[0],'app.is_admin_for(company_id)'],[memberships[1],'app.is_admin_for(company_id)'],
    [memberships[1],'(app.is_admin_for(company_id) or app.can_admin_payroll_for(company_id))']];
   for(const [membership,administratorArm] of shapes){
    const inherited=`(voided_at is null) and ((tenant_id=app.current_tenant_id()) and ((${membership}) or app.can_admin_payroll_for(company_id) or app.can_admin_perfcomp_for(company_id)))`;
    const expression=`(voided_at is null) and (tenant_id=app.current_tenant_id()) and case
     when (select current_setting('app.bank_import_point_read',true))='on'
     then case when ${administratorArm} then true else (${inherited}) end
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
  expect(afterEmployment?.qual).toBe(expectedEmploymentQuals[2]);
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
  // The combined release block (5000-5090): every relation, column grant and policy it adds, reviewed here and then
  // left out of the comparison of pre-existing privileges below. The owner role's name is normalised.
  const [{owner_role:ownerRole}]=await storage.client<{owner_role:string}[]>`select current_user as owner_role`;
  const ownerAcl=(acl:string|null)=>acl===null?null:acl.split(ownerRole).join('OWNER');
  const digest=(text:string|null)=>text===null?null:createHash('md5').update(text).digest('hex');
  const combinedRelations:Record<string,{rls:boolean;force:boolean;acl:string|null}>={
   // Board window 4 (5124): stored Preview Assignment snapshots, append-only and forced RLS.
   'attendance_workflow_preview':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'app.access_administrator_assert_pending':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.access_administrator_guard':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.access_capability_publication':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.access_capability_tenant_publication':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.bulk_job_seal':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.bulk_job_step_seal':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.import_attempt_release':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.leave_stage_release':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.movement_revert_capture':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'app.movement_revert_capture_seq_seq':{rls:false,force:false,acl:null},
   'app.movement_revert_job_outcome':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'app.payroll_history_stage':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.payroll_history_staged_row':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.system_label_import_release':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'bulk_job':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'bulk_job_kind':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'bulk_job_step':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'bulk_job_worker':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'payroll_run_group':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   // Background AI Formula Generator (5130): one row per login, forced RLS; the app role reads and deletes (own finished
   // and the tenant's expired rows) and writes only the listed columns below.
   'pay_formula_ai_draft_job':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=rd/OWNER}'},
  };
  const combinedColumns=[
   // 5130: INSERT of the admission columns, UPDATE of the outcome columns; tenant_id and user_id are never updated.
   {rel:'pay_formula_ai_draft_job',col:'deadline_at',acl:'{ai_hr_app=aw/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'expires_at',acl:'{ai_hr_app=aw/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'finished_at',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'id',acl:'{ai_hr_app=aw/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'reason',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'requirement_digest',acl:'{ai_hr_app=aw/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'result',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'started_at',acl:'{ai_hr_app=aw/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'state',acl:'{ai_hr_app=aw/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'tenant_id',acl:'{ai_hr_app=a/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'timeout_ms',acl:'{ai_hr_app=aw/OWNER}'},
   {rel:'pay_formula_ai_draft_job',col:'user_id',acl:'{ai_hr_app=a/OWNER}'},
   {rel:'payroll_run_group',col:'ended_at',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'payroll_run_group',col:'event_id',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'payroll_run_group',col:'outcomes',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'payroll_run_group',col:'result',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'payroll_run_group',col:'sealed_at',acl:'{ai_hr_app=w/OWNER}'},
  ];
  const combinedPolicies=[
   {schemaname:'app',tablename:'movement_revert_capture',policyname:'movement_revert_capture_own_transaction',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'896d23c477ff98ba03c5f769806872cb',with_check:null},
   {schemaname:'app',tablename:'movement_revert_job_outcome',policyname:'movement_revert_job_outcome_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'dd91406dbf38ec27c75ca3c02598b2ad',with_check:null},
   {schemaname:'app',tablename:'movement_revert_job_outcome',policyname:'movement_revert_job_outcome_record',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'96504ac7df85a38ba60b8d60fb88d6e4'},
   {schemaname:'public',tablename:'assignment',policyname:'assignment_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'0f9dd65355006232e921e629437f17ed',with_check:null},
   {schemaname:'public',tablename:'attendance_workflow_preview',policyname:'attendance_workflow_preview_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'cdc05808fee3cfb686b795e84e860d62'},
   {schemaname:'public',tablename:'attendance_workflow_preview',policyname:'attendance_workflow_preview_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'5be0ee6aeebbaa48781aed226acba9e1',with_check:null},
   {schemaname:'public',tablename:'bulk_job',policyname:'bulk_job_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'854f996ebf0fabb3d26bab47074b4367',with_check:null},
   {schemaname:'public',tablename:'bulk_job_step',policyname:'bulk_job_step_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'d7dd4940b61e35f349026181b8e2bf9f',with_check:null},
   {schemaname:'public',tablename:'business_unit',policyname:'business_unit_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'compensation',policyname:'compensation_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'0f9dd65355006232e921e629437f17ed',with_check:null},
   {schemaname:'public',tablename:'cost_center',policyname:'cost_center_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'department',policyname:'department_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'domain_event',policyname:'domain_event_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'b0a8927456ec43012df21412a95f7c37',with_check:null},
   {schemaname:'public',tablename:'employee_dependent',policyname:'employee_dependent_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'e1e347cd1d2f41f260b72723cf6fcd03',with_check:null},
   {schemaname:'public',tablename:'employee_qualification',policyname:'employee_qualification_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'0f9dd65355006232e921e629437f17ed',with_check:null},
   {schemaname:'public',tablename:'employee_statutory_my',policyname:'employee_statutory_my_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'e1e347cd1d2f41f260b72723cf6fcd03',with_check:null},
   {schemaname:'public',tablename:'employment',policyname:'employment_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'employment_cost_allocation_head',policyname:'employment_cost_allocation_head_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'0f9dd65355006232e921e629437f17ed',with_check:null},
   {schemaname:'public',tablename:'employment_tax_scheme_my',policyname:'employment_tax_scheme_my_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'0f9dd65355006232e921e629437f17ed',with_check:null},
   {schemaname:'public',tablename:'employment_tax_selection_my',policyname:'employment_tax_selection_my_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'0f9dd65355006232e921e629437f17ed',with_check:null},
   {schemaname:'public',tablename:'grade_group',policyname:'grade_group_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'grade_group_member',policyname:'grade_group_member_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'import_attempt_item',policyname:'import_attempt_item_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'0f9dd65355006232e921e629437f17ed',with_check:null},
   {schemaname:'public',tablename:'job_grade',policyname:'job_grade_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'label_company_assignment',policyname:'label_company_assignment_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'leave_ledger',policyname:'leave_ledger_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'0f9dd65355006232e921e629437f17ed',with_check:null},
   {schemaname:'public',tablename:'leave_ledger',policyname:'leave_ledger_stage_hidden',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'04ae78d4be9a45c73791e800606ae4f3',with_check:'750a56c287292289aa2796686ca07de0'},
   // 5130: own read/insert/update while the login's roles are current, own finished delete and the tenant's expired delete.
   {schemaname:'public',tablename:'pay_formula_ai_draft_job',policyname:'pay_formula_ai_draft_job_expired_delete',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'DELETE',qual:'15e7399f642d75240d8949db0ecdd901',with_check:null},
   {schemaname:'public',tablename:'pay_formula_ai_draft_job',policyname:'pay_formula_ai_draft_job_own_delete',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'DELETE',qual:'58d5af6b910eb37fd003f613bf15a31d',with_check:null},
   {schemaname:'public',tablename:'pay_formula_ai_draft_job',policyname:'pay_formula_ai_draft_job_own_insert',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'530d1680fe5109e2378b534d6786176d'},
   {schemaname:'public',tablename:'pay_formula_ai_draft_job',policyname:'pay_formula_ai_draft_job_own_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'1235e2cc02ad2a03cb64db43c0c2be39',with_check:null},
   {schemaname:'public',tablename:'pay_formula_ai_draft_job',policyname:'pay_formula_ai_draft_job_own_update',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'1235e2cc02ad2a03cb64db43c0c2be39',with_check:'1235e2cc02ad2a03cb64db43c0c2be39'},
   {schemaname:'public',tablename:'payroll_batch',policyname:'payroll_batch_history_stage',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'6ce658a1711835306c3e9cac03d44dda',with_check:null},
   {schemaname:'public',tablename:'payroll_history_import_record',policyname:'payroll_history_import_record_history_stage',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'b86f613f85d47351b877d5c302dd1f31',with_check:null},
   {schemaname:'public',tablename:'payroll_history_import_revision',policyname:'payroll_history_import_revision_history_stage',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'a9343f694013ea4b56643ee2bc1e5225',with_check:null},
   {schemaname:'public',tablename:'payroll_history_import_snapshot',policyname:'payroll_history_import_snapshot_history_stage',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'45e1516e5e1f89eceeac25aea6901daf',with_check:null},
   {schemaname:'public',tablename:'payroll_run_group',policyname:'payroll_run_group_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'ebf95bb6d330d9540e7de0753f0651e7'},
   {schemaname:'public',tablename:'payroll_run_group',policyname:'payroll_run_group_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ebf95bb6d330d9540e7de0753f0651e7',with_check:null},
   {schemaname:'public',tablename:'payroll_run_group',policyname:'payroll_run_group_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'ebf95bb6d330d9540e7de0753f0651e7',with_check:'ebf95bb6d330d9540e7de0753f0651e7'},
   {schemaname:'public',tablename:'payslip',policyname:'payslip_history_stage',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'be7965b44ae497db663f98fe9eb010be',with_check:null},
   {schemaname:'public',tablename:'person',policyname:'person_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'person_emergency_contact',policyname:'person_emergency_contact_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'e1e347cd1d2f41f260b72723cf6fcd03',with_check:null},
   {schemaname:'public',tablename:'position',policyname:'position_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'profile_option',policyname:'profile_option_import_pending',permissive:'RESTRICTIVE',roles:'{public}',cmd:'ALL',qual:'9e82774b0d29ab4d626e9af1fff8806d',with_check:null},
   {schemaname:'public',tablename:'reporting_line',policyname:'reporting_line_import_pending',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'b1326dc10537d8076dc330a56c78bb62',with_check:null},
  ];
  const isCombinedRelation=(rel:string)=>Object.hasOwn(combinedRelations,rel);
  expect(Object.fromEntries(afterPerformancePrivileges.relations.filter(row=>isCombinedRelation(row.rel)).map(row=>[row.rel,{rls:row.rls,force:row.force,acl:ownerAcl(row.acl)}])))
   .toEqual(combinedRelations);
  expect(afterPerformancePrivileges.columns.filter(row=>isCombinedRelation(row.rel)).map(row=>({rel:row.rel,col:row.col,acl:ownerAcl(row.acl)}))).toEqual(combinedColumns);
  const isCombinedPolicy=(row:(typeof afterPerformancePrivileges.policies)[number])=>combinedPolicies.some(policy=>policy.schemaname===row.schemaname&&policy.tablename===row.tablename&&policy.policyname===row.policyname);
  expect(afterPerformancePrivileges.policies.filter(isCombinedPolicy).map(row=>({...row,qual:digest(row.qual),with_check:digest(row.with_check)}))).toEqual(combinedPolicies);
  for(const rel of Object.keys(combinedRelations))expect(beforePerformancePrivileges.relations.some(row=>row.rel===rel),rel).toBe(false);
  // Board release block 5400-5600 (12-13 November 2026, docs/MIGRATION-ALLOCATION.md): the seven new tables, the 66 row
  // policies it adds (5580's configuration-editor and owner policies and 5600's owner policies included) (qual/with_check as md5 digests, the migration owner written OWNER) and the one it retires
  // (5400 drops the second-person PAT confirmation policy). Nothing else in the privilege graph may change.
  const boardRelations:Record<string,{rls:boolean;force:boolean;acl:string|null}>={
   'lc_v9_email_hold':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'reward_config_change':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'reward_limit_version':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'reward_offcycle_year':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'reward_role_permission_request':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'reward_role_permission_version':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'reward_unit_limit_pin':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
  };
  const boardPolicyRow=(row:(typeof afterPerformancePrivileges.policies)[number])=>({...row,roles:ownerAcl(row.roles),qual:digest(row.qual),with_check:digest(row.with_check)});
  const boardPolicies=[
   {schemaname:'public',tablename:'company_registration_classification',policyname:'company_registration_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'job_architecture_catalogue_revision',policyname:'reward_config_architecture_catalogue',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'job_architecture_position_revision',policyname:'reward_config_architecture_position',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'lc_v9_email_hold',policyname:'v9_email_hold_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'943f46d6c51979e6a3e15d49c833cfd3'},
   {schemaname:'public',tablename:'lc_v9_email_hold',policyname:'v9_email_hold_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'a891360032acbd07afa1f1c6e6c5be0a',with_check:null},
   {schemaname:'public',tablename:'lc_v9_email_hold',policyname:'v9_email_hold_release',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'943f46d6c51979e6a3e15d49c833cfd3',with_check:'63096f37cc862794aecf97d68e8a8239'},
   {schemaname:'public',tablename:'lc_v9_email_hold',policyname:'v9_email_hold_storage_owner',permissive:'PERMISSIVE',roles:'{OWNER}',cmd:'ALL',qual:'b326b5062b2f0e69046810717534cb09',with_check:'b326b5062b2f0e69046810717534cb09'},
   {schemaname:'public',tablename:'reward_config_change',policyname:'reward_config_change_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_config_change',policyname:'reward_config_change_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'b0652841b761793f00814566b72e654b',with_check:null},
   {schemaname:'public',tablename:'reward_governance',policyname:'reward_pat_draft_governance_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'TBD',with_check:'TBD'},
   {schemaname:'public',tablename:'reward_governance_history',policyname:'reward_pat_draft_history_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'INSERT',qual:null,with_check:'TBD'},
   {schemaname:'public',tablename:'reward_governance_public',policyname:'reward_pat_draft_public_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'TBD',with_check:'TBD'},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_config_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'TBD'},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_config_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'3db9f2711a716af4114c1d2de6f36690'},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_role_level_read',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'9e5d27cf872cd899d911a7f32e4cc4af',with_check:null},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_role_level_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'3db9f2711a716af4114c1d2de6f36690',with_check:'3db9f2711a716af4114c1d2de6f36690'},
   {schemaname:'public',tablename:'reward_library_revision_audit',policyname:'reward_library_revision_audit_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'INSERT',qual:null,with_check:'TBD'},
   {schemaname:'public',tablename:'reward_library_revision_audit',policyname:'reward_library_revision_audit_config_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_config_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'TBD'},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_config_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_config_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'TBD',with_check:'TBD'},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'19469ece367ce5db1b948c904a930afe'},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_role_level_read',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'3dd971f5ee9fd9894fcddae5d59219d7',with_check:null},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_role_level_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'19469ece367ce5db1b948c904a930afe',with_check:'19469ece367ce5db1b948c904a930afe'},
   {schemaname:'public',tablename:'reward_limit_version',policyname:'reward_limit_version_insert',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'dc8abe21091318ab10c2bbd508ce87f7'},
   {schemaname:'public',tablename:'reward_limit_version',policyname:'reward_limit_version_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_limit_version',policyname:'reward_limit_version_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'f793da3071cf53b7718d88009b667c30',with_check:null},
   {schemaname:'public',tablename:'reward_offcycle_year',policyname:'reward_offcycle_year_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_offcycle_year',policyname:'reward_offcycle_year_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:null},
   {schemaname:'public',tablename:'reward_pat_basis',policyname:'reward_pat_basis_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'TBD',with_check:'TBD'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_config_edit',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'TBD',with_check:'TBD'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_config_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'TBD'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_config_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_edit',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'4a6390221289b7a5b68ed462f1ae654d',with_check:'6e4e6815b3f76a0a02dfc631d884d4a6'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'fb82f1d410f5a0cc23172d46a47934b4'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_role_level_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'fb82f1d410f5a0cc23172d46a47934b4',with_check:'fb82f1d410f5a0cc23172d46a47934b4'},
   {schemaname:'public',tablename:'reward_plan_company',policyname:'reward_plan_company_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'reward_plan_setup',policyname:'reward_plan_setup_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'eb77a6877e57fb4ed5e1105c04f429d8'},
   {schemaname:'public',tablename:'reward_plan_setup',policyname:'reward_plan_setup_role_level_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'eb77a6877e57fb4ed5e1105c04f429d8',with_check:'eb77a6877e57fb4ed5e1105c04f429d8'},
   {schemaname:'public',tablename:'reward_role_permission',policyname:'reward_role_permission_immediate_write',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'ALL',qual:'936f1d956dcd8547eb9e662eee9f286c',with_check:'6f8317317731342637ca575bdd15bda7'},
   {schemaname:'public',tablename:'reward_role_permission',policyname:'reward_role_permission_not_own_delete',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'DELETE',qual:'5160b252615da4b17341fc336d0cabd4',with_check:null},
   {schemaname:'public',tablename:'reward_role_permission',policyname:'reward_role_permission_not_own_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'5160b252615da4b17341fc336d0cabd4'},
   {schemaname:'public',tablename:'reward_role_permission',policyname:'reward_role_permission_not_own_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'5160b252615da4b17341fc336d0cabd4',with_check:'5160b252615da4b17341fc336d0cabd4'},
   {schemaname:'public',tablename:'reward_role_permission_request',policyname:'reward_role_permission_request_decide',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'1829518e556fb0c57877c207e96d879c',with_check:'353ed469b3fc79962a302ab434cd15cf'},
   {schemaname:'public',tablename:'reward_role_permission_request',policyname:'reward_role_permission_request_insert',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'4efd5fd19e4d4b5eca40d71dbbb1db47'},
   {schemaname:'public',tablename:'reward_role_permission_request',policyname:'reward_role_permission_request_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_role_permission_request',policyname:'reward_role_permission_request_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'6b7e9d58809ee4629186960da8e36764',with_check:null},
   {schemaname:'public',tablename:'reward_role_permission_request',policyname:'reward_view_as_insert',permissive:'RESTRICTIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'64d386c9dfb279b22c2b1b0801e4fe32'},
   {schemaname:'public',tablename:'reward_role_permission_request',policyname:'reward_view_as_update',permissive:'RESTRICTIVE',roles:'{public}',cmd:'UPDATE',qual:'64d386c9dfb279b22c2b1b0801e4fe32',with_check:'64d386c9dfb279b22c2b1b0801e4fe32'},
   {schemaname:'public',tablename:'reward_role_permission_version',policyname:'reward_role_permission_version_insert',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'c0dcbcb0a01de2cf0e3b99d7cf3893c8'},
   {schemaname:'public',tablename:'reward_role_permission_version',policyname:'reward_role_permission_version_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_role_permission_version',policyname:'reward_role_permission_version_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'6b7e9d58809ee4629186960da8e36764',with_check:null},
   {schemaname:'public',tablename:'reward_role_permission_version',policyname:'reward_view_as_insert',permissive:'RESTRICTIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'64d386c9dfb279b22c2b1b0801e4fe32'},
   {schemaname:'public',tablename:'reward_senior_award',policyname:'reward_senior_award_role_level_delete',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'DELETE',qual:'8868c5bc470186e1b41c27776e90fd3e',with_check:null},
   {schemaname:'public',tablename:'reward_senior_award',policyname:'reward_senior_award_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'8868c5bc470186e1b41c27776e90fd3e'},
   {schemaname:'public',tablename:'reward_senior_award',policyname:'reward_senior_award_role_level_read',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'ad6fe465015b65b7e97e25dc80363599',with_check:null},
   {schemaname:'public',tablename:'reward_senior_award',policyname:'reward_senior_award_role_level_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'8868c5bc470186e1b41c27776e90fd3e',with_check:'8868c5bc470186e1b41c27776e90fd3e'},
   {schemaname:'public',tablename:'reward_senior_evidence',policyname:'reward_senior_evidence_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'8868c5bc470186e1b41c27776e90fd3e'},
   {schemaname:'public',tablename:'reward_senior_evidence',policyname:'reward_senior_evidence_role_level_read',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'ad6fe465015b65b7e97e25dc80363599',with_check:null},
   {schemaname:'public',tablename:'reward_setup_grant',policyname:'reward_setup_grant_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'reward_snapshot_comp_movement',policyname:'reward_config_snapshot_pay_change',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'TBD',with_check:null},
   {schemaname:'public',tablename:'reward_unit_limit_pin',policyname:'reward_unit_limit_pin_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_unit_limit_pin',policyname:'reward_unit_limit_pin_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'f793da3071cf53b7718d88009b667c30',with_check:null},
   {schemaname:'public',tablename:'reward_unit_setup',policyname:'reward_unit_setup_pat_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'TBD',with_check:'TBD'},
   {schemaname:'public',tablename:'reward_uploaded_award',policyname:'reward_uploaded_award_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'TBD',with_check:null},
  ];
  const boardRetiredPolicies=[
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_check',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'c66ab0b91608107f679757a4c4f058a5',with_check:'48c95b77271b4a3fb728d587ca687b6e'},
  ];
  const samePolicy=(a:Record<string,unknown>,b:Record<string,unknown>)=>a.schemaname===b.schemaname&&a.tablename===b.tablename&&a.policyname===b.policyname;
  const isBoardPolicy=(row:(typeof afterPerformancePrivileges.policies)[number])=>boardPolicies.some(policy=>samePolicy(policy,row));
  const isBoardRetiredPolicy=(row:(typeof afterPerformancePrivileges.policies)[number])=>boardRetiredPolicies.some(policy=>samePolicy(policy,row));
  expect(Object.fromEntries(afterPerformancePrivileges.relations.filter(row=>Object.hasOwn(boardRelations,row.rel)).map(row=>[row.rel,{rls:row.rls,force:row.force,acl:ownerAcl(row.acl)}]))).toEqual(boardRelations);
  for(const rel of Object.keys(boardRelations))expect(beforePerformancePrivileges.relations.some(row=>row.rel===rel),rel).toBe(false);
  expect(afterPerformancePrivileges.columns.filter(row=>Object.hasOwn(boardRelations,row.rel))).toEqual([]);
  expect(afterPerformancePrivileges.policies.filter(isBoardPolicy).map(boardPolicyRow)).toEqual(boardPolicies);
  expect(beforePerformancePrivileges.policies.filter(isBoardPolicy)).toEqual([]);
  expect(beforePerformancePrivileges.policies.filter(isBoardRetiredPolicy).map(boardPolicyRow)).toEqual(boardRetiredPolicies);
  expect(afterPerformancePrivileges.policies.filter(isBoardRetiredPolicy)).toEqual([]);
  const terminalComparable={
   relations:afterPerformancePrivileges.relations.filter(row=>row.rel!==receiptTable&&!sealTables.includes(row.rel)&&!isCombinedRelation(row.rel)&&!Object.hasOwn(boardRelations,row.rel)).map(row=>
    row.rel===clockTable?{...row,acl:beforeClockTable?.acl}:row),
   columns:afterPerformancePrivileges.columns.filter(row=>row.rel!==receiptTable&&row.rel!==clockTable&&!isCombinedRelation(row.rel)),
   functions:afterPerformancePrivileges.functions.filter(row=>!addedFunctions.includes(row.fn)),
   policies:afterPerformancePrivileges.policies.filter(row=>!receiptPolicies.includes(row)&&!clockAuditPolicy(row)&&!isCombinedPolicy(row)&&!isBoardPolicy(row)).map(row=>
    isClaimPolicy(row)?{...row,qual:expectedClaimQuals[0]}:isEmploymentPolicy(row)?{...row,qual:expectedEmploymentQuals[0]}:
     isAssignmentPolicy(row)?{...row,qual:expectedAssignmentQuals[0]}:row),
  };
  expect(terminalComparable).toEqual({...beforePerformancePrivileges,policies:beforePerformancePrivileges.policies.filter(row=>!isBoardRetiredPolicy(row))});
  const complete=await ledger();expect(complete).toHaveLength(671+APPROVED_UPGRADE_TAIL.length);expect(complete.slice(0,671)).toEqual(afterLedger);
  expect(complete.slice(0,performanceStart)).toEqual(beforePerformanceLedger);
  expect(complete.slice(671).map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(APPROVED_UPGRADE_TAIL.map(entry=>({hash:hash(readFileSync('db/migrations/'+entry.tag+'.sql')),created_at:String(entry.when)})));
  expect(withoutImportMarker(await native())).toEqual(beforeRerun);
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
  expect(await ledger()).toEqual(complete);expect(withoutImportMarker(await native())).toEqual(beforeRerun);expect(await privileges()).toEqual(terminalPrivileges);expect(await keys()).toEqual(completeKeys);
 }finally{
  await application.client.end();await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();rmSync(folder,{recursive:true,force:true});
 }
},300000);
