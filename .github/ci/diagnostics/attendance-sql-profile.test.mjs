/** Synthetic reports and fake Docker only; never launch PostgreSQL or application tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PROFILE_FILE,PROFILE_CASE,validateSelectedCase,validateStatistics,profile} from './attendance-sql-profile.mjs';
const names=JSON.parse(readFileSync(new URL('./attendance-unclocked-cases.json',import.meta.url)));
const selected=()=>({success:true,numTotalTests:32,numPassedTests:1,numFailedTests:0,numFailedTestSuites:0,numPendingTests:31,numTodoTests:0,testResults:[{name:join('/candidate',PROFILE_FILE),status:'passed',assertionResults:names.map(fullName=>({fullName,status:fullName===PROFILE_CASE?'passed':'skipped'}))}]});
test('one actual passing selection is distinct from31 deliberately unselected cases',()=>{
 assert.deepEqual(validateSelectedCase(selected(),'/candidate'),{registered:32,selectedPassed:1,deliberatelyUnselected:31,fullSuitePassed:false,releaseAuthorized:false});
 for(const edit of [r=>r.numPassedTests=32,r=>r.numPendingTests=0,r=>r.numFailedTests=1,r=>r.testResults[0].name='/foreign/file.ts',r=>r.testResults[0].assertionResults.pop(),r=>r.testResults[0].assertionResults.find(a=>a.fullName===PROFILE_CASE).status='pending',r=>r.testResults[0].assertionResults.find(a=>a.fullName!==PROFILE_CASE).status='passed']){const r=selected();edit(r);assert.throws(()=>validateSelectedCase(r,'/candidate'));}
});
const row=()=>Object.assign(Object.fromEntries(['calls','plans','total_exec_time','total_plan_time','mean_exec_time','shared_blks_hit','shared_blks_read','blk_read_time','blk_write_time','jit_functions','jit_generation_time','jit_inlining_time','jit_optimization_time','jit_emission_time'].map(k=>[k,1])),{userid:'10',dbid:'100',queryid:'-123',toplevel:true,original_query_bytes:8,query:'SELECT 1'});
const stats=()=>({settings:{preload:'pg_stat_statements',track:'all',planning:'on',ioTiming:'on',jit:'on',serverVersionNum:'160015'},applicationRole:{name:'ai_hr_app',superuser:false,bypassRls:false,createDb:false,createRole:false},entryCount:3,info:{dealloc:0,stats_reset:'2026-10-26T00:00:00Z'},execution:[row()],planning:[row()],jit:[row()]});
test('statistics require real enabled counters and an unprivileged RLS application role',()=>{
 assert.equal(validateStatistics(stats(),'on').releaseAuthorized,false);
 for(const edit of [s=>s.applicationRole.bypassRls=true,s=>s.settings.planning='off',s=>s.info.dealloc=1,s=>s.execution=[],s=>s.jit[0].query=null,s=>s.planning[0].total_plan_time=-1,s=>s.settings.jit='off']){const s=stats();edit(s);assert.throws(()=>validateStatistics(s,'on'));}
});
test('PG statistics are default-off and require explicit manual diagnostic ownership; Docker is a fake',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'attendance-sql-controller-'))),trace=join(dir,'trace');
 try{
  writeFileSync(join(dir,'docker'),'#!/bin/sh\ncase "$1" in container|inspect) exit 1;; esac\nprintf "%s\\n" "$@" >> "$AIHR_DOCKER_TRACE"\nexit 0\n',{mode:0o700});
  writeFileSync(join(dir,'seq'),'#!/bin/sh\nprintf "1\\n"\n',{mode:0o700});
  const inherited={...process.env};delete inherited.AIHR_CI_PG_CONFIGURED_CAP_BYTES;delete inherited.AIHR_CI_PG_PEAK_BUDGET_BYTES;
  const script=fileURLToPath(new URL('../postgres.sh',import.meta.url)),env={...inherited,PATH:dir+':/usr/bin:/bin',AIHR_DOCKER_TRACE:trace,GITHUB_ACTIONS:'true',CI:'true',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_UNIT:'db-3',AIHR_CI_PG_PROFILE:'legacy-2g',AIHR_CI_PG_MEMORY_GIB:'2',AIHR_CI_PG_JIT:'on',GITHUB_EVENT_NAME:'workflow_dispatch',AIHR_CI_PG_STATEMENTS:'0'};
  let r=spawnSync('/bin/bash',[script,'reset'],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);let text=readFileSync(trace,'utf8');assert(!text.includes('shared_preload_libraries'));assert(text.includes('NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'));rmSync(trace);
  r=spawnSync('/bin/bash',[script,'reset'],{env:{...env,AIHR_CI_PG_STATEMENTS:'1',AIHR_CI_PG_STATEMENTS_OWNER:'attendance-sql-profile'},encoding:'utf8'});assert.equal(r.status,0,r.stderr);text=readFileSync(trace,'utf8');assert(text.includes('shared_preload_libraries=pg_stat_statements')&&text.includes('pg_stat_statements.track_planning=on')&&text.includes('track_io_timing=on')&&text.includes('--memory=2147483648')&&text.includes('--memory-swap=2147483648'));rmSync(trace);
  r=spawnSync('/bin/bash',[script,'reset'],{env:{...env,AIHR_CI_PG_STATEMENTS:'1',AIHR_CI_PG_STATEMENTS_OWNER:'visibility-plan-benchmark'},encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert(readFileSync(trace,'utf8').includes('shared_preload_libraries=pg_stat_statements'));rmSync(trace);
  for(const changes of [{AIHR_CI_PG_STATEMENTS:'other'},{AIHR_CI_PG_STATEMENTS:'1',AIHR_CI_PG_STATEMENTS_OWNER:'not-owned'},{AIHR_CI_PG_STATEMENTS:'1',AIHR_CI_PG_STATEMENTS_OWNER:'attendance-sql-profile',GITHUB_EVENT_NAME:'push'}]){r=spawnSync('/bin/bash',[script,'reset'],{env:{...env,...changes},encoding:'utf8'});assert.equal(r.status,2);assert.equal(existsSync(trace),false);}
 }finally{rmSync(dir,{recursive:true});}
});
test('profiler refuses non-runner invocation before any source or database access',async()=>{
 const previous=process.env.GITHUB_ACTIONS;try{process.env.GITHUB_ACTIONS='false';await assert.rejects(profile(),/Owned hosted diagnostic/);}finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}
});

test('retained actual Vitest4.1.8 report uses skipped assertions with aggregate pending count',()=>{
 const raw=readFileSync(new URL('./fixtures/attendance-selected-vitest-4.1.8.json',import.meta.url));
 const report=JSON.parse(raw);
 assert.equal(validateSelectedCase(report,'/home/runner/work/ai-hr/ai-hr/source').selectedPassed,1);
 assert.equal(report.numPendingTests,31);
 assert.equal(report.testResults[0].assertionResults.filter(a=>a.status==='skipped').length,31);
 const missing=structuredClone(report);missing.testResults[0].assertionResults.find(a=>a.fullName===PROFILE_CASE).status='skipped';assert.throws(()=>validateSelectedCase(missing,'/home/runner/work/ai-hr/ai-hr/source'));
 const wrong=structuredClone(report);wrong.testResults[0].assertionResults.find(a=>a.fullName!==PROFILE_CASE).status='pending';assert.throws(()=>validateSelectedCase(wrong,'/home/runner/work/ai-hr/ai-hr/source'));
});
