/** Authenticated same-run build transfer for actual Next verification only.
 * No release, installation, alternate-origin or packet-supplied authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,realpathSync,lstatSync,readFileSync,openSync,closeSync,fstatSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX,inspectCiNativeBuildPacket,bindCiBuildSource} from './build-artifact.mjs';
import {downloadCiArchives} from './archive-downloads.mjs';
import {nativePreparationEnvironment} from './candidate-environment.mjs';
import {nativeNextUnit,validateNativeBuildPrerequisite} from './singleton-protocol.mjs';
import {NATIVE_HELPER_SOURCES} from './native-next-helper-sources.mjs';
import {captureInstallation,readProtectedBootstrap} from './native-next-installation.mjs';
export {NATIVE_HELPER_SOURCES} from './native-next-helper-sources.mjs';
const REPOSITORY='StradaverseHub/ai-hr',REPOSITORY_ID=1333414856,WORKFLOW_ID=395777276;
// The native workflow protects this owner closure before package invocation.
// Cache reviewed controller bytes before classifier/migration/test children. Missing
// future fixtures do not affect metadata tests, but actual native provisioning
// refuses them. Paths are never reopened as privileged code after preparation.
const NATIVE_HELPER_BYTES=new Map(Object.entries(NATIVE_HELPER_SOURCES).map(([name,path])=>{
 let fd;try{
  fd=openSync(new URL('../../'+path,import.meta.url),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=1024**2&&(before.mode&0o022)===0);
  const bytes=readFileSync(fd),after=fstatSync(fd);assert.equal(bytes.length,before.size);
  for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key]);
  return[name,bytes];
 }catch(error){if(error.code==='ENOENT')return[name,null];throw error;}finally{if(fd!==undefined)closeSync(fd);}
}));
const NATIVE_BUILD_SEALER=NATIVE_HELPER_BYTES.get('next_build_binding.py')?.toString('utf8');
assert(typeof NATIVE_BUILD_SEALER==='string');
assert(Buffer.byteLength(NATIVE_BUILD_SEALER)>0&&Buffer.byteLength(NATIVE_BUILD_SEALER)<=1024*1024);
export function nativeHelperClosure(plan,source){
 assert(/^[a-f0-9]{40}$/.test(plan?.sha)&&/^[a-f0-9]{40}$/.test(plan?.controller),'Exact native helper source/controller required');
 const automation=realpathSync(fileURLToPath(new URL('../../',import.meta.url))),helpers={};let total=0;
 for(const [name,path]of Object.entries(NATIVE_HELPER_SOURCES)){
  const bytes=NATIVE_HELPER_BYTES.get(name);assert(Buffer.isBuffer(bytes),'Native helper closure is incomplete');total+=bytes.length;assert(total<=2*1024**2);
  const from=(directory,sha)=>execFileSync('git',['-c','safe.directory='+directory,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',directory,'show','--end-of-options',sha+':'+path],{timeout:30000,maxBuffer:1024**2});
  assert(bytes.equals(from(automation,plan.controller))&&bytes.equals(from(source,plan.sha)),'Native candidate/controller helper bytes differ from their committed identities');
  helpers[name]={sourcePath:path,sha256:createHash('sha256').update(bytes).digest('hex'),
   gitBlobId:createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex'),base64:bytes.toString('base64')};
 }
 return helpers;
}
const INSTALLATIONS=new WeakSet();
/** Full native job only. Must run BEFORE createPlan invokes the classifier. */
export function captureNativeNextInstallation(env=process.env){
 if(env.GITHUB_JOB!=='native-test')return null;
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:REPOSITORY,GITHUB_REPOSITORY_ID:String(REPOSITORY_ID),GITHUB_RUN_ATTEMPT:'1'}))assert.equal(env[key],value);
 const plan={sha:env.AIHR_CI_HEAD,controller:env.AIHR_CI_CONTROL_HEAD};
 assert.equal(env.GITHUB_SHA,plan.controller);
 const workspace=realpathSync(env.GITHUB_WORKSPACE),source=realpathSync(process.cwd());assert.equal(source,join(workspace,'source'));
 const bootstrap=readProtectedBootstrap(env),helpers=nativeHelperClosure(plan,source);
 assert.equal(realpathSync(fileURLToPath(new URL('../../',import.meta.url))),bootstrap.automation);
 const git=(directory,...args)=>execFileSync('git',['-c','safe.directory='+directory,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',directory,...args],{encoding:'utf8',timeout:30000,maxBuffer:1048576}).trim();
 assert.equal(git(source,'rev-parse','HEAD'),plan.sha);assert.equal(git(source,'status','--porcelain'),'');
 const snapshot={source,sha:plan.sha,controller:plan.controller,helpers,...captureInstallation({source,helpers,bootstrap},env)};
 INSTALLATIONS.add(snapshot);return snapshot;
}
const positive=value=>Number.isSafeInteger(value)&&value>0;
const stamp=value=>typeof value==='string'?Date.parse(value):NaN;
const repo=value=>value?.id===REPOSITORY_ID&&value.full_name===REPOSITORY;
const branch=value=>['main','alpha'].includes(value)||typeof value==='string'&&/^codex\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value);
export function validateNativeBuildMetadata({run,jobs,artifacts,pullRequest},expected,now=Date.now()){
 assert(positive(expected?.runId)&&/^[a-f0-9]{40}$/.test(expected.source)&&/^[a-f0-9]{40}$/.test(expected.controller));
 assert(Number.isFinite(now));
 const pr=expected.controllerRef?.match(/^refs\/pull\/([1-9][0-9]*)\/merge$/),isPr=run?.event==='pull_request';
 if(isPr){
  assert(pr&&pullRequest?.number===Number(pr[1]));
  assert(repo(pullRequest.head?.repo)&&repo(pullRequest.base?.repo)&&pullRequest.base.ref==='alpha');
  assert.equal(pullRequest.head.sha,expected.source);assert.equal(pullRequest.head.ref,expected.controllerBranch);
  assert.equal(pullRequest.merge_commit_sha,expected.controller);
  assert(Array.isArray(run.pull_requests)&&run.pull_requests.length===1&&run.pull_requests[0].number===pullRequest.number);
  assert.equal(run.pull_requests[0].head?.sha,expected.source);assert.equal(run.pull_requests[0].head?.repo?.id,REPOSITORY_ID);
  assert.equal(run.head_sha,expected.source);
 }else{assert(!pr&&branch(expected.controllerBranch));assert.equal(run?.head_sha,expected.controller);}
 const apiHead=isPr?expected.source:expected.controller;
 assert(run?.id===expected.runId&&run.run_attempt===1&&repo(run.repository)&&repo(run.head_repository));
 assert.equal(run.head_branch,expected.controllerBranch);
 assert.equal(run.workflow_id,WORKFLOW_ID);assert.equal(run.path,'.github/workflows/alpha-staging.yml');
 // The producer is terminal; this consuming job means the whole run is still
 // in progress. This contract intentionally cannot satisfy validateRun/release.
 assert(['in_progress','completed'].includes(run.status));
 assert(isPr||run.event==='workflow_dispatch'||run.event==='push'&&run.head_branch==='alpha'&&expected.source===expected.controller);
 const created=stamp(run.created_at);assert(Number.isFinite(created)&&created<=now&&now-created<=86400000);
 assert(Array.isArray(jobs)&&jobs.length>0&&jobs.length<=512);
 const seen=new Set();for(const job of jobs){
  assert(positive(job?.id)&&!seen.has(job.id));seen.add(job.id);
  assert.equal(job.run_id,run.id);assert.equal(job.run_attempt,1);assert.equal(job.head_sha,apiHead);assert.equal(job.head_branch,run.head_branch);
 }
 const producers=jobs.filter(job=>job.name==='build');assert.equal(producers.length,1);
 const producer=producers[0],started=stamp(producer.started_at),completed=stamp(producer.completed_at);
 assert.equal(producer.status,'completed');assert.equal(producer.conclusion,'success');
 assert(Number.isFinite(started)&&Number.isFinite(completed)&&created<=started&&started<=completed&&completed<=now);
 assert(Array.isArray(artifacts)&&artifacts.length>0&&artifacts.length<=512);
 const matches=artifacts.filter(value=>value.name===BUILD_ARTIFACT);assert.equal(matches.length,1);
 const artifact=matches[0],when=stamp(artifact.created_at),expires=stamp(artifact.expires_at),origin=artifact.workflow_run;
 assert(positive(artifact.id)&&positive(artifact.size_in_bytes)&&artifact.size_in_bytes<=BUILD_ZIP_MAX&&artifact.expired===false);
 assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest??''));
 assert.equal(origin?.id,run.id);assert.equal(origin.repository_id,REPOSITORY_ID);assert.equal(origin.head_repository_id,REPOSITORY_ID);
 assert.equal(origin.head_sha,apiHead);assert.equal(origin.head_branch,run.head_branch);
 assert(Number.isFinite(when)&&Number.isFinite(expires)&&started<=when&&when<=completed&&expires>now);
 return {artifact,producer,expected:{candidate:expected.source,controller:expected.controller,runId:run.id,controllerBranch:run.head_branch,
  producerStartedAt:producer.started_at,producerCompletedAt:producer.completed_at,...(isPr?{controllerRef:expected.controllerRef}:{})}};
}
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:60000,maxBuffer:16*1024**2}));
function pages(path,key){
 const result=[];for(let page=1;page<=6;page++){
  const data=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
  assert(Array.isArray(data[key]));result.push(...data[key]);assert(result.length<=512,'Native build API inventory exceeds bound');
  if(data[key].length<100)return result;
 }
 throw Error('Native build API inventory is incomplete');
}
/** Called by the authenticated full-CI unit owner before any application child.
 * Actual singleton host/plan admission remains a separate mandatory operation. */
export async function provisionNativeNextBuild(plan,unit,directory,env=process.env,snapshot){
 assert(nativeNextUnit(unit),'Actual registered hybrid unit required');
 assert(snapshot&&INSTALLATIONS.has(snapshot)&&snapshot.sha===plan.sha&&snapshot.controller===plan.controller
  &&snapshot.source===realpathSync(process.cwd()),'Original pre-classifier installation capture required');
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:REPOSITORY,GITHUB_REPOSITORY_ID:String(REPOSITORY_ID),GITHUB_JOB:'native-test',GITHUB_RUN_ATTEMPT:'1'}))assert.equal(env[key],value);
 assert.equal(env.AIHR_CI_HEAD,plan.sha);assert.equal(env.AIHR_CI_CONTROL_HEAD,plan.controller);assert.equal(env.GITHUB_SHA,plan.controller);
 const runId=Number(env.GITHUB_RUN_ID);assert(positive(runId));
 const pr=env.GITHUB_EVENT_NAME==='pull_request'?env.GITHUB_REF?.match(/^refs\/pull\/([1-9][0-9]*)\/merge$/):null;
 if(pr)assert.equal(env.GITHUB_REF_NAME,pr[1]+'/merge');else{assert.equal(env.GITHUB_REF,'refs/heads/'+env.GITHUB_REF_NAME);assert(branch(env.GITHUB_REF_NAME));}
 assert.equal(env.GITHUB_WORKFLOW_REF,REPOSITORY+'/.github/workflows/alpha-staging.yml@'+env.GITHUB_REF);
 assert.equal(realpathSync(directory),directory);
 const parent=lstatSync(directory);assert(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===process.getuid());
 // This tree is deliberately OUTSIDE the uploaded unit-evidence directory.
 const temporary=realpathSync(env.RUNNER_TEMP);assert.equal(directory,join(temporary,'aihr-ci'));
 const root=join(temporary,unit.id+'-native-build-private');mkdirSync(root,{mode:0o700});
 const helpers=snapshot.helpers;
 const downloads=join(root,'archives');mkdirSync(downloads,{mode:0o700});
 const actualRun=api(`actions/runs/${runId}`);assert.equal(actualRun.event,env.GITHUB_EVENT_NAME);
 const metadata=validateNativeBuildMetadata({run:actualRun,jobs:pages(`actions/runs/${runId}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${runId}/artifacts`,'artifacts'),...(pr?{pullRequest:api('pulls/'+pr[1])}:{})},
  {source:plan.sha,controller:plan.controller,runId,controllerBranch:pr?actualRun.head_branch:env.GITHUB_REF_NAME,...(pr?{controllerRef:env.GITHUB_REF}:{})});
 const transfer=await downloadCiArchives([metadata.artifact],downloads,{concurrency:1});
 assert.equal(transfer.artifacts.length,1);assert.equal(transfer.artifacts[0].status,'verified');
 const packetDirectory=join(root,'packet');
 execFileSync('python3',['-I','-B',fileURLToPath(new URL('./build-transport-extract.py',import.meta.url)),transfer.artifacts[0].path,packetDirectory,metadata.artifact.digest.slice(7)],{timeout:60000,maxBuffer:1048576});
 assert.equal(realpathSync(packetDirectory),packetDirectory);assert.equal(lstatSync(packetDirectory).mode&0o777,0o700);
 const inspected=inspectCiNativeBuildPacket(packetDirectory,metadata.expected);
 assert.equal(inspected.lockSha256,snapshot.installation.lockSha256);assert.equal(inspected.packageSha256,snapshot.installation.packageSha256);
 // Canonical preparation executes candidate code only in a credential-free
 // fixed child. The API owner never imports that code into its own process.
 const source=realpathSync(process.cwd()),preparedPath=join(root,'canonical-prepared.json');
 const preparationEnv=nativePreparationEnvironment(env);
 execFileSync('pnpm',['exec','tsx',fileURLToPath(new URL('./native-next-build-inputs.mjs',import.meta.url)),source,preparedPath,plan.sha,inspected.buildRecordId],{cwd:source,env:preparationEnv,timeout:60000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']});
 const fd=openSync(preparedPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 let preparedBytes;try{const st=fstatSync(fd);assert(st.isFile()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o777)===0o600&&st.size>0&&st.size<=80*1024);preparedBytes=readFileSync(fd);assert.equal(preparedBytes.length,st.size);}finally{closeSync(fd);}
 const packet=bindCiBuildSource(inspected,{lockBytes:snapshot.lockBytes,packageBytes:snapshot.packageBytes,preparedBytes});
 assert.equal(packet.canonicalCandidateInputsVerified,true);
 assert.equal(packet.kind,'VERIFIED_NATIVE_NEXT_PACKET_NOT_RELEASE');
 const prerequisite={kind:'same-run-canonical-next-build',source:plan.sha,controller:plan.controller,runId:String(runId),attempt:'1',
  artifactId:String(metadata.artifact.id),artifactDigest:metadata.artifact.digest,producerJobId:String(metadata.producer.id),nextBuildId:packet.nextBuildId,
  archiveSha256:packet.archiveSha256,manifestSha256:packet.manifestSha256,provenanceSha256:packet.provenanceSha256};
 validateNativeBuildPrerequisite(prerequisite,{source:plan.sha,controller:plan.controller,runId:String(runId),attempt:'1'});
 const binding={schemaVersion:1,kind:'AUTHENTICATED_SAME_RUN_NATIVE_NEXT_BUILD_NOT_RELEASE',expected:metadata.expected,
  artifact:{id:metadata.artifact.id,digest:metadata.artifact.digest,runId},producerJob:{id:metadata.producer.id,name:'build'},
  packet:{archiveSha256:packet.archiveSha256,manifestSha256:packet.manifestSha256,provenanceSha256:packet.provenanceSha256,nextBuildId:packet.nextBuildId},installation:snapshot.installation,releaseAuthorized:false};
 // Deliver the API owner's in-memory expected hashes directly, never a
 // candidate-writable binding file. The fixed stdlib root receiver copies only
 // exact five-member bytes into an exclusive root-owned immutable handoff.
 const sealed=JSON.parse(execFileSync('sudo',['-n','/usr/bin/python3','-I','-B','-c',NATIVE_BUILD_SEALER,'--seal'],
  {input:JSON.stringify({binding,unit:unit.id,runnerTemp:temporary,runnerUid:process.getuid(),helpers}),encoding:'utf8',timeout:60000,maxBuffer:65536,stdio:['pipe','pipe','pipe']}));
 const sealedRoot='/var/lib/aihr-native-build/'+runId+'/'+unit.id;
 assert.deepEqual(sealed,{packetDirectory:sealedRoot+'/packet',bindingPath:sealedRoot+'/build-binding.json'});
 return {prerequisite,...sealed};
}
