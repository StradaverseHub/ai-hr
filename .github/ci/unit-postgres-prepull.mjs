/** One bounded transport attempt for the unchanged source-owned native PostgreSQL image. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateMissingUnitRequest} from './repair-missing-unit-policy.mjs';
export const POSTGRES_PULL_TIMEOUT_MS=180000;
export const NATIVE_POSTGRES_IMAGE='postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const sum=b=>createHash('sha256').update(b).digest('hex');
export function nativePostgresOwner(bytes,blob){
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=64*1024&&/^[a-f0-9]{40}$/.test(blob),'Bounded actual source owner required');
 const matches=bytes.toString('utf8').match(/postgres:16@sha256:[a-f0-9]{64}/g);
 assert.deepEqual(matches,[NATIVE_POSTGRES_IMAGE],'Native source image owner changed');
 return {path:'.github/ci/postgres.sh',gitBlob:blob,sha256:sum(bytes),image:NATIVE_POSTGRES_IMAGE};
}
export function validatePostgresPrepull(p,{owner,source,controller,runId,unit,producer,fontStep,prepullStep}){
 assert(p?.kind==='BOUNDED_SOURCE_NATIVE_POSTGRES_PREPULL_NOT_TEST_PASS'&&p.releaseAuthorized===false&&p.source===source&&p.controller===controller&&p.runId===runId&&p.attempt===1&&p.unit===unit,'Exact pre-pull source/producer identity required');
 assert(JSON.stringify(p.owner)===JSON.stringify(owner)&&p.timeoutMs===POSTGRES_PULL_TIMEOUT_MS&&p.pullAttempts===1,'Pre-pull owner/timeout/attempt changed');
 assert(p.pull?.status===0&&p.pull.signal===null&&p.pull.errorCode===null&&p.pull.timedOut===false&&p.pull.elapsedMs>=0&&p.pull.elapsedMs<=195000,'Actual bounded successful image pull required');
 assert(p.inspect?.status===0&&p.inspect.signal===null&&p.inspect.errorCode===null&&p.inspect.os==='linux'&&p.inspect.architecture==='amd64'&&/^sha256:[a-f0-9]{64}$/.test(p.inspect.configId),'Actual immutable image inspection required');
 const digest=owner.image.replace('postgres:16@','postgres@');
 assert(Array.isArray(p.inspect.repoDigests)&&p.inspect.repoDigests.some(x=>x===digest||x==='docker.io/library/'+digest),'Actual RepoDigests must contain source-owned immutable digest');
 // GitHub step timestamps are truncated to seconds; the local receipt retains milliseconds.
 // Admit only that sub-second quantization, backed by actual successful numbered step order.
 assert(prepullStep?.conclusion==='success'&&fontStep?.conclusion==='success'&&Number.isSafeInteger(prepullStep.number)&&prepullStep.number>0&&Number.isSafeInteger(fontStep.number)&&fontStep.number>0&&prepullStep.number<fontStep.number,'Actual successful pre-pull must precede the font step');
 assert(Date.parse(p.startedAt)>=Date.parse(producer.started_at)&&Date.parse(p.startedAt)>=Date.parse(prepullStep.started_at)&&Date.parse(p.endedAt)>=Date.parse(p.startedAt)&&Date.parse(p.endedAt)<Date.parse(prepullStep.completed_at)+1000&&Date.parse(prepullStep.completed_at)<=Date.parse(fontStep.started_at)&&Date.parse(p.endedAt)<Date.parse(fontStep.started_at)+1000&&Date.parse(fontStep.completed_at)<=Date.parse(producer.completed_at),'Pre-pull must complete inside its actual step before fonts (second-precision API)');
 return {kind:p.kind,owner,source,controller,runId,unit,timeoutMs:p.timeoutMs,pullAttempts:1,pull:p.pull,inspect:p.inspect,startedAt:p.startedAt,endedAt:p.endedAt,releaseAuthorized:false};
}
export function prefetchNativePostgres({env=process.env,output,run=spawnSync,clock=Date.now,git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()}={}){
 const event=JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8'));validateMissingUnitRequest(event.inputs??{},env.GITHUB_EVENT_NAME);
 assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.GITHUB_JOB==='test'&&env.GITHUB_RUN_ATTEMPT==='1'&&env.AIHR_CI_HEAD===event.inputs.expected_sha&&git('rev-parse','HEAD')===event.inputs.expected_sha&&git('status','--porcelain')==='','Actual clean frozen hosted native source required');
 assert(/^[a-f0-9]{40}$/.test(env.AIHR_CI_CONTROL_HEAD??'')&&/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'')&&env.AIHR_CI_UNIT===event.inputs.missing_unit,'Actual recovery producer identity required');
 const owner=nativePostgresOwner(readFileSync('.github/ci/postgres.sh'),git('rev-parse','HEAD:.github/ci/postgres.sh'));
 const p={kind:'BOUNDED_SOURCE_NATIVE_POSTGRES_PREPULL_NOT_TEST_PASS',releaseAuthorized:false,source:env.AIHR_CI_HEAD,controller:env.AIHR_CI_CONTROL_HEAD,runId:Number(env.GITHUB_RUN_ID),attempt:1,unit:env.AIHR_CI_UNIT,owner,timeoutMs:POSTGRES_PULL_TIMEOUT_MS,pullAttempts:1,startedAt:new Date(clock()).toISOString()};
 try{
  const start=clock(),pull=run('/usr/bin/timeout',['--signal=TERM','--kill-after=10s','180s','docker','pull',owner.image],{stdio:'inherit',timeout:195000,killSignal:'SIGKILL'});
  p.pull={status:pull.status,signal:pull.signal??null,errorCode:pull.error?.code??null,timedOut:pull.status===124||pull.status===137||pull.error?.code==='ETIMEDOUT',elapsedMs:clock()-start};
  assert(pull.status===0&&!pull.signal&&!pull.error,'Bounded native image transport failed');
  const inspected=run('docker',['image','inspect',owner.image],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  p.inspect={status:inspected.status,signal:inspected.signal??null,errorCode:inspected.error?.code??null};
  assert(inspected.status===0&&!inspected.signal&&!inspected.error,'Native image inspect failed');
  const rows=JSON.parse(inspected.stdout);assert(Array.isArray(rows)&&rows.length===1,'Single immutable image required');
  Object.assign(p.inspect,{configId:rows[0].Id,repoDigests:rows[0].RepoDigests,os:rows[0].Os,architecture:rows[0].Architecture});
  assert(p.inspect.os==='linux'&&p.inspect.architecture==='amd64'&&/^sha256:[a-f0-9]{64}$/.test(p.inspect.configId)&&p.inspect.repoDigests?.some(x=>x===owner.image.replace('postgres:16@','postgres@')||x==='docker.io/library/'+owner.image.replace('postgres:16@','postgres@')),'Native immutable image/platform differs');
 }finally{mkdirSync(dirname(output),{recursive:true,mode:0o700});p.endedAt=new Date(clock()).toISOString();writeFileSync(output,JSON.stringify(p,null,2)+'\n',{flag:'wx',mode:0o600});}
 return p;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert(process.argv.length===3);prefetchNativePostgres({output:process.argv[2]});}
