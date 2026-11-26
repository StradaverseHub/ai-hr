/** Compile-to-typecheck memory handoff for an owned `next build`. Scheduling only: never an acceptance, release
 * or capacity authority, and it changes no compiler input, flag, check or output.
 *
 * Measured on hosted 16 GB runners (no swap; build-only run 45865756865, candidate 3539e91e): after Turbopack
 * prints "Compiled successfully", the `next build` process keeps ~9.6–10.4 GiB resident for ~10 s while its
 * unawaited project shutdown frees the compiler graph, and Next spawns the TypeScript CLI immediately. `tsc` ramps
 * at ~250 MB/s, so the two overlap: MemFree reached 0.16 GiB and sampled MemAvailable bottomed at the moment
 * `next` dropped to 0.29 GiB. That overlap, not the long type-check phase, sets the minimum the reviewed floor
 * guards, and its length varies with teardown time.
 *
 * The handoff pauses (SIGSTOP) only a `tsc` whose parent is a `next` process inside the owned build tree, only
 * while that parent is still above RELEASE_KIB, and resumes it (SIGCONT) once the parent has released its memory,
 * the parent is gone, or MAX_HOLD_MS elapses. Every identity is re-proven (pid + starttime) before a signal, and
 * `release()` always resumes a held process. The GNU time RSS budget and the MemAvailable floor are unchanged.
 *
 * Measured with the handoff (build-only runs 45867939773, 45867944324, 45867948202, same candidate): tsc held
 * 10.0–13.3 s at <=22 MB, next released to 0.28–0.64 GiB, min sampled MemAvailable 3.46/3.71/3.49 GiB (at compile end,
 * next alone) versus 1.35–1.49 GiB on the failed gates and 2.01 GiB on the unchanged baseline 45865756865. */
import assert from 'node:assert/strict';
import {readdirSync,readFileSync,openSync,readSync,closeSync} from 'node:fs';
import {parseProcessStat,parseProcessMemory,buildProcessKind} from './build-process-memory.mjs';

export const HANDOFF_RELEASE_KIB=2*1024**2;
export const HANDOFF_MAX_HOLD_MS=90000;
export const HANDOFF_POLL_MS=250;
// Next 16 replaces its argv with the fixed title `next-build (vX)` shortly after start.
export function handoffProcessKind(cmdline){
 assert(Buffer.isBuffer(cmdline)&&cmdline.length<=4096);
 return /^next-build \(v\d/.test(cmdline.toString('utf8'))?'next':buildProcessKind(cmdline);
}
const systemIo={
 pids:()=>readdirSync('/proc').filter(x=>/^[1-9]\d*$/.test(x)).map(Number),
 stat:pid=>readFileSync('/proc/'+pid+'/stat','utf8'),
 status:pid=>readFileSync('/proc/'+pid+'/status','utf8'),
 cmdline:pid=>{const fd=openSync('/proc/'+pid+'/cmdline','r');try{const b=Buffer.alloc(4097),n=readSync(fd,b,0,b.length,0);assert(n<=4096);return b.subarray(0,n);}finally{closeSync(fd);}},
 kill:(pid,signal)=>process.kill(pid,signal),
};
/** Injected IO and clock permit pure fixtures without launching or signalling any process. */
export function createTypecheckHandoff(rootPid,{io=systemIo,now=Date.now,releaseKiB=HANDOFF_RELEASE_KIB,maxHoldMs=HANDOFF_MAX_HOLD_MS}={}){
 assert(Number.isSafeInteger(rootPid)&&rootPid>1);
 const issues={},kinds=new Map(),identity=p=>p.pid+':'+p.starttime;
 const issue=key=>{issues[key]=(issues[key]??0)+1;};
 const report={kind:'NEXT_TYPECHECK_MEMORY_HANDOFF_NOT_ACCEPTANCE',releaseAuthorized:false,releaseKiB,maxHoldMs,state:'watching',polls:0,issues};
 let held=null;
 const stat=pid=>{const p=parseProcessStat(io.stat(pid));assert(p.pid===pid);return p;};
 const rss=pid=>parseProcessMemory(io.status(pid)).rssKiB;
 const same=(pid,key)=>{try{return identity(stat(pid))===key;}catch{return false;}};
 function tree(){
  const all=new Map();
  for(const pid of io.pids().slice(0,4096)){try{const p=stat(pid);if(!['Z','X'].includes(p.state))all.set(pid,p);}catch{}}
  const root=all.get(rootPid);if(!root)return [];
  const children=new Map();for(const p of all.values()){const list=children.get(p.parentPid)??[];list.push(p);children.set(p.parentPid,list);}
  const owned=[root];for(let i=0;i<owned.length;i++)owned.push(...(children.get(owned[i].pid)??[]));
  return owned;
 }
 const kindOf=p=>{const key=identity(p);if(!kinds.has(key)){try{const cmd=io.cmdline(p.pid);kinds.set(key,same(p.pid,key)?handoffProcessKind(cmd):'other');}catch{issue('classification_gap');return 'other';}}return kinds.get(key);};
 function resume(reason){
  if(!held)return;
  const at=now();
  if(same(held.tsc.pid,held.tscKey))try{io.kill(held.tsc.pid,'SIGCONT');}catch{issue('resume_signal_gap');}
  else issue('held_process_gone');
  let parentRssKiB=null;try{if(same(held.next.pid,held.nextKey))parentRssKiB=rss(held.next.pid);}catch{}
  Object.assign(report,{state:'released',releaseReason:reason,holdMs:at-held.at,parentRssAtReleaseKiB:parentRssKiB});held=null;
 }
 function poll(){
  report.polls++;
  if(report.state==='released'||report.state==='not_needed')return;
  try{
   if(held){
    let parentRss=null;try{if(same(held.next.pid,held.nextKey))parentRss=rss(held.next.pid);}catch{}
    if(!same(held.tsc.pid,held.tscKey))return resume('typecheck_exited');
    if(parentRss===null)return resume('parent_exited');
    if(parentRss<=releaseKiB)return resume('parent_released');
    if(now()-held.at>=maxHoldMs)return resume('max_hold');
    return;
   }
   const owned=tree(),byPid=new Map(owned.map(p=>[p.pid,p]));
   for(const p of owned){
    if(kindOf(p)!=='tsc')continue;
    const parent=byPid.get(p.parentPid);if(!parent||kindOf(parent)!=='next')continue;
    const tscKey=identity(p),nextKey=identity(parent),parentRss=rss(parent.pid);
    if(parentRss<=releaseKiB){Object.assign(report,{state:'not_needed',parentRssAtSpawnKiB:parentRss});return;}
    // Re-prove both identities immediately before the only pause signal.
    if(!same(p.pid,tscKey)||!same(parent.pid,nextKey)){issue('identity_changed');return;}
    const tscRss=(()=>{try{return rss(p.pid);}catch{return null;}})();
    io.kill(p.pid,'SIGSTOP');
    held={tsc:p,tscKey,next:parent,nextKey,at:now()};
    // A wrapper that exits while holding still resumes the paused compiler.
    if(io===systemIo)process.once('exit',()=>release('wrapper_exit'));
    Object.assign(report,{state:'holding',parentRssAtHoldKiB:parentRss,typecheckRssAtHoldKiB:tscRss});
    return;
   }
  }catch{issue('poll_gap');}
 }
 /** Always safe to call; resumes a held process. */
 function release(reason='finished'){try{resume(reason);}catch{issue('release_gap');}if(report.state==='watching')report.state='not_observed';return report;}
 return {poll,release,report:()=>report};
}
