/** Read-only own-proc/descriptor controls, not actual supervised CI admission. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,rmSync,rmdirSync,mkdirSync,linkSync,unlinkSync,lstatSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compilerProcIdentity,boundedCompilerBytes,admitCompilerReference,publishCompilerReferenceClock,readPublishedCompilerBytes} from './admission.mjs';
test('own native PID/start/session are actual repeatable proc facts, not environment fields',()=>{
 const first=compilerProcIdentity(process.pid),next=compilerProcIdentity(process.pid);assert.equal(first.pid,process.pid);
 for(const key of ['pid','parent','group','session','start'])assert.equal(next[key],first[key]);assert(!['Z','X'].includes(first.state));
});
test('invalid native identities refuse before any proc-path interpretation',()=>{
 for(const pid of [0,1,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,'123'])assert.throws(()=>compilerProcIdentity(pid));
});
test('regular input bounds and no-follow descriptors refuse oversized/symlink evidence',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-reference-source-'));
 try{const file=join(root,'owned'),link=join(root,'link');writeFileSync(file,'fixed',{mode:0o600});symlinkSync(file,link);
  assert.equal(boundedCompilerBytes(file,5).toString(),'fixed');assert.throws(()=>boundedCompilerBytes(file,4));assert.throws(()=>boundedCompilerBytes(link,5));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('an ordinary source-control process cannot stand in for the compiler-only live kernel context',()=>{
 // No fake GHA/profile/normal-CI variables are installed by this model.
 assert.throws(()=>admitCompilerReference());assert.throws(()=>admitCompilerReference('foreign-mode'));
});
test('delayed exclusive file ACK retains the original shared T0 and stopped publication cannot reopen a clock',async()=>{
 // File-transport model only: this fabricated proof is NOT admission and is
 // never given to the wrapper/native fixture or any process constructor.
 const destination=mkdtempSync(join(tmpdir(),'compiler-clock-model-')),self=compilerProcIdentity(process.pid);
 const proof={destination,run:'123',attempt:'1',sourceHead:'1'.repeat(40),controllerHead:'2'.repeat(40),monitor:{pid:self.pid,start:self.start},self:{pid:self.pid,start:self.start}};
 const started=process.hrtime.bigint()-BigInt(100000000),controller=new AbortController();let publishing;
 try{
  publishing=publishCompilerReferenceClock(proof,controller.signal,started);let settled=false;publishing.then(()=>{settled=true;},()=>{settled=true;});
  const ack=join(destination,'compiler-reference-clock-ack.json'),pending=ack+'.pending';
  writeFileSync(pending,readFileSync(join(destination,'compiler-reference-clock.json')),{flag:'wx',mode:0o600});linkSync(pending,ack);assert.equal(lstatSync(ack).nlink,2);
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(settled,false,'Linked ACK is not settled readiness');
  unlinkSync(pending);mkdirSync(ack+'.ready',{mode:0o700});
  const result=await publishing;assert.equal(result.startNs,String(started));assert(process.hrtime.bigint()>started+BigInt(100000000));
  const original=readFileSync(join(destination,'compiler-reference-clock.json'));assert.equal(JSON.parse(original).startNs,String(started));
  const stopped=Error('fixed clock frontier closed');controller.abort(stopped);
  await assert.rejects(publishCompilerReferenceClock(proof,controller.signal,process.hrtime.bigint()),error=>error===stopped);
  assert.deepEqual(readFileSync(join(destination,'compiler-reference-clock.json')),original);
 }finally{controller.abort(Error('Fixed model settlement'));await publishing?.catch(()=>{});rmSync(destination,{recursive:true,force:true});}
});

test('clock and ACK readers wait through real nlink2 and refuse foreign readiness without relaxing file identity',()=>{
 const root=mkdtempSync(join(tmpdir(),'compiler-settled-source-'));
 try{for(const name of ['clock','ack']){
  const file=join(root,name),pending=file+'.pending',ready=file+'.ready';writeFileSync(pending,'fixed',{mode:0o600});linkSync(pending,file);
  assert.equal(lstatSync(file).nlink,2);assert.equal(readPublishedCompilerBytes(file,5),undefined);
  mkdirSync(ready,{mode:0o700});assert.throws(()=>readPublishedCompilerBytes(file,5),'A premature marker cannot waive nlink1');
  unlinkSync(pending);assert.equal(readPublishedCompilerBytes(file,5).toString(),'fixed');
  for(const mode of [0o755,0o1700]){chmodSync(ready,mode);assert.throws(()=>readPublishedCompilerBytes(file,5));}chmodSync(ready,0o700);
  writeFileSync(join(ready,'foreign'),'fixed');assert.throws(()=>readPublishedCompilerBytes(file,5));unlinkSync(join(ready,'foreign'));
  rmdirSync(ready);symlinkSync(root,ready);assert.throws(()=>readPublishedCompilerBytes(file,5));unlinkSync(ready);
 }}finally{rmSync(root,{recursive:true,force:true});}
});
