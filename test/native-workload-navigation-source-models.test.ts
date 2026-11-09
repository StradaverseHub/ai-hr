/** Held navigation byte models for the standard hosted NODB gate. */
import {spawnSync} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const file='.github/ci/native-workload-navigation-source.test.py';
const env={PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8',TZ:'UTC'};
const ordinary=2*1024*1024;
const inputs=[
 ['test/native-workload-navigation-source-models.test.ts',ordinary],
 [file,ordinary],
 ['.github/ci/native-workload-navigation-source.py',ordinary],
 ['.github/ci/runtime_inventory.py',ordinary],
 ['scripts/performance/navigation-protocol.ts',ordinary],
 ['scripts/performance/navigation-scenarios.json',ordinary],
 ['scripts/performance/navigation-browser-capture.ts',ordinary],
 ['deploy/admission/next_bootstrap_session_inverse.json',3_214_186],
 ['deploy/admission/next_controller_admit_terminal_inverse.json',22_906_898],
 ['deploy/admission/next_controller_admit_timing_inverse.json',8_085_766],
 ['deploy/admission/next_host_history_controller_inverse.json',39_474_867],
] as const;
const classes=[
 ['NativeNavigationHandoffModel',[
  'test_handoff_binds_the_raw_scenario_and_four_real_histories_in_inventory_order',
  'test_handoff_refuses_incomplete_or_duplicate_object_evidence_before_opening_any_file',
  'test_handoff_refuses_same_size_ordinary_bytes_and_earlier_member_change_at_final_walk',
 ]],
 ['NativeNavigationHistoryModel',[
  'test_exact_current_roots_and_four_whole_tracked_checkout_objects',
  'test_exact_length_incorrect_real_file_is_not_a_history_fact',
  'test_first_real_stream_has_no_result_after_clock_closes',
  'test_live_caps_and_original_member_limit_hold_with_history',
  'test_missing_duplicate_renamed_foreign_and_invalid_roles_refuse_before_read',
  'test_named_file_replacement_during_read_does_not_validate_held_inode',
  'test_symlink_hardlink_and_nonregular_refuse_through_pinned_tree',
 ]],
] as const;

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
 const paths=inputs.map(([path])=>path);
 const rows=git(['ls-tree','-rlz','--full-tree',sha,'--',...paths],1000).split('\0');
 expect(rows.pop()).toBe('');
 expect(rows).toHaveLength(inputs.length);
 const inventory=new Map(rows.map(row=>{
  const found=/^100644 blob ([a-f0-9]{40}) +([0-9]{1,8})\t([^\0]+)$/.exec(row);
  if(!found)throw Error('Expected one regular Git object per model input');
  return [found[3],{blob:found[1],size:Number(found[2])}] as const;
 }));
 const blobs=inputs.map(([path,limit])=>{
  const actual=resolve(root,path),info=lstatSync(actual),expected=inventory.get(path);
  expect(realpathSync(actual)).toBe(actual);
  expect(info.isFile()&&info.nlink===1&&info.size>0&&info.size<=limit).toBe(true);
  if(!expected)throw Error('Missing model input in the exact candidate');
  expect(expected.size).toBe(info.size);
  return expected.blob;
 });
 // Hash the working bytes without attributes, clean filters, or Git writes.
 expect(git(['hash-object','--no-filters','--',...paths],5000)).toBe(blobs.join('\n')+'\n');
}

it('runs the 10 exact held navigation source byte models',()=>{
 expect(process.platform).toBe('linux');
 expect(process.env.GITHUB_ACTIONS).toBe('true');
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 expect(process.env.GITHUB_REPOSITORY_ID).toBe('1333414856');
 const sha=process.env.AIHR_CI_HEAD??'';
 expect(sha).toMatch(/^[a-f0-9]{40}$/);
 requireSource(sha);
 const expected=classes.flatMap(([owner,methods])=>[...methods].sort()
  .map(method=>method+' (__main__.'+owner+'.'+method+') ... ok'));
 expect(expected).toHaveLength(10);
 expect(new Set(expected).size).toBe(10);
 // A nondirectory cache prefix and -B force the stock interpreter to read source.
 expect(lstatSync('/dev/null').isCharacterDevice()).toBe(true);
 const result=spawnSync('/usr/bin/python3',['-I','-B','-X','pycache_prefix=/dev/null',file,'-v'],{
  cwd:root,env,encoding:'utf8',
  timeout:10000,killSignal:'SIGKILL',maxBuffer:128*1024,stdio:['ignore','pipe','pipe'],
 });
 expect(result.error).toBeUndefined();
 expect(result.signal).toBeNull();
 expect(result.status).toBe(0);
 expect(result.stdout).toBe('');
 expect(result.stderr.split('\n')).toEqual([
  ...expected,'','-'.repeat(70),expect.stringMatching(/^Ran 10 tests in [0-9]+\.[0-9]{3}s$/),'','OK','',
 ]);
 requireSource(sha);
 process.stderr.write(result.stderr);
},30000);
