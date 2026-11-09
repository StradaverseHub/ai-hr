/** Ordinary navigation source models for the standard NODB gate. */
import {spawnSync} from 'node:child_process';
import {lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const file='.github/ci/native-workload-navigation-ordinary.test.py';
const owner='NativeNavigationOrdinaryModel';
const methods=[
 'test_real_checkout_yields_measured_scenario_and_complete_ordinary_rows',
 'test_same_size_checkout_bytes_do_not_match_independent_git_object',
 'test_git_raw_digest_and_git_blob_oid_are_independent_requirements',
 'test_missing_extra_duplicate_and_mismatched_git_object_facts_refuse_before_read',
 'test_git_inventory_rejects_duplicate_missing_foreign_or_invalid_regular_rows',
 'test_checkout_mode_must_match_git_and_refuse_privileged_or_foreign_write_bits',
 'test_symlink_hardlink_and_fifo_refuse_without_consuming_target',
 'test_named_inode_replacement_with_identical_bytes_refuses',
 'test_growth_and_truncation_after_first_real_chunk_refuse',
 'test_exact_file_and_aggregate_bounds_pass_with_real_bytes',
 'test_exact_combined_member_limit_and_oversized_raw_inventory',
 'test_owner_clock_closes_during_real_stream_without_facts',
 'test_terminal_real_tree_recheck_catches_earlier_read_member_replaced',
 'test_owner_clock_rechecks_after_successful_terminal_tree_walk',
] as const;

it('runs the 14 exact ordinary navigation source byte models',()=>{
 // Default unittest discovery sorts method names and also reports extra cases.
 const expected=[...methods].sort().map(method=>method+' (__main__.'+owner+'.'+method+') ... ok');
 expect(expected).toHaveLength(14);
 expect(new Set(expected).size).toBe(14);
 // An isolated nondirectory cache prefix makes CPython load source on cache miss.
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
  ...expected,'','-'.repeat(70),expect.stringMatching(/^Ran 14 tests in [0-9]+\.[0-9]{3}s$/),'','OK','',
 ]);
});
