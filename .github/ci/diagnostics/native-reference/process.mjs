/** Direct child handles only. External shared kernel owns the complete family. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {REFERENCE_LIMITS} from './graph.mjs';
const nativeRuntime={spawn,now:()=>performance.now(),identity:pid=>{const value=readFileSync('/proc/'+pid+'/stat','utf8');return value.slice(value.lastIndexOf(')')+2).split(/\s+/)[19];},status:pid=>readFileSync('/proc/'+pid+'/status','utf8'),
 write:(path,raw)=>writeFileSync(path,raw,{flag:'wx',mode:0o600}),
 after:(work,ms)=>setTimeout(work,ms),cancel:timer=>clearTimeout(timer),
 every:(work,ms)=>setInterval(work,ms),cancelEvery:timer=>clearInterval(timer)};
/** Explicit source-model seam; the real owner closes over the native runtime. */
export function createNativeReferenceProcess(runtime){
 return function owned(arguments_,{cwd,env,deadline,log,checkBudget,signal}){
  signal?.throwIfAborted();const started=runtime.now();assert(deadline-started>2000,'Aggregate native compiler budget exhausted');
  return new Promise(resolve=>{
   const failures=[],output=[];let bytes=0,stoppedBecause=null,exited=false,closed=false,killTimer,drainTimer,peakRss=0,nativeStart;
   const child=runtime.spawn(process.execPath,['--max-old-space-size='+REFERENCE_LIMITS.heapMiB,...arguments_],{cwd,env,stdio:['ignore','pipe','pipe']});
   const remember=value=>{if(!failures.includes(value))failures.push(value);};
   const closePipes=()=>{for(const stream of [child.stdout,child.stderr])try{stream?.destroy();}catch(error){remember(error);}};
   const stop=reason=>{
    stoppedBecause??=reason;if(closed)return;
    if(exited){closePipes();return;}
    try{child.kill('SIGTERM');}catch(error){remember(error);}
    killTimer??=runtime.after(()=>{if(!exited&&!closed)try{child.kill('SIGKILL');}catch(error){remember(error);}},1000);
   };
   const abort=()=>{remember(signal.reason);stop('owner-aborted');};
   // EXIT ends numeric-PID observation; CLOSE independently owns pipe drain.
   let timer,sample;
   child.once('exit',()=>{
    exited=true;if(sample!==undefined)runtime.cancelEvery(sample);if(killTimer!==undefined)runtime.cancel(killTimer);
    drainTimer=runtime.after(()=>{if(!closed){stoppedBecause??='pipe-drain-budget';closePipes();}},
     Math.max(0,Math.min(1000,deadline-runtime.now())));
   });
   child.once('error',remember);
   child.once('close',(code,childSignal)=>{
    closed=true;if(timer!==undefined)runtime.cancel(timer);if(killTimer!==undefined)runtime.cancel(killTimer);
    if(drainTimer!==undefined)runtime.cancel(drainTimer);if(sample!==undefined)runtime.cancelEvery(sample);
    signal?.removeEventListener('abort',abort);
    const raw=Buffer.concat(output);try{runtime.write(log,raw);}catch(error){remember(error);}
    if(runtime.now()>deadline)stoppedBecause??='aggregate-budget';
    const error=failures[0];
    resolve({code,signal:childSignal,stoppedBecause,error:error?{name:error.name,code:error.code??null,count:failures.length,
     causes:failures.map(value=>({name:value?.name??'UnknownFailure',code:value?.code??null}))}:null,
     elapsedMs:runtime.now()-started,peakRss,log,logBytes:raw.length});
   });
   for(const stream of [child.stdout,child.stderr]){
    if(!stream){remember(Error('Owned native child pipe absent'));stop('pipe-unavailable');continue;}
    stream.on('error',error=>{remember(error);stop('pipe-failed');});
    stream.on('data',chunk=>{bytes+=chunk.length;if(bytes<=REFERENCE_LIMITS.logBytes)output.push(chunk);else stop('output-budget');});
   }
   if(Number.isSafeInteger(child.pid)&&child.pid>1)try{nativeStart=runtime.identity(child.pid);assert(typeof nativeStart==='string'&&/^[0-9]+(?![\s\S])/.test(nativeStart));}catch(error){remember(error);stop('native-identity-unavailable');}
   timer=runtime.after(()=>stop('aggregate-budget'),Math.max(1,deadline-runtime.now()-2000));
   sample=runtime.every(()=>{
    if(exited||closed)return;
    try{if(nativeStart!==undefined&&runtime.identity(child.pid)===nativeStart){const text=runtime.status(child.pid),rss=/^VmRSS:\s+([0-9]+) kB$/m.exec(text);if(rss&&runtime.identity(child.pid)===nativeStart)peakRss=Math.max(peakRss,Number(rss[1])*1024);}}catch{}
    try{checkBudget?.();}catch(error){remember(error);stop('artifact-budget');}
   },100);
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
 };
}
const owned=createNativeReferenceProcess(nativeRuntime);
export function nativeReferenceProcess(arguments_,options){return owned(arguments_,options);}
export function requireNativeSuccess(result){assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(result.stoppedBecause,null);assert.equal(result.error,null);}
