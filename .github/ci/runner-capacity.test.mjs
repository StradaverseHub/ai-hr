/** Pure numeric policy fixtures. Never run SDK deletion or any application process. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {capacityDecision,validateCapacityScope,BOUNDED_DB_KIB} from './runner-capacity.mjs';
test('bounded diagnostics retain an8GiB floor while legacy SDK cleanup stays unconditional',()=>{
 for(const value of [0,BOUNDED_DB_KIB-1])assert.equal(capacityDecision('bounded-db-diagnostic',value).decision,'clean');
 for(const value of [BOUNDED_DB_KIB,12810652,34226968])assert.equal(capacityDecision('bounded-db-diagnostic',value).decision,'enough');
 for(const value of [0,BOUNDED_DB_KIB,34226968])assert.equal(capacityDecision('legacy',value).decision,'clean');
 for(const value of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>capacityDecision('bounded-db-diagnostic',value));
 assert.throws(()=>capacityDecision('unknown',12810652));
});
test('reduced disk profile refuses local, self-hosted, unrelated and ordinary release workflows',()=>{
 const e={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-db-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025'};
 assert(validateCapacityScope('bounded-db-diagnostic',e));assert(validateCapacityScope('legacy',{}));
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'false',RUNNER_ENVIRONMENT:'self-hosted',GITHUB_REPOSITORY:'other/repo',GITHUB_REPOSITORY_ID:'9',GITHUB_EVENT_NAME:'push',GITHUB_WORKFLOW_REF:e.GITHUB_WORKFLOW_REF.replace('alpha-staging-db-diagnostics','alpha-staging')}))assert.throws(()=>validateCapacityScope('bounded-db-diagnostic',{...e,[key]:value}));
});

import {mkdtempSync,realpathSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
test('real shell skips all SDK operations with enough capacity and fails closed on bad scope or failed df; sudo is fake',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'runner-capacity-'))),trace=join(dir,'sudo-trace');
 try{
  writeFileSync(join(dir,'uname'),'#!/bin/sh\nprintf "Linux\\n"\n',{mode:0o700});
  writeFileSync(join(dir,'df'),'#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 75085112 62258076 12810652 83%% /\\n"\n[ "$AIHR_DF_FAIL" != 1 ]\n',{mode:0o700});
  writeFileSync(join(dir,'sudo'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$AIHR_SUDO_TRACE"\nexit 0\n',{mode:0o700});
  writeFileSync(join(dir,'node'),'#!/bin/sh\nexec '+quote(process.execPath)+' "$@"\n',{mode:0o700});
  const env={...process.env,PATH:dir+':/usr/bin:/bin',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-db-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025',GITHUB_WORKSPACE:dir,RUNNER_TEMP:dir,AIHR_CI_CAPACITY_PROFILE:'bounded-db-diagnostic',AIHR_SUDO_TRACE:trace};
  const script=fileURLToPath(new URL('./prepare-runner.sh',import.meta.url));
  const ok=spawnSync('/bin/bash',[script],{env,encoding:'utf8'});assert.equal(ok.status,0,ok.stderr);assert(ok.stdout.includes('skip unused SDK deletion'));assert(!existsSync(trace));
  for(const [changes,expected] of [[{AIHR_DF_FAIL:'1'},1],[{GITHUB_WORKFLOW_REF:'other'},2],[{AIHR_CI_CAPACITY_PROFILE:'unknown'},2]]){const r=spawnSync('/bin/bash',[script],{env:{...env,...changes},encoding:'utf8'});assert.equal(r.status,expected,r.stderr);assert(!existsSync(trace));}
 }finally{rmSync(dir,{recursive:true});}
});
