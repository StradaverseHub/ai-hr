/** Pure bounded-heap admission/refusal probes. No build, compiler or runner change. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {BUILD_HEAP_CEILING_MB,BUILD_HEAP_DEFAULT_MB,BUILD_HEAP_PROFILE,BUILD_HEAP_NODE_OPTIONS,BUILD_RSS_WARN_KIB,BUILD_RSS_FAIL_KIB,
 parseMemTotalKiB,parseMaxRssKiB,assertBuildHeapRunner,assertRequestedHeapMb,admitBuildHeap,assertBuildHeapEnvironment,rssVerdict} from './build-heap.mjs';
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
test('GNU time maximum RSS is parsed and judged against the stated budget',()=>{
 const text='\tCommand being timed: "pnpm build"\n\tMaximum resident set size (kbytes): 9123456\n\tExit status: 0\n';
 assert.equal(parseMaxRssKiB(text),9123456);assert.throws(()=>parseMaxRssKiB('no rss here'));
 assert.equal(parseMemTotalKiB(hosted16),16374980);
 assert.equal(rssVerdict(9*1024**2),'within');assert.equal(rssVerdict(10*1024**2+1),'warn');assert.equal(rssVerdict(12*1024**2+1),'fail');
});
test('bounded heap is wired only into the two next build steps; typecheck, diagnostics and native jobs keep their heaps',()=>{
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
});
