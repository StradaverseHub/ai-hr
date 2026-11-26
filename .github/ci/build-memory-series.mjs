/** Diagnostic-only memory time series for a build window. Never an acceptance, release or capacity authority.
 * Records runner-wide MemAvailable/swap/pressure and the resident and swapped size of large processes, by
 * executable name and fixed build-process kind only (no argv or environment is exported). GNU time and the
 * reviewed MemAvailable floor remain the sole build memory verdicts. */
import assert from 'node:assert/strict';
import {readdirSync,readFileSync,openSync,readSync,closeSync} from 'node:fs';
import {parseProcessStat,buildProcessKind} from './build-process-memory.mjs';

export const SERIES_PROCESS_MIN_KIB=256*1024;
export const SERIES_ROW_LIMIT=4096;
const MEMINFO_FIELDS={MemTotal:'memTotalKiB',MemFree:'memFreeKiB',MemAvailable:'memAvailableKiB',Cached:'cachedKiB',SwapTotal:'swapTotalKiB',SwapFree:'swapFreeKiB',Shmem:'shmemKiB'};
export function parseMeminfoFields(text){
 assert(typeof text==='string'&&text.length<=65536);
 const out={};
 for(const [name,key]of Object.entries(MEMINFO_FIELDS)){const m=text.match(new RegExp('^'+name+':\\s+(\\d+) kB$','m'));if(m)out[key]=Number(m[1]);}
 assert(Number.isSafeInteger(out.memAvailableKiB),'MemAvailable required');
 return out;
}
/** /proc/pressure/memory: "some avg10=0.00 avg60=0.00 avg300=0.00 total=123" and the matching "full" line. */
export function parsePressure(text){
 assert(typeof text==='string'&&text.length<=4096);
 const out={};
 for(const kind of ['some','full']){const m=text.match(new RegExp('^'+kind+' avg10=([0-9.]+) avg60=([0-9.]+) avg300=([0-9.]+) total=(\\d+)$','m'));if(m)out[kind]={avg10:Number(m[1]),totalUs:Number(m[4])};}
 return out;
}
export function parseVmstat(text){
 assert(typeof text==='string'&&text.length<=65536);
 const out={};
 for(const name of ['pswpin','pswpout','pgmajfault','oom_kill']){const m=text.match(new RegExp('^'+name+' (\\d+)$','m'));if(m)out[name]=Number(m[1]);}
 return out;
}
export function parseProcessResidency(text){
 assert(typeof text==='string'&&text.length<=65536);
 const value=name=>{const m=text.match(new RegExp('^'+name+':\\s+(\\d+) kB$','m'));return m?Number(m[1]):0;};
 return {rssKiB:value('VmRSS'),swapKiB:value('VmSwap')};
}
const optional=read=>{try{return read();}catch{return null;}};
const systemIo={
 meminfo:()=>readFileSync('/proc/meminfo','utf8'),
 pressure:()=>readFileSync('/proc/pressure/memory','utf8'),
 vmstat:()=>readFileSync('/proc/vmstat','utf8'),
 pids:()=>readdirSync('/proc').filter(x=>/^[1-9]\d*$/.test(x)).map(Number),
 stat:pid=>readFileSync('/proc/'+pid+'/stat','utf8'),
 status:pid=>readFileSync('/proc/'+pid+'/status','utf8'),
 cmdline:pid=>{const fd=openSync('/proc/'+pid+'/cmdline','r');try{const b=Buffer.alloc(4097),n=readSync(fd,b,0,b.length,0);assert(n<=4096);return b.subarray(0,n);}finally{closeSync(fd);}},
};
const comm=stat=>{const start=stat.indexOf(' ('),end=stat.lastIndexOf(')');const name=stat.slice(start+2,end);return /^[\w.:@+() -]{1,15}$/.test(name)?name:'unnamed';};
/** Injected IO permits pure fixtures without launching any processes. */
export function createMemorySeries({io=systemIo,now=Date.now,rowLimit=SERIES_ROW_LIMIT,processMinKiB=SERIES_PROCESS_MIN_KIB}={}){
 const began=now(),rows=[],issues={};let vmstatStart=null,vmstatEnd=null;
 const issue=key=>{issues[key]=(issues[key]??0)+1;};
 const processes=()=>{
  const out=[];let pids;
  try{pids=io.pids();}catch{issue('process_inventory_gap');return out;}
  for(const pid of pids.slice(0,4096)){
   try{
    const residency=parseProcessResidency(io.status(pid));
    if(residency.rssKiB+residency.swapKiB<processMinKiB)continue;
    const stat=io.stat(pid),p=parseProcessStat(stat),name=comm(stat);
    // Next 16 replaces its argv with the fixed title `next-build (vX)` shortly after start.
    let kind='other';try{const cmdline=io.cmdline(pid);kind=/^next-build \(v/.test(cmdline.toString('utf8'))?'next':buildProcessKind(cmdline);}catch{issue('classification_gap');}
    out.push({pid,parentPid:p.parentPid,name,kind,...residency});
   }catch{issue('process_read_gap');}
  }
  return out.sort((a,b)=>b.rssKiB+b.swapKiB-a.rssKiB-a.swapKiB).slice(0,24);
 };
 function sample(label='during'){
  if(rows.length>=rowLimit){issue('row_limit');return;}
  const row={label,ms:now()-began};
  try{Object.assign(row,parseMeminfoFields(io.meminfo()));}catch{issue('meminfo_gap');}
  const pressure=optional(()=>parsePressure(io.pressure()));if(pressure)row.pressure=pressure;else issue('pressure_unavailable');
  const vm=optional(()=>parseVmstat(io.vmstat()));if(vm){row.vmstat=vm;vmstatStart??=vm;vmstatEnd=vm;}
  row.processes=processes();rows.push(row);
 }
 function report(){
  const available=rows.map(r=>r.memAvailableKiB).filter(Number.isSafeInteger),min=available.length?Math.min(...available):null;
  const at=rows.find(r=>r.memAvailableKiB===min);
  const delta=vmstatStart&&vmstatEnd?Object.fromEntries(Object.keys(vmstatEnd).map(k=>[k,vmstatEnd[k]-(vmstatStart[k]??0)])):null;
  return {kind:'BUILD_MEMORY_SERIES_DIAGNOSTIC_NOT_ACCEPTANCE',releaseAuthorized:false,samples:rows.length,issues,minMemAvailableKiB:min,minAt:at?{label:at.label,ms:at.ms,swapUsedKiB:Number.isSafeInteger(at.swapTotalKiB)?at.swapTotalKiB-at.swapFreeKiB:null,processes:at.processes}:null,
   maxSwapUsedKiB:Math.max(0,...rows.filter(r=>Number.isSafeInteger(r.swapTotalKiB)).map(r=>r.swapTotalKiB-r.swapFreeKiB)),vmstatDelta:delta,
   limitations:['Two-second samples cannot establish a continuous minimum.','Process names and fixed kinds only; no argv or environment.'],rows};
 }
 return {sample,report};
}
