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
 {name:'runs the 21 exact synthetic browser issuer and held evidence source models',file:'.github/ci/native-workload-browser-issuer.test.py',count:21,classes:[
   ['HeldEvidenceModel',[
    'test_changed_driver_identity_survives_recheck_pidfd_close_failure',
    'test_distinct_held_browser_roles_and_renderer_reuse_actual_kernel_checks',
    'test_exact_private_observer_rejects_other_roles_realms_and_extra_bytes',
    'test_held_pipe_reads_a_frame_and_refuses_surplus_at_terminal_eof',
    'test_tls_reconciliation_has_one_exact_url_status_body_and_certificate',
   ]],
   ['SyntheticTranscriptModel',[
    'test_observer_transcript_does_not_accept_synthetic_readiness',
    'test_synthetic_decoy_has_one_canonical_run_scope_and_no_observer_authority',
    'test_synthetic_readiness_does_not_extend_the_first_deadline',
    'test_synthetic_readiness_refuses_observer_data_or_extra_fields_permanently',
    'test_synthetic_readiness_runs_the_exact_remaining_role_and_counter_sequence',
    'test_wrong_role_or_repeated_synthetic_readiness_poison_the_transcript',
   ]],
   ['TranscriptModel',[
    'test_actual_role_pipe_refuses_child_output_observed_before_root_turn',
    'test_an_unexpected_packet_cannot_be_replaced_by_a_correct_one',
    'test_driver_connection_cannot_start_before_third_transport_eof',
    'test_exact_frames_use_distinct_role_pipes_and_bound_the_counter_windows',
    'test_initial_unowned_fence_and_aliased_role_channels_refuse',
    'test_missing_eof_preserves_primary_and_closes_other_pipes',
    'test_out_of_order_root_and_child_frames_poison_without_writes',
    'test_partial_transcript_is_terminal_before_any_descriptor_close',
    'test_timeout_rejects_before_consuming_first_frame',
    'test_wrong_counter_window_poison_preserves_fence',
   ]],
  ]},
 {name:'runs the 12 exact synthetic browser TLS fixture and tripwire source models',file:'.github/ci/native-workload-browser-capability-fixture.test.py',count:12,classes:[
   ['FixtureModels',[
    'test_browser_admission_requires_the_single_validated_independent_probe',
    'test_controlled_tls_shutdown_keeps_want_read_and_ragged_eof_distinct',
    'test_crypto_retains_leader_until_group_signal_and_observed_group_absence',
    'test_crypto_unknown_settlement_refuses_fixture_release_and_keeps_private_writers',
    'test_failed_crypto_launch_retains_exact_held_writers_without_releasing_fixture',
    'test_fixed_navigation_and_private_probe_are_distinct',
    'test_late_queued_traffic_keeps_failure_even_after_positive_listener_cleanup',
    'test_only_one_armed_bare_tcp_eof_settles_inside_same_counter_clock',
    'test_other_paths_authority_credentials_and_payload_refuse',
    'test_queued_split_tls_record_and_premature_eof_refuse_before_response',
    'test_tripwire_accepts_no_protocol_and_fails_the_course',
    'test_unsettled_thread_does_not_authorize_closing_either_held_listener',
   ]],
  ]},
 {name:'runs the 6 exact synthetic browser launch plan source models',file:'.github/ci/native-workload-browser-launch-plan.test.py',count:6,classes:[
   ['SyntheticLaunchPlanModels',[
    'test_browser_has_fixed_server_probe_and_chromium_view_without_driver_files',
    'test_driver_has_only_fixed_synthetic_credential_and_playwright_view',
    'test_driver_refuses_wrong_path_or_decoy_and_other_roles_refuse_credentials',
    'test_non_synthetic_scope_malformed_identity_and_sibling_stage_refuse',
    'test_only_browser_accepts_one_canonical_spki',
    'test_third_has_only_fixed_python_probe_and_no_writable_role_view',
   ]],
  ]},
 {name:'runs the 5 exact synthetic browser preimport gate source models',file:'.github/ci/native-workload-browser-preimport-gate.test.py',count:5,classes:[
   ['SyntheticPreimportGateModels',[
    'test_exact_pure_argv_and_closed_arguments',
    'test_inline_rechecks_argv_role_identity_and_reciprocal_pipes_before_ready',
    'test_one_ready_and_grant_restore_stdio_then_replace_exact_role_process',
    'test_pregate_io_refuses_prequeued_short_wrong_and_surplus_packets',
    'test_same_absolute_frontier_refuses_expired_future_and_late_grant',
   ]],
  ]},
 {name:'runs the 35 exact protected archive custody source models',file:'.github/ci/native-workload-browser-tool-course.test.py',count:35,classes:[
   ['ToolDisposalModels',[
    'test_complete_requires_both_actual_absence_facts_and_live_absolute_boundary',
    'test_foreign_or_replaced_mount_never_triggers_unmount',
    'test_observed_owned_mount_and_real_absence_are_both_required',
    'test_partial_precreated_slot_can_be_reclaimed_but_same_name_replacement_is_preserved',
    'test_primary_operation_failure_survives_later_owned_settlement_refusal',
    'test_private_mount_readback_reopens_the_current_namespace_before_owning_or_releasing',
    'test_protected_archive_scope_holds_order_and_refuses_changed_inputs',
   ]],
   ['ToolIntentModels',[
    'test_foreign_event_and_incompatible_modes_refuse_before_acquisition',
    'test_only_exact_real_native_job_and_manual_self_source_enter',
    'test_owner_capture_refuses_contradictory_process_and_cleanup_claims',
    'test_receiver_requires_bounded_seekable_and_exactly_sealed_transport',
    'test_refusal_capture_closes_unknown_and_positive_cleanup_shapes_separately',
    'test_returned_pre_root_refusal_is_bounded_and_kill_or_partial_is_not_a_receipt',
    'test_success_capture_requires_closed_owner_shape_and_positive_settlement',
    'test_tool_capsule_binds_fixed_package_metadata_and_actual_git_blob_shape',
   ]],
   ['ToolTransportModels',[
    'test_absolute_settlement_bound_refuses_late_signal_or_late_reap',
    'test_actual_owned_process_summary_and_absolute_reserve_gate_success',
    'test_child_refuses_late_ack_at_shorter_handshake_stop_before_native_exec',
    'test_downloader_waits_for_exact_grant_and_terminal_channel_before_tls',
    'test_duplicate_or_foreign_adoption_census_cannot_signal_or_reap_foreign_pid',
    'test_every_delivered_right_closes_before_framing_refusal',
    'test_exact_generation_and_length_and_fixed_npm_http_framing',
    'test_held_downloader_status_reads_complete_eof_before_the_same_frontier',
    'test_identity_reason_requires_the_exact_owned_downloader_exit_in_the_receipt',
    'test_identity_refusals_preserve_order_and_require_zero_after_both_admitted_policies',
    'test_incomplete_and_overcap_bodies_are_framing_refusals_before_overcap_write',
    'test_late_written_ack_keeps_real_group_proof_through_owned_refusal_reap',
    'test_pregrant_eof_keeps_the_owned_exit_and_cannot_succeed',
    'test_ready_identity_readback_at_active_edge_never_acknowledges',
    'test_redirect_partial_encoding_duplicate_and_wrong_generation_refuse',
    'test_setup_consumes_absolute_stop_before_ack_and_settles_with_original_reserve',
    'test_unreaped_or_still_live_child_never_permits_owned_disposal',
    'test_writer_capabilities_require_five_fresh_disjoint_write_only_inodes',
    'test_writer_grant_requires_held_native_identity_slots_and_no_late_send',
    'test_writer_transport_delivers_exact_kernel_credentials_cloexec_and_terminal_eof',
   ]],
  ]},
 {name:'runs the 15 exact fixed synthetic tool installation source models',file:'.github/ci/native-workload-browser-tool-installation.test.py',count:15,classes:[
   ['PrivateToolInstallationModels',[
    'test_actual_readback_rejects_same_size_change_replacement_and_extra_name',
    'test_elapsed_deadline_refuses_initially_and_after_complete_filesystem_readback',
    'test_entry_bound_counts_implicit_directories_before_creating_file',
    'test_file_ancestor_collision_never_opens_a_conflicting_path',
    'test_fixed_four_archive_bytes_and_staging_modes_reconcile_every_installed_member',
    'test_foreign_entry_or_symlink_refuses_before_mutating_held_root',
    'test_hardlink_and_symlink_refuse_readback_without_touching_external_bytes',
    'test_synthetic_abort_does_not_adopt_a_creation_without_held_birth',
    'test_synthetic_abort_keeps_known_file_birth_after_partial_write',
    'test_synthetic_capacity_and_exact_projection_refuse_without_publishing',
    'test_synthetic_stage_checks_four_inputs_and_returns_only_verified_browser_births',
    'test_synthetic_stage_refuses_unwritten_postgres_lock_framing_and_entrypoint',
    'test_unpinned_browser_refuses_before_creating_staged_outputs',
    'test_valid_sri_with_late_bad_tar_padding_never_returns_a_tree',
    'test_wrong_root_kind_or_mode_refuses_before_any_archive_read',
   ]],
  ]},
 {name:'runs the 7 exact manager launch view source models',file:'.github/ci/native-workload-browser-launch-view.test.py',count:7,classes:[
   ['LaunchViewModels',[
    'test_allocations_require_both_fragment_space_and_inode_reserves',
    'test_manager_namespace_or_stage_replacement_refuses_before_publication',
    'test_mountinfo_fd_identity_flags_and_foreign_mounts_fail_closed',
    'test_postview_mount_namespace_path_and_clock_drift_are_refusals',
    'test_run_and_capacity_inputs_cannot_choose_another_path_or_unbounded_allocation',
    'test_same_backing_stage_uses_two_namespace_local_mount_ids_and_closes_owned_fds',
    'test_same_pid1_birth_requires_fixed_protected_binary_and_all_four_root_uids',
   ]],
  ]},
 {name:'runs the 5 exact synthetic source finalization source models',file:'.github/ci/native-workload-browser-synthetic-stage.test.py',count:5,classes:[
   ['SyntheticStageModels',[
    'test_actual_inode_and_mode_readback_with_only_new_content_reads',
    'test_bad_archive_binding_refuses_before_any_mutation',
    'test_inheritable_or_unowned_stage_never_opens_a_finalizer',
    'test_role_directory_attempt_without_held_birth_is_retained_unknown',
    'test_wrong_new_content_preserves_known_nonexecutable_inode',
   ]],
  ]},
 {name:'runs the 11 exact owned role process source models',file:'.github/ci/native-workload-browser-host.test.py',count:11,selector:'BrowserHostMainProcessModel',classes:[
   ['BrowserHostMainProcessModel',[
    'test_both_roles_hold_one_pidfd_and_immutable_identity_through_exact_node_exec',
    'test_late_native_observation_cannot_return_and_still_releases_owned_fds',
    'test_refuses_child_cloexec_on_either_endpoint',
    'test_refuses_foreign_fdinfo_inode_or_mount_even_when_named_pipe_is_exact',
    'test_refuses_foreign_initial_user_pid_time_or_network_namespace',
    'test_refuses_inherited_capabilities_even_when_current_sets_are_zero',
    'test_refuses_input_replaced_during_output_observation_and_closes_both_pins',
    'test_refuses_reused_birth_changed_cgroup_and_pidfd_terminal',
    'test_refuses_same_executable_path_with_foreign_inode_or_changed_exact_argv',
    'test_refuses_swapped_aliased_wrong_mode_and_inheritable_pipe',
    'test_third_has_only_original_python_path_and_requires_its_own_uid',
   ]],
  ]},
 {name:'runs the 6 exact synthetic stage cleanup source models',file:'.github/ci/native-workload-browser-synthetic-stage-cleanup.test.py',count:6,classes:[
   ['SyntheticStageCleanupModels',[
    'test_known_partial_installer_output_can_be_removed_without_finalizer',
    'test_member_on_another_mount_refuses_before_any_removal',
    'test_pending_creation_or_unknown_entry_preserves_the_whole_stage',
    'test_removes_only_exact_stage_after_positive_fresh_view_recheck',
    'test_replaced_inode_refuses_even_if_bytes_and_mode_match',
    'test_root_name_survives_failed_manager_view_recheck',
   ]],
  ]},
] as const;

it.each(suites)('$name',suite=>{
 const {file,count,classes}=suite;
 const expected=classes.flatMap(([owner,methods])=>methods.map(method=>method+' (__main__.'+owner+'.'+method+') ... ok'));
 expect(expected).toHaveLength(count);
 expect(new Set(expected).size).toBe(count);
 const args=['-I','-B',file,'-v'];
 if('selector' in suite)args.push(suite.selector);
 const result=spawnSync('/usr/bin/python3',args,{
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
