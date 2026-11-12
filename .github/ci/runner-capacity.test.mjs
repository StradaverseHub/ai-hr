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

import {mkdtempSync,realpathSync,writeFileSync,readFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
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
  const compilerEnv={...env,AIHR_CI_CAPACITY_PROFILE:'bounded-compiler-diagnostic',AIHR_COMPILER_TRANSPORT:'consumer',AIHR_COMPILER_COMPATIBLE_CHILD:'true',GITHUB_WORKFLOW_REF:env.GITHUB_WORKFLOW_REF.replace('alpha-staging-db-diagnostics.yml','alpha-staging-diagnostics.yml'),...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
  const compilerOk=spawnSync('/bin/bash',[script],{env:compilerEnv,encoding:'utf8'});assert.equal(compilerOk.status,0,compilerOk.stderr);assert(compilerOk.stdout.includes('skip unused SDK deletion'));assert(!existsSync(trace));
  const managedEnv={...compilerEnv,AIHR_CI_CAPACITY_PROFILE:'bounded-whole-compiler',AIHR_COMPILER_CACHE_MODE:'whole',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'typecheck',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/main'};
  const managedOk=spawnSync('/bin/bash',[script],{env:managedEnv,encoding:'utf8'});assert.equal(managedOk.status,0,managedOk.stderr);assert(managedOk.stdout.includes('skip unused SDK deletion'));assert(!existsSync(trace));
  const buildEnv={...env,AIHR_CI_CAPACITY_PROFILE:'bounded-next-build-diagnostic',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025',GITHUB_JOB:'next-build-cache',GITHUB_RUN_ATTEMPT:'1',AIHR_NEXT_BUILD_CACHE_MODE:'cold',AIHR_BUILD_DIAGNOSTIC:'transport-producer',...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
  const buildOk=spawnSync('/bin/bash',[script],{env:buildEnv,encoding:'utf8'});assert.equal(buildOk.status,0,buildOk.stderr);assert(buildOk.stdout.includes('skip unused SDK deletion'));assert(!existsSync(trace));
  const normalBuildEnv={...buildEnv,CI:'true',AIHR_CI_CAPACITY_PROFILE:'bounded-canonical-build',GITHUB_JOB:'build',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/main',
   AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'c'.repeat(40),GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'123'};
  const normalBuildOk=spawnSync('/bin/bash',[script],{env:normalBuildEnv,encoding:'utf8'});assert.equal(normalBuildOk.status,0,normalBuildOk.stderr);assert(normalBuildOk.stdout.includes('skip unused SDK deletion'));assert(!existsSync(trace));
  const badNormal=spawnSync('/bin/bash',[script],{env:{...normalBuildEnv,GITHUB_JOB:'test'},encoding:'utf8'});assert.equal(badNormal.status,2);assert(!existsSync(trace));
  for(const [changes,expected] of [[{AIHR_DF_FAIL:'1'},1],[{GITHUB_WORKFLOW_REF:'other'},2],[{AIHR_CI_CAPACITY_PROFILE:'unknown'},2]]){const r=spawnSync('/bin/bash',[script],{env:{...env,...changes},encoding:'utf8'});assert.equal(r.status,expected,r.stderr);assert(!existsSync(trace));}
 }finally{rmSync(dir,{recursive:true});}
});

test('bounded compiler consumer retains12GiB setup and8GiB before swap; ordinary compiler stays20GiB',async()=>{
 const {BOUNDED_COMPILER_SETUP_KIB,compilerSwapFloorKiB}=await import('./runner-capacity.mjs');
 const e={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',
 GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025',
 AIHR_COMPILER_TRANSPORT:'consumer',AIHR_COMPILER_COMPATIBLE_CHILD:'true',
 ...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
 assert.equal(BOUNDED_COMPILER_SETUP_KIB,12*1024**2);
 assert.equal(capacityDecision('bounded-compiler-diagnostic',BOUNDED_COMPILER_SETUP_KIB-1).decision,'clean');
 assert.equal(capacityDecision('bounded-compiler-diagnostic',12861104).decision,'enough');
 assert.equal(compilerSwapFloorKiB('bounded-compiler-diagnostic',e),8*1024**2);
 assert.equal(compilerSwapFloorKiB('legacy',{}),20*1024**2);
 for(const [key,value]of Object.entries({AIHR_COMPILER_TRANSPORT:'producer',AIHR_COMPILER_COMPATIBLE_CHILD:'false',GITHUB_REPOSITORY_ID:'1',GITHUB_EVENT_NAME:'push',
 GITHUB_WORKFLOW_REF:e.GITHUB_WORKFLOW_REF.replace('diagnostics.yml','alpha-staging.yml'),DATABASE_URL:'postgres://live',MIGRATION_DATABASE_URL:'postgres://live'}))
  assert.throws(()=>compilerSwapFloorKiB('bounded-compiler-diagnostic',{...e,[key]:value}));
 assert.throws(()=>compilerSwapFloorKiB('bounded-db-diagnostic',e));
});

test('normal whole compiler capacity requires its actual job/purpose, closed URLs and first attempt',async()=>{
 const {compilerSwapFloorKiB}=await import('./runner-capacity.mjs');
 const e={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',
 GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/main',GITHUB_JOB:'typecheck',GITHUB_RUN_ATTEMPT:'1',AIHR_COMPILER_CACHE_MODE:'whole',
 ...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
 for(const event of ['workflow_dispatch','push','pull_request'])assert.equal(compilerSwapFloorKiB('bounded-whole-compiler',{...e,GITHUB_EVENT_NAME:event}),8*1024**2);
 for(const [key,value]of Object.entries({GITHUB_JOB:'build',GITHUB_RUN_ATTEMPT:'2',AIHR_COMPILER_CACHE_MODE:'unknown',DATABASE_URL:'postgres://live',GITHUB_WORKFLOW_REF:'other'}))
  assert.throws(()=>compilerSwapFloorKiB('bounded-whole-compiler',{...e,[key]:value}));
 const pilot={...e,GITHUB_JOB:'compiler-cache-pilot',AIHR_COMPILER_CACHE_PILOT:'true',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025'};
 assert.equal(compilerSwapFloorKiB('bounded-whole-compiler',pilot),8*1024**2);
 assert.throws(()=>compilerSwapFloorKiB('bounded-whole-compiler',{...pilot,AIHR_COMPILER_CACHE_PILOT:'false'}));
});

test('application-build headroom is scoped to the dedicated diagnostic and cannot lower compiler swap admission',async()=>{
 const {compilerSwapFloorKiB}=await import('./runner-capacity.mjs');
 const e={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025',GITHUB_JOB:'next-build-cache',GITHUB_RUN_ATTEMPT:'1',AIHR_NEXT_BUILD_CACHE_MODE:'cold',AIHR_BUILD_DIAGNOSTIC:'transport-producer',
 ...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
 assert.equal(capacityDecision('bounded-next-build-diagnostic',12*1024**2-1).decision,'clean');
 assert.equal(capacityDecision('bounded-next-build-diagnostic',12*1024**2).decision,'enough');
 for(const mode of ['cold','warm','recover'])assert(validateCapacityScope('bounded-next-build-diagnostic',{...e,AIHR_NEXT_BUILD_CACHE_MODE:mode}));
 for(const changes of [{GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/unrelated.yml@refs/heads/codex/test-suite-efficiency-review-20261025'},{GITHUB_JOB:'typecheck'},{GITHUB_RUN_ATTEMPT:'2'},{AIHR_NEXT_BUILD_CACHE_MODE:'other'},{DATABASE_URL:'postgres://live'},{GITHUB_EVENT_NAME:'push'}])assert.throws(()=>validateCapacityScope('bounded-next-build-diagnostic',{...e,...changes}));
 assert.throws(()=>compilerSwapFloorKiB('bounded-next-build-diagnostic',e));
});

test('normal suite setup preserves24GiB pre-dependency and21GiB ready margins; test admission stays20GiB',async()=>{
 const {SUITE_SETUP_KIB,SUITE_READY_KIB,compilerSwapFloorKiB}=await import('./runner-capacity.mjs');
 assert.equal(SUITE_SETUP_KIB,24*1024**2);assert.equal(SUITE_READY_KIB,21*1024**2);
 for(const [profile,floor]of [['bounded-suite-setup',SUITE_SETUP_KIB],['bounded-suite-ready',SUITE_READY_KIB]]){
  assert.equal(capacityDecision(profile,floor-1).decision,'clean');assert.equal(capacityDecision(profile,floor).decision,'enough');
  const e={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'test',
   GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/alpha',GITHUB_SHA:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'a'.repeat(40)};
  for(const event of ['push','pull_request','workflow_dispatch'])for(const job of ['test','browser','controller-tests'])assert(validateCapacityScope(profile,{...e,GITHUB_JOB:job,GITHUB_EVENT_NAME:event}));
  for(const change of [{CI:'false'},{GITHUB_JOB:'build'},{GITHUB_JOB:'typecheck'},{GITHUB_JOB:'migrations'},{GITHUB_RUN_ATTEMPT:'2'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_REPOSITORY_ID:'1'},{GITHUB_SHA:'b'.repeat(40)},{GITHUB_WORKFLOW_REF:'other'}])assert.throws(()=>validateCapacityScope(profile,{...e,...change}));
  const pilot={...e,GITHUB_JOB:'runner-diagnostics',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/codex/test-suite-efficiency-review-20261025',AIHR_SUITE_CAPACITY_PILOT:'true'};
  assert(validateCapacityScope(profile,pilot));assert.throws(()=>validateCapacityScope(profile,{...pilot,AIHR_SUITE_CAPACITY_PILOT:'false'}));
  assert.throws(()=>compilerSwapFloorKiB(profile,e));
 }
});
test('suite shell checks the actual Docker filesystem before SDK mutation and does not delete anything when admitted',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'suite-capacity-'))),trace=join(dir,'trace'),dockerRoot=join(dir,'docker-root');
 mkdirSync(dockerRoot);
 try{
  writeFileSync(join(dir,'uname'),'#!/bin/sh\nprintf "Linux\\n"\n',{mode:0o700});
  writeFileSync(join(dir,'node'),'#!/bin/sh\nexec '+quote(process.execPath)+' "$@"\n',{mode:0o700});
  writeFileSync(join(dir,'docker'),'#!/bin/sh\n[ "$AIHR_DOCKER_FAIL" != 1 ] || exit 1\n[ "$1" = info ] || exit 97\nprintf "%s\\n" "$AIHR_FAKE_DOCKER_ROOT"\n',{mode:0o700});
  writeFileSync(join(dir,'df'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$AIHR_DF_TRACE"\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\n"\nfor p in "$@"; do [ "$p" != -Pk ] || continue; k=41943040; if [ "$p" = "$AIHR_FAKE_DOCKER_ROOT" ] && [ "$AIHR_DOCKER_LOW" = 1 ]; then k=20971520; fi; printf "/dev/fake 75085112 0 %s 55%% %s\\n" "$k" "$p"; done\n',{mode:0o700});
  writeFileSync(join(dir,'sudo'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$AIHR_SUDO_TRACE"\nexit 0\n',{mode:0o700});
  const e={...process.env,PATH:dir+':/usr/bin:/bin',GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',
   GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'test',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/alpha',
   GITHUB_SHA:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'a'.repeat(40),GITHUB_WORKSPACE:dir,RUNNER_TEMP:dir,AIHR_CI_CAPACITY_PROFILE:'bounded-suite-setup',AIHR_SUDO_TRACE:trace,AIHR_DF_TRACE:trace+'.df',AIHR_FAKE_DOCKER_ROOT:dockerRoot};
  const script=fileURLToPath(new URL('./prepare-runner.sh',import.meta.url));
  const result=spawnSync('/bin/bash',[script],{env:e,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert(!existsSync(trace));
  assert(readFileSync(trace+'.df','utf8').includes(dir+' '+dir+' '+dockerRoot));
  const bad=spawnSync('/bin/bash',[script],{env:{...e,AIHR_DOCKER_FAIL:'1'},encoding:'utf8'});assert.notEqual(bad.status,0);assert(!existsSync(trace));
  const low=spawnSync('/bin/bash',[script],{env:{...e,AIHR_CI_CAPACITY_PROFILE:'bounded-suite-ready',AIHR_DOCKER_LOW:'1'},encoding:'utf8'});assert.equal(low.status,2,low.stderr);assert(low.stderr.includes('Insufficient capacity'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('focused setup uses the same suite margins only in its actual first-attempt manual closed-DB context',()=>{
 const e={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'selected-tests',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/heads/codex/test-suite-efficiency-review-20261025',GITHUB_SHA:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'a'.repeat(40),AIHR_FOCUSED_SUITE_CAPACITY:'true',
  ...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
 for(const profile of ['bounded-suite-setup','bounded-suite-ready']){
  assert(validateCapacityScope(profile,e));
  for(const change of [{AIHR_FOCUSED_SUITE_CAPACITY:'false'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_EVENT_NAME:'push'},{GITHUB_JOB:'linux-build'},{GITHUB_WORKFLOW_REF:e.GITHUB_WORKFLOW_REF.replace('alpha-focused-checks','other')},{DATABASE_URL:'postgres://live'},{GITHUB_REPOSITORY_ID:'1'},{AIHR_CI_CONTROL_HEAD:'b'.repeat(40)}])assert.throws(()=>validateCapacityScope(profile,{...e,...change}));
 }
});

test('immutable repair selection retains suite margins only in its explicit hosted diagnostic context',()=>{
 const ref='codex/parity-v3-impact-selection-frozen',e={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'runner-diagnostics',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/'+ref,GITHUB_REF:'refs/heads/'+ref,GITHUB_SHA:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'a'.repeat(40),
  AIHR_DIAGNOSTICS_ONLY:'true',AIHR_CONTROLLER_ONLY:'false',AIHR_BUILD_ONLY:'false',AIHR_REPAIR_IMPACT_BASE:'b'.repeat(40),AIHR_CI_HEAD:'c'.repeat(40),
  ...Object.fromEntries(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database']))};
 for(const [profile,floor]of [['bounded-suite-setup',24*1024**2],['bounded-suite-ready',21*1024**2]]){
  assert(validateCapacityScope(profile,e));assert.equal(capacityDecision(profile,floor).decision,'enough');assert.equal(capacityDecision(profile,floor-1).decision,'clean');
  for(const change of [{GITHUB_ACTIONS:'false'},{CI:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_REPOSITORY_ID:'1'},
   {GITHUB_REPOSITORY:'other/repo'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_JOB:'build'},{GITHUB_EVENT_NAME:'push'},
   {GITHUB_WORKFLOW_REF:e.GITHUB_WORKFLOW_REF.replace('alpha-staging.yml','unrelated.yml')},{GITHUB_WORKFLOW_REF:e.GITHUB_WORKFLOW_REF.replace(ref,'main')},
   {GITHUB_REF:'refs/heads/codex/other'},{AIHR_DIAGNOSTICS_ONLY:'false'},{AIHR_CONTROLLER_ONLY:'true'},{AIHR_BUILD_ONLY:'true'},
   {AIHR_REPAIR_IMPACT_BASE:''},{AIHR_REPAIR_IMPACT_BASE:'alpha'},{AIHR_REPAIR_IMPACT_BASE:e.AIHR_CI_HEAD},{AIHR_CI_HEAD:'branch'},
   {AIHR_CI_CONTROL_HEAD:'d'.repeat(40)},...['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].map(k=>({[k]:'postgres://live'}))])
    assert.throws(()=>validateCapacityScope(profile,{...e,...change}));
 }
});
