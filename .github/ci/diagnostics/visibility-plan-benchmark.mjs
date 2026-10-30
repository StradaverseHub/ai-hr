/** Bounded same-VM SQL-language/PLpgSQL experiment. No release authority. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,rmSync,readdirSync,statfsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {createPlanCopies,validatePlanSelection} from './visibility-plan-copies.mjs';
import {STATISTICS_SQL,validateStatistics} from './attendance-sql-profile.mjs';
import {measuredCommand} from './compiler-incremental.mjs';
import {capturePostgresEvidence,validatePostgresEvidence,postgresProfileFromEnv} from '../postgres-evidence.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:4*1024**2}).trim();
const UNIT='db-3',postgres=fileURLToPath(new URL('../postgres.sh',import.meta.url));
const MATCH="query NOT LIKE '%pg_stat_statements%' AND strpos(query,'admin_company AS')>0 AND strpos(query,'caller_dept AS')>0";
const rows="userid::text,dbid::text,queryid::text,toplevel,calls,plans,total_plan_time,total_exec_time,shared_blks_read,blk_read_time,jit_generation_time,jit_inlining_time,jit_optimization_time,jit_emission_time,left(query,8192) AS query";
export const VISIBILITY_STATISTICS_SQL="SELECT json_build_object('count',(SELECT count(*) FROM pg_stat_statements WHERE "+MATCH+"),'rows',(SELECT coalesce(json_agg(x),'[]'::json) FROM(SELECT "+rows+" FROM pg_stat_statements WHERE "+MATCH+" ORDER BY total_plan_time DESC,dbid,userid,queryid LIMIT100) x))".replace('LIMIT100','LIMIT 100');
export function validateVisibilityRows(value){
 assert(Number.isSafeInteger(value?.count)&&value.count>0&&value.count<=100&&Array.isArray(value.rows)&&value.rows.length===value.count,'Incomplete target-query statistics');
 const unique=new Set();for(const r of value.rows){const id=[r.userid,r.dbid,r.queryid,r.toplevel].join(':');assert(!unique.has(id),'Duplicate query record');unique.add(id);for(const key of ['calls','plans','total_plan_time','total_exec_time','shared_blks_read','blk_read_time','jit_generation_time','jit_inlining_time','jit_optimization_time','jit_emission_time'])assert(Number.isFinite(r[key])&&r[key]>=0);
  for(const key of ['calls','plans','shared_blks_read'])assert(Number.isSafeInteger(r[key]),'Noninteger statement counter');
  assert(/^\d+$/.test(r.userid)&&/^\d+$/.test(r.dbid)&&/^-?\d+$/.test(r.queryid)&&typeof r.toplevel==='boolean'&&typeof r.query==='string'&&Buffer.byteLength(r.query)<=4*8192&&r.query.includes('admin_company AS')&&r.query.includes('caller_dept AS'));}
 return value;
}
export function assertBenchmarkInvocation(e){
 assert(process.platform==='linux'&&process.arch==='x64'&&e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_RUN_ATTEMPT==='1','Owned first-attempt Linux runner required');
 assert(/^[a-f0-9]{40}$/.test(e.AIHR_CI_HEAD??'')&&e.AIHR_CI_HEAD===e.AIHR_CI_CONTROL_HEAD&&e.AIHR_CI_CONTROL_HEAD===e.GITHUB_SHA,'Identical frozen controller and candidate required');
 assert(/^StradaverseHub\/ai-hr\/\.github\/workflows\/alpha-staging-db-diagnostics\.yml@refs\/heads\/codex\/test-suite-efficiency-review-20261025$/.test(e.GITHUB_WORKFLOW_REF??''),'Unexpected workflow origin');
 assert(e.AIHR_CI_PG_MEMORY_GIB==='2'&&e.AIHR_CI_PG_JIT==='on'&&['both','prototype'].includes(e.AIHR_PLAN_BENCHMARK_PHASES??'both'),'Controlled runtime settings required');
}
export async function benchmark(){
 assertBenchmarkInvocation(process.env);
 const postgresProfile=postgresProfileFromEnv(process.env);assert.equal(postgresProfile.profileVersion,1);assert.equal(postgresProfile.profileId,'legacy-2g');
 const cwd=realpathSync(process.cwd()),controller=realpathSync(fileURLToPath(new URL('../../../',import.meta.url))),sha=process.env.AIHR_CI_HEAD;
 const clean=()=>{for(const p of [cwd,controller]){assert.equal(git(p,'rev-parse','HEAD'),sha);assert.equal(git(p,'status','--porcelain'),'');}};
 clean();for(const file of ['visibility-plan-prototype.mjs','visibility-plan-controls.mjs'])assert(readFileSync(join(cwd,'.github/ci/diagnostics',file)).equals(readFileSync(join(controller,'.github/ci/diagnostics',file))),'Installed experiment helper differs');
 const out=join(realpathSync(process.env.RUNNER_TEMP),'diagnostic-visibility-plan');mkdirSync(out,{mode:0o700});
 const proof=createPlanCopies(cwd,createRequire(join(cwd,'package.json'))('typescript'));writeFileSync(join(out,'copy-source-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
 const phases=(process.env.AIHR_PLAN_BENCHMARK_PHASES??'both')==='both'?['baseline','prototype']:['prototype'];
 const report={kind:phases.length===2?'PAIRED_VISIBILITY_PLAN_DIAGNOSTIC_NOT_RELEASE_EVIDENCE':'SINGLE_VISIBILITY_PROTOTYPE_NOT_PAIRED_PERFORMANCE',candidate:sha,controller:sha,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
  runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},execution:{workers:1,postgres:postgresProfile},order:phases,phases:[],releaseAuthorized:false,startedAt:new Date().toISOString(),exitCode:1,
  limits:['Only37 selected cases execute;88 registered cases are deliberately unselected. This is not full release coverage.','Baseline precedes prototype on one VM; OS/dependency warming may affect elapsed comparison.','Statement planning instrumentation adds overhead; nested/outer durations overlap.','Target query rows include deliberate reverted mutation definitions; inspect bound function/catalog proofs.','This changes only owned worker database functions; no applied migration or staging setting changes.']};
 const base={...process.env,AIHR_CI_UNIT:UNIT,AIHR_CI_PG_STATEMENTS:'1',AIHR_CI_PG_STATEMENTS_OWNER:'visibility-plan-benchmark',VITEST_MAX_WORKERS:'1',VITEST_MAX_WORKERS_NODB:'1',
  DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'};
 const name='aihr-ci-'+base.GITHUB_RUN_ID+'-'+base.GITHUB_RUN_ATTEMPT+'-'+UNIT;
 let directory=out;
 const control=action=>{const r=spawnSync('bash',[postgres,action],{env:base,encoding:'utf8',timeout:180000,maxBuffer:2*1024**2});writeFileSync(join(directory,'postgres-'+action+'-'+Date.now()+'.log'),(r.stdout??'')+(r.stderr??''),{flag:'wx',mode:0o600});assert.equal(r.status,0,'Owned database '+action+' failed');};
 const query=sql=>execFileSync('docker',['exec','-e','PGCONNECT_TIMEOUT=3','-e','PGOPTIONS=-c statement_timeout=15000',name,'psql','-U','postgres','-p','5433','-d','postgres','-XAt','-v','ON_ERROR_STOP=1','-c',sql],{env:base,encoding:'utf8',timeout:20000,maxBuffer:4*1024**2}).trim();
 try{
  for(const mode of phases){
   clean();directory=join(out,mode);mkdirSync(directory,{mode:0o700});const hooks=join(directory,'function-proofs');mkdirSync(hooks,{mode:0o700});
   const row={mode,startedAt:new Date().toISOString(),exitCode:1};report.phases.push(row);let started=false;
   row.sourceVolumeSamples=[];const sampleDisk=()=>{try{const f=statfsSync(cwd),availableBytes=f.bavail*f.bsize;assert(Number.isSafeInteger(availableBytes)&&availableBytes>=0);row.sourceVolumeSamples.push({at:new Date().toISOString(),availableBytes});row.minimumSampledSourceAvailableBytes=Math.min(row.minimumSampledSourceAvailableBytes??availableBytes,availableBytes);}catch(error){row.diskSamplingError=String(error);}};sampleDisk();const diskTimer=setInterval(sampleDisk,5000);
   const env={...base,TEST_DB_NAMESPACE:mode==='baseline'?'plan_base':'plan_proto',AIHR_PLAN_REUSE_MODE:mode,AIHR_PLAN_PROOF_DIR:hooks,AIHR_TEST_PROFILE_DIR:join(directory,'harness-profile'),AIHR_TEST_PROFILE_LABEL:mode};
   try{
    assert(!row.diskSamplingError&&row.minimumSampledSourceAvailableBytes>=4*1024**3,'Need4GiB measured headroom before this bounded private database');
    control('reset');started=true;query('CREATE EXTENSION pg_stat_statements');
    row.migration=await measuredCommand('pnpm',['db:migrate'],{cwd,env,log:join(directory,'migrate.log'),timeoutMs:300000});assert(row.migration.code===0&&!row.migration.timedOut&&row.migration.signal===null,'Development migration failed');
    query('SELECT pg_stat_statements_reset()');
    row.test=await measuredCommand('pnpm',['exec','vitest','run','--config',proof.configPath,...proof.files,'--testNamePattern='+proof.pattern,'--reporter=default','--reporter=json','--outputFile.json='+join(directory,'vitest.json')],{cwd,env,log:join(directory,'vitest.log'),timeoutMs:360000});
    assert(row.test.code===0&&!row.test.timedOut&&row.test.signal===null,'Selected prototype/security process failed');
    row.selection=validatePlanSelection(JSON.parse(readFileSync(join(directory,'vitest.json'),'utf8')),cwd,proof);
    const hookNames=readdirSync(hooks);assert.equal(hookNames.length,4,'All three install proofs and actual reserved-connection proof required');
    const installs=hookNames.filter(n=>n!=='reused-connection.json').map(n=>JSON.parse(readFileSync(join(hooks,n),'utf8')));
    assert.deepEqual(installs.map(p=>p.label).sort(),['cash','principal','visibility']);
    for(const p of installs)assert(p.source===sha&&p.mode===mode&&p.immutablePropertiesPreserved===true&&p.releaseAuthorized===false&&p.after.language===(mode==='prototype'?'plpgsql':'sql')&&isDeepStrictEqual(p.before.immutable,p.after.immutable));
    row.functionProofs=installs.map(p=>({database:p.database,dbid:p.after.dbid,label:p.label,beforeLanguage:p.before.language,afterLanguage:p.after.language,sha256:hash(JSON.stringify(p))}));
    const reused=JSON.parse(readFileSync(join(hooks,'reused-connection.json'),'utf8'));assert(reused.source===sha&&reused.mode===mode&&reused.reusedConnection===true&&reused.outerTransactionRolledBack===true&&reused.contextQueries>=72&&reused.roleRevocationAndRollbackVerified&&reused.loginArchivalAndRollbackVerified&&reused.actualGraphMutationAndRollbackVerified&&reused.releaseAuthorized===false);row.reusedConnection=reused;
    row.exitCode=0;
   }finally{
    clearInterval(diskTimer);sampleDisk();
    if(started){
     try{const raw=query(STATISTICS_SQL);writeFileSync(join(directory,'statement-statistics.json'),raw+'\n',{flag:'wx',mode:0o600});row.statistics=validateStatistics(JSON.parse(raw),'on');}catch(error){row.statisticsError=String(error);row.exitCode=1;}
     try{const raw=query(VISIBILITY_STATISTICS_SQL);writeFileSync(join(directory,'visibility-statistics.json'),raw+'\n',{flag:'wx',mode:0o600});validateVisibilityRows(JSON.parse(raw));}catch(error){row.targetStatisticsError=String(error);row.exitCode=1;}
     try{row.databaseEvidence=capturePostgresEvidence(UNIT,postgresProfile);validatePostgresEvidence(row.databaseEvidence,report.execution);}catch(error){row.databaseEvidenceError=String(error);row.exitCode=1;}
    }
    if(row.diskSamplingError)row.exitCode=1;
    try{control('stop');row.ownedContainerRemoved=true;}catch(error){row.cleanupError=String(error);row.exitCode=1;}
    row.endedAt=new Date().toISOString();writeFileSync(join(directory,'phase.json'),JSON.stringify(row,null,2)+'\n',{flag:'wx',mode:0o600});
   }
   assert.equal(row.exitCode,0);clean();
  }
  if(report.phases.length===2)assert.equal(report.phases[0].databaseEvidence.settings.serverVersionNum,report.phases[1].databaseEvidence.settings.serverVersionNum);
  report.exitCode=0;
 }catch(error){report.error=String(error);throw error;}
 finally{
  try{control('stop');report.ownedContainerRemoved=true;}catch(error){report.cleanupError=String(error);report.exitCode=1;}
  const copies=join(cwd,'.vitest-attachments');assert.equal(realpathSync(copies),copies);rmSync(copies,{recursive:true});report.ownedCopiesRemoved=true;
  try{clean();report.sourceUnchanged=true;}catch(error){report.sourceUnchanged=false;report.sourceError=String(error);report.exitCode=1;}
  report.endedAt=new Date().toISOString();writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 assert.equal(report.exitCode,0);return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))benchmark().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});
