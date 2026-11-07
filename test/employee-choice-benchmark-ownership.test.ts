/** Clock/promise/filesystem models only, never actual native plans or speed proof. */
import {expect,it} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {employeeChoiceBenchmarkLifetime,employeeChoiceBenchmarkBounds} from './performance/employee-choice-benchmark-lifetime';
import {employeeChoiceBenchmarkEvidence} from './performance/employee-choice-benchmark-evidence';
function clock(){let now=0;const tasks=new Set<{at:number;work:()=>void}>();return{
 now:()=>now,schedule:(work:()=>void,ms:number)=>{const row={at:now+ms,work};tasks.add(row);return()=>{tasks.delete(row);};},
 advance(ms:number){now+=ms;for(const row of [...tasks].sort((a,b)=>a.at-b.at))if(row.at<=now){tasks.delete(row);row.work();}},pending:()=>tasks.size,
};}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
it('stops work at840seconds under the fixed900-second envelope and reserves60seconds for drain/restore',async()=>{
 const time=clock(),events:unknown[]=[];let cancels=0;
 const life=employeeChoiceBenchmarkLifetime(async()=>{cancels++;},event=>events.push(event),time);life.start();
 expect(employeeChoiceBenchmarkBounds).toEqual({totalMs:900000,reserveMs:60000,workMs:840000});time.advance(839999);expect(()=>life.active()).not.toThrow();
 time.advance(1);expect(life.signal.aborted).toBe(true);expect(()=>life.active()).toThrow();await life.drain();expect(cancels).toBe(1);
 await expect(life.run('blocked',async()=>{throw Error('must not execute');})).rejects.toThrow('refused');expect(events).toContainEqual(expect.objectContaining({kind:'phase-blocked',phase:'blocked'}));
 await life.finish(async()=>{});expect(time.pending()).toBe(0);expect(life.snapshot()).toMatchObject({finished:true,stopped:true,uncertain:false,cancellationPending:false});
});
it('registers owned pending work before its microtask and refuses it if the shared budget aborts first',async()=>{
 const time=clock();let executed=false;const life=employeeChoiceBenchmarkLifetime(async()=>{},()=>{},time);life.start();
 const phase=life.run('prepare',async()=>{executed=true;});expect(life.snapshot().pending).toBe(true);time.advance(840000);
 await expect(phase).rejects.toThrow('refused');await life.finish(async()=>{});expect(executed).toBe(false);
});
it('drains the exact owned deferred phase and cancellation before cleanup or any successor can run',async()=>{
 const time=clock(),entered=deferred(),release=deferred(),cancelled=deferred();const order:string[]=[];
 const life=employeeChoiceBenchmarkLifetime(async()=>{order.push('cancel');await cancelled.promise;},()=>{},time);life.start();
 const phase=life.run('plans',async()=>{entered.resolve();try{await release.promise;}finally{order.push('phase-finally');}});await entered.promise;life.stop('case-aborted');
 const finish=life.finish(async()=>{order.push('restore');});expect(life.finish(async()=>{throw Error('duplicate cleanup');})).toBe(finish);
 await Promise.resolve();expect(order).not.toContain('restore');await expect(life.run('successor',async()=>{})).rejects.toThrow('refused');
 release.resolve();await phase;expect(order).not.toContain('restore');cancelled.resolve();await finish;expect(order).toEqual(['cancel','phase-finally','restore']);
});
it('retains cancellation/restoration uncertainty and rejects over-envelope cleanup rather than reporting success',async()=>{
 const time=clock(),life=employeeChoiceBenchmarkLifetime(async()=>{throw Error('socket close uncertain');},()=>{},time);life.start();life.stop('owner-uncertain');
 let cleanup=false;await expect(life.finish(async()=>{cleanup=true;})).rejects.toThrow('socket close uncertain');expect(cleanup).toBe(true);expect(life.snapshot().uncertain).toBe(true);
 const later=clock(),other=employeeChoiceBenchmarkLifetime(async()=>{},()=>{},later);other.start();later.advance(900001);await expect(other.finish(async()=>{})).rejects.toThrow('envelope');expect(other.snapshot()).toMatchObject({finished:true,uncertain:true});
});
it('still cancels and drains when progress persistence itself refuses instead of escaping from the deadline callback',async()=>{
 const time=clock();let cancel=false,restore=false;
 const life=employeeChoiceBenchmarkLifetime(async()=>{cancel=true;},()=>{throw Error('progress unavailable');},time);life.start();
 expect(()=>time.advance(840000)).not.toThrow();await expect(life.finish(async()=>{restore=true;})).rejects.toThrow('progress unavailable');
 expect(cancel).toBe(true);expect(restore).toBe(true);expect(life.snapshot()).toMatchObject({finished:true,uncertain:true});
});
const binding={source:'a'.repeat(40),controller:'b'.repeat(40),run:'42414058820',attempt:'1'};
const identity={phase:'native:deep:0',pid:123,container:'aihr-ci-42414058820-1-db-1',containerId:'c'.repeat(64),startedAt:'2026-11-07T21:05:56Z'};
const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
function temporary(){const directory=mkdtempSync(join(tmpdir(),'aihr-lookup-evidence-'));return{directory,close:()=>rmSync(directory,{recursive:true,force:true})};}
it('atomically publishes exact raw bytes+metadata, labels superseded cuts progress-only and retains the final actual cut',()=>{
 const f=temporary();try{
  const writer=employeeChoiceBenchmarkEvidence(f.directory,binding),first=writer.capture('actual first raw\n',identity),second=writer.capture('actual full new raw\n',{...identity,phase:'native:broad:0'});
  expect(existsSync(join(f.directory,first.file))).toBe(false);expect(readFileSync(join(f.directory,second.file),'utf8')).toBe('actual full new raw\n');
  const metadata=JSON.parse(readFileSync(join(f.directory,'native-plan-latest.json'),'utf8'));expect(metadata).toMatchObject({...binding,...second,sha256:hash('actual full new raw\n'),fullMatrixVerified:false,releaseAuthorized:false,priorPayloadRetained:false,supersedesPriorProgressPayload:true});
  expect(readdirSync(f.directory).filter(name=>name.startsWith('native-plan-cut-'))).toHaveLength(1);
  const final=writer.retainFinal();expect(hash(readFileSync(join(f.directory,final.file)))).toBe(second.sha256);expect(()=>writer.retainFinal()).toThrow();
 }finally{f.close();}
});
it('preserves previous complete bytes+metadata when a new cut fails before publication and never deletes a foreign pending file',()=>{
 const f=temporary();try{
  const writer=employeeChoiceBenchmarkEvidence(f.directory,binding),cut=writer.capture('last complete raw\n',identity),before=readFileSync(join(f.directory,'native-plan-latest.json'),'utf8');
  const pending=join(f.directory,'native-plan-meta.pending');writeFileSync(pending,'foreign pending source');
  expect(()=>writer.capture('new partial raw\n',identity)).toThrow();expect(readFileSync(pending,'utf8')).toBe('foreign pending source');expect(readFileSync(join(f.directory,cut.file),'utf8')).toBe('last complete raw\n');expect(readFileSync(join(f.directory,'native-plan-latest.json'),'utf8')).toBe(before);
  expect(writer.latest()).toEqual(cut);expect(readdirSync(f.directory).filter(name=>name.startsWith('native-plan-cut-'))).toHaveLength(1);
 }finally{f.close();}
});
it('refuses unsafe identity/path drift and cannot overwrite source binding or invent a final cut',()=>{
 const f=temporary();try{
  const writer=employeeChoiceBenchmarkEvidence(f.directory,binding);expect(()=>writer.retainFinal()).toThrow('No actual');
  for(const change of [{pid:0},{containerId:'caller'},{container:'foreign'},{startedAt:'invalid'}])expect(()=>writer.capture('raw',{...identity,...change})).toThrow();
  writer.append({kind:'model',source:'forged',controller:'forged',releaseAuthorized:true});const progress=readFileSync(join(f.directory,'benchmark-progress.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row));expect(progress[0]).toMatchObject({...binding,releaseAuthorized:false});
  const cut=writer.capture('actual raw',identity);writeFileSync(join(f.directory,cut.file),'changed');expect(()=>writer.capture('replacement',identity)).toThrow('drifted');
  symlinkSync(f.directory,join(f.directory,'linked'));expect(()=>employeeChoiceBenchmarkEvidence(join(f.directory,'linked'),binding)).toThrow('Owned');
 }finally{f.close();}
});
