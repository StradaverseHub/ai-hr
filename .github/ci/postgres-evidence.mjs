/** Capture only a job-owned disposable PostgreSQL instance; never a shared database. */
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const V15_POSTGRES_PROFILE=Object.freeze({profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,jit:'on'});
const GIB=1073741824;
export function validatePostgresProfile(profile){
 const keys=profile&&Object.keys(profile).sort().join(',');
 const ordinary=profile?.profileVersion===2&&keys==='configuredCapBytes,jit,peakBudgetBytes,profileVersion'
  &&profile.configuredCapBytes===2113929216&&profile.peakBudgetBytes===2147483648&&profile.jit==='on';
 const legacy=profile?.profileVersion===1&&keys==='configuredCapBytes,jit,peakBudgetBytes,profileId,profileVersion'
  &&['legacy-1g','legacy-2g'].includes(profile.profileId)&&['on','off'].includes(profile.jit)
  &&profile.configuredCapBytes===(profile.profileId==='legacy-1g'?GIB:2*GIB)&&profile.peakBudgetBytes===profile.configuredCapBytes;
 if(!ordinary&&!legacy)throw Error('Unknown or mixed PostgreSQL resource profile');
 return profile;
}
export function postgresProfileFromEnv(env){
 const present=key=>Object.hasOwn(env,key);
 if(env.AIHR_CI_PG_PROFILE==='2'){
  if(present('AIHR_CI_PG_MEMORY_GIB')||env.AIHR_CI_PG_CONFIGURED_CAP_BYTES!=='2113929216'
   ||env.AIHR_CI_PG_PEAK_BUDGET_BYTES!=='2147483648'||env.AIHR_CI_PG_JIT!=='on')throw Error('Invalid v15 PostgreSQL environment');
  return {...V15_POSTGRES_PROFILE};
 }
 if(!['legacy-1g','legacy-2g'].includes(env.AIHR_CI_PG_PROFILE)||present('AIHR_CI_PG_CONFIGURED_CAP_BYTES')
  ||present('AIHR_CI_PG_PEAK_BUDGET_BYTES')||env.AIHR_CI_PG_MEMORY_GIB!==(env.AIHR_CI_PG_PROFILE==='legacy-1g'?'1':'2')
  ||!['on','off'].includes(env.AIHR_CI_PG_JIT))throw Error('Missing, ambiguous or invalid PostgreSQL environment profile');
 const configuredCapBytes=Number(env.AIHR_CI_PG_MEMORY_GIB)*GIB;
 return validatePostgresProfile({profileVersion:1,profileId:env.AIHR_CI_PG_PROFILE,configuredCapBytes,peakBudgetBytes:configuredCapBytes,jit:env.AIHR_CI_PG_JIT});
}
export function validatePostgresEvidence(e,execution){
 const profile=validatePostgresProfile(execution?.postgres),{configuredCapBytes,peakBudgetBytes}=profile;
 if(e?.schemaVersion!==(profile.profileVersion===2?2:1)||e.profileVersion!==profile.profileVersion
   ||e.profileId!==profile.profileId||e.configuredCapBytes!==configuredCapBytes||e.peakBudgetBytes!==peakBudgetBytes
   ||Object.hasOwn(e,'memoryBytes')||e.memoryLimit!==configuredCapBytes||e.memorySwap!==configuredCapBytes
   ||e.memoryMax!==configuredCapBytes||e.memorySwapMax!==0
   ||!Number.isSafeInteger(e.memoryPeak)||e.memoryPeak<1||e.memoryPeak>peakBudgetBytes
   ||!e.memoryEvents||e.memoryEvents.oom!==0||e.memoryEvents.oom_kill!==0
   ||Object.values(e.memoryEvents).some(value=>!Number.isSafeInteger(value)||value<0)
   ||!e.errors||Object.keys(e.errors).length!==0
   ||e.state?.Running!==true||e.state?.OOMKilled!==false||e.state?.Dead!==false
   ||e.settings?.jit!==profile.jit||e.settings?.jitAvailable!==true
   ||!/^16\d{4}$/.test(String(e.settings?.serverVersionNum??'')))throw Error('Missing, unhealthy or mismatched PostgreSQL resource evidence');
 return true;
}
export function capturePostgresEvidence(unit=process.env.AIHR_CI_UNIT,profile){
 const env=process.env;
 validatePostgresProfile(profile);
 const actualProfile=postgresProfileFromEnv(env);
 if(Object.keys(profile).some(key=>actualProfile[key]!==profile[key]))throw Error('PostgreSQL execution/environment profile mismatch');
 if(env.GITHUB_ACTIONS!=='true'||env.CI!=='true'||process.platform!=='linux'
  ||!/^\d+$/.test(env.GITHUB_RUN_ID??'')||!/^\d+$/.test(env.GITHUB_RUN_ATTEMPT??'')
  ||!/^db-(?:[1-4]|[0-9a-f]{16})$/.test(unit??''))throw Error('Owned GitHub database only');
 const name=`aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${unit}`;
 const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim();
 if(docker('inspect','--format','{{index .Config.Labels "aihr-owner"}}',name)!==name)throw Error('Container ownership mismatch');
 const errors={};const safe=(key,fn)=>{try{return fn();}catch(error){errors[key]=String(error);return null;}};
 const state=safe('state',()=>JSON.parse(docker('inspect','--format','{{json .State}}',name)));
 const memoryLimit=safe('memoryLimit',()=>Number(docker('inspect','--format','{{.HostConfig.Memory}}',name)));
 const memorySwap=safe('memorySwap',()=>Number(docker('inspect','--format','{{.HostConfig.MemorySwap}}',name)));
 const cgroup=safe('cgroup',()=>docker('exec',name,'sh','-c','cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/memory.swap.max; cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events').split('\n'))??[];
 const memoryMax=Number(cgroup.shift()),memorySwapMax=Number(cgroup.shift()),memoryPeak=Number(cgroup.shift());
 const memoryEvents=Object.fromEntries(cgroup.map(line=>{const [key,value]=line.trim().split(/\s+/);return [key,Number(value)];}));
 const settings=safe('settings',()=>JSON.parse(docker('exec','-e','PGCONNECT_TIMEOUT=3','-e','PGOPTIONS=-c statement_timeout=2000',name,'psql','-U','postgres','-p','5433','-d','postgres','-Atc',"SELECT json_build_object('jit',current_setting('jit'),'jitAvailable',pg_jit_available(),'serverVersionNum',current_setting('server_version_num'))")));
 const logs=spawnSync('docker',['logs','--tail','100','--timestamps',name],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 const {jit,...identity}=profile;
 return {schemaVersion:profile.profileVersion===2?2:1,...identity,name,errors,capturedAt:new Date().toISOString(),memoryLimit,memorySwap,memoryMax,memorySwapMax,memoryPeak,memoryEvents,state,settings,serverLogTail:(logs.stdout??'')+(logs.stderr??''),logExitCode:logs.status};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(capturePostgresEvidence(process.env.AIHR_CI_UNIT,postgresProfileFromEnv(process.env))));
