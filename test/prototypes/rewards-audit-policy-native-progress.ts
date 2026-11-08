/** Test synchronization/lifetime only. A callback supplies a native observation;
 * this helper grants no permission or evidence authority. The actual independent
 *200ms blocking assertion remains required AFTER this phase is observed. */
import {controlledPolicyWait,type ControlledPolicyTask} from './rewards-audit-policy-controlled-wait';
export async function waitRewardPolicyNativeProgress(control:ReturnType<typeof controlledPolicyWait>,task:ControlledPolicyTask<unknown>,signal:AbortSignal,observe:()=>Promise<boolean>){
 let stopped=false,publish!:()=>void,refuse!:(error:unknown)=>void;
 const ready=new Promise<void>((resolve,reject)=>{publish=resolve;refuse=reject;});
 const progress=control.start(async()=>{
  while(!stopped){signal.throwIfAborted();if(await observe())return true;if(!stopped)await new Promise<void>(resolve=>setTimeout(resolve,5));}
  return false;
 });
 // Both settlements are consumed by this actual observer. A failed native query
 // remains unobserved in the SAME outer controlled scope, which retains it with
 // any distinct primary/cleanup error; it is never silently treated as readiness.
 const observed=progress.value().then(reached=>{if(reached&&!stopped)publish();},error=>{refuse(error);});
 try{await control.ready(ready,task,signal,'Actual receipt exited before native floor INSERT progress');}
 finally{stopped=true;await observed;}
}
