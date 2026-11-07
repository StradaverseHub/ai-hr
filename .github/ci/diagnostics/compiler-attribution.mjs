/** Whole-project attribution only. No compiler cache, test receipt or release authority. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openSync,closeSync,readSync,readFileSync,writeFileSync,mkdirSync,lstatSync,readdirSync,statfsSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {fileURLToPath} from 'node:url';

export const ATTRIBUTION_SOURCE='fe26d003b9750478e4d434cc9dd22b59092ae830';
const GiB=1024**3,FILE_CAP=512*1024**2,TOTAL_CAP=GiB,MIN_FREE=20*GiB;
const hash=value=>createHash('sha256').update(value).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:4*1024**2}).trim();
const freeBytes=path=>{const s=statfsSync(path);return s.bavail*s.bsize;};

export function validateAttributionSelection(inputs){
 assert.equal(inputs.compiler_probe,true);assert.equal(inputs.expected_sha,ATTRIBUTION_SOURCE);
 for(const [key,value] of Object.entries(inputs))if(typeof value==='boolean'&&key!=='compiler_probe')assert.equal(value,false,'Attribution must run without other diagnostic jobs');
 assert.equal(inputs.next_build_cache_phase,'disabled');
 // GitHub omits unspecified empty string inputs from toJSON(inputs). Missing
 // and literal empty are the only non-transport states; null is not absence.
 for(const key of ['transport_origin_run','transport_origin_sha','transport_origin_artifact','transport_origin_digest','compiler_origin_run','compiler_origin_sha','compiler_origin_artifact','compiler_origin_digest'])assert(inputs[key]===undefined||inputs[key]==='','No compiler/build transport is part of attribution');
}
export function compilerArguments(cwd,out,inventory=false){
 const args=[join(cwd,'node_modules/typescript/lib/tsc.js'),'--noEmit','--pretty','false','--tsBuildInfoFile',join(out,inventory?'inventory.tsbuildinfo':'whole-project.tsbuildinfo')];
 return inventory?[...args,'--listFilesOnly']:[...args,'--extendedDiagnostics','--generateTrace',join(out,'trace')];
}
/** A crashed compiler leaves a deliberately incomplete JSON array. Read only complete tail events. */
export function lastCheckedSource(tail){
 let found=null;
 for(const line of tail.split('\n')){
  try{const row=JSON.parse(line.replace(/^,/,''));if(row.name==='checkSourceFile'&&row.ph==='B'&&typeof row.args?.path==='string')found=row.args.path;}catch{}
 }
 return found;
}
export function actualCompilerResult(result,log){
 const files=Number(log.match(/^Files:\s+(\d+)\s*$/m)?.[1]);
 return {...result,files:Number.isSafeInteger(files)&&files>0?files:null,
  compilerCompleted:result.code===0&&result.signal===null&&!result.stoppedBecause&&Number.isSafeInteger(files)&&files>0&&!/\berror TS\d+:/.test(log),
  v8HeapFailure:/FATAL ERROR:.*(?:heap|Allocation failed)/i.test(log)};
}
function outputBytes(out){
 let bytes=0;
 for(const name of readdirSync(out)){
  const path=join(out,name),s=lstatSync(path);assert(!s.isSymbolicLink(),'Diagnostic output must not follow symlinks');
  if(s.isDirectory()){assert.equal(name,'trace');for(const child of readdirSync(path)){const t=lstatSync(join(path,child));assert(t.isFile()&&!t.isSymbolicLink());bytes+=t.size;}}
  else{assert(s.isFile());bytes+=s.size;}
 }
 return bytes;
}
function traceTail(path){
 let fd;
 try{const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink());const size=Math.min(s.size,128*1024),buf=Buffer.alloc(size);fd=openSync(path,'r');
  // readFileSync would copy an unbounded, actively growing compiler trace.
  readSync(fd,buf,0,size,s.size-size);return buf.toString('utf8');
 }catch(error){if(error.code==='ENOENT')return '';throw error;}finally{if(fd!==undefined)closeSync(fd);}
}
// Kept separate from the compiler process: monitoring must not retain its TypeScript object graph.
async function runCompiler(cwd,out,inventory,report){
 const name=inventory?'inventory':'compiler',logPath=join(out,name+'.log'),fd=openSync(logPath,'wx',0o600);
 const started=Date.now(),row={name,args:compilerArguments(cwd,out,inventory),code:null,signal:null,stoppedBecause:null};
 report.phases.push(row);
 const child=spawn('/usr/bin/prlimit',['--core=0',`--fsize=${FILE_CAP}`,'--',process.execPath,...row.args],{
  cwd,env:{...process.env,NODE_OPTIONS:'--max-old-space-size=12288'},stdio:['ignore',fd,fd],detached:true,
 });
 const samplesPath=join(out,name+'-samples.jsonl'),samples=openSync(samplesPath,'wx',0o600);
 let lastSource=null,timer,killTimer,monitorError=null,sampledPeakRssKiB=0;
 const stop=reason=>{
  if(row.stoppedBecause)return;row.stoppedBecause=reason;
  if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}
  killTimer=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}},10000);
 };
 const sample=()=>{
  try{
   if(!child.pid)return;
   let status;try{status=readFileSync(`/proc/${child.pid}/status`,'utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
   const rssKiB=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0),hwmKiB=Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]??0);
   sampledPeakRssKiB=Math.max(sampledPeakRssKiB,hwmKiB);
   const current=lastCheckedSource(traceTail(join(out,'trace/trace.json')));if(current)lastSource=current;
   const bytes=outputBytes(out),availableBytes=freeBytes(out);
   writeFileSync(samples,JSON.stringify({elapsedMs:Date.now()-started,rssKiB,hwmKiB,lastSource,outputBytes:bytes,freeBytes:availableBytes})+'\n');
   if(lstatSync(logPath).size>16*1024**2)stop('diagnostic-log-cap');else if(bytes>TOTAL_CAP)stop('diagnostic-output-cap');else if(availableBytes<2*GiB)stop('diagnostic-free-space-floor');
   else if(Date.now()-started>(inventory?120000:720000))stop('diagnostic-timeout');
  }catch(error){monitorError=String(error);stop('diagnostic-monitor-failure');}
 };
 try{
  timer=setInterval(sample,1000);sample();
  const exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});
  Object.assign(row,exit,{elapsedMs:Date.now()-started,sampledPeakRssKiB,lastCheckedSource:lastSource,monitorError});
 }finally{clearInterval(timer);clearTimeout(killTimer);closeSync(samples);closeSync(fd);}
 if(inventory){assert.equal(row.code,0,'Full compiler inventory failed');assert.equal(row.signal,null);assert.equal(row.stoppedBecause,null);
  const log=readFileSync(logPath,'utf8');assert(!/\berror TS\d+:/.test(log));const files=log.trim().split('\n');assert(files.length>0&&files.every(path=>path.startsWith(cwd+'/')),'Unexpected compiler inventory');
  row.files=files.length;row.inventorySha256=hash(log);return row;
 }
 Object.assign(row,actualCompilerResult(row,readFileSync(logPath,'utf8')));return row;
}
export async function attributeCompiler(){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.CI==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr','Managed company runner required');
 const cwd=realpathSync(process.cwd()),controller=fileURLToPath(new URL('../../../',import.meta.url));
 assert.equal(git(cwd,'rev-parse','HEAD'),ATTRIBUTION_SOURCE);assert.equal(process.env.AIHR_CI_HEAD,ATTRIBUTION_SOURCE);assert.equal(git(cwd,'status','--porcelain'),'');
 assert.equal(git(controller,'rev-parse','HEAD'),process.env.AIHR_CI_CONTROL_HEAD);assert.equal(git(controller,'status','--porcelain'),'');
 assert.equal(process.versions.node,'22.23.3');assert.equal(JSON.parse(readFileSync(join(cwd,'node_modules/typescript/package.json'),'utf8')).version,'5.9.3');
 assert.equal(cpus().length,4);assert(totalmem()>=14*GiB&&totalmem()<=18*GiB,'Standard runner memory expected');
 const temp=realpathSync(process.env.RUNNER_TEMP),out=join(temp,'diagnostic-compiler-attribution');
 assert(freeBytes(temp)>=MIN_FREE,'Need20GiB free before creating owned compiler diagnostics');mkdirSync(out,{mode:0o700});
 const report={kind:'WHOLE_COMPILER_ATTRIBUTION_NOT_RELEASE_EVIDENCE',source:ATTRIBUTION_SOURCE,controller:process.env.AIHR_CI_CONTROL_HEAD,
  runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,releaseAuthorized:false,heapMiB:12288,
  node:process.versions.node,typescript:'5.9.3',cpus:cpus().length,ramBytes:totalmem(),freeBytesBefore:freeBytes(out),
  limits:{perFileBytes:FILE_CAP,totalObservedBytes:TOTAL_CAP,observedLogBytes:16*1024**2,compileMs:720000,inventoryMs:120000,sampleMs:1000},
  tsconfigSha256:hash(readFileSync(join(cwd,'tsconfig.json'))),lockSha256:hash(readFileSync(join(cwd,'pnpm-lock.yaml'))),
  compilerSha256:hash(readFileSync(join(cwd,'node_modules/typescript/lib/_tsc.js'))),phases:[],complete:false,compilerSucceeded:false,
  caveat:'Trace instrumentation can change timing and memory. An incomplete trace or diagnostic failure never becomes compiler PASS. RSS is sampled; source remains the complete original project.'};
 try{
  const inventory=await runCompiler(cwd,out,true,report),compiler=await runCompiler(cwd,out,false,report);
  if(compiler.compilerCompleted)assert.equal(compiler.files,inventory.files,'Compiler inventory changed or roots were omitted');
  report.complete=true;report.compilerSucceeded=compiler.compilerCompleted;
 }catch(error){report.error=String(error);throw error;}
 finally{
  for(const name of ['inventory.tsbuildinfo','whole-project.tsbuildinfo'])rmSync(join(out,name),{force:true});
  report.sourceRestored=git(cwd,'rev-parse','HEAD')===ATTRIBUTION_SOURCE&&git(cwd,'status','--porcelain')==='';
  report.controllerRestored=git(controller,'rev-parse','HEAD')===process.env.AIHR_CI_CONTROL_HEAD&&git(controller,'status','--porcelain')==='';
  report.freeBytesAfter=freeBytes(out);report.endedAt=new Date().toISOString();writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 assert(report.sourceRestored&&report.controllerRestored,'Diagnostic modified source/controller');
 assert(report.phases[1]?.compilerCompleted,'Original whole compiler did not complete successfully; diagnostic retained its failure');
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--selection')validateAttributionSelection(JSON.parse(process.env.AIHR_COMPILER_ATTRIBUTION_INPUTS));
 else{assert.equal(process.argv.length,2);attributeCompiler().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});}
}
