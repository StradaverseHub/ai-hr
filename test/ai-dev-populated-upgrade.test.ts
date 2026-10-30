/** CI-only populated historical568→635 aggregate upgrade. Never connects to an installation or replays an installer.
 * The credential-free witness is metadata only; payroll/review rows below are fictional physical rows.
 * This proves migration preservation, not decryption or native decision behavior (covered separately). */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
import {expectedMigrationLedger,validateMigrationLedgerRows} from '../.github/ci/staging-migration-ledger.mjs';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import witness from './fixtures/ai-dev-applied-ledger-20261030.json';

type Entry={idx:number;when:number;tag:string};
type Journal={entries:Entry[];[key:string]:unknown};
// Exact main15 +approved49 source tail +root0861/0863/0864; the568-row observed witness remains unchanged.
const TAIL=[
 {"tag":"0696_feedback_menu_operator_switch","idx":683,"when":1793330000031},
 {"tag":"0721_movement_settings_catalog","idx":684,"when":1793330000050},
 {"tag":"0722_movement_type_controls","idx":685,"when":1793330000051},
 {"tag":"0713_lifecycle_v9","idx":686,"when":1793330000056},
 {"tag":"0714_lifecycle_v9_email","idx":687,"when":1793330000057},
 {"tag":"0715_lifecycle_v9_email_assets","idx":688,"when":1793330000058},
 {"tag":"0716_lifecycle_v9_events","idx":689,"when":1793330000059},
 {"tag":"0717_lifecycle_v9_delivery_review","idx":690,"when":1793330000060},
 {"tag":"0718_lifecycle_v9_employment_class","idx":691,"when":1793330000061},
 {"tag":"0719_lifecycle_v9_business_recipients","idx":692,"when":1793330000062},
 {"tag":"0720_lifecycle_v9_self_equipment","idx":693,"when":1793330000063},
 {"tag":"0728_feedback_release_evidence","idx":694,"when":1793330000065},
 {"tag":"0691_bank_import_point_read","idx":695,"when":1793330000075},
 {"tag":"0800_pay_formula_builder","idx":696,"when":1793330000200},
 {"tag":"0811_pay_formula_company_retention","idx":697,"when":1793330000211},
 {"tag":"0812_ai_feature_switch_owner","idx":698,"when":1793330000212},
 {"tag":"0813_assistant_action_kind","idx":699,"when":1793330000213},
 {"tag":"0814_ai_provider_change_gate","idx":700,"when":1793330000214},
 {"tag":"0815_assistant_learning_loop_scope","idx":701,"when":1793330000215},
 {"tag":"0816_ai_agent_action_pause","idx":702,"when":1793330000216},
 {"tag":"0817_automatic_chasers","idx":703,"when":1793330000217},
 {"tag":"0818_delegated_approvals","idx":704,"when":1793330000218},
 {"tag":"0819_automatic_followups","idx":705,"when":1793330000219},
 {"tag":"0820_template_feature_switch_owner","idx":706,"when":1793330000220},
 {"tag":"0821_delegated_leave_review_receipts","idx":707,"when":1793330000221},
 {"tag":"0822_assistant_qualification_maintenance","idx":708,"when":1793330000222},
 {"tag":"0823_assistant_employee_draft_activation","idx":709,"when":1793330000223},
 {"tag":"0824_assistant_compensation_maintenance","idx":710,"when":1793330000224},
 {"tag":"0825_assistant_emergency_contact_maintenance","idx":711,"when":1793330000225},
 {"tag":"0826_assistant_workforce_profile_maintenance","idx":712,"when":1793330000226},
 {"tag":"0827_assistant_family_maintenance","idx":713,"when":1793330000227},
 {"tag":"0828_assistant_bank_maintenance","idx":714,"when":1793330000228},
 {"tag":"0829_assistant_document_metadata","idx":715,"when":1793330000229},
 {"tag":"0830_assistant_employee_code_maintenance","idx":716,"when":1793330000230},
 {"tag":"0831_assistant_passport_maintenance","idx":717,"when":1793330000231},
 {"tag":"0832_assistant_payment_method_maintenance","idx":718,"when":1793330000232},
 {"tag":"0833_assistant_fixed_item_archive","idx":719,"when":1793330000233},
 {"tag":"0834_assistant_tp3_opening_maintenance","idx":720,"when":1793330000234},
 {"tag":"0835_assistant_cost_allocation_maintenance","idx":721,"when":1793330000235},
 {"tag":"0836_assistant_personnel_review_navigation","idx":722,"when":1793330000236},
 {"tag":"0837_assistant_attendance_schedule_group","idx":723,"when":1793330000237},
 {"tag":"0838_assistant_performance_goal_approval","idx":724,"when":1793330000238},
 {"tag":"0839_assistant_rewards_cancel_review","idx":725,"when":1793330000239},
 {"tag":"0840_assistant_personnel_profile_request_rejection","idx":726,"when":1793330000240},
 {"tag":"0841_assistant_position_archive_custody","idx":727,"when":1793330000241},
 {"tag":"0842_assistant_payroll_reopen_review","idx":728,"when":1793330000242},
 {"tag":"0843_assistant_lifecycle_offboarding_step_review","idx":729,"when":1793330000243},
 {"tag":"0844_assistant_performance_checkin_cancel","idx":730,"when":1793330000244},
 {"tag":"0845_assistant_attendance_day_schedule_correction","idx":731,"when":1793330000245},
 {"tag":"0846_native_ess_bank_direct_purpose","idx":732,"when":1793330000246},
 {"tag":"0847_assistant_performance_checkin_complete_custody","idx":733,"when":1793330000247},
 {"tag":"0848_assistant_rewards_cycle_calendar_review","idx":734,"when":1793330000248},
 {"tag":"0849_assistant_lifecycle_offboarding_step_undo","idx":735,"when":1793330000249},
 {"tag":"0850_assistant_department_archive_custody","idx":736,"when":1793330000250},
 {"tag":"0851_assistant_payroll_reset_review","idx":737,"when":1793330000251},
 {"tag":"0852_assistant_employee_id_template_status_custody","idx":738,"when":1793330000252},
 {"tag":"0853_onboarding_draft_discard_absence_context","idx":739,"when":1793330000253},
 {"tag":"0854_assistant_performance_checkin_schedule_custody","idx":740,"when":1793330000254},
 {"tag":"0855_assistant_rewards_annual_return_review","idx":741,"when":1793330000255},
 {"tag":"0856_assistant_lifecycle_offboarding_case_cancel","idx":742,"when":1793330000256},
 {"tag":"0857_assistant_performance_review_postimage_proof","idx":743,"when":1793330000257},
 {"tag":"0858_assistant_people_general_policy_custody","idx":744,"when":1793330000258},
 {"tag":"0859_assistant_employee_draft_discard_custody","idx":745,"when":1793330000259},
 {"tag":"0860_assistant_payroll_review_draft_delete_compatibility","idx":746,"when":1793330000260},
 {"tag":"0861_assistant_review_body_pending_parent","idx":747,"when":1793330000261},
 {"tag":"0863_assistant_bank_effect_closure","idx":748,"when":1793330000263},
 {"tag":"0864_assistant_catalogue_effect_closure","idx":749,"when":1793330000264},
] as const;
const PERFORMANCE=['performance.ai_360_enabled','performance.ai_tc_enabled','performance.ai_pm_enabled',
 'performance.ai_review_enabled','performance.ai_idp_enabled','performance.ai_calib_enabled'];
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');

// Exact reviewed80 additions after the historical568 prefix, independently traced to native ADD COLUMN
// declarations. Old NULL values remain original values; no runtime result supplies this expectation.
const ADDED_REVIEW_COLUMNS={
 "allocation_effective_company_id": "uuid",
 "allocation_effective_date": "date",
 "attendance_day_dependencies": "text",
 "attendance_day_proof_version": "integer",
 "attendance_group_after": "uuid",
 "attendance_group_before": "uuid",
 "attendance_group_proof_version": "integer",
 "attendance_group_unchanged": "text",
 "bank_after_hash": "text",
 "bank_audit_preimage": "jsonb",
 "bank_before_hash": "text",
 "bank_event_payload_hash": "text",
 "bank_event_scope_hash": "text",
 "bank_retained_prepare_hash": "text",
 "bank_retained_root_xid": "xid8",
 "bank_retained_version": "integer",
 "catalogue_audit_preimage": "jsonb",
 "catalogue_native_event": "uuid",
 "catalogue_native_phase": "text",
 "catalogue_native_root": "xid8",
 "catalogue_native_tid": "tid",
 "checkin_schedule_birth_hash": "text",
 "checkin_schedule_birth_xact": "text",
 "checkin_schedule_birth_xmin": "text",
 "checkin_schedule_date": "date",
 "checkin_schedule_manager_id": "uuid",
 "checkin_schedule_planned_id": "uuid",
 "checkin_schedule_result_id": "uuid",
 "day_schedule_date": "date",
 "department_archive_desired": "boolean",
 "draft_discard_capture_xid": "xid8",
 "draft_discard_delete_witness": "jsonb",
 "draft_discard_delete_xid": "xid8",
 "draft_discard_source": "jsonb",
 "draft_discard_source_ctid": "tid",
 "draft_discard_source_xmin": "text",
 "employee_id_template_desired_status": "text",
 "offboarding_cancel_case_version": "text",
 "offboarding_cancel_effect_commitment": "text",
 "offboarding_completion_event_id": "uuid",
 "offboarding_expect_completion": "boolean",
 "offboarding_step_case_version": "text",
 "offboarding_step_effect_commitment": "text",
 "offboarding_step_key": "text",
 "offboarding_step_version": "text",
 "offboarding_undo_case_event_id": "uuid",
 "offboarding_undo_expect_reopening": "boolean",
 "offboarding_undo_step_key": "text",
 "payroll_completion_root": "jsonb",
 "payroll_reopen_batch_id": "uuid",
 "payroll_reopen_period_id": "uuid",
 "payroll_reopen_person_ids": "uuid[]",
 "payroll_reopened_event_id": "uuid",
 "payroll_reset_batch_id": "uuid",
 "payroll_reset_event_id": "uuid",
 "payroll_reset_period_id": "uuid",
 "payroll_reset_person_ids": "uuid[]",
 "payroll_reset_proof": "jsonb",
 "people_general_after_email": "boolean",
 "people_general_after_nric": "boolean",
 "people_general_before_email": "boolean",
 "people_general_before_nric": "boolean",
 "people_general_before_revision": "uuid",
 "people_general_native_revision": "uuid",
 "performance_postimage_event_id": "uuid",
 "performance_postimage_mode": "text",
 "performance_postimage_notes": "text",
 "performance_postimage_root_xid": "xid8",
 "performance_postimage_unchanged": "text",
 "performance_postimage_version": "integer",
 "position_archive_desired": "boolean",
 "rewards_calendar_cycle_id": "uuid",
 "rewards_calendar_event_id": "uuid",
 "rewards_calendar_id": "uuid",
 "rewards_calendar_revision": "integer",
 "rewards_calendar_unit_id": "uuid",
 "rewards_return_commitment": "text",
 "rewards_return_completed_xid": "xid8",
 "rewards_return_decision_id": "uuid",
 "rewards_return_snapshot": "jsonb"
} as const;
function reviewRecords(value:unknown):Record<string,unknown>[] {
 expect(Array.isArray(value),'physical review row collection').toBe(true);
 if(!Array.isArray(value))throw Error('Expected physical review rows');
 return value.map(row=>{
  expect(row!==null&&typeof row==='object'&&!Array.isArray(row),'physical review record').toBe(true);
  if(row===null||typeof row!=='object'||Array.isArray(row))throw Error('Expected physical review record');
  return row as Record<string,unknown>;
 });
}

it('upgrades the exact observed populated Board prefix without rewriting applied history, payroll, settings or sealed reviews',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as Journal;
 const prefix=journal.entries.findIndex(entry=>entry.tag===TAIL[0].tag);
 expect(prefix).toBe(568);expect(witness.rows).toHaveLength(prefix);
 expect(witness.source).toBe('f752ac7f5d0323c5eae2280c3830af05b6da465f');
 expect(witness.buildId).toBe('Cvj9_lgd4fATCyUYRwWz_');expect(witness.observedAt).toBe('2026-10-29T21:09:26.134Z');
 expect(journal.entries[prefix-1]).toEqual({idx:682,version:'7',when:1793330000030,tag:'0698_information_only_corrections',breakpoints:true});
 expect(journal.entries.slice(prefix).map(({tag,idx,when})=>({tag,idx,when}))).toEqual(TAIL);
 // The canonical identity owner recognizes only the two retained historical SQL versions. It reads the
 // archived original bytes; this is not a checksum waiver or replacement of applied source.
 const expected:{tag:string;created_at:string;hash:string;sourceSha256?:string}[]=expectedMigrationLedger(process.cwd());
 expect(validateMigrationLedgerRows(expected.slice(0,prefix),witness.rows)).toEqual(witness.proof);
 expect(expected.slice(0,prefix).filter(row=>'sourceSha256' in row).map(row=>row.tag).sort()).toEqual(['0180_profile_option','0212_dashboard_card_config']);

 const name='ai_hr_ai_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'aihr-ai-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});let created=false;
 const tenantIds:string[]=[];
 const tables=['tenant','company','person','app_user','employment','compensation','pay_period','payroll_batch','payroll_input','payslip','domain_event','tenant_setting'] as const;
 const ledger=()=>storage.client`select m.id::text as id,m.hash,m.created_at::text as created_at from drizzle.__drizzle_migrations m order by m.id`;
 async function retainedRows(){
  const rows:Record<string,unknown>={};
  for(const table of tables){
   const predicate=table==='tenant'?'id=ANY($1::uuid[])':'tenant_id=ANY($1::uuid[])';
   rows[table]=await storage.client.unsafe(`select to_jsonb(t) as row from public.${table} t where ${predicate} order by to_jsonb(t)::text`,[tenantIds]);
  }
  rows.review=await storage.client`select * from app.assistant_own_leave_review order by id`;
  rows.content=await storage.client`select * from app.assistant_own_leave_review_content order by action_id`;
  return rows;
 }
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,prefix))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,prefix)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const replay=await ledger();expect(replay).toHaveLength(prefix);
  expect(replay.map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(journal.entries.slice(0,prefix).map(entry=>({hash:hash(readFileSync(`db/migrations/${entry.tag}.sql`)),created_at:String(entry.when)})));
  // ONLY this newly owned disposable fixture: restore the observed IDs/gaps and audited original
  // receipt hashes after native DDL replay. The installation and SQL bytes are never written.
  await storage.client`update drizzle.__drizzle_migrations set id=id+1000000`;
  for(let i=0;i<prefix;i++){
   const observed=witness.rows[i];
   await storage.client`update drizzle.__drizzle_migrations set id=${observed.id}::integer,hash=${observed.hash},created_at=${observed.created_at}::bigint where id=${Number(replay[i].id)+1000000}`;
  }
  await storage.client`select setval(pg_get_serial_sequence('drizzle.__drizzle_migrations','id'),(select max(id) from drizzle.__drizzle_migrations))`;
  expect(await ledger()).toEqual(witness.rows);

  for(let i=0;i<2;i++){
   const tenant=randomUUID(),company=randomUUID(),person=randomUUID(),user=randomUUID(),employment=randomUUID(),period=randomUUID(),batch=randomUUID(),event=randomUUID(),pending=randomUUID();
   tenantIds.push(tenant);
   await storage.client`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional AI upgrade tenant')`;
   await storage.client`insert into company(id,tenant_id,legal_name,country,currency) values(${company},${tenant},'Fictional preserved company','MY','MYR')`;
   await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenant},'Fictional reviewer',${randomUUID()+'@upgrade.invalid'})`;
   await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${tenant},${person},${randomUUID()})`;
   await storage.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${employment},${tenant},${person},${company},'2022-01-01')`;
   await storage.client`insert into compensation(tenant_id,employment_id,basic_salary,currency,valid_from) values(${tenant},${employment},5000,'MYR','2022-01-01')`;
   await storage.client`insert into pay_period(id,tenant_id,company_id,period,status) values(${period},${tenant},${company},'2023-01','closed')`;
   await storage.client`insert into payroll_batch(id,tenant_id,company_id,pay_period_id,pay_period,batch_date,status,employee_count,totals) values(${batch},${tenant},${company},${period},'2023-01','2023-01-31','closed',1,'{"gross":5000,"net":4500}'::jsonb)`;
   await storage.client`insert into payroll_input(tenant_id,batch_id,employment_id,overtime_amount,bonus_amount,tp1_deduction,zakat) values(${tenant},${batch},${employment},50,125.50,12.34,1.25)`;
   await storage.client`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,total_deductions,net_pay,employer_cost,statutory) values(${tenant},${batch},${employment},5000,5000,500,4500,5600,'{"epfEmployee":500,"epfEmployer":600}'::jsonb)`;
   await storage.client`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${event},${tenant},'fictional-upgrade',${randomUUID()},'fictional-upgrade.created','user',${user},'{"physicalWitness":true}'::jsonb)`;
   await storage.client`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,pay_component_id,pay_component_created_event_id,created_at,expires_at) values(${randomUUID()},'typed_pay_components.create',${tenant},${user},'completed',${randomUUID()},${event},now(),now()+interval '10 minutes')`;
   await storage.client`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,intent_digest,reviewed_digest,created_at,expires_at) values(${pending},'typed_pay_components.create',${tenant},${user},'awaiting_confirmation',${'a'.repeat(64)},${'b'.repeat(64)},now(),now()+interval '10 minutes')`;
   await storage.client`insert into app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext) values(${pending},${'c'.repeat(16)},'fictional opaque wrapped-key bytes','fictional opaque sealed-review bytes')`;
   // Opposite explicit stored choices must survive the new default-OFF definitions unchanged.
   await storage.client`insert into tenant_setting(tenant_id,key,value,source,updated_by) values(${tenant},'performance.ai_pm_enabled',${JSON.stringify(i===0)}::jsonb,'customer',${user})`;
  }
  const before=await retainedRows();for(const table of tables)expect(before[table],table).toHaveLength(2);expect(before.review).toHaveLength(4);expect(before.content).toHaveLength(2);
  const definitions=await storage.client`select * from setting_definition order by key`;
  const priorPerformance=definitions.filter(row=>PERFORMANCE.includes(String(row.key)));
  expect(priorPerformance).toHaveLength(6);
  for(const row of priorPerformance)expect(row).toMatchObject({default_value:true,default_on_install:true});
  const baseline=await ledger();
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  const retained=await retainedRows();
  expect(Object.keys(retained).sort()).toEqual(Object.keys(before).sort());
  // Every original non-review table and every opaque sealed-content byte stays exactly unchanged.
  for(const key of Object.keys(before))if(key!=='review')expect(retained[key],key+' exact physical preservation').toEqual(before[key]);
  const newKeys=Object.keys(ADDED_REVIEW_COLUMNS).sort();expect(newKeys).toHaveLength(80);
  const catalog=await storage.client<{name:string;type:string}[]>`
   select a.attname::text name,format_type(a.atttypid,a.atttypmod) type from pg_attribute a
   where a.attrelid='app.assistant_own_leave_review'::regclass and a.attnum>0 and not a.attisdropped
    and a.attname::text=any(${newKeys}::text[]) order by a.attname`;
  const sorted=(rows:readonly {name:string;type:string}[])=>[...rows].sort((a,b)=>a.name.localeCompare(b.name));
  expect(sorted(catalog)).toEqual(sorted(Object.entries(ADDED_REVIEW_COLUMNS).map(([name,type])=>({name,type}))));
  const oldReviews=reviewRecords(before.review),newReviews=reviewRecords(retained.review);
  expect(newReviews).toHaveLength(oldReviews.length);
  for(let index=0;index<oldReviews.length;index++){
   const oldRow=oldReviews[index],newRow=newReviews[index],oldKeys=Object.keys(oldRow).sort();
   expect(new Set([...oldKeys,...newKeys]).size,'dedicated keys are genuine additions').toBe(oldKeys.length+newKeys.length);
   expect(Object.keys(newRow).sort(),'exact original-plus-dedicated physical schema').toEqual([...oldKeys,...newKeys].sort());
   for(const key of newKeys){expect(oldRow,key+' absent in historical prefix').not.toHaveProperty(key);expect(newRow[key],key+' independently declared NULL addition').toBeNull();}
   // Preserve ALL original values, including original NULLs; never strip NULLs or ignore old keys.
   expect(Object.fromEntries(oldKeys.map(key=>[key,newRow[key]])),'every original review value').toEqual(oldRow);
  }
  const after=await ledger();expect(after).toHaveLength(635);expect(after.slice(0,prefix)).toEqual(baseline);
  expect(after.slice(prefix).map(({hash,created_at})=>({hash,created_at}))).toEqual(TAIL.map(({tag,when})=>({hash:hashFile(tag),created_at:String(when)})));
  const changedDefinitions=await storage.client`select * from setting_definition order by key`;
  expect(definitions.some(row=>row.key==='feedback.menu_enabled')).toBe(false);
  expect(changedDefinitions.filter(row=>row.key!=='feedback.menu_enabled')).toEqual(definitions.map(row=>PERFORMANCE.includes(String(row.key))?{...row,default_value:false,default_on_install:false}:row));
  const feedback=changedDefinitions.filter(row=>row.key==='feedback.menu_enabled');expect(feedback).toHaveLength(1);
  expect(feedback[0]).toMatchObject({key:'feedback.menu_enabled',module_code:null,scope:'platform',value_type:'boolean',default_value:true,default_on_install:null,customer_visible:false,sort_order:111});
  expect(changedDefinitions).toHaveLength(definitions.length+1);
  expect(changedDefinitions.filter(row=>PERFORMANCE.includes(String(row.key)))).toHaveLength(6);
  const constraints=await storage.client`select conname,convalidated from pg_constraint where conname in ('assistant_review_action_kind_registered','ai_native_outcome_association_action_registered') order by conname`;
  expect(constraints).toEqual([{conname:'ai_native_outcome_association_action_registered',convalidated:true},{conname:'assistant_review_action_kind_registered',convalidated:true}]);
  const [kinds]=await storage.client`select count(*)::int as n from app.assistant_action_kind`;expect(kinds.n).toBe(AGENT_ACTIONS.length);
  expect(await storage.client`select action_id from app.ai_agent_action_pause`).toEqual([]);
  const [switches]=await storage.client`select count(*)::int as n from app.ai_feature_setting`;expect(switches.n).toBe(15);
  // Ordinary replay is idempotent; it neither re-applies the tail nor rewrites retained rows.
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await ledger()).toEqual(after);expect(await retainedRows()).toEqual(retained);
 }finally{
  await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},300_000);
function hashFile(tag:string){return hash(readFileSync(`db/migrations/${tag}.sql`));}
