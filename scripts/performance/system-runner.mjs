/** Development-only production renderer and durable job-owned PostgreSQL. No target credentials. */
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync,readdirSync,openSync,closeSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import {setTimeout as pause} from 'node:timers/promises';
import {developmentPostgresLockWindow,postgresLockFailures} from './lock-failure-log.mjs';
import {admissionFailureMarkers} from './admission-failure-log.mjs';
import {runtimeAcceptance} from './runtime-acceptance.mjs';
import {createDriverFailures,createDriverSockets,validateDevelopmentMeasurement,DEVELOPMENT_DOCKER_COMMAND,
 developmentDockerContext,developmentPostgresBirthId,developmentPostgresSettlement} from './driver-shutdown.mjs';
import {systemBuildEnvironment} from './build-environment.mjs';
import {isolatedWorkerBudget,isolatedWorkerCpuAdmission} from './worker-budget.mjs';
import {fullDevelopmentBrowserRouteCourse} from './development-browser-route-course.mjs';
import {createWorkerComparisonModel} from './worker-comparison.mjs';
import {holdDevelopmentBuildSnapshot} from './worker-comparison-build.mjs';
import {comparisonClock,holdWorkerComparisonFiles,openWorkerComparisonFamily,readComparisonJson} from './worker-comparison-custody.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git('rev-parse','HEAD');assert.equal(sha,process.env.AIHR_CI_HEAD);assert.equal(git('status','--porcelain'),'');
const checksum=value=>createHash('sha256').update(value).digest('hex');
const comparisonPorts=[5433,3443,...Array.from({length:8},(_,index)=>3174+index)];
async function assertPortFree(port){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}

function processBirth(pid){
 assert(Number.isSafeInteger(pid)&&pid>1,'Development PostgreSQL process identity refused');
 let stat;
 try{stat=readFileSync('/proc/'+pid+'/stat','utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const end=stat.lastIndexOf(') '),birth=stat.slice(end+2).trimEnd().split(' ')[19];
 assert(stat.startsWith(pid+' (')&&end>0&&/^[1-9][0-9]*(?![\s\S])/.test(birth),'Development PostgreSQL process birth refused');
 return birth;
}

async function runSystemCell(comparison=null){
const base=comparison?.env??process.env;
const out=comparison?.paths.out??join(base.RUNNER_TEMP,'system-performance-evidence');
const privateDir=comparison?.paths.privateDir??join(base.RUNNER_TEMP,'system-performance-private');
const focusedEvidence=comparison?.paths.focusedEvidence??join(base.RUNNER_TEMP,'aihr-focused');
if(!comparison)for(const directory of [out,privateDir,focusedEvidence])mkdirSync(directory,{recursive:true,mode:0o700});
const authKey=randomBytes(32).toString('hex');
const env={...base,AIHR_PERFORMANCE_ROLE_FIXTURE:'true',AIHR_FOCUSED_SUITE_CAPACITY:'true',TEST_DB_NAMESPACE:'aifocus',AUTH_PROVIDER:'internal',AUTH_SESSION_KEY:authKey,AUTH_PUBLIC_ORIGIN:'https://localhost:3443',
 AUTH_DEFAULT_ORGANIZATION:'perf-a',ALLOW_DEMO_SESSION:'false',AUDIT_HASH_CHAIN_ENABLED:'true',
 AI_CONFIG_SECRET:randomBytes(32).toString('hex'),PERF_PRIVATE_DIR:privateDir,PERF_EVIDENCE_DIR:out,AIHR_FOCUSED_EVIDENCE_DIR:focusedEvidence,
 DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',
 TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'};
for(const key of Object.keys(env))if(key.startsWith('WORKOS_')||key==='SHARE_PASSWORD'||key==='DEV_USER_ID')delete env[key];
env.SHARE_PASSWORD='';env.DEV_USER_ID='';
const {workers,totalApplicationPool,poolPerWorker,heapPerWorker,totalHeapMiB}=isolatedWorkerBudget(
 env.PERF_APP_WORKERS,env.PERF_APP_POOL_CONNECTIONS,env.PERF_APP_TOTAL_HEAP_MIB);
const host={cpus:os.availableParallelism(),memoryBytes:os.totalmem()};
const cpuAdmission=isolatedWorkerCpuAdmission({workers,availableCpus:host.cpus,
 oversubscriptionDiagnostic:env.PERF_ALLOW_CPU_OVERSUBSCRIPTION_DIAGNOSTIC==='true',suite:env.PERF_HTTP_SUITE});
if(totalHeapMiB===8192){
 assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted','larger diagnostic heap requires a hosted runner');
 assert(host.cpus===4&&host.memoryBytes>=15*1024**3&&host.memoryBytes<=17*1024**3,'larger diagnostic heap requires the standard hosted 4-CPU / 16-GB runner');
}
const ports=Array.from({length:workers},(_,index)=>3174+index);
const report={kind:'ISOLATED_HTTP_BROWSER_DEVELOPMENT_ONLY',releaseEligible:false,sha,controller:env.AIHR_CI_CONTROL_HEAD,
 run:env.GITHUB_RUN_ID,runtime:{node:process.version,productionObservedNode:'v24.22.1'},productionEquivalent:false,topology:{workers,poolPerWorker,totalApplicationPool,heapMiBPerWorker:heapPerWorker,totalHeapMiB,upstreamKeepAlive:false,proxyUpstreamMaxSockets:4000},proxyErrors:[],host,cpuAdmission,phases:[],exitCode:1};
const measureDevelopment=['workflow-preflight','whole-system'].includes(env.PERF_HTTP_SUITE);
const lockLogNonce=measureDevelopment?randomBytes(16).toString('hex'):null;
const requireRenderedUnion=fullDevelopmentBrowserRouteCourse(env);
const measurementIdentity={candidateSha:sha,controllerSha:report.controller,runId:Number(report.run),
 requireRenderedUnion,
 runAttempt:Number(env.GITHUB_RUN_ATTEMPT),suite:env.PERF_HTTP_SUITE};
const measurement=measureDevelopment?report.developmentMeasurement={kind:'DEVELOPMENT_BROWSER_RUNNER_MEASUREMENT_V1',complete:false,
 driver:null,driverReceipt:'absent',settlement:{driver:'unknown',proxy:'unknown',workers:'unknown',
  ...developmentPostgresSettlement('unknown','unknown',null)}}:null;
const developmentReset={admitted:false,state:'unknown',id:null};
let developmentRemoveApi='unknown';
const proxyFailures=measurement?createDriverFailures():null;
const proxySockets=proxyFailures?createDriverSockets(proxyFailures):null;
const save=()=>writeFileSync(join(out,'runner.json'),JSON.stringify(report,null,2));
save();
const directChildren=new Set(),childBirths=new WeakMap();
let cleaning=false,build=null,fixture=null,postgresProfile=null;
function timeBudget(maximum,reserve=0,full=false){
 if(!comparison)return maximum;
 const deadline=cleaning?comparison.frontiers.settlementEndMs:comparison.frontiers.activeEndMs;
 const available=deadline-comparisonClock()-reserve;
 assert(available>0&&(!full||available>=maximum),'Worker comparison phase does not fit its absolute frontier');
 return Math.min(maximum,available);
}
function trackChild(child){
 if(comparison){
  directChildren.add(child);
  child.once('close',()=>directChildren.delete(child));
  if(child.pid)childBirths.set(child,processBirth(child.pid));
 }
 return child;
}
function signalChild(child,signal){
 if(!comparison)return child.kill(signal);
 try{
  const birth=childBirths.get(child);
  if(!birth||!directChildren.has(child)||child.exitCode!==null||child.signalCode!==null||processBirth(child.pid)!==birth)return false;
  return child.kill(signal);
 }catch{return false;}
}
async function run(label,command,args,childEnv=env,timeout=900000){
 timeout=timeBudget(timeout,10000,label==='http-and-browser');
 console.log('[system-perf] '+label+' started');const start=Date.now();
 const fd=openSync(join(privateDir,label+'.log'),'w',0o600);
 const phaseDeadline=comparison?comparisonClock()+timeout:null;
 const measuring=measurement!==null&&label==='http-and-browser';
 const capturingBirth=measurement!==null&&label==='postgres';
 const child=trackChild(spawn(command,args,{env:childEnv,stdio:measuring?['ignore',fd,fd,'ipc']:
  capturingBirth?['ignore',fd,fd,'pipe']:['ignore',fd,fd]}));
 let birth=Buffer.alloc(0),birthRefused=false;
 if(capturingBirth&&child.stdio[3]){
  child.stdio[3].on('data',chunk=>{
   if(birth.length+chunk.length>65){birthRefused=true;return;}
   birth=Buffer.concat([birth,chunk]);
  });
  child.stdio[3].on('error',()=>{birthRefused=true;});
 }
 if(measuring)child.on('message',value=>{
  if(measurement.driverReceipt!=='absent'||!validateDevelopmentMeasurement(value,measurementIdentity)
   ||Buffer.byteLength(JSON.stringify(value))>8192){
   measurement.driverReceipt='refused';measurement.driver=null;return;
  }
  measurement.driverReceipt='observed';measurement.driver=value;
 });
 let killTimer,closeTimer,timedOut=false,exitSignal,refuseUnsettled;
 const timer=setTimeout(()=>{
  timedOut=true;signalChild(child,'SIGTERM');
  killTimer=setTimeout(()=>{
   signalChild(child,'SIGKILL');
   if(capturingBirth)child.stdio[3]?.destroy();
   if(comparison)closeTimer=setTimeout(()=>refuseUnsettled(Error('Worker comparison direct child close unobserved')),1000);
  },10000);
 },timeout);
 let code;
 try{code=await new Promise((resolve,reject)=>{
  refuseUnsettled=reject;
  child.once('error',reject);
  child.once(comparison||measuring||capturingBirth?'close':'exit',(value,signal)=>{exitSignal=signal;resolve(value);});
 });}catch(error){
  if(!comparison||!timedOut)throw error;
  code=null;
 }finally{clearTimeout(timer);clearTimeout(killTimer);clearTimeout(closeTimer);closeSync(fd);}
 if(phaseDeadline!==null&&comparisonClock()>=phaseDeadline)timedOut=true;
 if(capturingBirth){
  developmentReset.id=birthRefused?null:developmentPostgresBirthId(birth);
  developmentReset.state=timedOut||code===null||exitSignal!==null?'unknown':code===0&&developmentReset.id?'settled':'failed';
  measurement.settlement.postgresReset=developmentReset.state;
 }
 if(measurement&&label==='cleanup')
  developmentRemoveApi=timedOut||code===null||exitSignal!==null?'unknown':code===0?'settled':'failed';
 if(measuring)measurement.settlement.driver=!timedOut&&code===0&&exitSignal===null?'settled':'failed';
 report.phases.push({label,elapsedMs:Date.now()-start,exitCode:code,timeoutMs:timeout,timedOut,exitSignal});save();
 console.log('[system-perf] '+JSON.stringify(report.phases.at(-1)));
 if(code!==0&&!comparison){const text=readFileSync(join(privateDir,label+'.log'),'utf8').slice(-12000).replace(/[A-Za-z0-9_-]{32,}/g,'<REDACTED>');writeFileSync(join(out,label+'-failure.txt'),text);}
 assert.equal(timedOut,false,label+' exceeded its unchanged process budget; retain incomplete evidence');
 assert.equal(code,0,label+' failed; private process logs contain no published credentials');
 if(capturingBirth)assert(developmentReset.state==='settled','Development PostgreSQL reset birth receipt refused');
 if(measuring)assert(measurement.driver?.complete===true,'Development driver terminal measurement refused');
 timeBudget(1);
}
function summarizeCpu(){
 const frames=new Map(),root=resolve('.next/server/chunks/ssr')+'/';
 const profiles=[];
 for(const name of readdirSync(join(out,'cpu')).filter(name=>name.endsWith('.cpuprofile'))){
  const profile=JSON.parse(readFileSync(join(out,'cpu',name),'utf8')),nodes=new Map(profile.nodes.map(node=>[node.id,node.callFrame]));
  profiles.push({file:name,samples:(profile.samples??[]).length,durationMs:(profile.endTime-profile.startTime)/1000});
  for(let i=0;i<(profile.samples??[]).length;i++){
   const frame=nodes.get(profile.samples[i]);if(!frame?.url?.startsWith('file://'))continue;
   const file=new URL(frame.url).pathname;if(!file.startsWith(root))continue;
   const key=file+':'+frame.lineNumber+':'+frame.columnNumber;
   let value=frames.get(key);if(!value){value={function:frame.functionName,file,line:frame.lineNumber,column:frame.columnNumber,sampledSelfMs:0};frames.set(key,value);}
   value.sampledSelfMs+=(profile.timeDeltas[i]??0)/1000;
  }
 }
 const secrets=Object.entries(env).filter(([key,value])=>/TOKEN|PASSWORD|SECRET|KEY/i.test(key)&&typeof value==='string'&&value.length>=8).map(([,value])=>value);
 const rows=[...frames.values()].sort((a,b)=>b.sampledSelfMs-a.sampledSelfMs).slice(0,12).map(frame=>{
  const line=readFileSync(frame.file,'utf8').split('\n')[frame.line]??'';
  let excerpt=line.slice(Math.max(0,frame.column-200),frame.column+1400);for(const secret of secrets)excerpt=excerpt.replaceAll(secret,'<REDACTED>');
  return {...frame,file:frame.file.slice(resolve('.').length+1),excerpt};
 });
 writeFileSync(join(out,'cpu-hot-frames.json'),JSON.stringify(rows,null,2));
 report.cpuProfiles={files:profiles.length,samples:profiles.reduce((sum,profile)=>sum+profile.samples,0),ssrHotFrames:rows.length,profiles};
 if(!profiles.length)report.cpuProfileUnavailable=true;
}
function summarizeNativeFailures(){
 // The raw logs remain private. Publish only generated references, SQLSTATEs and fixed diagnostic flags.
 const failures=[],workers=[];
 for(const name of readdirSync(privateDir).filter(name=>/^server-[0-9]+\.log$/.test(name))){
  const text=readFileSync(join(privateDir,name),'utf8');
  const worker=Number(name.match(/[0-9]+/)[0]);
  workers.push({worker,v8HeapOutOfMemory:/FATAL ERROR:[^\n]*JavaScript heap out of memory/.test(text),
   logMarkers:admissionFailureMarkers(text)});
  // The public-error owner logs one explicit SQLSTATE beside each generated reference.
  // Publish that closed metadata only; never the surrounding SQL, values or stack.
  for(const match of text.matchAll(/\[database error (DB-[A-Z]-[A-F0-9]{6})\] sqlstate=([0-9A-Z]{5}|none)/g)){
   if(failures.length>=100)break;
   failures.push({worker:Number(name.match(/[0-9]+/)[0]),source:'public-error',reference:match[1],sqlStates:match[2]==='none'?[]:[match[2]]});
  }
  const markers=[...text.matchAll(/\[Draft (activate|delete) failure (DRAFT-[A-F0-9]{8})\]/g)];
  for(let i=0;i<markers.length&&failures.length<100;i++){
   const marker=markers[i],block=text.slice(marker.index,Math.min(markers[i+1]?.index??text.length,marker.index+32000));
   failures.push({worker:Number(name.match(/[0-9]+/)[0]),operation:marker[1],reference:marker[2],
    sqlStates:[...new Set([...block.matchAll(/\bcode:\s*['"]([0-9A-Z]{5})['"]/g)].map(match=>match[1]))],
    lockTimeoutMessage:/canceling statement due to lock timeout/.test(block),
    statementTimeoutMessage:/canceling statement due to statement timeout/.test(block),
    deadlockMessage:/deadlock detected/.test(block),permissionDeniedMessage:/permission denied/.test(block)});
  }
 }
 report.workerFatalDiagnostics=workers.sort((a,b)=>a.worker-b.worker);
 report.nativeRuntimeFailures=failures;
 writeFileSync(join(out,'server-native-failures.json'),JSON.stringify({scope:'Exact public-error reference/SQLSTATE metadata plus bounded native Draft marker blocks; Draft block errors may overlap; raw logs and SQL excluded',failures},null,2));
}
const apps=[],appFds=[],workerProcessErrors=new Set(),appBirths=new Map();let proxy,upstream,dbStarted=false,postgresRuntimeFailures;
let developmentPostgresBirth;
const container=`aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-db-1`;
// Keep the canonical reset recipe. Its Docker commands cannot remove anything
// and, after creation, cannot resolve the database through a reusable name.
const developmentResetCommand=String.raw`set -euo pipefail
owned_id=''
fixed_docker() { /usr/bin/docker --config "$DOCKER_CONFIG" --host "$DOCKER_HOST" "$@" 3>&-; }
docker() {
 case "$1" in
  container)
   [[ "$#" == 3 && "$2" == inspect && "$3" == "$AIHR_DEVELOPMENT_DB_NAME" ]] || return 2
   fixed_docker "$@"
   ;;
  inspect)
   [[ "$#" == 4 && "$2" == --format && "$4" == "$AIHR_DEVELOPMENT_DB_NAME" ]] || return 2
   fixed_docker "$@"
   ;;
  run)
   [[ -z "$owned_id" && "$2" == -d && "$3" == --name && "$4" == "$AIHR_DEVELOPMENT_DB_NAME" &&
     "$5" == --label && "$6" == "aihr-owner=$AIHR_DEVELOPMENT_DB_NAME" ]] || return 2
   owned_id="$(exec 3>&-; fixed_docker "$@")" || return "$?"
   [[ "$owned_id" =~ ^[a-f0-9]{64}$ ]] || return 2
   printf '%s\n' "$owned_id" >&3
   printf '%s\n' "$owned_id"
   ;;
  exec|logs)
   local operation="$1"
   shift
   [[ -n "$owned_id" && "$1" == "$AIHR_DEVELOPMENT_DB_NAME" ]] || return 2
   shift
   fixed_docker "$operation" "$owned_id" "$@"
   ;;
  *) return 2 ;;
 esac
}
source .github/ci/postgres.sh reset
`;
const developmentDocker=()=>developmentDockerContext(privateDir);
function dockerQuery(args,maximum=4096,timeout=10000){
 const context=developmentDocker();
 return execFileSync(DEVELOPMENT_DOCKER_COMMAND,[...context.args,...args],
  {env:context.env,encoding:'utf8',timeout:timeBudget(timeout),killSignal:'SIGKILL',maxBuffer:maximum}).trim();
}
function dockerContainerIds(filter){
 const raw=dockerQuery(['container','ls','--all','--quiet','--no-trunc','--filter',filter]);
 const ids=raw?raw.split('\n'):[];
 assert(ids.length<=1&&ids.every(id=>/^[a-f0-9]{64}(?![\s\S])/.test(id)),'Development PostgreSQL container inventory refused');
 return ids;
}
const namedContainer=()=>dockerContainerIds(`name=^/${container}$`);
function observeDevelopmentPostgres(id){
 assert(/^[a-f0-9]{64}(?![\s\S])/.test(id),'Development PostgreSQL creation identity refused');
 const format='{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "aihr-owner")}},'
  +'"running":{{json .State.Running}},"pid":{{json .State.Pid}},"started":{{json .State.StartedAt}},"network":{{json .HostConfig.NetworkMode}},'
  +'"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"name":{{json $m.Name}},"type":{{json $m.Type}},"destination":{{json $m.Destination}}}{{end}}]}';
 const row=JSON.parse(dockerQuery(['inspect','--type','container','--format',format,id]));
 assert(row.id===id&&row.name==='/'+container&&row.owner===container&&row.network==='host'
  &&typeof row.running==='boolean'&&/^[0-9T:.+Z-]{20,40}(?![\s\S])/.test(row.started)
  &&Array.isArray(row.mounts)&&row.mounts.length===1,'Owned development PostgreSQL identity refused');
 const [volume]=row.mounts;
 assert(volume.type==='volume'&&volume.destination==='/var/lib/postgresql/data'
  &&/^[a-f0-9]{64}(?![\s\S])/.test(volume.name),'Development PostgreSQL anonymous volume refused');
 return {id,pid:row.pid,running:row.running,started:row.started,volume:volume.name};
}
function captureDevelopmentPostgres(id){
 const row=observeDevelopmentPostgres(id);
 assert(row.running,'Development PostgreSQL running birth unavailable');
 const birth=processBirth(row.pid),cgroup=readFileSync('/proc/'+row.pid+'/cgroup','utf8');
 const expected=['/system.slice/docker-'+id+'.scope','/docker/'+id].find(path=>cgroup==='0::'+path+'\n');
 assert(birth&&expected,'Development PostgreSQL native cgroup birth unavailable');
 const path='/sys/fs/cgroup'+expected,state=lstatSync(path,{bigint:true});
 const after=observeDevelopmentPostgres(id);
 const cgroupAfter=lstatSync(path,{bigint:true});
 assert(state.isDirectory()&&cgroupAfter.isDirectory()&&state.dev===cgroupAfter.dev&&state.ino===cgroupAfter.ino
  &&after.running&&after.pid===row.pid&&after.started===row.started&&after.volume===row.volume&&processBirth(row.pid)===birth
  &&readFileSync('/proc/'+row.pid+'/cgroup','utf8')===cgroup,'Development PostgreSQL birth changed');
 return {id,pid:row.pid,started:row.started,volume:row.volume,birth,path,cgroupDevice:String(state.dev),cgroupInode:String(state.ino)};
}
function assertDevelopmentLockLogDriver(id){
 const config=JSON.parse(dockerQuery(['inspect','--type','container','--format','{{json .HostConfig.LogConfig}}',id]));
 assert(config.Type==='json-file'&&config.Config.mode==='blocking'&&config.Config['max-size']==='16m'
  &&config.Config['max-file']==='1','Development PostgreSQL Docker log delivery refused');
}
const developmentDatabaseBackends="select exists(select from pg_stat_activity where datname=current_database() and backend_type='client backend' and pid<>pg_backend_pid())";
function developmentPostgresControl(held,sql){
 return dockerQuery(['exec',held.id,'psql','-XAtq','--no-password','-v','ON_ERROR_STOP=1',
  '-h','/var/run/postgresql','-p','5433','-U','postgres','-d','ai_hr_dev','-c',sql],4096,2000);
}
async function markDevelopmentLockLog(phase){
 assert(phase==='begin'||phase==='end','Invalid development PostgreSQL lock log marker');
 const held=developmentPostgresBirth,current=captureDevelopmentPostgres(held.id);
 assert.deepEqual(current,held,'Development PostgreSQL log marker birth changed');
 assertDevelopmentLockLogDriver(held.id);
 if(phase==='end'){
  const deadline=performance.now()+5000;
  while(true){
   const active=developmentPostgresControl(held,developmentDatabaseBackends);
   if(active==='f')break;
   assert(active==='t'&&performance.now()<deadline,'Development PostgreSQL application backends did not drain');
   await pause(50);
  }
 }
 const drainCheck=phase==='end'?" IF ("+developmentDatabaseBackends
  +") THEN RAISE EXCEPTION 'Development PostgreSQL application backend still active'; END IF;":"";
 const sql="BEGIN READ ONLY; DO $aihr$ BEGIN IF current_setting('log_lock_waits') <> 'on' OR current_setting('deadlock_timeout') <> '100ms'"
  +" OR current_setting('log_destination') <> 'stderr' OR current_setting('logging_collector') <> 'off'"
  +" THEN RAISE EXCEPTION 'Development PostgreSQL lock logging settings refused'; END IF;"
  +drainCheck+" RAISE LOG 'AIHR_LOCK_WINDOW_V1 "+lockLogNonce+" "+phase+"'; END; $aihr$; ROLLBACK;";
 assert.equal(developmentPostgresControl(held,sql),'');
}
function confirmDevelopmentPostgresAbsent(held){
 const containerAbsent=dockerContainerIds(`id=${held.id}`).length===0&&namedContainer().length===0;
 const processAbsent=processBirth(held.pid)!==held.birth;
 let cgroupAbsent=false;
 try{lstatSync(held.path);}catch(error){if(error.code==='ENOENT')cgroupAbsent=true;else throw error;}
 const volumeAbsent=dockerQuery(['volume','ls','--quiet','--filter','name='+held.volume])==='';
 return containerAbsent&&processAbsent&&cgroupAbsent&&volumeAbsent;
}

try{
 for(const port of comparison?comparisonPorts:[...ports,3443]){timeBudget(1);await assertPortFree(port);}
 if(comparison){
  const {cell}=comparison;
  assert(measureDevelopment&&!requireRenderedUnion&&workers===cell.workers&&poolPerWorker===cell.poolPerWorker
   &&totalApplicationPool===cell.totalPool&&heapPerWorker===cell.heapMiBPerWorker&&totalHeapMiB===cell.totalHeapMiB,
  'Worker comparison cell topology refused');
 }
 const {buildEnv,admission}=systemBuildEnvironment(env,readFileSync('/proc/meminfo','utf8'));
 report.buildHeap=admission;save();
 if(measureDevelopment){
  assert(/^[1-9][0-9]*(?![\s\S])/.test(env.GITHUB_RUN_ID)&&env.GITHUB_RUN_ATTEMPT==='1'&&env.AIHR_CI_UNIT==='db-1'
   &&realpathSync(privateDir)===privateDir,'Development PostgreSQL reset scope refused');
  mkdirSync(join(privateDir,'docker-config'),{mode:0o700});
  assert(namedContainer().length===0,'Development PostgreSQL pre-reset absence refused');
  const resetEnv={...developmentDocker().env,AIHR_DEVELOPMENT_DB_NAME:container,
   AIHR_CI_PG_DEVELOPMENT_LOCK_LOG:'1',GITHUB_JOB:env.GITHUB_JOB};
  for(const key of ['GITHUB_ACTIONS','CI','GITHUB_EVENT_NAME','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','AIHR_CI_UNIT',
   'AIHR_CI_PG_PROFILE','AIHR_CI_PG_CONFIGURED_CAP_BYTES','AIHR_CI_PG_PEAK_BUDGET_BYTES','AIHR_CI_PG_MEMORY_GIB',
   'AIHR_CI_PG_JIT','AIHR_CI_PG_DURABLE','AIHR_CI_PG_STATEMENTS','AIHR_CI_PG_STATEMENTS_OWNER'])
   if(env[key]!==undefined)resetEnv[key]=env[key];
  developmentReset.admitted=true;
  await run('postgres','/usr/bin/bash',['--noprofile','--norc','-c',developmentResetCommand],resetEnv);
  assert(namedContainer()[0]===developmentReset.id,'Development PostgreSQL name no longer matches the held creation ID');
  developmentPostgresBirth=captureDevelopmentPostgres(developmentReset.id);
 }else await run('postgres','bash',['.github/ci/postgres.sh','reset']);
 dbStarted=true;
 if(comparison){
  comparison.recordDatabase(developmentPostgresBirth);
  postgresProfile=observeComparisonPostgres(developmentPostgresBirth);
  assert.equal(postgresProfile.capBytes,2113929216,'Worker comparison native PostgreSQL memory cap refused');
  assert.equal(postgresProfile.swapMaxBytes,0,'Worker comparison PostgreSQL swap refused');
 }
 await run('migrate','pnpm',['db:migrate']);
 // Native performance helpers are installed through the ordinary migration journal.
 if(comparison){
  const receipt=readComparisonJson(join(focusedEvidence,'personnel-draft-discard-premigration-role-prerequisites.json'),256*1024);
  assert(receipt.kind==='PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES'
   &&receipt.phase==='before_initial_candidate_migration'&&receipt.fixture?.mode==='focused_disposable'
   &&receipt.candidate===sha&&receipt.controller===report.controller&&receipt.runId===report.run&&receipt.attempt==='1',
  'Worker comparison focused role evidence refused');
  for(const [key,path] of Object.entries({
   helperSha256:'test/helpers/personnel-draft-discard-ci-role-fixture.ts',wrapperSha256:'scripts/migrate-with-focused-prerequisites.ts',
   orchestrationSha256:'scripts/lib/discard-premigration.ts',
  }))assert.equal(receipt[key],checksum(readFileSync(path)),'Worker comparison focused role source seal refused');
 }
 copyFileSync(join(focusedEvidence,'personnel-draft-discard-premigration-role-prerequisites.json'),join(out,'personnel-draft-discard-premigration-role-prerequisites.json'));
 await run('organisation-admission-verifier',process.execPath,['--import','tsx','scripts/provision-organisation-admission.ts']);
 await run('catalogs',process.execPath,['--import','tsx','scripts/seed-catalogs.ts']);
 await run('fixture',process.execPath,['--conditions=react-server','--import','tsx','scripts/performance/system-fixture.mjs'],{...env,NODE_ENV:'development',TEST_DATABASE_URL:env.DATABASE_URL,TEST_MIGRATION_DATABASE_URL:env.MIGRATION_DATABASE_URL},600000);
 if(comparison){
  const native=readComparisonJson(join(out,'fixture.json'),512*1024);
  const population=readComparisonJson(join(out,'actor-tenancy.json'),4096);
  const privateFixture=readComparisonJson(join(privateDir,'fixture.json'),8*1024**2);
  assert(native.fictional===true&&population.fictional===true&&native.attendanceDays===comparison.cell.attendanceDays
   &&native.claimsPerEmployee===comparison.cell.claimsPerActor&&native.tenants===population.tenants&&native.companies===population.companies
   &&native.users===population.trafficActors&&native.users===population.nativeSelectedRows
   &&typeof privateFixture.today==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(privateFixture.today)
   &&privateFixture.month===privateFixture.today.slice(0,7)
   &&[native.users,native.tenants,native.companies,population.nativeGrants,native.counts.claims,native.counts.attendance,native.counts.payslips]
    .every(value=>Number.isSafeInteger(value)&&value>0),'Worker comparison fixture evidence refused');
  fixture={day:privateFixture.today,actors:native.users,tenants:native.tenants,companies:native.companies,
   nativeGrants:population.nativeGrants,claims:native.counts.claims,attendance:native.counts.attendance,payslips:native.counts.payslips};
 }
 // Refuse invalid database/role/fixture setup before paying for the production build.
 if(!comparison||comparison.cell.buildMode==='comparison-first'){
  await run('build',process.execPath,['.github/ci/build-heap.mjs','measure',join(out,'next-build-memory'),'--','pnpm','build'],buildEnv);
  if(comparison)build=comparison.snapshot.capture(comparison.frontiers.activeEndMs);
 }else{
  assert.equal(comparison.cell.buildMode,'comparison-copy');
  build=comparison.snapshot.install(comparison.frontiers.activeEndMs);
 }
 if(comparison)comparison.holdBuild(build);
 timeBudget(1);
 report.buildId=readFileSync('.next/BUILD_ID','utf8').trim();
 if(build)assert.equal(report.buildId,build.seal.buildId,'Worker comparison runtime build ID differs');

 await run('certificate','openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(privateDir,'key.pem'),'-out',join(privateDir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
 mkdirSync(join(out,'cpu'),{recursive:true});
 report.applicationRuntimeFrom=new Date().toISOString();save();
 if(measureDevelopment)await markDevelopmentLockLog('begin');
 for(const [index,port]of ports.entries()){
  timeBudget(1);
  const fd=openSync(join(privateDir,'server-'+index+'.log'),'w',0o600);appFds.push(fd);
  const app=trackChild(spawn(process.execPath,['--cpu-prof','--cpu-prof-dir='+join(out,'cpu'),'--import',resolve('scripts/performance/profile-exit.mjs'),'--import',resolve('scripts/performance/transaction-timing.mjs'),'node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...env,NODE_ENV:'production',PERF_TX_TIMING_PATH:join(out,'app-transactions-'+index+'.json'),AIHR_DB_POOL_MAX:String(poolPerWorker),AIHR_APP_WORKERS:String(workers),AIHR_DB_TOTAL_CONNECTIONS:String(totalApplicationPool),NODE_OPTIONS:'--max-old-space-size='+heapPerWorker},stdio:['ignore',fd,fd]}));
  if(measurement)app.on('error',()=>workerProcessErrors.add(index));
  apps.push(app);
 }
 // Avoid replaying a mutation onto a backend socket that closed during an idle interval.
 // Fresh loopback connections also avoid unsafe automatic retries after an ambiguous write.
 timeBudget(1);
 upstream=new http.Agent({keepAlive:false,maxSockets:4000});let nextWorker=0;
 proxy=https.createServer({key:readFileSync(join(privateDir,'key.pem')),cert:readFileSync(join(privateDir,'cert.pem'))},(req,res)=>{
  const request=http.request({host:'127.0.0.1',port:ports[nextWorker++%ports.length],path:req.url,method:req.method,agent:upstream,
   headers:{...req.headers,host:'localhost:3443','x-forwarded-host':'localhost:3443','x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  if(proxySockets)request.on('socket',proxySockets.observe);
  request.on('error',error=>{
   report.proxyErrors.push({at:new Date().toISOString(),method:req.method,path:req.url.split('?')[0],code:error.code??error.name,reusedSocket:request.reusedSocket,headersSent:res.headersSent,clientAborted:Boolean(req.aborted||res.destroyed)});save();
   if(res.destroyed)return;if(res.headersSent){res.destroy();return;}res.writeHead(502);res.end();
  });
  req.on('aborted',()=>request.destroy());
  res.on('close',()=>{if(!res.writableFinished)request.destroy();});req.pipe(request);
 });await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(3443,'127.0.0.1',resolve);});
 report.workerReadiness=[];
 for(const [worker,port]of ports.entries()){
  const started=Date.now();let health=false,login=false,attempts=0;
  while(Date.now()-started<60000){
   timeBudget(1);
   attempts++;
   try{
    const response=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(timeBudget(5000))});
    health=response.status===200&&(await response.text())==='{"status":"ok"}\n';
    if(health){
     const response=await fetch('http://127.0.0.1:'+port+'/login',{signal:AbortSignal.timeout(timeBudget(5000))});
     login=response.status===200;await response.body?.cancel();
     if(login)break;
    }
   }catch{}
   await pause(500);
  }
  report.workerReadiness.push({worker,elapsedMs:Date.now()-started,attempts,health,login,homeHandlerRequests:0});save();
  assert(health&&login,'production worker did not become ready');
 }
 if(comparison){
  for(const app of apps){
   assert(app.exitCode===null&&app.signalCode===null,'Worker comparison worker terminated before driver admission');
   appBirths.set(app.pid,childBirths.get(app));
  }
  report.comparisonWorkerMemory={startup:comparisonWorkerMemory(apps,appBirths),terminal:null};
 }
 // The driver covers setup journeys and verification as well as the steady traffic interval.
 // Keep the post-warmup allowance constant when the measured interval is longer.
 const driverTimeoutMs=600000+Math.max(0,Number(env.PERF_HTTP_HOLD_MS??30000)-30000);
 if(comparison)assert.equal(driverTimeoutMs,comparison.cell.driverMs,'Worker comparison driver budget differs');
 const clockTicks=execFileSync('getconf',['CLK_TCK'],{encoding:'utf8',...(comparison?{env,timeout:timeBudget(5000),killSignal:'SIGKILL'}:{})}).trim();
 await run('http-and-browser',process.execPath,['--import','tsx','scripts/performance/system-load.mjs'],{...env,PERF_APP_PIDS:apps.map(app=>app.pid).join(','),PERF_PROXY_PID:String(process.pid),PERF_POSTGRES_CONTAINER:container,...(measureDevelopment?{PERF_POSTGRES_CONTAINER_ID:developmentPostgresBirth.id}:{}),PERF_APP_WORKERS:String(workers),PERF_CLOCK_TICKS:clockTicks,NODE_OPTIONS:'--max-old-space-size=2048'},driverTimeoutMs);
 if(comparison)report.comparisonWorkerMemory.terminal=comparisonWorkerMemory(apps,appBirths);
 summarizeNativeFailures();
 assert(report.workerFatalDiagnostics.every(worker=>worker.logMarkers.passiveReadUnavailable===0),'passive shell approval read failures must be fixed before acceptance');
 report.exitCode=0;
}catch(error){
 report.error=String(error.message).slice(0,350);
 console.error(comparison?'[system-perf] Comparison cell setup or measurement refused':'[system-perf] '+report.error);
}
finally{
 cleaning=true;
 if(proxy&&measurement){
  const serverClosed=new Promise(resolve=>{proxy.close(error=>resolve(!error));proxy.closeAllConnections();});
  const agentClosed=proxySockets.closeAgent(upstream);
  let proxyTimer;
  const proxyLimit=new Promise(resolve=>{proxyTimer=setTimeout(resolve,5000);});
  const result=await Promise.race([Promise.allSettled([serverClosed,agentClosed]),proxyLimit]).finally(()=>clearTimeout(proxyTimer));
  if(result){
   const [server,agent]=result;
   const sockets=agent.status==='fulfilled'?agent.value:null;
   measurement.settlement.proxy=server.status==='fulfilled'&&server.value===true&&sockets?.state==='settled'
    &&sockets.assigned>0&&sockets.assigned===sockets.closed&&sockets.pending===0&&sockets.queued===0&&!proxyFailures.failed()?'settled':'failed';
  }
 }else{
  if(proxy)await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});
  if(upstream)upstream.destroy();
 }
 const workerStops=apps.map(async(app,worker)=>{
  if(measurement&&!app.pid)return {worker,code:null,signal:null};
  if(app.exitCode!==null||app.signalCode!==null)return {worker,alreadyExited:true,code:app.exitCode,signal:app.signalCode};
  const exited=new Promise(resolve=>app.once('exit',resolve));
  signalChild(app,'SIGUSR2');await Promise.race([exited,pause(5000)]);
  const forced=app.exitCode===null&&app.signalCode===null;
  if(forced){
   signalChild(app,'SIGKILL');
   if(measureDevelopment)await Promise.race([exited,pause(5000)]);else await exited;
  }
  return {worker,requestedSignal:'SIGUSR2',forced,code:app.exitCode,signal:app.signalCode};
 });
 report.profileShutdown=measurement?(await Promise.allSettled(workerStops)).map((result,worker)=>
  result.status==='fulfilled'?result.value:{worker,code:null,signal:null}):await Promise.all(workerStops);
 if(measurement&&apps.length===workers){
  const acknowledged=report.profileShutdown.every(row=>row.code!==null||row.signal!==null);
  const clean=workerProcessErrors.size===0&&report.profileShutdown.every(row=>row.requestedSignal==='SIGUSR2'&&row.forced===false&&row.code===0&&row.signal===null);
  measurement.settlement.workers=clean?'settled':acknowledged?'failed':'unknown';
 }
 if(apps.length){
  const observedPoolSizes=apps.map((_,worker)=>{
   try{return JSON.parse(readFileSync(join(out,'app-transactions-'+worker+'.json'),'utf8')).observedPoolSizes??[];}
   catch{return [];}
  });
  const verified=observedPoolSizes.length===workers&&observedPoolSizes.every(sizes=>sizes.length===1&&sizes[0]===poolPerWorker);
  report.poolBudgetEvidence={observedPoolSizes,verified};
  if(report.exitCode===0&&!verified){
   report.exitCode=1;
   report.error='Application worker database pools did not verify the requested connection budget';
  }
 }
 for(const fd of appFds){
  if(!measurement)closeSync(fd);
  else try{closeSync(fd);}catch{measurement.settlement.workers='failed';}
 }
 try{summarizeNativeFailures();}catch{report.nativeFailureSummaryUnavailable=true;}
 if(apps.length&&!comparison)try{summarizeCpu();}catch(error){report.cpuSummaryError=String(error.message).slice(0,180);}
 if(dbStarted){
  if(!measurement){
   const stats=spawnSync('bash',['.github/ci/postgres.sh','stats'],{env,encoding:'utf8'});
   writeFileSync(join(out,'postgres-resources.txt'),stats.stdout??'');
  }else try{
   const stats=dockerQuery(['stats','--no-stream','--format','{{json .}}',developmentPostgresBirth.id],16384);
   writeFileSync(join(out,'postgres-resources.txt'),stats+'\n');
   if(comparison){
    postgresProfile=observeComparisonPostgres(developmentPostgresBirth);
    assert(postgresProfile.capBytes===2113929216&&postgresProfile.swapMaxBytes===0
     &&postgresProfile.oom===0&&postgresProfile.oomKill===0,'Worker comparison PostgreSQL resource evidence refused');
   }
  }catch{report.postgresResourceSummaryUnavailable=true;report.exitCode=1;}
  try{
   if(measureDevelopment){
    assert(namedContainer()[0]===developmentPostgresBirth.id,'Owned development PostgreSQL identity changed');
    if(report.applicationRuntimeFrom)try{await markDevelopmentLockLog('end');}
    catch{report.postgresLockWindowEndUnavailable=true;}
   }
   else{
    const owner=execFileSync('docker',['inspect','--format','{{index .Config.Labels "aihr-owner"}}',container],{encoding:'utf8',timeout:10000}).trim();
    assert.equal(owner,container);
   }
   // Scope acceptance to actual application runtime. Setup/rehearsal diagnostics remain
   // independent. No tail truncation: exceeding the bounded capture fails evidence closed.
   const logContext=measureDevelopment?developmentDocker():null;
   const logs=spawnSync(logContext?DEVELOPMENT_DOCKER_COMMAND:'docker',
    [...(logContext?.args??[]),'logs',...(!measureDevelopment&&report.applicationRuntimeFrom?['--since',report.applicationRuntimeFrom]:[]),
     logContext?developmentPostgresBirth.id:container],
    {encoding:'utf8',timeout:timeBudget(10000),maxBuffer:8*1024*1024,...(logContext?{env:logContext.env,killSignal:'SIGKILL'}:{})});
   assert.equal(logs.status,0);
   const log=measureDevelopment?(logs.stderr??''):(logs.stdout??'')+'\n'+(logs.stderr??'');
   const advisoryKeys=new Map();
   if(measureDevelopment)try{
    const path=join(privateDir,'diagnostic-lock-families.json'),state=lstatSync(path);
    if(state.isFile()&&state.nlink===1&&state.uid===process.getuid()&&(state.mode&0o777)===0o600&&state.size<=128*1024){
     const rows=JSON.parse(readFileSync(path,'utf8'));
     if(Array.isArray(rows)&&rows.length<=1024&&rows.every(row=>Array.isArray(row)&&row.length===2
       &&typeof row[0]==='string'&&/^\d{1,10}:\d{1,10}:\d{1,10}:[12]$/.test(row[0])&&typeof row[1]==='string'&&row[1].length<=32)){
      for(const [key,family] of rows)advisoryKeys.set(key,family);
     }
    }
   }catch{/* Exact lock class remains available when the optional fixture labels are absent. */}
   const lockDiagnostics={runtimeFrom:report.applicationRuntimeFrom,advisoryKeys};
   const window=measureDevelopment&&!report.postgresLockWindowEndUnavailable?developmentPostgresLockWindow(log,lockLogNonce,lockDiagnostics):null;
   postgresRuntimeFailures=window?.failures??postgresLockFailures(log,lockDiagnostics);
   if(measureDevelopment){
    if(window)assert.deepEqual(captureDevelopmentPostgres(developmentPostgresBirth.id),developmentPostgresBirth,
     'Development PostgreSQL lock log capture birth changed');
    report.postgresWaitLogCoverage=window?{kind:'development-heavyweight-lock-log',thresholdMs:window.thresholdMs,
     retainedFailures:window.failures.length,databaseBackendsSettled:true}:null;
   }
   const scope=measureDevelopment&&!window?'Unqualified retained disposable database stderr; setup may be included':
    'Owned disposable database during application runtime only';
   writeFileSync(join(out,'postgres-lock-failures.json'),JSON.stringify({scope:scope+'; bounded lock topology and routine frames; SQL/values/raw logs excluded',runtimeFrom:report.applicationRuntimeFrom??null,logWindow:window?'qualified-runtime':'unqualified',failures:postgresRuntimeFailures},null,2));
  }catch{report.postgresLockFailureSummaryUnavailable=true;}
 }
 if(measurement&&developmentReset.admitted){
  let physicalAbsent=null;
  if(developmentReset.id)try{
   const current=observeDevelopmentPostgres(developmentReset.id);
   let held=developmentPostgresBirth;
   if(!held&&current.running)try{held=captureDevelopmentPostgres(developmentReset.id);}catch{}
   let sameBirth=held&&current.started===held.started&&current.volume===held.volume;
   if(sameBirth&&current.running)try{
    assert.deepEqual(captureDevelopmentPostgres(developmentReset.id),held);
   }catch{sameBirth=false;}
   assert(sameBirth,'Development PostgreSQL removal birth refused');
   const context=developmentDocker();
   try{await run('cleanup',DEVELOPMENT_DOCKER_COMMAND,[...context.args,'rm','-fv',developmentReset.id],context.env,25000);}
   catch{report.exitCode=1;}
   // A timeout can leave a pending Docker creation. An empty snapshot is not terminal evidence then.
   if(developmentRemoveApi==='settled'&&developmentReset.state!=='unknown'&&sameBirth)
    physicalAbsent=confirmDevelopmentPostgresAbsent(held);
  }catch{report.exitCode=1;}
  Object.assign(measurement.settlement,developmentPostgresSettlement(developmentReset.state,developmentRemoveApi,physicalAbsent));
 }else if(!measurement&&dbStarted)await run('cleanup','bash',['.github/ci/postgres.sh','stop']).catch(()=>{report.exitCode=1;});
 report.runtimeAcceptance=runtimeAcceptance({workers,
  workerDiagnostics:report.nativeFailureSummaryUnavailable?undefined:report.workerFatalDiagnostics,
  nativeFailures:report.nativeFailureSummaryUnavailable?undefined:report.nativeRuntimeFailures,postgresFailures:postgresRuntimeFailures,
  postgresRuntimeScoped:Boolean(report.applicationRuntimeFrom)&&!report.postgresLockFailureSummaryUnavailable
   &&(!measureDevelopment||Boolean(report.postgresWaitLogCoverage)),
  profileShutdown:report.profileShutdown,poolBudgetVerified:report.poolBudgetEvidence?.verified});
 if(!report.runtimeAcceptance.pass){
  if(report.exitCode===0)report.error='Application runtime diagnostics failed acceptance';
  report.exitCode=1;
 }
 if(measurement){
  const {driver,proxy,workers,postgres,postgresAbsent}=measurement.settlement;
  measurement.complete=report.exitCode===0&&measurement.driverReceipt==='observed'&&measurement.driver?.complete===true
   &&driver==='settled'&&proxy==='settled'&&workers==='settled'&&postgres==='settled'&&postgresAbsent===true;
  if(!measurement.complete&&report.exitCode===0){
   report.error='Development browser measurement settlement was incomplete';report.exitCode=1;
  }
 }
 save();
}
return {report,build,fixture,postgresProfile,directChildren};
}

function comparisonWorkerMemory(apps,births){
 return apps.map((app,worker)=>{
  const birth=births.get(app.pid);
  assert(birth&&app.exitCode===null&&app.signalCode===null&&processBirth(app.pid)===birth,'Worker comparison application memory birth refused');
  const status=readFileSync('/proc/'+app.pid+'/status','utf8');
  const memory=field=>{
   const value=Number(status.match(new RegExp('^'+field+':\\s+(\\d+) kB$','m'))?.[1]);
   assert(Number.isSafeInteger(value)&&value>0,'Worker comparison application memory missing');
   return value*1024;
  };
  const row={worker,rssBytes:memory('VmRSS'),peakRssBytes:memory('VmHWM')};
  assert(processBirth(app.pid)===birth,'Worker comparison application memory birth changed');
  return row;
 });
}

function observeComparisonPostgres(birth){
 const read=name=>{
  const path=join(birth.path,name),value=readFileSync(path,'utf8').trim();
  const row=lstatSync(birth.path,{bigint:true});
  assert(String(row.dev)===birth.cgroupDevice&&String(row.ino)===birth.cgroupInode
   &&processBirth(birth.pid)===birth.birth,'Worker comparison PostgreSQL resource birth changed');
  return value;
 };
 const exact=value=>{
  const parsed=Number(value);
  assert(/^(0|[1-9][0-9]*)$/.test(value??'')&&Number.isSafeInteger(parsed),'Worker comparison PostgreSQL counter refused');
  return parsed;
 };
 const events=Object.fromEntries(read('memory.events.local').split('\n').map(row=>row.split(' ')));
 return {birthSeal:checksum(birth.id+':'+birth.volume),capBytes:exact(read('memory.max')),swapMaxBytes:exact(read('memory.swap.max')),
  currentBytes:exact(read('memory.current')),peakBytes:exact(read('memory.peak')),oom:exact(events.oom),oomKill:exact(events.oom_kill)};
}

const inheritedComparisonKeys=[
 'PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TZ','PNPM_HOME','COREPACK_HOME','CI',
 'GITHUB_ACTIONS','GITHUB_EVENT_NAME','GITHUB_EVENT_PATH','GITHUB_JOB','GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID',
 'GITHUB_WORKFLOW','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','GITHUB_SHA','GITHUB_REF','GITHUB_REF_NAME',
 'GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_WORKSPACE','RUNNER_TEMP','RUNNER_ENVIRONMENT','RUNNER_OS','RUNNER_ARCH',
 'AIHR_CI_HEAD','AIHR_CI_CONTROL_HEAD','AIHR_CI_UNIT','AIHR_CI_PG_PROFILE','AIHR_CI_PG_CONFIGURED_CAP_BYTES',
 'AIHR_CI_PG_PEAK_BUDGET_BYTES','AIHR_CI_PG_JIT','AIHR_CI_PG_DURABLE','AIHR_CI_PG_STATEMENTS','AIHR_CI_PG_STATEMENTS_OWNER',
 'AIHR_MEASURED_BROWSER_COURSE','PLAYWRIGHT_CHROMIUM_EXECUTABLE',
];
function comparisonEnvironment(cell,paths){
 const base=Object.fromEntries(inheritedComparisonKeys.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
 assert(base.PLAYWRIGHT_CHROMIUM_EXECUTABLE===undefined||base.PLAYWRIGHT_CHROMIUM_EXECUTABLE==='/usr/bin/google-chrome',
  'Worker comparison Chromium source refused');
 const temp=join(paths.privateDir,'tmp');
 mkdirSync(temp,{mode:0o700});
 return Object.freeze({...base,TMPDIR:temp,NEXT_TELEMETRY_DISABLED:'1',
  PERF_HTTP_SUITE:cell.suite,PERF_HTTP_THINK_MS:String(cell.thinkMs),PERF_HTTP_HOLD_MS:String(cell.holdMs),
  PERF_APP_WORKERS:String(cell.workers),PERF_APP_POOL_CONNECTIONS:String(cell.totalPool),PERF_APP_TOTAL_HEAP_MIB:String(cell.totalHeapMiB),
  PERF_ATTENDANCE_DAYS:String(cell.attendanceDays),...(cell.oversubscribed?{PERF_ALLOW_CPU_OVERSUBSCRIPTION_DIAGNOSTIC:'true'}:{})});
}
function comparisonTelemetry(result,out){
 const {report,postgresProfile,fixture}=result;
 const measurement=report.developmentMeasurement;
 const number=value=>Number.isFinite(value)&&value>=0?value:null;
 const count=value=>Array.isArray(value)&&value.length<=1000000?value.length:null;
 const metrics=(row,keys)=>Object.fromEntries(keys.map(key=>[key,number(row?.[key])]));
 let browser=null;
 try{browser=readComparisonJson(join(out,'http-browser.json'),32*1024**2);}catch{}
 let renderedCaseCounts=null;
 const driver=measurement?.driver;
 if(driver?.renderedCapture)try{
  const {bytes,sha256}=driver.renderedCapture;
  const capture=readComparisonJson(join(out,'navigation-browser-capture.json'),bytes,sha256);
  assert(capture.schemaVersion===1&&capture.releaseAuthorized===false&&capture.baseline.complete===true);
  assert(driver.suite==='workflow-preflight'?capture.loaded===undefined:capture.loaded?.complete===true);
  for(const phase of ['baseline',...(capture.loaded?['loaded']:[])])
   for(const key of Object.keys(driver.identity))assert.equal(capture[phase][key],driver.identity[key]);
  renderedCaseCounts={baseline:count(capture.baseline.observations),loaded:count(capture.loaded?.observations)};
 }catch{}
 let canonicalBuild=null;
 if(result.build&&report.phases.some(row=>row.label==='build'))try{
  const memory=readComparisonJson(join(out,'next-build-memory','build-memory.json'),32768);
  canonicalBuild={...metrics(memory,['peakRssKiB','minMemAvailableKiB','memTotalKiB','memAvailableSamples','exitCode']),
   verdict:['pass','warn','fail'].includes(memory.verdict)?memory.verdict:null};
 }catch{}
 const roles=['employee','manager','companyHR','groupHR'];
 const roleLatency=browser?.steady?Object.fromEntries(roles.map(role=>[role,Object.fromEntries(['navigation','read','write'].map(work=>
  [work,metrics(browser.steady.roles?.[role]?.[work],['samples','p50Ms','p95Ms','p99Ms','maxMs'])]))])):null;
 const appMemory=browser?.appMemory?.processes;
 const workers=report.topology.workers,stops=report.profileShutdown??[];
 const abnormal=stops.filter(row=>row.alreadyExited===true||row.forced===true||row.code!==null&&row.code!==0||row.signal!==null).length;
 const stopCensus=stops.length===workers&&stops.every(row=>row.code!==null||row.signal!==null);
 const workerCrashes=abnormal>0||stopCensus?abnormal:null;
 const failures=count(report.nativeRuntimeFailures);
 const nativeRuntimeFailureCount=failures>0||report.workerFatalDiagnostics?.length===workers?failures:null;
 const poolBudget=report.poolBudgetEvidence?{verified:report.poolBudgetEvidence.verified===true,
  observedPoolSizes:report.poolBudgetEvidence.observedPoolSizes.slice(0,workers).map(row=>Array.isArray(row)&&row.length<=16
   &&row.every(size=>Number.isSafeInteger(size)&&size>=1&&size<=16)?row:null)}:null;
 return {
  scope:result.scope,topology:report.topology,cpuAdmission:report.cpuAdmission,fixture,canonicalBuild,
  postgres:postgresProfile,postgresWaitLog:report.postgresWaitLogCoverage??null,
  nativeRuntimeFailureCount,workerCrashes,
  runtimeAcceptance:report.runtimeAcceptance??null,poolBudget,
  driverReceipt:measurement?.driverReceipt??null,driver:driver??null,renderedCaseCounts,
  settlement:measurement?.settlement??null,roleLatency,
  workerMemory:report.comparisonWorkerMemory??null,
  appMemory:Array.isArray(appMemory)&&appMemory.length===report.topology.workers?appMemory.map(row=>metrics(row,['worker','rssMiB','peakRssMiB'])):null,
  resourceCpu:browser?.resourceCpu?metrics(browser.resourceCpu,['elapsedSeconds','postgresCpuSeconds','postgresThrottledSeconds',
   'proxyCpuSeconds','hostUserSystemSeconds','hostIoWaitSeconds','hostStealSeconds']):null,
  appCpu:browser?.cpu?metrics(browser.cpu,['appProcesses','appCpuSeconds','driverCpuSeconds','elapsedSeconds']):null,
  browserErrors:count(browser?.browserErrors),functionalErrors:count(browser?.functionalErrors),
  phaseStatus:report.phases.map(row=>({label:row.label,elapsedMs:row.elapsedMs,exitCode:row.exitCode,timedOut:row.timedOut})),
 };
}
function comparisonPassed(result,telemetry,prerequisite){
 const {driver}=telemetry;
 const measurement=result.report.developmentMeasurement;
 return result.report.exitCode===0&&measurement?.complete===true&&driver?.busyResponses===0
  &&driver.identity.harnessSha256===prerequisite.harnessSha256&&driver.identity.scenarioSha256===prerequisite.scenarioSha256
  &&driver.pageEvents.qualifiedCrashes===0&&telemetry.workerCrashes===0&&telemetry.renderedCaseCounts?.baseline===48
  &&driver.locks.preflight.pass===true
  &&(driver.suite==='workflow-preflight'||driver.locks.loaded.pass===true&&telemetry.roleLatency!==null
   &&Object.values(telemetry.roleLatency).every(role=>Object.values(role).every(row=>row.samples>0&&row.p95Ms!==null)))
  &&telemetry.postgresWaitLog?.thresholdMs===100&&telemetry.postgresWaitLog.retainedFailures===0
  &&telemetry.postgresWaitLog.databaseBackendsSettled===true&&telemetry.runtimeAcceptance?.pass===true
  &&telemetry.postgres?.oom===0&&telemetry.postgres.oomKill===0&&telemetry.workerMemory?.terminal?.length===result.report.topology.workers;
}

async function runWorkerComparison(){
 const env=process.env;
 assert(env.AIHR_MEASURED_BROWSER_COURSE==='serial-2-4-8'&&env.AIHR_CI_PG_PROFILE==='2'
  &&env.AIHR_CI_PG_CONFIGURED_CAP_BYTES==='2113929216'&&env.AIHR_CI_PG_PEAK_BUDGET_BYTES==='2147483648'
  &&env.AIHR_CI_PG_JIT==='on'&&env.AIHR_CI_PG_MEMORY_GIB===undefined,'Worker comparison hosted database profile refused');
 assert(/^[1-9][0-9]{0,14}$/.test(env.AIHR_WORKER_COMPARISON_T0_MS??'')
  &&/^[0-9a-f]{64}$/.test(env.AIHR_WORKER_COMPARISON_ADMISSION_SHA256??''),'Worker comparison sealed admission missing');
 const anchorMs=Number(env.AIHR_WORKER_COMPARISON_T0_MS),now=comparisonClock;
 assert(now()>=anchorMs&&now()<anchorMs+4040000,'Worker comparison admission deadline elapsed');
 assert(realpathSync(env.RUNNER_TEMP)===env.RUNNER_TEMP,'Worker comparison temporary root refused');
 const prerequisite=readComparisonJson(join(env.RUNNER_TEMP,'aihr-worker-comparison-admission.json'),4096,env.AIHR_WORKER_COMPARISON_ADMISSION_SHA256);
 const identity={candidateSha:sha,controllerSha:env.AIHR_CI_CONTROL_HEAD,runId:Number(env.GITHUB_RUN_ID),runAttempt:Number(env.GITHUB_RUN_ATTEMPT)};
 const host={effectiveCpus:os.availableParallelism(),memoryBytes:os.totalmem(),nodeVersion:process.version,postgresProfile:2};
 const family=openWorkerComparisonFamily(env);
 let snapshot,files,current;
 const receipts={},containers=new Set(),volumes=new Set();
 try{
  const model=createWorkerComparisonModel({identity,prerequisite,host,anchorMs,now,
   async observeCell({cell,frontiers}){
    const paths=files.openCell(cell);
    current=null;
    const result=await runSystemCell({cell,frontiers,paths,snapshot,env:comparisonEnvironment(cell,paths),
     holdBuild:view=>files.holdBuild(cell.ordinal,view),
     recordDatabase(birth){
      assert(!containers.has(birth.id)&&!volumes.has(birth.volume),'Worker comparison database birth reused');
      containers.add(birth.id);
      volumes.add(birth.volume);
     },
    });
    current={ordinal:cell.ordinal,result};
    const telemetry=comparisonTelemetry({...result,scope:cell.scope},paths.out);
    receipts[cell.name]=telemetry;
    return {kind:'WORKER_COMPARISON_CELL_V1',scope:cell.scope,passed:comparisonPassed(result,telemetry,prerequisite),
     build:result.build,fixture:result.fixture};
   },
   async settledForReuse({cell,frontiers}){
    const deadline=frontiers.settlementEndMs;
    assert(current?.ordinal===cell.ordinal,'Worker comparison cell completion missing');
    const {report,directChildren}=current.result;
    const childDeadline=Math.min(deadline,now()+5000);
    while(directChildren.size&&now()<childDeadline)await pause(25);
    assert(directChildren.size===0&&now()<deadline,'Worker comparison direct child closes incomplete');
    const {postgres,postgresAbsent}=report.developmentMeasurement.settlement;
    assert(postgres==='settled'&&postgresAbsent===true,'Worker comparison PostgreSQL birth removal incomplete');
    for(const port of comparisonPorts){
     assert(now()<deadline,'Worker comparison loopback deadline elapsed');
     await assertPortFree(port);
    }
    await family.acknowledge(cell.ordinal,deadline);
    files.retireCell(cell.ordinal,deadline);
    current=null;
    return {kind:'WORKER_COMPARISON_CELL_SETTLEMENT_V1',...identity,ordinal:cell.ordinal,settledForReuse:true,
     directChildrenClosed:true,processFamilyEmpty:true,postgresBirthAbsent:true,portsAbsent:true,
     runtimeBuildRetired:true,focusedDirectoryRetired:true};
   },
   verifySeed:({deadlineMs})=>snapshot.verify(deadlineMs),
   retireSeed({deadlineMs}){
    snapshot.close();
    files.retireSeed(deadlineMs);
    return {kind:'WORKER_COMPARISON_SEED_RETIREMENT_V1',...identity,retired:true,privateDirectoryRetired:true};
   },
  });
  await family.acknowledge(0,anchorMs+4040000);
  files=holdWorkerComparisonFiles(env);
  snapshot=holdDevelopmentBuildSnapshot(env);
  files.holdSeed();
  const result=await model.run();
  files.publish({...result,kind:'HOSTED_WORKER_COMPARISON_V1',host,productionEquivalent:false,
   eightWorkerScope:'Four-vCPU oversubscription diagnostic only. No steady load.',
   comparability:'Steady cells use one build seal, independent PostgreSQL births and equal configured budgets. Physical layout and host cache can differ.',
   cells:result.cells.map(cell=>({...cell,observation:receipts[cell.name]??null}))},result.frontiers.finalEndMs);
  return result.complete?0:1;
 }finally{
  family.close();
  try{snapshot?.close();}finally{files?.close();}
 }
}

if(process.argv.length===2){
 assert(process.env.AIHR_MEASURED_BROWSER_COURSE!=='serial-2-4-8','Serial comparison requires the closed process owner');
 process.exitCode=(await runSystemCell()).report.exitCode;
}else{
 assert(process.argv.length===3&&process.argv[2]==='--serial-2-4-8','Unknown system performance runner entry point');
 try{process.exitCode=await runWorkerComparison();}
 catch{console.error('[system-perf] Worker comparison custody or publication refused');process.exitCode=1;}
}
