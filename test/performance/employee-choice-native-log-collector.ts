/** One owned docker follower, never a sequence of cumulative log snapshots. */
import {spawn} from 'node:child_process';
import {employeeChoiceNativeLogParts,employeeChoiceNativeLogBounds,type NativeLogBinding,type NativeLogChannel} from './employee-choice-native-log-parts';
import {employeeChoiceNativeMarkerObserver} from './employee-choice-native-log-stream';
import {employeeChoiceSqlFingerprint} from './employee-choice-auto-explain-parser';
export function employeeChoiceNativeLogCollector(directory:string,binding:NativeLogBinding,signal:AbortSignal,poison:(error:Error)=>void){
 signal.throwIfAborted();const store=employeeChoiceNativeLogParts(directory,binding),seen=new Map<string,NativeLogChannel>(),waiters=new Map<string,{resolve:()=>void;reject:(error:unknown)=>void}>();
 let failure:Error|undefined,closing:Promise<void>|undefined,requestedClose=false,exited=false,channel:NativeLogChannel|undefined,poisoned=false;
 const refuse=(error:unknown)=>{failure??=error instanceof Error?error:new Error('Native follower refused',{cause:error});for(const waiter of waiters.values())waiter.reject(failure);waiters.clear();if(!poisoned){poisoned=true;try{poison(failure);}catch(error){failure=new AggregateError([failure,error],'Native follower failure and owner poison both refused',{cause:failure});}}};
 const marker=(from:NativeLogChannel,query:string)=>{
  if(channel&&channel!==from)throw Error('Native marker PID appeared on both raw channels');channel=from;
  const key=employeeChoiceSqlFingerprint(query);if(seen.has(key))throw Error('Duplicate actual native marker');seen.set(key,from);waiters.get(key)?.resolve();waiters.delete(key);
 };
 const observers={stdout:employeeChoiceNativeMarkerObserver(binding.pid,query=>marker('stdout',query)),stderr:employeeChoiceNativeMarkerObserver(binding.pid,query=>marker('stderr',query))};
 // Synchronous creation registers the child and ALL handlers before any await.
 const child=spawn('docker',['logs','--follow','--since',binding.startedAt,binding.containerId],{stdio:['ignore','pipe','pipe']});
 for(const name of ['stdout','stderr']as const){child[name].on('error',refuse);child[name].on('data',(value:Buffer)=>{try{store.append(name,value);observers[name].append(value);}catch(error){refuse(error);child.kill('SIGTERM');}});}
 const settled=new Promise<void>(resolve=>{
  child.once('error',error=>{refuse(error);});
  child.once('close',(code,termination)=>{exited=true;try{for(const observer of Object.values(observers))observer.finish();if(!requestedClose)throw Error('Native follower exited before owned close: '+String(code)+'/'+String(termination));}catch(error){refuse(error);}resolve();});
 });
 const close=()=>{
  if(closing)return closing;requestedClose=true;for(const waiter of [...waiters.values()])waiter.reject(Error('Native follower closed before marker'));waiters.clear();
  closing=Promise.resolve().then(async()=>{
   signal.removeEventListener('abort',abort);const timer=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},5000);
   let retentionFailure:unknown;try{if(!exited)child.kill('SIGTERM');await settled;try{store.checkpoint('transport-closed',true);}catch(error){retentionFailure=error;}}finally{clearTimeout(timer);}
   if(failure&&retentionFailure!==undefined)throw new AggregateError([failure,retentionFailure],'Native follower and final retention both refused',{cause:failure});if(failure)throw failure;if(retentionFailure!==undefined)throw retentionFailure;
  });void closing.catch(()=>{});return closing;
 };
 const abort=()=>{void close().catch(refuse);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 async function wait(query:string){
  signal.throwIfAborted();if(failure)throw failure;if(closing||exited)throw Error('Native follower admission closed');const key=employeeChoiceSqlFingerprint(query);
  if(seen.has(key))return;if(waiters.has(key))throw Error('Duplicate marker waiter');
  await new Promise<void>((resolve,reject)=>{
   const finish=(error?:unknown)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);waiters.delete(key);if(error!==undefined)reject(error);else resolve();};
   const cancel=()=>finish(signal.reason??Error('Native capture aborted'));
   const timer=setTimeout(()=>{const error=Error('Actual native marker not observed within20s');finish(error);refuse(error);},employeeChoiceNativeLogBounds.checkpointMs);
   waiters.set(key,{resolve:()=>finish(),reject:error=>finish(error)});signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  });if(failure)throw failure;signal.throwIfAborted();
 }
 return{wait,checkpoint:(label:string)=>{if(failure)throw failure;signal.throwIfAborted();return store.checkpoint(label);},close,store,nativeChannel:()=>{if(!channel)throw Error('No actual native marker channel observed');return channel;}};
}
