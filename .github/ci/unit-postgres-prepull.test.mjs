/** Pure transport/receipt controls; never downloads or starts Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativePostgresOwner,validatePostgresPrepull,prefetchNativePostgres,NATIVE_POSTGRES_IMAGE,POSTGRES_PULL_TIMEOUT_MS} from './unit-postgres-prepull.mjs';
import {UNIT_RECOVERY as c} from './unit-recovery-policy.mjs';
const bytes=readFileSync(new URL('./postgres.sh',import.meta.url)),blob='49d3fe2671ca6f13192169d8101c2c14f62236fc';
const t=n=>new Date(Date.parse('2026-11-19T09:00:00Z')+n).toISOString();
function fixture(){const owner=nativePostgresOwner(bytes,blob);return {owner,source:c.source,controller:'e'.repeat(40),runId:200,unit:c.unit,producer:{started_at:t(0),completed_at:t(10000)},fontStep:{started_at:t(3000),completed_at:t(5000)}};}
function proof(){const f=fixture();return {kind:'BOUNDED_SOURCE_NATIVE_POSTGRES_PREPULL_NOT_TEST_PASS',releaseAuthorized:false,source:f.source,controller:f.controller,runId:f.runId,attempt:1,unit:f.unit,owner:f.owner,timeoutMs:180000,pullAttempts:1,startedAt:t(1000),endedAt:t(2000),pull:{status:0,signal:null,errorCode:null,timedOut:false,elapsedMs:1000},inspect:{status:0,signal:null,errorCode:null,configId:'sha256:'+'a'.repeat(64),repoDigests:[NATIVE_POSTGRES_IMAGE.replace('postgres:16@','postgres@')],os:'linux',architecture:'amd64'}};}
test('source owner pins exactly the actual native immutable image; config ID is distinct from manifest digest',()=>{const p=proof(),r=validatePostgresPrepull(p,fixture());assert.equal(r.pullAttempts,1);assert.notEqual(r.inspect.configId,NATIVE_POSTGRES_IMAGE.split('@')[1]);assert.equal(POSTGRES_PULL_TIMEOUT_MS,180000);assert.throws(()=>nativePostgresOwner(Buffer.from(bytes.toString().replace('postgres:16@','postgres:17@')),blob));assert.throws(()=>nativePostgresOwner(Buffer.concat([bytes,Buffer.from('\n'+NATIVE_POSTGRES_IMAGE)]),blob));});
for(const [name,edit]of [['timeout',p=>p.pull.timedOut=true],['exit',p=>p.pull.status=124],['second attempt',p=>p.pullAttempts=2],['owner blob',p=>p.owner.gitBlob='b'.repeat(40)],['manifest',p=>p.inspect.repoDigests=['postgres@sha256:'+'b'.repeat(64)]],['wrong platform',p=>p.inspect.architecture='arm64'],['config masquerading as digest',p=>p.inspect.repoDigests=[p.inspect.configId]],['after fonts',p=>p.endedAt=t(4000)],['wrong source',p=>p.source='b'.repeat(40)],['failed inspect',p=>p.inspect.status=1]])test('pre-pull refuses '+name,()=>{const p=proof();edit(p);assert.throws(()=>validatePostgresPrepull(p,fixture()));});
test('one bounded transport command records real mocked exit/timeout and never retries or inspects after failure',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-prepull-'));try{
  const event=join(dir,'event.json'),output=join(dir,'proof.json');writeFileSync(event,JSON.stringify({inputs:{missing_unit:c.unit,missing_original_run:String(c.runId),expected_sha:c.source,candidate_ref:'codex/frozen'}}));
  const env={GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_JOB:'test',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_HEAD:c.source,AIHR_CI_CONTROL_HEAD:'e'.repeat(40),GITHUB_RUN_ID:'200',AIHR_CI_UNIT:c.unit};
  const calls=[],git=(...args)=>args[0]==='status'?'':args[1]==='HEAD'?c.source:blob;
  assert.throws(()=>prefetchNativePostgres({env,output,git,run:(...args)=>{calls.push(args);return {status:124,signal:null};}}));
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/usr/bin/timeout');assert.deepEqual(calls[0][1],['--signal=TERM','--kill-after=10s','180s','docker','pull',NATIVE_POSTGRES_IMAGE]);assert.equal(calls[0][2].timeout,195000);
  const p=JSON.parse(readFileSync(output,'utf8'));assert.equal(p.pull.status,124);assert.equal(p.pull.timedOut,true);assert.equal(p.pullAttempts,1);assert.equal(p.inspect,undefined);assert.equal(p.releaseAuthorized,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
