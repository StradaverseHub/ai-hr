/** Read-only attribution. GNU time remains the sole authoritative build RSS verdict. */
import assert from 'node:assert/strict';
import {readdirSync,readFileSync,openSync,readSync,closeSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';

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
 function sample({captureCurrent=false}={}){
  const observationStartedAtMs=now(),currentProcesses=[];
  const elapsed=now()-began;samples++;if(lastSample!==null)maxSampleGapMs=Math.max(maxSampleGapMs,elapsed-lastSample);lastSample=elapsed;
  const snapshot=()=>({observationStartedAtMs,observationEndedAtMs:now(),rootIdentity:rootKey,attributionComplete:false,
   issues:{...issues},processes:currentProcesses});
  if(!rootKey)return captureCurrent?snapshot():undefined;
  const current=new Map();let pids;
  try{pids=io.pids();assert(Array.isArray(pids));}catch{issue('process_inventory_gap');return captureCurrent?snapshot():undefined;}
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
    if(captureCurrent)currentProcesses.push({pid:row.pid,parentPid:live.parentPid,starttime:row.starttime,kind:row.kind,rssKiB:memory.rssKiB});
    row.peakObservedRssKiB=Math.max(row.peakObservedRssKiB,memory.rssKiB);
    if(memory.hwmKiB>row.peakObservedHwmKiB){row.peakObservedHwmKiB=memory.hwmKiB;row.hwmFirstObservedMs=elapsed;}
   }catch{issue('owned_memory_read_gap');}
  }
  return captureCurrent?snapshot():undefined;
 }
 return {sample,noteFailure:()=>issue('observer_sampling_error'),report:()=>({kind:'OBSERVED_BUILD_PROCESS_MEMORY_NOT_ACCEPTANCE',releaseAuthorized:false,rootPid,rootIdentity:rootKey,samples,maxSampleGapMs,rowLimit,scanLimit,issues,
  attributionComplete:false,limitations:['Polling may miss short-lived descendants.','VmHWM occurrence time is unknown; timestamps record its first observation.','No simultaneous RSS sum or sampled peak replaces GNU time ru_maxrss.'],
  processes:[...rows.values()].sort((a,b)=>b.peakObservedHwmKiB-a.peakObservedHwmKiB)})};
}

const buildStages=new Set(['start','compile','compile-server','webpack-compile-edge-server','webpack-compile-client','type-checking','static-generation']);
/** Only this one public enum is retained, never Next buildOptions or raw diagnostic text. */
export function nextBuildStage(text){
 assert(typeof text==='string'&&Buffer.byteLength(text)<=65536);
 const value=JSON.parse(text)?.buildStage;
 return buildStages.has(value)?value:null;
}
const phasePatterns=[
 ['compile-start',/^\s*Creating an optimized production build\b/],
 ['compile-finish',/^(?:\s|✓)*Compiled successfully\b/],
 ['typescript-start',/^\s*Running TypeScript\b/],
 ['typescript-finish',/^\s*Finished TypeScript\b/],
 ['page-collect',/^\s*Collecting page data using \d+ workers?\b/],
 ['static-generation',/^(?:\s|✓)*Generating static pages using \d+ workers?\b/],
 ['cache-finish',/^(?:\s|✓)*Finished writing to filesystem cache\b/],
 ['finalize',/^\s*Finalizing page optimization\b/],
];
const kinds=new Set(['other','next','tsc','dedupe','pnpm']);
const observerIssueKeys=['root_identity_unavailable','process_inventory_gap','process_scan_limit','process_scan_read_gap','owned_identity_gap','pid_reused','parent_identity_gap','lifetime_row_limit','owned_classification_gap','owned_memory_read_gap','observer_sampling_error'];
const hostFields=['MemTotal','MemFree','MemAvailable','Buffers','Cached','SReclaimable','Shmem','Dirty','Writeback','SwapTotal','SwapFree','Slab','PageTables','KernelStack'];
/** Bounded diagnostic history only: its omissions/failures never change the existing memory verdict. */
export function createBuildMemoryTimeline(binding,{now=Date.now,sampleLimit=512,processLimit=64,phaseLimit=64,lineLimit=2048}={}){
 for(const [n,max]of [[sampleLimit,512],[processLimit,64],[phaseLimit,64],[lineLimit,2048]])assert(Number.isSafeInteger(n)&&n>0&&n<=max);
 const safe=(v,re)=>typeof v==='string'&&re.test(v)?v:null;
 const identity={source:safe(binding.source,/^[a-f0-9]{40}$/),controller:safe(binding.controller,/^[a-f0-9]{40}$/),
  runId:safe(binding.runId,/^\d{1,20}$/),attempt:safe(binding.attempt,/^\d{1,20}$/),
  job:['build','linux-build','production-renderer'].includes(binding.job)?binding.job:null};
 const startedAtMs=now(),history=[],phases=[],issues={},streams={stdout:{decoder:new StringDecoder('utf8'),line:'',dropping:false},stderr:{decoder:new StringDecoder('utf8'),line:'',dropping:false}};
 let totalSamples=0,minSample=null,lastAtMs=null,maxSampleGapMs=0,lastPhase=null;
 const noteFailure=key=>{assert(['host_read','owned_read','diagnostics_read','phase_read','output_drain_timeout','output_cleanup_failure','sample_truncated','processes_truncated','phases_truncated','line_truncated','clock_regression'].includes(key));issues[key]=(issues[key]??0)+1;};
 function phaseLine(line,channel){
  const clean=line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  const phase=phasePatterns.find(([,pattern])=>pattern.test(clean))?.[0];
  if(!phase||phase===lastPhase)return;
  lastPhase=phase;
  if(phases.length<phaseLimit)phases.push({atMs:now(),phase,channel});else noteFailure('phases_truncated');
 }
 function consume(channel,chunk){
  assert(Object.hasOwn(streams,channel)&&Buffer.isBuffer(chunk));
  const state=streams[channel];
  for(let offset=0;offset<chunk.length;offset+=4096){
   const text=state.decoder.write(chunk.subarray(offset,offset+4096));
   for(const char of text){
    if(char==='\n'||char==='\r'){if(!state.dropping)phaseLine(state.line,channel);state.line='';state.dropping=false;}
    else if(!state.dropping){if(state.line.length>=lineLimit){state.line='';state.dropping=true;noteFailure('line_truncated');}else state.line+=char;}
   }
  }
 }
 function sample({atMs,hostReadEndedAtMs,meminfo,owned,diagnostics}){
  assert(Number.isSafeInteger(atMs)&&typeof meminfo==='string'&&meminfo.length<=65536);
  const memory={};
  for(const field of hostFields){const match=meminfo.match(new RegExp('^'+field+':\\s+(\\d+) kB$','m'));if(match&&Number.isSafeInteger(Number(match[1])))memory[field+'KiB']=Number(match[1]);}
  assert(Number.isSafeInteger(memory.MemAvailableKiB));
  if(lastAtMs!==null){if(atMs<lastAtMs)noteFailure('clock_regression');else maxSampleGapMs=Math.max(maxSampleGapMs,atMs-lastAtMs);}lastAtMs=atMs;
  const processes=[];let processesTruncated=false;
  if(!owned)noteFailure('owned_read');
  else for(const p of owned.processes){
   if(processes.length===processLimit){processesTruncated=true;noteFailure('processes_truncated');break;}
   assert(Number.isSafeInteger(p.pid)&&p.pid>1&&Number.isSafeInteger(p.parentPid)&&p.parentPid>=0&&/^\d{1,20}$/.test(p.starttime)&&kinds.has(p.kind)&&Number.isSafeInteger(p.rssKiB)&&p.rssKiB>=0);
   processes.push({pid:p.pid,parentPid:p.parentPid,starttime:p.starttime,kind:p.kind,rssKiB:p.rssKiB});
  }
  const stage=diagnostics?.stage;
  const ownedIssues={};for(const key of observerIssueKeys)if(Number.isSafeInteger(owned?.issues?.[key])&&owned.issues[key]>0)ownedIssues[key]=owned.issues[key];
  const time=value=>Number.isSafeInteger(value)?value:null;
  const row={atMs,hostReadEndedAtMs:time(hostReadEndedAtMs),hostMemory:memory,lastOutputMarker:lastPhase,
   nextDiagnostics:{status:['read','unavailable','failed'].includes(diagnostics?.status)?diagnostics.status:'failed',lastReportedBuildStage:buildStages.has(stage)?stage:null,
    observedAtMs:atMs,modifiedAtMs:Number.isSafeInteger(diagnostics?.modifiedAtMs)?diagnostics.modifiedAtMs:null},
   owned:{observationStartedAtMs:time(owned?.observationStartedAtMs),observationEndedAtMs:time(owned?.observationEndedAtMs),
    rootIdentity:safe(owned?.rootIdentity,/^\d{1,10}:\d{1,20}$/),processes,processesTruncated,attributionComplete:false,issues:owned?ownedIssues:{unavailable:1}}};
  totalSamples++;
  if(!minSample||memory.MemAvailableKiB<minSample.hostMemory.MemAvailableKiB)minSample=row;
  if(history.length<sampleLimit)history.push(row);else noteFailure('sample_truncated');
 }
 return {consume,sample,noteFailure,finish:()=>{for(const [channel,state]of Object.entries(streams)){const tail=state.decoder.end();if(!state.dropping){if(state.line.length+tail.length<=lineLimit)phaseLine(state.line+tail,channel);else noteFailure('line_truncated');}state.line='';}},
  report:()=>({kind:'BOUNDED_BUILD_MEMORY_TIMELINE_NOT_ACCEPTANCE',releaseAuthorized:false,binding:identity,bindingComplete:Object.values(identity).every(Boolean),
   runtime:{node:process.version,arch:process.arch,platform:process.platform},runnerImage:{ImageOS:safe(binding.imageOS,/^[A-Za-z0-9._-]{1,32}$/),ImageVersion:safe(binding.imageVersion,/^[A-Za-z0-9._-]{1,64}$/)},
   environmentScope:'Measured command inherits its existing environment unchanged. This metadata does not assert renderer auth/closed-DB-URL/Playwright-OS-dependency parity.',
   startedAtMs,endedAtMs:now(),sampleLimit,processLimit,phaseLimit,lineLimit,totalSamples,maxSampleGapMs,truncated:Boolean(issues.sample_truncated||issues.processes_truncated||issues.phases_truncated||issues.line_truncated||issues.output_drain_timeout),issues:{...issues},
   minimumSample:minSample,samples:history,outputPhaseMarkers:phases,attributionComplete:false,
   limitations:['Host memory and owned status are sequential reads in one callback, not an atomic physical-memory snapshot.','Owned rows contain current VmRSS, never HWM sums; shared pages may appear in multiple processes.','Next diagnostics are last reported stages, possibly stale; stdout/stderr markers record receipt time, not internal transition time.','Polling/bounds/read gaps may omit processes or phase markers; no whole-host process attribution, PSS or acceptance claim.']})};
}

/** Node piping retains backpressure and forwards original bytes; the parser retains enums only. */
export function forwardBuildOutput(stream,target,timeline,channel){
 const observe=chunk=>{try{timeline?.consume(channel,chunk);}catch{try{timeline?.noteFailure('phase_read');}catch{}}};
 stream.on('data',observe);
 stream.pipe(target,{end:false});
 return ()=>{stream.off('data',observe);stream.unpipe(target);stream.destroy();};
}

/** Bound post-exit reader ownership too, not only the wait for inherited output FDs to close. */
export function createBuildOutputDrain(child,disconnects,timeline,{timeoutMs=1000}={}){
 assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=1000&&disconnects.length===2);
 let closed=false,timer,childClose;
 const outputClosed=new Promise(done=>{childClose=()=>{closed=true;done(true);};child.once('close',childClose);});
 // Retain exactly our listener so an inherited FD timeout cannot leave it attached.
 return async()=>{
  try{
   const drained=closed||await Promise.race([outputClosed,new Promise(done=>{timer=setTimeout(()=>done(false),timeoutMs);})]);
   if(!drained){
    try{timeline?.noteFailure('output_drain_timeout');}catch{}
    for(const disconnect of disconnects)try{disconnect();}catch{try{timeline?.noteFailure('output_cleanup_failure');}catch{}}
   }
   return Boolean(drained);
  }finally{clearTimeout(timer);child.off('close',childClose);}
 };
}
