/** Reviewed dormant manager models for the standard hosted NODB gate. */
import {spawnSync} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const prefix='.github/ci/native-workload-browser-manager-';
const env={PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8',TZ:'UTC'};
const suites=[
 {name:'runs the 18 exact manager reference source models',stem:'reference',count:18,owner:'ManagerReferenceModels',methods:[
  'test_absence_requires_original_pinned_manager_error_shape_and_live_binding',
  'test_acknowledged_ref_requires_post_ref_invocation_before_grant',
  'test_late_ref_ack_is_uncertain_and_never_retried',
  'test_late_terminal_reply_does_not_become_success_or_authorize_unref',
  'test_live_pid_invocation_and_raw_start_must_match_the_owned_prelaunch_sample',
  'test_nonnormal_terminal_is_raw_evidence_even_when_result_is_success',
  'test_one_connection_uses_only_fixed_calls_across_all_three_roles',
  'test_prelaunch_refuses_any_loaded_name_and_any_nonmatching_object_path',
  'test_reentrant_exchange_and_expired_frontier_admit_no_additional_call',
  'test_refuses_wrong_or_empty_live_invocation_before_ref',
  'test_rejects_unbound_peer_bad_run_and_wrong_role_frontier_or_order_before_io',
  'test_terminal_requires_same_native_invocation_before_unref',
  'test_transport_failure_hides_raw_details_and_does_not_become_absence',
  'test_typed_live_and_terminal_passes_use_only_the_fixed_role_wire',
  'test_typed_observation_requires_exact_held_role_live_baseline_and_one_attempt',
  'test_typed_pass_refuses_reentrancy_and_early_late_or_regressed_clocks',
  'test_typed_terminal_refuses_mixed_identity_jobs_raw_shape_or_nonterminal_state',
  'test_uncertain_unref_preserves_attempt_and_does_not_admit_collection',
 ]},
 {name:'runs the 14 exact manager transport source models',stem:'transport',count:14,owner:'ManagerTransportModels',methods:[
  'test_async_hello_and_same_socket_close_around_fixed_reference_course',
  'test_changed_fd_refuses_native_close_without_touching_other_file',
  'test_changed_pid1_or_manager_name_never_admits_a_role_call',
  'test_close_is_independent_and_never_replaces_primary_failure',
  'test_detach_interruption_distinguishes_caller_owned_and_detached_fd',
  'test_exact_error_sender_cookie_and_body_are_required_for_absence',
  'test_hello_uses_absolute_frontier_even_before_any_method',
  'test_invocation_read_requires_bounded_exact_variant_before_ref',
  'test_late_or_replaced_socket_is_refused_after_set_fd_before_start',
  'test_native_boundary_refuses_mutated_verbs_paths_bodies_and_frontiers',
  'test_ref_reply_at_frontier_is_ambiguous_and_drops_slot_without_retry',
  'test_refuses_wrong_socket_peer_and_manager_credentials_before_role_calls',
  'test_set_fd_failure_distinguishes_uninstalled_and_native_owned_fd',
  'test_start_failure_distinguishes_retained_closed_and_unproved_native_fd',
 ]},
] as const;
const sources=[
 'test/native-workload-browser-manager-models.test.ts',
 ...suites.flatMap(({stem})=>[prefix+stem+'.py',prefix+stem+'.test.py']),
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

function reportFailure(owner:string,methods:readonly string[],stderr:string){
 const lines=stderr.split('\n');
 const cases=methods.map(method=>{
  const id=owner+'.'+method,label=method+' (__main__.'+id+')';
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
 process.stderr.write(JSON.stringify({cases,exceptions:exceptions.size?[...exceptions].sort():['other']})+'\n');
}

it.each(suites)('$name',({stem,count,owner,methods})=>{
 expect(process.platform).toBe('linux');
 expect(process.env.GITHUB_ACTIONS).toBe('true');
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 expect(process.env.GITHUB_REPOSITORY_ID).toBe('1333414856');
 const sha=process.env.AIHR_CI_HEAD??'';
 expect(sha).toMatch(/^[a-f0-9]{40}$/);
 requireSource(sha);
 const expected=[...methods].sort().map(method=>method+' (__main__.'+owner+'.'+method+') ... ok');
 expect(expected).toHaveLength(count);
 expect(new Set(expected).size).toBe(count);
 expect(lstatSync('/dev/null').isCharacterDevice()).toBe(true);
 const file=prefix+stem+'.test.py';
 const result=spawnSync('/usr/bin/python3',['-I','-B','-X','pycache_prefix=/dev/null',file,'-v'],{
  cwd:root,env,encoding:'utf8',
  timeout:10000,killSignal:'SIGKILL',maxBuffer:128*1024,stdio:['ignore','pipe','pipe'],
 });
 if(result.error||result.signal!==null||result.status!==0){
  reportFailure(owner,methods,result.stderr??'');
  throw Error('Browser manager model process failed');
 }
 const transcript=result.stderr.split('\n');
 const [spacer,divider,elapsed,blank,summary,eof]=transcript.slice(count);
 const duration=new RegExp('^Ran '+count+' tests in [0-9]+\\.[0-9]{3}s$');
 expect(result.stdout===''&&transcript.length===count+6&&expected.every((line,index)=>line===transcript[index])
  &&spacer===''&&divider==='-'.repeat(70)&&duration.test(elapsed)&&blank===''&&summary==='OK'&&eof==='').toBe(true);
 requireSource(sha);
 process.stderr.write(result.stderr);
},30000);
