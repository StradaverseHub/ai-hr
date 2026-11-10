import test from 'node:test';
import {controllerRegressionRoots,candidateCarriesSingletonFixtures,SINGLETON_FREE_CANDIDATE} from './controller-regression-roots.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateNativeBuildMetadata,provisionNativeNextBuild,captureNativeNextInstallation,nativeHelperClosure,NATIVE_HELPER_SOURCES} from './native-next-build-packet.mjs';
import {singletonSources,singletonDescriptor} from './singleton-protocol.mjs';
import {installationShape} from './native-next-installation.mjs';
test('native installation witness requires V2 relocated bytes and refuses a historical V1 digest',()=>{
 const value={version:1,kind:'LOCKED_HOSTED_INSTALL_BEFORE_CANDIDATE_VERIFICATION',
  node:{path:'/opt/node',sha256:'1'.repeat(64),bytes:100},lockSha256:'2'.repeat(64),packageSha256:'3'.repeat(64),
  dependencies:{normalization:'ROOT_COPY_DEPENDENCIES_V2',sha256:'4'.repeat(64),entries:10,bytes:200}};
 assert.equal(installationShape(value),value);
 assert.throws(()=>installationShape({...value,dependencies:{...value.dependencies,normalization:'ROOT_COPY_DEPENDENCIES_V1'}}));
 assert.throws(()=>installationShape({...value,dependencies:{...value.dependencies,normalization:'caller-claimed-relocation'}}));
});
function fixture(){
 const expected={source:'a'.repeat(40),controller:'b'.repeat(40),runId:123,controllerBranch:'codex/native-next-ci'};
 const repository={id:1333414856,full_name:'StradaverseHub/ai-hr'},now=Date.parse('2026-11-08T01:10:00Z');
 const run={id:123,run_attempt:1,repository,head_repository:repository,head_sha:expected.controller,head_branch:expected.controllerBranch,workflow_id:395777276,path:'.github/workflows/alpha-staging.yml',status:'in_progress',event:'workflow_dispatch',created_at:'2026-11-08T01:00:00Z'};
 const jobs=[{id:456,name:'build',run_id:123,run_attempt:1,head_sha:expected.controller,head_branch:expected.controllerBranch,status:'completed',conclusion:'success',started_at:'2026-11-08T01:01:00Z',completed_at:'2026-11-08T01:08:00Z'}];
 const artifacts=[{id:789,name:'production-build-v1',size_in_bytes:100,digest:'sha256:'+'c'.repeat(64),expired:false,created_at:'2026-11-08T01:07:00Z',expires_at:'2026-11-09T01:07:00Z',workflow_run:{id:123,repository_id:1333414856,head_repository_id:1333414856,head_sha:expected.controller,head_branch:expected.controllerBranch}}];
 return {metadata:{run,jobs,artifacts},expected,now};
}
test('only the same actual run and terminal sole build can issue native packet expectations',()=>{
 const f=fixture(),r=validateNativeBuildMetadata(f.metadata,f.expected,f.now);
 assert.equal(r.expected.candidate,f.expected.source);assert.equal(r.expected.runId,123);assert.equal(r.producer.id,456);assert.equal(r.artifact.id,789);
 assert.equal(r.expected.producerStartedAt,f.metadata.jobs[0].started_at);
 for(const status of ['failure','cancelled','queued']){
  const g=fixture();g.metadata.run.status=status;assert.throws(()=>validateNativeBuildMetadata(g.metadata,g.expected,g.now));
 }
});
for(const [name,mutate]of [
 ['foreign repository',f=>f.metadata.run.repository.id=1],['foreign head repository',f=>f.metadata.run.head_repository={id:1,full_name:'other/repo'}],
 ['foreign run',f=>f.metadata.run.id=124],['controller drift',f=>f.metadata.run.head_sha='f'.repeat(40)],['other workflow',f=>f.metadata.run.path='other.yml'],
 ['rerun',f=>f.metadata.run.run_attempt=2],['unsupported event',f=>f.metadata.run.event='pull_request'],['expired run',f=>f.now+=86400001],
 ['nonterminal producer',f=>f.metadata.jobs[0].status='in_progress'],['failed producer',f=>f.metadata.jobs[0].conclusion='failure'],
 ['duplicate producer',f=>f.metadata.jobs.push({...f.metadata.jobs[0],id:457})],['missing producer',f=>f.metadata.jobs=[]],
 ['foreign job',f=>f.metadata.jobs[0].run_id=124],['foreign producer controller',f=>f.metadata.jobs[0].head_sha='e'.repeat(40)],
 ['producer before run',f=>f.metadata.jobs[0].started_at='2026-11-07T01:00:00Z'],['producer future',f=>f.metadata.jobs[0].completed_at='2026-11-09T01:00:00Z'],
 ['missing artifact',f=>f.metadata.artifacts=[]],['duplicate artifact',f=>f.metadata.artifacts.push({...f.metadata.artifacts[0],id:790})],
 ['foreign artifact run',f=>f.metadata.artifacts[0].workflow_run.id=124],['foreign artifact controller',f=>f.metadata.artifacts[0].workflow_run.head_sha='d'.repeat(40)],
 ['expired artifact',f=>f.metadata.artifacts[0].expired=true],['bad digest',f=>f.metadata.artifacts[0].digest='claimed'],
 ['oversized archive',f=>f.metadata.artifacts[0].size_in_bytes=1024**3],['artifact before producer',f=>f.metadata.artifacts[0].created_at='2026-11-08T01:00:00Z'],
 ['artifact after producer',f=>f.metadata.artifacts[0].created_at='2026-11-08T01:09:00Z'],['artifact expired date',f=>f.metadata.artifacts[0].expires_at='2026-11-08T01:09:00Z'],
 ['untrusted branch',f=>f.expected.controllerBranch='feature'],['unsafe branch',f=>f.expected.controllerBranch='codex/../main'],
])test('native same-run packet refuses '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validateNativeBuildMetadata(f.metadata,f.expected,f.now));});
test('provisioning refuses an ordinary DB singleton before any API or filesystem operation',async()=>{
 await assert.rejects(provisionNativeNextBuild({}, {singleton:{profile:'notification-cluster-v1'}},'/foreign',{}),/registered hybrid/);
});
test('native provisioning rejects fabricated late installation facts before API or packet operations',async()=>{
 const unit={singleton:{profile:'linux-next-postgres-v1'}},plan={sha:'a'.repeat(40),controller:'b'.repeat(40)};
 for(const snapshot of [undefined,{}, {sha:plan.sha,controller:plan.controller,source:process.cwd(),installation:{captured:true}}])
  await assert.rejects(provisionNativeNextBuild(plan,unit,'/foreign',{},snapshot),/Original pre-classifier installation capture required/);
 assert.equal(captureNativeNextInstallation({GITHUB_JOB:'test'}),null);
 assert.equal(captureNativeNextInstallation({GITHUB_JOB:'selected-tests'}),null);
});
test('private archives, packet and binding stay outside uploaded evidence, and original release inspector stays strict',()=>{
 const source=readFileSync(new URL('./native-next-build-packet.mjs',import.meta.url),'utf8');
 assert(source.includes("const root=join(temporary,unit.id+'-native-build-private')"));
 assert(source.includes("assert.equal(directory,join(temporary,'aihr-ci'))"));
 assert(source.includes('downloadCiArchives([metadata.artifact]'));assert(source.includes('inspectCiNativeBuildPacket(packetDirectory,metadata.expected)'));
 assert(source.includes("'-I','-B'"));
});
test('privileged helper closure is finite, committed on both sides and sealed before returning candidate hints',t=>{
 assert.equal(Object.keys(NATIVE_HELPER_SOURCES).length,11);
 const candidate=controllerRegressionRoots().candidate;
 if(!candidateCarriesSingletonFixtures(candidate))t.diagnostic(SINGLETON_FREE_CANDIDATE);else{
 const file='test/runtime-next-admission-native.test.ts',unit={kind:'db',files:[file],singleton:singletonDescriptor(file)};
 const sources=singletonSources(unit,candidate);assert(sources.includes('db/migrations/meta/_journal.json'));for(const path of Object.values(NATIVE_HELPER_SOURCES))assert(sources.includes(path));
 assert(sources.includes('.github/ci/native-next-helper-sources.mjs'));
 }
 assert.throws(()=>nativeHelperClosure({sha:'HEAD',controller:'HEAD'},'/caller'),/Exact native helper/);
 const source=readFileSync(new URL('./native-next-build-packet.mjs',import.meta.url),'utf8');
 assert(source.indexOf('const NATIVE_HELPER_BYTES=')<source.indexOf('export async function provisionNativeNextBuild'));
 assert(source.indexOf('helpers=nativeHelperClosure(')<source.indexOf("execFileSync('pnpm'"));
 assert(source.includes('bytes.equals(from(automation,plan.controller))&&bytes.equals(from(source,plan.sha))'));
 assert(source.includes("execFileSync('sudo',['-n','/usr/bin/python3','-I','-B','-c',NATIVE_BUILD_SEALER,'--seal']"));
 assert(source.includes('JSON.stringify({binding,unit:unit.id,runnerTemp:temporary,runnerUid:process.getuid(),helpers})'));
 assert(!source.includes("writeFileSync(bindingPath"));assert(source.includes("const sealedRoot='/var/lib/aihr-native-build/'"));
});

function prFixture(){
 const f=fixture(),repo={id:1333414856,full_name:'StradaverseHub/ai-hr'};
 f.expected.controllerRef='refs/pull/230/merge';f.expected.controllerBranch='feature/native-runtime';
 Object.assign(f.metadata.run,{event:'pull_request',head_sha:f.expected.source,head_branch:f.expected.controllerBranch,pull_requests:[{number:230,head:{sha:f.expected.source,repo}}]});
 Object.assign(f.metadata.jobs[0],{head_sha:f.expected.source,head_branch:f.expected.controllerBranch});
 Object.assign(f.metadata.artifacts[0].workflow_run,{head_sha:f.expected.source,head_branch:f.expected.controllerBranch});
 f.metadata.pullRequest={number:230,merge_commit_sha:f.expected.controller,head:{sha:f.expected.source,ref:f.expected.controllerBranch,repo},base:{ref:'alpha',repo}};
 return f;
}
test('same-repository PR distinguishes actual API head source from merge workflow controller',()=>{
 const f=prFixture(),checked=validateNativeBuildMetadata(f.metadata,f.expected,f.now);
 assert.equal(checked.expected.candidate,f.expected.source);assert.equal(checked.expected.controller,f.expected.controller);
 assert.equal(checked.expected.controllerRef,'refs/pull/230/merge');assert.notEqual(f.metadata.run.head_sha,f.expected.controller);
});
for(const [name,mutate]of [
 ['foreign head repo',f=>f.metadata.pullRequest.head.repo={id:1,full_name:'other/repo'}],
 ['foreign base repo',f=>f.metadata.pullRequest.base.repo={id:1,full_name:'other/repo'}],
 ['changed head',f=>f.metadata.pullRequest.head.sha='f'.repeat(40)],['changed merge',f=>f.metadata.pullRequest.merge_commit_sha='f'.repeat(40)],
 ['wrong base',f=>f.metadata.pullRequest.base.ref='main'],['wrong PR',f=>f.metadata.pullRequest.number=231],
 ['wrong head ref',f=>f.metadata.pullRequest.head.ref='other'],['missing run association',f=>f.metadata.run.pull_requests=[]],
 ['foreign job head',f=>f.metadata.jobs[0].head_sha=f.expected.controller],['foreign artifact head',f=>f.metadata.artifacts[0].workflow_run.head_sha=f.expected.controller],
 ['missing merge ref',f=>delete f.expected.controllerRef],['wrong merge ref',f=>f.expected.controllerRef='refs/pull/231/merge'],
])test('PR native verification refuses '+name,()=>{const f=prFixture();mutate(f);assert.throws(()=>validateNativeBuildMetadata(f.metadata,f.expected,f.now));});
