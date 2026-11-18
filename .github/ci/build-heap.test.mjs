/** Pure bounded-heap admission/refusal probes. No build, compiler or runner change. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {parseProcessStat,parseProcessMemory,buildProcessKind,createBuildProcessObserver} from './build-process-memory.mjs';
import {BUILD_HEAP_CEILING_MB,BUILD_HEAP_DEFAULT_MB,BUILD_HEAP_PROFILE,BUILD_HEAP_NODE_OPTIONS,BUILD_RSS_WARN_KIB,BUILD_RSS_FAIL_KIB,
 parseMemTotalKiB,parseMaxRssKiB,assertBuildHeapRunner,assertRequestedHeapMb,admitBuildHeap,assertBuildHeapEnvironment,admittedBuildNodeOptions,rssVerdict} from './build-heap.mjs';

const processStat=(pid,parent,start,name='node')=>{const fields=Array(20).fill('0');fields[0]='S';fields[1]=String(parent);fields[19]=String(start);return `${pid} (${name}) ${fields.join(' ')}`;};
function processFixture(){
 const rows=new Map(),readCommands=[];let clock=0;
 const add=(pid,parent,start,script='/source/node_modules/next/dist/bin/next')=>rows.set(pid,{parent,start,command:Buffer.from(`node\0${script}\0build\0SECRET_ARGUMENT\0`),memory:'VmRSS:\t100 kB\nVmHWM:\t150 kB\n'});
 const io={pids:()=>[...rows.keys()],stat:pid=>{const r=rows.get(pid);assert(r,'gone');return processStat(pid,r.parent,r.start);},status:pid=>rows.get(pid).memory,cmdline:pid=>{readCommands.push(pid);return rows.get(pid).command;}};
 return {rows,readCommands,add,io,now:()=>clock,tick:()=>{clock+=500;}};
}
test('process metadata parses stat names with parentheses and refuses malformed memory',()=>{
 assert.deepEqual(parseProcessStat(processStat(200,100,321,'name ) ( with spaces')),{pid:200,parentPid:100,starttime:'321',state:'S'});
 assert.deepEqual(parseProcessMemory('VmRSS:\t100 kB\nVmHWM:\t150 kB\n'),{rssKiB:100,hwmKiB:150});
 for(const value of ['', 'VmRSS: 12 MB\nVmHWM: 20 kB', 'VmRSS: 12 kB'])assert.throws(()=>parseProcessMemory(value));
 assert.throws(()=>parseProcessStat('200 invalid stat'));
});
test('classification emits only fixed labels, including the detached TypeScript CLI and deduper',()=>{
 const command=script=>Buffer.from(`node\0${script}\0build\0SECRET\0`);
 assert.equal(buildProcessKind(command('/source/node_modules/typescript/bin/tsc')),'tsc');
 assert.equal(buildProcessKind(command('/source/node_modules/typescript/lib/tsc.js')),'tsc');
 assert.equal(buildProcessKind(command('/source/node_modules/next/dist/bin/next')),'next');
 assert.equal(buildProcessKind(command('scripts/dedupe-server-source-maps.mjs')),'dedupe');
 assert.equal(buildProcessKind(command('/source/pnpm.cjs')),'pnpm');
 assert.equal(buildProcessKind(command('/private/SECRET.mjs')),'other');
 assert.throws(()=>buildProcessKind(Buffer.alloc(4097)));
});
test('observer proves ancestry before command reads and never exports argv or environment',()=>{
 const f=processFixture();f.add(100,90,10);f.add(200,100,20);f.add(300,1,30,'/private/SECRET.mjs');
 const observer=createBuildProcessObserver(100,{io:f.io,now:f.now,expectedParentPid:90});observer.sample();
 assert.deepEqual(new Set(f.readCommands),new Set([100,200]));
 const report=observer.report();assert.equal(report.processes.length,2);assert.equal(report.processes[0].peakObservedHwmKiB,150);
 assert(!JSON.stringify(report).includes('SECRET'));assert.equal(report.attributionComplete,false);
 assert.equal(rssVerdict(BUILD_RSS_FAIL_KIB+1),'fail');
});
test('retained child identity survives reparenting but a reused PID needs fresh ancestry',()=>{
 const f=processFixture();f.add(100,90,10);f.add(200,100,20);
 const observer=createBuildProcessObserver(100,{io:f.io,now:f.now,expectedParentPid:90});observer.sample();
 f.tick();f.rows.get(200).parent=1;observer.sample();assert.equal(observer.report().processes.find(p=>p.pid===200).lastParentPid,1);
 f.tick();f.add(200,1,99,'/private/SECRET.mjs');observer.sample();
 assert.equal(f.readCommands.filter(pid=>pid===200).length,1);assert(observer.report().issues.pid_reused>0);
 f.tick();f.add(200,100,100,'scripts/dedupe-server-source-maps.mjs');observer.sample();
 assert.equal(observer.report().processes.filter(p=>p.pid===200).length,2);
 assert.equal(observer.report().processes.find(p=>p.pid===200&&p.starttime==='100').kind,'dedupe');
});
test('observer records disappearing and unreadable processes and enforces finite rows and scans',()=>{
 const f=processFixture();f.add(100,90,10);f.add(200,100,20);f.add(201,200,30);
 const observer=createBuildProcessObserver(100,{io:f.io,now:f.now,expectedParentPid:90,rowLimit:2});observer.sample();
 assert.equal(observer.report().processes.length,2);assert(observer.report().issues.lifetime_row_limit>0);
 f.tick();f.rows.get(200).memory='malformed';observer.sample();assert(observer.report().issues.owned_memory_read_gap>0);
 f.tick();f.rows.delete(200);observer.sample();assert(observer.report().processes.find(p=>p.pid===200).exitedSeenMs!==undefined);
 const limited=createBuildProcessObserver(100,{io:f.io,now:f.now,expectedParentPid:90,scanLimit:1});limited.sample();assert(limited.report().issues.process_scan_limit>0);
 const absent=createBuildProcessObserver(999,{io:f.io,now:f.now,expectedParentPid:90});absent.sample();assert(absent.report().issues.root_identity_unavailable>0);
 const wrongParent=createBuildProcessObserver(100,{io:f.io,now:f.now,expectedParentPid:91});wrongParent.sample();assert(wrongParent.report().issues.root_identity_unavailable>0);
});
import {readdirSync} from 'node:fs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const hosted16='MemTotal:       16374980 kB\nMemFree:         1000000 kB\nMemAvailable:   15000000 kB\n';
const e={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',AIHR_CI_BUILD_HEAP_MB:'8192'};
test('ceiling stays 8192 and default stays 6144 (changing either needs owner review)',()=>{
 assert.equal(BUILD_HEAP_CEILING_MB,8192);assert.equal(BUILD_HEAP_DEFAULT_MB,6144);assert.equal(BUILD_HEAP_NODE_OPTIONS,'--max-old-space-size=8192');
 assert.equal(BUILD_RSS_WARN_KIB,10*1024**2);assert.equal(BUILD_RSS_FAIL_KIB,12*1024**2);
});
test('admits exactly 8192 on a GitHub-hosted 16 GB Linux runner',()=>{
 const a=admitBuildHeap(e,hosted16);
 assert.equal(a.nodeOptions,'--max-old-space-size=8192');assert.equal(a.profile,BUILD_HEAP_PROFILE);assert.equal(a.memTotalKiB,16374980);assert.equal(a.releaseAuthorized,false);
});
test('refuses self-hosted, non-Linux, non-Actions and other memory classes',()=>{
 for(const patch of [{RUNNER_ENVIRONMENT:'self-hosted'},{RUNNER_ENVIRONMENT:undefined},{RUNNER_OS:'macOS'},{RUNNER_OS:'Windows'},{GITHUB_ACTIONS:undefined},{CI:'false'}])
  assert.throws(()=>admitBuildHeap({...e,...patch},hosted16));
 for(const total of [7*1024**2,15*1024**2-1,17*1024**2+1,32*1024**2,64*1024**2])
  assert.throws(()=>admitBuildHeap(e,`MemTotal:       ${total} kB\nMemAvailable: 1 kB\n`),/16 GB class/);
 assert.throws(()=>admitBuildHeap(e,'garbage'));
 assert.equal(assertBuildHeapRunner(e,15*1024**2),true);assert.equal(assertBuildHeapRunner(e,17*1024**2),true);
});
test('any value above the ceiling fails closed; other values are unreviewed',()=>{
 for(const v of ['8193','12288','16384','999999'])assert.throws(()=>assertRequestedHeapMb(v),/exceeds the 8192 MB ceiling; raising it needs owner review/);
 for(const v of ['6144','7000','4096',undefined,'','8192.0','08192','-8192',' 8192'])assert.throws(()=>assertRequestedHeapMb(v));
 assert.equal(assertRequestedHeapMb('8192'),8192);
 assert.throws(()=>admitBuildHeap({...e,AIHR_CI_BUILD_HEAP_MB:'12288'},hosted16),/owner review/);
});
test('consumer environment check accepts only the exact default or the exact admitted profile',()=>{
 assert.equal(assertBuildHeapEnvironment({NODE_OPTIONS:'--max-old-space-size=6144'}),6144);
 const admitted={...e,NODE_OPTIONS:'--max-old-space-size=8192',AIHR_CI_BUILD_HEAP_PROFILE:BUILD_HEAP_PROFILE,AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:'16374980'};
 assert.equal(assertBuildHeapEnvironment(admitted),8192);
 for(const patch of [{NODE_OPTIONS:'--max-old-space-size=12288'},{NODE_OPTIONS:'--max-old-space-size=8192 --max-old-space-size=16384'},{AIHR_CI_BUILD_HEAP_PROFILE:'other'},{AIHR_CI_BUILD_HEAP_PROFILE:undefined},
  {AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:undefined},{AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:String(32*1024**2)},{RUNNER_ENVIRONMENT:'self-hosted'},{RUNNER_OS:'macOS'}])
  assert.throws(()=>assertBuildHeapEnvironment({...admitted,...patch}));
 assert.throws(()=>assertBuildHeapEnvironment({NODE_OPTIONS:'--max-old-space-size=6144',AIHR_CI_BUILD_HEAP_PROFILE:BUILD_HEAP_PROFILE}));
 assert.throws(()=>assertBuildHeapEnvironment({}));
});
test('child build heap (browser orchestrator) is exactly the default without admission and exactly 8192 with it',()=>{
 assert.equal(admittedBuildNodeOptions({}),'--max-old-space-size=6144');
 assert.equal(admittedBuildNodeOptions({NODE_OPTIONS:'--max-old-space-size=16384'}),'--max-old-space-size=6144');
 const admitted={...e,AIHR_CI_BUILD_HEAP_PROFILE:BUILD_HEAP_PROFILE,AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:'16374980'};
 assert.equal(admittedBuildNodeOptions(admitted),'--max-old-space-size=8192');
 for(const patch of [{AIHR_CI_BUILD_HEAP_PROFILE:'other'},{AIHR_CI_BUILD_HEAP_PROFILE:'hosted-linux-32g-12288'},{AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:undefined},{AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:''},
  {AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:String(64*1024**2)},{RUNNER_ENVIRONMENT:'self-hosted'},{RUNNER_OS:'macOS'},{GITHUB_ACTIONS:undefined}])
  assert.throws(()=>admittedBuildNodeOptions({...admitted,...patch}),undefined,JSON.stringify(patch));
 assert.throws(()=>admittedBuildNodeOptions({AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:'16374980'}),/Partial/);
});
test('GNU time maximum RSS is parsed and judged against the stated budget',()=>{
 const text='\tCommand being timed: "pnpm build"\n\tMaximum resident set size (kbytes): 9123456\n\tExit status: 0\n';
 assert.equal(parseMaxRssKiB(text),9123456);assert.throws(()=>parseMaxRssKiB('no rss here'));
 assert.equal(parseMemTotalKiB(hosted16),16374980);
 assert.equal(rssVerdict(9*1024**2),'within');assert.equal(rssVerdict(10*1024**2+1),'warn');assert.equal(rssVerdict(12*1024**2+1),'fail');
});
test('bounded heap is wired only into the hosted next build steps; typecheck, diagnostics and native jobs keep their heaps',()=>{
 const focused=readFileSync(join(root,'.github/workflows/alpha-focused-checks.yml'),'utf8');
 const staging=readFileSync(join(root,'.github/workflows/alpha-staging.yml'),'utf8');
 const diagnostics=readFileSync(join(root,'.github/workflows/alpha-staging-diagnostics.yml'),'utf8');
 const job=(text,name)=>{const start=text.indexOf('\n  '+name+':\n');assert(start>=0,name);const rest=text.slice(start+1);const next=rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);return next<0?rest:rest.slice(0,next+1);};
 const build=job(focused,'linux-build');
 assert.match(build,/build-heap\.mjs admit/);assert.match(build,/build-heap\.mjs measure "\$RUNNER_TEMP\/next-build-memory" -- pnpm build/);
 assert.match(build,/AIHR_CI_BUILD_HEAP_MB: '8192'/);assert.match(build,/runs-on: ubuntu-24\.04/);assert.doesNotMatch(build,/max-old-space-size=(?!6144)\d+/);
 for(const name of ['typecheck','native-typecheck','native-bundle','selected-tests'])assert.doesNotMatch(job(focused,name),/build-heap|max-old-space-size=8192/,name);
 const canonical=job(staging,'build');
 assert.match(canonical,/NODE_OPTIONS: --max-old-space-size=6144/);assert.match(canonical,/build-heap\.mjs admit/);assert.match(canonical,/runs-on: ubuntu-24\.04/);
 assert.match(canonical,/NODE_OPTIONS: \$\{\{ steps\.build-heap\.outputs\.node_options \}\}/);
 assert.equal((staging.match(/build-heap\.mjs admit/g)??[]).length,1);assert.equal((staging.match(/build-heap\.mjs measure/g)??[]).length,0);assert.equal((staging.match(/AIHR_CI_BUILD_HEAP_MB/g)??[]).length,1);
 assert.doesNotMatch(diagnostics,/build-heap|max-old-space-size=8192/);
 assert.doesNotMatch(staging+focused+diagnostics,/skipLibCheck|ignoreBuildErrors/);
 // Browser orchestrator: the same admission, passed to its `next build` child only; the step itself keeps the normal heap.
 const walkthrough=readFileSync(join(root,'.github/workflows/ai-orchestrator-walkthrough.yml'),'utf8'),renderer=job(walkthrough,'production-renderer');
 assert.match(renderer,/runs-on: ubuntu-24\.04/);assert.match(renderer,/build-heap\.mjs admit/);assert.match(renderer,/AIHR_CI_BUILD_HEAP_MB: '8192'/);
 assert.match(renderer,/AIHR_CI_BUILD_HEAP_PROFILE: \$\{\{ steps\.build-heap\.outputs\.heap_profile \}\}/);
 assert.match(renderer,/AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB: \$\{\{ steps\.build-heap\.outputs\.memtotal_kib \}\}/);
 assert.doesNotMatch(walkthrough,/NODE_OPTIONS|max-old-space-size/);
 const orchestrator=readFileSync(join(root,'.github/ci/orchestrator-browser.mjs'),'utf8');
 assert.doesNotMatch(orchestrator,/max-old-space-size/);assert.match(orchestrator,/admittedBuildNodeOptions\(dbEnv\)/);
 assert.match(orchestrator,/\[buildHeap, 'measure', join\(out, 'next-build-memory'\), '--', 'pnpm', 'build'\]/);
});
test('one identical bounded profile everywhere it applies: every admission is 8192 on a standard hosted ubuntu-24.04 job',()=>{
 const dir=join(root,'.github/workflows'),admitting=[];
 for(const name of readdirSync(dir).filter(n=>/\.ya?ml$/.test(n)).sort()){
  const text=readFileSync(join(dir,name),'utf8');
  assert.doesNotMatch(text,/max-old-space-size=(?:819[3-9]|8[2-9]\d\d|9\d{3}|[1-9]\d{4,})/,name);
  assert.doesNotMatch(text,/self-hosted/,name);
  const requests=[...text.matchAll(/AIHR_CI_BUILD_HEAP_MB:\s*'?([^'\s}]*)'?/g)].map(m=>m[1]);
  if(!/build-heap\.mjs admit/.test(text)){assert.deepEqual(requests,[],name);continue;}
  admitting.push(name);assert.deepEqual(requests,['8192'],name);
  assert.equal((text.match(/build-heap\.mjs admit/g)??[]).length,1,name);
  // The admitting job itself must be a standard hosted ubuntu-24.04 job (build-heap.mjs re-checks at runtime).
  const jobs=text.slice(text.indexOf('\njobs:\n')).split(/\n(?=  [a-z][a-z0-9-]*:\n)/).filter(j=>/build-heap\.mjs admit/.test(j));
  assert.equal(jobs.length,1,name);assert.deepEqual([...jobs[0].matchAll(/runs-on:\s*(\S+)/g)].map(m=>m[1]),['ubuntu-24.04'],name);
  assert.doesNotMatch(jobs[0],/container:|services:/,name);
 }
 assert.deepEqual(admitting,['ai-orchestrator-walkthrough.yml','alpha-focused-checks.yml','alpha-staging.yml']);
});
