/** Read-only attribution. GNU time remains the sole authoritative build RSS verdict. */
import assert from 'node:assert/strict';
import {readdirSync,readFileSync,openSync,readSync,closeSync} from 'node:fs';

export function parseProcessStat(text){
 assert(typeof text==='string'&&text.length<=16384);
 const start=text.indexOf(' ('),end=text.lastIndexOf(')');
 assert(start>0&&end>start);
 const pid=Number(text.slice(0,start)),fields=text.slice(end+1).trim().split(/\s+/);
 assert(Number.isSafeInteger(pid)&&pid>1&&fields.length>=20&&/^[A-Za-z]$/.test(fields[0]));
 const parentPid=Number(fields[1]);assert(Number.isSafeInteger(parentPid)&&parentPid>=0&&/^\d+$/.test(fields[19]));
 return {pid,parentPid,starttime:fields[19],state:fields[0]};
}
export function parseProcessMemory(text){
 assert(typeof text==='string'&&text.length<=65536);
 const value=name=>{const m=text.match(new RegExp('^'+name+':\\s+(\\d+) kB$','m'));assert(m);const n=Number(m[1]);assert(Number.isSafeInteger(n)&&n>=0);return n;};
 return {rssKiB:value('VmRSS'),hwmKiB:value('VmHWM')};
}
export function buildProcessKind(bytes){
 assert(Buffer.isBuffer(bytes)&&bytes.length<=4096);
 const args=bytes.toString('utf8').split('\0'),base=value=>value?.split('/').at(-1);
 if(!['node','nodejs'].includes(base(args[0])))return 'other';
 const script=args[1]??'';
 if(/\/typescript\/(?:bin\/tsc|lib\/_?tsc\.js)$/.test(script))return 'tsc';
 if(/\/next\/dist\/bin\/next$/.test(script)&&args[2]==='build')return 'next';
 if(/\/scripts\/dedupe-server-source-maps\.mjs$/.test(script)||script==='scripts/dedupe-server-source-maps.mjs')return 'dedupe';
 if(['pnpm.cjs','pnpm.js','pnpm'].includes(base(script)))return 'pnpm';
 return 'other';
}
const systemIo={
 pids:()=>readdirSync('/proc').filter(x=>/^[1-9]\d*$/.test(x)).map(Number),
 stat:pid=>readFileSync('/proc/'+pid+'/stat','utf8'),
 status:pid=>readFileSync('/proc/'+pid+'/status','utf8'),
 cmdline:pid=>{const fd=openSync('/proc/'+pid+'/cmdline','r');try{const b=Buffer.alloc(4097),n=readSync(fd,b,0,b.length,0);assert(n<=4096);return b.subarray(0,n);}finally{closeSync(fd);}},
};
/** Injected IO permits pure ownership/parser fixtures without launching any processes. */
export function createBuildProcessObserver(rootPid,{io=systemIo,now=Date.now,rowLimit=256,scanLimit=4096,expectedParentPid=process.pid}={}){
 assert(Number.isSafeInteger(rowLimit)&&rowLimit>0&&rowLimit<=256&&Number.isSafeInteger(scanLimit)&&scanLimit>0&&scanLimit<=4096);
 const began=now(),rows=new Map(),issues={},identity=p=>p.pid+':'+p.starttime;
 let rootKey=null,samples=0,lastSample=null,maxSampleGapMs=0;
 const issue=key=>{issues[key]=(issues[key]??0)+1;};
 const readStat=pid=>{const p=parseProcessStat(io.stat(pid));assert(p.pid===pid);return p;};
 function admit(p,elapsed){
  const key=identity(p);if(rows.has(key))return;
  if(rows.size>=rowLimit){issue('lifetime_row_limit');return;}
  let kind='other';try{assert(identity(readStat(p.pid))===key);const cmdline=io.cmdline(p.pid);assert(identity(readStat(p.pid))===key);kind=buildProcessKind(cmdline);}catch{issue('owned_classification_gap');return;}
  rows.set(key,{pid:p.pid,parentPid:p.parentPid,starttime:p.starttime,kind,firstSeenMs:elapsed,lastSeenMs:elapsed,peakObservedRssKiB:0,peakObservedHwmKiB:0,hwmFirstObservedMs:null});
 }
 try{assert(Number.isSafeInteger(rootPid)&&rootPid>1);const root=readStat(rootPid);assert(root.parentPid===expectedParentPid);rootKey=identity(root);admit(root,0);}catch{issue('root_identity_unavailable');}
 function sample(){
  const elapsed=now()-began;samples++;if(lastSample!==null)maxSampleGapMs=Math.max(maxSampleGapMs,elapsed-lastSample);lastSample=elapsed;
  if(!rootKey)return;
  const current=new Map();let pids;
  try{pids=io.pids();assert(Array.isArray(pids));}catch{issue('process_inventory_gap');return;}
  if(pids.length>scanLimit){issue('process_scan_limit');pids=pids.slice(0,scanLimit);}
  for(const pid of pids){
   if(!Number.isSafeInteger(pid)||pid<=1)continue;
   try{const p=readStat(pid);if(!['Z','X'].includes(p.state))current.set(pid,p);}catch{issue('process_scan_read_gap');}
  }
  // Already proven identities remain owned after reparenting. Reused PIDs do not.
  const queue=[],owned=new Set();
  for(const [key,row]of rows){const live=current.get(row.pid);if(live&&identity(live)===key){try{assert(identity(readStat(live.pid))===key);queue.push(live.pid);owned.add(key);}catch{issue('owned_identity_gap');}}else if(row.exitedSeenMs===undefined){row.exitedSeenMs=elapsed;if(live)issue('pid_reused');}}
  const children=new Map();for(const p of current.values()){const list=children.get(p.parentPid)??[];list.push(p);children.set(p.parentPid,list);}
  for(let index=0;index<queue.length;index++)for(const child of children.get(queue[index])??[]){
   const key=identity(child);if(owned.has(key))continue;
   try{assert(identity(readStat(queue[index]))===identity(current.get(queue[index])));}catch{issue('parent_identity_gap');continue;}
   admit(child,elapsed);if(rows.has(key)){owned.add(key);queue.push(child.pid);}
  }
  for(const key of owned){
   const row=rows.get(key),live=current.get(row.pid);row.lastSeenMs=elapsed;row.lastParentPid=live.parentPid;
   try{
    const memory=parseProcessMemory(io.status(row.pid));
    // Refuse a PID that changed identity between the ancestry and status reads.
    assert(identity(readStat(row.pid))===key);
    row.peakObservedRssKiB=Math.max(row.peakObservedRssKiB,memory.rssKiB);
    if(memory.hwmKiB>row.peakObservedHwmKiB){row.peakObservedHwmKiB=memory.hwmKiB;row.hwmFirstObservedMs=elapsed;}
   }catch{issue('owned_memory_read_gap');}
  }
 }
 return {sample,noteFailure:()=>issue('observer_sampling_error'),report:()=>({kind:'OBSERVED_BUILD_PROCESS_MEMORY_NOT_ACCEPTANCE',releaseAuthorized:false,rootPid,rootIdentity:rootKey,samples,maxSampleGapMs,rowLimit,scanLimit,issues,
  attributionComplete:false,limitations:['Polling may miss short-lived descendants.','VmHWM occurrence time is unknown; timestamps record its first observation.','No simultaneous RSS sum or sampled peak replaces GNU time ru_maxrss.'],
  processes:[...rows.values()].sort((a,b)=>b.peakObservedHwmKiB-a.peakObservedHwmKiB)})};
}
