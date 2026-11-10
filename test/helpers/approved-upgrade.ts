/** Exact approved forward tail and its intended populated permission transitions.
 * Historical receipts remain pinned by each owning fixture. No migration or old audit row is skipped. */
import {expect} from 'vitest';
import {PERFORMANCE_MIGRATION_IDENTITIES} from '../performance-migration-identities';
import {createHash} from 'node:crypto';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {createDb} from '../../db/client';
type Database=ReturnType<typeof createDb>;
type Row=Record<string,unknown>;
export const APPROVED_UPGRADE_TAIL=[
 {idx:1353,when:1793330001506,tag:'2106_account_management_subject'},
 {idx:1354,when:1793330001507,tag:'2107_probation_module_permission'},
 {idx:1355,when:1793330001508,tag:'2108_rewards_entity_classification'},
 {idx:1356,when:1793330001509,tag:'2109_org_chart_roots'},
 {idx:1357,when:1793330001510,tag:'2110_pay_formula_personnel_registry'},
 {idx:1358,when:1793330001511,tag:'2111_probation_personnel_mapping'},
 {idx:1380,when:1793330001526,tag:'2126_company_organisation_tagging'},
 {idx:1381,when:1793330001527,tag:'2127_personnel_filter_search'},
 {idx:1382,when:1793330001528,tag:'2128_organisation_account_admission'},
 {idx:1383,when:1793330001530,tag:'2130_approved_company_retention'},
 {idx:1410,when:1793330001610,tag:'2210_personnel_projection_reuse'},
 // Pending main payroll learning, then the combined Architecture, Rewards and Registration successors.
 {idx:1411,when:1793330001611,tag:'2013_payroll_learned_baseline'},
 {idx:1412,when:1793330001612,tag:'2200_job_architecture'},
 {idx:1413,when:1793330001613,tag:'2201_job_architecture_documents'},
 {idx:1414,when:1793330001614,tag:'2202_job_architecture_profile'},
 {idx:1415,when:1793330001615,tag:'2203_rewards_libraries_pat'},
 {idx:1416,when:1793330001616,tag:'2204_rewards_plan_setup'},
 {idx:1417,when:1793330001617,tag:'2205_rewards_review_creation'},
 {idx:1418,when:1793330001618,tag:'2206_rewards_role_permissions'},
 {idx:1419,when:1793330001619,tag:'2207_reward_advisor'},
 {idx:1420,when:1793330001620,tag:'2208_rewards_uploaded_awards'},
 {idx:1421,when:1793330001621,tag:'2209_company_registration_classification'},
 {idx:1422,when:1793330001622,tag:'2211_company_retention_approved_expansion'},
 {idx:1450,when:1793330001650,tag:'2250_rewards_whole_group_grants'},
 {idx:1451,when:1793330001651,tag:'2251_company_display_group'},
 {idx:1500,when:1793330001700,tag:'2300_retire_job_architecture_workflows'},
 {idx:1550,when:1793330001850,tag:'2450_personnel_search_projection'},
 {idx:1551,when:1793330001851,tag:'2451_personnel_company_filter_choices'},
 {idx:1654,when:1793330001854,tag:'2404_payroll_reconciliation_remark'},
 {idx:1655,when:1793330001855,tag:'2405_rewards_review_activity'},
 {idx:1656,when:1793330001856,tag:'2406_payroll_reconciliation_generation'},
 {idx:1660,when:1793330001860,tag:'2460_payroll_individual_import_queue'},
 {idx:1900,when:1793330002200,tag:'2600_onboarding_current_personnel'},
 {idx:2400,when:1793330002700,tag:'3100_pay_formula_saved_availability'},
 {idx:2401,when:1793330002701,tag:'3101_attendance_shared_workflow'},
 {idx:2410,when:1793330002710,tag:'3110_attendance_workflow_owner_rls'},
 {idx:2500,when:1793330002800,tag:'3200_ai_centre_controls'},
 {idx:2501,when:1793330002801,tag:'3201_ai_centre_function_coverage'},
 {idx:2700,when:1793330003000,tag:'3400_system_label_company_scope'},
 {idx:3000,when:1793330003300,tag:'3700_pay_item_company_applicability'},
 {idx:3001,when:1793330003301,tag:'3701_rewards_unit_preparation'},
 {idx:3002,when:1793330003302,tag:'3702_maybank_payment_arrangement'},
 {idx:3003,when:1793330003303,tag:'3703_attendance_formula_versions'},
 {idx:3004,when:1793330003304,tag:'3704_attendance_formula_results'},
 {idx:3005,when:1793330003305,tag:'3705_attendance_formula_payroll_source'},
 {idx:3006,when:1793330003306,tag:'3706_attendance_formula_overtime_binding'},
 {idx:3200,when:1793330003500,tag:'3900_individual_transaction_calculation_method'},
 {idx:3300,when:1793330003600,tag:'4000_attendance_workflow_lifecycle_scope'},
 {idx:3301,when:1793330003601,tag:'4001_personnel_employment_filter_projection'},
 {idx:3302,when:1793330003602,tag:'4002_attendance_prepare_review_only'},
 {idx:3500,when:1793330003800,tag:'4100_rewards_review_creator_independence'},
 {idx:3501,when:1793330003801,tag:'4101_attendance_formula_company_scope'},
 {idx:3600,when:1793330003900,tag:'4200_employee_loop_action_digest'},
 {idx:3601,when:1793330003901,tag:'4201_retire_attendance_formula_builder'},
 {idx:3602,when:1793330003902,tag:'4202_attendance_clock_policy_revisions'},
 {idx:4000,when:1793330004300,tag:'4600_attendance_clock_policy_group_scope'},
 {idx:4001,when:1793330004301,tag:'4601_last_login_event_index'},
 // 50d9b809: the AI Centre control for the shared_leave_groups read (docs/MIGRATION-ALLOCATION.md, 10 November 2026).
 {idx:4200,when:1793330004500,tag:'4800_ai_shared_leave_groups_read'},
 // Architecture candidate, renumbered above the released 8d5254eb watermark (docs/MIGRATION-ALLOCATION.md, 10 November 2026).
 ...PERFORMANCE_MIGRATION_IDENTITIES.map(({idx,when,tag})=>({idx,when,tag})),
 {idx:4237,when:1793330004537,tag:'3500_ai_centre_architecture_compatibility'},
 {idx:4238,when:1793330004538,tag:'3501_ai_centre_mandate_write_order'},
 {idx:4239,when:1793330004539,tag:'4338_assistant_rewards_return_presentation_snapshot'},
 {idx:4240,when:1793330004540,tag:'4339_assistant_rewards_calendar_cancel_presentation_snapshot'},
 {idx:4241,when:1793330004541,tag:'4340_ai_management_presentation_snapshot'},
 {idx:4242,when:1793330004542,tag:'4341_home_leave_presentation_snapshot'},
 {idx:4243,when:1793330004543,tag:'4342_attendance_clock_policy_audit_scope'},
 // Combined release block above every surveyed peer (docs/MIGRATION-ALLOCATION.md, 11 November 2026): the reader/writer
 // Access lock, the staged employee import and bulk-job kernel, Personnel typed facts, the bulk conversions, and the
 // audit-chain commit seal last.
 {idx:4400,when:1793330004700,tag:'5000_access_reader_writer_core'},
 {idx:4401,when:1793330004701,tag:'5001_access_reader_writer_serialisers'},
 {idx:4402,when:1793330004702,tag:'5002_access_reader_writer_profile_values'},
 {idx:4403,when:1793330004703,tag:'5003_access_reader_writer_owner_writers'},
 {idx:4404,when:1793330004704,tag:'5004_access_reader_writer_payroll_inputs'},
 {idx:4405,when:1793330004705,tag:'5005_access_reader_writer_people_values'},
 {idx:4406,when:1793330004706,tag:'5006_access_wave4_admin_fair_exclusive'},
 {idx:4410,when:1793330004710,tag:'5010_employee_import_staged_job'},
 {idx:4411,when:1793330004711,tag:'5011_bulk_job_kernel'},
 {idx:4412,when:1793330004712,tag:'5012_import_release_visibility'},
 {idx:4413,when:1793330004713,tag:'5013_bulk_job_least_privilege'},
 {idx:4414,when:1793330004714,tag:'5014_bulk_job_owner_attribution'},
 {idx:4420,when:1793330004720,tag:'5020_personnel_overview_facts'},
 {idx:4430,when:1793330004730,tag:'5030_leave_bulk_jobs'},
 {idx:4431,when:1793330004731,tag:'5031_leave_ledger_stage'},
 {idx:4432,when:1793330004732,tag:'5032_bulk_job_unbounded_kind'},
 {idx:4433,when:1793330004733,tag:'5033_leave_follow_up_jobs'},
 {idx:4435,when:1793330004735,tag:'5035_leave_stage_digests'},
 {idx:4436,when:1793330004736,tag:'5036_leave_type_pending_year_cycle'},
 {idx:4440,when:1793330004740,tag:'5040_roster_bulk_jobs'},
 {idx:4441,when:1793330004741,tag:'5041_bulk_job_queue_and_watch'},
 {idx:4445,when:1793330004745,tag:'5045_attendance_bulk_jobs'},
 {idx:4450,when:1793330004750,tag:'5050_payroll_processing_status'},
 {idx:4451,when:1793330004751,tag:'5051_payroll_processing_job'},
 {idx:4452,when:1793330004752,tag:'5052_payroll_run_group'},
 {idx:4453,when:1793330004753,tag:'5053_bulk_job_settle'},
 {idx:4454,when:1793330004754,tag:'5054_payroll_partner_point_read'},
 {idx:4455,when:1793330004755,tag:'5055_payroll_history_staged_job'},
 {idx:4456,when:1793330004756,tag:'5056_payroll_reprocess_job'},
 {idx:4460,when:1793330004760,tag:'5060_register_section_import_jobs'},
 {idx:4461,when:1793330004761,tag:'5061_register_import_set_release'},
 {idx:4462,when:1793330004762,tag:'5062_employee_import_revert_job'},
 {idx:4463,when:1793330004763,tag:'5063_register_import_release_key_authority'},
 {idx:4464,when:1793330004764,tag:'5064_employee_import_revert_release_hash'},
 {idx:4470,when:1793330004770,tag:'5070_system_label_import_staged_job'},
 {idx:4471,when:1793330004771,tag:'5071_workforce_capability_tenant_publication'},
 {idx:4490,when:1793330004790,tag:'5090_audit_chain_commit_seal'},
] as const;
// Final pending 2109/2126 bytes reviewed from engine 128bc2539; no applied-prefix hashes change.
const APPROVED_UPGRADE_HASHES:Record<string,string>={
 '4800_ai_shared_leave_groups_read':'774dce41ba113549ec5415586d104b8d5b7712934216f2beb4d9aa0e9f00ffc5',
 '4601_last_login_event_index':'868e30d4a2840d4939a46f303ce999b2e041ae3cb6823eb8b712179ccf7d5788',
 '4600_attendance_clock_policy_group_scope':'b30a62bec597f53266232abe569a040a9a421eaa2239eac232d0e44041352be6',
 '4200_employee_loop_action_digest':'8fb9906f3f5a4828507a87fe0e162826ccbbe76430e4ca39993e9ab1301d967f',
 '4201_retire_attendance_formula_builder':'7929ff4d341d96873c3d7c7f0a6c7253674816ed65e9b8d44171218377559778',
 '4202_attendance_clock_policy_revisions':'4633648e6d0869af1205dcf0911c9b6a02daeb177a16c6a89c5d5bdccf758df6',
 '4100_rewards_review_creator_independence':'2b985ae73e3da8c1ce3e7015829734632bff6ac550021dc644c59b9603083dff',
 '4101_attendance_formula_company_scope':'60d18c40db8d2f8392c81fa5ccb7cf05c12d6448321e744ebbc31605574e28f4',
 '4000_attendance_workflow_lifecycle_scope':'62759d27e18adc62dd458a18d7f1525f9ed2ac498ae58d7d3884f9f200cc0b1f',
 '4001_personnel_employment_filter_projection':'a7cd7536bca8d1b271d6f08eecd11242c4b56e9ba492e57e4b50053737d1c9fd',
 '4002_attendance_prepare_review_only':'c4b5b39f6eb241744e11eb49c96eff188efb11aa3cd5120f4195d2c1052bec36',
 '3900_individual_transaction_calculation_method':'f6f4a31109f66bc5c9038315e249829c2655b870db98a9cbb1ede9cfdab958d4',
 '3400_system_label_company_scope':'58067b76694141c5fc824c66acc24fda05c273dd7d3d85654418e0f52a01b69e',
 '3706_attendance_formula_overtime_binding':'4a46111e9d07cdf8a2167e430ee6c79c78e9c049c79c6c13544ffc68ad39d153',
 '3705_attendance_formula_payroll_source':'50263e2c7628a10a894c4f2ea7e9f912faa7d5b83331ea5b8e7d542cff8e31cc',
 '3704_attendance_formula_results':'f238d8b8893833ec71cd08691856b68b452c37e4444eccbbd241bdf73d3c391b',
 '3703_attendance_formula_versions':'d77ce2a318d153b61f3804defe9858d33649db14ceb19764448d8c2a501a4702',
 '3702_maybank_payment_arrangement':'19334a66cee1af68b561a8a8795dc74748e5825507f268d0138f7aff7cd91dfa',
 '3700_pay_item_company_applicability':'ff67d0990fce26f759b7d0e07a6805aced04e70af893c98dcf41c23774aa9c3c',
 '3701_rewards_unit_preparation':'4d8969bfc0b8f134f8cc01c42a738eb6cc4babdcb1ccfb0ec824a61d9b9fee11',
 '3100_pay_formula_saved_availability':'7bc0ab95aea27bae36f9be299784d3d391b4a315aa0302a9c42c2dbf9996b1b8',
 '3101_attendance_shared_workflow':'f32d12965f2788dc673f0c09e128996a653341bbcf6933e47f211da021617169',
 '3110_attendance_workflow_owner_rls':'39fc4b31666120cb4befe263b8b30433d6752dbaa52cda6cdbe350b3077f8f16',

 '2106_account_management_subject':'d4bbd5d20d9b40294b31d022a3ec0cf29e9a290f10749493c4934db31c5cdd67',
 '2107_probation_module_permission':'da94777be8e2b3f4365851eb785a64baaf9c54e9fb64808f7c72379ee94732f8',
 '2108_rewards_entity_classification':'8f485227fba437d5a24bc8b762630c670c38364d98d10e85802ce6e05bddd1c6',
 '2109_org_chart_roots':'71354dedee1e268a87846e5e983c267f4e1ade19704f5116e476dbc0f784ce2d',
 '2110_pay_formula_personnel_registry':'049f95c71a155eb95846e2d44d837624f5ee07c44c8911aae8e68188f66b9dc8',
 '2111_probation_personnel_mapping':'f280a7cf60fc1f3be24dee090fd8526454c6e65200ff10eba0728cbce82e5e24',
 '2126_company_organisation_tagging':'54e259de501c50db5c5cf930ea4e0d23c85a60e603d6ae7569b572365c83effd',
 '2127_personnel_filter_search':'ce56780cd696e805c4a217316b9d36bc411cfa0f8a5015c53a46e7ff9b606283',
 '2128_organisation_account_admission':'c239e97d982c0e5e2075e30c5b431ef03f8f61ff367f6660602234a6c74dd62d',
 '2130_approved_company_retention':'6d549d157a0c21f1da680daa1546cd45bd2f19187b8d7a9d9a4dc56482d68d2c',
 '2210_personnel_projection_reuse':'84665a381ed31061437c601197d9a9f8da5f8a5573abef5c09c0603b4546d613',
 '2013_payroll_learned_baseline':'bd490fda5f21c713262ecc6c8a29e8ed5dc88e0c963e201be7745bdc5a351da3',
 '2200_job_architecture':'85a609473361238e5aa44aaaea0b788cd0b8d354b6fd67c70be3c3506dd52a64',
 '2201_job_architecture_documents':'54bdaf9bf1a810fc5b7304813fb396a1a3640d323c2e9e2cf236cdf184cb12f7',
 '2202_job_architecture_profile':'2d49add7961177b8032cdf891446e6d4758c4e94e53ed957406bb7fcbdf3224d',
 '2203_rewards_libraries_pat':'f03d8d83b009054cce059cb9b87b35d3ea97bb54a6d63d96e311cfdffc3504ad',
 '2204_rewards_plan_setup':'311201ad2e3e745ea142e6ec8ea275887bfd02097e009f81c6a08ea7ad06e56c',
 '2205_rewards_review_creation':'37ffb2122b551cb7e01c5df2b4765d0ceaf1af030da2fb8c8c7a2977c3dbcd53',
 '2206_rewards_role_permissions':'30788b82fa2a31be1168596e88bd59f73f42db79040f341463e907443aa7edaf',
 '2207_reward_advisor':'be660e08105928d50c81775a9f01eab3a5c1a572dbec9e1a8929f682fc68ef6b',
 '2208_rewards_uploaded_awards':'97012d64969a58fe52f611aee883d61822e3021d5ed49bccac276f217119eefb',
 '2209_company_registration_classification':'9685fcef72990612baedf333b4af3fe8c4d3e0a6ebe9611bcc7eabea466ad0e0',
 '2211_company_retention_approved_expansion':'5e336a948b9490d9355eba65d6f341618334a031c7bdc66562ed9139b7c5f0c4',
 '2250_rewards_whole_group_grants':'dc3437a768104a0be69f38adc395d7d814efb01f0feb66d7fc1af84c971f9e27',
 '2251_company_display_group':'3015af6a8183b9e01fbb42c165fe2ce83eb6d167d0b7cd61210144cd6d292a8a',
 '2300_retire_job_architecture_workflows':'0baf5adae50036cb20634ec362c1302b8c6c45f38ec8610f68e5c1bdc9ebedda',
 '2450_personnel_search_projection':'4e349dd20f6d55562ada2709b092543abab69390a5903a89b49407ed29357fe8',
 '2451_personnel_company_filter_choices':'06e8f11ebe34c106bffba5985db366258a72accfb31ad931bb0825fbd0fe23b6',
 '2404_payroll_reconciliation_remark':'a0b5e3df73af733fd19ec72c1333cbdf21e9a932123be476ea86b4bfafda3974',
 '2405_rewards_review_activity':'fb8f6d1be9e24589969329324174f74a2c3516dedf041ae8dad37f60d19afc20',
 '2406_payroll_reconciliation_generation':'38979689c8df2b486fdd1c104de7dd94e872ba8e0838e1d51cc8be119fa99113',
 '2460_payroll_individual_import_queue':'5919c5fde5796a08c13d2a37174becaa20f86abb896e2aa66be5d3b222a79f4c',
 '2600_onboarding_current_personnel':'ef82561ecfca93f3feab8f38918c3449569b68afe944085cceb8bafd25ab60be',
 '3200_ai_centre_controls':'2182ae4a614d0b847f399af18f9cfc43e82d3c9fd6f42ca960bfe22ebf4f10e2',
 '3201_ai_centre_function_coverage':'0c7239f512174c0d941dcb441cf98bd3a685a8e4d65973dc92f136dfb6b78d8a',
 ...Object.fromEntries(PERFORMANCE_MIGRATION_IDENTITIES.map(({tag,hash})=>[tag,hash])),
 '3500_ai_centre_architecture_compatibility':'c264d042ea39709e2bcc3b7f9b33b83715a30f05b98437e60b1c1910b1e3bbf3',
 '3501_ai_centre_mandate_write_order':'821312765fb359ee0c761a200b519525d1d667bfe20b11f1889829f6d4976d76',
 '4338_assistant_rewards_return_presentation_snapshot':'1acfa11fd818c5efe53dc74c05aef351fb7b71e238dcd0dfc0d1c978672d84d8',
 '4339_assistant_rewards_calendar_cancel_presentation_snapshot':'6df872ead7dc864a8e2a7c78ee8dcdf9e4bd4d637186c185c54a656acb6f07e9',
 '4340_ai_management_presentation_snapshot':'17973dd386f8fb1fda3a2773de3cd189055bed744730949912b2206a77c4e32c',
 '4341_home_leave_presentation_snapshot':'91ceea84de63aa91d8d5c559c0c7c4ee4cadd86ee14bb0d2c1300be580c2a664',
 '4342_attendance_clock_policy_audit_scope':'bc83887d91db94c2199d600a4ca5293d43d14662fb08c85818d35455ac28f67f',
 '5000_access_reader_writer_core':'fead3e8f0d90a199119cf0578e2cab387f4a4d9a2e56cb4ab96de792d4040527',
 '5001_access_reader_writer_serialisers':'6665dac2d56dd325b0495fbf1e1215326071b7a23043d5c546155abae971c104',
 '5002_access_reader_writer_profile_values':'c976c1b3852df4a7715047912ead0fc53a50492ca9a59c7e72490c8fff4598f1',
 '5003_access_reader_writer_owner_writers':'07f7c70515033c682a9dadd5031c68df282ad56b9eb984423fd2ee807de019cf',
 '5004_access_reader_writer_payroll_inputs':'5f6cf69f2c1c6b1285536727df0bb43d6459a4bbec013e4ea2c0628ab80d4bd0',
 '5005_access_reader_writer_people_values':'4e00488e5571f4d7e17e4f90fa8445150c848fb4159bd50d76f986f1e6354025',
 '5006_access_wave4_admin_fair_exclusive':'3a8ef207e6235548a53d2d49993c81404a097a6dc503eb77e1e5a7115abe8445',
 '5010_employee_import_staged_job':'c71e21ef9571ebd015bcff95b87da46fbedb098b66f0b8edfbb10d4b16fe9e65',
 '5011_bulk_job_kernel':'50af4670d06419c82ec7495827cf14db2905fda780b21ee58f17ae2f1df7af58',
 '5012_import_release_visibility':'c9317842654b48046d93ca842cf5fbb99db42324bca02858fcea4759a0d90801',
 '5013_bulk_job_least_privilege':'14ced1c75079a4b5846cbb2c267671cbdbcb77e5810aeb43f73909e3b5a3cde6',
 '5014_bulk_job_owner_attribution':'204bdda42c5a3bbde262c07698d25d34071056b45cf3068189c1cb8c2bb7bdfe',
 '5020_personnel_overview_facts':'e45555e45eee6f644abf2cd2665b9ac7c3c4adad5b46874fc8b1296f648d350f',
 '5030_leave_bulk_jobs':'63cf77be718402bc8cf27653ea4fab7cf08f6ace92a08751597fff8dae4b2b9a',
 '5031_leave_ledger_stage':'89b37fb2f07bd3d12214ddbab3ec681a029d539a1312adcd611f29ff7580b484',
 '5032_bulk_job_unbounded_kind':'87546b29bea2e2103bf6261fef63d04d068906cba48555def165f53e2fd83df4',
 '5033_leave_follow_up_jobs':'d948a22f42e1a65ee259782d0d4856e5e3ba5d069ec344d9f39175f87ce47d42',
 '5035_leave_stage_digests':'494012354aa83806eee58e6c4476016cc2534ec255b58feacd523b0f784638d1',
 '5036_leave_type_pending_year_cycle':'451ac2eefb07ca27865ea92f60bd7819f9882156c7dda88b1686ef4eace69324',
 '5040_roster_bulk_jobs':'c8aada50a9e2fb4a9fc938334fc1e7e0412e9afbb155e108296c2516e6fc3d73',
 '5041_bulk_job_queue_and_watch':'2597d98df5afbbcb1d7dea7a31c1d09c5902753ebc04a40003992dbc8b9d4e2d',
 '5045_attendance_bulk_jobs':'deb95193c213c2d400d5e2d798c3bcf376d07f9635d635be42b663ee1fef4e1c',
 '5050_payroll_processing_status':'1e9ca4115879eff695e815bc7e83ce18eef78ce0982da05a8d292eb5a08bc7d1',
 '5051_payroll_processing_job':'37caaa2ba6bc6ea90552cf3da0a933c9972cc9aff3d56c98c567b28e6891be16',
 '5052_payroll_run_group':'f420568a0612c6da490ea7330d36b464bedad8fc5e25663d268e9750b1886901',
 '5053_bulk_job_settle':'a0edd7cf60bd4cb3dc5c52a924abc749b5af3dde9c53a22034673e2ba78d3f6e',
 '5054_payroll_partner_point_read':'628f65f096449ddfca7075e1fc75e6e727f1e5ea566d83b3610b2924378a5d45',
 '5055_payroll_history_staged_job':'c2344884621bc3017920a44fa3d51feff14459dca8342dab1705a19e4fa74cb0',
 '5056_payroll_reprocess_job':'96a041edc8964a6234bc13b7a0c905a396d342fa83e8f16f86ff36472a5df881',
 '5060_register_section_import_jobs':'208d2d40dd1c9b6a5c3cc061ac6a9f282e8f20eb1309c69aeb0e15c2a5088346',
 '5061_register_import_set_release':'2e58415bc1ba2925268df41bf07d3b9cf802f274e01476b336b7dd207b843efe',
 '5062_employee_import_revert_job':'1e48068ba30160e2a94e5e511a5dd68bf23f5f968f5fd675da39cc11599d8d43',
 '5063_register_import_release_key_authority':'ae0827b9a2cc63fdc9a2485d4e2762f34800c070da43e2e5b4b2bb2567316f40',
 '5064_employee_import_revert_release_hash':'8862489275a2132ff64547b7e1641afd43c57a2cc4f1660ff9a3a8464d2ff568',
 '5070_system_label_import_staged_job':'ba9f29643d13bbe4e69f169d004c698a393af6b639edf97f1d7dd835347e61ba',
 '5071_workforce_capability_tenant_publication':'4d22cd648ea0698c5ce230461862fc4c93e61cbc9196800e0317b680d694a311',
 '5090_audit_chain_commit_seal':'f6bf0e0f80ca6cb222c8ec10996d55e1bafdbe436809987d9d7b7cf9c11485f1',
};
export function assertApprovedUpgradeTail(entries:{idx:number;when:number;tag:string}[]){
 expect(entries).toHaveLength(671+APPROVED_UPGRADE_TAIL.length);
 expect(entries.slice(671)).toEqual(APPROVED_UPGRADE_TAIL.map(entry=>({...entry,version:'7',breakpoints:true})));
 for(const entry of APPROVED_UPGRADE_TAIL)expect(createHash('sha256').update(readFileSync('db/migrations/'+entry.tag+'.sql')).digest('hex'),entry.tag+' reviewed pending SQL identity').toBe(APPROVED_UPGRADE_HASHES[entry.tag]);
}
const payload={capabilityId:'probation.module',scope:'tenant',initialHolders:'current-named-admins-and-system-administrators',legacyAssignmentsRetained:true};
export type ApprovedUpgradeWitness={events:Row[];eventsRaw:Row[];grants:Row[];overrides:Row[];configurations:{before:Row;after:Row}[];generations:{before:Row;after:Row}[]};
const canonical=(row:unknown)=>JSON.stringify(row,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const ordered=(rows:Row[])=>rows.map(canonical).sort();
async function table(db:Database,name:string):Promise<Row[]>{return (await db.client.unsafe('select to_jsonb(t) value from '+name+' t order by to_jsonb(t)::text')).map(row=>row.value as Row);}
/** Stage the complete ordinary prefix immediately before 2107, inspect exactly that transition,
 * then migrate every remaining journal entry. No SQL is installed outside the ordinary migrator. */
export async function migrateApprovedUpgrade(db:Database, migrationsFolder = 'db/migrations'):Promise<ApprovedUpgradeWitness>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 assertApprovedUpgradeTail(journal.entries);
 const boundary=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='2107_probation_module_permission');
 const folder=mkdtempSync(join(tmpdir(),'aihr-approved-permission-upgrade-'));
 try{
  mkdirSync(join(folder,'meta'));
  for(const entry of journal.entries.slice(0,boundary+1))copyFileSync('db/migrations/'+entry.tag+'.sql',join(folder,entry.tag+'.sql'));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(db.db,{migrationsFolder:folder});
  const configs=await table(db,'public.access_configuration'),generations=await table(db,'app.access_profile_write_generation');
  const groups=await table(db,'public.access_group'),users=await table(db,'public.app_user'),legacyAccess=await table(db,'public.probation_access'),memberships=await table(db,'public.access_membership'),capabilities=await table(db,'public.access_capability');
  const groupsBefore=await table(db,'public.access_group_grant'),overridesBefore=await table(db,'public.access_user_override'),eventsBefore=await table(db,'public.domain_event');
  const eligible=(await db.client`select tenant_id from access_configuration union select tenant_id from probation_access order by tenant_id`).map(row=>String(row.tenant_id));
  const namedAdmins=await db.client`select distinct a.tenant_id,a.user_id from probation_access a join app_user u on u.id=a.user_id and u.tenant_id=a.tenant_id where a.role='admin' and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date and (a.valid_to is null or a.valid_to>=(now() at time zone 'Asia/Kuala_Lumpur')::date) and u.archived_at is null and not app.login_blocked(u.id) order by a.tenant_id,a.user_id`;
  const [clock]=await db.client`select clock_timestamp()::text at`;
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary+1)}));
  await migrate(db.db,{migrationsFolder:folder});
  const groupAfter=await table(db,'public.access_group_grant'),overrideAfter=await table(db,'public.access_user_override'),eventsAfter=await table(db,'public.domain_event');
  const eventsRaw=[...await db.client`select * from domain_event order by id`] as Row[];
  const newRows=(before:Row[],after:Row[])=>after.filter(row=>!before.some(old=>old.id===row.id));
  const grants=newRows(groupsBefore,groupAfter),overrides=newRows(overridesBefore,overrideAfter),events=newRows(eventsBefore,eventsAfter);
  for(const [before,after] of [[groupsBefore,groupAfter],[overridesBefore,overrideAfter],[eventsBefore,eventsAfter]])expect(ordered(after.filter(row=>before.some(old=>old.id===row.id)))).toEqual(ordered(before));
  const expectedGroups=groups.filter(row=>eligible.includes(String(row.tenant_id))&&row.system_administrator===true&&row.retired_at===null).map(row=>({tenant_id:row.tenant_id,group_id:row.id,capability_id:'probation.module',company_id:null,retired_at:null}));
  expect(ordered(grants.map(({tenant_id,group_id,capability_id,company_id,retired_at})=>({tenant_id,group_id,capability_id,company_id,retired_at})))).toEqual(ordered(expectedGroups));
  expect(ordered(overrides.map(({tenant_id,user_id,capability_id,effect,company_id,retired_at})=>({tenant_id,user_id,capability_id,effect,company_id,retired_at})))).toEqual(ordered(namedAdmins.map(({tenant_id,user_id})=>({tenant_id,user_id,capability_id:'probation.module',effect:'allow',company_id:null,retired_at:null}))));
  for(const row of [...grants,...overrides]){expect(String(row.id)).toMatch(/^[0-9a-f-]{36}$/);expect(Date.parse(String(row.created_at))).toBeGreaterThanOrEqual(Date.parse(String(clock.at)));}
  expect(events).toHaveLength(eligible.length);
  expect(events.map(row=>String(row.tenant_id)).sort()).toEqual(eligible.slice().sort());
  for(const event of events){
   expect(event).toMatchObject({aggregate_type:'access-configuration',aggregate_id:event.tenant_id,event_type:'probation.module-permission.registered',actor_type:'system',actor_id:null,subject_employment_id:null,payload});
   expect(event.payload).toEqual(payload);expect(String(event.id)).toMatch(/^[0-9a-f-]{36}$/);
   expect(Date.parse(String(event.occurred_at))).toBeGreaterThanOrEqual(Date.parse(String(clock.at)));
  }
  const capabilityAfter=await table(db,'public.access_capability');
  expect(ordered(capabilityAfter.filter(row=>row.id!=='probation.module'))).toEqual(ordered(capabilities));
  expect(capabilityAfter.filter(row=>row.id==='probation.module')).toEqual([{id:'probation.module',scope:'tenant',supported:true,bindings:[{owner:'app.probation_config_admin',operation:'configure-all-entitled-companies'},{owner:'app.probation_request_activation',operation:'activate-reviewed-cutover'},{owner:'app.probation_navigation_access',operation:'page'}]}]);
  expect(await table(db,'public.probation_access')).toEqual(legacyAccess);expect(await table(db,'public.access_membership')).toEqual(memberships);
  const configsAfter=await table(db,'public.access_configuration'),generationsAfter=await table(db,'app.access_profile_write_generation');
  expect(configsAfter).toHaveLength(configs.length);expect(generationsAfter).toHaveLength(generations.length);
  const configurations=configs.map(before=>{
   const after=configsAfter.find(row=>row.tenant_id===before.tenant_id)!;
   expect(after).toEqual({...before,revision:after.revision,updated_at:after.updated_at});
   expect(after.revision).not.toBe(before.revision);expect(Date.parse(String(after.updated_at))).toBeGreaterThanOrEqual(Date.parse(String(clock.at)));
   return {before,after};
  });
  const generationPairs=generations.map(before=>{
   const after=generationsAfter.find(row=>row.tenant_id===before.tenant_id)!;
   expect(after).toEqual({...before,generation:Number(before.generation)+(configs.some(row=>row.tenant_id===before.tenant_id)?1:0)});return {before,after};
  });
  expect(await table(db,'public.access_group')).toEqual(groups);expect(await table(db,'public.app_user')).toEqual(users);
  await migrate(db.db,{migrationsFolder});
  expect(await db.client`select id from public.company where display_group_field is not null or display_group_option_id is not null`).toEqual([]);
  expect(await db.client`select user_id from public.reward_group_role_grant`).toEqual([]);
  expect(await table(db,'public.domain_event')).toEqual(eventsAfter);
  expect(await table(db,'public.access_group_grant')).toEqual(groupAfter);expect(await table(db,'public.access_user_override')).toEqual(overrideAfter);
  expect(await table(db,'public.access_configuration')).toEqual(configsAfter);expect(await table(db,'app.access_profile_write_generation')).toEqual(generationsAfter);
  return {events,eventsRaw:eventsRaw.filter(row=>events.some(event=>event.id===row.id)),grants,overrides,configurations,generations:generationPairs};
 }finally{rmSync(folder,{recursive:true,force:true});}
}
/** Remove ONLY exact independently validated new rows, or restore ONLY exact independently
 * validated permission revisions. Unexpected audit mutations or extra rows remain visible. */
export function retainedUpgradeRows(name:string,rows:unknown[],witness?:ApprovedUpgradeWitness):unknown[]{
 const tableName=name.replace(/^public\./,'');
 const result=rows.flatMap(item=>{
  const parsed=typeof item==='string'?JSON.parse(item):item;
  const wrapper=parsed as Row;
  const field=wrapper&&typeof wrapper==='object'&&Object.keys(wrapper).length===1&&('row' in wrapper||'value' in wrapper)?('row' in wrapper?'row':'value'):null;
  const row=(field?wrapper[field]:parsed) as Row;
  let normalized=row;
  if((tableName==='reward_unit'||tableName==='units')&&Object.hasOwn(row,'preparation_required')){
   expect(row.preparation_required,'historical reviews retain unrecorded preparation, never fabricated release proofs').toBe(false);
   const {preparation_required:_preparation,...original}=normalized;normalized=original;
  }
  if(tableName==='pay_component'&&Object.hasOwn(row,'applied_company_ids')){
   expect(row.applied_company_ids,'legacy Pay Items retain all-company availability').toBeNull();
   const {applied_company_ids:_companies,...original}=normalized;normalized=original;
  }
  if(tableName==='company'&&row.display_group_field===null&&row.display_group_option_id===null){
   const {display_group_field:_field,display_group_option_id:_option,...original}=row;
   normalized=original;
  }
  if(witness){
   const additions=tableName==='domain_event'||tableName==='audit'?witness.events:tableName==='access_group_grant'?witness.grants:tableName==='access_user_override'?witness.overrides:[];
   const added=additions.find(value=>value.id===row.id);
   if(added){const raw=witness.eventsRaw.find(value=>value.id===row.id);expect([canonical(added),...(raw?[canonical(raw)]:[])]).toContain(canonical(row));return [];}
   const pairs=name==='app.access_profile_write_generation'?witness.generations:tableName==='access_configuration'?witness.configurations:[];
   const pair=pairs.find(value=>value.after.tenant_id===row.tenant_id);
   if(pair){
    // Fixtures may compare only their original columns. Each present changed field must match
    // the fully validated transition before its original value is restored for comparison.
    normalized={...row};
    for(const key of Object.keys(pair.before))if(key in row&&canonical(pair.before[key])!==canonical(pair.after[key])){expect(row[key]).toEqual(pair.after[key]);normalized[key]=pair.before[key];}
   }
  }
  return [typeof item==='string'?canonical(normalized):field?{...wrapper,[field]:normalized}:normalized];
 });
 return rows.every(item=>typeof item==='string')?(result as string[]).sort():result;
}
export function retainedUpgradeSnapshot(snapshot:Record<string,unknown>,witness?:ApprovedUpgradeWitness){return Object.fromEntries(Object.entries(snapshot).map(([key,value])=>[key,Array.isArray(value)?retainedUpgradeRows(key,value,witness):value]));}
/** Preserve every original column of the explicitly owned synthetic business rows across a
 * second, full-source phase. Later nullable schema additions are not mistaken for rewritten facts. */
export async function captureTenantUpgradeRows(db:Database,tenantIds:string[],names:string[]){
 const definitions=await Promise.all(names.map(async name=>{
  const [schema,tableName]=name.includes('.')?name.split('.'):['public',name];
  const columns=(await db.client`select column_name from information_schema.columns where table_schema=${schema} and table_name=${tableName} order by ordinal_position`).map(row=>String(row.column_name));
  expect(columns.length,name+' original columns').toBeGreaterThan(0);
  return {name,schema,tableName,columns};
 }));
 const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
 const read=async()=>{
  const snapshot:Record<string,unknown>={};
  for(const definition of definitions){
   const scoped=definition.columns.includes('tenant_id')?' where t.tenant_id=any($1::uuid[])':definition.tableName==='tenant'?' where t.id=any($1::uuid[])':'';
   const params=scoped?[tenantIds,definition.columns]:[definition.columns];
   const index=scoped?2:1;
   snapshot[definition.name]=await db.client.unsafe('select value from (select (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(t)) where key=any($'+index+'::text[])) value from '+quote(definition.schema)+'.'+quote(definition.tableName)+' t'+scoped+') retained order by retained.value::text',params);
  }
  return snapshot;
 };
 return {before:await read(),read};
}
