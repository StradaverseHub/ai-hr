/** Reviewed dormant browser role models for the standard hosted NODB gate. */
import {spawnSync} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const prefix='.github/ci/native-workload-browser-';
const env={PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8',TZ:'UTC'};
const suites=[
 {name:'runs the 16 exact runtime layout source models',stem:'runtime-layout',count:16,owner:'RuntimeLayoutModel',methods:[
  'test_absolute_deadline_and_borrowed_fd_closure_do_not_admit_later_checks',
  'test_active_fixed_recheck_leaves_scratch_unknown_and_empty_check_refuses',
  'test_exact_layout_matches_existing_bind_union_and_all_fixed_metadata',
  'test_existing_foreign_top_symlink_refuses_before_any_layout_write',
  'test_failed_final_manager_readback_cannot_publish_ready_layout',
  'test_foreign_mount_or_same_content_replacement_refuses_on_held_recheck',
  'test_invalid_or_expired_role_deadline_refuses_before_native_admission',
  'test_lost_directory_birth_retains_pending_and_refuses_second_attempt',
  'test_read_only_checks_use_original_active_and_cleanup_frontiers_after_preparation',
  'test_readbacks_crossing_their_own_postcheck_frontiers_cannot_return',
  'test_rejects_wrong_stage_scope_without_layout_mutation',
  'test_role_deadline_crossed_during_target_read_stops_before_next_native_scan',
  'test_role_deadline_is_the_narrower_native_read_bound_and_never_extends_course_or_view',
  'test_role_view_completion_at_earlier_deadline_cannot_return_snapshot',
  'test_short_canary_write_retains_known_file_birth_without_ready_layout',
  'test_unattempted_layout_cannot_begin_at_preparation_frontier',
 ]},
 {name:'runs the 9 exact service view source models',stem:'service-view',count:9,owner:'ServiceViewModels',methods:[
  'test_both_layout_reads_use_original_role_cutoff_and_late_observation_cannot_publish',
  'test_descendant_mount_id_mode_inode_sibling_and_native_exec_flags_refuse',
  'test_each_home_mask_or_scratch_omission_refuses_for_all_roles',
  'test_exact_mount_topology_for_all_role_sets_and_private_slave_mount',
  'test_fixed_scratch_and_home_mask_are_stable_auxiliary_not_runtime_grants',
  'test_held_pidfd_must_report_same_native_pid_before_process_root_lookup',
  'test_inode_bound_executables_empty_placeholders_and_exact_tree',
  'test_live_scratch_joins_owned_home_and_scratch_births_native_mount_and_writable_flags',
  'test_wrong_parent_source_flags_shared_nested_or_alias_mount_refuses',
 ]},
 {name:'runs the 13 exact wrapper source models',stem:'wrapper',count:13,owner:'WrapperModels',methods:[
  'test_ack_checks_parent_death_first_and_rejects_surplus_or_wrong_peer',
  'test_control_requires_single_credentials_and_closes_received_rights_on_refusal',
  'test_exact_helper_argv_environment_and_four_fd_actions',
  'test_exact_prepare_data_refuses_arbitrary_commands_environment_and_later_time',
  'test_helper_closes_private_fds_after_one_ack_before_exact_exec',
  'test_non_capsule_entry_refuses_before_touching_control',
  'test_parent_loss_expired_slot_or_stdio_change_after_ack_never_executes',
  'test_parent_witness_refuses_changed_birth_or_time_namespace',
  'test_queued_control_before_readiness_never_grants_or_executes',
  'test_returned_pid_remains_data_even_after_complete_cleanup_slot',
  'test_same_length_changed_source_and_unsafe_capsule_file_refuse',
  'test_stock_command_is_built_from_only_the_three_verified_capsule_members',
  'test_stock_exec_restores_explicit_native_signal_policy',
 ]},
 {name:'runs the 12 exact wrapper parent source models',stem:'wrapper-parent',count:12,owner:'ParentModels',methods:[
  'test_ack_is_one_use_and_ambiguity_stays_manager_possible_without_stock_credit',
  'test_failed_live_bind_preserves_refusal_without_timely_exact_terminal_proof',
  'test_failure_settlement_reaps_owned_helper_that_exits_during_live_bind',
  'test_failure_signal_requires_held_direct_child_and_records_before_syscall',
  'test_fixed_posix_spawn_only_after_prepare_and_ready_does_not_grant',
  'test_foreign_inheritable_descriptor_refuses_without_rewriting_it',
  'test_held_pidfd_and_proc_birth_must_join_exact_parent_session_and_time_namespace',
  'test_lost_pid_and_known_pid_after_cleanup_never_open_or_signal_a_process',
  'test_only_exact_waitid_pidfd_reaps_and_zero_needs_prior_stock_witness',
  'test_pid_returned_at_launch_cutoff_keeps_only_its_cleanup_handle',
  'test_stock_observation_requires_held_exec_transition_and_never_uses_control_eof',
  'test_stock_snapshot_rejects_command_or_surviving_helper_socket',
 ]},
 {name:'runs the 17 exact manager admission source models',stem:'manager-admission',count:17,owner:'ManagerAdmissionModels',methods:[
  'test_borrowed_library_and_callback_close_after_terminal_or_refused_recheck',
  'test_fixed_paths_observe_same_pid1_library_and_socket_without_loader_or_connection',
  'test_original_clock_refuses_invalid_expired_and_late_native_readback',
  'test_recheck_allows_unrelated_mount_rows_with_similar_names',
  'test_recheck_refuses_changed_local_executable_names_after_both_mount_reads',
  'test_recheck_refuses_socket_rebind_foreign_mount_or_relabelled_library_mount',
  'test_recheck_refuses_stock_ancestor_and_leaf_mount_rows_in_either_view',
  'test_recheck_rejects_pid1_birth_executable_credentials_namespaces_and_exit',
  'test_refuses_symlink_writable_parent_or_foreign_socket_path_before_admission',
  'test_refuses_unsafe_library_header_extent_or_changed_name',
 ],additional:{owner:'ManagerLibraryLinkInputModels',methods:[
  'test_link_inputs_are_dormant_and_read_only_with_exact_byte_boundary',
  'test_link_inputs_bind_exact_bytes_and_ordered_duplicate_dependencies',
  'test_link_inputs_refuse_competing_projected_pages_even_when_load_extents_are_disjoint',
  'test_link_inputs_refuse_conflicting_or_non_file_backed_address_mappings',
  'test_link_inputs_refuse_invalid_dynamic_segment_and_missing_terminator',
  'test_link_inputs_refuse_missing_duplicate_or_unbounded_string_table_fields',
  'test_link_inputs_require_fixed_soname_and_bounded_ascii_basenames',
 ]}},
] as const;
const sources=[
 'test/native-workload-browser-role-models.test.ts',
 ...suites.flatMap(({stem})=>[prefix+stem+'.py',prefix+stem+'.test.py']),
 ...['host','launch-plan','launch-view','preimport-gate','synthetic-stage'].map(stem=>prefix+stem+'.py'),
 'deploy/admission/next_profile.py',
];

function git(args:string[],timeout:number){
 const result=spawnSync('/usr/bin/git',args,{
  cwd:root,env:{...env,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_CONFIG_NOSYSTEM:'1',
   GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},
  encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:8*1024,stdio:['ignore','pipe','pipe'],
 });
 expect(result.error).toBeUndefined();
 expect(result.signal).toBeNull();
 expect(result.status).toBe(0);
 expect(result.stderr).toBe('');
 return result.stdout;
}

function requireSource(sha:string){
 expect(git(['rev-parse','HEAD'],1000)).toBe(sha+'\n');
 const rows=git(['ls-tree','-rlz','--full-tree',sha,'--',...sources],1000).split('\0');
 expect(rows.pop()).toBe('');
 expect(rows).toHaveLength(sources.length);
 const inventory=new Map(rows.map(row=>{
  const found=/^100644 blob ([a-f0-9]{40}) +([0-9]{1,8})\t([^\0]+)$/.exec(row);
  if(!found)throw Error('Expected one regular Git object per model input');
  return [found[3],{blob:found[1],size:Number(found[2])}] as const;
 }));
 const blobs=sources.map(path=>{
  const actual=resolve(root,path),info=lstatSync(actual),expected=inventory.get(path);
  expect(realpathSync(actual)).toBe(actual);
  expect(info.isFile()&&info.nlink===1&&info.size>0&&info.size<=2*1024*1024).toBe(true);
  if(!expected)throw Error('Missing model input in the exact candidate');
  expect(expected.size).toBe(info.size);
  return expected.blob;
 });
 // Hash the working bytes without attributes, clean filters, or Git writes.
 expect(git(['hash-object','--no-filters','--',...sources],5000)).toBe(blobs.join('\n')+'\n');
}

const exceptionKinds=new Map([
 ['AssertionError','assertion'],
 ['FileNotFoundError','io'],['FileExistsError','io'],['IsADirectoryError','io'],['NotADirectoryError','io'],
 ['OSError','io'],['PermissionError','io'],['BrokenPipeError','io'],
 ['ImportError','import'],['ModuleNotFoundError','import'],
 ['TypeError','type'],['ValueError','value'],['UnicodeDecodeError','value'],
 ['RuntimeError','runtime'],['TimeoutError','timeout'],['Refused','refused'],
]);

function reportFailure(cases:readonly {id:string;label:string}[],stderr:string){
 const lines=stderr.split('\n');
 const outcomesByCase=cases.map(({id,label})=>{
  const outcomes=lines.filter(line=>line.startsWith(label+' ... ')||line.startsWith('  '+label+' ('));
  const outcome=outcomes.some(line=>line.endsWith(' ... ERROR'))?'error'
   :outcomes.some(line=>line.endsWith(' ... FAIL'))?'failed'
   :outcomes.some(line=>line.startsWith(label+' ... skipped'))?'skipped'
   :outcomes.includes(label+' ... ok')?'passed':'unreported';
  return {id,outcome};
 });
 const exceptions=new Set<string>();
 for(const line of lines){
  const name=/^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)(?::|$)/.exec(line)?.[1];
  const kind=name&&exceptionKinds.get(name);
  if(kind)exceptions.add(kind);
 }
 process.stderr.write(JSON.stringify({cases:outcomesByCase,exceptions:exceptions.size?[...exceptions].sort():['other']})+'\n');
}

it.each(suites)('$name',suite=>{
 const {stem,count,owner,methods}=suite;
 expect(process.platform).toBe('linux');
 expect(process.env.GITHUB_ACTIONS).toBe('true');
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 expect(process.env.GITHUB_REPOSITORY_ID).toBe('1333414856');
 const sha=process.env.AIHR_CI_HEAD??'';
 expect(sha).toMatch(/^[a-f0-9]{40}$/);
 requireSource(sha);
 const groups='additional' in suite?[{owner,methods},suite.additional]:[{owner,methods}];
 const cases=groups.flatMap(group=>[...group.methods].sort().map(method=>{
  const id=group.owner+'.'+method;
  return {id,label:method+' (__main__.'+id+')'};
 }));
 const expected=cases.map(({label})=>label+' ... ok');
 expect(expected).toHaveLength(count);
 expect(new Set(expected).size).toBe(count);
 expect(lstatSync('/dev/null').isCharacterDevice()).toBe(true);
 const file=prefix+stem+'.test.py';
 const result=spawnSync('/usr/bin/python3',['-I','-B','-X','pycache_prefix=/dev/null',file,'-v'],{
  cwd:root,env,encoding:'utf8',
  timeout:10000,killSignal:'SIGKILL',maxBuffer:128*1024,stdio:['ignore','pipe','pipe'],
 });
 requireSource(sha);
 if(result.error||result.signal!==null||result.status!==0){
  reportFailure(cases,result.stderr??'');
  throw Error('Browser role model process failed');
 }
 const transcript=result.stderr.split('\n');
 const [spacer,divider,elapsed,blank,summary,eof]=transcript.slice(count);
 const duration=new RegExp('^Ran '+count+' tests in [0-9]+\\.[0-9]{3}s$');
 expect(result.stdout===''&&transcript.length===count+6&&expected.every((line,index)=>line===transcript[index])
  &&spacer===''&&divider==='-'.repeat(70)&&duration.test(elapsed)&&blank===''&&summary==='OK'&&eof==='').toBe(true);
 process.stderr.write(result.stderr);
},30000);
