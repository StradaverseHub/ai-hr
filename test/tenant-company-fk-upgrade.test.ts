import {PERFORMANCE_MIGRATION_IDENTITIES} from './performance-migration-identities';
import contractIntent from './fixtures/contract-upgrade-acl-intent.json';
import {APPROVED_UPGRADE_TAIL,assertApprovedUpgradeTail,migrateApprovedUpgrade,withoutCombinedReleaseNulls} from './helpers/approved-upgrade';
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

// Frozen Contract member identities; forward allocation updates these literals with their SQL hashes.
const APPROVED_COMBINED_RELEASE_TAGS=[
 '6300_resignation_journey',
 '6301_resignation_configuration',
 '6302_resignation_postings',
 '6303_resignation_email_delivery',
 '6304_resignation_letter_teams',
 '6305_resignation_letter_fields',
 '6306_resignation_case_communications',
 '6307_contract_resignation_directory_bridge',
 '6308_contract_shared_access',
 '6309_contract_shared_flows',
 '6310_contract_shared_builders',
 '6311_shared_document_templates',
 '6312_shared_email_rich_body',
 '6313_native_contract_counter_and_cutover',
 '6314_contract_shared_projections',
 '6315_contract_shared_commands',
 '6316_contract_shared_signing',
 '6317_contract_shared_decision_identity',
 '6318_contract_shared_execution_adapters',
 '6319_contract_shared_worker_binding',
 '6320_contract_shared_identity_context',
 '6321_contract_shared_email_notifications',
 '6322_contract_shared_personnel_postings',
 '6323_contract_posting_movement_authority',
 '6324_contract_posting_projections',
 '6325_contract_posting_receipts_and_tasks',
 '6326_contract_shared_tracker',
 '6327_contract_shared_period_open',
 '6328_contract_shared_case_workspace',
 '6329_contract_shared_assigned_work',
 '6330_contract_shared_ending_handoff',
 '6331_contract_shared_decline',
 '6332_contract_shared_offboarding',
 '6333_contract_shared_email_document_lifecycle',
 '6334_automation_shared_assignment_groups',
 '6335_shared_automation_email_assets',
 '6336_automation_email_test_self',
 '6337_shared_automation_email_asset_delivery',
 '6338_contract_shared_tracker_choices',
 '6339_contract_shared_starting_setup',
 '6340_contract_shared_tracker_retained_cases',
 '6341_contract_shared_review_wording',
 '6342_contract_shared_ending_actions',
 '6343_contract_shared_email_self_binding',
 '6344_contract_shared_email_task_projection',
 '6345_shared_email_test_asset_source',
 '6346_shared_email_case_file_pages',
 '6347_probation_shared_email_asset_proof',
 '6348_shared_groups_preserve_members',
 '6349_shared_groups_member_identity',
 '6350_email_test_current_human',
 '6351_email_test_authority_utf8',
 '6352_contract_shared_virtual_period',
 '6353_contract_shared_case_references',
 '6354_contract_shared_directory_and_signer_caption',
 '6355_contract_shared_period_history',
 '6356_contract_shared_work_page',
 '6357_contract_shared_legacy_inbox_cutover',
 '6358_contract_shared_manual_workflows',
 '6359_contract_shared_release_evidence',
 '6360_contract_shared_native_intake_guard',
 '6361_contract_shared_body_identity',
 '6362_contract_shared_work_page_null_guards',
 '6363_contract_posting_canonical_assignment_receipt',
 '6364_contract_posting_source_projection',
 '6365_contract_posting_native_completion',
 '6366_contract_posting_durable_job_readiness',
 '6367_contract_ordinary_signing_company_gate',
 '6368_contract_work_exact_document_join',
 '6369_contract_tracker_scheduled_period',
 '6370_contract_work_case_source_anchor',
 '6371_contract_case_progress_explanations',
 '6372_contract_case_fallback_receipts',
 '6373_contract_email_assigned_work',
 '6374_contract_letter_purpose_guidance',
 '6375_contract_template_lifecycle',
 '6376_contract_template_draft_publication',
 '6377_contract_routing_check_names',
 '6378_contract_tracker_attention_summary',
 '6379_contract_starting_setup_completion',
 '6380_contract_native_system_kernel',
 '6381_contract_system_period_events',
 '6382_contract_system_mail_digest',
 '6383_contract_system_provenance_rechecks',
 '6384_contract_accept_no_matching_workflow',
 '6385_contract_digest_queue_capability',
 '6386_contract_system_private_row_security',
 '6387_contract_form_response_owner',
 '6388_country_owned_document_sources',
 '6389_contract_form_response_actions',
 '6390_contract_email_document_readiness',
 '6391_contract_letterhead_fallback_evidence',
 '6392_contract_retrospective_ending_legacy_owner',
 '6393_contract_snapshot_native_binding',
 '6394_contract_email_document_identity',
 '6395_contract_form_current_proof',
 '6396_contract_published_form_email_source',
 '6397_shared_email_materialization_start',
 '6398_shared_email_explicit_tenant_start',
 '6399_contract_email_prerequisite_recovery',
 '6400_contract_manual_attention_reconciliation',
 '6401_contract_email_required_files',
 '6402_shared_email_guard_preservation',
 '6403_contract_canonical_form_readiness',
 '6404_contract_intake_paged_read',
 '6405_contract_email_recovery_guard_identity',
 '6406_contract_email_recovery_callback_identity',
 '6407_contract_live_form_source_owner',
 '6408_contract_email_prerequisite_state_binding',
 '6409_contract_unsigned_email_form_sources',
 '6410_contract_original_email_readiness_recheck',
 '6411_contract_form_native_field_parity',
 '6412_contract_setup_ending_email_readiness',
 '6413_contract_setup_preserved_definition_review',
 '6414_contract_email_current_set_source',
 '6415_contract_email_work_archived_company',
 '6416_contract_email_current_explicit_tenant',
 '6417_contract_email_actual_upload_signal_identity',
 '6418_contract_shared_mail_native_compatibility',
 '6419_contract_configuration_directory',
 '6420_contract_historical_email_recovery',
 '6421_contract_posting_protected_job_foundation',
 '6422_contract_posting_recorded_replay_frames',
 '6423_contract_posting_prepared_target_source',
 '6424_contract_posting_bound_target_completion',
 '6425_contract_posting_finish_and_commit_guard',
 '6426_contract_posting_first_producer_readiness',
 '6427_contract_posting_admission_and_status_ports',
 '6428_contract_posting_application_metadata',
 '6429_contract_posting_reconciliation_and_authority',
 '6430_contract_email_document_hr_notices',
 '6431_contract_posting_org_snapshot_owner',
 '6432_contract_shared_navigation_access',
 '6433_contract_email_form_binding_order',
 '6434_contract_empty_opening_technical_finish',
 '6435_automation_offboarding_configuration_compatibility',
 '6436_contract_setup_fingerprint_setwise',
 '6437_contract_completed_email_child_context',
 '6438_contract_setup_membership_fold',
 '6439_contract_resignation_shared_compatibility',
 '6440_own_leave_shared_access',
 '6441_contract_resignation_email_modules',
] as const;

// Approved but not yet installed forward tail; this fixture independently pins journal identity.
const APPROVED_BOARD_TAIL:Entry[]=[
 {idx:5500,version:'7',when:1794841006100,tag:'6100_rewards_review_plans',breakpoints:true},
 {idx:5501,version:'7',when:1794841006101,tag:'6101_reward_person_history',breakpoints:true},
 {idx:5502,version:'7',when:1794841006102,tag:'6102_lifecycle_recipient_directory',breakpoints:true},
 {idx:5503,version:'7',when:1794841006103,tag:'6103_lifecycle_pbp_removal',breakpoints:true},
 {idx:5504,version:'7',when:1794841006104,tag:'6104_lifecycle_recipient_fanout',breakpoints:true},
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
 // row no import staged, and only then is the row compared without it. 5161 (draft 9770) adds the company's team minimum the
 // same way: unset on every company that predates it.
 const withoutImportMarker=(rows:Record<string,unknown>)=>Object.fromEntries(Object.entries(rows).map(([table,list])=>[table,
  (list as {row:Record<string,unknown>}[]).map(({row})=>{
   const rest={...withoutCombinedReleaseNulls(table,row)};
   for(const column of ['import_pending_attempt_id',...(table==='company'?['leave_team_minimum_present']:[]),...(table==='employment'?['rehired_from_employment_id']:[])]){
    if(!(column in rest))continue;
    expect(rest[column],table+'.'+column+' on a retained row').toBeNull();
    delete rest[column];
   }
   return {row:rest};
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
   // Irwin attendance workflow lane draft (daa76ed4/96a54ed2).
   '5140_attendance_workflow_cross_company_pending',
   '5141_attendance_workflow_escalation',
   '5142_attendance_on_behalf',
   '5143_attendance_final_decision_window',
   '5144_attendance_lane_security_review',
   // 96a54ed2: the AI Centre controls for the two on-behalf reads.
   '5145_ai_attendance_on_behalf_reads',
   // Irwin Schedule Group Overtime Setting (2f803985): per-date rounding (function replacement only).
   '5150_attendance_policy_dated_rounding',
   // Sweep reads each company's net-swing threshold (draft 9760), allocated 5160 (13 November 2026).
   '5160_sweep_swing_thresholds',
   // Manager Today team minimum (draft 9770), allocated 13 November 2026 as 5161.
   '5161_leave_team_minimum_present',
   // Probation and passport loops act as request-only steps (13 November 2026): draft 9780 allocated as 5162, widened CHECKs only.
   '5162_teras_loop_request_acts',
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
   '5620_rewards_config_grants_creator_lock',
   // Gate repair (13 November 2026): the ADR-0174 composite key for 5460's lc_v9_email_hold.
   '5640_lifecycle_v9_email_hold_company_tenant',
   // Statutory follow-ups (14 November 2026): EPF Bonus 2012 on the seeded-shape default BONUS pay item.
   '5660_pay_component_bonus_epf_bonus_2012',
   // Board 4604dccc (15 November 2026): payroll history binds a record to the company of its month.
   '5680_payroll_history_dated_company',
   // Board 4604dccc r3 (15 November 2026): payslip snapshots from recorded history.
   '5690_information_payslip_snapshot_from_history',
   // Board 511aa74a (15 November 2026): the employment period link of a Rehired event.
   '5695_employment_rehire_link',
   // Board 4604dccc r4 (16 November 2026): the latest saved information correction controls the SQL readers.
   '5696_information_correction_latest_saved',
   // Probation reshape onto shared HR automation (16 November 2026): shared definitions, Personnel postings (whose
   // company key follows ADR-0174) and shared email templates.
   '5740_automation_shared_definitions',
   '5741_personnel_postings',
   '5742_probation_settings_scope',
   '5743_automation_email_templates',
   '5744_probation_case_at_activation',
   '5745_probation_outcome_override_event',
   '5746_probation_tracker_scale_and_extensions',
   '5747_document_signing_review_routing',
   '5748_automation_runs',
   '5749_probation_delegation',
   '5750_probation_tracker_plan_robustness',
   '5751_probation_queues_and_form_routing',
   '5752_probation_letter_routing',
   '5753_probation_outcome_automation',
   // Lane F (16 November 2026): real email for shared workflow steps.
   '5754_automation_email_delivery',
   '5755_probation_routed_assignment',
   '5756_probation_form_approver_choices',
   '5757_probation_legacy_workflow_move',
   '5758_probation_routed_overrides',
   '5759_probation_employee_own_steps_only',
   '5760_probation_queue_kinds_and_pbp_tasks',
   '5761_probation_automation_recipients_and_tracker_steps',
   // Lane J (16 November 2026): imported saved offline evaluation forms.
   '5762_probation_form_import',
   // Lane K (16 November 2026): Probation access roles, scoped members and the Direct Superiors rule.
   '5763_probation_access_roles',
   // Lane K2 (16 November 2026): the shared routings own a case's PBP and Head of Department.
   '5764_probation_routed_holders',
   // Lane L (16 November 2026): letter signers for unsigned signature blocks and Required signers.
   '5765_probation_letter_signers',
   // Release gate (16 November 2026): company deletion sees the reshape's owner-only company referrers.
   '5766_probation_reshape_company_in_use',
   // Board 237c31e6 (16 November 2026): the request-bound approver Employee ID readers.
   '5770_attendance_workflow_approver_codes',
   // Architecture/performance: shared Access for the existing assistant metadata index.
   '5771_assistant_legacy_index_shared_access',
   '5772_movement_employment_periods',
   '5773_movement_payroll_protection_and_delete',
   '5774_employment_payment_method_history',
   '5775_movement_payment_method_field',
   '5776_workforce_payroll_input_invalidation',
   '5777_movement_closed_payroll_metadata',
   '5778_movement_payroll_windows',
   '5779_hire_company_allocation_review',
   // Recruitment slices 1–25 (17 November 2026; renumbered 5700–5727 → 5850–5877).
   '5850_recruiting_partner_role',
   '5851_recruitment_core',
   '5852_recruitment_team_interviews',
   '5853_recruitment_offers_hire_handoff',
   '5854_recruitment_requisitions',
   '5855_recruitment_candidate_privacy',
   '5856_recruitment_report_indexes',
   '5857_recruitment_referrals',
   '5858_recruitment_careers_page',
   '5859_recruitment_tasks',
   '5860_recruitment_agencies',
   '5861_recruitment_screening',
   '5862_recruitment_background_checks',
   '5863_recruitment_talent_pools_blocked_list',
   '5864_recruitment_consume_invitation_access_lock',
   '5865_recruitment_custom_fields',
   '5866_recruitment_position_templates',
   '5867_recruitment_import_export',
   '5868_recruitment_waiting_limits',
   '5869_recruitment_interview_setup',
   '5870_recruitment_candidate_email',
   '5871_recruitment_candidate_email_interviews_offers',
   '5872_recruitment_careers_verified_applicants',
   '5873_recruitment_candidate_response_links',
   '5874_recruitment_candidate_survey',
   '5875_recruitment_referral_rewards_agency_fees',
   '5876_recruitment_ai_match_summary',
   '5877_recruitment_agency_portal',
   ...APPROVED_BOARD_TAIL.map(row=>row.tag),
   ...APPROVED_COMBINED_RELEASE_TAGS,
  ]);
  expect(journal.entries.slice(919,924)).toEqual(APPROVED_BOARD_TAIL);
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
  // The exact signed resignation construction changes only this invoker trigger's
  // subject lookup branch; its identity, owner-only ACL and other callers remain.
  // Contract source admission preserves this native invoker trigger identity,
  // owner-only ACL and all existing callers.
  const [v9Integrity]=await storage.client`select prosecdef as security_definer,
   has_function_privilege('ai_hr_app',oid,'EXECUTE') as app_execute,
   exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
   from pg_proc where oid='app.lc_v9_integrity()'::regprocedure`;
  expect(v9Integrity).toEqual({security_definer:false,app_execute:false,public_execute:false});
  // Every function the forward migrations add, with its reviewed EXECUTE privileges: private functions are not
  // callable by the application role, and none is callable by PUBLIC. The policy-side and trigger-WHEN helpers are
  // granted to exactly the roles their policies or the domain_event writers are (test/policy-helper-function-grants).
  const privateFunctions=[
   ...contractIntent.functionsAdded.filter(fn=>!fn.appExecute).map(fn=>fn.signature),
   // Movement5777: shared metadata implementation is private; only the validated public wrappers execute it.
   'app.preserve_payroll_metadata(uuid,boolean)',
   // 5850–5877: Recruitment owner-only helpers and definers (careers, portal, sweeps), not executable by ai_hr_app.
   'app.recruitment_agency_check(uuid,uuid,text,text,text,text,uuid,boolean)','app.recruitment_agency_matches(uuid,uuid,text,text,text,text,uuid)','app.recruitment_agency_portal_anonymous()',
   'app.recruitment_agency_portal_consultants(uuid,uuid,text)','app.recruitment_agency_portal_prune(uuid,uuid)','app.recruitment_agency_portal_session_at(text,text)',
   'app.recruitment_agency_portal_site(text)','app.recruitment_agency_submission_link()','app.recruitment_application_applied_now()',
   'app.recruitment_background_check_cancel_reason_settled()','app.recruitment_background_check_has_detail()','app.recruitment_blocked_lock_key(uuid,uuid)',
   'app.recruitment_blocked_mark(uuid,uuid,uuid,uuid,uuid,uuid,uuid)','app.recruitment_blocked_match(uuid,uuid,uuid,boolean)','app.recruitment_blocked_match_application()',
   'app.recruitment_candidate_email_claim(integer)','app.recruitment_candidate_email_finish(uuid,uuid,text,text)','app.recruitment_candidate_email_hour_count_owner(uuid,uuid)',
   'app.recruitment_candidate_email_purge(integer)','app.recruitment_candidate_email_start(uuid,uuid,text)','app.recruitment_candidate_email_target(uuid,uuid)',
   'app.recruitment_candidate_email_worker_ok()','app.recruitment_careers_email_digest(text)','app.recruitment_careers_prune()',
   'app.recruitment_careers_site_at(text)','app.recruitment_careers_submit(text,uuid,text,text,text,text,text,integer,boolean,text,text,bytea)','app.recruitment_careers_verification_required(uuid,uuid)',
   'app.recruitment_check_candidate_email_queue()','app.recruitment_clear_to_assign()','app.recruitment_enabled_for(uuid)',
   'app.recruitment_guard_agency_detail()','app.recruitment_guard_agency_fee()','app.recruitment_guard_agency_portal_submission()',
   'app.recruitment_guard_agency_setup()','app.recruitment_guard_agency_submission()','app.recruitment_guard_application()',
   'app.recruitment_guard_application_event()','app.recruitment_guard_archive_reason()','app.recruitment_guard_background_check()',
   'app.recruitment_guard_background_check_detail()','app.recruitment_guard_background_check_file()','app.recruitment_guard_background_check_type()',
   'app.recruitment_guard_background_check_type_link()','app.recruitment_guard_blocked()','app.recruitment_guard_candidate()',
   'app.recruitment_guard_candidate_child()','app.recruitment_guard_candidate_email()','app.recruitment_guard_candidate_email_setting()',
   'app.recruitment_guard_candidate_email_template()','app.recruitment_guard_candidate_import()','app.recruitment_guard_careers_application()',
   'app.recruitment_guard_careers_author()','app.recruitment_guard_careers_notice()','app.recruitment_guard_careers_site()',
   'app.recruitment_guard_custom_field()','app.recruitment_guard_custom_field_option()','app.recruitment_guard_custom_value()',
   'app.recruitment_guard_evaluation_form()','app.recruitment_guard_export_template()','app.recruitment_guard_hire_handoff()',
   'app.recruitment_guard_identity()','app.recruitment_guard_interview()','app.recruitment_guard_interview_place()',
   'app.recruitment_guard_interview_question_link()','app.recruitment_guard_interview_setup()','app.recruitment_guard_interviewer()',
   'app.recruitment_guard_interviewer_group_member()','app.recruitment_guard_job()','app.recruitment_guard_job_agency_contract()',
   'app.recruitment_guard_job_careers_page()','app.recruitment_guard_job_referral_portal()','app.recruitment_guard_job_referral_reward()',
   'app.recruitment_guard_job_template()','app.recruitment_guard_offer()','app.recruitment_guard_offer_approval()',
   'app.recruitment_guard_offer_field()','app.recruitment_guard_offer_value()','app.recruitment_guard_position_template()',
   'app.recruitment_guard_position_template_value()','app.recruitment_guard_preview_quota()','app.recruitment_guard_referral()',
   'app.recruitment_guard_referral_reward()','app.recruitment_guard_repeat_application()','app.recruitment_guard_requisition()',
   'app.recruitment_guard_requisition_approval()','app.recruitment_guard_review_mark()','app.recruitment_guard_scorecard()',
   'app.recruitment_guard_screening_answer()','app.recruitment_guard_screening_request()','app.recruitment_guard_stage()',
   'app.recruitment_guard_stage_waiting_rule()','app.recruitment_guard_tag()','app.recruitment_guard_talent_pool()',
   'app.recruitment_guard_talent_pool_member()','app.recruitment_guard_talent_pool_share()','app.recruitment_guard_task_read_marker()',
   'app.recruitment_guard_to_assign()','app.recruitment_referral_freeze_reward()','app.recruitment_referrer_companies()',
   'app.recruitment_response_state(app.recruitment_response_link)','app.recruitment_screening_answered()','app.recruitment_screening_close_for_application()',
   'app.recruitment_screening_close_for_reviewer()','app.recruitment_settle_candidate_import(uuid)','app.recruitment_survey_issue(uuid,uuid,text)',
   'app.recruitment_survey_live(text)','app.recruitment_survey_prune()','app.recruitment_talent_pool_sharing_follows()',
   'app.recruitment_withdraw_interview_emails()',
   // Owner-only team admission, communication custody and immutable receipt trigger.
   'app.resignation_letter_step_mine(jsonb,jsonb)',
   'app.resignation_letter_owner_mine(jsonb)',
   'app.resignation_communication_case_scope(uuid,uuid)',
   'app.resignation_communication_test_immutable()',

   // Native managed-submission cutover: the insert trigger remains owner-only.
   'app.resignation_submission_guard()',
   // Resignation9991/9993: private command verifiers and revoked original Probation implementations.
   'app.offboarding_posting_group_members(text)','app.offboarding_posting_references_ok(uuid,jsonb)','app.offboarding_posting_values_ok(text,jsonb)','app.personnel_posting_approve_probation_v1(uuid,integer,jsonb)','app.personnel_posting_create_probation_v1(text,uuid,uuid,text,jsonb,text,text)','app.personnel_posting_edit_probation_v1(uuid,integer,jsonb)','app.personnel_posting_visible_probation_v1(text,uuid,text)','app.resignation_command_allowed(uuid,jsonb)','app.resignation_journey_subject_guard()','app.resignation_managed_request_guard()','app.resignation_notification_owner()','app.resignation_notification_valid(notification)','app.resignation_pending_steps(jsonb)','app.resignation_runtime_consume(text,uuid,jsonb)','app.resignation_runtime_intent(uuid)',
   // 5763: Probation access helpers, owner only.
   'app.probation_access_scope_check(uuid,uuid,date,date)','app.probation_intake_admin_for(uuid,uuid,uuid)','app.probation_permitted_companies(uuid,text[])','app.probation_permitted_scope(text,uuid[])','app.probation_postings_admin(uuid[])','app.probation_superior_rule()',
   // 5764: the routed holder resolver and routing-rule helpers, owner only.
   'app.probation_routed_holders(uuid[])','app.probation_routing_dimension(jsonb,text[])','app.probation_routing_weight(jsonb,integer)',
   // 5763: Probation access helpers, owner only.
   'app.probation_access_scope_check(uuid,uuid,date,date)','app.probation_intake_admin_for(uuid,uuid,uuid)','app.probation_permitted_companies(uuid,text[])','app.probation_permitted_scope(text,uuid[])','app.probation_postings_admin(uuid[])','app.probation_superior_rule()',
   // 5760: owner-only helpers.
   'app.probation_pending_signer_kinds(uuid)',
   // Board 511aa74a (5695): the rehire link guard is a trigger function, owner only.
   'app.employment_rehire_link_guard()',
   // 5756: approver role, group membership, approver label and form route checks, owner only.
   'app.probation_form_approver_role(text)','app.probation_v9_group_member(text,uuid)','app.probation_form_approver_label(text)','app.probation_validate_form_route(jsonb,integer)',
   // Probation core (5742, 5744-5746, 5749-5751): internal helpers, never granted to the application role.
   'app.probation_company_ancestors(uuid[])',
   'app.probation_config_write_company(uuid,text,jsonb,boolean,integer)',
   'app.probation_did_not_join(uuid)',
   'app.probation_general_delegate(uuid,uuid,text)',
   'app.probation_holders_set(uuid[])',
   'app.probation_settings_materialize(uuid[])',
   'app.probation_settings_scope_check(text,jsonb)',
   'app.probation_source_from_start(jsonb,uuid)',
   'app.probation_visible_among(uuid[])',
   // 5752: routed letter template checks, owner only.
   'app.probation_letter_routed(jsonb)','app.probation_letter_routing_signatures_ok(jsonb)','app.probation_letter_routing_valid(jsonb)',
   // 5753: the posting-approval trigger function, owner only.
   'app.probation_posting_approved()',
   // 5754: the workflow email immutability trigger function, owner only.
   'app.automation_email_immutable()',
   // 5748: the run-log bound check, owner only.
   'app.automation_run_log_valid(jsonb)',
   // 5741: the approval-commit trigger and two internal posting value helpers, never granted to the application role.
   'app.personnel_posting_approval_complete()','app.personnel_posting_day(jsonb)','app.personnel_posting_values_ok(text,jsonb)',
   // Board window 4 (5124): a trigger function, never granted to the application role.
   // 5129: the set-wise effective-snapshot owner, inlined into app.payroll_history_effective and the batch aggregate.
   // Board release block 5400-5560: three trigger functions, owner only.
   // 5580/5600: owner-only readers, trigger functions, the PAT repricing chain and the review creator's source copies.
   // daa76ed4/96a54ed2 (5140-5142): the login rule helper and two trigger functions, never granted to the application role.
   'app.attendance_workflow_approver_login(uuid)','app.attendance_workflow_stage_clock()','app.attendance_correction_submitter_guard()',
   // 5143: the request-bound final-decision read window proof, called only by the owner-run visibility functions.
   'app.attendance_effect_window_employment()',
   // 5144: the window token and proof (owner only).
   'app.attendance_final_window_token(uuid,uuid)','app.attendance_final_window_prove(uuid)',
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
  // 5620 took EXECUTE on the 5580 configuration predicates and the creating flag away from PUBLIC; each is granted to
  // the roles that evaluate it (test/rewards-config-grants-lock.test.ts), so no added function is callable by PUBLIC.
  // 5850–5877: Recruitment's SECURITY INVOKER predicates and normalisers keep the default PUBLIC EXECUTE (they run with the
  // caller's own privileges).
  const publicFunctions:string[]=[
   'app.can_admin_recruitment_for(uuid)','app.can_operate_recruitment_job(uuid,uuid)','app.can_read_recruitment_application(uuid,uuid,uuid)',
   'app.can_review_recruitment_job(uuid,uuid)','app.can_see_recruitment_company(uuid)','app.recruitment_candidate_lock_key(uuid,uuid)',
   'app.recruitment_contract_usable(uuid)','app.recruitment_destroying_application(uuid)','app.recruitment_has_job_role(uuid,text[])',
   'app.recruitment_interviews_application(uuid)','app.recruitment_norm_email(text)','app.recruitment_norm_id(text)',
   'app.recruitment_norm_mobile(text)','app.recruitment_norm_name(text)','app.recruitment_offer_value_visible(uuid,uuid,uuid,uuid)',
   'app.recruitment_operates_candidate(uuid,uuid)','app.recruitment_operates_in_company(uuid)','app.recruitment_reads_candidate(uuid)',
   'app.recruitment_reviews_candidate(uuid,uuid)','app.recruitment_scorecards_private(uuid)','app.recruitment_team_in_company(uuid)',
  ];
  const addedFunctions=[
   // Handoff corrections: exact native team, date and case-communication entry points; never PUBLIC.
   'app.resignation_letter_step_mine(jsonb,jsonb)',
   'app.resignation_letter_owner_mine(jsonb)',
   'app.resignation_communication_case_scope(uuid,uuid)',
   'app.resignation_communication_test_immutable()',
   'app.resignation_offboarding_date_intent(uuid,date,date)',
   'app.resignation_offboarding_date_store(uuid,integer,date,date,jsonb)',
   'app.resignation_communication_scope(uuid,uuid,uuid)',
   'app.resignation_communication_test_receipt(uuid,integer,uuid,text,uuid,uuid)',
   'app.resignation_communication_test_begin(uuid,integer,uuid,text,uuid,uuid,jsonb)',
   'app.resignation_communication_test_queue(uuid,integer,uuid,text,uuid,jsonb)',
   'app.resignation_communication_runs(uuid,uuid)',
   'app.resignation_communication_offboarding_context(uuid,uuid,uuid)',
   'app.resignation_communication_files(uuid,uuid)',

   // Human-only pending Offboarding posting member labels; application EXECUTE, never PUBLIC.
   'app.offboarding_posting_waiting_members(uuid[])',
   // Scoped company-retention boolean; journey rows retain their existing custody-only RLS.
   'app.resignation_company_in_use(uuid)',
   // Reverse-linked clearance template IDs: scoped native metadata, application EXECUTE only.
   'app.resignation_offboarding_template_ids(uuid)',
   // HMAC-bound missing-decision repair audience: application entry point, never PUBLIC.
   'app.resignation_decision_repair_audience(uuid)',
   // Verified managed-V9 classification; a scoped native boolean, callable by the application only.
   'app.resignation_offboarding_case_managed(uuid)',
   // Final shared directory and managed-submission cutover helpers.
   'app.contract_configuration_directory(uuid[],text,uuid[])','app.resignation_managed_submission_enabled(uuid)','app.resignation_submission_guard()',
   // Resignation9991/9992/9993/9995: explicit native entry points and private implementation identities.
   'app.offboarding_posting_choices(uuid,text)','app.offboarding_posting_due(uuid,date)','app.offboarding_posting_edit_event(uuid,integer,text,jsonb)','app.offboarding_posting_group(uuid,text)','app.offboarding_posting_group_members(text)','app.offboarding_posting_ops(uuid)','app.offboarding_posting_queue_access()','app.offboarding_posting_reassign(text,text)','app.offboarding_posting_receipt(uuid)','app.offboarding_posting_references_ok(uuid,jsonb)','app.offboarding_posting_reject(uuid,integer,text)','app.offboarding_posting_terms(uuid)','app.offboarding_posting_values_ok(text,jsonb)','app.personnel_posting_approve_probation_v1(uuid,integer,jsonb)','app.personnel_posting_create_probation_v1(text,uuid,uuid,text,jsonb,text,text)','app.personnel_posting_edit_probation_v1(uuid,integer,jsonb)','app.personnel_posting_visible_probation_v1(text,uuid,text)','app.resignation_command_allowed(uuid,jsonb)','app.resignation_configuration_usage(text[],text[])','app.resignation_email_assets(uuid,uuid,text)','app.resignation_email_files(uuid,uuid,text)','app.resignation_email_queue(uuid,text,uuid[],uuid[],text,text,jsonb)','app.resignation_handoff_active()','app.resignation_journey_access(uuid)','app.resignation_journey_admit(text,text)','app.resignation_journey_can_act(uuid,text)','app.resignation_journey_context(uuid,uuid)','app.resignation_journey_create(uuid,jsonb,uuid[])','app.resignation_journey_notify(uuid,text,uuid[],text,text)','app.resignation_journey_save(uuid,integer,text,text,jsonb,uuid[],uuid)','app.resignation_journey_subject_guard()','app.resignation_managed_clearance_ready(uuid)','app.resignation_managed_request_guard()','app.resignation_notification_owner()','app.resignation_notification_valid(notification)','app.resignation_offboarding_admit(uuid)','app.resignation_offboarding_intent(uuid)','app.resignation_offboarding_sequence(uuid)','app.resignation_pending_steps(jsonb)','app.resignation_posting_run_rejected(uuid,uuid,text)','app.resignation_request_is_managed(uuid)','app.resignation_run_retry_save(uuid,jsonb)','app.resignation_runtime_consume(text,uuid,jsonb)','app.resignation_runtime_intent(uuid)','app.resignation_runtime_readable(uuid,uuid,uuid)',
   // Board window 4 (5124): the preview binding trigger (owner only) and the superior diagnostic.
   // Board release block 5400-5560 (12 November 2026): the Rewards, dashboard and On/Off Boarding functions. Kept sorted.
   // daa76ed4/96a54ed2 (5140-5144, origin/alpha 65e23a1e7): the attendance resolution, escalation, on-behalf and final-window functions.
   // 5160 (origin/alpha de15677b0): the sweep's net-swing threshold reader.
   // Probation reshape (5740, 5741, 5743; 16 November 2026): shared automation and Personnel postings functions.
   // 5747/5748: document signing review-routing helpers and the shared workflow-run functions.
   // Probation core (5742, 5744-5746, 5749, 5751; 16 November 2026): settings scope, case at activation, override event, set-based access and tracker, delegation, work queues.
   // 5752: routed Probation letters (routing context, route freeze and three owner-only template checks).
   // 5753: Probation outcomes on the shared workflow runner (context, notify, outcome runs, posting effect, posting-approval trigger).
   // 5754: shared workflow email (queue, the private sender's target, start and finish, and the owner-only immutability trigger).
   // 5755: routed Probation steps (assignment facts for the V9 assignment owner).
   // 5756: approver choices on form approval rows (approver role helper, form route validator, group membership and label helpers, routing context and approver freeze).
   // 5757: legacy Probation workflows move to the shared engine (legacy audience, move and its list, daily overdue summary cases).
   // 5762: imported saved evaluation forms (import, the reviewer's list and the original-file download).
   // Board 511aa74a (5695): the rehire link guard, its Roll Back writer and blockers, and the person-state count.
   // 5763: Probation access (role, member and rule commands, the page reader, people search and navigation, permission and scope helpers).
   // 5764: the routed PBP and Head of Department resolver and its two routing-rule helpers, owner only.
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
   'app.attendance_clock_policy_history(uuid,uuid)','app.attendance_correction_submitter_guard()','app.attendance_effect_window_employment()',
   'app.attendance_final_window_prove(uuid)','app.attendance_final_window_token(uuid,uuid)','app.attendance_frozen_actor_identity_keys(jsonb,text)',
   // Board 237c31e6 (5770): the two request-bound approver Employee ID readers, EXECUTE for the application role.
   'app.attendance_pending_visible_headers(uuid)','app.attendance_workflow_approver_codes(uuid[])','app.attendance_workflow_approver_login(uuid)','app.attendance_workflow_close_final_window()',
   'app.attendance_workflow_escalate(uuid,date)','app.attendance_workflow_escalation_due(date,date,uuid,integer)','app.attendance_workflow_escalation_written(uuid,uuid,integer)',
   'app.attendance_workflow_hierarchy_v5(uuid,integer)','app.attendance_workflow_on_behalf_allowed(uuid,integer,text)','app.attendance_workflow_on_behalf_slot(uuid,uuid)',
   'app.attendance_workflow_open_final_window(uuid)','app.attendance_workflow_preview_bind()','app.attendance_workflow_route_approver_codes(uuid,uuid)','app.attendance_workflow_stage_clock()',
   'app.attendance_workflow_superior_diagnostic(uuid,integer)','app.automation_active_users(uuid[])','app.automation_assignment_groups()',
   'app.automation_can_configure(text)','app.automation_can_configure_any()','app.automation_can_run(text,uuid)',
   'app.automation_email_finish(uuid,uuid,text,text)','app.automation_email_immutable()','app.automation_email_queue(text,uuid,text,uuid[],uuid[],text,text)',
   'app.automation_email_start(uuid,uuid,text,jsonb)','app.automation_email_target(uuid,uuid,text)','app.automation_email_template_save(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text)',
   'app.automation_routing_save(uuid,text,jsonb,boolean,integer,text)','app.automation_run_log_valid(jsonb)','app.automation_run_save(uuid,text,text,integer,uuid,jsonb,jsonb,text)',
   'app.automation_run_start(uuid,text,uuid,integer,uuid,text,text,text,jsonb,jsonb)','app.automation_run_subject_access(text,uuid)','app.automation_runner_waiting(text,uuid,uuid)',
   'app.automation_runner_workflows(text,text,uuid)','app.automation_workflow_save(uuid,text,text,boolean,jsonb,integer,text)','app.bulk_job_access(uuid)',
   'app.bulk_job_admit()','app.bulk_job_attribution()','app.bulk_job_capability_held(uuid)',
   'app.bulk_job_clear_inputs(uuid,boolean)','app.bulk_job_enqueue(text,uuid,uuid[],text,bytea,jsonb)','app.bulk_job_event_attribution()',
   'app.bulk_job_fence(uuid,text)','app.bulk_job_held(uuid)','app.bulk_job_input_conforms(jsonb,integer,jsonb)',
   'app.bulk_job_input_shape_valid(jsonb)','app.bulk_job_lease_capability(uuid,uuid,text)','app.bulk_job_mark_watched(uuid)',
   'app.bulk_job_notice_recipients(uuid)','app.bulk_job_pending_steps(uuid,integer)','app.bulk_job_request_cancel(uuid,text)',
   'app.bulk_job_scope_current(text,uuid[])','app.bulk_job_seal_verify(uuid,text)','app.bulk_job_step_digest(text,integer,jsonb,text,jsonb,text)',
   'app.bulk_job_step_update(uuid,integer[],jsonb)','app.bulk_job_steps_put(uuid,boolean,jsonb)','app.bulk_job_value_digest(jsonb)',
   'app.bulk_job_waiting(uuid)','app.bulk_job_worker_ready(text)','app.bulk_job_worker_update(uuid,jsonb)',
   'app.can_admin_recruitment_for(uuid)',
   'app.can_operate_recruitment_job(uuid,uuid)',
   'app.can_read_recruitment_application(uuid,uuid,uuid)',
   'app.can_review_recruitment_job(uuid,uuid)',
   'app.can_see_recruitment_company(uuid)',
   'app.contract_renewal_open(uuid)','app.delegated_approval_subjects(uuid[],text,text)','app.document_signing_can_edit(jsonb,uuid)',
   'app.document_signing_content_visible(uuid,boolean)','app.document_signing_locked(jsonb)','app.document_signing_owner(jsonb)',
   'app.document_signing_owner_step(jsonb)','app.document_signing_pending_steps(jsonb)','app.document_signing_returned(jsonb)',
   'app.document_signing_round_actions(jsonb)','app.domain_event_chain_arm()','app.domain_event_chain_flush(uuid)',
   'app.domain_event_chain_seal_now()','app.domain_event_chain_sealing()','app.employee_import_revert_release(uuid,boolean)',
   'app.employment_rehire_link_guard()','app.employment_rehire_person_state(uuid,date)','app.employment_rehire_rollback(uuid,text)',
   'app.employment_rehire_rollback_blockers(uuid)','app.employment_void_reference_blockers(uuid[])','app.home_leave_presentation_index(text)',
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
   'app.personnel_overview_page_rows(date,uuid[],uuid[])','app.personnel_overview_page_rows_typed(date,uuid[],uuid[])','app.personnel_posting_approval_complete()',
   'app.personnel_posting_approve(uuid,integer,jsonb)','app.personnel_posting_approver(text)','app.personnel_posting_create(text,uuid,uuid,text,jsonb,text,text)',
   'app.personnel_posting_day(jsonb)','app.personnel_posting_edit(uuid,integer,jsonb)','app.personnel_posting_groups(text[])',
   'app.personnel_posting_people(uuid[])','app.personnel_posting_record_movement(uuid,text)','app.personnel_posting_values_ok(text,jsonb)',
   'app.personnel_posting_visible(text,uuid,text)','app.personnel_private_search_entries(text,uuid[])','app.personnel_search_candidates(uuid[],boolean,boolean,text,text,text,text,text[])',
   'app.probation_access_admin()','app.probation_access_member_add(uuid,uuid,uuid,uuid,date,date)','app.probation_access_member_change(uuid,uuid,uuid,date,date)',
   'app.probation_access_member_revoke(uuid,text)','app.probation_access_navigation()','app.probation_access_people(text)',
   'app.probation_access_role_retire(uuid,integer,text)','app.probation_access_role_save(uuid,text,text[],integer)','app.probation_access_rule_save(boolean,boolean,boolean,integer)',
   'app.probation_access_scope_check(uuid,uuid,date,date)','app.probation_access_view()','app.probation_assignment_facts(uuid,text[],uuid[])',
   'app.probation_automation_active_users(uuid,uuid[])','app.probation_automation_context(uuid)','app.probation_automation_notify(uuid,uuid,text,text,uuid[])',
   'app.probation_case_permitted(uuid,text)','app.probation_company_ancestors(uuid[])','app.probation_config_write_company(uuid,text,jsonb,boolean,integer)',
   'app.probation_decide_other(uuid,integer,text,integer,text)','app.probation_did_not_join(uuid)','app.probation_form_approver_label(text)',
   'app.probation_form_approver_role(text)','app.probation_form_freeze_approvers(uuid,jsonb)','app.probation_form_import(uuid,text,text,bytea,jsonb)',
   'app.probation_form_import_read(uuid)','app.probation_form_imports(uuid)','app.probation_form_routing_context(uuid)',
   'app.probation_general_delegate(uuid,uuid,text)','app.probation_holders_set(uuid[])','app.probation_intake_admin(uuid)',
   'app.probation_intake_admin_for(uuid,uuid,uuid)','app.probation_legacy_audience(uuid,uuid)','app.probation_letter_freeze_route(uuid,jsonb,jsonb)',
   'app.probation_letter_routed(jsonb)','app.probation_letter_routing_context(uuid)','app.probation_letter_routing_signatures_ok(jsonb)',
   'app.probation_letter_routing_valid(jsonb)','app.probation_letter_signers(uuid)','app.probation_max_extensions(jsonb)',
   'app.probation_outcome_automation(uuid)','app.probation_overdue_summary_cases(uuid,date)','app.probation_pending_signer_kinds(uuid)',
   'app.probation_permitted(text,uuid)','app.probation_permitted_companies(uuid,text[])','app.probation_permitted_scope(text,uuid[])',
   'app.probation_posting_approved()','app.probation_postings_admin(uuid[])','app.probation_record_low_result_action(uuid,text)',
   'app.probation_record_override(uuid)','app.probation_record_posting_effect(uuid,uuid,uuid,jsonb,jsonb)','app.probation_reshape_company_in_use(uuid)','app.probation_routed_holders(uuid[])',
   'app.probation_routing_dimension(jsonb,text[])','app.probation_routing_weight(jsonb,integer)','app.probation_settings_materialize(uuid[])',
   'app.probation_settings_scope_admin()',
   'app.probation_settings_scope_check(text,jsonb)','app.probation_settings_scope_refresh(uuid)','app.probation_settings_scope_retire(uuid,integer,text)',
   'app.probation_settings_scope_save(uuid,text,text,uuid[],jsonb,boolean,integer,text)','app.probation_shared_workflow_triggers()','app.probation_source_from_start(jsonb,uuid)',
   'app.probation_superior_rule()','app.probation_task_list(text,integer)','app.probation_tracker_cases()',
   'app.probation_tracker_page(uuid[])','app.probation_v9_group_member(text,uuid)','app.probation_validate_form_route(jsonb,integer)',
   'app.probation_visible_among(uuid[])','app.probation_visible_case_ids()','app.probation_workflow_move(jsonb,text)',
   'app.probation_workflow_moves()',
   'app.recruitment_admin_contacts(uuid)',
   'app.recruitment_agency_check(uuid,uuid,text,text,text,text,uuid,boolean)',
   'app.recruitment_agency_clearing(uuid)',
   'app.recruitment_agency_matches(uuid,uuid,text,text,text,text,uuid)',
   'app.recruitment_agency_portal_anonymous()',
   'app.recruitment_agency_portal_check_code(text,text,text,text,text)',
   'app.recruitment_agency_portal_consultants(uuid,uuid,text)',
   'app.recruitment_agency_portal_email_context(text)',
   'app.recruitment_agency_portal_issue_code(text,text,text,text)',
   'app.recruitment_agency_portal_open(uuid,uuid)',
   'app.recruitment_agency_portal_prune(uuid,uuid)',
   'app.recruitment_agency_portal_session_at(text,text)',
   'app.recruitment_agency_portal_sign_out(text)',
   'app.recruitment_agency_portal_site(text)',
   'app.recruitment_agency_portal_status(text,text)',
   'app.recruitment_agency_portal_submit(text,text,text,uuid,uuid,text,text,text,text,text,text,bytea,boolean)',
   'app.recruitment_agency_portal_view(text,text)',
   'app.recruitment_agency_submission_check(uuid,uuid,text,text,text,text)',
   'app.recruitment_agency_submission_link()',
   'app.recruitment_application_agency(uuid)',
   'app.recruitment_application_applied_now()',
   'app.recruitment_application_needs_review(uuid)',
   'app.recruitment_application_referral(uuid)',
   'app.recruitment_background_check_cancel_reason_settled()',
   'app.recruitment_background_check_candidate_open(uuid,uuid)',
   'app.recruitment_background_check_has_detail()',
   'app.recruitment_background_check_stage_ok(uuid)',
   'app.recruitment_block_candidate(uuid,text)',
   'app.recruitment_blocked_identity_match(text,text,text,text,text,text,text,text)',
   'app.recruitment_blocked_lock_key(uuid,uuid)',
   'app.recruitment_blocked_mark(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
   'app.recruitment_blocked_match(uuid,uuid,uuid,boolean)',
   'app.recruitment_blocked_match_application()',
   'app.recruitment_blocked_matching(uuid,uuid)',
   'app.recruitment_candidate_duplicate_count(uuid,text,text,text,text,uuid)',
   'app.recruitment_candidate_duplicate_flags(uuid,jsonb)',
   'app.recruitment_candidate_email_claim(integer)',
   'app.recruitment_candidate_email_finish(uuid,uuid,text,text)',
   'app.recruitment_candidate_email_hour_count(uuid)',
   'app.recruitment_candidate_email_hour_count_owner(uuid,uuid)',
   'app.recruitment_candidate_email_linkish(text)',
   'app.recruitment_candidate_email_placeholders_ok(text,text)',
   'app.recruitment_candidate_email_purge(integer)',
   'app.recruitment_candidate_email_sender(text,text)',
   'app.recruitment_candidate_email_start(uuid,uuid,text)',
   'app.recruitment_candidate_email_target(uuid,uuid)',
   'app.recruitment_candidate_email_worker_ok()',
   'app.recruitment_candidate_lock_key(uuid,uuid)',
   'app.recruitment_careers_apply(text,text,uuid,text,text,text,text,text,integer,boolean,text,text,bytea)',
   'app.recruitment_careers_check_code(text,uuid,text,text,text,text)',
   'app.recruitment_careers_client_limited(text)',
   'app.recruitment_careers_email_context(text,uuid)',
   'app.recruitment_careers_email_digest(text)',
   'app.recruitment_careers_issue_code(text,uuid,text,text,text)',
   'app.recruitment_careers_job(text,uuid)',
   'app.recruitment_careers_open(uuid,uuid)',
   'app.recruitment_careers_page(text,text,text,text,integer)',
   'app.recruitment_careers_prune()',
   'app.recruitment_careers_published(uuid,uuid)',
   'app.recruitment_careers_queue_receipt(text,uuid,text,text,text)',
   'app.recruitment_careers_site_at(text)',
   'app.recruitment_careers_submit(text,uuid,text,text,text,text,text,integer,boolean,text,text,bytea)',
   'app.recruitment_careers_verification_required(uuid,uuid)',
   'app.recruitment_check_candidate_email_queue()',
   'app.recruitment_clear_agency_submission(uuid)',
   'app.recruitment_clear_to_assign()',
   'app.recruitment_contract_usable(uuid)',
   'app.recruitment_current_person()',
   'app.recruitment_delete_company_setup(uuid)',
   'app.recruitment_destroy_candidate(uuid)',
   'app.recruitment_destroying(uuid)',
   'app.recruitment_destroying_application(uuid)',
   'app.recruitment_destroying_in(uuid)',
   'app.recruitment_email_context_open(text,uuid)',
   'app.recruitment_enabled_for(uuid)',
   'app.recruitment_export_columns_valid(text[])',
   'app.recruitment_guard_agency_detail()',
   'app.recruitment_guard_agency_fee()',
   'app.recruitment_guard_agency_portal_submission()',
   'app.recruitment_guard_agency_setup()',
   'app.recruitment_guard_agency_submission()',
   'app.recruitment_guard_application()',
   'app.recruitment_guard_application_event()',
   'app.recruitment_guard_archive_reason()',
   'app.recruitment_guard_background_check()',
   'app.recruitment_guard_background_check_detail()',
   'app.recruitment_guard_background_check_file()',
   'app.recruitment_guard_background_check_type()',
   'app.recruitment_guard_background_check_type_link()',
   'app.recruitment_guard_blocked()',
   'app.recruitment_guard_candidate()',
   'app.recruitment_guard_candidate_child()',
   'app.recruitment_guard_candidate_email()',
   'app.recruitment_guard_candidate_email_setting()',
   'app.recruitment_guard_candidate_email_template()',
   'app.recruitment_guard_candidate_import()',
   'app.recruitment_guard_careers_application()',
   'app.recruitment_guard_careers_author()',
   'app.recruitment_guard_careers_notice()',
   'app.recruitment_guard_careers_site()',
   'app.recruitment_guard_custom_field()',
   'app.recruitment_guard_custom_field_option()',
   'app.recruitment_guard_custom_value()',
   'app.recruitment_guard_evaluation_form()',
   'app.recruitment_guard_export_template()',
   'app.recruitment_guard_hire_handoff()',
   'app.recruitment_guard_identity()',
   'app.recruitment_guard_interview()',
   'app.recruitment_guard_interview_place()',
   'app.recruitment_guard_interview_question_link()',
   'app.recruitment_guard_interview_setup()',
   'app.recruitment_guard_interviewer()',
   'app.recruitment_guard_interviewer_group_member()',
   'app.recruitment_guard_job()',
   'app.recruitment_guard_job_agency_contract()',
   'app.recruitment_guard_job_careers_page()',
   'app.recruitment_guard_job_referral_portal()',
   'app.recruitment_guard_job_referral_reward()',
   'app.recruitment_guard_job_template()',
   'app.recruitment_guard_offer()',
   'app.recruitment_guard_offer_approval()',
   'app.recruitment_guard_offer_field()',
   'app.recruitment_guard_offer_value()',
   'app.recruitment_guard_position_template()',
   'app.recruitment_guard_position_template_value()',
   'app.recruitment_guard_preview_quota()',
   'app.recruitment_guard_referral()',
   'app.recruitment_guard_referral_reward()',
   'app.recruitment_guard_repeat_application()',
   'app.recruitment_guard_requisition()',
   'app.recruitment_guard_requisition_approval()',
   'app.recruitment_guard_review_mark()',
   'app.recruitment_guard_scorecard()',
   'app.recruitment_guard_screening_answer()',
   'app.recruitment_guard_screening_request()',
   'app.recruitment_guard_stage()',
   'app.recruitment_guard_stage_waiting_rule()',
   'app.recruitment_guard_tag()',
   'app.recruitment_guard_talent_pool()',
   'app.recruitment_guard_talent_pool_member()',
   'app.recruitment_guard_talent_pool_share()',
   'app.recruitment_guard_task_read_marker()',
   'app.recruitment_guard_to_assign()',
   'app.recruitment_has_job_role(uuid,text[])',
   'app.recruitment_interview_period(timestamp with time zone,integer)',
   'app.recruitment_interviews_application(uuid)',
   'app.recruitment_job_hiring_managers(uuid)',
   'app.recruitment_my_referral_rewards()',
   'app.recruitment_my_referrals()',
   'app.recruitment_norm_email(text)',
   'app.recruitment_norm_id(text)',
   'app.recruitment_norm_mobile(text)',
   'app.recruitment_norm_name(text)',
   'app.recruitment_offer_candidate_reply(uuid)',
   'app.recruitment_offer_value_visible(uuid,uuid,uuid,uuid)',
   'app.recruitment_operates_candidate(uuid,uuid)',
   'app.recruitment_operates_in_company(uuid)',
   'app.recruitment_people_labels(uuid)',
   'app.recruitment_reads_candidate(uuid)',
   'app.recruitment_referral_eligible()',
   'app.recruitment_referral_freeze_reward()',
   'app.recruitment_referral_open(uuid)',
   'app.recruitment_referral_portal(uuid)',
   'app.recruitment_referral_portal_rewards(uuid)',
   'app.recruitment_referrer_companies()',
   'app.recruitment_resolve_review_mark(uuid,text,text)',
   'app.recruitment_response_answer(text,text,text)',
   'app.recruitment_response_link_issue(text,uuid,text)',
   'app.recruitment_response_link_matches(text,uuid,uuid)',
   'app.recruitment_response_state(app.recruitment_response_link)',
   'app.recruitment_response_url_digest(text)',
   'app.recruitment_response_view(text)',
   'app.recruitment_reviews_candidate(uuid,uuid)',
   'app.recruitment_reward_employment_active(uuid)',
   'app.recruitment_reward_facts(uuid)',
   'app.recruitment_reward_payroll_queue(uuid)',
   'app.recruitment_scorecards_private(uuid)',
   'app.recruitment_screening_answered()',
   'app.recruitment_screening_close_for_application()',
   'app.recruitment_screening_close_for_reviewer()',
   'app.recruitment_settle_candidate_import(uuid)',
   'app.recruitment_submit_referral(uuid,text,text,text,text,boolean,text,text,bytea)',
   'app.recruitment_survey_answer(text,jsonb,text)',
   'app.recruitment_survey_issue(uuid,uuid,text)',
   'app.recruitment_survey_live(text)',
   'app.recruitment_survey_prune()',
   'app.recruitment_survey_view(text)',
   'app.recruitment_talent_pool_sharing_follows()',
   'app.recruitment_team_in_company(uuid)',
   'app.recruitment_unblock_candidate(uuid,text)',
   'app.recruitment_user_administers(uuid,uuid)',
   'app.recruitment_user_in_company(uuid,uuid)',
   'app.recruitment_user_labels(uuid)',
   'app.recruitment_withdraw_interview_emails()',
   'app.register_import_release(uuid,boolean)','app.reward_access_observation_due(uuid)',
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
   'app.reward_unit_level(uuid,text)','app.reward_unit_limit_version(uuid)','app.sweep_swing_thresholds(uuid[])',
   'app.system_label_import_conflicts(uuid)','app.system_label_import_discard_batch(uuid,uuid,uuid,uuid,integer)','app.system_label_import_release_attempt(uuid,uuid)',
  ];
  // Movement5773–5779: exact new function inventory, with no PUBLIC execute and one private implementation.
  addedFunctions.push('app.access_movement_delete_employment(uuid)','app.cost_allocations_after_hire_company_correction(uuid,uuid,text)','app.employment_payment_method_on(uuid,date)','app.preserve_movement_payroll(uuid)','app.preserve_payroll_metadata(uuid,boolean)','app.workforce_payroll_inputs_changed(uuid,date,date,text)','app.workforce_payroll_inputs_changed_windows(uuid,jsonb,text)');
  //6100–6102: exact independently reviewed new signatures and application EXECUTE decisions.
  const approvedFunctions:{fn:string;app:boolean}[]=[
   {fn:'app.reward_review_plan_population(integer,date)',app:true},
   {fn:'app.reward_review_plan_rows(integer)',app:true},
   {fn:'app.reward_review_plan_grid(integer,jsonb,integer)',app:true},
   {fn:'app.reward_review_plan_writing()',app:true},
   {fn:'app.reward_review_plan_save(integer,jsonb,jsonb,jsonb,boolean,text)',app:true},
   {fn:'app.reward_review_plan_links()',app:true},
   {fn:'app.reward_review_plan_metadata(integer)',app:true},
   {fn:'app.reward_review_plan_selected(integer,jsonb)',app:true},
   {fn:'app.reward_review_plan_consume_rebind(uuid,integer)',app:true},
   {fn:'app.reward_review_plan_rebind(integer,jsonb,text)',app:true},
   {fn:'app.reward_review_plan_previous_choices(integer)',app:true},
   {fn:'app.reward_review_plan_target_available()',app:false},
   {fn:'app.reward_review_plan_company_enqueue()',app:false},
   {fn:'app.reward_review_plan_company_tick()',app:false},
   {fn:'app.reward_review_plan_company_recipients(uuid)',app:true},
   {fn:'app.reward_review_plan_activate(integer,uuid)',app:true},
   {fn:'app.reward_review_plan_company_rows(integer,date,boolean)',app:true},
   {fn:'app.reward_review_plan_legacy_suggestion_data(integer,date)',app:true},
   {fn:'app.reward_review_plan_track_legacy_setup()',app:false},
   {fn:'app.reward_review_plan_track_legacy_participation()',app:false},
   {fn:'app.reward_review_plan_rebind_recipients(uuid)',app:true},
   {fn:'app.reward_plan_company_in_use(uuid)',app:true},
   {fn:'app.reward_history_company_in_use(uuid)',app:true},
   {fn:'app.reward_history_upload_authorized(uuid)',app:true},
   {fn:'app.reward_history_upload_subject(uuid,uuid)',app:true},
   {fn:'app.reward_history_upload_context(uuid,text[])',app:true},
   {fn:'app.reward_history_shape()',app:false},
   {fn:'app.reward_history_write_guard()',app:false},
   {fn:'app.reward_record_person_history(uuid,jsonb)',app:true},
   {fn:'app.reward_person_history(uuid,uuid)',app:true},
   {fn:'app.reward_history_recorded_entries(uuid)',app:true},
   {fn:'app.reward_history_audit_value(text,jsonb)',app:false},
   {fn:'app.reward_review_activity_changes(uuid[],uuid,uuid)',app:true},
   {fn:'app.lifecycle_recipient_case_allowed(uuid,boolean)',app:false},
   {fn:'app.lifecycle_recipient_accounts(uuid,text,uuid[],text)',app:true},
  ];
  addedFunctions.push(...approvedFunctions.map(row=>row.fn));
  privateFunctions.push(...approvedFunctions.filter(row=>!row.app).map(row=>row.fn));
  // Frozen literal Contract intent; never an observed-database allowlist.
  expect(contractIntent.functionsAdded.every(fn=>!fn.publicExecute)).toBe(true);
  const sharedContractDirectory='app.contract_configuration_directory(uuid[],text,uuid[])';
  expect(contractIntent.functionsAdded.filter(fn=>addedFunctions.includes(fn.signature)).map(fn=>fn.signature)).toEqual([sharedContractDirectory]);
  addedFunctions.push(...contractIntent.functionsAdded.filter(fn=>fn.signature!==sharedContractDirectory).map(fn=>fn.signature));
  // The guarded bridge retains one original OID privately; no application/PUBLIC execution.
  const archivedContractDirectory='app.contract_configuration_directory_before_combined(uuid[],text,uuid[])';
  addedFunctions.push(archivedContractDirectory);privateFunctions.push(archivedContractDirectory);
  expect(new Set(addedFunctions).size).toBe(addedFunctions.length);
  addedFunctions.sort();
  const beforeFunctions=new Set(beforePerformancePrivileges.functions.map(row=>row.fn));
  expect(afterPerformancePrivileges.functions.filter(row=>!beforeFunctions.has(row.fn)).map(row=>row.fn).sort()).toEqual(addedFunctions);
  for(const fn of addedFunctions){
   const [permission]=await storage.client`select has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc p where p.oid=to_regprocedure(${fn})`;
   expect(permission).toEqual({app_execute:!privateFunctions.includes(fn),public_execute:publicFunctions.includes(fn)});
  }
  // Replacement bodies retain their native ACL unless a reviewed literal says otherwise.
  // Every selected new function has only owner EXECUTE plus its explicit app grant.
  // Check the full ACL as a set: another grantee or grant option must fail too.
  const [{owner_role:ownerRole}]=await storage.client<{owner_role:string}[]>`select current_user as owner_role`;
  // Pin intended ownership before any ACL normalization. A different owner cannot
  // excuse itself merely by reissuing the same grants under its own identity.
  const contractFunctionOwners=await storage.client`select p.oid::regprocedure::text as fn,p.proowner::regrole::text as owner
   from pg_proc p where p.oid::regprocedure::text=any(${contractIntent.functionsAdded.map(fn=>fn.signature)}::text[]) order by 1`;
  expect(contractFunctionOwners).toHaveLength(contractIntent.functionsAdded.length);
  for(const expected of contractIntent.functionsAdded){
   const intendedOwner=expected.owner==='MIGRATION_OWNER'?ownerRole:expected.owner;
   expect(contractFunctionOwners.find(row=>row.fn===expected.signature)?.owner,expected.signature+' owner').toBe(intendedOwner);
  }
  const contractTableOwners=await storage.client`select c.oid::regclass::text as rel,c.relowner::regrole::text as owner
   from pg_class c where c.oid::regclass::text=any(${contractIntent.tablesAdded.map(table=>table.table.replace(/^public\./,''))}::text[]) order by 1`;
  expect(contractTableOwners).toHaveLength(contractIntent.tablesAdded.length);
  for(const expected of contractIntent.tablesAdded){
   const rel=expected.table.replace(/^public\./,''),intendedOwner=expected.owner==='MIGRATION_OWNER'?ownerRole:expected.owner;
   expect(contractTableOwners.find(row=>row.rel===rel)?.owner,rel+' owner').toBe(intendedOwner);
  }
  const contractFunctionAcls=await storage.client`select p.oid::regprocedure::text as fn,
   jsonb_agg(jsonb_build_object('grantee',case when a.grantee=p.proowner then 'OWNER' when a.grantee=0 then 'PUBLIC' else a.grantee::regrole::text end,
    'grantor',case when a.grantor=p.proowner then 'OWNER' else a.grantor::regrole::text end,
    'privilege',a.privilege_type,'grantable',a.is_grantable) order by case when a.grantee=p.proowner then 0 else 1 end,a.grantee::regrole::text,a.privilege_type) as acl
   from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid::regprocedure::text=any(${contractIntent.functionsAdded.map(fn=>fn.signature)}::text[])
   group by p.oid,p.proowner order by p.oid::regprocedure::text`;
  expect(contractFunctionAcls).toHaveLength(contractIntent.functionsAdded.length);
  for(const expected of contractIntent.functionsAdded){
   const acl=[{grantee:'OWNER',grantor:'OWNER',privilege:'EXECUTE',grantable:false},...(expected.appExecute?[{grantee:'ai_hr_app',grantor:'OWNER',privilege:'EXECUTE',grantable:false}]:[])];
   expect(contractFunctionAcls.find(row=>row.fn===expected.signature)?.acl,expected.signature).toEqual(acl);
  }

  for(const expected of contractIntent.existingFunctionsTouched){
   const [actual]=await storage.client`select has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc p where p.oid=to_regprocedure(${expected.signature})`;
   expect(actual,expected.signature).toEqual({app_execute:expected.appExecute,public_execute:expected.publicExecute});
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
  // daa76ed4/96a54ed2 (5141-5142): this lane's new and replaced policies, each compared with PostgreSQL's own rendering
  // of the reviewed expression (parsed on the same table and discarded), never with a hand-typed digest.
  const ownerRead="tenant_id=app.current_tenant_id() AND request_id::text=current_setting('app.attendance_workflow_escalating',true) AND current_user=pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid='app.attendance_workflow_escalate(uuid,date)'::regprocedure))";
  const lanePolicies:{table:string;name:string;cmd:'SELECT'|'INSERT';using:string|null;check:string|null;replaces:boolean}[]=[
   {table:'attendance_workflow_escalation',name:'attendance_workflow_escalation_read',cmd:'SELECT',replaces:false,check:null,
    using:"tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_read(w.correction_id))"},
   {table:'attendance_workflow_participant_decision',name:'attendance_workflow_escalation_owner_read',cmd:'SELECT',replaces:false,check:null,using:ownerRead},
   {table:'attendance_workflow_participant_reassignment',name:'attendance_workflow_escalation_owner_read',cmd:'SELECT',replaces:false,check:null,using:ownerRead},
   {table:'attendance_workflow_participant_decision',name:'attendance_workflow_v3_participant_insert',cmd:'INSERT',replaces:true,using:null,
    check:"tenant_id=app.current_tenant_id() AND actual_user_id=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND (app.attendance_workflow_v3_decision_slot(w.correction_id) IS NOT NULL OR (acting_mode='on_behalf' AND app.attendance_workflow_on_behalf_slot(w.correction_id,(assigned->>'employmentId')::uuid)->>'slot'=participant_slot)))"},
  ];
  const laneRendered=await storage.client.begin(async tx=>{
   const out:{qual:string|null;with_check:string|null}[]=[];
   for(const policy of lanePolicies){
    await tx.unsafe(`create policy lane_reference on public.${policy.table} for ${policy.cmd}${policy.using?` using (${policy.using})`:''}${policy.check?` with check (${policy.check})`:''}`);
    const [row]=await tx<{qual:string|null;with_check:string|null}[]>`select qual,with_check from pg_policies where schemaname='public' and tablename=${policy.table} and policyname='lane_reference'`;
    out.push(row);await tx.unsafe(`drop policy lane_reference on public.${policy.table}`);
   }
   return out;
  });
  const isLanePolicy=(row:(typeof beforePerformancePrivileges.policies)[number])=>row.schemaname==='public'&&lanePolicies.some(policy=>policy.table===row.tablename&&policy.name===row.policyname);
  for(const [index,policy] of lanePolicies.entries()){
   const [row]=afterPerformancePrivileges.policies.filter(candidate=>candidate.schemaname==='public'&&candidate.tablename===policy.table&&candidate.policyname===policy.name);
   expect(row,policy.name).toMatchObject({permissive:'PERMISSIVE',roles:'{public}',cmd:policy.cmd,qual:laneRendered[index].qual,with_check:laneRendered[index].with_check});
  }
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
  const ownerAcl=(acl:string|null)=>acl===null?null:acl.split(ownerRole).join('OWNER');
  const digest=(text:string|null)=>text===null?null:createHash('md5').update(text).digest('hex');
  const combinedRelations:Record<string,{rls:boolean;force:boolean;acl:string|null}>={
   // Movement5774: only native routing maintenance writes; history is forced-RLS and never deletable by app.
   'employment_payment_method_history':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   // Board window 4 (5124): stored Preview Assignment snapshots, append-only and forced RLS.
   'attendance_workflow_preview':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   // daa76ed4 (5141): immutable escalation history, read-only to the application role.
   'attendance_workflow_escalation':{rls:true,force:false,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   // 5144: owner-only window key and spent-transaction record.
   'app.attendance_final_window_key':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.attendance_final_window_spent':{rls:false,force:false,acl:'{OWNER=arwdDxt/OWNER}'},
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
  type PolicyWitness={schemaname:string;tablename:string;policyname:string;permissive:string;roles:string;cmd:string;qual:string|null;with_check:string|null};
  // Parse independently reviewed expressions on the real table, exactly as the Claim control above.
  // These temporary comparison policies are removed in this owned disposable database transaction.
  const methodPolicies=await storage.client.begin(async tx=>{
   const names=['movement_expected_method_owner','movement_expected_method_read','movement_expected_method_write'];
   await tx.unsafe("create policy movement_expected_method_owner on public.employment_payment_method_history for all using(current_user<>'ai_hr_app') with check(current_user<>'ai_hr_app')");
   await tx.unsafe("create policy movement_expected_method_read on public.employment_payment_method_history for select using(tenant_id=app.current_tenant_id() and (app.can_admin_employment(employment_id) or exists(select 1 from public.employment e where e.id=employment_id and app.is_self_person(e.person_id))))");
   await tx.unsafe("create policy movement_expected_method_write on public.employment_payment_method_history for all using(tenant_id=app.current_tenant_id() and app.can_admin_employment(employment_id) and app.access_workforce_employment(employment_id,'workforce.maintain')) with check(tenant_id=app.current_tenant_id() and app.can_admin_employment(employment_id) and app.access_workforce_employment(employment_id,'workforce.maintain'))");
   const rows=await tx<PolicyWitness[]>`select schemaname,tablename,replace(policyname,'movement_expected_method_','employment_payment_method_history_') as policyname,permissive,roles::text,cmd,md5(qual) as qual,md5(with_check) as with_check from pg_policies where schemaname='public' and tablename='employment_payment_method_history' and policyname=any(${names}::text[]) order by policyname`;
   expect(rows).toHaveLength(3);
   for(const name of names)await tx.unsafe('drop policy '+name+' on public.employment_payment_method_history');
   return rows;
  });
  const combinedPolicies:PolicyWitness[]=[
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
  combinedPolicies.push(...methodPolicies);
  combinedPolicies.sort((a,b)=>a.schemaname.localeCompare(b.schemaname)||a.tablename.localeCompare(b.tablename)||a.policyname.localeCompare(b.policyname));
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
  // Explicit intended grants. The physical migration owner always retains its native ACL;
  // literal ai_hr_owner grants collapse into OWNER only when that is the actual owner role.
  const contractAcl=(literal:Record<string,readonly string[]|undefined>)=>{
   const grants=new Map<string,Set<string>>([['OWNER',new Set(['INSERT','SELECT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])]]);
   for(const [grantee,privileges]of Object.entries(literal)){
    const role=grantee===ownerRole?'OWNER':grantee;
    if(!privileges?.length)continue;
    const merged=grants.get(role)??new Set<string>();for(const privilege of privileges)merged.add(privilege);grants.set(role,merged);
   }
   const codes=[['INSERT','a'],['SELECT','r'],['UPDATE','w'],['DELETE','d'],['TRUNCATE','D'],['REFERENCES','x'],['TRIGGER','t']];
   return '{'+[...grants].map(([role,privileges])=>role+'='+codes.filter(([privilege])=>privileges.has(privilege!)).map(([,code])=>code).join('')+'/OWNER').join(',')+'}';
  };
  const contractRelations=Object.fromEntries(contractIntent.tablesAdded.map(table=>[table.table.replace(/^public\./,''),{rls:table.rls,force:table.force,acl:contractAcl(table.explicitRolePrivileges)}]));
  const boardRelations:Record<string,{rls:boolean;force:boolean;acl:string|null}>={
   // Actor-only test receipts remain owner-only and forced-RLS.
   'resignation_communication_test':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   // Resignation9991: salary-sensitive state and uploaded receipts are forced-RLS; HMAC material stays owner-only.
   'resignation_journey':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'resignation_journey_number_seq':{rls:false,force:false,acl:null},
   'resignation_journey_file':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'app.resignation_runtime_verifier':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.resignation_runtime_state':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.resignation_notification_receipt':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   ...contractRelations,
   'automation_run':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   // Probation reshape (5740, 5741, 5743; 16 November 2026): four append-only tables, read-only to the application.
   'automation_email_template_version':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   // 5754: queued workflow email, owner only (the application writes through app.automation_email_queue).
   'automation_email_delivery':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   // 5757: moved notify-only Probation workflow definitions, owner only (written through app.probation_workflow_move).
   'probation_workflow_move':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   // 5762: imported saved evaluation forms, owner only (written and read through the app.probation_form_import* functions).
   'probation_form_import':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'probation_access_role':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'probation_access_member':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'probation_access_rule':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'automation_routing_version':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'automation_workflow_version':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'personnel_posting':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   // 5742 (Probation settings scope): versions and company membership, read-only to the application.
   'probation_settings_scope_member':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'probation_settings_scope_version':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
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
   {schemaname:'public',tablename:'automation_email_delivery',policyname:'automation_email_delivery_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'automation_email_template_version',policyname:'automation_email_template_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'automation_email_template_version',policyname:'automation_email_template_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'bac4a95592bbda57aed591f6db313641',with_check:null},
   {schemaname:'public',tablename:'automation_routing_version',policyname:'automation_routing_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'automation_routing_version',policyname:'automation_routing_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'f20caae34239109c303ca06035783833',with_check:null},
   {schemaname:'public',tablename:'automation_run',policyname:'automation_run_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'automation_run',policyname:'automation_run_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'e9cbf47fa5ad06022706718f7647f2b1',with_check:null},
   {schemaname:'public',tablename:'automation_workflow_version',policyname:'automation_workflow_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'automation_workflow_version',policyname:'automation_workflow_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'bac4a95592bbda57aed591f6db313641',with_check:null},
   {schemaname:'public',tablename:'company_registration_classification',policyname:'company_registration_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'3f508ac9bab3a400ba652cdcbc225fec',with_check:null},
   {schemaname:'public',tablename:'job_architecture_catalogue_revision',policyname:'reward_config_architecture_catalogue',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'dbbe81253dcbe78bcb5b57df467675ae',with_check:null},
   {schemaname:'public',tablename:'job_architecture_position_revision',policyname:'reward_config_architecture_position',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'ee611118f080c3f4c23c582744c9e6fc',with_check:null},
   {schemaname:'public',tablename:'lc_v9_email_hold',policyname:'v9_email_hold_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'943f46d6c51979e6a3e15d49c833cfd3'},
   {schemaname:'public',tablename:'lc_v9_email_hold',policyname:'v9_email_hold_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'a891360032acbd07afa1f1c6e6c5be0a',with_check:null},
   {schemaname:'public',tablename:'lc_v9_email_hold',policyname:'v9_email_hold_release',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'943f46d6c51979e6a3e15d49c833cfd3',with_check:'63096f37cc862794aecf97d68e8a8239'},
   {schemaname:'public',tablename:'lc_v9_email_hold',policyname:'v9_email_hold_storage_owner',permissive:'PERMISSIVE',roles:'{OWNER}',cmd:'ALL',qual:'b326b5062b2f0e69046810717534cb09',with_check:'b326b5062b2f0e69046810717534cb09'},
   {schemaname:'public',tablename:'personnel_posting',policyname:'personnel_posting_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'personnel_posting',policyname:'personnel_posting_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'8b0333122d2e162cc1eff24b8b0fc365',with_check:null},
   {schemaname:'public',tablename:'probation_access_member',policyname:'probation_access_member_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'probation_access_role',policyname:'probation_access_role_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'probation_access_rule',policyname:'probation_access_rule_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'probation_form_import',policyname:'probation_form_import_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'probation_settings_scope_member',policyname:'probation_settings_scope_member_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'probation_settings_scope_member',policyname:'probation_settings_scope_member_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'782ac6da7f7880201b39db019eaaac01',with_check:null},
   {schemaname:'public',tablename:'probation_settings_scope_version',policyname:'probation_settings_scope_version_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'probation_settings_scope_version',policyname:'probation_settings_scope_version_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'782ac6da7f7880201b39db019eaaac01',with_check:null},
   {schemaname:'public',tablename:'probation_workflow_move',policyname:'probation_workflow_move_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'c380ea6ec96fb7e23eb0498d6d773a76',with_check:'c380ea6ec96fb7e23eb0498d6d773a76'},
   {schemaname:'public',tablename:'reward_config_change',policyname:'reward_config_change_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_config_change',policyname:'reward_config_change_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'b0652841b761793f00814566b72e654b',with_check:null},
   {schemaname:'public',tablename:'reward_governance',policyname:'reward_pat_draft_governance_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'042db60115c525438a1583b0609fcebb',with_check:'042db60115c525438a1583b0609fcebb'},
   {schemaname:'public',tablename:'reward_governance_history',policyname:'reward_pat_draft_history_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'INSERT',qual:null,with_check:'7c64acb97dde9a40d6fd64b947f0878f'},
   {schemaname:'public',tablename:'reward_governance_public',policyname:'reward_pat_draft_public_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'1692d9ff59891005626ffc283881c409',with_check:'1692d9ff59891005626ffc283881c409'},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_config_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'460d9edc04eb8b288e570b264338be1b'},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_config_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c5be2466a772025245f339de977e091f',with_check:null},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'3db9f2711a716af4114c1d2de6f36690'},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_role_level_read',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'9e5d27cf872cd899d911a7f32e4cc4af',with_check:null},
   {schemaname:'public',tablename:'reward_library',policyname:'reward_library_role_level_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'3db9f2711a716af4114c1d2de6f36690',with_check:'3db9f2711a716af4114c1d2de6f36690'},
   {schemaname:'public',tablename:'reward_library_revision_audit',policyname:'reward_library_revision_audit_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'INSERT',qual:null,with_check:'9b373c82902eef1a24a76bf152720190'},
   {schemaname:'public',tablename:'reward_library_revision_audit',policyname:'reward_library_revision_audit_config_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'c5be2466a772025245f339de977e091f',with_check:null},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_config_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'86e428b683b8e16ae531f0b2b6fe0506'},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_config_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c5be2466a772025245f339de977e091f',with_check:null},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_config_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'fa548c9c50304e48374aeb96778cc3b3',with_check:'3e6d9aa831224badb17f27d760458c1c'},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'19469ece367ce5db1b948c904a930afe'},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_role_level_read',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'3dd971f5ee9fd9894fcddae5d59219d7',with_check:null},
   {schemaname:'public',tablename:'reward_library_version',policyname:'reward_library_version_role_level_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'19469ece367ce5db1b948c904a930afe',with_check:'19469ece367ce5db1b948c904a930afe'},
   {schemaname:'public',tablename:'reward_limit_version',policyname:'reward_limit_version_insert',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'dc8abe21091318ab10c2bbd508ce87f7'},
   {schemaname:'public',tablename:'reward_limit_version',policyname:'reward_limit_version_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_limit_version',policyname:'reward_limit_version_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'f793da3071cf53b7718d88009b667c30',with_check:null},
   {schemaname:'public',tablename:'reward_offcycle_year',policyname:'reward_offcycle_year_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_offcycle_year',policyname:'reward_offcycle_year_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:null},
   {schemaname:'public',tablename:'reward_pat_basis',policyname:'reward_pat_basis_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'75e09c69c00173db53bdde71101b1450',with_check:'75e09c69c00173db53bdde71101b1450'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_config_edit',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'e8664043d4e71aa72cda090b8d7579ea',with_check:'0a9ee63b1a7f167a8d2cc559dc366c48'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_config_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'c477309fc5ff423e0050998366955f1c'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_config_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'3f508ac9bab3a400ba652cdcbc225fec',with_check:null},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_edit',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'4a6390221289b7a5b68ed462f1ae654d',with_check:'6e4e6815b3f76a0a02dfc631d884d4a6'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_role_level_insert',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'INSERT',qual:null,with_check:'fb82f1d410f5a0cc23172d46a47934b4'},
   {schemaname:'public',tablename:'reward_pat_version',policyname:'reward_pat_role_level_update',permissive:'RESTRICTIVE',roles:'{ai_hr_app}',cmd:'UPDATE',qual:'fb82f1d410f5a0cc23172d46a47934b4',with_check:'fb82f1d410f5a0cc23172d46a47934b4'},
   {schemaname:'public',tablename:'reward_plan_company',policyname:'reward_plan_company_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'d4bfed513a5dca90ee295d81659abce9',with_check:null},
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
   {schemaname:'public',tablename:'reward_setup_grant',policyname:'reward_setup_grant_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'194cbd7d3fd11cfc049653fe38684a49',with_check:null},
   {schemaname:'public',tablename:'reward_snapshot_comp_movement',policyname:'reward_config_snapshot_pay_change',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'43dace533fb958e7731144fd5d2a99ee',with_check:null},
   {schemaname:'public',tablename:'reward_unit_limit_pin',policyname:'reward_unit_limit_pin_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'59492f3697ba1af7263dfebcdb7c1b78',with_check:'59492f3697ba1af7263dfebcdb7c1b78'},
   {schemaname:'public',tablename:'reward_unit_limit_pin',policyname:'reward_unit_limit_pin_read',permissive:'PERMISSIVE',roles:'{ai_hr_app}',cmd:'SELECT',qual:'f793da3071cf53b7718d88009b667c30',with_check:null},
   {schemaname:'public',tablename:'reward_unit_setup',policyname:'reward_unit_setup_pat_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'ALL',qual:'f11a21eee98956088c3be9e2f59ebb19',with_check:'f11a21eee98956088c3be9e2f59ebb19'},
   {schemaname:'public',tablename:'reward_uploaded_award',policyname:'reward_uploaded_award_config_owner',permissive:'PERMISSIVE',roles:'{ai_hr_owner}',cmd:'SELECT',qual:'4094f5ce20f217ddbff264f02f20fd45',with_check:null},
  ];
  // 5802 intentionally replaces only the two shared definition read predicates.
  // Parse reviewed literal SQL independently; observed policy rows never define expected access.
  const sharedDefinitionReadPolicies=[
   {table:'automation_email_template_version',name:'automation_email_template_read',using:"tenant_id=app.current_tenant_id() AND app.automation_can_manage(module,'templates')"},
   {table:'automation_workflow_version',name:'automation_workflow_read',using:"tenant_id=app.current_tenant_id() AND app.automation_can_manage(module,'workflows')"},
  ];
  const sharedDefinitionReadQuals=await storage.client.begin(async tx=>{
   const parsed:(string|null)[]=[];
   for(const policy of sharedDefinitionReadPolicies){
    await tx.unsafe('create policy upgrade_expected_shared_definition_read on public.'+policy.table+' for select to ai_hr_app using ('+policy.using+')');
    const [row]=await tx<{qual:string|null}[]>`select qual from pg_policies where schemaname='public' and tablename=${policy.table} and policyname='upgrade_expected_shared_definition_read'`;
    parsed.push(row.qual);
    await tx.unsafe('drop policy upgrade_expected_shared_definition_read on public.'+policy.table);
   }
   return parsed;
  });
  sharedDefinitionReadPolicies.forEach((policy,index)=>{
   const expected=boardPolicies.find(row=>row.schemaname==='public'&&row.tablename===policy.table&&row.policyname===policy.name)!;
   // Preserve the independently pinned 5740/5743 source predicate before its reviewed replacement.
   expect(expected.qual,policy.name+' original source').toBe('bac4a95592bbda57aed591f6db313641');
   expect(sharedDefinitionReadQuals[index],policy.name+' parsed replacement').not.toBeNull();
   expected.qual=digest(sharedDefinitionReadQuals[index]);
  });
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
  // Movement5775 adds only Payment Method to the existing protected-document field set.
  // Independently parse both exact predicates; every role, command and other field stays pinned.
  const expectedAttachment=await storage.client.begin(async tx=>{
   const read:{qual:string|null;with_check:string|null}[]=[],insert:{qual:string|null;with_check:string|null}[]=[];
   for(const method of [false,true]){
    const fields="'basicSalary','currency','payMode','paymentTerm'"+(method?",'paymentMethod'":"");
    const scope="tenant_id=app.current_tenant_id()";
    const protectedRead=`(field not in (${fields}) or app.can_admin_employment(employment_id) or app.can_admin_perfcomp_employment(employment_id) or app.can_admin_payroll_employment(employment_id))`;
    const protectedWrite=`(field not in (${fields}) or app.can_admin_employment(employment_id) or app.can_admin_perfcomp_employment(employment_id))`;
    for(const [kind,clause] of [['select',`using (${scope} and app.access_workforce_employment(employment_id,'workforce.view') and ${protectedRead})`],['insert',`with check (${scope} and app.is_admin() and app.access_workforce_employment(employment_id,'workforce.maintain') and ${protectedWrite})`]]){
     await tx.unsafe('create policy movement_expected_attachment on public.movement_attachment for '+kind+' '+clause);
     const [row]=await tx<{qual:string|null;with_check:string|null}[]>`select qual,with_check from pg_policies where schemaname='public' and tablename='movement_attachment' and policyname='movement_expected_attachment'`;
     (kind==='select'?read:insert).push(row);
     await tx.unsafe('drop policy movement_expected_attachment on public.movement_attachment');
    }
   }
   return {read,insert};
  });
  const isAttachmentRead=(row:(typeof afterPerformancePrivileges.policies)[number])=>row.schemaname==='public'&&row.tablename==='movement_attachment'&&row.policyname==='movement_attachment_read';
  const isAttachmentInsert=(row:(typeof afterPerformancePrivileges.policies)[number])=>row.schemaname==='public'&&row.tablename==='movement_attachment'&&row.policyname==='movement_attachment_insert';
  for(const [predicate,expected] of [[isAttachmentRead,expectedAttachment.read],[isAttachmentInsert,expectedAttachment.insert]] as const){
   const before=beforePerformancePrivileges.policies.find(predicate),after=afterPerformancePrivileges.policies.find(predicate);
   expect(before).toBeDefined();expect(before).toMatchObject(expected[0]);
   expect(after).toEqual({...before,...expected[1]});
  }
  // Recruitment slices 1–25 (5850–5877, renumbered 17 November 2026; docs/MIGRATION-ALLOCATION.md): 105 new relations,
  // 30 column grants and 362 row policies (qual/with_check as md5 digests, the migration owner written OWNER), all new.
  // Captured from a real upgraded database (run 43940310499). Nothing else in the privilege graph changes.
  const recruitmentRelations:Record<string,{rls:boolean;force:boolean;acl:string|null}>={
   'app.recruitment_agency_attempt':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_agency_clear_marker':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_agency_portal_check':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_agency_portal_code':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_agency_portal_context':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_agency_portal_session':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_agency_submission_match':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_blocked_context':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_candidate_email_context':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_careers_attempt':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_careers_code':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_careers_code_check':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_careers_context':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_careers_verification':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_destroy_marker':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_referral_attempt':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_referral_context':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_response_attempt':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_response_link':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.recruitment_survey_invitation':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'recruitment_agency':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_agency_consultant':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_agency_contract':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_agency_contract_terms':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_agency_contract_user':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_agency_fee':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_agency_portal_submission':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'recruitment_agency_submission':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_agency_tag':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_agency_tag_link':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_application':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_application_event':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_application_review_mark':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'recruitment_approval_step':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_archive_reason':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_background_check':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_background_check_detail':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_background_check_file':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_background_check_type':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_background_check_type_link':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_blocked_entry':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'recruitment_blocked_entry_restricted':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'recruitment_blocked_history':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'recruitment_candidate':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_candidate_consent':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_candidate_custom_restricted':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_candidate_custom_value':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_candidate_email':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_candidate_email_setting':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_candidate_email_template':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_candidate_entry':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_candidate_file':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_candidate_import':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_candidate_import_note':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_candidate_import_row':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_candidate_restricted':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_candidate_survey_response':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'recruitment_candidate_tag':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_careers_application':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=r/OWNER}'},
   'recruitment_careers_notice':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_careers_site':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_company_setting':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_custom_field':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_custom_field_option':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_evaluation_form':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_export_template':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_hire_handoff':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_import_preview_quota':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_interview':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_interview_address':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_interviewer_group':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_interviewer_group_member':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_interview_interviewer':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_interview_question':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_interview_question_link':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_interview_room':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_job_agency_contract':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_job_custom_value':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_job_member':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_job_opening':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_offer':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_offer_approval':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_offer_field':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_offer_value':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_position_template':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_position_template_value':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_process':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_process_stage':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_referral':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'recruitment_referral_reward':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_requisition':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_requisition_approval':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_requisition_job':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_scorecard':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_screening_answer':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'recruitment_screening_request':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_stage':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_stage_waiting_rule':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_tag':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_tag_group':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_talent_pool':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arwd/OWNER}'},
   'recruitment_talent_pool_member':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_talent_pool_share':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ard/OWNER}'},
   'recruitment_task_read_marker':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
   'recruitment_to_assign':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
  };
  const recruitmentColumns=[
   {rel:'recruitment_agency_portal_submission',col:'comments',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'decided_at',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'decided_by_user_id',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'decline_reason',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'email',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'full_name',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'mobile',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'permission_confirmed',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'resume_content',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'resume_mime',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'resume_name',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'resume_size',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'state',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_agency_portal_submission',col:'submission_id',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_referral',col:'application_id',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'candidate_id',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'company_id',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'confirmed_at',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'created_at',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'id',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'job_id',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'referrer_person_id',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'referrer_user_id',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'reward_amount',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'reward_currency',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral',col:'tenant_id',acl:'{ai_hr_app=r/OWNER}'},
   {rel:'recruitment_referral_reward',col:'pay_period',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_referral_reward',col:'sent_at',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_referral_reward',col:'sent_by_user_id',acl:'{ai_hr_app=w/OWNER}'},
   {rel:'recruitment_referral_reward',col:'txn_id',acl:'{ai_hr_app=w/OWNER}'},
  ];
  const recruitmentPolicies=[
   {schemaname:'app',tablename:'recruitment_agency_attempt',policyname:'recruitment_agency_attempt_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'0c74fff1ed33360568922ea1e4f8eb32',with_check:'0c74fff1ed33360568922ea1e4f8eb32'},
   {schemaname:'app',tablename:'recruitment_agency_clear_marker',policyname:'recruitment_agency_clear_marker_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'588f00666dc8284ed3ea01fc72912857',with_check:'588f00666dc8284ed3ea01fc72912857'},
   {schemaname:'app',tablename:'recruitment_agency_portal_check',policyname:'recruitment_agency_portal_check_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'e51cd9a1c7841fdd069447bc27675827',with_check:'e51cd9a1c7841fdd069447bc27675827'},
   {schemaname:'app',tablename:'recruitment_agency_portal_code',policyname:'recruitment_agency_portal_code_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'976fd5f8fdeac31d3ae0600038123f52',with_check:'976fd5f8fdeac31d3ae0600038123f52'},
   {schemaname:'app',tablename:'recruitment_agency_portal_context',policyname:'recruitment_agency_portal_context_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'5156a38ba0b61c1e57e9e737666ed733',with_check:'5156a38ba0b61c1e57e9e737666ed733'},
   {schemaname:'app',tablename:'recruitment_agency_portal_session',policyname:'recruitment_agency_portal_session_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'c1cf91437ddbc02248b22678cb641e0d',with_check:'c1cf91437ddbc02248b22678cb641e0d'},
   {schemaname:'app',tablename:'recruitment_agency_submission_match',policyname:'recruitment_agency_submission_match_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'4d4404ef7491298cd8235446781f09df',with_check:'4d4404ef7491298cd8235446781f09df'},
   {schemaname:'app',tablename:'recruitment_blocked_context',policyname:'recruitment_blocked_context_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'34d7306367a40adc1de0213bfc4bf242',with_check:'34d7306367a40adc1de0213bfc4bf242'},
   {schemaname:'app',tablename:'recruitment_candidate_email_context',policyname:'recruitment_candidate_email_context_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'3c33c9ac5b70d4554e6508a95cfb976b',with_check:'3c33c9ac5b70d4554e6508a95cfb976b'},
   {schemaname:'app',tablename:'recruitment_careers_attempt',policyname:'recruitment_careers_attempt_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'8d36431ccd2c8e4005db9c1c538d6842',with_check:'8d36431ccd2c8e4005db9c1c538d6842'},
   {schemaname:'app',tablename:'recruitment_careers_code',policyname:'recruitment_careers_code_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'c025b1a449482ac444d2671f21f2dc4d',with_check:'c025b1a449482ac444d2671f21f2dc4d'},
   {schemaname:'app',tablename:'recruitment_careers_code_check',policyname:'recruitment_careers_code_check_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'828054b78b5c56ac3c154688a4f68aab',with_check:'828054b78b5c56ac3c154688a4f68aab'},
   {schemaname:'app',tablename:'recruitment_careers_context',policyname:'recruitment_careers_context_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'da43cfec160662a4ad15ffbb85f26069',with_check:'da43cfec160662a4ad15ffbb85f26069'},
   {schemaname:'app',tablename:'recruitment_careers_verification',policyname:'recruitment_careers_verification_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'b6092478d9b664230f5f6409a99cc07b',with_check:'b6092478d9b664230f5f6409a99cc07b'},
   {schemaname:'app',tablename:'recruitment_destroy_marker',policyname:'recruitment_destroy_marker_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'6c3d6edb0ec2a695659f04dd0223d317',with_check:'6c3d6edb0ec2a695659f04dd0223d317'},
   {schemaname:'app',tablename:'recruitment_referral_attempt',policyname:'recruitment_referral_attempt_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'0fc85caddfeb2d595138d789cc4be439',with_check:'0fc85caddfeb2d595138d789cc4be439'},
   {schemaname:'app',tablename:'recruitment_referral_context',policyname:'recruitment_referral_context_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'7636af04c1b6d02ba8bebb529006d6c0',with_check:'7636af04c1b6d02ba8bebb529006d6c0'},
   {schemaname:'app',tablename:'recruitment_response_attempt',policyname:'recruitment_response_attempt_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'4d4a087e2878166d96ad7a513f289e28',with_check:'4d4a087e2878166d96ad7a513f289e28'},
   {schemaname:'app',tablename:'recruitment_response_link',policyname:'recruitment_response_link_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'a9091dd9e31f7243e84827e4ec2af5af',with_check:'a9091dd9e31f7243e84827e4ec2af5af'},
   {schemaname:'app',tablename:'recruitment_survey_invitation',policyname:'recruitment_survey_invitation_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'4a2f04fcc5d114da58656913dffc4bae',with_check:'4a2f04fcc5d114da58656913dffc4bae'},
   {schemaname:'public',tablename:'recruitment_agency',policyname:'recruitment_agency_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_agency',policyname:'recruitment_agency_agency_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'1a18217fc4a69d5e92e8ae9b5040af1f',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency',policyname:'recruitment_agency_context_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'57ba925eca0bff34a978c9639dc9bfdc',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency',policyname:'recruitment_agency_released',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'2e97274e1dd80e3c31d783b765422d38',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_consultant',policyname:'recruitment_agency_consultant_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_agency_consultant',policyname:'recruitment_agency_consultant_agency_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'319b8b7bf3f28332bff48ef6bac1c49d',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_consultant',policyname:'recruitment_agency_consultant_context_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'dab24de130068c57b16efbe6afd5e2d4',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_consultant',policyname:'recruitment_agency_consultant_released',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'74fca31761d647a19b08931b96b46ed4',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_contract',policyname:'recruitment_agency_contract_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_agency_contract',policyname:'recruitment_agency_contract_agency_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'3ae4be66eba538661101078dec4a13b7',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_contract',policyname:'recruitment_agency_contract_context_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'fd47b91fabf73d19422313fe1687fecc',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_contract',policyname:'recruitment_agency_contract_released',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'d2436a7bfa04a32b88d49f9979196c94',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_contract_terms',policyname:'recruitment_agency_contract_terms_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_agency_contract_user',policyname:'recruitment_agency_contract_user_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_agency_contract_user',policyname:'recruitment_agency_contract_user_self',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c3507aad03f3c5fca92b8d982ffc71dd',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_fee',policyname:'recruitment_agency_fee_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_agency_portal_submission',policyname:'recruitment_agency_portal_submission_operate_decide',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_agency_portal_submission',policyname:'recruitment_agency_portal_submission_operate_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_portal_submission',policyname:'recruitment_agency_portal_submission_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'001e3c33cd6c7ad8d510d5eaeb36eb86',with_check:'001e3c33cd6c7ad8d510d5eaeb36eb86'},
   {schemaname:'public',tablename:'recruitment_agency_submission',policyname:'recruitment_agency_submission_agency_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'645371a2e6af49ea4350ba149c14c887',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_submission',policyname:'recruitment_agency_submission_context_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'7c973ce97c215781243854eca9852ac6',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_submission',policyname:'recruitment_agency_submission_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_agency_submission',policyname:'recruitment_agency_submission_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:null},
   {schemaname:'public',tablename:'recruitment_agency_submission',policyname:'recruitment_agency_submission_review',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_agency_tag',policyname:'recruitment_agency_tag_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_agency_tag_link',policyname:'recruitment_agency_tag_link_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_agency_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'e9ee8f62b85f5ca1fa0ebff65fd8e33a',with_check:null},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_blocked_new',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'a4235983c18cc4426b76eb042df10b97',with_check:null},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_blocked_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'dcc7e745f960dd5dd527a1298466c6d5',with_check:null},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_careers_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'7568d5136b415c27d9eadee1b4851169'},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_careers_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'7568d5136b415c27d9eadee1b4851169',with_check:null},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_email_worker_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c25cb773758a7ca2232a4aa74d0e2b4a',with_check:null},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_referral_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'27f45e80a297d02bf33a403b040b6f17'},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_referral_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'27f45e80a297d02bf33a403b040b6f17',with_check:null},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_team_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_team_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'26faf16159ffcce6d5cda1f47a687684',with_check:null},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_team_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'b13624fe77cecb4d5265059a36b872f3',with_check:'b13624fe77cecb4d5265059a36b872f3'},
   {schemaname:'public',tablename:'recruitment_application',policyname:'recruitment_application_to_assign_probe',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f650b2469c69eef6cc3e6b63d70050bf',with_check:null},
   {schemaname:'public',tablename:'recruitment_application_event',policyname:'recruitment_application_event_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_application_event',policyname:'recruitment_application_event_careers_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'f7277a2140d296147b658e05318108c1'},
   {schemaname:'public',tablename:'recruitment_application_event',policyname:'recruitment_application_event_referral_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'34f09a8fd3c6ba35fda846dabe3de5f6'},
   {schemaname:'public',tablename:'recruitment_application_event',policyname:'recruitment_application_event_team_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'0dd9c4dedf47835023bb8ce7557b62b0'},
   {schemaname:'public',tablename:'recruitment_application_event',policyname:'recruitment_application_event_team_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'da03582b0f083dabfe24209dce2c885a',with_check:null},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_blocked_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'78eff7e2d0e9e3a32b0eeac67ce3ff03'},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_blocked_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'78eff7e2d0e9e3a32b0eeac67ce3ff03',with_check:null},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_blocked_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'78eff7e2d0e9e3a32b0eeac67ce3ff03',with_check:'78eff7e2d0e9e3a32b0eeac67ce3ff03'},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'0d5226bac9173dd1244e856b779f4019',with_check:null},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'0d5226bac9173dd1244e856b779f4019',with_check:null},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'abffa8b3056bb36ea4bb9b0fec7f2a0b',with_check:null},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'abffa8b3056bb36ea4bb9b0fec7f2a0b',with_check:null},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_open_guard',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'d7cc3779359594a218db2c3d1426f1a1',with_check:null},
   {schemaname:'public',tablename:'recruitment_application_review_mark',policyname:'recruitment_application_review_mark_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'126623df70b43c63a4386302df26456d',with_check:null},
   {schemaname:'public',tablename:'recruitment_approval_step',policyname:'recruitment_approval_step_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_approval_step',policyname:'recruitment_approval_step_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'8967b0c0a39648d52c60f02945e66729',with_check:null},
   {schemaname:'public',tablename:'recruitment_archive_reason',policyname:'recruitment_archive_reason_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_archive_reason',policyname:'recruitment_archive_reason_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check',policyname:'recruitment_background_check_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'ef395a3830c27b5336f7175cb045a735',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check',policyname:'recruitment_background_check_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ef395a3830c27b5336f7175cb045a735',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check',policyname:'recruitment_background_check_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'78c6e2ddff15743aaf3cb0107a2ba65e',with_check:'78c6e2ddff15743aaf3cb0107a2ba65e'},
   {schemaname:'public',tablename:'recruitment_background_check',policyname:'recruitment_background_check_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'78c6e2ddff15743aaf3cb0107a2ba65e',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check',policyname:'recruitment_background_check_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_background_check',policyname:'recruitment_background_check_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b13624fe77cecb4d5265059a36b872f3',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check',policyname:'recruitment_background_check_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_background_check_detail',policyname:'recruitment_background_check_detail_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'df941be4259a627cd81929d6616f5318',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_detail',policyname:'recruitment_background_check_detail_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'df941be4259a627cd81929d6616f5318',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_detail',policyname:'recruitment_background_check_detail_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'f673f9ddaa7629fc468f24b9957a9b45',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_detail',policyname:'recruitment_background_check_detail_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f673f9ddaa7629fc468f24b9957a9b45',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_detail',policyname:'recruitment_background_check_detail_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_background_check_detail',policyname:'recruitment_background_check_detail_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_detail',policyname:'recruitment_background_check_detail_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_background_check_file',policyname:'recruitment_background_check_file_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'f0f46dea92b7548d36230e717470289b',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_file',policyname:'recruitment_background_check_file_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f0f46dea92b7548d36230e717470289b',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_file',policyname:'recruitment_background_check_file_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'c901802ab86e950f7c5c9f98d5929d2b',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_file',policyname:'recruitment_background_check_file_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c901802ab86e950f7c5c9f98d5929d2b',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_file',policyname:'recruitment_background_check_file_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_background_check_file',policyname:'recruitment_background_check_file_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_type',policyname:'recruitment_background_check_type_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_background_check_type',policyname:'recruitment_background_check_type_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_type_link',policyname:'recruitment_background_check_type_link_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'c04014fd342e042cae7d0a16564b4d22',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_type_link',policyname:'recruitment_background_check_type_link_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c04014fd342e042cae7d0a16564b4d22',with_check:null},
   {schemaname:'public',tablename:'recruitment_background_check_type_link',policyname:'recruitment_background_check_type_link_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_background_check_type_link',policyname:'recruitment_background_check_type_link_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b13624fe77cecb4d5265059a36b872f3',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_active_probe',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'a559d8f85e5e750afd6e81b51f287801',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_blocked_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'294640f1b7974bddd361ffc613503b6f'},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_blocked_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'294640f1b7974bddd361ffc613503b6f',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_blocked_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'294640f1b7974bddd361ffc613503b6f',with_check:'294640f1b7974bddd361ffc613503b6f'},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'7abaccf04290b38b3c2b3f44ba413bc3',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'7abaccf04290b38b3c2b3f44ba413bc3',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'c37eb90af6d5fd2774722d47928e8c83',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c37eb90af6d5fd2774722d47928e8c83',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry',policyname:'recruitment_blocked_entry_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f0eccda431c999fea4b0c2a903d3f601',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry_restricted',policyname:'recruitment_blocked_entry_restricted_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry_restricted',policyname:'recruitment_blocked_entry_restricted_blocked_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'48b925cd18a9d88040cbd40d45937357'},
   {schemaname:'public',tablename:'recruitment_blocked_entry_restricted',policyname:'recruitment_blocked_entry_restricted_blocked_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'48b925cd18a9d88040cbd40d45937357',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry_restricted',policyname:'recruitment_blocked_entry_restricted_blocked_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'48b925cd18a9d88040cbd40d45937357',with_check:'48b925cd18a9d88040cbd40d45937357'},
   {schemaname:'public',tablename:'recruitment_blocked_entry_restricted',policyname:'recruitment_blocked_entry_restricted_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'620802f98a18a2bc3e6e550cb8fe2db8',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry_restricted',policyname:'recruitment_blocked_entry_restricted_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'620802f98a18a2bc3e6e550cb8fe2db8',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry_restricted',policyname:'recruitment_blocked_entry_restricted_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'0381ee39161077d19a14ea7ab3fb5aec',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_entry_restricted',policyname:'recruitment_blocked_entry_restricted_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'0381ee39161077d19a14ea7ab3fb5aec',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_history',policyname:'recruitment_blocked_history_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_history',policyname:'recruitment_blocked_history_blocked_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'e7715ded9c0e76dde6086b6133638700'},
   {schemaname:'public',tablename:'recruitment_blocked_history',policyname:'recruitment_blocked_history_blocked_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'e7715ded9c0e76dde6086b6133638700',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_history',policyname:'recruitment_blocked_history_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'d76949331e9ec45849e6abd74e638e1b',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_history',policyname:'recruitment_blocked_history_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'d76949331e9ec45849e6abd74e638e1b',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_history',policyname:'recruitment_blocked_history_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'e19e99c7f121139495b1be82ccc83376',with_check:null},
   {schemaname:'public',tablename:'recruitment_blocked_history',policyname:'recruitment_blocked_history_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'e19e99c7f121139495b1be82ccc83376',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_blocked_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'37e4cd053e2ff03a9d8ac9e14ae8a70e',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_careers_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'311a023306715c4719a1f59a60d9c133'},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_careers_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'311a023306715c4719a1f59a60d9c133',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_duplicate_probe',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b25c0b8babd0f5663416803dc5c44333',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_email_worker_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'7a8f3d4258815b9819414b214b4e1e49',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_operator_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'ff516705da065a958c8ed83e360eed1d',with_check:'ff516705da065a958c8ed83e360eed1d'},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_referral_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'853a97c491bc2c4c541f89ef0f2f25a1'},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_referral_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'853a97c491bc2c4c541f89ef0f2f25a1',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_team_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'8967b0c0a39648d52c60f02945e66729'},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_team_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'bcbe304dca9b4683ad448c714c94b2ab',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate',policyname:'recruitment_candidate_to_assign_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'cc7faa83d0ff9105aa2584c715515749',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_consent',policyname:'recruitment_candidate_consent_careers_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'54d82372e77406ee2d8658d8c45ad821'},
   {schemaname:'public',tablename:'recruitment_candidate_consent',policyname:'recruitment_candidate_consent_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'ea4b67d239ef03facaa7e8695b657792',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_consent',policyname:'recruitment_candidate_consent_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'edc5c5237953f6d555c3bb979f908562'},
   {schemaname:'public',tablename:'recruitment_candidate_consent',policyname:'recruitment_candidate_consent_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'edc5c5237953f6d555c3bb979f908562',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_restricted',policyname:'recruitment_candidate_custom_restricted_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'36f95be898321dd7189b8ba4d1ec222f',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_restricted',policyname:'recruitment_candidate_custom_restricted_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'36f95be898321dd7189b8ba4d1ec222f',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_restricted',policyname:'recruitment_candidate_custom_restricted_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'10328e878d31a200d4b317639e362092',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_restricted',policyname:'recruitment_candidate_custom_restricted_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'10328e878d31a200d4b317639e362092',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_restricted',policyname:'recruitment_candidate_custom_restricted_operator',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'edc5c5237953f6d555c3bb979f908562',with_check:'edc5c5237953f6d555c3bb979f908562'},
   {schemaname:'public',tablename:'recruitment_candidate_custom_value',policyname:'recruitment_candidate_custom_value_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'0b0383eb765961be561a0d4e17caa3aa',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_value',policyname:'recruitment_candidate_custom_value_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'0b0383eb765961be561a0d4e17caa3aa',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_value',policyname:'recruitment_candidate_custom_value_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'bb75b17cca59ac377a13426802c20ddb',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_value',policyname:'recruitment_candidate_custom_value_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'bb75b17cca59ac377a13426802c20ddb',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_value',policyname:'recruitment_candidate_custom_value_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'042a2fe553d815ae026931dad075b14d',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_custom_value',policyname:'recruitment_candidate_custom_value_write',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'edc5c5237953f6d555c3bb979f908562',with_check:'edc5c5237953f6d555c3bb979f908562'},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'43d8b6f9152233577bfeb4895cb3709d',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'43d8b6f9152233577bfeb4895cb3709d',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_count',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'1b6707fe87ebddf65527c00bc8a7c032',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'e18e7e3c8edd15145398ad5172f67cbd',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'e18e7e3c8edd15145398ad5172f67cbd',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_queue',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'315a1b24c7e48efadff406cd52eca948'},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b13624fe77cecb4d5265059a36b872f3',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_retry',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_candidate_email',policyname:'recruitment_candidate_email_worker',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'a91dc19e6d93f45226f2cfa93e6cf4af',with_check:'a91dc19e6d93f45226f2cfa93e6cf4af'},
   {schemaname:'public',tablename:'recruitment_candidate_email_setting',policyname:'recruitment_candidate_email_setting_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_candidate_email_setting',policyname:'recruitment_candidate_email_setting_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email_setting',policyname:'recruitment_candidate_email_setting_worker_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'2b0d0603056f6f78d33541089dcbcff3',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email_template',policyname:'recruitment_candidate_email_template_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_candidate_email_template',policyname:'recruitment_candidate_email_template_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_email_template',policyname:'recruitment_candidate_email_template_worker_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'1dbd279720a34147fd81513107015c26',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_entry',policyname:'recruitment_candidate_entry_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'042a2fe553d815ae026931dad075b14d',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_entry',policyname:'recruitment_candidate_entry_write',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'edc5c5237953f6d555c3bb979f908562',with_check:'edc5c5237953f6d555c3bb979f908562'},
   {schemaname:'public',tablename:'recruitment_candidate_file',policyname:'recruitment_candidate_file_careers_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'0ad2558fa4c8cdf4c0bfb5448d47a1ab'},
   {schemaname:'public',tablename:'recruitment_candidate_file',policyname:'recruitment_candidate_file_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'edc5c5237953f6d555c3bb979f908562',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_file',policyname:'recruitment_candidate_file_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'edc5c5237953f6d555c3bb979f908562'},
   {schemaname:'public',tablename:'recruitment_candidate_file',policyname:'recruitment_candidate_file_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'5f32df2b248a6061f7b461147ff4fee7',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_file',policyname:'recruitment_candidate_file_referral_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'60f821f4c591a95dd6f8167d7f668c83'},
   {schemaname:'public',tablename:'recruitment_candidate_import',policyname:'recruitment_candidate_import_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'c0b30c028f5365e386bd261307cba1fd',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import',policyname:'recruitment_candidate_import_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c0b30c028f5365e386bd261307cba1fd',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import',policyname:'recruitment_candidate_import_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'ad8a0cb3ba7533edce2354111f66a23c'},
   {schemaname:'public',tablename:'recruitment_candidate_import',policyname:'recruitment_candidate_import_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'22063e3e3563b05ecb5a2466db516a25',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import',policyname:'recruitment_candidate_import_settle',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'cf95a8cb31267b3b50d6c572326d23be',with_check:'cf95a8cb31267b3b50d6c572326d23be'},
   {schemaname:'public',tablename:'recruitment_candidate_import',policyname:'recruitment_candidate_import_settle_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'cf95a8cb31267b3b50d6c572326d23be',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import',policyname:'recruitment_candidate_import_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'ad8a0cb3ba7533edce2354111f66a23c',with_check:'ad8a0cb3ba7533edce2354111f66a23c'},
   {schemaname:'public',tablename:'recruitment_candidate_import_note',policyname:'recruitment_candidate_import_note_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'253dc04d46718d6f5b67af97d466f78d',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import_note',policyname:'recruitment_candidate_import_note_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'253dc04d46718d6f5b67af97d466f78d',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import_note',policyname:'recruitment_candidate_import_note_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'c3c987a307c5f42a82fb91227f672f25',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import_note',policyname:'recruitment_candidate_import_note_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c3c987a307c5f42a82fb91227f672f25',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import_note',policyname:'recruitment_candidate_import_note_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'ad8a0cb3ba7533edce2354111f66a23c'},
   {schemaname:'public',tablename:'recruitment_candidate_import_note',policyname:'recruitment_candidate_import_note_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'0654d801fcbd449235bf38894d08c61b',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import_row',policyname:'recruitment_candidate_import_row_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'8cd0b1d626accb5a93fb01a48b724592',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import_row',policyname:'recruitment_candidate_import_row_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'8cd0b1d626accb5a93fb01a48b724592',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import_row',policyname:'recruitment_candidate_import_row_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'ba5c67aaf8e14c0fcd279e041366687b'},
   {schemaname:'public',tablename:'recruitment_candidate_import_row',policyname:'recruitment_candidate_import_row_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'7d4ccbcd3a649149922e9bf8509b9678',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_import_row',policyname:'recruitment_candidate_import_row_settle',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'68493b6f54a20647342916aa7afa7137'},
   {schemaname:'public',tablename:'recruitment_candidate_import_row',policyname:'recruitment_candidate_import_row_settle_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'68493b6f54a20647342916aa7afa7137',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_restricted',policyname:'recruitment_candidate_restricted_blocked_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'e5ebe9f36d7c190c4be771b1d03be944',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_restricted',policyname:'recruitment_candidate_restricted_duplicate_probe',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f75c7a20b9d655f859f6b26621b1f1c3',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_restricted',policyname:'recruitment_candidate_restricted_operator',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'edc5c5237953f6d555c3bb979f908562',with_check:'edc5c5237953f6d555c3bb979f908562'},
   {schemaname:'public',tablename:'recruitment_candidate_survey_response',policyname:'recruitment_candidate_survey_response_admin_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_survey_response',policyname:'recruitment_candidate_survey_response_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'08a3a2fa735ca8bb9741ebd60573bc7d',with_check:'08a3a2fa735ca8bb9741ebd60573bc7d'},
   {schemaname:'public',tablename:'recruitment_candidate_tag',policyname:'recruitment_candidate_tag_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'edc5c5237953f6d555c3bb979f908562',with_check:null},
   {schemaname:'public',tablename:'recruitment_candidate_tag',policyname:'recruitment_candidate_tag_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'edc5c5237953f6d555c3bb979f908562'},
   {schemaname:'public',tablename:'recruitment_candidate_tag',policyname:'recruitment_candidate_tag_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c6146280ce462aadefba29be4c432d79',with_check:null},
   {schemaname:'public',tablename:'recruitment_careers_application',policyname:'recruitment_careers_application_careers_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'098eb8006a3441e51d85a85ad90a9318'},
   {schemaname:'public',tablename:'recruitment_careers_application',policyname:'recruitment_careers_application_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'ea4b67d239ef03facaa7e8695b657792',with_check:'ea4b67d239ef03facaa7e8695b657792'},
   {schemaname:'public',tablename:'recruitment_careers_application',policyname:'recruitment_careers_application_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b13624fe77cecb4d5265059a36b872f3',with_check:null},
   {schemaname:'public',tablename:'recruitment_careers_notice',policyname:'recruitment_careers_notice_admin_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_careers_notice',policyname:'recruitment_careers_notice_admin_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:null},
   {schemaname:'public',tablename:'recruitment_careers_notice',policyname:'recruitment_careers_notice_careers_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'fc165e3e184545e30c88ab0931358090',with_check:null},
   {schemaname:'public',tablename:'recruitment_careers_notice',policyname:'recruitment_careers_notice_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'3db46335e0f502aa8cdd0c731406447b',with_check:null},
   {schemaname:'public',tablename:'recruitment_careers_notice',policyname:'recruitment_careers_notice_public',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'382d2043401750932c57de20d1cb3bdb',with_check:null},
   {schemaname:'public',tablename:'recruitment_careers_site',policyname:'recruitment_careers_site_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_careers_site',policyname:'recruitment_careers_site_public',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'aca629112467c21c0106715380b7c391',with_check:null},
   {schemaname:'public',tablename:'recruitment_company_setting',policyname:'recruitment_company_setting_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_company_setting',policyname:'recruitment_company_setting_agency_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'663d49252768735c6be5002644858ea4',with_check:null},
   {schemaname:'public',tablename:'recruitment_company_setting',policyname:'recruitment_company_setting_careers_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'d1cbee26eab47e88cf53b510d6826c89',with_check:null},
   {schemaname:'public',tablename:'recruitment_company_setting',policyname:'recruitment_company_setting_referral_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'96599c19451e449388c6c50add531845',with_check:null},
   {schemaname:'public',tablename:'recruitment_company_setting',policyname:'recruitment_company_setting_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_custom_field',policyname:'recruitment_custom_field_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_custom_field',policyname:'recruitment_custom_field_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'aac8413e54d84b87c65ede51be1e4b2f',with_check:null},
   {schemaname:'public',tablename:'recruitment_custom_field_option',policyname:'recruitment_custom_field_option_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_custom_field_option',policyname:'recruitment_custom_field_option_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'e22a90688905218dd7d56d2564a37921',with_check:null},
   {schemaname:'public',tablename:'recruitment_evaluation_form',policyname:'recruitment_evaluation_form_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_evaluation_form',policyname:'recruitment_evaluation_form_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_export_template',policyname:'recruitment_export_template_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_export_template',policyname:'recruitment_export_template_operator',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'8967b0c0a39648d52c60f02945e66729',with_check:null},
   {schemaname:'public',tablename:'recruitment_hire_handoff',policyname:'recruitment_hire_handoff_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'c05eabf225562f7d1e95f551d7f4157c'},
   {schemaname:'public',tablename:'recruitment_hire_handoff',policyname:'recruitment_hire_handoff_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b13624fe77cecb4d5265059a36b872f3',with_check:null},
   {schemaname:'public',tablename:'recruitment_import_preview_quota',policyname:'recruitment_import_preview_quota_self',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'c3507aad03f3c5fca92b8d982ffc71dd',with_check:'c3507aad03f3c5fca92b8d982ffc71dd'},
   {schemaname:'public',tablename:'recruitment_interview',policyname:'recruitment_interview_close_review',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'b13624fe77cecb4d5265059a36b872f3',with_check:'b13624fe77cecb4d5265059a36b872f3'},
   {schemaname:'public',tablename:'recruitment_interview',policyname:'recruitment_interview_email_worker_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'660694ccee978172d894c3c121d7e55f',with_check:null},
   {schemaname:'public',tablename:'recruitment_interview',policyname:'recruitment_interview_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_interview',policyname:'recruitment_interview_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'34a7482393ad6587bb13e7691a269f29',with_check:null},
   {schemaname:'public',tablename:'recruitment_interview',policyname:'recruitment_interview_response_worker',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'660694ccee978172d894c3c121d7e55f',with_check:'660694ccee978172d894c3c121d7e55f'},
   {schemaname:'public',tablename:'recruitment_interview',policyname:'recruitment_interview_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_interview_address',policyname:'recruitment_interview_address_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_interview_address',policyname:'recruitment_interview_address_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_interview_interviewer',policyname:'recruitment_interview_interviewer_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:null},
   {schemaname:'public',tablename:'recruitment_interview_interviewer',policyname:'recruitment_interview_interviewer_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_interview_interviewer',policyname:'recruitment_interview_interviewer_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'1c0217337788aa37967d6f24f94fc643',with_check:null},
   {schemaname:'public',tablename:'recruitment_interview_question',policyname:'recruitment_interview_question_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_interview_question',policyname:'recruitment_interview_question_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_interview_question_link',policyname:'recruitment_interview_question_link_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_interview_question_link',policyname:'recruitment_interview_question_link_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_interview_room',policyname:'recruitment_interview_room_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_interview_room',policyname:'recruitment_interview_room_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_interviewer_group',policyname:'recruitment_interviewer_group_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_interviewer_group',policyname:'recruitment_interviewer_group_operator',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'8967b0c0a39648d52c60f02945e66729',with_check:null},
   {schemaname:'public',tablename:'recruitment_interviewer_group_member',policyname:'recruitment_interviewer_group_member_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_interviewer_group_member',policyname:'recruitment_interviewer_group_member_operator',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'8967b0c0a39648d52c60f02945e66729',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_agency_contract',policyname:'recruitment_job_agency_contract_agency_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b1b6061bdde5c878d39f9bd5d09d041c',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_agency_contract',policyname:'recruitment_job_agency_contract_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_agency_contract',policyname:'recruitment_job_agency_contract_write',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'3677331cd793fef1e7566545a844fcc5',with_check:'3677331cd793fef1e7566545a844fcc5'},
   {schemaname:'public',tablename:'recruitment_job_custom_value',policyname:'recruitment_job_custom_value_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_job_custom_value',policyname:'recruitment_job_custom_value_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'f6f39152d08872e8fdbd3e150436a9f7',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_custom_value',policyname:'recruitment_job_custom_value_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f6f39152d08872e8fdbd3e150436a9f7',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_custom_value',policyname:'recruitment_job_custom_value_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'3c162a152542fde02485c403701f3ef2',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_member',policyname:'recruitment_job_member_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_job_member',policyname:'recruitment_job_member_screening_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'71f538efaccc97fd58ec26add34c0f49',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_member',policyname:'recruitment_job_member_self',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c3507aad03f3c5fca92b8d982ffc71dd',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_agency_portal',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'9a0b49e3595d86f7c84924065640e023',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_careers_lock',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'3fd5e8f0c3ae5705f68ab08c25670844',with_check:'68934a3e9455fa72420237eb05902327'},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_careers_public',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f2996ba4a4b91e7b4315850af3a22564',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_careers_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'3fd5e8f0c3ae5705f68ab08c25670844',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_referral_lock',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'1cb9d790a76af81bab26819f7d6c28d8',with_check:'68934a3e9455fa72420237eb05902327'},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_referral_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'1cb9d790a76af81bab26819f7d6c28d8',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_response_worker_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'e72867eef3e2f87c308ab65f02c64351',with_check:null},
   {schemaname:'public',tablename:'recruitment_job_opening',policyname:'recruitment_job_opening_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b7681b4f6ec3fd504b7f190ff05a0e7b',with_check:null},
   {schemaname:'public',tablename:'recruitment_offer',policyname:'recruitment_offer_email_worker_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'0fe942492508f8e48e8bf1477a99fc88',with_check:null},
   {schemaname:'public',tablename:'recruitment_offer',policyname:'recruitment_offer_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_offer',policyname:'recruitment_offer_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'42ecdd35c91f2106c83f16a45c73260a',with_check:null},
   {schemaname:'public',tablename:'recruitment_offer',policyname:'recruitment_offer_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'55803bfd7e0219d86eb2700db4e383d3',with_check:'7d6103c125ea2417ec46a8add3e37815'},
   {schemaname:'public',tablename:'recruitment_offer_approval',policyname:'recruitment_offer_approval_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'d1d697706d49ef5decf4df3548fa7fcc',with_check:'d1d697706d49ef5decf4df3548fa7fcc'},
   {schemaname:'public',tablename:'recruitment_offer_approval',policyname:'recruitment_offer_approval_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'3a132319c73765da514b775c5cc924c0'},
   {schemaname:'public',tablename:'recruitment_offer_approval',policyname:'recruitment_offer_approval_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'dbaa61dc9563fdb6262df6a8777982b4',with_check:null},
   {schemaname:'public',tablename:'recruitment_offer_field',policyname:'recruitment_offer_field_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_offer_field',policyname:'recruitment_offer_field_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c4102bd7c24780937e835ccfe12562f5',with_check:null},
   {schemaname:'public',tablename:'recruitment_offer_value',policyname:'recruitment_offer_value_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'7889afaba66ca31ffbb378ab3f96aefe',with_check:null},
   {schemaname:'public',tablename:'recruitment_offer_value',policyname:'recruitment_offer_value_write',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'a560a3224a45f46368cfc9934591b15e',with_check:'a560a3224a45f46368cfc9934591b15e'},
   {schemaname:'public',tablename:'recruitment_position_template',policyname:'recruitment_position_template_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_position_template_value',policyname:'recruitment_position_template_value_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_process',policyname:'recruitment_process_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_process',policyname:'recruitment_process_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_process_stage',policyname:'recruitment_process_stage_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_process_stage',policyname:'recruitment_process_stage_careers_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'db00d9cbcebdffccea695b79baad33d8',with_check:null},
   {schemaname:'public',tablename:'recruitment_process_stage',policyname:'recruitment_process_stage_referral_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'285e271992004875a59032b8ede9871f',with_check:null},
   {schemaname:'public',tablename:'recruitment_process_stage',policyname:'recruitment_process_stage_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_referral',policyname:'recruitment_referral_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'ea4b67d239ef03facaa7e8695b657792',with_check:'ea4b67d239ef03facaa7e8695b657792'},
   {schemaname:'public',tablename:'recruitment_referral',policyname:'recruitment_referral_own',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'cc55eb498d1f20b7156b3027735b3cd2',with_check:null},
   {schemaname:'public',tablename:'recruitment_referral',policyname:'recruitment_referral_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'34a7482393ad6587bb13e7691a269f29',with_check:null},
   {schemaname:'public',tablename:'recruitment_referral',policyname:'recruitment_referral_referral_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'b8b2e787d163f2341debe68bfd145627'},
   {schemaname:'public',tablename:'recruitment_referral',policyname:'recruitment_referral_referral_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b8b2e787d163f2341debe68bfd145627',with_check:null},
   {schemaname:'public',tablename:'recruitment_referral_reward',policyname:'recruitment_referral_reward_admin_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:null},
   {schemaname:'public',tablename:'recruitment_referral_reward',policyname:'recruitment_referral_reward_decide',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'57aaf67181864842be4c02a080f3a7dc'},
   {schemaname:'public',tablename:'recruitment_referral_reward',policyname:'recruitment_referral_reward_owner',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'0676460b75f75e40337123758f5a1301',with_check:null},
   {schemaname:'public',tablename:'recruitment_referral_reward',policyname:'recruitment_referral_reward_payroll_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'4fb7b4d1a5b5fb9b53ba9c004c5c71bf',with_check:null},
   {schemaname:'public',tablename:'recruitment_referral_reward',policyname:'recruitment_referral_reward_send',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'2080dedb114f06901fdadc55edb61f1c',with_check:'59d9fac2c1b4492d61a410cc27e30ba0'},
   {schemaname:'public',tablename:'recruitment_requisition',policyname:'recruitment_requisition_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_requisition',policyname:'recruitment_requisition_approver_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'fe29afd3f8702e442dc7c63b29060a18',with_check:null},
   {schemaname:'public',tablename:'recruitment_requisition',policyname:'recruitment_requisition_approver_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'9618d6f84b62a1c2500a5cf9e13abe4d',with_check:'fe29afd3f8702e442dc7c63b29060a18'},
   {schemaname:'public',tablename:'recruitment_requisition_approval',policyname:'recruitment_requisition_approval_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'3a132319c73765da514b775c5cc924c0'},
   {schemaname:'public',tablename:'recruitment_requisition_approval',policyname:'recruitment_requisition_approval_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'0f6fb2ac882d8a6cac98ee2add055a56',with_check:null},
   {schemaname:'public',tablename:'recruitment_requisition_job',policyname:'recruitment_requisition_job_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_scorecard',policyname:'recruitment_scorecard_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'e9c764ff3c578e2191abaf2cf9b8e414',with_check:'e9c764ff3c578e2191abaf2cf9b8e414'},
   {schemaname:'public',tablename:'recruitment_scorecard',policyname:'recruitment_scorecard_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'bfe4911eac92ec6a8743233b3e462274'},
   {schemaname:'public',tablename:'recruitment_scorecard',policyname:'recruitment_scorecard_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'415746a8558581721c07dd38ca8b3323',with_check:null},
   {schemaname:'public',tablename:'recruitment_scorecard',policyname:'recruitment_scorecard_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'bfe4911eac92ec6a8743233b3e462274',with_check:'bfe4911eac92ec6a8743233b3e462274'},
   {schemaname:'public',tablename:'recruitment_screening_answer',policyname:'recruitment_screening_answer_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'f99187e51c741d7c4e60c3adf6aaf396',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_answer',policyname:'recruitment_screening_answer_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f99187e51c741d7c4e60c3adf6aaf396',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_answer',policyname:'recruitment_screening_answer_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'5fd0bef69d986c455ee27d2389682031',with_check:'5fd0bef69d986c455ee27d2389682031'},
   {schemaname:'public',tablename:'recruitment_screening_answer',policyname:'recruitment_screening_answer_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'5fd0bef69d986c455ee27d2389682031',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_answer',policyname:'recruitment_screening_answer_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'4e87d7e0e785a4ae9ffd4ca12cfbc7ec'},
   {schemaname:'public',tablename:'recruitment_screening_answer',policyname:'recruitment_screening_answer_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'b13624fe77cecb4d5265059a36b872f3',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_auto_close',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'af723d93f6924f7134a23f71ea40c854',with_check:'294bb6ac9c48a75931fc9c459e928c8f'},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_auto_close_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'af723d93f6924f7134a23f71ea40c854',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'41c09e1e4adef336704d5a7cc9a1876d',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'41c09e1e4adef336704d5a7cc9a1876d',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'f61ff764d9fad101903551ce6bacf308',with_check:'f61ff764d9fad101903551ce6bacf308'},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f61ff764d9fad101903551ce6bacf308',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_operate_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_operate_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'30ae093aca72c0ca77747934d82d1b07',with_check:'30ae093aca72c0ca77747934d82d1b07'},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_own_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'abba5f2a064ee9ec5db871d4e3ba42f2',with_check:null},
   {schemaname:'public',tablename:'recruitment_screening_request',policyname:'recruitment_screening_request_own_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'27147d83654285812b59f81d206f6e39',with_check:'27c5afb38d45d7a6a21dad1fa5621103'},
   {schemaname:'public',tablename:'recruitment_stage',policyname:'recruitment_stage_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_stage',policyname:'recruitment_stage_careers_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'2a8e609bc9f11736faa323539bda9f02',with_check:null},
   {schemaname:'public',tablename:'recruitment_stage',policyname:'recruitment_stage_referral_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'26742543887b35b0b188a8028e53cfc1',with_check:null},
   {schemaname:'public',tablename:'recruitment_stage',policyname:'recruitment_stage_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_stage_waiting_rule',policyname:'recruitment_stage_waiting_rule_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_stage_waiting_rule',policyname:'recruitment_stage_waiting_rule_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_tag',policyname:'recruitment_tag_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_tag',policyname:'recruitment_tag_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_tag_group',policyname:'recruitment_tag_group_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_tag_group',policyname:'recruitment_tag_group_team',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'ee75d82289275822c5e29592924dd07a',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool',policyname:'recruitment_talent_pool_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_talent_pool',policyname:'recruitment_talent_pool_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'70563277b28eaa4273bc79c9e676e3ef',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool',policyname:'recruitment_talent_pool_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'70563277b28eaa4273bc79c9e676e3ef',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool',policyname:'recruitment_talent_pool_shared',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'610769491064a99f99078ed200d6296d',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool_member',policyname:'recruitment_talent_pool_member_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'0e16e679dcefbbbc94190773d236a3f2',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool_member',policyname:'recruitment_talent_pool_member_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'0e16e679dcefbbbc94190773d236a3f2',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool_member',policyname:'recruitment_talent_pool_member_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'456b44c63512330faea8c3b762b78a1c',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool_member',policyname:'recruitment_talent_pool_member_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'456b44c63512330faea8c3b762b78a1c'},
   {schemaname:'public',tablename:'recruitment_talent_pool_member',policyname:'recruitment_talent_pool_member_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'456b44c63512330faea8c3b762b78a1c',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool_share',policyname:'recruitment_talent_pool_share_admin',permissive:'PERMISSIVE',roles:'{public}',cmd:'ALL',qual:'bb4dc0e91cab08bf384b17de8a2de2b9',with_check:'bb4dc0e91cab08bf384b17de8a2de2b9'},
   {schemaname:'public',tablename:'recruitment_talent_pool_share',policyname:'recruitment_talent_pool_share_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'a6acc52c6eb18d8f4b1d79803ad45d17',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool_share',policyname:'recruitment_talent_pool_share_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'a6acc52c6eb18d8f4b1d79803ad45d17',with_check:null},
   {schemaname:'public',tablename:'recruitment_talent_pool_share',policyname:'recruitment_talent_pool_share_own',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c3507aad03f3c5fca92b8d982ffc71dd',with_check:null},
   {schemaname:'public',tablename:'recruitment_task_read_marker',policyname:'recruitment_task_read_marker_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'1609fc6414455e60f0dd50b1f97503dc',with_check:null},
   {schemaname:'public',tablename:'recruitment_task_read_marker',policyname:'recruitment_task_read_marker_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'1609fc6414455e60f0dd50b1f97503dc',with_check:null},
   {schemaname:'public',tablename:'recruitment_task_read_marker',policyname:'recruitment_task_read_marker_own_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'eeaa791d9950b154bbdd0d87b460bb18'},
   {schemaname:'public',tablename:'recruitment_task_read_marker',policyname:'recruitment_task_read_marker_own_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'c3507aad03f3c5fca92b8d982ffc71dd',with_check:null},
   {schemaname:'public',tablename:'recruitment_task_read_marker',policyname:'recruitment_task_read_marker_own_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'c3507aad03f3c5fca92b8d982ffc71dd',with_check:'c3507aad03f3c5fca92b8d982ffc71dd'},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_clear',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'cc71ee00f03a4efc2852c2425a7a3303',with_check:null},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_clear_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'cc71ee00f03a4efc2852c2425a7a3303',with_check:null},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_company_delete',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'f74601a7a50a9a3e86c076d019c5ae7f',with_check:null},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_company_delete_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'f74601a7a50a9a3e86c076d019c5ae7f',with_check:null},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_destroy',permissive:'PERMISSIVE',roles:'{public}',cmd:'DELETE',qual:'18286ff78a420bfb9fdcf754726d19ee',with_check:null},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_destroy_read',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'18286ff78a420bfb9fdcf754726d19ee',with_check:null},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_insert',permissive:'PERMISSIVE',roles:'{public}',cmd:'INSERT',qual:null,with_check:'ad8a0cb3ba7533edce2354111f66a23c'},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_operator',permissive:'PERMISSIVE',roles:'{public}',cmd:'SELECT',qual:'8967b0c0a39648d52c60f02945e66729',with_check:null},
   {schemaname:'public',tablename:'recruitment_to_assign',policyname:'recruitment_to_assign_update',permissive:'PERMISSIVE',roles:'{public}',cmd:'UPDATE',qual:'8967b0c0a39648d52c60f02945e66729',with_check:'8967b0c0a39648d52c60f02945e66729'},
  ];
  const isRecruitmentRelation=(rel:string)=>Object.hasOwn(recruitmentRelations,rel);
  const isRecruitmentPolicy=(row:(typeof afterPerformancePrivileges.policies)[number])=>recruitmentPolicies.some(policy=>samePolicy(policy,row));
  expect(Object.fromEntries(afterPerformancePrivileges.relations.filter(row=>isRecruitmentRelation(row.rel)).map(row=>[row.rel,{rls:row.rls,force:row.force,acl:ownerAcl(row.acl)}]))).toEqual(recruitmentRelations);
  for(const rel of Object.keys(recruitmentRelations))expect(beforePerformancePrivileges.relations.some(row=>row.rel===rel),rel).toBe(false);
  expect(afterPerformancePrivileges.columns.filter(row=>isRecruitmentRelation(row.rel)).map(row=>({rel:row.rel,col:row.col,acl:ownerAcl(row.acl)}))).toEqual(recruitmentColumns);
  expect(afterPerformancePrivileges.policies.filter(isRecruitmentPolicy).map(boardPolicyRow)).toEqual(recruitmentPolicies);
  expect(beforePerformancePrivileges.policies.filter(isRecruitmentPolicy)).toEqual([]);
  //6100–6102: assert every new security delta before excluding ONLY its exact identity below.
  const approvedRelations:Record<string,{rls:boolean;force:boolean;acl:string}>={
   'app.reward_review_plan_company_outbox':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'app.reward_review_plan_write_lease':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'reward_history_post_read_lease':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER}'},
   'reward_person_history':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=a/OWNER}'},
   'reward_plan_year':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=ar/OWNER}'},
   'reward_plan_year_company':{rls:true,force:true,acl:'{OWNER=arwdDxt/OWNER,ai_hr_app=arw/OWNER}'},
  };
  const isApprovedRelation=(rel:string)=>Object.hasOwn(approvedRelations,rel);
  expect(Object.fromEntries(afterPerformancePrivileges.relations.filter(row=>isApprovedRelation(row.rel)).map(row=>[row.rel,{rls:row.rls,force:row.force,acl:ownerAcl(row.acl)}]))).toEqual(approvedRelations);
  expect(beforePerformancePrivileges.relations.filter(row=>isApprovedRelation(row.rel))).toEqual([]);
  const approvedColumns=['company_id','employment_id','id','kind','source','superseded_at','tenant_id','year'].map(col=>({rel:'reward_person_history',col,acl:col==='superseded_at'?'{ai_hr_app=rw/OWNER}':'{ai_hr_app=r/OWNER}'}));
  expect(afterPerformancePrivileges.columns.filter(row=>isApprovedRelation(row.rel)).map(row=>({...row,acl:ownerAcl(row.acl)}))).toEqual(approvedColumns);
  expect(beforePerformancePrivileges.columns.filter(row=>isApprovedRelation(row.rel))).toEqual([]);
  expect(afterPerformancePrivileges.functions.filter(row=>approvedFunctions.some(expected=>expected.fn===row.fn)).map(row=>({fn:row.fn,acl:ownerAcl(row.acl)})))
   .toEqual(approvedFunctions.map(row=>({fn:row.fn,acl:row.app?'{OWNER=X/OWNER,ai_hr_app=X/OWNER}':'{OWNER=X/OWNER}'})).sort((a,b)=>a.fn<b.fn?-1:a.fn>b.fn?1:0));
  type ApprovedPolicy={table:string;name:string;cmd:'ALL'|'SELECT'|'INSERT'|'UPDATE';role:'public'|'ai_hr_owner'|'ai_hr_app';using:string|null;check:string|null};
  const view=(column:string)=>`tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(${column},'plans.manage','library_view')`;
  const manage=(column:string)=>`tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(${column},'plans.manage','manage')`;
  const own='app.acting_as_owner()';
  const approvedPolicies:ApprovedPolicy[]=[
   {table:'reward_plan_year',name:'reward_plan_year_read',cmd:'SELECT',role:'public',using:view('NULL'),check:null},
   {table:'reward_plan_year',name:'reward_plan_year_insert',cmd:'INSERT',role:'public',using:null,check:manage('NULL')+' AND created_by=app.current_user_id()'},
   {table:'reward_plan_year_company',name:'reward_plan_year_company_read',cmd:'SELECT',role:'public',using:view('company_id'),check:null},
   {table:'reward_plan_year_company',name:'reward_plan_year_company_write',cmd:'ALL',role:'public',using:manage('company_id'),check:manage('company_id')},
   {table:'app.reward_review_plan_write_lease',name:'reward_review_plan_lease_owner',cmd:'ALL',role:'ai_hr_owner',using:own,check:own},
   {table:'reward_plan_setup',name:'reward_year_plan_setup_owner',cmd:'ALL',role:'ai_hr_owner',using:"tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_config_page_allowed(c,'plans.manage','library_view'))",check:"tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_config_page_allowed(c,'plans.manage','manage'))"},
   {table:'reward_plan_company',name:'reward_year_plan_company_owner',cmd:'ALL',role:'ai_hr_owner',using:view('company_id'),check:manage('company_id')},
   {table:'reward_company_year_review',name:'reward_year_company_review_owner',cmd:'SELECT',role:'ai_hr_owner',using:view('company_id'),check:null},
   {table:'company',name:'reward_year_company_owner',cmd:'SELECT',role:'ai_hr_owner',using:view('id'),check:null},
   {table:'employment',name:'reward_year_employment_owner',cmd:'SELECT',role:'ai_hr_owner',using:view('company_id'),check:null},
   {table:'business_unit',name:'reward_year_business_unit_owner',cmd:'SELECT',role:'ai_hr_owner',using:view('NULL'),check:null},
   {table:'reward_pat_version',name:'reward_year_pat_owner',cmd:'SELECT',role:'ai_hr_owner',using:view('company_id'),check:null},
   {table:'reward_library',name:'reward_year_library_owner',cmd:'SELECT',role:'ai_hr_owner',using:view('NULL'),check:null},
   {table:'reward_library_version',name:'reward_year_library_version_owner',cmd:'SELECT',role:'ai_hr_owner',using:view('NULL'),check:null},
   {table:'company_registration_classification',name:'reward_year_registration_owner',cmd:'SELECT',role:'ai_hr_owner',using:view('company_id'),check:null},
   {table:'reward_company_exclusion',name:'reward_review_plan_exclusion_owner',cmd:'ALL',role:'ai_hr_owner',using:manage('company_id'),check:manage('company_id')},
   {table:'app.reward_review_plan_company_outbox',name:'reward_review_plan_outbox_owner',cmd:'ALL',role:'ai_hr_owner',using:own,check:own},
   {table:'reward_plan_year',name:'reward_plan_year_system',cmd:'ALL',role:'ai_hr_owner',using:own,check:own},
   {table:'reward_plan_year_company',name:'reward_plan_year_company_system',cmd:'ALL',role:'ai_hr_owner',using:own,check:own},
   {table:'company_registration_classification',name:'reward_plan_registration_system',cmd:'SELECT',role:'ai_hr_owner',using:own,check:null},
   {table:'reward_unit_setup',name:'reward_review_plan_consume_owner',cmd:'UPDATE',role:'ai_hr_owner',using:"tenant_id=app.current_tenant_id() AND library_rebind_revision IS NOT NULL AND app.reward_not_viewing_as() AND app.reward_access(unit_id) AND(app.reward_capability(unit_id,'figures.edit') OR app.reward_capability(unit_id,'review.decide'))",check:"tenant_id=app.current_tenant_id() AND library_rebind_revision IS NULL AND app.reward_not_viewing_as() AND app.reward_access(unit_id) AND(app.reward_capability(unit_id,'figures.edit') OR app.reward_capability(unit_id,'review.decide'))"},
   {table:'reward_person_history',name:'reward_history_owner_read',cmd:'SELECT',role:'ai_hr_owner',using:'tenant_id=app.current_tenant_id()',check:null},
   {table:'reward_person_history',name:'reward_history_owner_insert',cmd:'INSERT',role:'ai_hr_owner',using:null,check:"tenant_id=app.current_tenant_id() AND source='review' AND created_by=app.current_user_id()"},
   {table:'reward_person_history',name:'reward_history_upload_read',cmd:'SELECT',role:'ai_hr_app',using:"tenant_id=app.current_tenant_id() AND source='upload' AND app.reward_history_upload_authorized(company_id) AND app.reward_history_upload_subject(employment_id,company_id)",check:null},
   {table:'reward_person_history',name:'reward_history_insert',cmd:'INSERT',role:'ai_hr_app',using:null,check:"tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.reward_not_viewing_as() AND source='upload' AND app.reward_history_upload_authorized(company_id)"},
   {table:'reward_person_history',name:'reward_history_supersede',cmd:'UPDATE',role:'ai_hr_app',using:"tenant_id=app.current_tenant_id() AND source='upload' AND superseded_at IS NULL AND app.reward_history_upload_authorized(company_id) AND app.reward_history_upload_subject(employment_id,company_id)",check:"tenant_id=app.current_tenant_id() AND source='upload' AND superseded_at IS NOT NULL AND app.reward_history_upload_authorized(company_id) AND app.reward_history_upload_subject(employment_id,company_id)"},
   {table:'reward_history_post_read_lease',name:'reward_history_post_read_lease_owner',cmd:'ALL',role:'ai_hr_owner',using:'tenant_id=app.current_tenant_id() AND transaction_id=txid_current()',check:'tenant_id=app.current_tenant_id() AND transaction_id=txid_current()'},
   {table:'reward_uploaded_award',name:'reward_history_uploaded_post_selection',cmd:'SELECT',role:'ai_hr_owner',using:"tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.reward_not_viewing_as() AND EXISTS(SELECT 1 FROM public.reward_history_post_read_lease l WHERE l.tenant_id=reward_uploaded_award.tenant_id AND l.unit_id=reward_uploaded_award.unit_id AND l.transaction_id=txid_current()) AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=reward_uploaded_award.unit_id AND u.tenant_id=reward_uploaded_award.tenant_id AND u.deleted_at IS NULL AND u.status IN('approved','posted') AND app.reward_admin(u.company_id) AND 'payroll'=ANY(ARRAY(SELECT app.reward_roles(u.id))))",check:null},
  ];
  const policyIdentity=(policy:ApprovedPolicy)=>({schemaname:policy.table.startsWith('app.')?'app':'public',tablename:policy.table.replace(/^app\./,''),policyname:policy.name});
  const isApprovedPolicy=(row:(typeof afterPerformancePrivileges.policies)[number])=>approvedPolicies.some(policy=>samePolicy(policyIdentity(policy),row));
  expect(beforePerformancePrivileges.policies.filter(isApprovedPolicy)).toEqual([]);
  type ApprovedPolicyRow={schemaname:string;tablename:string;policyname:string;permissive:string;roles:string;cmd:string;qual:string|null;with_check:string|null};
  const renderedApproved=await storage.client.begin(async tx=>{
   const rows:ApprovedPolicyRow[]=[];
   for(const policy of approvedPolicies){
    const table=policy.table.startsWith('app.')?policy.table:'public.'+policy.table;
    await tx.unsafe(`create policy approved_forward_reference on ${table} for ${policy.cmd} to ${policy.role}${policy.using?` using (${policy.using})`:''}${policy.check?` with check (${policy.check})`:''}`);
    const identity=policyIdentity(policy);
    const [row]=await tx<ApprovedPolicyRow[]>`select schemaname::text,tablename::text,policyname::text,permissive::text,roles::text,cmd::text,qual,with_check from pg_policies where schemaname=${identity.schemaname} and tablename=${identity.tablename} and policyname='approved_forward_reference'`;
    rows.push({...row,policyname:policy.name});await tx.unsafe(`drop policy approved_forward_reference on ${table}`);
   }
   return rows;
  });
  const policyOrder=(a:{schemaname:string;tablename:string;policyname:string},b:{schemaname:string;tablename:string;policyname:string})=>{
   const left=[a.schemaname,a.tablename,a.policyname].join('.'),right=[b.schemaname,b.tablename,b.policyname].join('.');return left<right?-1:left>right?1:0;
  };
  expect(afterPerformancePrivileges.policies.filter(isApprovedPolicy)).toEqual(renderedApproved.sort(policyOrder));
  // Resignation9991: exact new policies, parsed independently on their actual tables. No prefix exception.
  const resignationPolicies = [
   {schema:'public',table:'resignation_communication_test',name:'resignation_communication_test_owner',cmd:'ALL',roles:'ai_hr_owner',using:'app.acting_as_owner()',check:'app.acting_as_owner()'},
  {
    "schema": "public",
    "table": "lc_v9_config",
    "name": "resignation_handoff_config_read",
    "cmd": "SELECT",
    "roles": "ai_hr_app",
    "using": "tenant_id=app.current_tenant_id() AND app.resignation_handoff_active()",
    "check": null
  },
  {
    "schema": "public",
    "table": "resignation_journey",
    "name": "resignation_journey_owner",
    "cmd": "ALL",
    "roles": "ai_hr_owner",
    "using": "app.acting_as_owner()",
    "check": "app.acting_as_owner()"
  },
  {
    "schema": "app",
    "table": "resignation_runtime_verifier",
    "name": "resignation_runtime_owner",
    "cmd": "ALL",
    "roles": "ai_hr_owner",
    "using": "app.acting_as_owner()",
    "check": "app.acting_as_owner()"
  },
  {
    "schema": "app",
    "table": "resignation_runtime_state",
    "name": "resignation_runtime_owner",
    "cmd": "ALL",
    "roles": "ai_hr_owner",
    "using": "app.acting_as_owner()",
    "check": "app.acting_as_owner()"
  },
  {
    "schema": "public",
    "table": "resignation_journey",
    "name": "resignation_journey_read",
    "cmd": "SELECT",
    "roles": "ai_hr_app",
    "using": "tenant_id=app.current_tenant_id() AND app.resignation_runtime_readable(id,employment_id,company_id)",
    "check": null
  },
  {
    "schema": "public",
    "table": "resignation_journey_file",
    "name": "resignation_journey_file_owner",
    "cmd": "ALL",
    "roles": "ai_hr_owner",
    "using": "app.acting_as_owner()",
    "check": "app.acting_as_owner()"
  },
  {
    "schema": "public",
    "table": "resignation_journey_file",
    "name": "resignation_journey_file_read",
    "cmd": "SELECT",
    "roles": "ai_hr_app",
    "using": "tenant_id=app.current_tenant_id() AND app.resignation_journey_access(case_id) AND document_id IS NULL",
    "check": null
  },
  {
    "schema": "public",
    "table": "resignation_journey_file",
    "name": "resignation_journey_file_insert",
    "cmd": "INSERT",
    "roles": "ai_hr_app",
    "using": null,
    "check": "tenant_id=app.current_tenant_id() AND uploaded_by=app.current_user_id() AND document_id IS NULL AND EXISTS(SELECT 1 FROM resignation_journey j CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.data->'waits','[]'::jsonb)) w WHERE j.tenant_id=resignation_journey_file.tenant_id AND j.id=resignation_journey_file.case_id AND w->>'kind'='file' AND w->>'id'=resignation_journey_file.task_id AND w->>'slot'=resignation_journey_file.slot AND w->'to' ? app.current_user_id()::text)"
  },
  {
    "schema": "public",
    "table": "lc_v9_case",
    "name": "resignation_handoff_case_read",
    "cmd": "SELECT",
    "roles": "ai_hr_app",
    "using": "tenant_id=app.current_tenant_id() AND app.resignation_handoff_active() AND data->>'resignationSourceCaseId'=current_setting('app.resignation_handoff',true)",
    "check": null
  },
  {
    "schema": "public",
    "table": "lc_v9_case",
    "name": "resignation_handoff_case_insert",
    "cmd": "INSERT",
    "roles": "ai_hr_app",
    "using": null,
    "check": "tenant_id=app.current_tenant_id() AND app.resignation_handoff_active() AND module='off' AND data->>'resignationSourceCaseId'=current_setting('app.resignation_handoff',true) AND EXISTS(SELECT 1 FROM resignation_journey j WHERE j.id::text=current_setting('app.resignation_handoff',true) AND j.tenant_id=lc_v9_case.tenant_id AND j.employment_id=lc_v9_case.employment_id AND j.company_id=lc_v9_case.company_id AND j.offboarding_case_id IS NULL)"
  },
  {
    "schema": "app",
    "table": "resignation_notification_receipt",
    "name": "resignation_notification_owner",
    "cmd": "ALL",
    "roles": "ai_hr_owner",
    "using": "app.acting_as_owner()",
    "check": "app.acting_as_owner()"
  },
  {
    "schema": "public",
    "table": "resignation_request_attachment",
    "name": "resignation_journey_supporting_read",
    "cmd": "SELECT",
    "roles": "ai_hr_app",
    "using": "tenant_id=app.current_tenant_id() AND app.resignation_journey_access(resignation_request_id)",
    "check": null
  }
] as const;
  const isResignationPolicy=(row:(typeof afterPerformancePrivileges.policies)[number])=>resignationPolicies.some(p=>p.schema===row.schemaname&&p.table===row.tablename&&p.name===row.policyname);
  expect(beforePerformancePrivileges.policies.filter(isResignationPolicy)).toEqual([]);
  const resignationRendered=await storage.client.begin(async tx=>{
   const reviewed=[];
   for(const policy of resignationPolicies){
    const qualified=policy.schema+'.'+policy.table;
    await tx.unsafe('create policy upgrade_expected_resignation on '+qualified+' for '+policy.cmd+' to '+policy.roles+(policy.using?' using ('+policy.using+')':'')+(policy.check?' with check ('+policy.check+')':''));
    const [row]=await tx`select qual,with_check from pg_policies where schemaname=${policy.schema} and tablename=${policy.table} and policyname='upgrade_expected_resignation'`;
    reviewed.push(row);await tx.unsafe('drop policy upgrade_expected_resignation on '+qualified);
   }
   return reviewed;
  });
  expect(afterPerformancePrivileges.policies.filter(isResignationPolicy)).toHaveLength(resignationPolicies.length);
  resignationPolicies.forEach((policy,index)=>{
   const actual=afterPerformancePrivileges.policies.find(row=>row.schemaname===policy.schema&&row.tablename===policy.table&&row.policyname===policy.name);
   expect(actual,policy.schema+'.'+policy.table+'.'+policy.name).toEqual({schemaname:policy.schema,tablename:policy.table,policyname:policy.name,permissive:'PERMISSIVE',roles:'{'+policy.roles+'}',cmd:policy.cmd,qual:resignationRendered[index].qual,with_check:resignationRendered[index].with_check});
  });
  // Every new Contract policy has an exact table/name/role/command and independently
  // parsed literal predicate. A prefix is never permission to omit an unexpected policy.
  const contractPolicies=contractIntent.policiesAdded;
  const isContractPolicy=(row:(typeof afterPerformancePrivileges.policies)[number])=>contractPolicies.some(policy=>policy.schema===row.schemaname&&policy.table===row.tablename&&policy.name===row.policyname);
  expect(beforePerformancePrivileges.policies.filter(isContractPolicy)).toEqual([]);
  const contractRendered=await storage.client.begin(async tx=>{
   const reviewed=[];
   for(const policy of contractPolicies){
    const qualified=policy.schema+'.'+policy.table;
    await tx.unsafe('create policy upgrade_expected_contract on '+qualified+' for '+policy.cmd+' to '+policy.roles+(policy.using?' using ('+policy.using+')':'')+(policy.check?' with check ('+policy.check+')':''));
    const [row]=await tx`select qual,with_check from pg_policies where schemaname=${policy.schema} and tablename=${policy.table} and policyname='upgrade_expected_contract'`;
    reviewed.push(row);await tx.unsafe('drop policy upgrade_expected_contract on '+qualified);
   }
   return reviewed;
  });
  expect(afterPerformancePrivileges.policies.filter(isContractPolicy)).toHaveLength(contractPolicies.length);
  contractPolicies.forEach((policy,index)=>{
   const actual=afterPerformancePrivileges.policies.find(row=>row.schemaname===policy.schema&&row.tablename===policy.table&&row.policyname===policy.name);
   expect(actual,policy.schema+'.'+policy.table+'.'+policy.name).toEqual({schemaname:policy.schema,tablename:policy.table,policyname:policy.name,permissive:'PERMISSIVE',roles:'{'+policy.roles+'}',cmd:policy.cmd,qual:contractRendered[index].qual,with_check:contractRendered[index].with_check});
  });
  // 5842 narrows only legacy On/Off asset reads/inserts to rows outside shared automation.
  // Independently parse both 0715 and 5842 literals, then pin every before/after policy field.
  const legacyEmailAssetPolicies=[
   {name:'lc_v9_email_asset_insert',cmd:'INSERT',using:null,check:'tenant_id=app.current_tenant_id() AND app.is_group_admin() AND uploaded_by=app.current_user_id()'},
   {name:'lc_v9_email_asset_read',cmd:'SELECT',using:'tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND (app.is_admin() OR app.is_group_admin())',check:null},
  ];
  type LegacyAssetPredicate={qual:string|null;with_check:string|null};
  const legacyEmailAssetPredicates=await storage.client.begin(async tx=>{
   const reviewed:{before:LegacyAssetPredicate;after:LegacyAssetPredicate}[]=[];
   for(const policy of legacyEmailAssetPolicies){
    const versions:LegacyAssetPredicate[]=[];
    for(const sharedBoundary of [false,true]){
     const prefix=sharedBoundary?'automation_module IS NULL AND ':'';
     await tx.unsafe('create policy upgrade_expected_legacy_email_asset on public.lc_v9_email_asset for '+policy.cmd+' to public'+(policy.using?' using ('+prefix+policy.using+')':'')+(policy.check?' with check ('+prefix+policy.check+')':''));
     const [row]=await tx<LegacyAssetPredicate[]>`select qual,with_check from pg_policies where schemaname='public' and tablename='lc_v9_email_asset' and policyname='upgrade_expected_legacy_email_asset'`;
     versions.push(row);
     await tx.unsafe('drop policy upgrade_expected_legacy_email_asset on public.lc_v9_email_asset');
    }
    reviewed.push({before:versions[0],after:versions[1]});
   }
   return reviewed;
  });
  const legacyEmailAssetIndex=(row:(typeof afterPerformancePrivileges.policies)[number])=>row.schemaname==='public'&&row.tablename==='lc_v9_email_asset'?legacyEmailAssetPolicies.findIndex(policy=>policy.name===row.policyname):-1;
  legacyEmailAssetPolicies.forEach((policy,index)=>{
   const identity={schemaname:'public',tablename:'lc_v9_email_asset',policyname:policy.name,permissive:'PERMISSIVE',roles:'{public}',cmd:policy.cmd};
   expect(beforePerformancePrivileges.policies.filter(row=>legacyEmailAssetIndex(row)===index),policy.name+' original source').toEqual([{...identity,...legacyEmailAssetPredicates[index].before}]);
   expect(afterPerformancePrivileges.policies.filter(row=>legacyEmailAssetIndex(row)===index),policy.name+' reviewed narrowing').toEqual([{...identity,...legacyEmailAssetPredicates[index].after}]);
  });
  const originalLegacyEmailAssetPredicate=(row:(typeof afterPerformancePrivileges.policies)[number])=>{
   const index=legacyEmailAssetIndex(row);
   return index<0?row:{...row,...legacyEmailAssetPredicates[index].before};
  };
  const terminalComparable={
   relations:afterPerformancePrivileges.relations.filter(row=>row.rel!==receiptTable&&!sealTables.includes(row.rel)&&!isCombinedRelation(row.rel)&&!Object.hasOwn(boardRelations,row.rel)&&!isRecruitmentRelation(row.rel)&&!isApprovedRelation(row.rel)).map(row=>
    row.rel===clockTable?{...row,acl:beforeClockTable?.acl}:row),
   columns:afterPerformancePrivileges.columns.filter(row=>row.rel!==receiptTable&&row.rel!==clockTable&&!isCombinedRelation(row.rel)&&!isRecruitmentRelation(row.rel)&&!isApprovedRelation(row.rel)),
   functions:afterPerformancePrivileges.functions.filter(row=>!addedFunctions.includes(row.fn)),
   policies:afterPerformancePrivileges.policies.filter(row=>!receiptPolicies.includes(row)&&!clockAuditPolicy(row)&&!isCombinedPolicy(row)&&!isBoardPolicy(row)&&!isLanePolicy(row)&&!isRecruitmentPolicy(row)&&!isApprovedPolicy(row)&&!isContractPolicy(row)&&!isResignationPolicy(row)).map(row=>
    isClaimPolicy(row)?{...row,qual:expectedClaimQuals[0]}:isEmploymentPolicy(row)?{...row,qual:expectedEmploymentQuals[0]}:
     isAssignmentPolicy(row)?{...row,qual:expectedAssignmentQuals[0]}:
      isAttachmentRead(row)?{...row,...expectedAttachment.read[0]}:isAttachmentInsert(row)?{...row,...expectedAttachment.insert[0]}:originalLegacyEmailAssetPredicate(row)),
  };
  expect(terminalComparable).toEqual({...beforePerformancePrivileges,policies:beforePerformancePrivileges.policies.filter(row=>!isBoardRetiredPolicy(row)&&!isLanePolicy(row))});
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
  // 5640 (board release gate repair, 13 November 2026) adds the same validated NO ACTION key to 5460's lc_v9_email_hold.
  // Probation reshape (16 November 2026): 5741's personnel_posting and 5742's settings-scope membership use the same key.
  const boardReleaseKeys = [
   { rel: 'lc_v9_email_hold', conname: 'lc_v9_email_hold_company_tenant_fk', convalidated: true, action: 'a' },
   { rel: 'resignation_journey', conname: 'resignation_journey_company_tenant_fk', convalidated: true, action: 'a' },
   { rel: 'personnel_posting', conname: 'personnel_posting_company_tenant_fk', convalidated: true, action: 'a' },
   { rel: 'probation_access_member', conname: 'probation_access_member_company_tenant_fk', convalidated: true, action: 'a' },
   { rel: 'probation_form_import', conname: 'probation_form_import_company_tenant_fk', convalidated: true, action: 'a' },
   { rel: 'probation_settings_scope_member', conname: 'probation_settings_scope_member_company_tenant_fk', convalidated: true, action: 'a' },
   { rel: 'reward_person_history', conname: 'reward_person_history_company_tenant_fk', convalidated: true, action: 'a' },
  ];
  const boardReleaseNames = new Set(boardReleaseKeys.map(row => row.conname));
  expect(await storage.client`select i.indisvalid as valid,i.indisready as ready,i.indisunique as unique,
   array(select a.attname::text from unnest(i.indkey::smallint[]) with ordinality k(num,ord) join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num order by k.ord) as columns,
   pg_get_expr(i.indpred,i.indrelid) as predicate from pg_index i where i.indexrelid='public.reward_person_history_company'::regclass`)
   .toEqual([{valid:true,ready:true,unique:false,columns:['tenant_id','company_id'],predicate:null}]);
  const completeKeys = await keys();
  expect(completeKeys.filter(row => boardReleaseNames.has(row.conname))).toEqual([...boardReleaseKeys].sort((a,b)=>a.rel.localeCompare(b.rel)));
  expect(completeKeys.filter(row => !expansionNames.has(row.conname) && !boardReleaseNames.has(row.conname))).toEqual(installed);
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
