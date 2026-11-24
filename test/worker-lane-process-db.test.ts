/** The real import worker process (scripts/bank-import-runner.ts) against real PostgreSQL (ADR 0181 J1.2):
 *  - AIHR_WORKER_LANES starts an all-lane child and one child per lane; each advertises its lanes;
 *  - SIGTERM to the main process stops every child and exits 0;
 *  - a child that dies takes the whole worker down with a non-zero status (systemd Restart=on-failure restarts it);
 *  - losing the database (connection refused, or the server ending the sessions with 57P01 and refusing connections
 *    for a while, as a PostgreSQL restart does) never ends the worker with status 0. On 24 November staging's worker
 *    exited 0 after a PostgreSQL restart and systemd left it down.
 * A TCP proxy between the worker and the test database plays the database restart. */
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import net from 'node:net';
import {WORKER_LANES,laneMarker} from '../core/bulk-job-lanes';
import {WORKER_UNEXPECTED_EXIT_CODE} from '../core/worker-lane-supervisor';
import {closeAll,migrateTestDb,owner,resetDb} from './harness';

type Run={child:ChildProcess;stderr:string[];exit:Promise<{code:number|null;signal:NodeJS.Signals|null}>};
const runs:Run[]=[];
function start(env:Record<string,string|undefined>,args:string[]=[]):Run{
 const child=spawn(process.execPath,['--import','tsx','scripts/bank-import-runner.ts',...args],{cwd:process.cwd(),
  env:{...process.env,DATABASE_URL:process.env.DATABASE_URL,MIGRATION_DATABASE_URL:process.env.MIGRATION_DATABASE_URL,...env},stdio:['ignore','ignore','pipe']});
 const stderr:string[]=[];child.stderr!.on('data',chunk=>stderr.push(String(chunk)));
 const run={child,stderr,exit:new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})))};
 runs.push(run);return run;
}
const text=(run:Run)=>run.stderr.join('');
async function until<T>(what:string,fn:()=>Promise<T|undefined|false>,ms=120_000,cancelled=()=>false):Promise<T>{
 const deadline=Date.now()+ms;
 for(;;){
  if(cancelled())throw new Error(`stopped waiting for ${what}`);
  const value=await fn();if(value)return value;
  if(Date.now()>deadline)throw new Error(`timed out waiting for ${what}`);
  await new Promise(r=>setTimeout(r,250));
 }
}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const beats=()=>owner.client<{pid:number;kinds:string[];beat_at:Date}[]>`select pid,kinds,beat_at from bulk_job_worker where host<>'fixture' order by started_at`;
/** Worker heartbeats of processes that are not `parent` (the children), keyed by the lanes they advertise. */
async function childBeats(parent:number,count:number){
 return until(`${count} child heartbeats`,async()=>{const rows=(await beats()).filter(r=>r.pid!==parent&&alive(r.pid));return rows.length>=count&&rows;});
}

/** A TCP proxy in front of the test database: `outage()` ends every session the way a database restart does (the
 * server terminates the backends, then refuses connections) and `restore()` accepts connections again. */
class DatabaseProxy{
 server=net.createServer(socket=>this.accept(socket));port=0;pairs=new Set<[net.Socket,net.Socket]>();
 constructor(readonly host:string,readonly target:number){}
 async listen(){await new Promise<void>(resolve=>this.server.listen(this.port,'127.0.0.1',resolve));this.port=(this.server.address() as net.AddressInfo).port;}
 accept(socket:net.Socket){
  const upstream=net.connect(this.target,this.host);const pair:[net.Socket,net.Socket]=[socket,upstream];this.pairs.add(pair);
  socket.pipe(upstream);upstream.pipe(socket);
  const end=()=>{this.pairs.delete(pair);socket.destroy();upstream.destroy();};
  socket.on('error',end);upstream.on('error',end);socket.on('close',end);upstream.on('close',end);
 }
 url(raw:string){const url=new URL(raw);url.hostname='127.0.0.1';url.port=String(this.port);return url.toString();}
 async outage(){
  const ports=[...this.pairs].map(([,upstream])=>upstream.localPort).filter((p):p is number=>typeof p==='number');
  // Refuse new connections first; close() calls back only once every open connection has ended.
  const closed=new Promise<void>(resolve=>this.server.close(()=>resolve()));
  // 57P01 (terminating connection due to administrator command) to every session through the proxy, as a shutdown
  // sends. A test role that may not signal other roles' backends still gets the connection loss below.
  if(ports.length)await owner.client`select pg_terminate_backend(pid) from pg_stat_activity where client_port=any(${ports}::int[])`.catch(()=>undefined);
  await new Promise(resolve=>setTimeout(resolve,200));
  for(const [socket,upstream] of this.pairs){socket.destroy();upstream.destroy();}
  this.pairs.clear();
  await closed;
 }
 async restore(){this.server=net.createServer(socket=>this.accept(socket));await this.listen();}
 async close(){for(const [a,b] of this.pairs){a.destroy();b.destroy();}await new Promise<void>(resolve=>this.server.close(()=>resolve()));}
}

beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();await owner.client`delete from bulk_job_worker`;});
afterEach(async()=>{
 for(const run of runs.splice(0))if(run.child.exitCode===null&&run.child.signalCode===null){run.child.kill('SIGKILL');await run.exit;}
 // Children of a killed supervisor (still alive) and their heartbeats must not leak into later files.
 for(const row of await beats())if(alive(row.pid))process.kill(row.pid,'SIGKILL');
 await owner.client`delete from bulk_job_worker`;
});
afterAll(closeAll);

it('starts an all-lane child and one child per lane, and a --once run ends with status 0',async()=>{
 const run=start({AIHR_WORKER_LANES:'payroll,import'},['--once']);
 expect(await run.exit,text(run)).toEqual({code:0,signal:null});
 const out=text(run);
 expect(out).toMatch(/Import worker supervisor started \(pid \d+\); lanes: all, payroll, import \(AIHR_WORKER_LANES\)\./);
 for(const lanes of ['all lanes','lane payroll','lane import'])expect(out).toContain(`Import worker serves ${lanes} (`);
 expect(out).toContain('Import worker lanes stopped.');
},300_000);

it('stops every child on SIGTERM and exits 0 only after they have finished',async()=>{
 const run=start({AIHR_WORKER_LANES:'payroll'});
 const children=await childBeats(run.child.pid!,2);
 expect(children.find(r=>r.kinds.includes('payroll_process')&&r.kinds.includes(laneMarker('default')))?.kinds).toEqual(expect.arrayContaining(WORKER_LANES.map(laneMarker)));
 const payroll=children.find(r=>r.kinds.includes(laneMarker('payroll'))&&!r.kinds.includes(laneMarker('default')))!;
 expect(payroll.kinds.sort()).toEqual(['lane:payroll','payroll_history','payroll_process']);
 run.child.kill('SIGTERM');
 expect(await run.exit,text(run)).toEqual({code:0,signal:null});
 for(const row of children)expect(alive(row.pid)).toBe(false);
 // Each child retired its heartbeat on the way out.
 expect(await beats()).toEqual([]);
},300_000);

it('takes the whole worker down with a non-zero status when one child dies',async()=>{
 const run=start({AIHR_WORKER_LANES:'payroll'});
 const children=await childBeats(run.child.pid!,2);
 const payroll=children.find(r=>!r.kinds.includes(laneMarker('default')))!;
 process.kill(payroll.pid,'SIGKILL');
 expect(await run.exit,text(run)).toEqual({code:WORKER_UNEXPECTED_EXIT_CODE,signal:null});
 expect(text(run)).toContain('Import worker lane payroll exited with signal SIGKILL.');
 for(const row of children)expect(alive(row.pid)).toBe(false);
},300_000);

it('never exits 0 when the database refuses connections',async()=>{
 const closed=new URL(process.env.MIGRATION_DATABASE_URL!);closed.hostname='127.0.0.1';closed.port='1';
 for(const lanes of [undefined,'payroll']){
  const run=start({AIHR_WORKER_LANES:lanes,DATABASE_URL:closed.toString(),MIGRATION_DATABASE_URL:closed.toString()});
  const exit=await run.exit;
  expect(exit.code,`${lanes??'single process'}: ${text(run)}`).not.toBe(0);
  expect(exit.code).not.toBeNull();
 }
},300_000);

for(const lanes of [undefined,'payroll']){
 it(`never ends with status 0 when the database restarts (${lanes?'supervised lanes':'single process'})`,async()=>{
  const target=new URL(process.env.MIGRATION_DATABASE_URL!);
  const proxy=new DatabaseProxy(target.hostname,Number(target.port||5432));await proxy.listen();
  try{
   const run=start({AIHR_WORKER_LANES:lanes,DATABASE_URL:proxy.url(process.env.DATABASE_URL!),MIGRATION_DATABASE_URL:proxy.url(process.env.MIGRATION_DATABASE_URL!)});
   await until('a worker heartbeat',async()=>(await beats()).length>=(lanes?2:1));
   await proxy.outage();
   const outageAt=new Date();
   await new Promise(resolve=>setTimeout(resolve,8000));
   await proxy.restore();
   // Either the worker recovered (fresh heartbeats after the outage) or it exited with a failure for systemd to restart.
   let settled=false;
   const outcome=await Promise.race([
    run.exit.then(exit=>({exited:exit})),
    until('recovered heartbeats',async()=>{const rows=(await beats()).filter(r=>r.beat_at>outageAt&&alive(r.pid));return rows.length>=(lanes?2:1)&&rows;},90_000,()=>settled)
     .then(()=>({recovered:true as const}),error=>({stuck:String(error)})),
   ]);
   settled=true;
   // Neither recovered nor exited: a hung worker (the stall watchdog would only end it after 30 minutes).
   expect('stuck' in outcome?outcome.stuck:'',text(run)).toBe('');
   if('exited' in outcome){
    expect(outcome.exited.code,text(run)).not.toBe(0);
    expect(outcome.exited.code).not.toBeNull();
   }else{
    // Recovered: it still stops cleanly when asked.
    run.child.kill('SIGTERM');
    expect(await run.exit,text(run)).toEqual({code:0,signal:null});
   }
  }finally{await proxy.close();}
 },300_000);
}
