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
 {idx:4200,when:1793330004500,tag:'4800_ai_shared_leave_groups_read'},
 {idx:4237,when:1793330004537,tag:'3500_ai_centre_architecture_compatibility'},
 {idx:4238,when:1793330004538,tag:'3501_ai_centre_mandate_write_order'},
 {idx:4239,when:1793330004539,tag:'4338_assistant_rewards_return_presentation_snapshot'},
 {idx:4240,when:1793330004540,tag:'4339_assistant_rewards_calendar_cancel_presentation_snapshot'},
 {idx:4241,when:1793330004541,tag:'4340_ai_management_presentation_snapshot'},
 {idx:4242,when:1793330004542,tag:'4341_home_leave_presentation_snapshot'},
 {idx:4243,when:1793330004543,tag:'4342_attendance_clock_policy_audit_scope'},
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
 {idx:4475,when:1793330004775,tag:'5075_bulk_job_movement_import'},
 {idx:4476,when:1793330004776,tag:'5076_workforce_employment_access_set'},
 {idx:4477,when:1793330004777,tag:'5077_bulk_job_movement_check'},
 {idx:4478,when:1793330004778,tag:'5078_bulk_job_movement_import_revert'},
 {idx:4479,when:1793330004779,tag:'5079_movement_revert_capture'},
 {idx:4480,when:1793330004780,tag:'5080_access_administrator_coalesced_assert'},
 {idx:4481,when:1793330004781,tag:'5081_reward_access_observation_due'},
 {idx:4482,when:1793330004782,tag:'5082_home_own_clock_day'},
 {idx:4483,when:1793330004783,tag:'5083_home_own_schedule_range'},
 {idx:4490,when:1793330004790,tag:'5090_audit_chain_commit_seal'},
 {idx:4520,when:1793330004820,tag:'5120_access_review_custody_held_mode'},
 {idx:4521,when:1793330004821,tag:'5121_personnel_search_set_mapping'},
 {idx:4523,when:1793330004823,tag:'5123_import_history_kind'},
 {idx:4524,when:1793330004824,tag:'5124_attendance_workflow_skipped_levels'},
 {idx:4525,when:1793330004825,tag:'5125_individual_txn_pricing_marker'},
 {idx:4526,when:1793330004826,tag:'5126_contract_internship_end_dates'},
 {idx:4527,when:1793330004827,tag:'5127_import_log_actor_labels'},
 {idx:4529,when:1793330004829,tag:'5129_payroll_history_effective_reads'},
 {idx:4530,when:1793330004830,tag:'5130_pay_formula_ai_draft_job'},
 {idx:4540,when:1793330004840,tag:'5140_attendance_workflow_cross_company_pending'},
 {idx:4541,when:1793330004841,tag:'5141_attendance_workflow_escalation'},
 {idx:4542,when:1793330004842,tag:'5142_attendance_on_behalf'},
 {idx:4543,when:1793330004843,tag:'5143_attendance_final_decision_window'},
 {idx:4544,when:1793330004844,tag:'5144_attendance_lane_security_review'},
 {idx:4545,when:1793330004845,tag:'5145_ai_attendance_on_behalf_reads'},
 {idx:4550,when:1793330004850,tag:'5150_attendance_policy_dated_rounding'},
 {idx:4560,when:1793330004860,tag:'5160_sweep_swing_thresholds'},
 {idx:4561,when:1793330004861,tag:'5161_leave_team_minimum_present'},
 {idx:4562,when:1793330004862,tag:'5162_teras_loop_request_acts'},
 {idx:4800,when:1793330005100,tag:'5400_rewards_direct_configuration'},
 {idx:4820,when:1793330005120,tag:'5420_rewards_dashboard_preparation_notices'},
 {idx:4860,when:1793330005160,tag:'5460_lifecycle_v9_email_recipients'},
 {idx:4880,when:1793330005180,tag:'5480_offboarding_items_assignment_load'},
 {idx:4900,when:1793330005200,tag:'5500_rewards_limit_controls'},
 {idx:4920,when:1793330005220,tag:'5520_rewards_role_permission_grid'},
 {idx:4940,when:1793330005240,tag:'5540_rewards_offcycle_company_balance'},
 {idx:4960,when:1793330005260,tag:'5560_rewards_limit_controls_role_level'},
 {idx:4980,when:1793330005280,tag:'5580_rewards_config_owner_paths'},
 {idx:5000,when:1793330005300,tag:'5600_rewards_config_editor_role_levels'},
 {idx:5020,when:1793330005320,tag:'5620_rewards_config_grants_creator_lock'},
 {idx:5040,when:1793330005340,tag:'5640_lifecycle_v9_email_hold_company_tenant'},
 {idx:5060,when:1793330005360,tag:'5660_pay_component_bonus_epf_bonus_2012'},
 {idx:5080,when:1793330005380,tag:'5680_payroll_history_dated_company'},
 {idx:5090,when:1793330005390,tag:'5690_information_payslip_snapshot_from_history'},
 {idx:5095,when:1793330005395,tag:'5695_employment_rehire_link'},
 {idx:5096,when:1793330005396,tag:'5696_information_correction_latest_saved'},
 {idx:5140,when:1793330005440,tag:'5740_automation_shared_definitions'},
 {idx:5141,when:1793330005441,tag:'5741_personnel_postings'},
 {idx:5142,when:1793330005442,tag:'5742_probation_settings_scope'},
 {idx:5143,when:1793330005443,tag:'5743_automation_email_templates'},
 {idx:5144,when:1793330005444,tag:'5744_probation_case_at_activation'},
 {idx:5145,when:1793330005445,tag:'5745_probation_outcome_override_event'},
 {idx:5146,when:1793330005446,tag:'5746_probation_tracker_scale_and_extensions'},
 {idx:5147,when:1793330005447,tag:'5747_document_signing_review_routing'},
 {idx:5148,when:1793330005448,tag:'5748_automation_runs'},
 {idx:5149,when:1793330005449,tag:'5749_probation_delegation'},
 {idx:5150,when:1793330005450,tag:'5750_probation_tracker_plan_robustness'},
 {idx:5151,when:1793330005451,tag:'5751_probation_queues_and_form_routing'},
 {idx:5152,when:1793330005452,tag:'5752_probation_letter_routing'},
 {idx:5153,when:1793330005453,tag:'5753_probation_outcome_automation'},
 {idx:5154,when:1793330005454,tag:'5754_automation_email_delivery'},
 {idx:5155,when:1793330005455,tag:'5755_probation_routed_assignment'},
 {idx:5156,when:1793330005456,tag:'5756_probation_form_approver_choices'},
 {idx:5157,when:1793330005457,tag:'5757_probation_legacy_workflow_move'},
 {idx:5158,when:1793330005458,tag:'5758_probation_routed_overrides'},
 {idx:5159,when:1793330005459,tag:'5759_probation_employee_own_steps_only'},
 {idx:5160,when:1793330005460,tag:'5760_probation_queue_kinds_and_pbp_tasks'},
 {idx:5161,when:1793330005461,tag:'5761_probation_automation_recipients_and_tracker_steps'},
 {idx:5162,when:1793330005462,tag:'5762_probation_form_import'},
 {idx:5163,when:1793330005463,tag:'5763_probation_access_roles'},
 {idx:5164,when:1793330005464,tag:'5764_probation_routed_holders'},
 {idx:5165,when:1793330005465,tag:'5765_probation_letter_signers'},
 {idx:5166,when:1793330005466,tag:'5766_probation_reshape_company_in_use'},
 {idx:5170,when:1793330005470,tag:'5770_attendance_workflow_approver_codes'},
 {idx:5171,when:1793330005471,tag:'5771_assistant_legacy_index_shared_access'},
 {idx:5183,when:1793330005483,tag:'5783_resignation_journey'},
 {idx:5184,when:1793330005484,tag:'5784_resignation_configuration'},
 {idx:5185,when:1793330005485,tag:'5785_resignation_postings'},
 {idx:5186,when:1793330005486,tag:'5786_resignation_email_delivery'},
 {idx:5200,when:1794841005800,tag:'5800_contract_shared_access'},
 {idx:5201,when:1794841005801,tag:'5801_contract_shared_flows'},
 {idx:5202,when:1794841005802,tag:'5802_contract_shared_builders'},
 {idx:5203,when:1794841005803,tag:'5803_shared_document_templates'},
 {idx:5204,when:1794841005804,tag:'5804_shared_email_rich_body'},
 {idx:5205,when:1794841005805,tag:'5805_native_contract_counter_and_cutover'},
 {idx:5206,when:1794841005806,tag:'5806_contract_shared_projections'},
 {idx:5207,when:1794841005807,tag:'5807_contract_shared_commands'},
 {idx:5208,when:1794841005808,tag:'5808_contract_shared_signing'},
 {idx:5209,when:1794841005809,tag:'5809_contract_shared_decision_identity'},
 {idx:5210,when:1794841005810,tag:'5810_contract_shared_execution_adapters'},
 {idx:5211,when:1794841005811,tag:'5811_contract_shared_worker_binding'},
 {idx:5212,when:1794841005812,tag:'5812_contract_shared_identity_context'},
 {idx:5213,when:1794841005813,tag:'5813_contract_shared_email_notifications'},
 {idx:5214,when:1794841005814,tag:'5814_contract_shared_personnel_postings'},
 {idx:5215,when:1794841005815,tag:'5815_contract_posting_movement_authority'},
 {idx:5216,when:1794841005816,tag:'5816_contract_posting_projections'},
 {idx:5217,when:1794841005817,tag:'5817_contract_posting_receipts_and_tasks'},
 {idx:5218,when:1794841005818,tag:'5818_contract_shared_tracker'},
 {idx:5219,when:1794841005819,tag:'5819_contract_shared_period_open'},
 {idx:5220,when:1794841005820,tag:'5820_contract_shared_case_workspace'},
 {idx:5221,when:1794841005821,tag:'5821_contract_shared_assigned_work'},
 {idx:5222,when:1794841005822,tag:'5822_contract_shared_ending_handoff'},
 {idx:5223,when:1794841005823,tag:'5823_contract_shared_decline'},
 {idx:5224,when:1794841005824,tag:'5824_contract_shared_offboarding'},
 {idx:5225,when:1794841005825,tag:'5825_contract_shared_email_document_lifecycle'},
 {idx:5226,when:1794841005826,tag:'5826_automation_shared_assignment_groups'},
 {idx:5227,when:1794841005827,tag:'5827_shared_automation_email_assets'},
 {idx:5228,when:1794841005828,tag:'5828_automation_email_test_self'},
 {idx:5229,when:1794841005829,tag:'5829_shared_automation_email_asset_delivery'},
 {idx:5230,when:1794841005830,tag:'5830_contract_shared_tracker_choices'},
 {idx:5232,when:1794841005832,tag:'5832_contract_shared_starting_setup'},
 {idx:5233,when:1794841005833,tag:'5833_contract_shared_tracker_retained_cases'},
 {idx:5234,when:1794841005834,tag:'5834_contract_shared_email_compatibility'},
 {idx:5235,when:1794841005835,tag:'5835_contract_shared_review_wording'},
 {idx:5236,when:1794841005836,tag:'5836_contract_shared_ending_actions'},
 {idx:5237,when:1794841005837,tag:'5837_contract_shared_email_self_binding'},
 {idx:5238,when:1794841005838,tag:'5838_contract_shared_email_task_projection'},
 {idx:5240,when:1794841005840,tag:'5840_shared_email_test_asset_source'},
 {idx:5241,when:1794841005841,tag:'5841_shared_email_case_file_pages'},
 {idx:5242,when:1794841005842,tag:'5842_probation_shared_email_asset_proof'},
 {idx:5244,when:1794841005844,tag:'5844_shared_groups_preserve_members'},
 {idx:5245,when:1794841005845,tag:'5845_shared_groups_member_identity'},
 {idx:5246,when:1794841005846,tag:'5846_email_test_current_human'},
 {idx:5247,when:1794841005847,tag:'5847_email_test_authority_utf8'},
 {idx:5248,when:1794841005848,tag:'5848_contract_shared_virtual_period'},
 {idx:5249,when:1794841005849,tag:'5849_contract_shared_case_references'},
 {idx:5296,when:1794841005896,tag:'5896_contract_shared_directory_and_signer_caption'},
 {idx:5297,when:1794841005897,tag:'5897_contract_shared_period_history'},
 {idx:5298,when:1794841005898,tag:'5898_contract_shared_work_page'},
 {idx:5299,when:1794841005899,tag:'5899_contract_shared_legacy_inbox_cutover'},
 {idx:5302,when:1794841005902,tag:'5902_shared_automation_permission_compatibility'},
 {idx:5304,when:1794841005904,tag:'5904_contract_shared_native_intake_guard'},
 {idx:5310,when:1794841005910,tag:'5910_contract_shared_work_page_null_guards'},
 {idx:5311,when:1794841005911,tag:'5911_contract_posting_canonical_assignment_receipt'},
 {idx:5312,when:1794841005912,tag:'5912_contract_posting_source_projection'},
 {idx:5313,when:1794841005913,tag:'5913_contract_posting_native_completion'},
 {idx:5315,when:1794841005915,tag:'5915_contract_posting_durable_job_readiness'},
 {idx:5316,when:1794841005916,tag:'5916_contract_ordinary_signing_company_gate'},
 {idx:5317,when:1794841005917,tag:'5917_contract_work_exact_document_join'},
 {idx:5318,when:1794841005918,tag:'5918_contract_tracker_scheduled_period'},
 {idx:5319,when:1794841005919,tag:'5919_contract_work_case_source_anchor'},
 {idx:5330,when:1794841005930,tag:'5930_contract_tracker_attention_summary'},
 {idx:5331,when:1794841005931,tag:'5931_contract_starting_setup_completion'},
] as const;
// Final pending 2109/2126 bytes reviewed from engine 128bc2539; no applied-prefix hashes change.
const APPROVED_UPGRADE_HASHES:Record<string,string>={
 '5902_shared_automation_permission_compatibility':'33a60c8951f539bf987f9ae5ecda727fbe9927083c6f35fdaf3a0025167a8ef5',
 '5931_contract_starting_setup_completion':'05ffef386dcc1c2f7612c700ce2d3be58185525f730659f4f507fbc29a78ce80',
 '5930_contract_tracker_attention_summary':'9446565465c8c8f1ec25cbef7f93df6672a03437a7b123b0237f7356e8cfa4a1',
 '5919_contract_work_case_source_anchor':'1a631a17f42da80d13ca08959c4968674e7524615d99bc002f476b5095267d27',
 '5918_contract_tracker_scheduled_period':'a0e74677822b8fd5c8d09e22cf0291c009cced94dbc5fa3fc446e8c44e69a898',
 '5917_contract_work_exact_document_join':'9a08bdc24d937c3c019f0246717c67e5810800017967c2a5eb6104c74e32cb2c',
 '5916_contract_ordinary_signing_company_gate':'cd7f5ad4d52dede9a0210796a92c10ed9721fa8ba7fcd37e68e8ea1519db13f0',
 '5915_contract_posting_durable_job_readiness':'d6d2471e14534c8b8e68aa0fba0d0d4e3a2341db2f027cd88320884787359171',

 '5913_contract_posting_native_completion':'b267d52c086b6dabda037ada30eb5902144a236f873916cd82829dc9e7036e26',
 '5838_contract_shared_email_task_projection':'6796ee897abfa5c088b1f215afc5889cc6d1d2b3557d0f0deaac710fb23c4214',
 '5837_contract_shared_email_self_binding':'d00b83a2300a3e26a25b79150d084d61fa224b688a43ccc4475b4e854d74c6d4',
 '5836_contract_shared_ending_actions':'26b4dd8d55fda25ea1f97f8e950243834555a4bc87a0110361a30d4d97c9cad9',
 '5822_contract_shared_ending_handoff':'93453d2576f82d89f1007e0d558d55ca4cd4c8de7175059ccb8faca66390d6dc',
 '5823_contract_shared_decline':'f8c314de620cdc82f282d35908b70677fabcd2c9ad81cd2753d5a27aa80adaef',
 '5824_contract_shared_offboarding':'cbd497768b3ea5731c999dda3cf9ac3389fefd8612352186e4eb3620ca69617f',
 '5825_contract_shared_email_document_lifecycle':'0e53c15e1a2f4d8be4095f1fa4e3baebbde9007bb5b9ccc63f41b8b2baa78cc7',
 '5817_contract_posting_receipts_and_tasks':'97f25f6436ae0dc36e62eaba6cc9432b5a71d4ad47774b70aa916c430f58c6a4',
 '5816_contract_posting_projections':'81a74ca3dbe2554756574c7684273a5ff7be69c615846482e794408459ed79da',
 '5815_contract_posting_movement_authority':'1eea9a234448186bbbfc90372deb53936b2ec92f34b87d6c08cb0567b7db0924',
 '5814_contract_shared_personnel_postings':'54a543202440caccc4e32f50eab39eecf76ae2497f2df850b6d6f8af02f793e3',
 '5912_contract_posting_source_projection':'c4b3003dfd78efecdf4e1f9674769dcb8aee9701593bc327cdba24cdb28e746e',
 '5911_contract_posting_canonical_assignment_receipt':'86d530dec94eb6cce45039e05adfba1a3b671764e5b8e687f1e5a64747f0b977',
 '5829_shared_automation_email_asset_delivery':'96c9f4fdbb02063c6335c1d7f83dd5273d94a33515159a883712f7b30a68c925',
 '5827_shared_automation_email_assets':'35f2cf530e008e6c47bc48f36640cc3f328a072ee29f73bb6523c41295485d66',
 '5840_shared_email_test_asset_source':'18e936754a6784f14911a82ea9654c2f3d8d2e9278d1d45c6663ce9c4e81a883',
 '5841_shared_email_case_file_pages':'bc583120fb2148723ec7dcbeb43aa8e12a8491c1c2c07922b8a6f33f76c58f32',
 '5828_automation_email_test_self':'2f14899f4fffb1c84cf20d6ba60b282b8f443a53471342611648583663a8afcc',
 '5826_automation_shared_assignment_groups':'4b112e626b80a509c6687fbfd3153bd56bd4ddfdda5cf1fb5c236f8bb9ff86f8',
 '5844_shared_groups_preserve_members':'3d5b0933efdee689848653da194bda914e93e7a94246c3b1345ad684e9e7ad9a',
 '5845_shared_groups_member_identity':'970591319022c650ce991c1ff6be1ad6ed7718fd8e7679f0dd88b7cb92fc4873',
 '5847_email_test_authority_utf8':'3ba274eada4346d5cfea1ac8dbb154e2f01374dab24325e45c9fabdd176a8186',
 '5846_email_test_current_human':'a3cd7270229682b341c50f05a7ef50fda655dcbc76d4deda66bc82b414318b0c',
 '5842_probation_shared_email_asset_proof':'b0deeef4ccebf79b41f57c8f44753c67a8039b50eea5414541ab87f81050bb15',
 '5910_contract_shared_work_page_null_guards':'51ecf59479ae4516b699ef3020b08bd1ea4aa6eaf9d4b7ac67ff80c1120a547d',
 '5834_contract_shared_email_compatibility':'73670275ddadbdfce99ec61ba758ab604afb841c3caa5650a1c8ffe95449138e',
 '5899_contract_shared_legacy_inbox_cutover':'7e03b54bd2375278e32aef835d2e88bf6fb017145bb3bf488ebffdd0a6dcc32e',
 '5849_contract_shared_case_references':'420746f8e5fc37017e9a87c125cbd457b67e4f99e35bad4ab058c5f66b450319',
 '5904_contract_shared_native_intake_guard':'2e3725db72f7f2a080a2a6d0db9fcd748e800ab2700e65616681c951732419c8',
 '5898_contract_shared_work_page':'f18a09d0a09539f502171b5d8e201298c75e627869c613f5cc90c9c0b71c0dca',
 '5897_contract_shared_period_history':'df2f4fd1dea25a1461fcb9e83bcdc21fc5d5658e6b9cb9618fb0f4f0807bbecc',
 '5832_contract_shared_starting_setup':'115b3dcb22d478e7e106a3bac40c8210ca925cf71bcfa726fea975090a42c2ee',
 '5833_contract_shared_tracker_retained_cases':'3d9992098d14c60bd6464b58b9a95a631238feb0bf09b0f4de019ac521934ca5',
 '5848_contract_shared_virtual_period':'d8686bc5d8eb4b862790f32b8a1e088aecf12d69f9a52a0ce0c077b7c2349018',
 '5835_contract_shared_review_wording':'557fbe13eab31a62eda92dce6e6bb33b0c82139ac3d1d547e4e5366bd41197aa',
 '5896_contract_shared_directory_and_signer_caption':'b76119936a00827c77ec3de038bf3fa3bb61d439559257b4795b7e83e885a0cf',
 '5820_contract_shared_case_workspace':'d463af063a32e5abbba0485bac85c2eade319e1363d40df6ccb4c11c688e4eba',
 '5821_contract_shared_assigned_work':'8880d4a73eb8b577e06ba4aec4d139b1bd0c693b8997e900b4d7dc1946c07d30',
 '5830_contract_shared_tracker_choices':'ffe03a1ed05a62c27ec5fc554c50f0fc1cff854e2dc21ff2428c7db49a77a65a',
 '5819_contract_shared_period_open':'ca6b1667583d3b8544f1a6d8b4eb3168140d67a9fc4c916b9fa98b03f2c49c3c',
 '5818_contract_shared_tracker':'b20ac0a47fb09b78bb02f71566726d0c3b09bb4f574d0e492c85cec4730a0daa',
 '5813_contract_shared_email_notifications':'dffc41e7da79471a45e00cf2fc8914107ac94978e856d40b863eef510f0a58eb',
 '5812_contract_shared_identity_context':'52297a99fc31f991954be72225bd15b1929de02fe0c798558498fb873f511345',
 '5811_contract_shared_worker_binding':'06f410b065580e27f79add6d988e0b3aaacb81ef786416ed395417860885d1e4',
 '5810_contract_shared_execution_adapters':'f166257ff49068e15adda1a78a3070df1661fb65fd67e08e76d1b65643fd10f9',
 '5808_contract_shared_signing':'580fb0f986a84218b127dad7276954331eba90e1398b3b46a4ba4f2b47a68c9d',
 '5809_contract_shared_decision_identity':'5e83fffd290b7cdbceb5d01b17c1b64241228dd905ac4738a721f3798787772b',
 '5807_contract_shared_commands':'e8c5737b8b0757fd2e3ce5c84b572a0933770fac76c6774d799eabcee91699d2',
 '5804_shared_email_rich_body':'96dd54e4b9bd66c015296ec0874b32c6de2af9af7c40b6f5812eaa7d3e408754',
 '5805_native_contract_counter_and_cutover':'caf0bdc349aa0f84c0edfeaeddff55f15318d235ba100c450062e497b929a9ac',
 '5806_contract_shared_projections':'02834a55469bd12ba44b5e6e299cda8f9374f4c22451b69958fac65e32344b25',
 '5800_contract_shared_access':'08671eb8f4654fb52af284d4202fc56f98befc38bca4bcab5b279cdb531dc756',
 '5801_contract_shared_flows':'12ff6216ebe82fcc0456ade8cf6a6f40d4daaf101782aa94136927e2f4f54382',
 '5802_contract_shared_builders':'c0fda7bf21a7d01dd214b7527736910eff7e0260962e1f67efda36ab2ffa97d0',
 '5803_shared_document_templates':'adce2251c00b32bb1913ef5c385f40782fdbb2c28274d3cc611c4305f77c0e12',
 '5761_probation_automation_recipients_and_tracker_steps':'c39e471adb80e51b56466c264bc6546dc6ce48a354e30d8e9ef3629a82b2184b',
 '5760_probation_queue_kinds_and_pbp_tasks':'c3ab5ddf4c702dd1ca947b3a350c7e852ab8699524c9da7fcad11f19887cdb59',
 '5150_attendance_policy_dated_rounding':'f1549fefc467398d9701ba5428e238134a8ca248fb645046b4b23877280e3408',
 '5145_ai_attendance_on_behalf_reads':'45f46d793d836371aebc7d7e20bcea000edef1a6e517367f8deffd59dd2ec9ff',
 '5144_attendance_lane_security_review':'a8b3b68d4ff8faa0f3f69f62089be537c1c8a7ba4522aefa5c3a5e8d314569ed',
 '5143_attendance_final_decision_window':'e048acb77ceb8115bebc25365c5f0b7a53a9981c7b2533312c0c460e5f6dca9d',
 '5142_attendance_on_behalf':'f6e733a3388ff70ffde812ce669b42b6a55decb3951584a8d8d420100d061125',
 '5141_attendance_workflow_escalation':'b578fbc0588c783b9091ae12753701e5e3322fc3fe53cbae60e5da18ce66ddde',
 '5140_attendance_workflow_cross_company_pending':'3fbdc8541c9ba5b9b03d7cb3a0e212df1db1b9e196822db575cc186bbb33c4c1',
 '5124_attendance_workflow_skipped_levels':'849dba4bf7c3aa39e45eb7f463ef24301a2eea3b10a781cf39858aa218635c6d',
 '5123_import_history_kind':'2da28686e0f48790491ed9677813be1fae9a71f1e9fbbe1c9b51786f401420e7',
 '5127_import_log_actor_labels':'1f90bf32091400f2ec667a8538802248a90bb1336c869a8b8faad349b2530ce2',
 '5129_payroll_history_effective_reads':'2df235f08c69d3547847e6bd8a3cafb1f774bc051ec51b2c2fcf50d8d07596e7',
 '5130_pay_formula_ai_draft_job':'842cf4996cdb4f3d0d8f26fcc205e774d5937f0d612122dafe2b5254e16e84ce',
 '5160_sweep_swing_thresholds':'5217e41181c030728ee879b45cc683c39bc9d7b9c7aed44c4c4abe88a230ee48',
 '5161_leave_team_minimum_present':'fa4c016e8aa6d259e8ec31bec4809c88b46f50dfd157d9ddaf251568623a4660',
 '5162_teras_loop_request_acts':'1b92edf3fe85d66954e50f5677bc1cf5122f8fe92faf22db636181c5ed8503f8',
 '5400_rewards_direct_configuration':'0e55f9de5d62ef07719a876ae208d9206ebc43d716c3bbdba02094a3cb997c6e',
 '5500_rewards_limit_controls':'3a710dc0103dd39b50c734243fd7f2691d6f08dbfb5d94d388d7664eb7ef93b0',
 '5520_rewards_role_permission_grid':'e603208c9cb9ada2e35a7338ede22637dcf886c5763912e5273adce0fd7ce172',
 '5540_rewards_offcycle_company_balance':'25bd51577444f2cea0a0c53a231156f591c6c2f0f0ce56e293aeae9d054850aa',
 '5420_rewards_dashboard_preparation_notices':'b0882911ef0802d34e67408810dfb455e935f25de54ac563460cd4b4755bef96',
 '5460_lifecycle_v9_email_recipients':'117d86c07c68c2bc658b4a33e26797bf23b040ad998fa948dbae1ad1307ef3d0',
 '5480_offboarding_items_assignment_load':'d5dc8975f26a9091f1bafd089aa36619b30eaa222b02ab09538ec63397d22ed3',
 '5560_rewards_limit_controls_role_level':'04d12b358fb70088e9bd9be95b64aa5014068a80035bafc5a2b605f5a308c619',
 '5580_rewards_config_owner_paths':'cf51650518408e4c4e5cc22823924b6fbcff130820be63887ba951f5520e60cd',
 '5600_rewards_config_editor_role_levels':'06a383842db72810be80aa8b276fe10e66236328afe8d4c28651b3d147792aff',
 '5620_rewards_config_grants_creator_lock':'8e322e3dd748f0295456595001e28b418e87a810a80577c821056abd1528538a',
 '5640_lifecycle_v9_email_hold_company_tenant':'66d191aaee14e910480bd7ce7240bd23a76f02e57c66f1c129f40b2562e7d6c7',
 '5660_pay_component_bonus_epf_bonus_2012':'b61c1f10cf2016da97ad257cdbd7b6f8ad8daf261a322fa5260dc0c54f6b6ddf',
 '5680_payroll_history_dated_company':'664b422a2a2128357932b0e0b036fa69ad731eb6c31aa6c4a8ce2a5b6e080faf',
 '5690_information_payslip_snapshot_from_history':'c0ea9c5f84f2dca7466aabdffb2d47d8af6ebd671add371ee49f00d93aedb892',
 '5695_employment_rehire_link':'58e9b0b1f01d0f03e2815ee43152e0bd0137114f7cdf1d79ace22ccb899407d6',
 '5696_information_correction_latest_saved':'235b556dd8c67cdecc2b5bda3859a627ef9a6f719766e36ca97b041fe1258f3e',
 '5740_automation_shared_definitions':'72baaa106846be4ede55607235a4555a0a0f38f6f0958183077c9e9f6dca0569',
 '5741_personnel_postings':'bac24f1f803408ee29db5915e69d47a72f981c45b5b6c5fee469831dcb800cb5',
 '5742_probation_settings_scope':'5b21bd348acedd68cd3267a973a8a62ec9c4f953ff7230e078db6ce50037655c',
 '5743_automation_email_templates':'5b82f328178b8bc5357acb830eceffd89337e13dd563eaec8f931f1f29bce3cd',
 '5744_probation_case_at_activation':'bade792a24fe3f31bc5c8afc1a40404d8919313711a2a050b1c6083b2095494a',
 '5745_probation_outcome_override_event':'450ad5d958411186348239940f3f16302bc17f7642a6e2e6bb3a63212a41a3ed',
 '5746_probation_tracker_scale_and_extensions':'6de6b3a28d10dd05bbb6dd37a84d6a30e42e67748636514ff94c4d04330b6432',
 '5747_document_signing_review_routing':'7fef112b3edec88c5ac54c7a17d8fa8354a96d618e353fa7b24894c925fc20dd',
 '5748_automation_runs':'06de500ccad8a64f68b37b7bd211404f2f717837b511949cc75aa16c8d733065',
 '5749_probation_delegation':'a57888eba4421d3ca4b2a3fdbe55065196005cfdffa7ed011615c6cef93e9dfd',
 '5750_probation_tracker_plan_robustness':'5acc2142a000baade0f4e01c5345fbc1114e9cc980f3a62689004cdfc9851123',
 '5751_probation_queues_and_form_routing':'378318141f25744883a7be53c5435f12acec38c60558bf24eff550d234809134',
 '5752_probation_letter_routing':'c8fa1384eb8fc2eb4111a00ae1210fff9f01ac5cc1687ae22ba635b0f86bb819',
 '5753_probation_outcome_automation':'764d407852799a3f0722417f062a602e996ba7907fd2e88d1005c563d748df93',
 '5755_probation_routed_assignment':'f1c0d942e5649071ff20eafab362dbaf363f2c1dc461684444d00480a3a81ac4',
 '5756_probation_form_approver_choices':'58c393bf5583abeb5a46bc6078ad756aee0691f24b3d68f80fec169218fe996e',
 '5757_probation_legacy_workflow_move':'16519f586b1f89c69f3758ac41cf5456cf4ae91bdd768bfe973e638982e86d21',
 '5758_probation_routed_overrides':'824f6d210d6d9361bf4132246ea40b4662c7e48cee8a67a4af269cca6740ec35',
 '5759_probation_employee_own_steps_only':'df0d15c2435048949c6436329d19db429696906dc2a8760086d9e8688af440f2',
 '5762_probation_form_import':'7accc885810776b61d2b4b5c292798f62aad1f2434280d80cc787d2946e8215d',
 '5763_probation_access_roles':'3a0bae544f30907238605bbf59f79816a130b08b886a2c9904d9ae137d8f9e40',
 '5764_probation_routed_holders':'30f0d7b6c019127bbce33b44061a88c092ba12c803d307cd19d828bdcba9826a',
 '5765_probation_letter_signers':'989f12a1f048f924609e6c881c476bb272f256695e8595f7436f1c3f65adfcd5',
 '5766_probation_reshape_company_in_use':'5f47f0f77e115d29927b9c227b03ec79c5b726c051e31303f14cdb1ab70751dd',
 '5754_automation_email_delivery':'bd1dc53c5461299006b240e7fb3fd25801a5aaaa3b6807be8995f858ffe57c05',
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
 '5010_employee_import_staged_job':'75b8691265788892e2bf3cc885280a804e4528730fb9c461e77a4a6426670ff6',
 '5011_bulk_job_kernel':'50af4670d06419c82ec7495827cf14db2905fda780b21ee58f17ae2f1df7af58',
 '5012_import_release_visibility':'f0ac24138bdfecb5c2eea63a724808c119db86cc1719936b7f839473c7396ac8',
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
 '5055_payroll_history_staged_job':'52b094d559f748ff638bdaff0575ad97bce1a1312a719ed1508e25b90333e69b',
 '5056_payroll_reprocess_job':'9c060255355bcb74569ffde8d8974ab433cfaa4a319c837b874abd1a33bcb57c',
 '5060_register_section_import_jobs':'208d2d40dd1c9b6a5c3cc061ac6a9f282e8f20eb1309c69aeb0e15c2a5088346',
 '5061_register_import_set_release':'2e58415bc1ba2925268df41bf07d3b9cf802f274e01476b336b7dd207b843efe',
 '5062_employee_import_revert_job':'1e48068ba30160e2a94e5e511a5dd68bf23f5f968f5fd675da39cc11599d8d43',
 '5063_register_import_release_key_authority':'ae0827b9a2cc63fdc9a2485d4e2762f34800c070da43e2e5b4b2bb2567316f40',
 '5064_employee_import_revert_release_hash':'8862489275a2132ff64547b7e1641afd43c57a2cc4f1660ff9a3a8464d2ff568',
 '5070_system_label_import_staged_job':'9d30e4768feb5b5c0de4bbbe40ec149d746216efdabfa55a9dea3327b93b3270',
 '5071_workforce_capability_tenant_publication':'4d22cd648ea0698c5ce230461862fc4c93e61cbc9196800e0317b680d694a311',
 '5075_bulk_job_movement_import':'11a734038c4f7d7dd31e3f342a1d85103365f7b13f2936bd6c1348f7f30ce190',
 '5076_workforce_employment_access_set':'0e1c2bce56e6ee1380bae2451d2d7ab83b6fff9b33a5eddba2d247595fbc995f',
 '5077_bulk_job_movement_check':'3abc199fe1d6602b771e9c205d5b4f1be15133b10f9deec2f4b33e50d26a4dc1',
 '5078_bulk_job_movement_import_revert':'de9210cf356101a69c19ea695bdc6b7ccc6ec9e0667e19b82e4b1d20dda98f5d',
 '5079_movement_revert_capture':'0e334a7236ee9a2ae433b28bce3e7e011aa8cee9407bea46ca4a225cf6f2d47c',
 '5080_access_administrator_coalesced_assert':'721af90b5e4554c36ce39ee8e8db2ae6b53bdfa2cabc0029b990bd0f78cfd1f2',
 '5081_reward_access_observation_due':'f55738cd1422d1c955c722869e0328f9dcafafeb0042fd2b137165606663460a',
 '5082_home_own_clock_day':'345c604cebcc58946865d6cc93cd248ad693165063a67648d6781243ec652c58',
 '5083_home_own_schedule_range':'75045a4ec8c176c55ddc51ddba0b079e6ca8c5662b004a345945ee335efce70a',
 '5090_audit_chain_commit_seal':'6ce9bebe8c8de296b3b4a03b1d5d52c90c7df79fbdb0b8f8e0617616001e263e',
 '5120_access_review_custody_held_mode':'f99d6938631f4ae17dea7af03b56d5dad4830ef5402b206b097e25ea4854c2a0',
 '5121_personnel_search_set_mapping':'3d9b5a53b963a0f01843d090a96662da3e9f7b5c5bb0650e3064d237a3c60d54',
 '5125_individual_txn_pricing_marker':'d48a8a3e394da801bbb0e9917d74d934ab51a3470bdea1bc8d8be1b110a24837',
 '5126_contract_internship_end_dates':'cbc405c4dde11abbe8f298feaf4af0795c8cf742701f62565547eb9ec9d10796',
 '5770_attendance_workflow_approver_codes':'f71cf33a9ced5f4e1007de02388a858bd31c64006a422352193bd7c14e367ec0',
 '5771_assistant_legacy_index_shared_access':'433dfd7549b496b034bdeaa2c06484b700b5dd5647213106d68487f0b485c7c0',
 '5783_resignation_journey':'130c0b99586bc316ac5203d27a65bfc0a565c4f608b8ab1ac336a8e8d41d1216',
 '5784_resignation_configuration':'6e064c336c441fbbf01017debe9e1a748957976d3d6b2b96470747d07d7dacb5',
 '5785_resignation_postings':'5d26a0f446c3e72ed01861544af395690b08cdce47b9fc739f0b0d7d1b22a4f5',
 '5786_resignation_email_delivery':'52bf3fa8f4430d37fd4dabd2164f00764e73245b38ee6520d2816dca7e03459b',
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
/** Every nullable column the combined release block (docs/MIGRATION-ALLOCATION.md, 5000-5090) appends to a table
 * that already holds rows: its ALTER TABLE ... ADD COLUMN statements, by migration. No row that predates the block
 * may hold a value there. migrateApprovedUpgrade proves each column present and null on every row once its
 * migration is applied; a retained row is then compared without it (withoutCombinedReleaseNulls). */
export const COMBINED_RELEASE_NULL_COLUMNS:readonly {tag:string;table:string;columns:readonly string[]}[]=Object.freeze([
 {tag:'5808_contract_shared_signing',table:'contract_shared_letter',columns:['signing_document_id','decision_revision','workflow_run_id','workflow_step_id']},
 {tag:'5809_contract_shared_decision_identity',table:'contract_shared_case_revision',columns:['actor_person_id','actor_name']},
 {tag:'5810_contract_shared_execution_adapters',table:'contract_shared_event',columns:['root_event_id']},
 {tag:'5804_shared_email_rich_body',table:'automation_email_template_version',columns:['body_doc']},
 {tag:'5805_native_contract_counter_and_cutover',table:'employment',columns:['contract_number']},
 {tag:'5010_employee_import_staged_job',table:'employment',columns:['import_pending_attempt_id']},
 {tag:'5010_employee_import_staged_job',table:'person',columns:['import_pending_attempt_id']},
 {tag:'5012_import_release_visibility',table:'domain_event',columns:['import_pending_attempt_id']},
 {tag:'5031_leave_ledger_stage',table:'leave_ledger',columns:['stage_id']},
 {tag:'5036_leave_type_pending_year_cycle',table:'leave_type',columns:['pending_year_cycle_job_id']},
 {tag:'5051_payroll_processing_job',table:'payroll_batch',columns:['processing_job_id','processing_started_at']},
 {tag:'5125_individual_txn_pricing_marker',table:'payroll_individual_txn',columns:['pricing_source','pricing_ref','priced_at']},
 // daa76ed4 Escalation Approval stage clock: NULL on every request submitted before it (never escalates).
 {tag:'5141_attendance_workflow_escalation',table:'attendance_workflow_request',columns:['stage_reached_at','escalate_on']},
 // 96a54ed2 Request On Behalf: NULL on every application filed before it (the employee filed it).
 {tag:'5142_attendance_on_behalf',table:'attendance_correction',columns:['submitted_by_user_id','submitted_by_person_id','submitted_by_name']},
 // 5161 (draft 9770): the team minimum is unset (no minimum) on every company that predates it.
 {tag:'5161_leave_team_minimum_present',table:'company',columns:['leave_team_minimum_present']},
 // Board 511aa74a (5695): no employment that predates it was rehired from another period.
 {tag:'5695_employment_rehire_link',table:'employment',columns:['rehired_from_employment_id']},
 {tag:'5760_probation_queue_kinds_and_pbp_tasks',table:'probation_outcome',columns:['extension_months']},
 {tag:'5785_resignation_postings',table:'personnel_posting',columns:['rejected_by','rejected_at','rejection_reason','due_on','baseline_values']},
 ...['department','position','cost_center','business_unit','label_company_assignment','profile_option','job_grade','grade_group','grade_group_member']
  .map(table=>({tag:'5070_system_label_import_staged_job',table,columns:['import_pending_attempt_id']})),
]);
// Snapshot keys that name a widened table by another word.
const SNAPSHOT_TABLE_ALIASES:Readonly<Record<string,string>>={audit:'domain_event',people:'person'};
/** A retained row of a widened table, compared without the combined release's columns. Each one the row carries
 * must be null; a row that lacks them (an original-column capture) is returned unchanged. */
export function withoutCombinedReleaseNulls(name:string,row:Row):Row{
 const tableName=name.replace(/^public\./,''),target=SNAPSHOT_TABLE_ALIASES[tableName]??tableName;
 let normalized=row;
 for(const entry of COMBINED_RELEASE_NULL_COLUMNS)if(entry.table===target)for(const column of entry.columns){
  if(!Object.hasOwn(normalized,column))continue;
  expect(normalized[column],tableName+'.'+column+' ('+entry.tag+') on a retained row').toBeNull();
  const {[column]:_added,...original}=normalized;normalized=original;
 }
 return normalized;
}
/** After the complete migrate: each column whose migration the applied journal holds exists, and no row holds a value. */
async function assertCombinedReleaseNulls(db:Database,migrationsFolder:string){
 const applied=new Set((JSON.parse(readFileSync(join(migrationsFolder,'meta/_journal.json'),'utf8')).entries as {tag:string}[]).map(entry=>entry.tag));
 for(const entry of COMBINED_RELEASE_NULL_COLUMNS){
  if(!applied.has(entry.tag))continue;
  for(const column of entry.columns){
   expect(await db.client`select 1 as present from information_schema.columns where table_schema='public' and table_name=${entry.table} and column_name=${column}`,entry.table+'.'+column+' added by '+entry.tag).toEqual([{present:1}]);
   expect(await db.client.unsafe('select count(*)::int as held from public."'+entry.table+'" where "'+column+'" is not null'),entry.table+'.'+column+' is null on every upgraded row').toEqual([{held:0}]);
  }
 }
}
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
  // The combined release appends nullable columns (5012 adds the staged-import marker to domain_event). Each is
  // present and null on every upgraded row, and only then is a retained event compared without it.
  await assertCombinedReleaseNulls(db,migrationsFolder);
  expect((await table(db,'public.domain_event')).map(row=>withoutCombinedReleaseNulls('domain_event',row))).toEqual(eventsAfter);
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
  // A combined-release column must be null on the row before the row is compared without it.
  let normalized=withoutCombinedReleaseNulls(tableName,row);
  if((tableName==='reward_unit'||tableName==='units')&&Object.hasOwn(row,'preparation_required')){
   expect(row.preparation_required,'historical reviews retain unrecorded preparation, never fabricated release proofs').toBe(false);
   const {preparation_required:_preparation,...original}=normalized;normalized=original;
  }
  if(tableName==='pay_component'&&Object.hasOwn(row,'applied_company_ids')){
   expect(row.applied_company_ids,'legacy Pay Items retain all-company availability').toBeNull();
   const {applied_company_ids:_companies,...original}=normalized;normalized=original;
  }
  if(tableName==='company'&&row.display_group_field===null&&row.display_group_option_id===null){
   const {display_group_field:_field,display_group_option_id:_option,...original}=normalized;
   normalized=original;
  }
  if(witness){
   const additions=tableName==='domain_event'||tableName==='audit'?witness.events:tableName==='access_group_grant'?witness.grants:tableName==='access_user_override'?witness.overrides:[];
   const added=additions.find(value=>value.id===row.id);
   if(added){const raw=witness.eventsRaw.find(value=>value.id===row.id);expect([canonical(added),...(raw?[canonical(raw)]:[])]).toContain(canonical(normalized));return [];}
   const pairs=name==='app.access_profile_write_generation'?witness.generations:tableName==='access_configuration'?witness.configurations:[];
   const pair=pairs.find(value=>value.after.tenant_id===row.tenant_id);
   if(pair){
    // Fixtures may compare only their original columns. Each present changed field must match
    // the fully validated transition before its original value is restored for comparison.
    normalized={...normalized};
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
