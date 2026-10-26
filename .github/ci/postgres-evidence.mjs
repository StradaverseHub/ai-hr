/** Capture only a job-owned disposable PostgreSQL instance; never a shared database. */
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function validatePostgresEvidence(e,execution){
 const budget=execution?.postgres?.memoryBytes;
 if(!Number.isSafeInteger(budget)||budget<1||e?.schemaVersion!==1||e.memoryLimit!==budget||e.memoryMax!==budget
   ||!Number.isSafeInteger(e.memoryPeak)||e.memoryPeak<1||e.memoryPeak>budget
   ||!Number.isSafeInteger(e.memoryEvents?.oom_kill)||e.memoryEvents.oom_kill!==0
   ||e.state?.Running!==true||e.state?.OOMKilled!==false||e.state?.Dead!==false
   ||e.settings?.jit!==execution.postgres.jit||e.settings?.jitAvailable!==true
   ||!/^16\d{4}$/.test(String(e.settings?.serverVersionNum??'')))throw Error('Missing, unhealthy or mismatched PostgreSQL resource evidence');
 return true;
}
export function capturePostgresEvidence(unit=process.env.AIHR_CI_UNIT){
 const env=process.env;
 if(env.GITHUB_ACTIONS!=='true'||env.CI!=='true'||process.platform!=='linux'
  ||!/^\d+$/.test(env.GITHUB_RUN_ID??'')||!/^\d+$/.test(env.GITHUB_RUN_ATTEMPT??'')
  ||!/^db-(?:[1-4]|[0-9a-f]{16})$/.test(unit??''))throw Error('Owned GitHub database only');
 const name=`aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${unit}`;
 const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim();
 if(docker('inspect','--format','{{index .Config.Labels "aihr-owner"}}',name)!==name)throw Error('Container ownership mismatch');
 const errors={};const safe=(key,fn)=>{try{return fn();}catch(error){errors[key]=String(error);return null;}};
 const state=safe('state',()=>JSON.parse(docker('inspect','--format','{{json .State}}',name)));
 const memoryLimit=safe('memoryLimit',()=>Number(docker('inspect','--format','{{.HostConfig.Memory}}',name)));
 const cgroup=safe('cgroup',()=>docker('exec',name,'sh','-c','cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events').split('\n'))??[];
 const memoryMax=Number(cgroup.shift()),memoryPeak=Number(cgroup.shift());
 const memoryEvents=Object.fromEntries(cgroup.map(line=>{const [key,value]=line.trim().split(/\s+/);return [key,Number(value)];}));
 const settings=safe('settings',()=>JSON.parse(docker('exec','-e','PGCONNECT_TIMEOUT=3','-e','PGOPTIONS=-c statement_timeout=2000',name,'psql','-U','postgres','-p','5433','-d','postgres','-Atc',"SELECT json_build_object('jit',current_setting('jit'),'jitAvailable',pg_jit_available(),'serverVersionNum',current_setting('server_version_num'))")));
 const logs=spawnSync('docker',['logs','--tail','100','--timestamps',name],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 return {schemaVersion:1,name,errors,capturedAt:new Date().toISOString(),memoryLimit,memoryMax,memoryPeak,memoryEvents,state,settings,serverLogTail:(logs.stdout??'')+(logs.stderr??''),logExitCode:logs.status};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(capturePostgresEvidence()));
