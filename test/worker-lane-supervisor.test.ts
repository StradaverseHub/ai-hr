/** ADR 0181 J1.2 lane supervisor (core/worker-lane-supervisor.ts), with fake children: a stop request is forwarded
 * and exits 0 only when every child exits 0; any other child exit takes the whole worker down with a non-zero status,
 * so systemd's Restart=on-failure brings it back. The real processes are in test/worker-lane-process-db.test.ts. */
import {EventEmitter} from 'node:events';
import {describe,expect,it} from 'vitest';
import {FAILURE_DRAIN_MS,WORKER_UNEXPECTED_EXIT_CODE,superviseWorkerLanes,workerLaneChildren,type SupervisedChild,type WorkerLaneChildSpec} from '../core/worker-lane-supervisor';

class FakeChild extends EventEmitter{
 signals:NodeJS.Signals[]=[];
 constructor(readonly name:string,private readonly onSignal?:(child:FakeChild,signal:NodeJS.Signals)=>void){super();}
 kill(signal:NodeJS.Signals){this.signals.push(signal);this.onSignal?.(this,signal);return true;}
 exitWith(code:number|null,signal:NodeJS.Signals|null=null){this.emit('exit',code,signal);}
}
function fleet(options:{once?:boolean;onSignal?:(child:FakeChild,signal:NodeJS.Signals)=>void;failSpawn?:string}={}){
 const children=new Map<string,FakeChild>(),exits:number[]=[],log:string[]=[],timers:{fn:()=>void;ms:number}[]=[];
 const specs:WorkerLaneChildSpec[]=workerLaneChildren({MIGRATION_DATABASE_URL:'postgres://fictional',AIHR_WORKER_LANES:'payroll,import'},['payroll','import']);
 const supervisor=superviseWorkerLanes({children:specs,once:options.once,log:line=>log.push(line),exit:code=>exits.push(code),
  setTimeout:(fn,ms)=>{timers.push({fn,ms});return{};},
  spawn:spec=>{if(spec.name===options.failSpawn)throw new Error('fictional spawn failure');const child=new FakeChild(spec.name,options.onSignal);children.set(spec.name,child);return child as unknown as SupervisedChild;}});
 return{supervisor,children,exits,log,timers,child:(name:string)=>children.get(name)!};
}
// A child that drains and exits cleanly on SIGTERM, as scripts/lib/worker-lane-process.ts does.
const drains=(child:FakeChild,signal:NodeJS.Signals)=>{if(signal==='SIGTERM')queueMicrotask(()=>child.exitWith(0));};

describe('lane children',()=>{
 it('starts an all-lane child and one child per dedicated lane, none of which supervises',()=>{
  const specs=workerLaneChildren({MIGRATION_DATABASE_URL:'postgres://fictional',AIHR_WORKER_LANES:'payroll,tax',AIHR_DB_POOL_MAX:'2'},['payroll','tax']);
  expect(specs.map(s=>s.name)).toEqual(['all lanes','lane payroll','lane tax']);
  expect(specs.map(s=>s.env.AIHR_WORKER_LANE)).toEqual([undefined,'payroll','tax']);
  for(const spec of specs)expect(spec.env).toMatchObject({AIHR_WORKER_LANES:undefined,MIGRATION_DATABASE_URL:'postgres://fictional',AIHR_DB_POOL_MAX:'2'});
 });
});

describe('a stop request',()=>{
 it('is forwarded to every child, and exits 0 only after every child has exited 0',async()=>{
  const f=fleet({onSignal:drains});
  expect(f.supervisor.running).toEqual(['all lanes','lane payroll','lane import']);
  f.supervisor.stop('SIGTERM');
  for(const child of f.children.values())expect(child.signals).toEqual(['SIGTERM']);
  await Promise.resolve();await Promise.resolve();
  expect(f.exits).toEqual([0]);
  expect(f.supervisor.failed).toBe(false);
 });
 it('waits for the slowest child before exiting',()=>{
  const f=fleet();
  f.supervisor.stop('SIGINT');
  f.child('all lanes').exitWith(0);f.child('lane payroll').exitWith(0);
  expect(f.exits).toEqual([]);
  f.child('lane import').exitWith(0);
  expect(f.exits).toEqual([0]);
 });
 it('fails when a child fails while stopping',()=>{
  const f=fleet();
  f.supervisor.stop('SIGTERM');
  f.child('all lanes').exitWith(0);f.child('lane payroll').exitWith(1);f.child('lane import').exitWith(0);
  expect(f.exits).toEqual([WORKER_UNEXPECTED_EXIT_CODE]);
  expect(f.log).toContain('Import worker lane payroll exited with status 1 while stopping.');
 });
});

describe('a child exit without a stop request takes the whole worker down with a non-zero status',()=>{
 for(const [how,code,signal] of [['crashes',1,null],['is killed',null,'SIGKILL'],['hits the stall watchdog',70,null],['loses the database',75,null],['ends with status 0',0,null]] as const){
  it(`when a child ${how}`,async()=>{
   const f=fleet({onSignal:drains});
   f.child('lane payroll').exitWith(code,signal);
   // The other children are asked to stop and drain.
   expect(f.child('all lanes').signals).toEqual(['SIGTERM']);
   expect(f.child('lane import').signals).toEqual(['SIGTERM']);
   await Promise.resolve();await Promise.resolve();
   expect(f.exits).toEqual([WORKER_UNEXPECTED_EXIT_CODE]);
   expect(f.exits).not.toContain(0);
   expect(f.supervisor.failed).toBe(true);
  });
 }
 it('kills children that do not drain within the failure bound',()=>{
  const f=fleet();
  f.child('all lanes').exitWith(1);
  expect(f.timers.map(t=>t.ms)).toEqual([FAILURE_DRAIN_MS]);
  f.timers[0].fn();
  expect(f.child('lane payroll').signals).toEqual(['SIGTERM','SIGKILL']);
  f.child('lane payroll').exitWith(null,'SIGKILL');f.child('lane import').exitWith(null,'SIGKILL');
  expect(f.exits).toEqual([WORKER_UNEXPECTED_EXIT_CODE]);
 });
 it('fails when a child cannot start, or reports a spawn error',()=>{
  const f=fleet({failSpawn:'lane import',onSignal:drains});
  expect(f.supervisor.failed).toBe(true);
  expect(f.child('all lanes').signals).toEqual(['SIGTERM']);
  const g=fleet({onSignal:drains});
  g.child('lane import').emit('error',new Error('fictional ENOENT'));
  expect(g.supervisor.failed).toBe(true);
 });
});

it('treats each child ending its pass as expected in a --once run',()=>{
 const f=fleet({once:true});
 for(const child of f.children.values())child.exitWith(0);
 expect(f.exits).toEqual([0]);
 const g=fleet({once:true});
 g.child('all lanes').exitWith(0);g.child('lane payroll').exitWith(2);g.child('lane import').exitWith(0);
 expect(g.exits).toEqual([WORKER_UNEXPECTED_EXIT_CODE]);
});
