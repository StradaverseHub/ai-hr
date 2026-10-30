/** Explicit disposable benchmark entry point; never a normal test skip or release witness. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(process.platform,'linux');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git('rev-parse','HEAD');assert.equal(sha,process.env.AIHR_CI_HEAD);assert.equal(git('status','--porcelain'),'');
const mode=process.env.PERF_SERVICE_PROFILE;assert(['plan-cache','claims-sql','admin-gate','session-plan','scope-lock'].includes(mode));
const out=join(process.env.RUNNER_TEMP,'service-performance-evidence');mkdirSync(out,{recursive:true});
const env={...process.env,TEST_DB_NAMESPACE:'aifocus',AIHR_FOCUSED_EVIDENCE_DIR:out,
 DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test',
 TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'};
assert.equal(env.AIHR_CI_PG_STATEMENTS,'1');
const report={kind:'EXPLICIT_SERVICE_BENCHMARK',releaseEligible:false,sha,mode,run:env.GITHUB_RUN_ID,controller:env.AIHR_CI_CONTROL_HEAD,phases:[],exitCode:1};
const save=()=>writeFileSync(join(out,'benchmark.json'),JSON.stringify(report,null,2));
function run(label,command,args){
 const start=Date.now(),fd=openSync(join(out,label+'.log'),'w');let result;
 try{result=spawnSync(command,args,{env,stdio:['ignore',fd,fd],timeout:600000,killSignal:'SIGKILL'});}finally{closeSync(fd);}
 report.phases.push({label,exitCode:result.status,elapsedMs:Date.now()-start});save();
 assert.equal(result.status,0,label+' failed; retain original benchmark evidence');
}
save();
try{
 run('postgres','bash',['.github/ci/postgres.sh','reset']);
 const file=mode==='plan-cache'?'claims-plan-cache':mode==='admin-gate'?'visibility-admin-gate':mode==='session-plan'?'session-read-plan':mode==='scope-lock'?'workforce-read-lock':'claims-query-profile';
 run('profile','pnpm',['exec','vitest','run','--config','vitest.performance.config.ts','--project','performance',
  'test/performance/'+file+'.profile.ts','--reporter=default','--reporter=json','--outputFile='+join(out,'vitest.json')]);
 report.exitCode=0;
}catch(error){report.error=String(error.message);}
finally{
 const stats=spawnSync('bash',['.github/ci/postgres.sh','stats'],{env,encoding:'utf8'});writeFileSync(join(out,'postgres-resources.txt'),stats.stdout??'');
 try{run('cleanup','bash',['.github/ci/postgres.sh','stop']);}catch{report.exitCode=1;}save();
}
process.exitCode=report.exitCode;
