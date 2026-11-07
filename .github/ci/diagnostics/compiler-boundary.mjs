/** Sequential standard-runner experiment. Ordinary compiler and release witnesses are untouched. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,openSync,closeSync,mkdirSync,lstatSync,readdirSync,statfsSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus,totalmem} from 'node:os';
import {BOUNDARY_SOURCE,BOUNDARY_LIMITS,sha256,admitBoundaryInputs,remainingCompilerMs} from './compiler-boundary-policy.mjs';

export function boundaryArguments(worker,out,mode,index){return [worker,mode,out,...(index===undefined?[]:[String(index)])];}
export function validatePhase(result){assert(result.code===0&&result.signal===null&&result.stoppedBecause===null&&!result.monitorError,'Native diagnostic phase failed');}
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
export async function experiment(){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.CI==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr','Managed diagnostic runner required');
 assert.equal(process.versions.node,'22.23.3');assert.equal(cpus().length,4);assert(totalmem()>=14*1024**3&&totalmem()<=18*1024**3);
 const cwd=realpathSync(process.cwd()),controller=realpathSync(fileURLToPath(new URL('../../../',import.meta.url)));
 const git=(path,...args)=>execFileSync('git',args,{cwd:path,encoding:'utf8',timeout:30000,maxBuffer:4*1024**2}).trim();
 assert.equal(git(cwd,'rev-parse','HEAD'),BOUNDARY_SOURCE);assert.equal(process.env.AIHR_CI_HEAD,BOUNDARY_SOURCE);assert.equal(git(cwd,'status','--porcelain'),'');
 assert.equal(git(controller,'rev-parse','HEAD'),process.env.AIHR_CI_CONTROL_HEAD);assert.equal(git(controller,'status','--porcelain'),'');
 const temp=realpathSync(process.env.RUNNER_TEMP),out=join(temp,'diagnostic-compiler-boundary');
 const free=()=>{const value=statfsSync(temp);return value.bavail*value.bsize;};assert(free()>=20*1024**3);mkdirSync(out,{mode:0o700});
 const report={kind:'DEVELOPMENT_COMPILER_DECLARATION_BOUNDARY_NOT_RELEASE',source:BOUNDARY_SOURCE,controller:process.env.AIHR_CI_CONTROL_HEAD,
  runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,releaseAuthorized:false,ordinaryCompilerQualified:false,
  complete:false,limits:BOUNDARY_LIMITS,phases:[],host:{node:process.version,cpus:cpus().length,ramBytes:totalmem()},
  controllerFiles:Object.fromEntries(['compiler-boundary.mjs','compiler-boundary-worker.mjs','compiler-boundary-policy.mjs'].map(name=>[name,sha256(readFileSync(new URL(name,import.meta.url)))]))};
 const outputBytes=()=>{
  let total=0,files=0;const walk=path=>{for(const name of readdirSync(path)){const child=join(path,name),stat=lstatSync(child);assert(!stat.isSymbolicLink(),'Foreign diagnostic symlink');
   if(stat.isDirectory())walk(child);else{assert(stat.isFile());assert(stat.size<=BOUNDARY_LIMITS.fileBytes,'Diagnostic individual file bound exceeded');total+=stat.size;assert(++files<=50000);}}};walk(out);return total;
 };
 async function phase(mode,index){
  const budget=mode==='inventory'?BOUNDARY_LIMITS.inventoryMs:remainingCompilerMs(report.phases);assert(budget>0,'Aggregate720s compiler budget exhausted');
  const name=mode+(index===undefined?'':'-'+index),log=join(out,name+'.log'),fd=openSync(log,'wx',0o600),samples=openSync(join(out,name+'-samples.jsonl'),'wx',0o600);
  const row={mode,index,budgetMs:budget,code:null,signal:null,stoppedBecause:null,monitorError:null,elapsedMs:0,sampledPeakRssKiB:0};report.phases.push(row);
  const start=Date.now(),worker=fileURLToPath(new URL('compiler-boundary-worker.mjs',import.meta.url));
  const child=spawn('/usr/bin/prlimit',['--core=0',`--fsize=${BOUNDARY_LIMITS.fileBytes}`,'--',process.execPath,...boundaryArguments(worker,out,mode,index)],{
   cwd,env:{...process.env,NODE_OPTIONS:'--max-old-space-size=12288'},stdio:['ignore',fd,fd],detached:true});
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
   Object.assign(row,exit,{elapsedMs:Date.now()-start});assert(row.elapsedMs<=budget,'Aggregate phase time bound exceeded');validatePhase(row);
   const filename=mode==='inventory'?'inventory-phase.json':name+'.json',path=join(out,filename);assert(existsSync(path),'Native phase report missing');
   const value=JSON.parse(readFileSync(path,'utf8'));assert(value.complete===true&&value.releaseAuthorized===false);row.resultSha256=sha256(readFileSync(path));
   // Full native resolutions/diagnostics stay on disk; do not retain every consumer graph beside the next compiler.
   return {mode:value.mode,index:value.index,complete:value.complete,identity:value.identity,observedOriginalIds:value.observedOriginalIds};
  }finally{row.elapsedMs=Date.now()-start;clearInterval(timer);clearTimeout(killer);closeSync(fd);closeSync(samples);}
 }
 try{
  await phase('inventory');const inventory=JSON.parse(readFileSync(join(out,'inventory.json'),'utf8')),plan=JSON.parse(readFileSync(join(out,'plan.json'),'utf8'));
  report.inventorySha256=sha256(readFileSync(join(out,'inventory.json')));report.planSha256=sha256(readFileSync(join(out,'plan.json')));
  const results=[];results.push(await phase('producer'));results.push(await phase('declarations'));
  results.push(await phase('source-negative'));results.push(await phase('declaration-negative'));
  for(const batch of plan.consumers)results.push(await phase('consumer',batch.id));
  report.coverage=exactCoverage(inventory,plan,results);assert(remainingCompilerMs(report.phases)>0,'Compiler aggregate budget exhausted');
  assert(outputBytes()<=BOUNDARY_LIMITS.totalBytes);report.complete=true;
 }catch(error){report.error=String(error);throw error;}
 finally{
  report.sourceRestored=git(cwd,'rev-parse','HEAD')===BOUNDARY_SOURCE&&git(cwd,'status','--porcelain')==='';
  report.controllerRestored=git(controller,'rev-parse','HEAD')===process.env.AIHR_CI_CONTROL_HEAD&&git(controller,'status','--porcelain')==='';
  if(!report.sourceRestored||!report.controllerRestored)report.complete=false;
  report.compilerElapsedMs=report.phases.filter(row=>row.mode!=='inventory').reduce((sum,row)=>sum+row.elapsedMs,0);
  writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  assert(report.sourceRestored&&report.controllerRestored,'Diagnostic modified frozen checkouts');
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--selection')admitBoundaryInputs(JSON.parse(process.env.AIHR_COMPILER_BOUNDARY_INPUTS));
 else{assert.equal(process.argv.length,2);experiment().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});}
}
