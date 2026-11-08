/** Fixed private proof controller. An IPC message is never native acceptance. */
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {defaultControllerOutput,type DefaultControllerIdentity} from './rewards-audit-default-controller-protocol';
import {controlledPolicyWait} from './rewards-audit-policy-controlled-wait';
export type AuditDefaultControl=Readonly<{signal:AbortSignal;registerStop:(stop:()=>Promise<void>)=>void;registerDefaultController:(nonce:string)=>void}>;
type Closed={code:number|null;signal:NodeJS.Signals|null};
export function privateAuditDefaultController(ownerUrl:string,control:AuditDefaultControl,poison:(error:Error)=>void){
 const nonce=randomUUID(),messages:DefaultControllerIdentity[]=[],wake=new Set<()=>void>();control.registerDefaultController(nonce);
 let child:ReturnType<typeof spawn>|undefined,exited=false,ownedKill=false,output=0,invalid:Error|undefined,childError:unknown,closeResolve!:(value:Closed)=>void;
 const closed=new Promise<Closed>(resolve=>{closeResolve=resolve;});let stopping:Promise<Closed>|undefined;
 // Register actual process creation before its first microtask. A stop during
 // construction awaits creation, then owns close even if startup/send failed.
 const creation=Promise.resolve().then(()=>{
  control.signal.throwIfAborted();child=spawn(process.execPath,['--import','tsx','test/prototypes/rewards-audit-default-controller-child.ts'],{cwd:process.cwd(),env:{PATH:process.env.PATH,TZ:'UTC',LANG:'en_US.UTF-8',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',TEST_DB_NAMESPACE:process.env.TEST_DB_NAMESPACE??'',VITEST_POOL_ID:process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID,WORKER_DB:process.env.WORKER_DB},stdio:['ignore','pipe','pipe','ipc']});
  child.once('error',error=>{childError=error;});child.once('close',(code,signal)=>{exited=true;closeResolve({code,signal});for(const call of wake)call();});
  for(const stream of [child.stdout,child.stderr])stream?.on('data',value=>{output+=Buffer.byteLength(value);invalid??=Error('Unexpected private default-controller output');if(output>16384&&!exited)ownedKill=child?.kill('SIGKILL')===true;for(const call of wake)call();});
  child.on('message',raw=>{
   const parsed=defaultControllerOutput.safeParse(raw);
   if(!parsed.success||parsed.data.kind==='refused'||parsed.data.nonce!==nonce||messages.length>=3||parsed.data.kind!==(['prepared','committed','completed']as const)[messages.length])invalid??=Error(parsed.success&&parsed.data.kind==='refused'?'Private default-controller refused '+parsed.data.phase:'Private default-controller protocol refused');
   else messages.push(parsed.data);
   for(const call of wake)call();
  });
  child.send({kind:'start',nonce,ownerUrl},error=>{if(error){childError=error;for(const call of wake)call();}});
 }).then(()=>({ok:true as const}), (error:unknown)=>({ok:false as const,error}));
 const stop=()=>stopping??=Promise.resolve().then(async()=>{
  const started=await creation;
  try{
   if(child){if(!exited)ownedKill=child.kill('SIGKILL');const result=await closed;if(childError!==undefined)throw childError;if(invalid)throw invalid;if(output)throw Error('Private owner output refused');
    assert(result.code===0&&result.signal===null||ownedKill&&result.code===null&&result.signal==='SIGKILL','Unexpected private owner exit');if(!started.ok)throw started.error;return result;
   }
   if(!started.ok)throw started.error;throw Error('Private owner process missing');
  }finally{control.signal.removeEventListener('abort',abort);}
 });
 const abort=()=>{void stop().catch(error=>poison(Error('Private default-controller stop uncertain',{cause:error})));};
 control.registerStop(async()=>{await stop();});control.signal.addEventListener('abort',abort,{once:true});if(control.signal.aborted)abort();
 function wait(kind:DefaultControllerIdentity['kind']):Promise<DefaultControllerIdentity>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{wake.delete(check);reject(Error('Private default-controller transition missing'));},10000);
  function check(){const message=messages.find(value=>value.kind===kind);if(message&&!invalid){clearTimeout(timer);wake.delete(check);resolve(message);}else if(invalid||childError!==undefined||exited||control.signal.aborted){clearTimeout(timer);wake.delete(check);reject(invalid??Error('Private default-controller unavailable',{cause:childError??control.signal.reason}));}}
  wake.add(check);void creation.then(value=>{if(!value.ok){invalid=Error('Private default-controller startup refused',{cause:value.error});}check();});check();
 });}
 return Object.freeze({nonce,wait,stop,
  advance(){control.signal.throwIfAborted();if(!child||exited||invalid)throw Error('Private owner not available');child.send({kind:'continue',nonce},error=>{if(error){childError=error;for(const call of wake)call();}});},
  async run<T>(work:()=>Promise<T>){return controlledPolicyWait(poison).run(work,async()=>{await stop();});},
 });
}
