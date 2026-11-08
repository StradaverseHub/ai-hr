/** One owned native child at a time. Mandatory close/reap before return. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {REFERENCE_LIMITS} from './graph.mjs';
export function nativeReferenceProcess(arguments_,{cwd,env,deadline,log,checkBudget}){
 const started=performance.now();assert(deadline-started>2000,'Aggregate native compiler budget exhausted');
 return new Promise((resolve,reject)=>{
  let bytes=0,output=[],error=null,stoppedBecause=null,killTimer,peakRss=0;
  const child=spawn(process.execPath,['--max-old-space-size='+REFERENCE_LIMITS.heapMiB,...arguments_],{cwd,env,stdio:['ignore','pipe','pipe']});
  const stop=reason=>{stoppedBecause??=reason;child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1000);};
  // Timer includes startup/compilation and leaves native reap inside720s.
  const timer=setTimeout(()=>stop('aggregate-budget'),Math.max(1,deadline-performance.now()-2000));
  const sample=setInterval(()=>{try{const text=readFileSync('/proc/'+child.pid+'/status','utf8'),rss=/^VmRSS:\s+([0-9]+) kB$/m.exec(text);if(rss)peakRss=Math.max(peakRss,Number(rss[1])*1024);}catch{}try{checkBudget?.();}catch(value){error??=value;stop('artifact-budget');}},100);
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes<=REFERENCE_LIMITS.logBytes)output.push(chunk);else stop('output-budget');});
  child.once('error',value=>{error??=value;});
  child.once('close',(code,signal)=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);clearInterval(sample);
   const raw=Buffer.concat(output);try{writeFileSync(log,raw,{flag:'wx',mode:0o600});}catch(value){error??=value;}
   const result={code,signal,stoppedBecause,error:error?{name:error.name,code:error.code??null}:null,elapsedMs:performance.now()-started,peakRss,log,logBytes:raw.length};
   if(performance.now()>deadline)result.stoppedBecause??='aggregate-budget';resolve(result);
  });
 });
}
export function requireNativeSuccess(result){assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(result.stoppedBecause,null);assert.equal(result.error,null);}
