/** Bounded source models. These checks confer no native browser capability. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const suites=[
 {name:'runs the 7 exact native navigation history custody models',file:'.github/ci/native-workload-navigation-source.test.py',count:7,classes:[
   ['NativeNavigationHistoryModel',[
    'test_exact_current_roots_and_four_whole_tracked_checkout_objects',
    'test_exact_length_incorrect_real_file_is_not_a_history_fact',
    'test_first_real_stream_has_no_result_after_clock_closes',
    'test_live_caps_and_original_member_limit_hold_with_history',
    'test_missing_duplicate_renamed_foreign_and_invalid_roles_refuse_before_read',
    'test_named_file_replacement_during_read_does_not_validate_held_inode',
    'test_symlink_hardlink_and_nonregular_refuse_through_pinned_tree',
   ]],
  ]},
 {name:'runs the 15 exact browser issuer transcript and settlement models',file:'.github/ci/native-workload-browser-issuer.test.py',count:15,classes:[
   ['HeldEvidenceModel',[
    'test_changed_driver_identity_survives_recheck_pidfd_close_failure',
    'test_distinct_held_browser_roles_and_renderer_reuse_actual_kernel_checks',
    'test_exact_private_observer_rejects_other_roles_realms_and_extra_bytes',
    'test_held_pipe_reads_a_frame_and_refuses_surplus_at_terminal_eof',
    'test_tls_reconciliation_has_one_exact_url_status_body_and_certificate',
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
