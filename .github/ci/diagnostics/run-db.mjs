/** Diagnostic only: original source/assertions/timeouts, owned PG and crash telemetry. */
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostHealth} from '../host-health.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='linux')throw Error('Disposable Linux CI only');
const fixture=JSON.parse(readFileSync(new URL('./db-original-batch.json',import.meta.url),'utf8'));
const mode=process.argv[2],modes={'original-batch':fixture.files,'isolated-r298':['test/r298-payroll-sections-gate.test.ts'],'isolated-organization':['test/organization-list-detail.test.ts']};
const files=modes[mode];if(!files||files.length>64)throw Error('Invalid diagnostic mode');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git('rev-parse','HEAD');if(sha!==fixture.source||git('status','--porcelain'))throw Error('Diagnostic requires unchanged original source');
const unit=mode==='isolated-organization'?'db-2':'db-3';process.env.AIHR_CI_UNIT=unit;
const name=`aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${unit}`;
const out=join(process.env.RUNNER_TEMP,'diagnostic-db-'+mode);mkdirSync(out,{recursive:true});
const postgres=fileURLToPath(new URL('../postgres.sh',import.meta.url));
const invoke=(cmd,args,opts={})=>spawnSync(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,...opts});
const report={kind:'DIAGNOSTIC_ONLY_NOT_GATE_RECEIPT',mode,sha,files,postgresMemoryBytes:1073741824,workers:2,healthBefore:hostHealth(),started:new Date().toISOString(),vitestExitCode:null};
let logger,fd,sampler;
function snapshot(label){
 const state=invoke('docker',['inspect','--format','{{json .State}}',name]);
 const memory=invoke('docker',['exec',name,'sh','-c','for f in memory.events memory.current memory.peak memory.max; do echo "$f"; cat "/sys/fs/cgroup/$f" 2>/dev/null || true; done']);
 const stats=invoke('docker',['stats','--no-stream','--format','{{json .}}',name]);
 appendFileSync(join(out,'postgres-snapshots.jsonl'),JSON.stringify({label,time:new Date().toISOString(),state:state.stdout,stateExit:state.status,memory:memory.stdout,memoryExit:memory.status,stats:stats.stdout,statsExit:stats.status})+'\n');
}
try{
 if(!report.healthBefore.ok)throw Error('Insufficient runner headroom');
 const reset=invoke('bash',[postgres,'reset'],{stdio:'inherit',timeout:180000});if(reset.status!==0)throw Error('Owned PostgreSQL reset failed');
 fd=openSync(join(out,'postgres-server.log'),'wx',0o600);logger=spawn('docker',['logs','--follow','--timestamps',name],{stdio:['ignore',fd,fd]});
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
