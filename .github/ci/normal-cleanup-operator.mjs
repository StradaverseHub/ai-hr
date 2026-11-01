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
 const completed=new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('Cleanup terminal close timed out; retain lease and reconcile remote state')),terminalTimeout);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);code===0?accept():reject(Error('Cleanup transport failed; reconcile state and retain lease'));});});completed.catch(()=>{});
 child.stdin.on('error',()=>{});
 return {frames,stdin:child.stdin,success:async()=>{await completed;assert(errorBytes<=65536,'Cleanup stderr exceeds bound');frames.finish();},stderr:()=>({bytes:errorBytes,capturedSha256:installHash(Buffer.concat(stderr))})};
}
/** Wait only for real local time to catch a small cross-host READY skew; all validators retain their strict bounds. */
export async function waitForRealReadyClock(ready,{now=()=>Date.now(),sleep=ms=>new Promise(done=>setTimeout(done,ms))}={}){
 const at=Date.parse(ready?.readyAt),start=now();assert(Number.isFinite(at)&&at-start<=2000,'Cross-host clock gap exceeds bounded real wait');
 while(now()<at){assert(now()-start<=2100,'Real clock wait exceeded bound');await sleep(Math.min(10,Math.max(1,at-now())));}
}
export async function driveNormalCleanup({channel,grant,arrival,checksum,frozen,save,now=()=>Date.now(),wait=waitForRealReadyClock}){
 try{
  const raw=await channel.frames.next();await wait(raw);const ready=validateReady(raw,grant,{now:now()});save('cleanup-session-ready.json',ready);frozen();
  const output=await checksum(),checkedAt=new Date(now()).toISOString();save('cleanup-fresh-source-arrival.json',{source:grant.source,output,checkedAt,checksum:true});frozen();
  const proof=createCleanupRequest(grant,{output,checkedAt,arrival}),commit=createCommit(ready,proof,grant);save('cleanup-session-commit.json',commit);
  channel.stdin.end(installJson(commit)+'\n');
  const message=await channel.frames.next();assert(message&&Object.keys(message).sort().join(',')==='format,kind,result'&&message.format===1&&message.kind===RESULT_KIND,'Exact normal cleanup result marker required');
  await channel.success();save('cleanup-session-stderr.json',{stderr:channel.stderr()});frozen();return message.result;
 }catch(error){channel.stdin.end();save('cleanup-session-incomplete.json',{retainLease:true,reconcileRemoteBeforeRetry:true,error:String(error)});throw error;}
}
