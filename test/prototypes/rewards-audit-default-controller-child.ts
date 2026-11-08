/** PRIVATE disposable owner-controller child, NOT a reader/projector/worker.
 * Sole program: literal native default canonicalization. No SQL, signature,
 * default, role, path or program flags are accepted over IPC. */
import postgres from 'postgres';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {defaultControllerInput,defaultControllerApplication,type DefaultControllerIdentity} from './rewards-audit-default-controller-protocol';
import {rewardsAuditWorkerScope,rewardsAuditWorkerUrl} from './rewards-audit-fixture-context';
import {admitAuditCanonicalization,applyExactAuditCanonicalization,referenceAuditCanonicalization} from './rewards-audit-native-postimage';
import {controlledPolicyWait} from './rewards-audit-policy-controlled-wait';
type Phase='startup'|'context'|'reference'|'apply'|'commit'|'publication'|'cleanup';
let phase:Phase='startup',failurePhase:Phase|undefined,started=false,nonce:string|undefined;
let advance:(()=>void)|undefined,cancelWait:(()=>void)|undefined,closeOwned=async()=>{};
const stopped=new AbortController();
function cancel(){if(!stopped.signal.aborted)stopped.abort(Error('Private owner channel closed'));cancelWait?.();void closeOwned().catch(()=>{failurePhase??='cleanup';});}
process.once('disconnect',cancel);
const wait=()=>new Promise<void>((resolve,reject)=>{
 stopped.signal.throwIfAborted();assert(!advance);const clear=()=>{clearTimeout(timer);advance=undefined;cancelWait=undefined;};
 const timer=setTimeout(()=>{clear();reject(Error('Fixed owner transition timeout'));},10000);
 advance=()=>{clear();resolve();};cancelWait=()=>{clear();reject(stopped.signal.reason);};
});
function send(value:unknown){if(!process.send||!process.connected)throw Error('Private owner IPC required');process.send(value,error=>{if(error)cancel();});}
async function run(ownerUrl:string,id:string){
 assert.equal(process.argv.length,2);assert.equal(resolve(process.argv[1]),resolve('test/prototypes/rewards-audit-default-controller-child.ts'));
 assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');const scope=rewardsAuditWorkerScope(),url=rewardsAuditWorkerUrl(ownerUrl,scope.database),login=decodeURIComponent(url.username);
 const connection=postgres(url.toString(),{max:1,connect_timeout:2,connection:{statement_timeout:20000,lock_timeout:300,default_transaction_isolation:'read committed',default_transaction_read_only:'off',application_name:defaultControllerApplication(id)}});
 let ending:Promise<void>|undefined;closeOwned=()=>ending??=Promise.resolve().then(()=>connection.end({timeout:0}));
 let physical:Omit<DefaultControllerIdentity,'kind'>|undefined;
 await controlledPolicyWait().run(async()=>{
  try{
   stopped.signal.throwIfAborted();await connection.begin(async tx=>{
    phase='context';const original=await admitAuditCanonicalization(tx,scope.database,login);
    const [identity]=await tx`select pg_backend_pid()as pid,backend_start::text as started,pg_current_xact_id()::text as xid from pg_stat_activity where pid=pg_backend_pid()`;
    assert.equal(typeof identity.pid,'number');assert.equal(typeof identity.started,'string');assert.equal(typeof identity.xid,'string');physical={nonce:id,database:scope.database,role:login,pid:identity.pid,started:identity.started,xid:identity.xid};
    phase='reference';const canonical=await referenceAuditCanonicalization(tx,original);
    phase='apply';await applyExactAuditCanonicalization(tx,original,canonical);
    const next=wait();send({...physical,kind:'prepared'});await next;stopped.signal.throwIfAborted();phase='commit';
   });
   assert(physical);phase='publication';const next=wait();send({...physical,kind:'committed'});await next;stopped.signal.throwIfAborted();send({...physical,kind:'completed'});
  }catch(error){failurePhase??=phase;throw error;}
 },async()=>{phase='cleanup';await closeOwned();});
}
process.on('message',raw=>{
 const message=defaultControllerInput.safeParse(raw);
 if(!message.success){send({kind:'refused',phase});cancel();process.disconnect?.();process.exitCode=1;return;}
 if(message.data.kind==='continue'){
  if(message.data.nonce!==nonce||!advance){send({kind:'refused',phase});cancel();process.disconnect?.();process.exitCode=1;return;}advance();return;
 }
 if(started){send({kind:'refused',phase});cancel();process.disconnect?.();process.exitCode=1;return;}
 started=true;nonce=message.data.nonce;
 void run(message.data.ownerUrl,nonce).then(()=>{process.removeListener('disconnect',cancel);process.disconnect?.();},()=>{
  if(process.connected)send({kind:'refused',phase:failurePhase??phase});process.exitCode=1;process.removeListener('disconnect',cancel);process.disconnect?.();
 });
});
