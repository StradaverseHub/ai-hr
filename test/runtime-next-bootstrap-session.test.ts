/** Pure source/ownership/timer controls only. Native qualification is separate. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {expect,it} from 'vitest';

it('checks one-operation profile custody, five fresh live proofs, refusal and mandatory close states',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_bootstrap_session.py'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);expect(result.stdout).toBe('');
 expect(output).toMatch(/Ran 27 tests in /);expect(output).toMatch(/\nOK\s*$/);expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);process.stdout.write(output);
});

function browserModel(options:{remainingMs?:number;writeThrows?:boolean}={}){
 const source=readFileSync('scripts/performance/native-next-boot-browser.mjs','utf8');
 const start=source.indexOf('async function host(operation)'),end=source.indexOf('const worker=response',start);
 assert(start>=0&&end>start);const remaining=source.split('\n').find(line=>line.startsWith('const remaining='));assert(remaining);
 let now=0,timer:(()=>void)|undefined,timeout=0,cleared=0,saves=0;
 const writes:string[]=[],waiting=new Map<number,(value:unknown)=>void>();
 const context=createContext({assert,deadline:options.remainingMs??300000,performance:{now:()=>now},waiting,nextId:0,report:{},
  process:{stdout:{write:(value:string)=>{if(options.writeThrows)throw Error('fictional-private-value');writes.push(value);}}},
  setTimeout:(callback:()=>void,ms:number)=>{timer=callback;timeout=ms;return 1;},clearTimeout:(id:number)=>{assert.equal(id,1);cleared++;},save:()=>{saves++;}});
 runInContext(remaining+'\n'+source.slice(start,end)+'\nglobalThis.model={host,remaining,report};',context);
 return {context,writes,waiting,advance:(ms:number)=>{now=ms;},expire:()=>{assert(timer);timer();},timeout:()=>timeout,cleared:()=>cleared,saves:()=>saves};
}

it('uses the actual first-request function and original remaining clock before a genuine reply',async()=>{
 const m=browserModel(),request=m.context.model.host('start-first');
 expect(m.timeout()).toBe(90000);expect(m.writes).toEqual([JSON.stringify({id:1,operation:'start-first'})+'\n']);
 m.advance(7.75);m.waiting.get(1)!({port:3201});expect(await request).toEqual({port:3201});
 expect(m.context.model.report.firstHostRequestTiming).toEqual({kind:'ACTUAL_FIRST_HOST_REQUEST_TIMING_NOT_ADMISSION',timeoutMs:90000,elapsedMs:7,outcome:'returned',driverFinalElapsedMs:null});
 expect(m.waiting.size).toBe(0);expect(m.cleared()).toBe(1);expect(m.saves()).toBe(1);
 const short=browserModel({remainingMs:21.9});short.advance(1);expect(short.context.model.remaining()).toBe(20);
 short.advance(22);expect(()=>short.context.model.remaining()).toThrow('Native browser budget exhausted');
});

it('records the actual original90s timer rejection without raising the cap or clamping elapsed time',async()=>{
 const m=browserModel(),request=m.context.model.host('start-first');
 expect(m.timeout()).toBe(90000);m.advance(90010.25);m.expire();await expect(request).rejects.toThrow('Native host operation timed out');
 expect(m.context.model.report.firstHostRequestTiming).toMatchObject({timeoutMs:90000,elapsedMs:90010,outcome:'timeout'});
 expect(m.waiting.size).toBe(0);expect(m.cleared()).toBe(1);expect(m.saves()).toBe(1);
});

it('clears a failed first request without reflecting private error text into timing evidence',async()=>{
 const m=browserModel({writeThrows:true}),request=m.context.model.host('start-first');
 m.advance(11);await expect(request).rejects.toThrow('fictional-private-value');
 expect(m.context.model.report.firstHostRequestTiming).toMatchObject({outcome:'refused',elapsedMs:11});
 expect(JSON.stringify(m.context.model.report)).not.toContain('fictional-private-value');expect(m.waiting.size).toBe(0);expect(m.cleared()).toBe(1);
});
