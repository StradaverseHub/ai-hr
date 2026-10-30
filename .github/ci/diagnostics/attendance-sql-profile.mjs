/** One selected unchanged case, owned PG statistics, diagnostic only. Never a release witness. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FILES,sourceProof} from './attendance-split-benchmark.mjs';
import {measuredCommand} from './compiler-incremental.mjs';
import {capturePostgresEvidence,validatePostgresEvidence,postgresProfileFromEnv} from '../postgres-evidence.mjs';

export const PROFILE_FILE='test/attendance-policy-storage-unclocked.test.ts';
export const PROFILE_CASE="immutable non-payable policy part storage settles disjoint approved-plan quantity through the actual 'cash' owner with v4 (combined=true) while reserving original work";
const BASE='3c51317ea43ded103e782c37b55eccf9fdeae05c',UNIT='db-3';
const postgres=fileURLToPath(new URL('../postgres.sh',import.meta.url));
const registry=JSON.parse(readFileSync(new URL('./attendance-unclocked-cases.json',import.meta.url),'utf8'));
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:4*1024**2}).trim();
const escapeRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function validateSelectedCase(result,cwd){
  assert(result?.success===true&&result.numTotalTests===32&&result.numPassedTests===1&&result.numFailedTests===0
    &&result.numFailedTestSuites===0&&result.numPendingTests===31&&(result.numTodoTests??0)===0,'Selected diagnostic counts differ');
  assert(Array.isArray(result.testResults)&&result.testResults.length===1,'Foreign or missing diagnostic file');
  const suite=result.testResults[0];assert.equal(suite.name,join(cwd,PROFILE_FILE));assert.equal(suite.status,'passed');
  assert.equal(suite.assertionResults.length,32);assert.deepEqual(suite.assertionResults.map(a=>a.fullName).sort(),registry.slice().sort(),'Registered cases changed');
  let selected=0;for(const a of suite.assertionResults){if(a.fullName===PROFILE_CASE){selected++;assert.equal(a.status,'passed');}else assert.equal(a.status,'skipped','Only deliberately unselected cases may be skipped');}
  assert.equal(selected,1);return {registered:32,selectedPassed:1,deliberatelyUnselected:31,fullSuitePassed:false,releaseAuthorized:false};
}
const rowColumns=`userid::text,dbid::text,queryid::text,toplevel,calls,plans,total_exec_time,total_plan_time,mean_exec_time,
 shared_blks_hit,shared_blks_read,blk_read_time,blk_write_time,jit_functions,jit_generation_time,jit_inlining_time,jit_optimization_time,jit_emission_time,
 octet_length(query) AS original_query_bytes,left(query,8192) AS query`;
const cohort=order=>`(SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT ${rowColumns} FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' ORDER BY ${order} DESC,dbid,userid,queryid LIMIT 50) x)`;
export const STATISTICS_SQL=`SELECT json_build_object(
 'settings',(SELECT json_build_object('preload',current_setting('shared_preload_libraries'),'track',current_setting('pg_stat_statements.track'),
 'planning',current_setting('pg_stat_statements.track_planning'),'ioTiming',current_setting('track_io_timing'),'jit',current_setting('jit'),'serverVersionNum',current_setting('server_version_num'))),
 'applicationRole',(SELECT json_build_object('name',rolname,'superuser',rolsuper,'bypassRls',rolbypassrls,'createDb',rolcreatedb,'createRole',rolcreaterole) FROM pg_roles WHERE rolname='ai_hr_app'),
 'info',(SELECT row_to_json(x) FROM pg_stat_statements_info x),'entryCount',(SELECT count(*) FROM pg_stat_statements),
 'execution',${cohort('total_exec_time')},'planning',${cohort('total_plan_time')},
 'jit',${cohort('(jit_generation_time+jit_inlining_time+jit_optimization_time+jit_emission_time)')})`;
export function validateStatistics(stats,jit){
 assert(stats?.settings?.preload==='pg_stat_statements'&&stats.settings.track==='all'&&stats.settings.planning==='on'&&stats.settings.ioTiming==='on'
  &&stats.settings.jit===jit&&/^16\d{4}$/.test(stats.settings.serverVersionNum),'Statistics settings differ');
 assert.deepEqual(stats.applicationRole,{name:'ai_hr_app',superuser:false,bypassRls:false,createDb:false,createRole:false},'Application role became privileged');
 assert(Number.isSafeInteger(stats.entryCount)&&stats.entryCount>0&&stats.entryCount<=10000&&stats.info?.dealloc===0&&Number.isFinite(Date.parse(stats.info.stats_reset)),'Missing or evicted statement statistics');
 for(const key of ['execution','planning','jit']){
  assert(Array.isArray(stats[key])&&stats[key].length>0&&stats[key].length<=50,'Missing ranked statistics');
  for(const row of stats[key]){
   for(const field of ['userid','dbid'])assert(/^\d+$/.test(row[field]));assert(/^-?\d+$/.test(row.queryid)&&typeof row.toplevel==='boolean');
   for(const field of ['calls','plans','total_exec_time','total_plan_time','mean_exec_time','shared_blks_hit','shared_blks_read','blk_read_time','blk_write_time','jit_functions','jit_generation_time','jit_inlining_time','jit_optimization_time','jit_emission_time'])assert(Number.isFinite(row[field])&&row[field]>=0,'Invalid numeric statistic');
   assert(typeof row.query==='string'&&Buffer.byteLength(row.query)<=4*8192&&Number.isSafeInteger(row.original_query_bytes)&&row.original_query_bytes>=Buffer.byteLength(row.query),'Missing or oversized representative SQL');
  }
 }
 return {statisticsCompleteWithinConfiguredCapacity:true,rankedRows:stats.execution.length,topLevelAndNestedTimesOverlap:true,releaseAuthorized:false};
}
export async function profile(){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
   &&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.GITHUB_EVENT_NAME==='workflow_dispatch','Owned hosted diagnostic only');
 const cwd=realpathSync(process.cwd()),sha=git(cwd,'rev-parse','HEAD'),jit=process.env.AIHR_CI_PG_JIT;
 assert.equal(sha,process.env.AIHR_CI_HEAD);assert.equal(git(cwd,'status','--porcelain'),'');assert(['on','off'].includes(jit));assert.equal(process.env.AIHR_CI_PG_MEMORY_GIB,'2');
 const postgresProfile=postgresProfileFromEnv(process.env);assert.equal(postgresProfile.profileVersion,1);assert.equal(postgresProfile.profileId,'legacy-2g');
 const controller=fileURLToPath(new URL('../../../',import.meta.url));assert.equal(git(controller,'rev-parse','HEAD'),process.env.AIHR_CI_CONTROL_HEAD);assert.equal(git(controller,'status','--porcelain'),'');
 const original=execFileSync('git',['show',BASE+':'+FILES[0]],{cwd,encoding:'utf8',maxBuffer:1024**2}),contents=Object.fromEntries(FILES.map(f=>[f,readFileSync(join(cwd,f),'utf8')]));
 const proof=sourceProof(original,contents,readFileSync(join(cwd,'test/attendance-policy-storage-fixture.ts'),'utf8'),createRequire(join(cwd,'package.json'))('typescript'));
 const out=join(realpathSync(process.env.RUNNER_TEMP),'diagnostic-attendance-sql');mkdirSync(out,{mode:0o700});
 const report={kind:'SELECTED_CASE_SQL_DIAGNOSTIC_NOT_TEST_GATE',candidate:sha,controller:process.env.AIHR_CI_CONTROL_HEAD,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
  sourceProof:proof,runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},execution:{workers:2,postgres:postgresProfile},file:PROFILE_FILE,selectedCase:PROFILE_CASE,releaseAuthorized:false,startedAt:new Date().toISOString(),exitCode:1,
  limits:['Exactly one case executes;31 other registered cases are deliberately unselected, never called passing.','Planning/all-nested/I/O instrumentation adds overhead; this is not a comparable performance benchmark.','Top-level and nested execution/JIT times overlap; do not sum cohorts.','Statistics include owned cluster setup/template work, not only the case. Dropped worker database OIDs may no longer resolve.','Representative SQL may be truncated at8192characters; only synthetic test data is used.']};
 const env={...process.env,AIHR_CI_UNIT:UNIT,AIHR_CI_PG_STATEMENTS:'1',AIHR_CI_PG_STATEMENTS_OWNER:'attendance-sql-profile',VITEST_MAX_WORKERS:'2',VITEST_MAX_WORKERS_NODB:'2',TEST_DB_NAMESPACE:'attendance_sql',
  DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'};
 const name=`aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${UNIT}`;
 const control=action=>{const r=spawnSync('bash',[postgres,action],{env,encoding:'utf8',timeout:180000,maxBuffer:1024**2});writeFileSync(join(out,'postgres-'+action+'-'+Date.now()+'.log'),(r.stdout??'')+(r.stderr??''),{flag:'wx',mode:0o600});assert.equal(r.status,0,'Owned database control failed');};
 const query=sql=>execFileSync('docker',['exec','-e','PGCONNECT_TIMEOUT=3','-e','PGOPTIONS=-c statement_timeout=10000',name,'psql','-U','postgres','-p','5433','-d','postgres','-XAt','-v','ON_ERROR_STOP=1','-c',sql],{env,encoding:'utf8',timeout:15000,maxBuffer:4*1024**2}).trim();
 let started=false;
 try{
  control('reset');started=true;query('CREATE EXTENSION pg_stat_statements');
  report.migrationProcess=await measuredCommand('pnpm',['db:migrate'],{cwd,env,log:join(out,'migrate.log'),timeoutMs:300000});assert(!report.migrationProcess.timedOut&&report.migrationProcess.code===0&&report.migrationProcess.signal===null,'Migration process failed');query('SELECT pg_stat_statements_reset()');
  report.testProcess=await measuredCommand('pnpm',['exec','vitest','run',PROFILE_FILE,'--testNamePattern=^'+escapeRegex(PROFILE_CASE)+'$','--reporter=default','--reporter=json','--outputFile.json='+join(out,'vitest.json')],{cwd,env:{...env,AIHR_TEST_PROFILE_DIR:join(out,'harness-profile'),AIHR_TEST_PROFILE_LABEL:'one-case-sql'},log:join(out,'vitest.log'),timeoutMs:300000});
  report.testProcessExitCode=report.testProcess.code;report.testCommandElapsedMs=report.testProcess.elapsedMs;assert(!report.testProcess.timedOut&&report.testProcess.code===0&&report.testProcess.signal===null,'Selected case process failed');
  report.selection=validateSelectedCase(JSON.parse(readFileSync(join(out,'vitest.json'),'utf8')),cwd);
  report.exitCode=0;
 }catch(error){report.error=String(error);throw error;}
 finally{
  if(started){try{const stats=JSON.parse(query(STATISTICS_SQL));writeFileSync(join(out,'statement-statistics.json'),JSON.stringify(stats,null,2)+'\n',{flag:'wx',mode:0o600});report.statistics=validateStatistics(stats,jit);report.databaseEvidence=capturePostgresEvidence(UNIT,postgresProfile);validatePostgresEvidence(report.databaseEvidence,{postgres:postgresProfile});}catch(error){report.statisticsError=String(error);report.exitCode=1;}}
  try{control('stop');report.ownedContainerRemoved=true;}catch(error){report.cleanupError=String(error);report.exitCode=1;}
  report.sourceUnchanged=git(cwd,'rev-parse','HEAD')===sha&&git(cwd,'status','--porcelain')==='';if(!report.sourceUnchanged)report.exitCode=1;
  report.endedAt=new Date().toISOString();writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 assert.equal(report.exitCode,0);return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))profile().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});
