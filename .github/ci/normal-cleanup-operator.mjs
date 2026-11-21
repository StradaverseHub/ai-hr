/** Same-channel normal cleanup driver. Failed/unknown transport never retries mutation. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {installJson,installHash} from './ci-install-grant.mjs';
import {createCleanupRequest} from './staging-cleanup-protocol.mjs';
import {validateReady,createCommit,RESULT_KIND} from './normal-cleanup-session.mjs';
import {cleanupFrames} from './normal-cleanup-io.mjs';
export function openNormalCleanupChannel(args,{launch=spawn,terminalTimeout=900000}={}){
 const child=launch('ssh',args,{stdio:['pipe','pipe','pipe']}),frames=cleanupFrames(child.stdout);let errorBytes=0;const stderr=[];
 child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes<=65536)stderr.push(chunk);});
 const terminal={closed:false,exitCode:null,signal:null,spawnErrorCode:null,timedOut:false};
 const completed=new Promise((accept,reject)=>{const timer=setTimeout(()=>{terminal.timedOut=true;reject(Error('Cleanup terminal close timed out; retain lease and reconcile remote state'));},terminalTimeout);child.once('error',error=>{terminal.spawnErrorCode=typeof error.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:'UNKNOWN';clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{terminal.closed=true;terminal.exitCode=code;terminal.signal=signal;clearTimeout(timer);code===0?accept():reject(Error('Cleanup transport failed; reconcile state and retain lease'));});});completed.catch(()=>{});
 child.stdin.on('error',()=>{});
 return {frames,stdin:child.stdin,success:async()=>{await completed;assert(errorBytes<=65536,'Cleanup stderr exceeds bound');frames.finish();},terminal:()=>({...terminal}),stderr:()=>({bytes:errorBytes,capturedSha256:installHash(Buffer.concat(stderr))})};
}
/** Wait only for real local time to catch a small cross-host READY skew; all validators retain their strict bounds. */
export async function waitForRealReadyClock(ready,{now=()=>Date.now(),sleep=ms=>new Promise(done=>setTimeout(done,ms))}={}){
 const at=Date.parse(ready?.readyAt),start=now();assert(Number.isFinite(at)&&at-start<=2000,'Cross-host clock gap exceeds bounded real wait');
 while(now()<at){assert(now()-start<=2100,'Real clock wait exceeded bound');await sleep(Math.min(10,Math.max(1,at-now())));}
}
export async function driveNormalCleanup({channel,grant,arrival,checksum,frozen,save,now=()=>Date.now(),wait=waitForRealReadyClock}){
 let phase='awaiting-ready',commitSent=false,resultReceived=false;
 try{
  const raw=await channel.frames.next();phase='validating-ready';await wait(raw);const ready=validateReady(raw,grant,{now:now()});save('cleanup-session-ready.json',ready);frozen();
  phase='checking-source';const output=await checksum(),checkedAt=new Date(now()).toISOString();save('cleanup-fresh-source-arrival.json',{source:grant.source,output,checkedAt,checksum:true});frozen();
  phase='preparing-commit';const proof=createCleanupRequest(grant,{output,checkedAt,arrival}),commit=createCommit(ready,proof,grant);save('cleanup-session-commit.json',commit);
  phase='sending-commit';channel.stdin.end(installJson(commit)+'\n');commitSent=true;phase='awaiting-result';
  const message=await channel.frames.next();resultReceived=true;phase='validating-result';assert(message&&Object.keys(message).sort().join(',')==='format,kind,result'&&message.format===1&&message.kind===RESULT_KIND,'Exact normal cleanup result marker required');
  phase='awaiting-terminal-close';await channel.success();save('cleanup-session-stderr.json',{stderr:channel.stderr()});frozen();return message.result;
 }catch(error){
  channel.stdin.end();const observedAt=new Date(now()).toISOString();
  // Observation only: sending COMMIT does not prove deletion, and EOF can precede child close.
  // Keep stderr private and bounded as metadata; never infer cleanup success or retry mutation.
  save('cleanup-session-incomplete.json',{retainLease:true,reconcileRemoteBeforeRetry:true,error:String(error),phase,commitSent,resultReceived,observedAt,grantExpiresAt:grant.expiresAt,grantExpiredAtObservation:Date.parse(observedAt)>=Date.parse(grant.expiresAt),terminal:channel.terminal?.()??null,stderr:channel.stderr?.()??null});throw error;
 }
}
