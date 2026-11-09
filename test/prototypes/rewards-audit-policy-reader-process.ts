/** Fixed test child. No app/owner URL, environment or SQL crosses its IPC. */
import {spawn} from 'node:child_process';
import {controlledPolicyWait} from './rewards-audit-policy-controlled-wait';
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import type {RewardsAuditPolicyFixtureOwner} from './rewards-audit-policy-owner';
const identity={session_user:z.literal('ai_hr_reward_audit_read'),current_user:z.literal('ai_hr_reward_audit_read'),pid:z.number().int().positive(),started:z.string().min(20),database:z.string(),statement:z.literal('20s'),lock:z.literal('300ms')};
const message=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('ready')}).strict(),z.object({kind:z.literal('refused')}).strict(),
 z.object({...identity,kind:z.enum(['finalized','committed']),receiptId:z.guid()}).strict(),
 z.object({...identity,kind:z.literal('reconciled'),value:z.object({id:z.guid(),observedAt:z.string(),armed:z.boolean(),projected:z.boolean()}).strict().nullable()}).strict(),
]);
type Message=z.infer<typeof message>;
export async function rewardPolicyReaderProcess(fixture:RewardsAuditPolicyFixtureOwner,ctx:SessionContext,signal:AbortSignal,registerStop:(stop:()=>Promise<void>)=>void){
 if(!ctx.userId||ctx.agent||ctx.entitlementsExempt!==undefined||ctx.statutoryOverride!==undefined)throw Error('Actual human policy process required');
 const userId=ctx.userId,tenantId=ctx.tenantId,roles=ctx.roles?.slice()??[],grants=ctx.grants?.map(grant=>({...grant}))??roles.map(role=>({role,companyId:null}));
 const child=spawn(process.execPath,['--import','tsx','test/prototypes/rewards-audit-policy-reader-child.ts'],{cwd:process.cwd(),env:{NODE_ENV:'test',PATH:process.env.PATH,TZ:'UTC',LANG:'en_US.UTF-8',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr'},stdio:['ignore','pipe','pipe','ipc']});
 let outputBytes=0,invalid=false,exited=false;const messages:Message[]=[],wake=new Set<()=>void>();
 const abort=()=>{if(!exited)child.kill('SIGKILL');};
 // An error event is not the close/drain witness. Retain it until the real
 // close event, so startup failure cannot release ownership before teardown.
 let childError:unknown;
 const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',error=>{childError=error;});child.once('close',(code,signal)=>{exited=true;if(childError!==undefined)reject(childError);else resolve({code,signal});for(const call of wake)call();});});void closed.catch(()=>{});
 let stopping:Promise<void>|undefined;const stop=()=>stopping??=Promise.resolve().then(async()=>{abort();try{await closed;if(invalid||outputBytes)throw Error('Unexpected policy child output/protocol');}finally{signal.removeEventListener('abort',abort);}});
 // Owned stop registration precedes ready/SQL/message awaits and all callbacks.
 registerStop(stop);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 for(const stream of [child.stdout,child.stderr])stream?.on('data',value=>{outputBytes+=Buffer.byteLength(value);if(outputBytes>16384)abort();});
 child.on('message',raw=>{const parsed=message.safeParse(raw);if(!parsed.success||messages.length>=8){invalid=true;abort();return;}messages.push(parsed.data);for(const call of wake)call();});
 function wait(kind:Message['kind']):Promise<Message>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{wake.delete(check);reject(Error('Fixed policy process transition missing'));},10000);
  function check(){const found=messages.find(row=>row.kind===kind);if(found){clearTimeout(timer);wake.delete(check);resolve(found);}else if(exited||invalid||messages.some(row=>row.kind==='refused')){clearTimeout(timer);wake.delete(check);reject(Error('Native policy process refused'));}}
  wake.add(check);check();
 });}
 const common={database:fixture.database,readerUrl:fixture.readerUrl,tenantId,userId,roles,grants};
 try{await wait('ready');}catch(error){await controlledPolicyWait().run(async()=>{throw error;},stop);throw error;}
 return{child,closed,wait,stop,
  read(year:number,pause:'before-commit'|'after-commit'){signal.throwIfAborted();child.send({...common,kind:'read',year,pause});},
  reconcile(receiptId:string){signal.throwIfAborted();child.send({...common,kind:'reconcile',receiptId});},
 };
}
