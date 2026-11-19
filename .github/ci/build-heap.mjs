/** Bounded `next build` heap admission and memory telemetry. Never a release, deployment or typecheck authority.
 *
 * The canonical `next build` heap is 6144 MB. This module admits exactly one larger value, 8192 MB, and only for
 * the `next build` step on a standard GitHub-hosted 16 GB Linux runner. Every other place keeps 6144 (or its
 * existing value) untouched.
 *
 * OWNER REVIEW REQUIRED: BUILD_HEAP_CEILING_MB is a hard ceiling. Raising it, admitting another value, widening
 * the runner class, or relaxing the peak-RSS budget needs explicit owner review recorded in
 * docs/reviews/build-capacity-8192-proposal.md (or a superseding ADR). Any value above the ceiling fails closed.
 * Rollback: revert the commit that introduced this file; every caller returns to --max-old-space-size=6144.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,appendFileSync,existsSync,openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBuildProcessObserver,createBuildMemoryTimeline,nextBuildStage,forwardBuildOutput,createBuildOutputDrain} from './build-process-memory.mjs';

export const BUILD_HEAP_DEFAULT_MB=6144;
export const BUILD_HEAP_CEILING_MB=8192; // Hard ceiling. Changing it needs owner review.
export const BUILD_HEAP_PROFILE='hosted-linux-16g-8192';
export const BUILD_HEAP_NODE_OPTIONS='--max-old-space-size='+BUILD_HEAP_CEILING_MB;
export const DEFAULT_BUILD_NODE_OPTIONS='--max-old-space-size='+BUILD_HEAP_DEFAULT_MB;
// Standard public GitHub-hosted ubuntu-24.04 runners report ~16 GB (MemTotal ~15.6 GiB). Larger or smaller
// machines are a different runner class and are refused rather than silently given the larger heap.
export const RUNNER_MEMTOTAL_MIN_KIB=15*1024**2;
export const RUNNER_MEMTOTAL_MAX_KIB=17*1024**2;
// Peak RSS budget for the largest single build process (GNU time ru_maxrss). 8 GiB V8 old space plus young
// generation, code space and native buffers also consume memory. The reviewed 8192 profile admits at most
// 12.5 GiB single-process RSS and additionally requires sampled MemAvailable >=1.5 GiB. The default
// 6144 profile retains its original 12 GiB RSS limit. See the owner decision in the capacity review.
export const BUILD_RSS_WARN_KIB=10*1024**2;
export const BUILD_RSS_DEFAULT_FAIL_KIB=12*1024**2;
export const BUILD_RSS_FAIL_KIB=12.5*1024**2;
export const BUILD_MEM_AVAILABLE_MIN_KIB=1.5*1024**2;

export function parseMemTotalKiB(meminfo){
 const m=typeof meminfo==='string'?meminfo.match(/^MemTotal:\s+(\d+) kB$/m):null;
 assert(m,'Actual /proc/meminfo MemTotal required');
 const kib=Number(m[1]);assert(Number.isSafeInteger(kib)&&kib>0,'Malformed MemTotal');return kib;
}
export function parseMemAvailableKiB(meminfo){
 const m=typeof meminfo==='string'?meminfo.match(/^MemAvailable:\s+(\d+) kB$/m):null;
 assert(m,'Actual /proc/meminfo MemAvailable required');return Number(m[1]);
}
/** Refuses self-hosted, non-Linux, non-Actions and non-16 GB runners. */
export function assertBuildHeapRunner(e,memTotalKiB){
 assert(e.GITHUB_ACTIONS==='true'&&e.CI==='true','GitHub Actions required for the bounded build heap');
 assert(e.RUNNER_ENVIRONMENT==='github-hosted','Bounded build heap refused: runner is not GitHub-hosted');
 assert(e.RUNNER_OS==='Linux','Bounded build heap refused: runner is not Linux');
 assert(Number.isSafeInteger(memTotalKiB)&&memTotalKiB>=RUNNER_MEMTOTAL_MIN_KIB&&memTotalKiB<=RUNNER_MEMTOTAL_MAX_KIB,
  'Bounded build heap refused: runner MemTotal '+memTotalKiB+' KiB is not the standard 16 GB class');
 return true;
}
/** Exactly 8192 is admitted. Anything above the ceiling fails closed; any other value is unreviewed. */
export function assertRequestedHeapMb(value){
 assert(typeof value==='string'&&/^[1-9][0-9]{0,5}$/.test(value),'Integer build heap MB required');
 const mb=Number(value);
 assert(mb<=BUILD_HEAP_CEILING_MB,'Build heap '+mb+' MB exceeds the '+BUILD_HEAP_CEILING_MB+' MB ceiling; raising it needs owner review');
 assert(mb===BUILD_HEAP_CEILING_MB,'Build heap '+mb+' MB is not a reviewed bounded value');
 return mb;
}
export function admitBuildHeap(e,meminfo){
 const memTotalKiB=parseMemTotalKiB(meminfo);
 assertBuildHeapRunner(e,memTotalKiB);
 const mb=assertRequestedHeapMb(e.AIHR_CI_BUILD_HEAP_MB);
 return {kind:'BOUNDED_NEXT_BUILD_HEAP_ADMISSION_NOT_RELEASE',releaseAuthorized:false,profile:BUILD_HEAP_PROFILE,heapMb:mb,
  nodeOptions:'--max-old-space-size='+mb,memTotalKiB,runner:{environment:e.RUNNER_ENVIRONMENT,os:e.RUNNER_OS,name:e.RUNNER_NAME??null},
  rssBudgetKiB:{warn:BUILD_RSS_WARN_KIB,fail:BUILD_RSS_FAIL_KIB}};
}
/** Environment check used by consumers (canonical build protocol). Returns the admitted heap MB. */
export function assertBuildHeapEnvironment(e){
 if(e.NODE_OPTIONS===DEFAULT_BUILD_NODE_OPTIONS){
  assert(e.AIHR_CI_BUILD_HEAP_PROFILE===undefined,'Default build heap cannot carry a bounded heap profile');
  return BUILD_HEAP_DEFAULT_MB;
 }
 assert(e.NODE_OPTIONS===BUILD_HEAP_NODE_OPTIONS&&e.AIHR_CI_BUILD_HEAP_PROFILE===BUILD_HEAP_PROFILE,'Exact default or admitted bounded build heap required');
 assert(/^[1-9][0-9]{0,9}$/.test(e.AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB??''),'Admitted runner memory required');
 assertBuildHeapRunner(e,Number(e.AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB));
 return BUILD_HEAP_CEILING_MB;
}
/** NODE_OPTIONS for a `next build` child of a step whose own process must keep its normal heap (the browser
 * orchestrator also runs migrations, a server and Chromium). Without an admission it is exactly the default 6144;
 * with the admitted profile (and only on the admitted runner class) it is exactly 8192; a partial or mixed admission
 * fails closed. The same profile, ceiling and runner refusals as every other bounded build step. */
export function admittedBuildNodeOptions(e){
 if(e.AIHR_CI_BUILD_HEAP_PROFILE===undefined){
  assert(e.AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB===undefined,'Partial bounded build heap admission refused');
  return DEFAULT_BUILD_NODE_OPTIONS;
 }
 assertBuildHeapEnvironment({...e,NODE_OPTIONS:BUILD_HEAP_NODE_OPTIONS});
 return BUILD_HEAP_NODE_OPTIONS;
}
export function parseMaxRssKiB(text){
 const m=typeof text==='string'?[...text.matchAll(/^\s*Maximum resident set size \(kbytes\): (\d+)\s*$/gm)]:[];
 assert(m.length>=1,'GNU time maximum resident set size required');
 const kib=Number(m.at(-1)[1]);assert(Number.isSafeInteger(kib)&&kib>0,'Malformed maximum resident set size');return kib;
}
export function rssVerdict(peakKiB,{warn=BUILD_RSS_WARN_KIB,fail=BUILD_RSS_FAIL_KIB}={}){
 assert(Number.isSafeInteger(peakKiB)&&peakKiB>0);
 return peakKiB>fail?'fail':peakKiB>warn?'warn':'within';
}
export function buildMemoryBudget(heapMb){
 assert(heapMb===BUILD_HEAP_DEFAULT_MB||heapMb===BUILD_HEAP_CEILING_MB);
 return heapMb===BUILD_HEAP_CEILING_MB
  ?{rssFailKiB:BUILD_RSS_FAIL_KIB,minAvailableKiB:BUILD_MEM_AVAILABLE_MIN_KIB}
  :{rssFailKiB:BUILD_RSS_DEFAULT_FAIL_KIB,minAvailableKiB:null};
}
export function availableMemoryVerdict(availableKiB){
 return Number.isSafeInteger(availableKiB)&&availableKiB>=BUILD_MEM_AVAILABLE_MIN_KIB?'within':'fail';
}
/** Shared acceptance model for both actual build wrappers; original command status remains separate. */
export function buildMemoryVerdict(heapMb,peakKiB,minAvailableKiB){
 const budget=buildMemoryBudget(heapMb),rss=rssVerdict(peakKiB,{fail:budget.rssFailKiB});
 const available=budget.minAvailableKiB===null?'not_applicable':availableMemoryVerdict(minAvailableKiB);
 return {rssVerdict:rss,availableMemoryVerdict:available,verdict:available==='fail'?'fail':rss};
}
const gib=kib=>(kib/1024**2).toFixed(2)+' GiB';

// Fixed job-local Next metadata only. A partial/concurrent write is diagnostic failure, never a gate waiver.
function readNextBuildDiagnostics(){
 let fd;
 try{
  fd=openSync(join(process.cwd(),'.next/diagnostics/build-diagnostics.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const st=fstatSync(fd);assert(st.isFile()&&st.size>0&&st.size<=65536);
  const bytes=Buffer.alloc(st.size+1),count=readSync(fd,bytes,0,bytes.length,0);assert(count===st.size);
  const stage=nextBuildStage(bytes.subarray(0,count).toString('utf8'));
  return {status:stage?'read':'failed',stage,modifiedAtMs:Math.trunc(st.mtimeMs)};
 }catch(error){return {status:error?.code==='ENOENT'?'unavailable':'failed',stage:null};}
 finally{if(fd!==undefined)closeSync(fd);}
}

async function measure(dir,argv){
 const e=process.env;
 const bounded=assertBuildHeapEnvironment(e)===BUILD_HEAP_CEILING_MB;
 const {rssFailKiB}=buildMemoryBudget(bounded?BUILD_HEAP_CEILING_MB:BUILD_HEAP_DEFAULT_MB);
 assert(argv.length>=1,'Measured command required');
 mkdirSync(dir,{recursive:true,mode:0o700});
 const timeFile=join(dir,'time-v.txt');assert(!existsSync(timeFile),'Fresh memory evidence directory required');
 let observer,processTimer,exit,observerFailure=false,timeline;
 try{timeline=createBuildMemoryTimeline({source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD??e.GITHUB_SHA,runId:e.GITHUB_RUN_ID,attempt:e.GITHUB_RUN_ATTEMPT,job:e.GITHUB_JOB,imageOS:e.ImageOS,imageVersion:e.ImageVersion});}catch{}
 let sampleCount=0,minAvailable=Infinity,minAvailableAtMs=null;
 const diagnosticFailure=key=>{try{timeline?.noteFailure(key);}catch{}};
 const sample=()=>{try{
  const atMs=Date.now(),meminfo=readFileSync('/proc/meminfo','utf8'),hostReadEndedAtMs=Date.now(),a=parseMemAvailableKiB(meminfo);
  if(a<minAvailable)minAvailableAtMs=atMs;minAvailable=Math.min(minAvailable,a);sampleCount++;
  // Same callback, sequential host/status reads; the observation interval is retained, not claimed atomic.
  try{const diagnostics=readNextBuildDiagnostics();if(diagnostics.status==='failed')diagnosticFailure('diagnostics_read');
   timeline?.sample({atMs,hostReadEndedAtMs,meminfo,owned:observer?.sample({captureCurrent:true}),diagnostics});}catch{diagnosticFailure('owned_read');}
 }catch{diagnosticFailure('host_read');}};
 sample();const timer=setInterval(sample,2000);
 const startedAt=new Date().toISOString();
 const child=spawn('/usr/bin/time',['-v','-o',timeFile,...argv],{stdio:['inherit','pipe','pipe'],env:e});
 // Forward both streams byte-for-byte, with pipe backpressure; retain only recognized phase enums.
 const drainOutput=createBuildOutputDrain(child,[forwardBuildOutput(child.stdout,process.stdout,timeline,'stdout'),forwardBuildOutput(child.stderr,process.stderr,timeline,'stderr')],timeline);
 const observe=()=>{try{observer?.sample();}catch{observerFailure=true;try{observer?.noteFailure();}catch{}}};
 try{
  try{observer=createBuildProcessObserver(child.pid);observe();processTimer=setInterval(observe,500);}catch{observerFailure=true;}
  exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});
 }finally{
  clearInterval(timer);clearInterval(processTimer);sample();
  // Do not await diagnostic stream closure indefinitely after the original command exit/sample.
  const outputDrained=await drainOutput();
  try{if(outputDrained)timeline?.finish();if(timeline){const text=JSON.stringify(timeline.report(),null,2)+'\n';assert(Buffer.byteLength(text)<=16*1024**2);writeFileSync(join(dir,'build-memory-timeline.json'),text,{flag:'wx',mode:0o600});}}
  catch{console.log('::warning::Optional bounded build-memory timeline unavailable; original memory verdict remains authoritative');}
  try{observe();const attribution=observer?.report()??{kind:'OBSERVED_BUILD_PROCESS_MEMORY_NOT_ACCEPTANCE',attributionComplete:false,error:'observer_unavailable'};attribution.observerFailure=observerFailure;writeFileSync(join(dir,'build-process-memory.json'),JSON.stringify(attribution,null,2)+'\n',{flag:'wx',mode:0o600});}
  catch{console.log('::warning::Optional build-process attribution unavailable; GNU time verdict remains authoritative');}
 }
 const report={kind:'NEXT_BUILD_MEMORY_TELEMETRY_NOT_RELEASE',releaseAuthorized:false,source:e.AIHR_CI_HEAD??null,controller:e.AIHR_CI_CONTROL_HEAD??e.GITHUB_SHA??null,
  runId:e.GITHUB_RUN_ID??null,job:e.GITHUB_JOB??null,command:argv,nodeOptions:e.NODE_OPTIONS,heapProfile:e.AIHR_CI_BUILD_HEAP_PROFILE??'default-6144',
  memTotalKiB:parseMemTotalKiB(readFileSync('/proc/meminfo','utf8')),startedAt,endedAt:new Date().toISOString(),exitCode:exit.code,signal:exit.signal,
  peakRssKiB:null,peakRssMeasure:'GNU time ru_maxrss: largest single waited descendant process, not the sum of concurrent processes',
  minMemAvailableKiB:Number.isFinite(minAvailable)?minAvailable:null,minMemAvailableAtMs:minAvailableAtMs,memAvailableSamples:sampleCount,rssBudgetKiB:{warn:BUILD_RSS_WARN_KIB,fail:rssFailKiB},
  minMemAvailableBudgetKiB:bounded?BUILD_MEM_AVAILABLE_MIN_KIB:null,availableMemoryVerdict:bounded?availableMemoryVerdict(Number.isFinite(minAvailable)?minAvailable:null):'not_applicable',verdict:null};
 try{report.peakRssKiB=parseMaxRssKiB(readFileSync(timeFile,'utf8'));Object.assign(report,buildMemoryVerdict(bounded?BUILD_HEAP_CEILING_MB:BUILD_HEAP_DEFAULT_MB,report.peakRssKiB,report.minMemAvailableKiB));}catch(error){report.telemetryError=String(error);}
 writeFileSync(join(dir,'build-memory.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 const line=`next build memory: exit=${exit.code}${exit.signal?' signal='+exit.signal:''}; heap=${report.nodeOptions} (${report.heapProfile}); peak RSS=${report.peakRssKiB?gib(report.peakRssKiB):'unknown'}; `
  +`min MemAvailable=${report.minMemAvailableKiB!=null?gib(report.minMemAvailableKiB):'unknown'} of MemTotal ${gib(report.memTotalKiB)}; budget warn>${gib(BUILD_RSS_WARN_KIB)} fail>${gib(rssFailKiB)}${bounded?'; sampled available floor='+gib(BUILD_MEM_AVAILABLE_MIN_KIB):''}; verdict=${report.verdict??'unmeasured'}`;
 console.log(line);if(e.GITHUB_STEP_SUMMARY)try{appendFileSync(e.GITHUB_STEP_SUMMARY,line+'\n');}catch{}
 if(exit.code!==0)return exit.code??1;
 if(report.verdict===null){console.log('::error::Build memory telemetry missing; refusing to treat the build as measured');return 1;}
 if(bounded&&report.availableMemoryVerdict==='fail'){console.log('::error::next build sampled available memory is missing or below the reviewed 1.50 GiB floor');return 1;}
 if(report.verdict==='fail'){console.log(`::error::next build peak RSS ${gib(report.peakRssKiB)} exceeds the ${gib(rssFailKiB)} budget`);return 1;}
 if(report.verdict==='warn')console.log(`::warning::next build peak RSS ${gib(report.peakRssKiB)} exceeds the ${gib(BUILD_RSS_WARN_KIB)} warning budget`);
 return 0;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,...rest]=process.argv.slice(2);
 if(mode==='admit'){
  assert(rest.length===0,'Usage: build-heap.mjs admit');
  const admission=admitBuildHeap(process.env,readFileSync('/proc/meminfo','utf8'));
  const out=process.env.GITHUB_OUTPUT;assert(out,'GITHUB_OUTPUT required');
  appendFileSync(out,`node_options=${admission.nodeOptions}\nheap_profile=${admission.profile}\nmemtotal_kib=${admission.memTotalKiB}\n`);
  console.log(JSON.stringify(admission));
 }else if(mode==='measure'){
  const sep=rest.indexOf('--');assert(sep===1,'Usage: build-heap.mjs measure EVIDENCE_DIR -- COMMAND...');
  measure(rest[0],rest.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{console.error(error);process.exitCode=1;});
 }else throw Error('Usage: build-heap.mjs admit | measure EVIDENCE_DIR -- COMMAND...');
}
