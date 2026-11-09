/** Closed current-application metadata only; never compiler/release qualification. */
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {admitCompilerApplicationInventory,publishCompilerApplicationInventoryClock} from '../.github/ci/diagnostics/native-reference/admission.mjs';
it('inventories actual original and build native application inputs without checking semantics',async context=>{
 const started=process.hrtime.bigint(),controller=new AbortController(),failures:unknown[]=[],output:Buffer[]=[];
 let child:ReturnType<typeof spawn>|undefined,closed:Promise<{code:number|null;signal:NodeJS.Signals|null}>|undefined;
 let exited=false,finished=false,bytes=0,timer:ReturnType<typeof setTimeout>|undefined,killTimer:ReturnType<typeof setTimeout>|undefined,drainTimer:ReturnType<typeof setTimeout>|undefined;
 const elapsed=()=>Number(process.hrtime.bigint()-started)/1e6;
 const remember=(error:unknown)=>{if(!failures.includes(error))failures.push(error);};
 const closePipes=()=>{for(const stream of [child?.stdout,child?.stderr])try{stream?.destroy();}catch(error){remember(error);}};
 const stop=(reason:unknown)=>{
  if(!controller.signal.aborted)controller.abort(reason);
  if(!child)return;if(exited){closePipes();return;}
  try{child.kill('SIGTERM');}catch(error){remember(error);}
  killTimer??=setTimeout(()=>{if(child&&!exited)try{child.kill('SIGKILL');}catch(error){remember(error);}},1000);
 };
 const abort=()=>stop(context.signal.reason);context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
 const run=(async()=>{
  try{
   controller.signal.throwIfAborted();const proof=admitCompilerApplicationInventory();
   await publishCompilerApplicationInventoryClock(proof,controller.signal,started);controller.signal.throwIfAborted();
   const keys=['PATH','HOME','RUNNER_TEMP','GITHUB_WORKSPACE','GITHUB_ACTIONS','CI','RUNNER_ENVIRONMENT','RUNNER_OS','GITHUB_REPOSITORY','GITHUB_WORKFLOW','GITHUB_JOB','GITHUB_EVENT_NAME','GITHUB_RUN_ATTEMPT','GITHUB_RUN_ID','AIHR_CI_HEAD','AIHR_CI_CONTROL_HEAD','AIHR_FOCUSED_TESTS','AIHR_FOCUSED_EVIDENCE_DIR']as const;
   const env:NodeJS.ProcessEnv={LANG:'C',LC_ALL:'C',TZ:'UTC'};for(const key of keys)if(process.env[key]!==undefined)env[key]=process.env[key];
   expect(elapsed()).toBeLessThan(718000);
   child=spawn(process.execPath,['--max-old-space-size=12288',join(proof.source,'.github/ci/diagnostics/native-reference/application-inventory.mjs')],{env,stdio:['ignore','pipe','pipe']});
   closed=new Promise(resolve=>{
    child!.once('error',remember);
    child!.once('exit',()=>{exited=true;if(killTimer)clearTimeout(killTimer);drainTimer=setTimeout(()=>{remember(Error('Inventory inherited pipe exceeded close budget'));closePipes();},Math.max(0,Math.min(1000,720000-elapsed())));});
    child!.once('close',(code,signal)=>{if(killTimer)clearTimeout(killTimer);if(drainTimer)clearTimeout(drainTimer);resolve({code,signal});});
   });
   for(const stream of [child.stdout,child.stderr]){
    if(!stream){remember(Error('Owned inventory pipe absent'));stop(failures.at(-1));continue;}
    stream.on('error',error=>{remember(error);stop(error);});
    stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes<=1024*1024)output.push(chunk);else{const error=Error('Native inventory wrapper output bound');remember(error);stop(error);}});
   }
   timer=setTimeout(()=>stop(Error('Native inventory aggregate budget exhausted')),Math.max(0,718000-elapsed()));
   const result=await closed;controller.signal.throwIfAborted();expect(failures).toEqual([]);expect(result.signal).toBeNull();expect(result.code,Buffer.concat(output).toString('utf8')).toBe(0);
   const report=JSON.parse(readFileSync(join(proof.destination,'compiler-native-application-inventory/report.json'),'utf8'));expect(report.complete).toBe(true);expect(report.ordinaryCompilerQualified).toBe(false);expect(report.releaseAuthorized).toBe(false);expect(report.applicationInventoryComplete).toBe(true);expect(report.graphComplete).toBe(false);expect(report.planFeasible).toBe(false);expect(report.originalApplicationFiveNegativesQualified).toBe(false);expect(report.elapsedMs).toBeLessThanOrEqual(720000);
  }catch(error){remember(error);}
  finally{
   if(child&&!exited)stop(Error('Owned native inventory settlement required'));
   try{await closed;}catch(error){remember(error);}
   if(timer)clearTimeout(timer);if(killTimer)clearTimeout(killTimer);if(drainTimer)clearTimeout(drainTimer);
   context.signal.removeEventListener('abort',abort);finished=true;
  }
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'Native inventory and owned settlement both refused');
 })();
 // Hook/promise ownership exists before the first asynchronous continuation.
 context.onTestFinished(async()=>{if(!finished)stop(Error('Native inventory finish requested'));await run;});
 await run;
},720000);
