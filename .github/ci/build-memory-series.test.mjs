/** Pure fixture probes for the diagnostic build memory series. No build, process or runner change. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMeminfoFields,parsePressure,parseVmstat,parseProcessResidency,createMemorySeries,SERIES_PROCESS_MIN_KIB} from './build-memory-series.mjs';

const meminfo=(available,swapFree=4194300)=>`MemTotal:       16078424 kB\nMemFree:          300000 kB\nMemAvailable:   ${available} kB\nCached:          900000 kB\nSwapTotal:       4194300 kB\nSwapFree:        ${swapFree} kB\nShmem:             1000 kB\n`;
const stat=(pid,parent,name)=>{const f=Array(20).fill('0');f[0]='S';f[1]=String(parent);f[19]='7';return `${pid} (${name}) ${f.join(' ')}`;};
function fixture(){
 let clock=0,available=5000000,swapFree=4194300;
 const procs=new Map([
  [100,{parent:90,name:'next-build (v16',cmd:'next-build (v16.4.1)\0',rss:9000000,swap:0}],
  [200,{parent:100,name:'node',cmd:'node\0/s/node_modules/typescript/bin/tsc\0--noEmit\0SECRET\0',rss:6000000,swap:0}],
  [300,{parent:1,name:'dockerd',cmd:'/usr/bin/dockerd\0SECRET\0',rss:120000,swap:0}],
 ]);
 const io={meminfo:()=>meminfo(available,swapFree),pressure:()=>'some avg10=1.50 avg60=0.40 avg300=0.10 total=900\nfull avg10=0.25 avg60=0.00 avg300=0.00 total=100\n',
  vmstat:()=>`pswpin 10\npswpout ${4194300-swapFree}\npgmajfault 5\noom_kill 0\n`,pids:()=>[...procs.keys()],
  stat:pid=>stat(pid,procs.get(pid).parent,procs.get(pid).name),status:pid=>`VmRSS:\t${procs.get(pid).rss} kB\nVmSwap:\t${procs.get(pid).swap} kB\n`,
  cmdline:pid=>Buffer.from(procs.get(pid).cmd)};
 return {io,procs,now:()=>clock,advance:(ms,a,s)=>{clock+=ms;available=a;swapFree=s??swapFree;}};
}
test('parsers read fixed kernel fields and refuse missing MemAvailable',()=>{
 assert.deepEqual(parseMeminfoFields(meminfo(1500000,1000)),{memTotalKiB:16078424,memFreeKiB:300000,memAvailableKiB:1500000,cachedKiB:900000,swapTotalKiB:4194300,swapFreeKiB:1000,shmemKiB:1000});
 assert.throws(()=>parseMeminfoFields('MemTotal: 1 kB\n'));
 assert.deepEqual(parsePressure('some avg10=2.00 avg60=1.00 avg300=0.00 total=5\n'),{some:{avg10:2,totalUs:5}});
 assert.deepEqual(parseVmstat('pswpin 1\npswpout 2\npgmajfault 3\noom_kill 0\nother 9\n'),{pswpin:1,pswpout:2,pgmajfault:3,oom_kill:0});
 assert.deepEqual(parseProcessResidency('VmRSS:\t12 kB\n'),{rssKiB:12,swapKiB:0});
});
test('series keeps the minimum, its large processes and swap use, without exporting argv',()=>{
 const f=fixture(),series=createMemorySeries({io:f.io,now:f.now});
 series.sample('before');f.advance(2000,1400000,1194300);f.procs.get(100).swap=3000000;series.sample();f.advance(2000,2600000);series.sample('after');
 const r=series.report();
 assert.equal(r.samples,3);assert.equal(r.minMemAvailableKiB,1400000);assert.equal(r.minAt.ms,2000);assert.equal(r.minAt.swapUsedKiB,3000000);
 assert.equal(r.maxSwapUsedKiB,3000000);assert.equal(r.vmstatDelta.pswpout,3000000);assert.equal(r.releaseAuthorized,false);
 assert.deepEqual(r.minAt.processes.map(p=>[p.pid,p.kind,p.name]),[[100,'next','next-build (v16'],[200,'tsc','node']]);
 assert(!JSON.stringify(r).includes('SECRET'));
 assert(r.rows[0].processes.every(p=>p.rssKiB+p.swapKiB>=SERIES_PROCESS_MIN_KIB));
});
test('unreadable inputs are recorded as issues and never throw; rows are bounded',()=>{
 const f=fixture();f.io.pressure=()=>{throw Error('no psi');};f.io.status=()=>'malformed';
 const series=createMemorySeries({io:f.io,now:f.now,rowLimit:1});series.sample();series.sample();
 const r=series.report();assert.equal(r.samples,1);assert(r.issues.pressure_unavailable>0&&r.issues.row_limit>0);assert.deepEqual(r.rows[0].processes,[]);
 f.io.meminfo=()=>'';const empty=createMemorySeries({io:f.io,now:f.now});empty.sample();assert(empty.report().issues.meminfo_gap>0);assert.equal(empty.report().minMemAvailableKiB,null);
});
