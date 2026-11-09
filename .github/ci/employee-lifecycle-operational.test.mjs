/** Source wiring contracts only; real job/DB/process proof remains required. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=file=>readFileSync(new URL(file,import.meta.url),'utf8');
const before=(text,first,last)=>{const a=text.indexOf(first),b=text.indexOf(last);assert(a>=0&&b>a,first+' must precede '+last);};
test('the employee30min job derives its first precheckout anchor from actual native clocks and retains ordinary120min',()=>{
 const workflow=read('../workflows/alpha-staging.yml'),job=workflow.slice(workflow.indexOf('  test:\n'),workflow.indexOf('  native-test:\n'));
 assert.match(job,/name: test \(\$\{\{ matrix\.unit \}\}\)/);assert.match(job,/timeout-minutes: \$\{\{ matrix\.employeeLifecycle && 30 \|\| 120 \}\}/);
 before(job,'Anchor first executable employee lifecycle job step','actions/checkout@');
 for(const fact of ['time.monotonic_ns()','time.time_ns()','/proc/sys/kernel/random/boot_id','os.O_EXCL|os.O_NOFOLLOW','mode=0o700','0o600'])assert(job.includes(fact));
 assert.match(job,/if: \$\{\{ matrix\.employeeLifecycle \}\}/);assert(job.includes('exec "$NODE" "$GITHUB_WORKSPACE/automation/.github/ci/run-unit.mjs" "$UNIT" "$RUNNER_TEMP/aihr-ci"'));
 const recovery=job.slice(job.indexOf('name: Always settle the exact owned employee PostgreSQL resource'));
 assert(recovery.includes('always() && matrix.employeeLifecycle'));assert(recovery.includes('employee-lifecycle-always-stop.mjs'));assert(!recovery.includes('continue-on-error: true'));before(job,'employee-lifecycle-always-stop.mjs','actions/upload-artifact@');
});
test('real run-unit stages preserve role/singleton admission and mandatory stop before any terminal publication',()=>{
 const source=read('./run-unit.mjs'),main=source.slice(source.indexOf('export async function main()'));
 before(main,'lifecycle=prepareEmployeeLifecycle(lifecycleProfile.file)',"fixedStage('reset')");before(main,"fixedStage('reset')",'actualFullCiRoleContext(plan,unit');before(main,"fixedStage('migrate'",'writeSingletonBinding(plan,unit');before(main,'writeSingletonBinding(plan,unit','authorizeEmployeeLifecycleTest(lifecycle,singleton.path)');before(main,'authorizeEmployeeLifecycleTest(lifecycle,singleton.path)','fixedStage(lifecycleProfile.stage,env)');
 const final=main.slice(main.lastIndexOf('} finally {'));before(final,'closeEmployeeLifecycle(lifecycle)','report.healthAfter = hostHealth()');before(final,'closeEmployeeLifecycle(lifecycle)','writeFileSync(join(dir, `unit-${id}.json`)');assert(final.includes("unit.kind === 'db'&&!lifecycleProfile"));assert(main.includes("if(lifecycle)assert.equal(roleProfile,fullRoleMode"));
 assert(!main.includes('AIHR_FOCUSED_TESTS='));assert(!main.includes('AIHR_FOCUSED_SUITE_CAPACITY='));
});
test('pre-admission metadata is bounded without claiming process-family containment from its timeout',()=>{
 const plan=read('./plan.mjs'),profiles=read('./singleton-profiles.mjs');assert(plan.includes('timeout:10000,killSignal:\'SIGTERM\''));assert(plan.includes('timeout:15000,killSignal:\'SIGTERM\''));assert(plan.includes('env:nativePreparationEnvironment(process.env)'));assert(profiles.includes('timeout:10000,killSignal:\'SIGTERM\''));
 const api=read('./employee-lifecycle-api.mjs');for(const fact of ['--no-replace-objects','GIT_CONFIG_NOSYSTEM','name.startsWith(\'GIT_\')','cat-file','employeeLifecycleControllerBlob(bytes,blobs.get(file).id)','controllerFactOwners.has(controllerFacts)'])assert(api.includes(fact));assert(!api.includes('authenticated:true'));
});
test('normal verification keeps artifact boundaries and release revalidation reconstructs actual authenticated proof again',()=>{
 const workflow=read('../workflows/alpha-staging.yml');for(const job of ['verify','commission-summary']){const part=workflow.slice(workflow.indexOf('  '+job+':\n')).split(/\n  [a-z][a-z-]*:\n/)[0];assert(part.includes('merge-multiple: false'));}
 const release=read('./release-ci.mjs');assert(release.includes('employeeLifecycleUnit(unit)&&artifact.name===\'unit-\'+unit.id'));assert(release.includes('readEmployeeLifecycleArchive({plan,unit,run,job,artifact'));assert(release.includes('const fresh=await verifyCi({candidatePath:evidence.candidatePath,runId:evidence.runId,baseline:evidence.baseline})'));assert(!release.includes('authenticated:true'));
});
