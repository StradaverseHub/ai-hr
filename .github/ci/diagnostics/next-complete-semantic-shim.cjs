/** Diagnostic-only compiler path for the unchanged installed Next CLI owner. */
'use strict';
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {constants}=require('node:os');
const ORIGIN='34fe96c83a15591b8868dfddf5237533d479a0b6';
const TSC_SHA='2cffde0b8c6760dfb0b5b0382bbb7e00ba6a8b2d981b9205b256a700a481d983';
const WORKFLOW='StradaverseHub/ai-hr/.github/workflows/next-complete-semantic-profile.yml@refs/heads/codex/resignation-next-complete-profile-20261118';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const put=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
function proc(pid){
 const value=fs.readFileSync('/proc/'+pid+'/stat','utf8');
 const fields=value.slice(value.lastIndexOf(')')+2).trim().split(/\s+/);
 return {pid:Number(pid),parentPid:Number(fields[1]),pgid:Number(fields[2]),starttime:fields[19]};
}
function validateOriginalArgs(args,{source,out}){
 assert(Array.isArray(args)&&args.every(value=>typeof value==='string'),'Invalid compiler argv');
 assert(path.isAbsolute(source)&&path.resolve(source)===source&&path.isAbsolute(out)&&path.resolve(out)===out,'Absolute canonical scope required');
 const config=path.join(source,'tsconfig.build.json');
 const show=['--showConfig','--project',config,'--pretty','false'];
 const semantic=['--project',config,'--noEmit','--declarationMap','false','--emitDeclarationOnly','false','--tsBuildInfoFile',path.join(source,'.next/cache/.tsbuildinfo')];
 if(JSON.stringify(args)===JSON.stringify(show))return {mode:'showConfig',actualArgs:args.slice()};
 assert.deepStrictEqual(args,semantic,'Only the exact original Next semantic argv is admitted');
 return {mode:'semantic',actualArgs:[...args,'--generateTrace',path.join(out,'trace'),'--extendedDiagnostics','--pretty','false']};
}
module.exports={validateOriginalArgs};

async function main(){
 const env=process.env;
 assert(process.platform==='linux'&&process.versions.node==='20.20.2','Pinned Linux Node runtime required');
 assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted','Hosted diagnostic only');
 assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856','Repository binding refused');
 assert(env.GITHUB_WORKFLOW_REF===WORKFLOW&&env.GITHUB_WORKFLOW==='next-complete-semantic-profile'&&env.GITHUB_JOB==='profile','Workflow binding refused');
 assert(env.AIHR_DIAG_SOURCE_SHA===ORIGIN&&/^[a-f0-9]{40}$/.test(env.AIHR_DIAG_CONTROLLER_SHA??''),'Source/controller binding refused');
 assert(env.GITHUB_SHA===env.AIHR_DIAG_CONTROLLER_SHA&&env.AIHR_CI_CONTROL_HEAD===env.GITHUB_SHA,'Controller identity refused');
 assert(env.NODE_OPTIONS==='--max-old-space-size=12288','Only existing whole-compiler diagnostic heap is admitted');
 const source=fs.realpathSync(process.cwd()),controller=fs.realpathSync(path.resolve(__dirname,'../../..'));
 assert(source===path.join(fs.realpathSync(env.GITHUB_WORKSPACE),'source')&&controller===path.join(fs.realpathSync(env.GITHUB_WORKSPACE),'automation'),'Checkout scope refused');
 const git=(dir,...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',timeout:10000,maxBuffer:1024**2}).trim();
 assert(git(source,'rev-parse','HEAD')===ORIGIN&&git(controller,'rev-parse','HEAD')===env.AIHR_DIAG_CONTROLLER_SHA,'Checkout revision refused');
 const out=fs.realpathSync(env.AIHR_DIAG_OUT);
 assert(out===path.join(fs.realpathSync(env.RUNNER_TEMP),'next-complete-semantic-profile-34fe'),'Output scope refused');
 assert((fs.statSync(out).mode&0o077)===0,'Private diagnostic output required');
 const localRequire=createRequire(path.join(source,'package.json'));
 assert(localRequire('typescript/package.json').version==='5.9.3'&&localRequire('next/package.json').version==='16.4.1','Installed compiler/framework refused');
 const realTsc=fs.realpathSync(localRequire.resolve('typescript/lib/tsc.js'));
 assert(fs.realpathSync(env.AIHR_DIAG_REAL_TSC)===realTsc&&hash(fs.readFileSync(realTsc))===TSC_SHA,'Real compiler identity refused');
 assert(/^\d+$/.test(env.AIHR_DIAG_DRIVER_PID??'')&&/^\d+$/.test(env.AIHR_DIAG_DRIVER_STARTTIME??''),'Driver identity missing');
 const self=proc(process.pid),driver=proc(Number(env.AIHR_DIAG_DRIVER_PID));
 assert(self.pgid===process.pid&&self.parentPid===driver.pid&&driver.starttime===env.AIHR_DIAG_DRIVER_STARTTIME,'Owned Next process group refused');
 const {mode,actualArgs}=validateOriginalArgs(process.argv.slice(2),{source,out});
 const identity={mode,role:'shim-'+mode,cleanupGroup:true,source:ORIGIN,controller:env.AIHR_DIAG_CONTROLLER_SHA,run:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,
  pid:self.pid,pgid:self.pgid,starttime:self.starttime,parentPid:self.parentPid,driverPid:driver.pid,driverStarttime:driver.starttime};
 put(path.join(out,'shim-'+mode+'-identity.json'),identity);
 put(path.join(out,'shim-'+mode+'-invocation.json'),{...identity,originalArgs:process.argv.slice(2),actualArgs,realTsc,realTscSha256:TSC_SHA,
  runtime:{node:process.versions.node,next:'16.4.1',typescript:'5.9.3'},releaseEligible:false});
 const stdoutLog='shim-'+mode+'.stdout.log',stderrLog='shim-'+mode+'.stderr.log';
 const stdoutFd=fs.openSync(path.join(out,stdoutLog),'wx',0o600),stderrFd=fs.openSync(path.join(out,stderrLog),'wx',0o600);
 const started=Date.now();let child,childIdentity,peakObservedRssKiB=0,minMemAvailableKiB=null,monitor,fallback;
 const signals=['SIGINT','SIGTERM','SIGHUP'];
 const ownedChild=()=>{try{return childIdentity&&proc(childIdentity.pid).starttime===childIdentity.starttime;}catch{return false;}};
 const forward=signal=>{
  if(ownedChild())try{process.kill(childIdentity.pid,signal);}catch{}
  if(!fallback)fallback=setTimeout(()=>{if(ownedChild())try{process.kill(childIdentity.pid,'SIGKILL');}catch{}},5000);
 };
 const signalHandlers=signals.map(signal=>[signal,()=>forward(signal)]);
 try{
  // Next owns this detached shim group; the real compiler stays inside that group.
  child=spawn(process.execPath,[realTsc,...actualArgs],{cwd:source,env:{...env},detached:false,stdio:['ignore','pipe','pipe']});
  if(child.pid){
   const observed=proc(child.pid);
   assert(observed.pgid===self.pgid&&observed.parentPid===self.pid,'Real compiler escaped its owned group');
   childIdentity={...identity,role:'compiler-'+mode,pid:observed.pid,pgid:observed.pgid,starttime:observed.starttime,parentPid:observed.parentPid,shimPid:self.pid,shimStarttime:self.starttime};
   put(path.join(out,'shim-'+mode+'-compiler-identity.json'),childIdentity);
  }
  const tee=(readable,fd,destination)=>readable.on('data',chunk=>{
   fs.writeSync(fd,chunk);
   if(!destination.write(chunk)){readable.pause();destination.once('drain',()=>readable.resume());}
  });
  tee(child.stdout,stdoutFd,process.stdout);tee(child.stderr,stderrFd,process.stderr);
  const measure=()=>{try{
   if(ownedChild()){
    const status=fs.readFileSync('/proc/'+childIdentity.pid+'/status','utf8'),rss=/^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    if(rss)peakObservedRssKiB=Math.max(peakObservedRssKiB,Number(rss[1]));
   }
   const available=/^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo','utf8'));
   if(available)minMemAvailableKiB=Math.min(minMemAvailableKiB??Infinity,Number(available[1]));
  }catch{}};
  measure();monitor=setInterval(measure,200);
  for(const [signal,handler] of signalHandlers)process.on(signal,handler);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
  measure();
  put(path.join(out,'shim-'+mode+'-outcome.json'),{...identity,compilerPid:childIdentity?.pid??null,compilerStarttime:childIdentity?.starttime??null,
   ...result,elapsedMs:Date.now()-started,peakObservedRssKiB,minMemAvailableKiB,stdoutLog,stderrLog,releaseEligible:false});
  if(mode==='showConfig'&&result.exitCode===0&&result.signal===null){
   const stdoutPath=path.join(out,stdoutLog),rootsPath=path.join(out,'original-effective-roots.json');
   assert(fs.statSync(stdoutPath).size<=32*1024**2&&fs.statSync(rootsPath).size<=32*1024**2,'Configuration metadata bound refused');
   const actual=JSON.parse(fs.readFileSync(stdoutPath,'utf8')),baseline=JSON.parse(fs.readFileSync(rootsPath,'utf8'));
   assert(Array.isArray(actual.files)&&Array.isArray(baseline),'Complete original root lists required');
   const normalize=rows=>rows.map(value=>{assert(typeof value==='string');return path.resolve(source,value);}).sort();
   const observedRoots=normalize(actual.files),originalRoots=normalize(baseline);
   assert(new Set(observedRoots).size===observedRoots.length&&new Set(originalRoots).size===originalRoots.length,'Duplicate root identity refused');
   assert.deepStrictEqual(observedRoots,originalRoots,'Actual Next CLI changed original program roots');
   assert(actual.compilerOptions?.strict===true&&actual.compilerOptions.noEmit===true&&actual.compilerOptions.noCheck!==true,'Original strict semantic checking required');
   put(path.join(out,'shim-showConfig-scope-proof.json'),{...identity,originalRootCount:originalRoots.length,actualRootCount:observedRoots.length,
    originalRootsSha256:hash(fs.readFileSync(rootsPath)),actualShowConfigSha256:hash(fs.readFileSync(stdoutPath)),sameNormalizedRoots:true,strict:true,noEmit:true,noCheck:false,releaseEligible:false});
  }
  process.exitCode=result.exitCode??128+(constants.signals[result.signal]??1);
 }finally{
  if(monitor)clearInterval(monitor);if(fallback)clearTimeout(fallback);
  for(const [signal,handler] of signalHandlers)process.removeListener(signal,handler);
  if(ownedChild()){
   try{process.kill(childIdentity.pid,'SIGTERM');}catch{}
   await new Promise(done=>setTimeout(done,5000));
   if(ownedChild())try{process.kill(childIdentity.pid,'SIGKILL');}catch{}
  }
  fs.closeSync(stdoutFd);fs.closeSync(stderrFd);
 }
}
if(require.main===module)main().catch(error=>{console.error('Diagnostic compiler shim refused: '+String(error.message));process.exitCode=2;});
