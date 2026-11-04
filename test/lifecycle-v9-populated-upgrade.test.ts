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
 // The tax/movement release (1 Nov 2026) appends exactly 0873/0874; the ordinary upgrade below applies them too.
 expect(journal.entries).toHaveLength(675); // Accepted 650-entry LOGIN baseline plus the six Re-plan successors, the four AI v2 Phase 1 migrations 2000-2003 and the seven AI v2 Phase 2 migrations 2004-2010, the Phase 2 hardening migration 2011 and the ADR-0174 tenant-isolation hardening 2100-2102 and 2120-2123 below.
 expect(journal.entries.slice(boundary,579)).toHaveLength(8);
 expect(journal.entries.slice(boundary)).toHaveLength(104);
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
 expect(journal.entries.slice(636).map(migrationIdentity)).toEqual([
  {idx:751,version:'7',when:1793330000273,tag:'0873_movement_exit_payroll_preservation',breakpoints:true,hash:'39b6020262382d7c68dab60135837b6fc8b132f6b94afecd3892ba87cdbad440'},
  {idx:752,version:'7',when:1793330000274,tag:'0874_payroll_tax_basis_corrections',breakpoints:true,hash:'9177fcd20fa1706ccc8077f50083270b9f03acb126b729e6af725082ed5d5745'},
  {idx:753,version:'7',when:1793330000275,tag:'0875_reward_access_request_read_role',breakpoints:true,hash:'06190afbe171fffa7baa1c27b6fc6417499c50f1e8a7ec9a702a536e5acb41a1'},
  {idx:754,version:'7',when:1793330000276,tag:'0876_epf_manual_percentage_zero',breakpoints:true,hash:'e09b59c1b79628d8701bee3864ac2421bdbd1b7e4162a696dbc273e97fdca430'},
  {idx:755,version:'7',when:1793330000298,tag:'0898_session_idle_timeout',breakpoints:true,hash:'0f7204555b6aad9819a43e9a00b04530593e1d137afa7941603ac02e8ecc8729'},
  {idx:756,version:'7',when:1793330000299,tag:'0899_entra_workforce',breakpoints:true,hash:'c70afe9dac5c37ebd471230df02f9d824184affc5db50ab7d8c6163c0adf842b'},
  // Teras source claims (claude/teras-review-fixes), frozen here.
  {idx:757,version:'7',when:1793330000324,tag:'0924_teras_outcome_record_mandates',breakpoints:true,hash:'f60531e8dcc633857fc5bb18f7cf886a75b1767374956e30a2b49d6a962627c4'},
  {idx:758,version:'7',when:1793330000325,tag:'0925_teras_rule_version_labels',breakpoints:true,hash:'2d779ba3d268fcc68a1cf2e2d1ffde50e72ade996daa02ff4ec4e345203d531b'},
  {idx:759,version:'7',when:1793330000326,tag:'0926_teras_worker_registry',breakpoints:true,hash:'60108e148ce2f7c0c178d4a678217a565c2f2d0f1b6988752ffc61f1f1d3c259'},
  {idx:760,version:'7',when:1793330000327,tag:'0927_teras_conversation_switch',breakpoints:true,hash:'ac5475982a99c2b387bc5f34e9af6f69cb5bbe3aac156bdd8aa906e17579c968'},
  {idx:761,version:'7',when:1793330000328,tag:'0928_teras_outcome_private_turns',breakpoints:true,hash:'17a50608b153559bfa06cf49f2b2efb526c85f2cbf0ce1de16a78fa4a0df8fa9'},
  {idx:762,version:'7',when:1793330000329,tag:'0929_teras_review_services',breakpoints:true,hash:'765ca87aebc30ae1aaf46ec4eb8cfb3d36466f1401dcbe2bbe092fec60358bc0'},
  // Nine-item BOARD successors; the accepted Noveri SQL and prior journal identities above stay unchanged.
  {idx:763,version:'7',when:1793330000335,tag:'0935_password_account_unlock',breakpoints:true,hash:'3933f36ffe4ea3d4c0d47a2e0c27f6cf514dc8ba48942af7e241c60e829bafaa'},
  {idx:793,version:'7',when:1793330000346,tag:'0946_draft_creation_cohort_custody',breakpoints:true,hash:'cf06975c936963a98af73b2c602a32d599557a5791f461794564c03af066d390'},
  {idx:794,version:'7',when:1793330000347,tag:'0947_rewards_access_approval_exemptions',breakpoints:true,hash:'f7a1e3725019d8ce09052efb3b3fe1763190622052b4f826a678f8231cf8914e'},
  {idx:795,version:'7',when:1793330000348,tag:'0948_document_signing',breakpoints:true,hash:'07ab24b5dcd85f16ba3474fe7fdd7b620d9603ee882dc8b8abc22e18b21533ea'},
  {idx:796,version:'7',when:1793330000349,tag:'0949_probation_confirmation',breakpoints:true,hash:'53978af9d391beb2683c47902413bbf4a61e11c4f013cdb3211f80c49aff42ab'},
  {idx:797,version:'7',when:1793330000350,tag:'0950_contract_management',breakpoints:true,hash:'84bc3e3a907118e2c6806e863c63544df061b49dbb9b51fcd4fe8f85ffcef8ac'},
  {idx:798,version:'7',when:1793330000351,tag:'0951_payroll_reprocess_correction_lineage',breakpoints:true,hash:'b65a8adc2f45165fb2bdb41b30d4ca6eeb7f7b44ef2539bcdecc7efde0322057'},
  {idx:799,version:'7',when:1793330000353,tag:'0953_lifecycle_service_info_intents',breakpoints:true,hash:'6f71e2fe862f86c836026f3e07647ca29b913dd34b2171c98a033b43da0afa89'},
  // AI v2 Phase 1, renumbered into the AI Centre block 2000-2019 at the release integration (were 0952, 0959, 0960, 0961).
  // AI Centre stored chats (claude/noveri-chats), frozen here.
  {idx:800,version:'7',when:1793330001400,tag:'2000_teras_chats',breakpoints:true,hash:'8cd50320de942af9aa59e515c5e39e78f6027325da86264dd8e772bff1c802b7'},
  // AI v2 W11 protected case route (claude/aiv2-s2-case-route), frozen here.
  {idx:801,version:'7',when:1793330001401,tag:'2001_private_cases',breakpoints:true,hash:'bcfb193a8f6e59c7fec485291bf94cf460f89f44d5abc5bb9ef80cdb6f802acc'},
  // AI v2 W8 loops at the Prepare level (claude/aiv2-s3-loops), frozen here.
  {idx:802,version:'7',when:1793330001402,tag:'2002_teras_loops',breakpoints:true,hash:'9614f0d8aa6855d24fe0b7ee1e75c46f80f89e19ec43161825e4bf357eefb908'},
  // AI v2 Phase 1 slice 3 employee letter requests (claude/aiv2-s3-letter-request), frozen here.
  {idx:803,version:'7',when:1793330001403,tag:'2003_letter_requests',breakpoints:true,hash:'86648ce2dc7af62b92091a5ec195877c68a511f6272dd9681781cedf85900041'},
  // AI v2 Phase 2, renumbered into the AI Centre block 2000-2019 at the Phase 2 integration (were 0963-0967, 0971, 0972).
  // AI v2 Phase 2 P2-1 autonomy ladder (claude/aiv2-p2-autonomy-ladder), frozen here.
  {idx:804,version:'7',when:1793330001404,tag:'2004_teras_loop_autonomy',breakpoints:true,hash:'b6bdeac1995dad6df759ce9a537c98e9a3666bf01aef716a7f6cac9a9134b132'},
  // AI v2 Phase 2 P2-2a payroll-cycle loops (claude/aiv2-p2-payroll-loops), frozen here.
  {idx:805,version:'7',when:1793330001405,tag:'2005_teras_payroll_cycle_loops',breakpoints:true,hash:'d211dd97ebdeb673998d29a2a9b3b8d8597c39a5646259ac0c855d46eca49fbc'},
  // AI v2 Phase 2 P2-2b Audit loop (claude/aiv2-p2-audit-loop), frozen here.
  {idx:806,version:'7',when:1793330001406,tag:'2006_payroll_audit_loop',breakpoints:true,hash:'05bc9e35367093ae4c6aec877a7ca7ec171387cb84b28940e0db0e190fcf7723'},
  // AI v2 Phase 2 P2-4 HR capacity baseline (claude/aiv2-p2-capacity-ledger), frozen here.
  {idx:807,version:'7',when:1793330001407,tag:'2007_teras_capacity_baseline',breakpoints:true,hash:'8b2bb6e38d76c7bf6643e45c62c11ed89e71d954615438d527adf1b4593f22ad'},
  // AI v2 Phase 2 P2-3 own payroll cut-off (claude/aiv2-p2-payroll-checklist), frozen here.
  {idx:808,version:'7',when:1793330001408,tag:'2008_own_payroll_cut_off',breakpoints:true,hash:'c068fa72631c648453117fdf73cc81e6ffbbb4cc94d55d82397e40ac4e4291f8'},
  // AI v2 Phase 2 P2-5 Living Handbook (claude/aiv2-p2-living-handbook), frozen here.
  {idx:809,version:'7',when:1793330001409,tag:'2009_teras_living_handbook',breakpoints:true,hash:'2ffa6731bc3e8cfbc0586875ba9c33d0db2c67104376dc99e35ba181214ccae0'},
  // AI v2 Phase 2 P2-6 learning loops (claude/aiv2-p2-learning-loops), frozen here.
  {idx:810,version:'7',when:1793330001410,tag:'2010_teras_learning_loops',breakpoints:true,hash:'2cabdaa5975db8ef1d91f6027bb38b4b7ca1f7ce3c17561b9961926f2e02c201'},
  // AI v2 Phase 2 hardening, payroll loops, audit and checklist (claude/aiv2-p2h-loops-hardening), frozen here.
  {idx:811,version:'7',when:1793330001411,tag:'2011_payroll_loops_hardening',breakpoints:true,hash:'d42cceaf96f728c8682b73c40c33b5d3066de40f1d5484100dff3686c811d909'},
  // ADR-0174 tenant-isolation hardening; frozen here.
  {idx:1347,version:'7',when:1793330001500,tag:'2100_employment_helper_tenant_pin',breakpoints:true,hash:'f492c0306ec81e4fd8d976aeab82b23defa099093b31f360e7e02ebdf5d45b9a'},
  {idx:1348,version:'7',when:1793330001501,tag:'2101_company_tenant_fk_not_valid',breakpoints:true,hash:'5aaf9b7e1f06514771e46ae3303e2e375eb461ba3acf0f8bb21af510bf49eb18'},
  {idx:1349,version:'7',when:1793330001502,tag:'2102_company_tenant_fk_validate',breakpoints:true,hash:'b2a6af380bb89765c2b32b6edaf8b5c7707ca23901f22806cd9f8888856983b4'},
  {idx:1367,version:'7',when:1793330001520,tag:'2120_definer_search_path_pin',breakpoints:true,hash:'d3154b1a705b519b3df8263492338253d3a445126e0e29aae8d228658b176238'},
  {idx:1368,version:'7',when:1793330001521,tag:'2121_company_descendant_tenant_pin',breakpoints:true,hash:'226a62add7c1b827f5486e327419186da115f7f74834dea87e1c385b711a0a34'},
  {idx:1369,version:'7',when:1793330001522,tag:'2122_company_reference_tenant_fk_not_valid',breakpoints:true,hash:'91bf130056cf56c6d114c472cfe27afed5725f2956b24f62f2a5f94cf8756752'},
  {idx:1370,version:'7',when:1793330001523,tag:'2123_company_reference_tenant_fk_validate',breakpoints:true,hash:'64a6df6bf067290871d7415d0efbd11a1c27f6f4c268313f4a673c331bebaaa4'},
 ]);
 expect(journal.entries.slice(583,636).map(migrationIdentity)).toEqual([
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
