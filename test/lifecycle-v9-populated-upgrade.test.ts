/** Ordinary journal rehearsal against an owned populated pre-V9 database. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';

it('preserves populated Native issuance, private data, identity and every applied receipt through the ordinary V9 upgrade',async()=>{
 const journalBytes=readFileSync('db/migrations/meta/_journal.json');
 const journal=JSON.parse(journalBytes.toString());
 const boundary=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='0713_lifecycle_v9');
 expect(boundary).toBe(571);
 expect(journal.entries).toHaveLength(636);
 expect(journal.entries.slice(boundary,579)).toHaveLength(8);
 expect(journal.entries.slice(boundary)).toHaveLength(65);
 const migrationIdentity=(entry:{idx:number;version:string;when:number;tag:string;breakpoints:boolean})=>({...entry,hash:createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex')});
 // The accepted V9 prefix and coordinated Feedback/Bank identities are immutable; the two coordinated Formula appends follow.
 expect(createHash('sha256').update(JSON.stringify(journal.entries.slice(0,579).map(migrationIdentity))).digest('hex')).toBe('11e5295ce4e60acb1f13c009a78098b043c862b6412ed2bbc2e102f142a87f85');
 expect(journal.entries.slice(579,583).map(migrationIdentity)).toEqual([
  {idx:694,version:'7',when:1793330000065,tag:'0728_feedback_release_evidence',breakpoints:true,hash:'d0914e5ec06a1f78b5e081164ab46330f37c29c8c3b2d0d6c592b205cee374c7'},
  {idx:695,version:'7',when:1793330000075,tag:'0691_bank_import_point_read',breakpoints:true,hash:'be6f8d38850fadd9151d58ea7476d8f60e09a0bf2b2b078e0196f4cb90c5bfe9'},
  {idx:696,version:'7',when:1793330000200,tag:'0800_pay_formula_builder',breakpoints:true,hash:'f8ba2919eb59346bc86453667cc7952a5671db88b740fcab3c41b4530802c322'},
  {idx:697,version:'7',when:1793330000211,tag:'0811_pay_formula_company_retention',breakpoints:true,hash:'b3bea8f1c646e0989ac1cf161cc4950e4956439693961c2d8c00aba1c21aae5b'},
 ]);
 // Independently frozen b813 appended identities; never derive this expectation from the live journal.
 expect(journal.entries.slice(583).map(migrationIdentity)).toEqual([
  {
    "idx": 698,
    "version": "7",
    "when": 1793330000212,
    "tag": "0812_ai_feature_switch_owner",
    "breakpoints": true,
    "hash": "6fefed6eef2105dfc19a818a5c387dfbea10de014a732c1839d5921db02da78f"
  },
  {
    "idx": 699,
    "version": "7",
    "when": 1793330000213,
    "tag": "0813_assistant_action_kind",
    "breakpoints": true,
    "hash": "65b9aeb05a6980f6af46452307514af536da48df95b50d34d5cae0607cd21b8c"
  },
  {
    "idx": 700,
    "version": "7",
    "when": 1793330000214,
    "tag": "0814_ai_provider_change_gate",
    "breakpoints": true,
    "hash": "acd288d90f61190327a327defd4671cea63f255f307a6ac73bee93b20c717441"
  },
  {
    "idx": 701,
    "version": "7",
    "when": 1793330000215,
    "tag": "0815_assistant_learning_loop_scope",
    "breakpoints": true,
    "hash": "07da7779b5e3fe1fa6165c53827a478e15443f9fdd5928b209121db5d53ba4f1"
  },
  {
    "idx": 702,
    "version": "7",
    "when": 1793330000216,
    "tag": "0816_ai_agent_action_pause",
    "breakpoints": true,
    "hash": "65865529b3d79342e6091437f0b99b92fdcb8e2e96f096a929c34b11bad54913"
  },
  {
    "idx": 703,
    "version": "7",
    "when": 1793330000217,
    "tag": "0817_automatic_chasers",
    "breakpoints": true,
    "hash": "d8293d81627932b19028854328eab8d734b1eeca756a411f1aca438813d0f65a"
  },
  {
    "idx": 704,
    "version": "7",
    "when": 1793330000218,
    "tag": "0818_delegated_approvals",
    "breakpoints": true,
    "hash": "11e6111da5fc22c1163004b995f7d0ec7a45126504b8939e3d1ddc3b45587732"
  },
  {
    "idx": 705,
    "version": "7",
    "when": 1793330000219,
    "tag": "0819_automatic_followups",
    "breakpoints": true,
    "hash": "4759e4b988988220a0374ce0db644b4182b0005e3fe9b4e09cfe27f52e5b183c"
  },
  {
    "idx": 706,
    "version": "7",
    "when": 1793330000220,
    "tag": "0820_template_feature_switch_owner",
    "breakpoints": true,
    "hash": "b351155710806e9e78656ed172ebb8ca2135284fe55298b38ed75f3679809d8b"
  },
  {
    "idx": 707,
    "version": "7",
    "when": 1793330000221,
    "tag": "0821_delegated_leave_review_receipts",
    "breakpoints": true,
    "hash": "f3c8b4704c1100bc2449b753b470605826e01687a16ac1223dc8115f5b3b25b9"
  },
  {
    "idx": 708,
    "version": "7",
    "when": 1793330000222,
    "tag": "0822_assistant_qualification_maintenance",
    "breakpoints": true,
    "hash": "906bca2ef99251482151e08bed27ef42a567c699f5755f864f03728c58a80f19"
  },
  {
    "idx": 709,
    "version": "7",
    "when": 1793330000223,
    "tag": "0823_assistant_employee_draft_activation",
    "breakpoints": true,
    "hash": "e46d788f134c28621efb57cb35f44b234b2dc53de0a59cb83651bf5d9899e826"
  },
  {
    "idx": 710,
    "version": "7",
    "when": 1793330000224,
    "tag": "0824_assistant_compensation_maintenance",
    "breakpoints": true,
    "hash": "ec92c35942918a28a4c9e4f9c03d00cf9c752692be9d7c7de449dd6d75c4883c"
  },
  {
    "idx": 711,
    "version": "7",
    "when": 1793330000225,
    "tag": "0825_assistant_emergency_contact_maintenance",
    "breakpoints": true,
    "hash": "c13f92b5fc020eb98a865a8e6f9b349d20893250100f28a0816e7e23afe0d3a2"
  },
  {
    "idx": 712,
    "version": "7",
    "when": 1793330000226,
    "tag": "0826_assistant_workforce_profile_maintenance",
    "breakpoints": true,
    "hash": "1a4d732e908dc7d25a94e93c4fd7be7efc29d73b3e83fdfdf3557d9c8bb2eead"
  },
  {
    "idx": 713,
    "version": "7",
    "when": 1793330000227,
    "tag": "0827_assistant_family_maintenance",
    "breakpoints": true,
    "hash": "b669a1e4ba6b961d5454e2ac0cbfcb25369d4e16399ef6123ce2c1f332340e80"
  },
  {
    "idx": 714,
    "version": "7",
    "when": 1793330000228,
    "tag": "0828_assistant_bank_maintenance",
    "breakpoints": true,
    "hash": "13707bcf9ea2053d1546014ab19d022a9ce1a4121855ac18095d78ca60fda460"
  },
  {
    "idx": 715,
    "version": "7",
    "when": 1793330000229,
    "tag": "0829_assistant_document_metadata",
    "breakpoints": true,
    "hash": "5a531ad04016b0e6ae55b381d77cb2bd4870c85fd747d2b37dd70ba6a0268688"
  },
  {
    "idx": 716,
    "version": "7",
    "when": 1793330000230,
    "tag": "0830_assistant_employee_code_maintenance",
    "breakpoints": true,
    "hash": "757986c7421891e9a07e78bef9635deb62bc13376c07184f5c5519c9a12262e9"
  },
  {
    "idx": 717,
    "version": "7",
    "when": 1793330000231,
    "tag": "0831_assistant_passport_maintenance",
    "breakpoints": true,
    "hash": "8c463f9da529241bd35606ea39baa93d4a38f32a19a687130dad737f64041699"
  },
  {
    "idx": 718,
    "version": "7",
    "when": 1793330000232,
    "tag": "0832_assistant_payment_method_maintenance",
    "breakpoints": true,
    "hash": "091f5e6f0e52cb384395ba5e2fe67569dd721955d21a0854f34d2a5dda56efe9"
  },
  {
    "idx": 719,
    "version": "7",
    "when": 1793330000233,
    "tag": "0833_assistant_fixed_item_archive",
    "breakpoints": true,
    "hash": "f82508e59af919152f540d610d08bb20558245e2f6505accd6730b241c4aeb5b"
  },
  {
    "idx": 720,
    "version": "7",
    "when": 1793330000234,
    "tag": "0834_assistant_tp3_opening_maintenance",
    "breakpoints": true,
    "hash": "d53e11421976cc6d4964ad9d47c1830110cee136941b6efba9e31530c1718a5e"
  },
  {
    "idx": 721,
    "version": "7",
    "when": 1793330000235,
    "tag": "0835_assistant_cost_allocation_maintenance",
    "breakpoints": true,
    "hash": "47a8ee2c78d43964d5ef82b781c39dcf0dde1e1d6ff596ae74e8248bd717495f"
  },
  {
    "idx": 722,
    "version": "7",
    "when": 1793330000236,
    "tag": "0836_assistant_personnel_review_navigation",
    "breakpoints": true,
    "hash": "40561946d2d0d7a626ff0063d34b61285508045ace02d24019c4ac54508d1472"
  },
  {
    "idx": 723,
    "version": "7",
    "when": 1793330000237,
    "tag": "0837_assistant_attendance_schedule_group",
    "breakpoints": true,
    "hash": "2271e18c5ae12f14c47dd5236c47355206012cb979b30c90535355a93251360e"
  },
  {
    "idx": 724,
    "version": "7",
    "when": 1793330000238,
    "tag": "0838_assistant_performance_goal_approval",
    "breakpoints": true,
    "hash": "d3571cf1135674076938bf58acf0994f68a5b3dfa37e8d1dea977a8550e08ee7"
  },
  {
    "idx": 725,
    "version": "7",
    "when": 1793330000239,
    "tag": "0839_assistant_rewards_cancel_review",
    "breakpoints": true,
    "hash": "594e07a5ba75ef8f7ddd947d42d1514fdb5b6bc203e4bb54255b7bbe28d1302f"
  },
  {
    "idx": 726,
    "version": "7",
    "when": 1793330000240,
    "tag": "0840_assistant_personnel_profile_request_rejection",
    "breakpoints": true,
    "hash": "0f8f87f262f4d5571597fc5245793179a0c184f3767bcc8ffd7b6d464a7c8b72"
  },
  {
    "idx": 727,
    "version": "7",
    "when": 1793330000241,
    "tag": "0841_assistant_position_archive_custody",
    "breakpoints": true,
    "hash": "9a4699b6cf6f86b5f9a8456d2f2084ddf03f9b1c81320ec821126d23a9605eeb"
  },
  {
    "idx": 728,
    "version": "7",
    "when": 1793330000242,
    "tag": "0842_assistant_payroll_reopen_review",
    "breakpoints": true,
    "hash": "3e751a258147a2e2d9b51680dad3ff21ef4b6b2b7072aa750d9666849c62f97c"
  },
  {
    "idx": 729,
    "version": "7",
    "when": 1793330000243,
    "tag": "0843_assistant_lifecycle_offboarding_step_review",
    "breakpoints": true,
    "hash": "bfe24dd05e8ff105e2a57e510b19ff5faf82e4f3d7400a6c647b5bb92c149c6d"
  },
  {
    "idx": 730,
    "version": "7",
    "when": 1793330000244,
    "tag": "0844_assistant_performance_checkin_cancel",
    "breakpoints": true,
    "hash": "b616b9edbb686c02393161817adf5b1967386b97b92a7cb67e384e7d4e0092c4"
  },
  {
    "idx": 731,
    "version": "7",
    "when": 1793330000245,
    "tag": "0845_assistant_attendance_day_schedule_correction",
    "breakpoints": true,
    "hash": "77256b705e285074caadef4f96f71f19abe7d3ef86b087ff0a0b90724213d28a"
  },
  {
    "idx": 732,
    "version": "7",
    "when": 1793330000246,
    "tag": "0846_native_ess_bank_direct_purpose",
    "breakpoints": true,
    "hash": "631d8f924100dc9988c6fcf219bf57eb72e724503ea4229878b4295b764951c0"
  },
  {
    "idx": 733,
    "version": "7",
    "when": 1793330000247,
    "tag": "0847_assistant_performance_checkin_complete_custody",
    "breakpoints": true,
    "hash": "a14f106c59baf5363dc632c38777b4c596f9ec062d6b9450c2b640548674b9d5"
  },
  {
    "idx": 734,
    "version": "7",
    "when": 1793330000248,
    "tag": "0848_assistant_rewards_cycle_calendar_review",
    "breakpoints": true,
    "hash": "102c9133cc513ddd0faed0df63c147304da5e98cba58b5d762f0c7c311d5c4ad"
  },
  {
    "idx": 735,
    "version": "7",
    "when": 1793330000249,
    "tag": "0849_assistant_lifecycle_offboarding_step_undo",
    "breakpoints": true,
    "hash": "5b18e6eebcdd7ec72b1a10815fd30130df18719487b8426767d68efa09e5f0d9"
  },
  {
    "idx": 736,
    "version": "7",
    "when": 1793330000250,
    "tag": "0850_assistant_department_archive_custody",
    "breakpoints": true,
    "hash": "eb1772c9befd38eeb4839555711059ad5783ac4cfa37696ac2959b2f5e1efed9"
  },
  {
    "idx": 737,
    "version": "7",
    "when": 1793330000251,
    "tag": "0851_assistant_payroll_reset_review",
    "breakpoints": true,
    "hash": "1ce75d6d82d06cd6273a103199c28c2cfb5e9ba0912181165d352dd3afe645b4"
  },
  {
    "idx": 738,
    "version": "7",
    "when": 1793330000252,
    "tag": "0852_assistant_employee_id_template_status_custody",
    "breakpoints": true,
    "hash": "311ca601a3f16747a736bd2f4038ef628640be3d68e00565c29071477e7d5764"
  },
  {
    "idx": 739,
    "version": "7",
    "when": 1793330000253,
    "tag": "0853_onboarding_draft_discard_absence_context",
    "breakpoints": true,
    "hash": "4ec70b3fdcf63810ba4f7f75d6758e589da1b124bf0503d307795e95175b26e2"
  },
  {
    "idx": 740,
    "version": "7",
    "when": 1793330000254,
    "tag": "0854_assistant_performance_checkin_schedule_custody",
    "breakpoints": true,
    "hash": "d22ed559566f8fe09103b8672b972f74afa7d513d18908659478c1a81423b7f6"
  },
  {
    "idx": 741,
    "version": "7",
    "when": 1793330000255,
    "tag": "0855_assistant_rewards_annual_return_review",
    "breakpoints": true,
    "hash": "b7fc76e3c456a392123ad9e8c4353ad9184a61c93d4e68f5ad8e7cf0c2dce3d9"
  },
  {
    "idx": 742,
    "version": "7",
    "when": 1793330000256,
    "tag": "0856_assistant_lifecycle_offboarding_case_cancel",
    "breakpoints": true,
    "hash": "fec51befd4613d79614caa8a703e5c4c8ea0485e3bd26df18341cd0fc56a0ac2"
  },
  {
    "idx": 743,
    "version": "7",
    "when": 1793330000257,
    "tag": "0857_assistant_performance_review_postimage_proof",
    "breakpoints": true,
    "hash": "dc22028f693116a7f3296185be508f4c7007b1a4819768e248cf51b345bd898a"
  },
  {
    "idx": 744,
    "version": "7",
    "when": 1793330000258,
    "tag": "0858_assistant_people_general_policy_custody",
    "breakpoints": true,
    "hash": "6ed6aab3149e0766d977b9f4ed54e2aac46e554bbcf0781d264aae7cd4049093"
  },
  {
    "idx": 745,
    "version": "7",
    "when": 1793330000259,
    "tag": "0859_assistant_employee_draft_discard_custody",
    "breakpoints": true,
    "hash": "dc873a3e08400580a6003bcfd43563b3f4c1832a27fa4c46cf722d9a825d2c8e"
  },
  {
    "idx": 746,
    "version": "7",
    "when": 1793330000260,
    "tag": "0860_assistant_payroll_review_draft_delete_compatibility",
    "breakpoints": true,
    "hash": "a5cddfed9be058b6542c91815efe2ad00bbdab9a022e6a63ab67046399b9ebe8"
  },
  {
    "idx": 747,
    "version": "7",
    "when": 1793330000261,
    "tag": "0861_assistant_review_body_pending_parent",
    "breakpoints": true,
    "hash": "198d51c106d1775cbed0c937ee53dc3c46375342ad6ac280a9e28f510d373d79"
  },
  {
    "idx": 748,
    "version": "7",
    "when": 1793330000263,
    "tag": "0863_assistant_bank_effect_closure",
    "breakpoints": true,
    "hash": "8381b76568d5910b791df7a1cb73d2939467f5709a12c11f5f5ddd01d727f264"
  },
  {
    "idx": 749,
    "version": "7",
    "when": 1793330000264,
    "tag": "0864_assistant_catalogue_effect_closure",
    "breakpoints": true,
    "hash": "09421f02fbe27b231395acd36cd4bab6d3e9a6943705cee73741851adef9efb3"
  },
  {
    "idx": 750,
    "version": "7",
    "when": 1793330000265,
    "tag": "0865_assistant_company_retention_references",
    "breakpoints": true,
    "hash": "088acfed2e8aba43deb012e0baed2d4d88765d115afd19a858ebee53e12141cd"
  }
]);
 const directory=mkdtempSync(join(tmpdir(),'v9-ordinary-upgrade-')),name='ai_hr_v9_upgrade_'+randomUUID().replaceAll('-','');
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});let created=false;
 const tenant=randomUUID(),company=randomUUID(),person=randomUUID(),user=randomUUID(),employment=randomUUID(),caseId=randomUUID();
 const native={version:1,id:caseId,number:'OB-UPGRADE-0001',state:'submitted',source:{fullName:'Fictional upgrade employee',company,joinDate:'2026-01-01'},tasks:[{id:'historic-task',status:'done'}],requisitions:[{id:'historic-request',handedAt:'2026-01-01T01:00:00Z',items:[{id:'historic-device',name:'Fictional issued device',state:'handed',employeeReceipt:{status:'received',by:user,at:'2026-01-01T02:00:00Z',note:'Retain this receipt'}}]}],history:[{id:'historic-handover',action:'requisition.handed',by:user}]};
 const tables=['person','app_user','role_assignment','employment','lc_onboarding_config','lc_onboarding_case','lc_onboarding_private','lc_onboarding_case_revision','lc_onboarding_note','domain_event'];
 async function original(){const rows:Record<string,unknown>={};for(const table of tables)rows[table]=await storage.client.unsafe(`select to_jsonb(t) as row from public.${table} t where tenant_id=$1 order by to_jsonb(t)::text`,[tenant]);return rows;}
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries)copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(storage.db,{migrationsFolder:directory});
  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional V9 upgrade')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${company},${tenant},'Fictional employer')`;
  await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenant},'Fictional upgrade employee','v9-upgrade@example.invalid')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${tenant},${person},${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant},${user},'hr_admin')`;
  await storage.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on) values(${employment},${tenant},${person},${company},'V9-UPGRADE-001','2026-01-01')`;
  await storage.client`insert into lc_onboarding_config(tenant_id,data) values(${tenant},${JSON.stringify({version:1,groups:[{id:'historic-team',name:'Fictional issuing team',members:[user],limit:8}],access:{onboarding:[user],offboarding:[]}})}::jsonb)`;
  await storage.client`insert into lc_onboarding_case(id,tenant_id,company_id,employment_id,data) values(${caseId},${tenant},${company},${employment},${JSON.stringify(native)}::jsonb)`;
  await storage.client`insert into lc_onboarding_private(case_id,tenant_id,company_id,data) values(${caseId},${tenant},${company},${JSON.stringify({source:{ic:'FICTIONAL-PRIVATE-ID'},local:{},retained:'original private data'})}::jsonb)`;
  await storage.client`insert into lc_onboarding_case_revision(case_id,tenant_id,company_id,revision,data) values(${caseId},${tenant},${company},1,${JSON.stringify(native)}::jsonb)`;
  await storage.client`insert into lc_onboarding_note(tenant_id,case_id,data) values(${tenant},${caseId},${JSON.stringify({context:'case',body:'Retain original note',by:user,mentions:[],deleted:false})}::jsonb)`;
  const before=await original(),prefix=await ledger();expect(prefix).toHaveLength(boundary);
  // Ordinary journal prefixes expose the exact before/after of each Lifecycle CHECK extension.
  // No applied SQL is rewritten; final migration and the idempotence pass still use the real folder.
  const checks=()=>storage.client<{name:string;oid:string;validated:boolean;expressionHash:string}[]>`select conname as name,oid::text as oid,convalidated as validated,encode(sha256(convert_to(conbin::text,'UTF8')),'hex') as "expressionHash" from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and contype='c' order by conname`;
  const migrateThrough=async(length:number)=>{
   writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,length)}));
   await migrate(storage.db,{migrationsFolder:directory});
  };
  const changed=['assistant_own_leave_review_check','assistant_own_leave_review_check16','assistant_review_kind_columns'];
  const checkpoints=[
   {index:614,tag:'0843_assistant_lifecycle_offboarding_step_review',added:['assistant_offboarding_step_columns','assistant_step_effect_columns']},
   {index:620,tag:'0849_assistant_lifecycle_offboarding_step_undo',added:['assistant_offboarding_step_undo_columns']},
  ];
  for(const checkpoint of checkpoints){
   expect(journal.entries[checkpoint.index].tag).toBe(checkpoint.tag);
   await migrateThrough(checkpoint.index);
   const prior=Array.from(await checks());expect(prior.length).toBeGreaterThan(changed.length);
   expect(prior.filter(row=>changed.includes(row.name)).map(row=>row.name)).toEqual([...changed].sort());
   const receiptBefore=await ledger();expect(receiptBefore).toHaveLength(checkpoint.index);
   await migrateThrough(checkpoint.index+1);
   const next=Array.from(await checks());
   expect(next.map(row=>row.name)).toEqual([...prior.map(row=>row.name),...checkpoint.added].sort());
   // All unrelated guards retain actual OID, raw expression SHA256 and validation state.
   expect(next.filter(row=>!changed.includes(row.name)&&!checkpoint.added.includes(row.name))).toEqual(prior.filter(row=>!changed.includes(row.name)));
   for(const name of changed){const old=prior.find(row=>row.name===name)!,current=next.find(row=>row.name===name)!;expect(current.validated,name).toBe(true);expect(current.expressionHash,name).not.toBe(old.expressionHash);}
   for(const name of checkpoint.added)expect(next.find(row=>row.name===name)?.validated,name).toBe(true);
   const receiptAfter=await ledger();expect(receiptAfter).toHaveLength(checkpoint.index+1);expect(receiptAfter.slice(0,checkpoint.index)).toEqual(receiptBefore);
   expect(receiptAfter.at(-1)).toMatchObject({hash:migrationIdentity(journal.entries[checkpoint.index]).hash,created_at:String(journal.entries[checkpoint.index].when)});
   expect(await original()).toEqual(before);
  }
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await original()).toEqual(before);
  const after=await ledger();expect(after.slice(0,boundary)).toEqual(prefix);expect(after).toHaveLength(journal.entries.length);
  expect(after.slice(boundary).map(row=>({hash:row.hash,when:row.created_at}))).toEqual(journal.entries.slice(boundary).map((entry:{tag:string;when:number})=>({hash:createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),when:String(entry.when)})));
  expect(await storage.client`select count(*)::int as count from lc_v9_case`).toEqual([{count:0}]);
  expect(await storage.client`select to_regnamespace('v9_test_fixture') as fixture,has_function_privilege('ai_hr_app','app.lc_v9_assigned_item(uuid,integer,text)','EXECUTE') as assigned`).toEqual([{fixture:null,assigned:true}]);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});expect(await ledger()).toEqual(after);expect(await original()).toEqual(before);
 }finally{await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});}
},180000);
