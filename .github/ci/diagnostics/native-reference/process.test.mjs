/** Source-model lifecycle controls. Fake handles/clock are NOT native evidence. */
import test,{mock,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createNativeReferenceProcess,requireNativeSuccess} from './process.mjs';
const forbidden=mock.method(process,'kill',()=>{throw Error('Numeric signal forbidden in owned-handle models');});
afterEach(()=>assert.equal(forbidden.mock.callCount(),0));
function fixture(){
 const child=new EventEmitter(),signals=[],timers=[],intervals=[],logs=[];let now=0,reads=0,spawns=0,start='123';child.pid=99;
 for(const key of ['stdout','stderr']){child[key]=new EventEmitter();child[key].destroyed=false;child[key].destroy=()=>{child[key].destroyed=true;};}
 child.kill=signal=>{signals.push(signal);return true;};
 const runtime={spawn(_node,_args,options){assert.equal(options.detached,undefined);spawns++;return child;},
  now:()=>now,identity:()=>start,status:()=>{reads++;return 'VmRSS: 42 kB\n';},write:(path,raw)=>logs.push({path,raw}),
  after:(work,ms)=>{const value={work,at:now+ms,active:true};timers.push(value);return value;},cancel:value=>{value.active=false;},
  every:work=>{const value={work,active:true};intervals.push(value);return value;},cancelEvery:value=>{value.active=false;}};
 const owner=createNativeReferenceProcess(runtime),controller=new AbortController();
 return{child,signals,timers,intervals,logs,runtime,controller,owner,
  run:()=>owner(['fixed-owned-child'],{cwd:'/owned-model',env:{},deadline:10000,log:'/owned-model/log',signal:controller.signal}),
  advance(ms){now+=ms;for(const value of timers)if(value.active&&value.at<=now){value.active=false;value.work();}},
  samples(){for(const value of intervals)if(value.active)value.work();},reads:()=>reads,spawns:()=>spawns,
  replacePid(){start='999';},exit(code=0,signal=null){child.emit('exit',code,signal);},close(code=0,signal=null){child.emit('close',code,signal);}};
}
test('normal direct handle closes once and preserves measured output/RSS',async()=>{
 const f=fixture(),pending=f.run();f.samples();f.child.stdout.emit('data',Buffer.from('fixed output'));f.exit();f.close();
 const result=await pending;requireNativeSuccess(result);assert.equal(result.peakRss,42*1024);assert.equal(f.logs.length,1);assert.equal(f.logs[0].raw.toString(),'fixed output');assert.deepEqual(f.signals,[]);
});
test('EXIT stops all PID sampling while CLOSE is still pending and never signals a reused numeric PID',async()=>{
 const f=fixture(),pending=f.run();f.samples();const reads=f.reads();f.exit();f.replacePid();f.samples();
 assert.equal(f.reads(),reads);f.controller.abort(Error('fixed late abort'));assert.deepEqual(f.signals,[]);f.close();
 assert.equal((await pending).stoppedBecause,'owner-aborted');
});
test('already stopped frontier refuses a new native child before spawn',()=>{
 const f=fixture(),failure=Error('fixed stopped owner');f.controller.abort(failure);assert.throws(f.run,error=>error===failure);assert.equal(f.spawns(),0);
});
test('live abort uses only the direct handle TERM/KILL and awaits actual CLOSE',async()=>{
 const f=fixture(),pending=f.run(),failure=Error('fixed owner stop');let settled=false;pending.then(()=>{settled=true;});
 f.controller.abort(failure);assert.deepEqual(f.signals,['SIGTERM']);f.advance(1000);assert.deepEqual(f.signals,['SIGTERM','SIGKILL']);
 await Promise.resolve();assert.equal(settled,false);f.exit(null,'SIGKILL');f.close(null,'SIGKILL');
 const result=await pending;assert.equal(result.stoppedBecause,'owner-aborted');assert.equal(result.error.name,failure.name);assert.equal(result.error.count,1);
});
test('an exited child with inherited pipes fails and closes owned read handles within the remaining reserve',async()=>{
 const f=fixture(),pending=f.run();f.exit();f.advance(1000);assert(f.child.stdout.destroyed&&f.child.stderr.destroyed);assert.deepEqual(f.signals,[]);f.close();
 const result=await pending;assert.equal(result.stoppedBecause,'pipe-drain-budget');assert.throws(()=>requireNativeSuccess(result));
});
test('distinct original/settlement errors retain primary classification and both causes',async()=>{
 const f=fixture(),original=Object.assign(Error('fixed spawn failure'),{code:'ENOENT'}),publication=Object.assign(Error('fixed publication failure'),{code:'EIO'});
 f.runtime.write=()=>{throw publication;};const pending=f.run();f.child.emit('error',original);f.close(-2,null);const result=await pending;
 assert.equal(result.error.code,'ENOENT');assert.equal(result.error.count,2);assert.deepEqual(result.error.causes,[{name:'Error',code:'ENOENT'},{name:'Error',code:'EIO'}]);assert.throws(()=>requireNativeSuccess(result));
});
