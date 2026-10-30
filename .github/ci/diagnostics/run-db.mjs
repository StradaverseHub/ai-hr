/** Diagnostic only: original source/assertions/timeouts, owned PG and crash telemetry. */
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostHealth} from '../host-health.mjs';
import {postgresProfileFromEnv} from '../postgres-evidence.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='linux')throw Error('Disposable Linux CI only');
const postgresProfile=postgresProfileFromEnv(process.env);
if(postgresProfile.profileVersion!==1)throw Error('Historical diagnostic requires an explicit legacy resource profile');
const fixture=JSON.parse(readFileSync(new URL('./db-original-batch.json',import.meta.url),'utf8'));
const mode=process.argv[2],modes={'slow-r395':['test/r395-write-path-equivalence.test.ts'],'slow-attendance':['test/attendance-policy-storage.test.ts'],'repaired-focused':['test/organization-list-detail.test.ts','test/company-referrers.test.ts','test/r298-payroll-sections-gate.test.ts'],'original-batch':fixture.files,'isolated-r298':['test/r298-payroll-sections-gate.test.ts'],'isolated-organization':['test/organization-list-detail.test.ts'],'isolated-organization-baseline':['test/organization-list-detail.test.ts']};
const files=modes[mode];if(!files||files.length>64)throw Error('Invalid diagnostic mode');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git('rev-parse','HEAD'),expectedSource=mode.startsWith('slow-')?'ba2142efbc2e181134d30d1e45740a36d55e29e8':mode==='repaired-focused'?process.env.AIHR_CI_HEAD:mode==='isolated-organization-baseline'?'c98bfed60f6330b57f5a67d959ce6e3757df3b53':fixture.source;if(!/^[0-9a-f]{40}$/.test(expectedSource??'')||sha!==expectedSource||git('status','--porcelain'))throw Error('Diagnostic requires unchanged original source');
const unit=mode.includes('organization')?'db-2':'db-3';process.env.AIHR_CI_UNIT=unit;
const name=`aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${unit}`;
const out=join(process.env.RUNNER_TEMP,'diagnostic-db-'+mode);mkdirSync(out,{recursive:true});
const postgres=fileURLToPath(new URL('../postgres.sh',import.meta.url));
const invoke=(cmd,args,opts={})=>spawnSync(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,...opts});
const report={kind:'DIAGNOSTIC_ONLY_NOT_GATE_RECEIPT',mode,sha,sourceRole:mode.startsWith('slow-')?'unchanged-frozen-performance-candidate':mode==='repaired-focused'?'repaired-candidate-development':mode.endsWith('-baseline')?'released-staging-baseline':'original-failed-candidate',migrationJournalEntries:JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')).entries.length,files,postgresProfile,jitRequested:postgresProfile.jit,workers:2,healthBefore:hostHealth(),started:new Date().toISOString(),vitestExitCode:null};
let logger,fd,sampler;
function snapshot(label){
 const state=invoke('docker',['inspect','--format','{{json .State}}',name]);
 const memory=invoke('docker',['exec',name,'sh','-c','for f in memory.events memory.current memory.peak memory.max; do echo "$f"; cat "/sys/fs/cgroup/$f" 2>/dev/null || true; done']);
 const stats=invoke('docker',['stats','--no-stream','--format','{{json .}}',name]);
 const activitySql="SELECT coalesce(json_agg(row_to_json(a)),'[]'::json) FROM (SELECT pid,datname,state,backend_type,wait_event_type,wait_event,extract(epoch FROM clock_timestamp()-query_start) AS query_seconds,pg_blocking_pids(pid) AS blocking_pids,left(query,1200) AS query FROM pg_stat_activity WHERE datname LIKE 'ai_hr_%' AND pid<>pg_backend_pid() ORDER BY pid LIMIT 100) a";
 const activity=invoke('docker',['exec','-e','PGCONNECT_TIMEOUT=3','-e','PGOPTIONS=-c statement_timeout=2000',name,'psql','-U','postgres','-p','5433','-d','postgres','-Atc',activitySql],{timeout:10000});
 appendFileSync(join(out,'postgres-snapshots.jsonl'),JSON.stringify({label,time:new Date().toISOString(),state:state.stdout,stateExit:state.status,memory:memory.stdout,memoryExit:memory.status,stats:stats.stdout,statsExit:stats.status,activity:activity.stdout,activityExit:activity.status,activityError:activity.stderr?.slice(0,3000)})+'\n');
}
try{
 if(!report.healthBefore.ok)throw Error('Insufficient runner headroom');
 const reset=invoke('bash',[postgres,'reset'],{stdio:'inherit',timeout:180000});if(reset.status!==0)throw Error('Owned PostgreSQL reset failed');
 fd=openSync(join(out,'postgres-server.log'),'wx',0o600);logger=spawn('docker',['logs','--follow','--timestamps',name],{stdio:['ignore',fd,fd]});
 const settings=invoke('docker',['exec',name,'psql','-U','postgres','-p','5433','-d','postgres','-Atc',"SELECT json_build_object('version',version(),'jit',current_setting('jit'),'jit_available',pg_jit_available(),'jit_above_cost',current_setting('jit_above_cost'),'jit_inline_above_cost',current_setting('jit_inline_above_cost'),'jit_optimize_above_cost',current_setting('jit_optimize_above_cost'))"]);
 const config=invoke('docker',['exec',name,'pg_config','--configure']);
 writeFileSync(join(out,'postgres-jit-environment.json'),JSON.stringify({settingsExit:settings.status,settings:settings.stdout,settingsError:settings.stderr,configureExit:config.status,configure:config.stdout},null,2)+'\n',{flag:'wx'});
 if(settings.status!==0||config.status!==0)throw Error('Cannot record actual PostgreSQL JIT environment');
 snapshot('before-migrations');
 const migrate=invoke('pnpm',['db:migrate'],{stdio:'inherit',timeout:300000});if(migrate.status!==0)throw Error('Migration failed');
 snapshot('before-vitest');sampler=setInterval(()=>snapshot('during-vitest'),10000);
 const resultFile=join(out,'vitest-result.json');
 const child=spawn('pnpm',['exec','vitest','run',...files,'--reporter=default','--reporter=json','--outputFile.json='+resultFile],{stdio:'inherit',env:{...process.env,VITEST_MAX_WORKERS:'2',VITEST_MAX_WORKERS_NODB:'2'}});
 report.vitestExitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{report.signal=signal;done(code);});});
 if(git('rev-parse','HEAD')!==sha||git('status','--porcelain'))throw Error('Source changed');
}catch(error){report.controllerError=String(error);process.exitCode=1;}
finally{
 if(sampler)clearInterval(sampler);
 try{snapshot('terminal-before-cleanup');}catch(error){report.telemetryError=String(error);}
 // Every logger/container here was created by this job; never a shared Mac/staging database.
 if(logger){logger.kill('SIGTERM');await new Promise(done=>{if(logger.exitCode!==null||logger.signalCode!==null)done();else logger.once('exit',done);});}
 if(fd!==undefined)closeSync(fd);
 const stop=invoke('bash',[postgres,'stop'],{stdio:'inherit',timeout:60000});report.cleanupExitCode=stop.status;
 report.ended=new Date().toISOString();report.healthAfter=hostHealth();
 writeFileSync(join(out,'execution.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify(report));
