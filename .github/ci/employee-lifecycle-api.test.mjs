import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS} from './employee-lifecycle-sources.mjs';
import {nativePreparationEnvironment} from './candidate-environment.mjs';
import {EMPLOYEE_LIFECYCLE_PROFILE} from './employee-lifecycle-profile.mjs';
import {validateEmployeeLifecycleTransport,readEmployeeLifecycleArchive,employeeLifecycleControllerBlob,employeeLifecycleGitObject,employeeLifecycleGitTree,readEmployeeLifecycleControllerFacts} from './employee-lifecycle-api.mjs';
const repository={id:1333414856,full_name:'StradaverseHub/ai-hr'},source='a'.repeat(40),controller='b'.repeat(40);
function fixture(row=EMPLOYEE_LIFECYCLE_PROFILE.files[0]){
 const descriptor={version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'};
 const unit={id:'db-'+createHash('sha256').update(JSON.stringify({file:row.file,descriptor})).digest('hex').slice(0,16),kind:'db',files:[row.file],singleton:descriptor};
 const plan={sha:source,controller};
 const run={id:123,run_attempt:1,repository,head_repository:repository,workflow_id:395777276,path:'.github/workflows/alpha-staging.yml',event:'workflow_dispatch',head_branch:'codex/normal-qualification',head_sha:controller,display_title:'Alpha staging'};
 const job={id:456,run_id:123,run_attempt:1,name:`test (${unit.id})`,head_sha:controller,status:'completed',conclusion:'success',started_at:'2026-11-08T00:00:00Z',completed_at:'2026-11-08T00:20:00Z'};
 const artifact={id:789,name:'unit-'+unit.id,expired:false,size_in_bytes:1024,digest:'sha256:'+'c'.repeat(64),created_at:'2026-11-08T00:19:00Z',workflow_run:{id:123,repository_id:repository.id,head_repository_id:repository.id,head_sha:controller,head_branch:run.head_branch}};
 return{run,job,artifact,plan,unit};
}
const validate=value=>validateEmployeeLifecycleTransport(value,value.plan,value.unit,123);
test('all five exact complete units accept actual-shape same-run API facts only as transport, not test acceptance',()=>{
 for(const row of EMPLOYEE_LIFECYCLE_PROFILE.files){const value=fixture(row);assert.equal(validate(value).artifact.id,789);value.job.conclusion='failure';assert.equal(validate(value).job.conclusion,'failure');}
});
test('cross-run, repository, source, job, archive, attempt and foreign timing facts refuse',()=>{
 const changes=[v=>v.run.id++,v=>v.run.run_attempt=2,v=>v.run.repository={...repository,id:1},v=>v.run.head_repository={id:1},v=>v.run.workflow_id=1,v=>v.run.path='other.yml',v=>v.run.head_sha=source,v=>v.run.head_branch='feature/untrusted',v=>v.job.name='test (foreign)',v=>v.job.id=0,v=>v.job.run_id++,v=>v.job.head_sha=source,v=>v.job.run_attempt=2,v=>v.job.status='in_progress',v=>v.job.completed_at='2026-11-07T00:00:00Z',v=>v.artifact.workflow_run.id++,v=>v.artifact.workflow_run.head_sha=source,v=>v.artifact.workflow_run.repository_id=1,v=>v.artifact.workflow_run.head_repository_id=1,v=>v.artifact.workflow_run.head_branch='foreign',v=>v.artifact.expired=true,v=>v.artifact.digest='sha256:invalid',v=>v.artifact.size_in_bytes=67108865,v=>v.artifact.created_at='2026-11-08T00:20:01Z',v=>v.artifact.name='unit-other'];
 for(const change of changes){const value=fixture();change(value);assert.throws(()=>validate(value));}
});
test('PR API head is source while independent same-repository alpha merge is controller',()=>{
 const value=fixture();value.run.event='pull_request';value.run.head_sha=source;value.run.pull_requests=[{number:230,head:{sha:source}}];value.job.head_sha=source;value.artifact.workflow_run.head_sha=source;value.pullRequest={number:230,head:{repo:repository,sha:source},base:{repo:repository,ref:'alpha'},merge_commit_sha:controller};assert.equal(validate(value).job.id,456);
 for(const change of [v=>v.pullRequest.head.repo={...repository,id:1},v=>v.pullRequest.base.repo={...repository,id:1},v=>v.pullRequest.base.ref='main',v=>v.pullRequest.head.sha=controller,v=>v.pullRequest.merge_commit_sha=source,v=>v.run.pull_requests[0].head.sha=controller,v=>v.run.pull_requests[0].number=231,v=>v.job.head_sha=controller]){const candidate=structuredClone(value);change(candidate);assert.throws(()=>validate(candidate));}
});
test('commissioning requires its distinct actual artifact inventory and remains transport only',()=>{
 const value=fixture();value.run.display_title='Singleton commissioning only · source';assert.throws(()=>validate(value));value.artifact.name='commission-unit-'+value.unit.id;assert.equal(validate(value).artifact.name,value.artifact.name);
});

test('caller-provided controller JSON cannot replace independently owned clean-commit facts',()=>{
 const value=fixture();assert.throws(()=>readEmployeeLifecycleArchive({...value,controllerFacts:{controller},sourceRoot:'/foreign',archivePath:'/foreign.zip',destination:'/foreign-output'}),/Controller facts must originate/);
});
test('actual Git blob identity frames byte length, rejects changed content and never trusts a claimed SHA256',()=>{
 assert.equal(employeeLifecycleControllerBlob(Buffer.from('abc'),'f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f'),createHash('sha256').update('abc').digest('hex'));
 assert.equal(employeeLifecycleControllerBlob(Buffer.from('é'),'4b04fff51468d8ab5201ab02b725dc477bc7cb45'),createHash('sha256').update('é').digest('hex'));
 for(const [bytes,blob]of [[Buffer.from('abd'),'f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f'],[Buffer.alloc(0),'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'],[Buffer.from('abc'),'0'.repeat(64)],['abc','f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f']])assert.throws(()=>employeeLifecycleControllerBlob(bytes,blob));
});

test('controller commit/tree object bytes and every native tree boundary are independently verified',()=>{
 const blob='f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f',tree=Buffer.concat([Buffer.from('100644 fixed.mjs\0'),Buffer.from(blob,'hex')]),id=createHash('sha1').update('tree '+tree.length+'\0').update(tree).digest('hex');assert.deepEqual(employeeLifecycleGitObject('tree',tree,id),tree);assert.deepEqual(employeeLifecycleGitTree(tree).get(Buffer.from('fixed.mjs').toString('hex')),{mode:'100644',id:blob});
 assert.throws(()=>employeeLifecycleGitObject('tree',Buffer.concat([tree,Buffer.from('x')]),id));assert.throws(()=>employeeLifecycleGitObject('blob',tree,id));assert.throws(()=>employeeLifecycleGitObject('tree',tree,'0'.repeat(40)));
 for(const invalid of [tree.subarray(0,-1),Buffer.concat([tree,tree]),Buffer.concat([Buffer.from('100644 ../foreign\0'),Buffer.from(blob,'hex')]),Buffer.concat([Buffer.from('777777 fixed.mjs\0'),Buffer.from(blob,'hex')]),Buffer.from('100644 incomplete'),Buffer.concat([Buffer.from([0xb1,0x30,0x30,0x36,0x34,0x34,32]),Buffer.from('fixed.mjs\0'),Buffer.from(blob,'hex')])])assert.throws(()=>employeeLifecycleGitTree(invalid));
});

test('the fixed controller owner binds its actual clean Git commit, descriptors and complete CI closure',()=>{
 // This is real read-only Git/filesystem I/O in the hosted controller checkout.
 // It is not API, application, database, host-admission or release evidence.
 // The separate reviewed PG owner must be integrated before this source check.
 const root=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,''),head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{env:nativePreparationEnvironment(process.env),encoding:'utf8',timeout:10000,killSignal:'SIGTERM'}).trim(),facts=readEmployeeLifecycleControllerFacts(head);
 assert.equal(facts.controller,head);assert.deepEqual(Object.keys(facts.sourceHashes),EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS);assert.deepEqual(Object.keys(facts.gitBlobs),EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS);assert.equal(facts.closureSha256,createHash('sha256').update(JSON.stringify(EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS)).digest('hex'));
 for(const file of EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS)assert.equal(facts.sourceHashes[file],createHash('sha256').update(readFileSync(root+'/'+file)).digest('hex'));
 assert.throws(()=>readEmployeeLifecycleControllerFacts('0'.repeat(40)));
});
