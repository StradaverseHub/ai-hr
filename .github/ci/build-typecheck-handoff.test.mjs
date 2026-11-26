/** Pure fixture probes for the compile-to-typecheck handoff. No process is launched or signalled. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createTypecheckHandoff,handoffProcessKind,HANDOFF_RELEASE_KIB,HANDOFF_MAX_HOLD_MS} from './build-typecheck-handoff.mjs';

const GIB=1024**2;
const stat=(pid,parent,start)=>{const f=Array(20).fill('0');f[0]='S';f[1]=String(parent);f[19]=String(start);return `${pid} (node) ${f.join(' ')}`;};
function fixture(){
 let clock=0;const signals=[],procs=new Map();
 const add=(pid,parent,cmd,rss,start=pid)=>procs.set(pid,{parent,cmd:Buffer.from(cmd),rss,start});
 add(10,1,'/usr/bin/time\0-v\0',2000);add(11,10,'/usr/bin/prlimit\0',2000);add(12,11,'node\0/s/pnpm.cjs\0build\0',90000);
 add(20,12,'next-build (v16.4.1)\0',10*GIB);
 add(99,1,'node\0/elsewhere/node_modules/typescript/bin/tsc\0SECRET\0',4*GIB);
 const io={pids:()=>[...procs.keys()],stat:pid=>{const p=procs.get(pid);assert(p,'gone');return stat(pid,p.parent,p.start);},
  status:pid=>`VmRSS:\t${procs.get(pid).rss} kB\nVmHWM:\t${procs.get(pid).rss} kB\n`,cmdline:pid=>procs.get(pid).cmd,kill:(pid,signal)=>signals.push([pid,signal])};
 return {io,procs,add,signals,now:()=>clock,tick:ms=>{clock+=ms;}};
}
const tsc=f=>f.add(30,20,'node\0/s/node_modules/typescript/bin/tsc\0--noEmit\0-p\0tsconfig.build.json\0',400000);

test('classifies the retitled next build and the TypeScript CLI by fixed labels only',()=>{
 assert.equal(handoffProcessKind(Buffer.from('next-build (v16.4.1)\0')),'next');
 assert.equal(handoffProcessKind(Buffer.from('node\0/s/node_modules/typescript/bin/tsc\0')),'tsc');
 assert.equal(handoffProcessKind(Buffer.from('node\0/s/other.mjs\0')),'other');
 assert.equal(HANDOFF_RELEASE_KIB,2*GIB);assert.equal(HANDOFF_MAX_HOLD_MS,90000);
});
test('pauses an owned tsc while its next parent still holds compiler memory and resumes once next releases it',()=>{
 const f=fixture(),h=createTypecheckHandoff(10,{io:f.io,now:f.now});
 h.poll();assert.deepEqual(f.signals,[]);assert.equal(h.report().state,'watching');
 tsc(f);h.poll();assert.deepEqual(f.signals,[[30,'SIGSTOP']]);assert.equal(h.report().state,'holding');assert.equal(h.report().parentRssAtHoldKiB,10*GIB);
 f.tick(4000);f.procs.get(20).rss=9*GIB;h.poll();assert.equal(f.signals.length,1);
 f.tick(4000);f.procs.get(20).rss=300000;h.poll();
 assert.deepEqual(f.signals,[[30,'SIGSTOP'],[30,'SIGCONT']]);
 const r=h.release();assert.equal(r.state,'released');assert.equal(r.releaseReason,'parent_released');assert.equal(r.holdMs,8000);assert.equal(r.parentRssAtReleaseKiB,300000);
 h.poll();assert.equal(f.signals.length,2,'one handoff per build');
 assert(!JSON.stringify(r).includes('SECRET')&&!JSON.stringify(r).includes('tsconfig'));
});
test('never touches a tsc outside the owned tree or under a non-next parent, and skips when next already released',()=>{
 const f=fixture(),h=createTypecheckHandoff(10,{io:f.io,now:f.now});h.poll();
 f.add(31,12,'node\0/s/node_modules/typescript/bin/tsc\0',400000);h.poll();
 assert.deepEqual(f.signals,[]);
 const g=fixture(),k=createTypecheckHandoff(10,{io:g.io,now:g.now});g.procs.get(20).rss=HANDOFF_RELEASE_KIB;tsc(g);k.poll();
 assert.deepEqual(g.signals,[]);assert.equal(k.report().state,'not_needed');
});
test('bounded hold: maximum time, exited parent, exited or reused tsc and final release all resume or skip safely',()=>{
 const max=fixture(),a=createTypecheckHandoff(10,{io:max.io,now:max.now,maxHoldMs:1000});tsc(max);a.poll();max.tick(1000);a.poll();
 assert.deepEqual(max.signals.at(-1),[30,'SIGCONT']);assert.equal(a.report().releaseReason,'max_hold');
 const gone=fixture(),b=createTypecheckHandoff(10,{io:gone.io,now:gone.now});tsc(gone);b.poll();gone.procs.delete(20);b.poll();
 assert.deepEqual(gone.signals.at(-1),[30,'SIGCONT']);assert.equal(b.report().releaseReason,'parent_exited');
 const reused=fixture(),c=createTypecheckHandoff(10,{io:reused.io,now:reused.now});tsc(reused);c.poll();reused.procs.get(30).start=777;c.poll();
 assert.deepEqual(reused.signals,[[30,'SIGSTOP']],'a reused pid is never signalled');assert.equal(c.report().releaseReason,'typecheck_exited');
 const final=fixture(),d=createTypecheckHandoff(10,{io:final.io,now:final.now});tsc(final);d.poll();
 assert.equal(d.release('build_exited').releaseReason,'build_exited');assert.deepEqual(final.signals.at(-1),[30,'SIGCONT']);
 const none=fixture(),e=createTypecheckHandoff(10,{io:none.io,now:none.now});assert.equal(e.release().state,'not_observed');
 const broken=fixture();broken.io.pids=()=>{throw Error('no proc');};const x=createTypecheckHandoff(10,{io:broken.io,now:broken.now});x.poll();assert(x.report().issues.poll_gap>0);
});
test('both reviewed build wrappers use the handoff and keep the floor and RSS budget assertions',()=>{
 const read=name=>readFileSync(fileURLToPath(new URL(name,import.meta.url)),'utf8');
 const canonical=read('./next-application-cache.mjs'),measure=read('./build-heap.mjs');
 assert(canonical.includes("name==='canonical-build'?pid=>{try{handoff=createTypecheckHandoff(pid)"));
 assert(canonical.includes("assert(report.memory.availableMemoryVerdict!=='fail','Canonical next build sampled available memory missing or below reviewed floor');"));
 assert(measure.includes('handoff=createTypecheckHandoff(child.pid)')&&measure.includes("bounded&&report.availableMemoryVerdict==='fail'"));
});
