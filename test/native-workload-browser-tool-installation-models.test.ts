/** Bounded source models for the archive parser and private tool staging. */
import {spawnSync} from 'node:child_process';
import {lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const suites=[
 {
  name:'runs the 17 exact affected browser archive source models',
  file:'.github/ci/native-workload-browser-toolchain.test.py',
  owner:'StrictToolchainArchiveModels',
  count:17,
  methods:[
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
  ],
 },
 {
  name:'runs the 10 exact private browser tool installation source models',
  file:'.github/ci/native-workload-browser-tool-installation.test.py',
  owner:'PrivateToolInstallationModels',
  count:10,
  methods:[
   'test_actual_readback_rejects_same_size_change_replacement_and_extra_name',
   'test_elapsed_deadline_refuses_initially_and_after_complete_filesystem_readback',
   'test_entry_bound_counts_implicit_directories_before_creating_file',
   'test_file_ancestor_collision_never_opens_a_conflicting_path',
   'test_fixed_four_archive_bytes_and_staging_modes_reconcile_every_installed_member',
   'test_foreign_entry_or_symlink_refuses_before_mutating_held_root',
   'test_hardlink_and_symlink_refuse_readback_without_touching_external_bytes',
   'test_unpinned_browser_refuses_before_creating_staged_outputs',
   'test_valid_sri_with_late_bad_tar_padding_never_returns_a_tree',
   'test_wrong_root_kind_or_mode_refuses_before_any_archive_read',
  ],
 },
] as const;

it.each(suites)('$name',({file,owner,count,methods})=>{
 const expected=methods.map(method=>method+' (__main__.'+owner+'.'+method+') ... ok');
 expect(expected).toHaveLength(count);
 expect(new Set(expected).size).toBe(count);
 // /dev/null is a nondirectory. CPython falls back to source when cache
 // lookup beneath this fixed prefix fails, and -B suppresses cache writes.
 expect(lstatSync('/dev/null').isCharacterDevice()).toBe(true);
 const result=spawnSync('/usr/bin/python3',['-I','-B','-X','pycache_prefix=/dev/null',file,'-v'],{
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
