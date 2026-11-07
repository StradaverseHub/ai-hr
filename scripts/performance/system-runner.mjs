/** Development-only production renderer and durable job-owned PostgreSQL. No target credentials. */
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync,readdirSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import {setTimeout as pause} from 'node:timers/promises';
import {postgresLockFailures} from './lock-failure-log.mjs';
import {admissionFailureMarkers} from './admission-failure-log.mjs';
import {systemBuildEnvironment} from './build-environment.mjs';
import {isolatedWorkerBudget,isolatedWorkerCpuAdmission} from './worker-budget.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git('rev-parse','HEAD');assert.equal(sha,process.env.AIHR_CI_HEAD);assert.equal(git('status','--porcelain'),'');
const out=join(process.env.RUNNER_TEMP,'system-performance-evidence'),privateDir=join(process.env.RUNNER_TEMP,'system-performance-private');
mkdirSync(out,{recursive:true,mode:0o700});mkdirSync(privateDir,{recursive:true,mode:0o700});
const focusedEvidence=join(process.env.RUNNER_TEMP,'aihr-focused');mkdirSync(focusedEvidence,{recursive:true,mode:0o700});
const authKey=randomBytes(32).toString('hex');
const env={...process.env,AIHR_PERFORMANCE_ROLE_FIXTURE:'true',AIHR_FOCUSED_SUITE_CAPACITY:'true',TEST_DB_NAMESPACE:'aifocus',AUTH_PROVIDER:'internal',AUTH_SESSION_KEY:authKey,AUTH_PUBLIC_ORIGIN:'https://localhost:3443',
 AUTH_DEFAULT_ORGANIZATION:'perf-a',ALLOW_DEMO_SESSION:'false',AUDIT_HASH_CHAIN_ENABLED:'true',
 AI_CONFIG_SECRET:randomBytes(32).toString('hex'),PERF_PRIVATE_DIR:privateDir,PERF_EVIDENCE_DIR:out,AIHR_FOCUSED_EVIDENCE_DIR:focusedEvidence,
 DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',
 TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'};
for(const key of Object.keys(env))if(key.startsWith('WORKOS_')||key==='SHARE_PASSWORD'||key==='DEV_USER_ID')delete env[key];
env.SHARE_PASSWORD='';env.DEV_USER_ID='';
const {workers,totalApplicationPool,poolPerWorker,heapPerWorker,totalHeapMiB}=isolatedWorkerBudget(
 process.env.PERF_APP_WORKERS,process.env.PERF_APP_POOL_CONNECTIONS,process.env.PERF_APP_TOTAL_HEAP_MIB);
const host={cpus:os.availableParallelism(),memoryBytes:os.totalmem()};
const cpuAdmission=isolatedWorkerCpuAdmission({workers,availableCpus:host.cpus,
 oversubscriptionDiagnostic:process.env.PERF_ALLOW_CPU_OVERSUBSCRIPTION_DIAGNOSTIC==='true',suite:process.env.PERF_HTTP_SUITE});
if(totalHeapMiB===8192){
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','larger diagnostic heap requires a hosted runner');
 assert(host.cpus===4&&host.memoryBytes>=15*1024**3&&host.memoryBytes<=17*1024**3,'larger diagnostic heap requires the standard hosted 4-CPU / 16-GB runner');
}
const ports=Array.from({length:workers},(_,index)=>3174+index);
const report={kind:'ISOLATED_HTTP_BROWSER_DEVELOPMENT_ONLY',releaseEligible:false,sha,controller:process.env.AIHR_CI_CONTROL_HEAD,
 run:process.env.GITHUB_RUN_ID,runtime:{node:process.version,productionObservedNode:'v24.22.1'},productionEquivalent:false,topology:{workers,poolPerWorker,totalApplicationPool,heapMiBPerWorker:heapPerWorker,totalHeapMiB,upstreamKeepAlive:false,proxyUpstreamMaxSockets:4000},proxyErrors:[],host,cpuAdmission,phases:[],exitCode:1};
const save=()=>writeFileSync(join(out,'runner.json'),JSON.stringify(report,null,2));
save();
async function assertPortFree(port){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});await new Promise(resolve=>server.close(resolve));}
async function run(label,command,args,childEnv=env,timeout=900000){
 console.log('[system-perf] '+label+' started');const start=Date.now();
 const fd=openSync(join(privateDir,label+'.log'),'w',0o600);
 const child=spawn(command,args,{env:childEnv,stdio:['ignore',fd,fd]});
 let killTimer,timedOut=false,exitSignal;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),10000);},timeout);let code;
 try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(value,signal)=>{exitSignal=signal;resolve(value);});});}finally{clearTimeout(timer);clearTimeout(killTimer);closeSync(fd);}
 report.phases.push({label,elapsedMs:Date.now()-start,exitCode:code,timeoutMs:timeout,timedOut,exitSignal});save();
 console.log('[system-perf] '+JSON.stringify(report.phases.at(-1)));
 if(code!==0){const text=readFileSync(join(privateDir,label+'.log'),'utf8').slice(-12000).replace(/[A-Za-z0-9_-]{32,}/g,'<REDACTED>');writeFileSync(join(out,label+'-failure.txt'),text);}
 assert.equal(timedOut,false,label+' exceeded its unchanged process budget; retain incomplete evidence');
 assert.equal(code,0,label+' failed; private process logs contain no published credentials');
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
 writeFileSync(join(out,'server-native-failures.json'),JSON.stringify({scope:'Exact public-error reference/SQLSTATE metadata plus bounded native Draft marker blocks; Draft block errors may overlap; raw logs and SQL excluded',failures},null,2));
}
const apps=[],appFds=[];let proxy,upstream,dbStarted=false;
const container=`aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-db-1`;
try{
 for(const port of ports)await assertPortFree(port);await assertPortFree(3443);
 const {buildEnv,admission}=systemBuildEnvironment(env,readFileSync('/proc/meminfo','utf8'));
 report.buildHeap=admission;save();
 await run('postgres','bash',['.github/ci/postgres.sh','reset']);dbStarted=true;
 await run('migrate','pnpm',['db:migrate']);
 // Native performance helpers are installed through the ordinary migration journal.
 copyFileSync(join(focusedEvidence,'personnel-draft-discard-premigration-role-prerequisites.json'),join(out,'personnel-draft-discard-premigration-role-prerequisites.json'));
 await run('organisation-admission-verifier',process.execPath,['--import','tsx','scripts/provision-organisation-admission.ts']);
 await run('catalogs',process.execPath,['--import','tsx','scripts/seed-catalogs.ts']);
 await run('fixture',process.execPath,['--conditions=react-server','--import','tsx','scripts/performance/system-fixture.mjs'],{...env,NODE_ENV:'development',TEST_DATABASE_URL:env.DATABASE_URL,TEST_MIGRATION_DATABASE_URL:env.MIGRATION_DATABASE_URL},600000);
 // Refuse invalid database/role/fixture setup before paying for the production build.
 await run('build',process.execPath,['.github/ci/build-heap.mjs','measure',join(out,'next-build-memory'),'--','pnpm','build'],buildEnv);
 report.buildId=readFileSync('.next/BUILD_ID','utf8').trim();

 await run('certificate','openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(privateDir,'key.pem'),'-out',join(privateDir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
 mkdirSync(join(out,'cpu'),{recursive:true});
 for(const [index,port]of ports.entries()){
  const fd=openSync(join(privateDir,'server-'+index+'.log'),'w',0o600);appFds.push(fd);
  apps.push(spawn(process.execPath,['--cpu-prof','--cpu-prof-dir='+join(out,'cpu'),'--import',resolve('scripts/performance/profile-exit.mjs'),'--import',resolve('scripts/performance/transaction-timing.mjs'),'node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...env,NODE_ENV:'production',PERF_TX_TIMING_PATH:join(out,'app-transactions-'+index+'.json'),AIHR_DB_POOL_MAX:String(poolPerWorker),AIHR_APP_WORKERS:String(workers),AIHR_DB_TOTAL_CONNECTIONS:String(totalApplicationPool),NODE_OPTIONS:'--max-old-space-size='+heapPerWorker},stdio:['ignore',fd,fd]}));
 }
 // Avoid replaying a mutation onto a backend socket that closed during an idle interval.
 // Fresh loopback connections also avoid unsafe automatic retries after an ambiguous write.
 upstream=new http.Agent({keepAlive:false,maxSockets:4000});let nextWorker=0;
 proxy=https.createServer({key:readFileSync(join(privateDir,'key.pem')),cert:readFileSync(join(privateDir,'cert.pem'))},(req,res)=>{
  const request=http.request({host:'127.0.0.1',port:ports[nextWorker++%ports.length],path:req.url,method:req.method,agent:upstream,
   headers:{...req.headers,host:'localhost:3443','x-forwarded-host':'localhost:3443','x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  request.on('error',error=>{
   report.proxyErrors.push({at:new Date().toISOString(),method:req.method,path:req.url.split('?')[0],code:error.code??error.name,reusedSocket:request.reusedSocket,headersSent:res.headersSent,clientAborted:Boolean(req.aborted||res.destroyed)});save();
   if(res.destroyed)return;if(res.headersSent){res.destroy();return;}res.writeHead(502);res.end();
  });
  req.on('aborted',()=>request.destroy());
  res.on('close',()=>{if(!res.writableFinished)request.destroy();});req.pipe(request);
 });await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(3443,'127.0.0.1',resolve);});
 for(const port of ports){
  let ready=false;for(let i=0;i<120;i++){try{const response=await fetch('http://127.0.0.1:'+port+'/login');if(response.status===200){ready=true;break;}}catch{}await pause(500);}
  assert(ready,'production worker did not become ready');
 }
 // The driver covers setup journeys and verification as well as the steady traffic interval.
 // Keep the post-warmup allowance constant when the measured interval is longer.
 const driverTimeoutMs=600000+Math.max(0,Number(env.PERF_HTTP_HOLD_MS??30000)-30000);
 await run('http-and-browser',process.execPath,['--import','tsx','scripts/performance/system-load.mjs'],{...env,PERF_APP_PIDS:apps.map(app=>app.pid).join(','),PERF_PROXY_PID:String(process.pid),PERF_POSTGRES_CONTAINER:container,PERF_APP_WORKERS:String(workers),PERF_CLOCK_TICKS:execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim(),NODE_OPTIONS:'--max-old-space-size=2048'},driverTimeoutMs);
 summarizeNativeFailures();
 assert(report.workerFatalDiagnostics.every(worker=>worker.logMarkers.passiveReadUnavailable===0),'passive shell approval read failures must be fixed before acceptance');
 report.exitCode=0;
}catch(error){report.error=String(error.message).slice(0,350);console.error('[system-perf] '+report.error);}
finally{
 if(proxy)await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});
 if(upstream)upstream.destroy();
 report.profileShutdown=await Promise.all(apps.map(async(app,worker)=>{
  if(app.exitCode!==null||app.signalCode!==null)return {worker,alreadyExited:true,code:app.exitCode,signal:app.signalCode};
  const exited=new Promise(resolve=>app.once('exit',resolve));
  app.kill('SIGUSR2');await Promise.race([exited,pause(5000)]);
  const forced=app.exitCode===null&&app.signalCode===null;
  if(forced){app.kill('SIGKILL');await exited;}
  return {worker,requestedSignal:'SIGUSR2',forced,code:app.exitCode,signal:app.signalCode};
 }));
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
 for(const fd of appFds)closeSync(fd);
 try{summarizeNativeFailures();}catch{report.nativeFailureSummaryUnavailable=true;}
 if(apps.length)try{summarizeCpu();}catch(error){report.cpuSummaryError=String(error.message).slice(0,180);}
 if(dbStarted){
  const stats=spawnSync('bash',['.github/ci/postgres.sh','stats'],{env,encoding:'utf8'});writeFileSync(join(out,'postgres-resources.txt'),stats.stdout??'');
  try{
   const owner=execFileSync('docker',['inspect','--format','{{index .Config.Labels "aihr-owner"}}',container],{encoding:'utf8',timeout:10000}).trim();
   assert.equal(owner,container);
   const logs=spawnSync('docker',['logs','--tail','10000',container],{encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});
   assert.equal(logs.status,0);
   writeFileSync(join(out,'postgres-lock-failures.json'),JSON.stringify({scope:'Owned disposable database only; bounded lock topology and routine frames; SQL/values/raw logs excluded',failures:postgresLockFailures((logs.stdout??'')+'\n'+(logs.stderr??''))},null,2));
  }catch{report.postgresLockFailureSummaryUnavailable=true;}
  await run('cleanup','bash',['.github/ci/postgres.sh','stop']).catch(()=>{report.exitCode=1;});
 }
 save();
}
process.exitCode=report.exitCode;
