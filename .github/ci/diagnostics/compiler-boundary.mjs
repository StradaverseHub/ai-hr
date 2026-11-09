/** Sequential standard-runner experiment. Ordinary compiler and release witnesses are untouched. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,openSync,closeSync,mkdirSync,lstatSync,readdirSync,statfsSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus,totalmem} from 'node:os';
import {boundaryExecutionSource,BOUNDARY_LIMITS,sha256,admitBoundaryInputs,admitConsumerTraceInputs,CONSUMER_TRACE_INTENT,TRACED_CONSUMERS,boundarySchedule,remainingCompilerMs} from './compiler-boundary-policy.mjs';

export function boundaryArguments(worker,out,mode,index,traceOnly=false){
 assert.equal(typeof traceOnly,'boolean');if(traceOnly&&mode==='consumer')assert(TRACED_CONSUMERS.includes(index),'Only fixed consumers may trace');
 return [worker,mode,out,...(index===undefined?[]:[String(index)]),...(traceOnly&&mode==='consumer'?['--trace-consumer']:[])];
}
export function validatePhase(result){assert(result.code===0&&result.signal===null&&result.stoppedBecause===null&&!result.monitorError,'Native diagnostic phase failed');}
/** After checked producer/declarations, both negative controls and every
 * consumer are independent. None produces an input for another check. */
export async function runIndependentPhases(planned,run,remaining,recordBlocked){
 const key=row=>row.mode+(row.index===undefined?'':'-'+row.index);
 assert(Array.isArray(planned)&&planned.every(row=>row&&typeof row==='object'&&!Array.isArray(row)
  &&(row.mode==='consumer'?Object.keys(row).sort().join('|')==='index|mode'&&Number.isSafeInteger(row.index)&&row.index>=0
   :['source-negative','declaration-negative'].includes(row.mode)&&Object.keys(row).join('|')==='mode'))
  &&new Set(planned.map(key)).size===planned.length,'Invalid independent compiler phase plan');
 const results=[],failures=[],blocked=[];
 for(const item of planned){
  const budget=remaining();assert(Number.isFinite(budget)&&budget>=0,'Invalid remaining aggregate compiler budget');
  if(budget===0){const row={...item,status:'blocked',blockedReason:'aggregate-time-budget',elapsedMs:0,budgetMs:0,
   code:null,signal:null,stoppedBecause:'not-started',monitorError:null};blocked.push(row);recordBlocked(row);continue;}
  try{results.push(await run(item.mode,item.index));}
  catch(error){failures.push({...item,error:String(error)});}
 }
 return{results,failures,blocked};
}
export function blockedUnstartedPhases(planned,phases,budget){
 assert(Number.isFinite(budget)&&budget>=0,'Invalid blocked-phase aggregate budget');
 const key=row=>row.mode+(row.index===undefined?'':'-'+row.index),started=new Set(phases.map(key));
 const failed=phases.find(row=>row.status==='failed'&&['inventory','producer','declarations'].includes(row.mode));
 const reason=budget===0?'aggregate-time-budget':failed?'failed-prerequisite':phases.length?'orchestration-failure':'inventory-or-plan-failure';
 return planned.filter(item=>!started.has(key(item))).map(item=>({...item,status:'blocked',
  blockedReason:reason,blockedBy:failed?key(failed):phases.length?'independent-phase-executor':'inventory-or-plan',
  elapsedMs:0,budgetMs:budget,code:null,signal:null,stoppedBecause:'not-started',monitorError:null}));
}
export function exactCoverage(inventory,plan,phases){
 assert.equal(plan.roots.length,inventory.roots.length);assert.deepEqual(plan.roots,inventory.roots);
 const expected=['producer','declarations','source-negative','declaration-negative',...plan.consumers.map(row=>'consumer-'+row.id)];
 assert.deepEqual(phases.map(row=>row.mode+(row.index===undefined?'':'-'+row.index)).sort(),expected.sort(),'Incomplete or duplicate phases');
 assert(phases.every(row=>row.complete===true),'Incomplete phase result');
 if(inventory.identity)assert(phases.every(row=>JSON.stringify(row.identity)===JSON.stringify(inventory.identity)),'Compiler/source/config identity changed between phases');
 const observed=new Set(phases.flatMap(row=>row.observedOriginalIds));
 assert(inventory.files.every(row=>observed.has(row.id)),'Original transitive source identity omitted');
 const assigned=[...plan.producerRoots,...plan.consumers.flatMap(row=>row.roots)];
 assert.equal(new Set(assigned).size,inventory.roots.length);assert.deepEqual(assigned.sort(),[...inventory.roots].sort(),'Original root owner omitted');
 return {orderedOriginalRoots:inventory.roots.length,originalResolvedFiles:inventory.files.length,originalResolvedObserved:observed.size,
  producerRoots:plan.producerRoots.length,consumerRoots:plan.consumers.reduce((sum,row)=>sum+row.roots.length,0),consumerPartitions:plan.consumers.length};
}
export async function experiment(traceOnly=false){
 assert.equal(typeof traceOnly,'boolean');
 const schedule=traceOnly?'selected-trace':'full',source=boundaryExecutionSource(schedule);
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.CI==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr','Managed diagnostic runner required');
 assert.equal(process.versions.node,'22.23.3');assert.equal(cpus().length,4);assert(totalmem()>=14*1024**3&&totalmem()<=18*1024**3);
 const cwd=realpathSync(process.cwd()),controller=realpathSync(fileURLToPath(new URL('../../../',import.meta.url)));
 const git=(path,...args)=>execFileSync('git',args,{cwd:path,encoding:'utf8',timeout:30000,maxBuffer:4*1024**2}).trim();
 assert.equal(git(cwd,'rev-parse','HEAD'),source);assert.equal(process.env.AIHR_CI_HEAD,source);assert.equal(git(cwd,'status','--porcelain'),'');
 assert.equal(git(controller,'rev-parse','HEAD'),process.env.AIHR_CI_CONTROL_HEAD);assert.equal(git(controller,'status','--porcelain'),'');
 const temp=realpathSync(process.env.RUNNER_TEMP),out=join(temp,'diagnostic-compiler-boundary');
 const free=()=>{const value=statfsSync(temp);return value.bavail*value.bsize;};assert(free()>=20*1024**3);mkdirSync(out,{mode:0o700});
 const report={kind:traceOnly?'DEVELOPMENT_SELECTED_CONSUMER_TRACE_NOT_RELEASE':'DEVELOPMENT_COMPILER_DECLARATION_BOUNDARY_NOT_RELEASE',source:source,controller:process.env.AIHR_CI_CONTROL_HEAD,
  runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,releaseAuthorized:false,ordinaryCompilerQualified:false,
  ...(traceOnly?{completeSuite:false,selectedConsumers:TRACED_CONSUMERS,coverageScope:'Diagnostic only: checked fresh producer/declarations and consumers7/8/9; earlier native results retain original identities'}:{}),
  complete:false,limits:BOUNDARY_LIMITS,phases:[],host:{node:process.version,cpus:cpus().length,ramBytes:totalmem()},
  controllerFiles:Object.fromEntries(['compiler-boundary.mjs','compiler-boundary-worker.mjs','compiler-boundary-policy.mjs',...(traceOnly?['compiler-consumer-trace.mjs']:[])].map(name=>[name,sha256(readFileSync(new URL(name,import.meta.url)))]))};
 const outputBytes=()=>{
  let total=0,files=0;const walk=path=>{for(const name of readdirSync(path)){const child=join(path,name),stat=lstatSync(child);assert(!stat.isSymbolicLink(),'Foreign diagnostic symlink');
   if(stat.isDirectory())walk(child);else{assert(stat.isFile());assert(stat.size<=BOUNDARY_LIMITS.fileBytes,'Diagnostic individual file bound exceeded');total+=stat.size;assert(++files<=50000);}}};walk(out);return total;
 };
 async function phase(mode,index){
  const budget=mode==='inventory'?BOUNDARY_LIMITS.inventoryMs:remainingCompilerMs(report.phases);assert(budget>0,'Aggregate720s compiler budget exhausted');
  const name=mode+(index===undefined?'':'-'+index),log=join(out,name+'.log'),fd=openSync(log,'wx',0o600),samples=openSync(join(out,name+'-samples.jsonl'),'wx',0o600);
  const row={mode,index,status:'running',budgetMs:budget,code:null,signal:null,stoppedBecause:null,monitorError:null,elapsedMs:0,sampledPeakRssKiB:0};report.phases.push(row);
  const start=Date.now(),worker=fileURLToPath(new URL('compiler-boundary-worker.mjs',import.meta.url));
  const child=spawn('/usr/bin/prlimit',['--core=0',`--fsize=${BOUNDARY_LIMITS.fileBytes}`,'--',process.execPath,...boundaryArguments(worker,out,mode,index,traceOnly)],{
   cwd,env:{...process.env,AIHR_COMPILER_BOUNDARY_SCHEDULE:schedule,NODE_OPTIONS:'--max-old-space-size=12288'},stdio:['ignore',fd,fd],detached:true});
  let timer,killer;
  const stop=reason=>{if(row.stoppedBecause)return;row.stoppedBecause=reason;if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}
   killer=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}},10000);};
  const sample=()=>{
   try{let status;try{status=readFileSync('/proc/'+child.pid+'/status','utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
    const rssKiB=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0),hwmKiB=Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]??0);
    row.sampledPeakRssKiB=Math.max(row.sampledPeakRssKiB,hwmKiB);const bytes=outputBytes(),freeBytes=free();
    writeFileSync(samples,JSON.stringify({elapsedMs:Date.now()-start,rssKiB,hwmKiB,outputBytes:bytes,freeBytes})+'\n');
    if(Date.now()-start>=budget)stop('aggregate-time-budget');else if(bytes>BOUNDARY_LIMITS.totalBytes)stop('diagnostic-output-cap');
    else if(lstatSync(log).size>BOUNDARY_LIMITS.logBytes)stop('diagnostic-log-cap');else if(freeBytes<2*1024**3)stop('free-space-floor');
   }catch(error){row.monitorError=String(error);stop('monitor-failure');}
  };
  try{timer=setInterval(sample,1000);sample();const exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}));});
   Object.assign(row,exit,{elapsedMs:Date.now()-start});
   const filename=mode==='inventory'?'inventory-phase.json':name+'.json',path=join(out,filename);
   if(existsSync(path))row.resultSha256=sha256(readFileSync(path)); // Retain actual failed diagnostic bytes too.
   assert(row.elapsedMs<=budget,'Aggregate phase time bound exceeded');validatePhase(row);assert(existsSync(path),'Native phase report missing');
   const value=JSON.parse(readFileSync(path,'utf8'));assert(value.complete===true&&value.releaseAuthorized===false);row.status='passed';
   // Full native resolutions/diagnostics stay on disk; do not retain every consumer graph beside the next compiler.
   return {mode:value.mode,index:value.index,complete:value.complete,identity:value.identity,observedOriginalIds:value.observedOriginalIds};
  }catch(error){row.status='failed';row.error=String(error);throw error;}
  finally{row.elapsedMs=Date.now()-start;clearInterval(timer);clearTimeout(killer);closeSync(fd);closeSync(samples);}
 }
 try{
  await phase('inventory');const inventory=JSON.parse(readFileSync(join(out,'inventory.json'),'utf8')),plan=JSON.parse(readFileSync(join(out,'plan.json'),'utf8'));
  if(traceOnly){
   assert.equal(sha256(readFileSync(join(out,'inventory.json'))),'803a319b3af6409a251a009fa2cf76f9fb0fa1a5f7fe758025bb4a5c9250a6a8','Original f2 native inventory changed');
   assert.equal(sha256(readFileSync(join(out,'plan.json'))),'33143b33eec77708f21da2eaa979a5df2aea68b74589e3b1f6274c6773de032e','Original400-root native plan changed');
  }
  report.plannedPhases=boundarySchedule(plan,traceOnly);
  if(traceOnly){const selected=new Set(report.plannedPhases.map(row=>row.mode+(row.index===undefined?'':'-'+row.index)));report.omittedPhases=boundarySchedule(plan).filter(row=>!selected.has(row.mode+(row.index===undefined?'':'-'+row.index))).map(row=>({...row,status:'omitted-diagnostic',notNewPass:true}));}
  report.inventorySha256=sha256(readFileSync(join(out,'inventory.json')));report.planSha256=sha256(readFileSync(join(out,'plan.json')));
  const results=[];results.push(await phase('producer'));results.push(await phase('declarations'));
  const independent=report.plannedPhases.slice(2);
  report.independentSchedule=independent;
  const outcome=await runIndependentPhases(independent,phase,()=>remainingCompilerMs(report.phases),row=>report.phases.push(row));
  results.push(...outcome.results);report.independentFailures=outcome.failures;
  assert(outcome.failures.length===0&&outcome.blocked.length===0,'Independent compiler controls/consumers failed or were blocked; all actual outcomes retained');
  if(traceOnly){
   assert.deepEqual(results.map(row=>row.mode+(row.index===undefined?'':'-'+row.index)),report.plannedPhases.map(row=>row.mode+(row.index===undefined?'':'-'+row.index)));
   assert(results.every(row=>row.complete===true&&JSON.stringify(row.identity)===JSON.stringify(inventory.identity)),'Incomplete or foreign selected phase');
   report.coverage={completeSuite:false,allOriginalInventoryRoots:inventory.roots.length,allOriginalResolvedFiles:inventory.files.length,selectedConsumerRoots:plan.consumers.filter(row=>TRACED_CONSUMERS.includes(row.id)).reduce((n,row)=>n+row.roots.length,0)};
  }else report.coverage=exactCoverage(inventory,plan,results);
  assert(remainingCompilerMs(report.phases)>0,'Compiler aggregate budget exhausted');
  assert(outputBytes()<=BOUNDARY_LIMITS.totalBytes);report.complete=true;
 }catch(error){report.error=String(error);throw error;}
 finally{
  // A failed prerequisite prevents trustworthy dependent work. Record every
  // known planned phase that did not start instead of inventing empty passes.
  const planned=report.plannedPhases??(traceOnly?[{mode:'producer'},{mode:'declarations'},...TRACED_CONSUMERS.map(index=>({mode:'consumer',index}))]:['producer','declarations','source-negative','declaration-negative'].map(mode=>({mode})));
  report.phases.push(...blockedUnstartedPhases(planned,report.phases,remainingCompilerMs(report.phases)));
  if(!report.plannedPhases)report.consumerPlanUnavailable={status:'blocked',blockedReason:'inventory-or-plan-failure',consumersKnown:false};
  report.sourceRestored=git(cwd,'rev-parse','HEAD')===source&&git(cwd,'status','--porcelain')==='';
  report.controllerRestored=git(controller,'rev-parse','HEAD')===process.env.AIHR_CI_CONTROL_HEAD&&git(controller,'status','--porcelain')==='';
  if(!report.sourceRestored||!report.controllerRestored)report.complete=false;
  report.compilerElapsedMs=report.phases.filter(row=>row.mode!=='inventory').reduce((sum,row)=>sum+row.elapsedMs,0);
  writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  assert(report.sourceRestored&&report.controllerRestored,'Diagnostic modified frozen checkouts');
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--selection'){const inputs=JSON.parse(process.env.AIHR_COMPILER_BOUNDARY_INPUTS);(inputs.installer_fixture_phase===CONSUMER_TRACE_INTENT?admitConsumerTraceInputs:admitBoundaryInputs)(inputs);}
 else{assert(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--trace-consumers');experiment(process.argv[2]==='--trace-consumers').then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});}
}
