/** Bounded source models. These checks confer no native browser capability. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const suites=[
 {name:'runs the 17 exact browser archive and toolchain source models',file:'.github/ci/native-workload-browser-toolchain.test.py',count:17,classes:[
   ['StrictToolchainArchiveModels',[
    'test_browser_rejects_synthetic_transfer_before_parser_even_at_expected_size',
    'test_combined_tree_budget_accounts_for_implicit_parents_before_each_package',
    'test_complete_zip_checks_actual_bytes_modes_and_both_classic_descriptor_shapes',
    'test_executable_program_table_and_tree_parent_are_independent_checks',
    'test_expanded_and_path_limits_refuse_under_a_single_elapsed_deadline',
    'test_package_sri_identity_precedes_any_tar_parsing',
    'test_parse_consumed_package_bytes_must_match_the_initial_locked_digest_and_extent',
    'test_raw_deflate_requires_natural_exact_end_and_independent_crc',
    'test_sri_match_alone_cannot_substitute_package_or_browser_manifest',
    'test_tar_end_cannot_hide_a_gzip_suffix_second_member_or_invalid_footer',
    'test_tar_keeps_explicit_directory_and_rejects_v7_alias_and_reserved_bytes',
    'test_tar_octal_fields_match_native_decode_without_ignored_digits',
    'test_tar_refuses_extended_entries_links_privilege_duplicates_and_nonzero_padding',
    'test_three_fictional_lock_sri_archives_admit_exact_known_package_entrypoints',
    'test_zip_refuses_bad_local_identity_overlap_preamble_and_descriptor',
    'test_zip_refuses_dos_directory_and_volume_flags_on_regular_members',
    'test_zip_refuses_hidden_central_members_zip64_extra_and_local_aliases',
   ]],
  ]},
 {name:'runs the 25 exact browser host and settlement source models',file:'.github/ci/native-workload-browser-host.test.py',count:25,classes:[
   ['BrowserHostModel',[
    'test_browser_reply_has_original_connection_proof_and_only_exact_allowlisted_ports',
    'test_counter_windows_refuse_missing_moved_and_unattributed_events',
    'test_exact_seventeen_frame_course_requires_final_role_exit_messages',
    'test_final_control_deny_checks_only_actual_listener_before_any_other_role_allow',
    'test_frame_refuses_wrong_order_duplicates_size_false_pid_and_incomplete_probe',
    'test_only_one_real_address_and_owner_can_name_the_listener',
    'test_readback_checks_exact_order_counter_shape_and_rule_bytes',
    'test_renderer_must_be_in_the_same_family_with_more_filters_and_both_namespaces_distinct',
    'test_role_census_includes_all_uid_gid_and_supplementary_slots',
    'test_role_policy_keeps_direct_socket_abi_and_ring_fences',
    'test_terminal_base_hooks_refuse_competitors',
   ]],
   ['BrowserHostSettlementModel',[
    'test_actual_task_census_refuses_sibling_reserved_uid_gid_and_group',
    'test_expired_active_frontier_refuses_before_spawn',
    'test_expired_cleanup_frontier_retains_child_without_late_signal_or_wait',
    'test_failed_nft_retains_first_error_and_actual_uncertain_child_under_original_clock',
    'test_late_absence_inventory_keeps_last_proven_handles_and_delete_attempt',
    'test_late_initial_readback_retains_protection_without_birth_proof',
    'test_late_readback_does_not_publish_new_counters',
    'test_late_zero_wait_refuses_after_clearing_the_proven_reap',
    'test_nft_reaped_nonzero_exit_refuses_without_another_signal',
    'test_observer_source_binds_warm_and_reserved_scalar_facts_before_report',
    'test_segmented_native_reads_require_eof_and_retain_later_listener',
    'test_task_budget_is_aggregate_and_new_live_sibling_requires_observation',
    'test_task_census_refuses_missing_status_and_missing_task_dir_with_live_group_path',
    'test_uncertain_firewall_delete_cannot_retry_the_native_mutation',
   ]],
  ]},
] as const;

it.each(suites)('$name',({file,count,classes})=>{
 const expected=classes.flatMap(([owner,methods])=>methods.map(method=>method+' (__main__.'+owner+'.'+method+') ... ok'));
 expect(expected).toHaveLength(count);
 expect(new Set(expected).size).toBe(count);
 const result=spawnSync('/usr/bin/python3',['-I','-B',file,'-v'],{
  cwd:root,env:{PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8',TZ:'UTC'},encoding:'utf8',
  timeout:10000,killSignal:'SIGKILL',maxBuffer:128*1024,stdio:['ignore','pipe','pipe'],
 });
 process.stdout.write(result.stdout??'');
 process.stderr.write(result.stderr??'');
 expect(result.error).toBeUndefined();
 expect(result.signal).toBeNull();
 expect(result.status).toBe(0);
 expect(result.stdout).toBe('');
 expect(result.stderr.split('\n')).toEqual([
  ...expected,'','-'.repeat(70),expect.stringMatching(new RegExp('^Ran '+count+' tests in [0-9]+\\.[0-9]{3}s$')),'','OK','',
 ]);
});
