/** Bounded IPC; terminal errors are retained and no remote process is killed on uncertainty. */
import assert from 'node:assert/strict';
import {openSync,closeSync,writeFileSync,fsyncSync,lstatSync,fstatSync,realpathSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {installJson} from './ci-install-grant.mjs';
export function durableCleanupRecord(path,value){
 const parent=dirname(path),s=lstatSync(parent);assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(parent)===parent&&s.uid===process.getuid()&&(s.mode&511)===448,'Private canonical cleanup parent required');
 const fd=openSync(path,'wx',384);try{writeFileSync(fd,installJson(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const directory=openSync(parent,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
export function acquireNormalCleanupLock(path,value){
 const parent=dirname(path),st=lstatSync(parent);assert(st.isDirectory()&&!st.isSymbolicLink()&&realpathSync(parent)===parent&&st.uid===process.getuid()&&(st.mode&511)===448,'Private canonical cleanup parent required');
 const fd=openSync(path,'wx',384),opened=fstatSync(fd);let released=false;
 try{writeFileSync(fd,installJson(value)+'\n');fsyncSync(fd);const directory=openSync(parent,'r');try{fsyncSync(directory);}finally{closeSync(directory);}}catch(error){closeSync(fd);throw error;}
 return ()=>{if(released)return;released=true;try{const current=lstatSync(path);assert(current.dev===opened.dev&&current.ino===opened.ino&&!current.isSymbolicLink(),'Replaced cleanup lock retained');unlinkSync(path);const directory=openSync(parent,'r');try{fsyncSync(directory);}finally{closeSync(directory);}}finally{closeSync(fd);}};
}
export function readSingleCleanupCommit(stream,{timeout=180000,bound=32768}={}){
 return new Promise((accept,reject)=>{let bytes=Buffer.alloc(0),done=false;const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);stream.off('data',data);stream.off('end',end);stream.off('error',fail);stream.pause();if(error)return reject(error);try{const text=bytes.toString('utf8');assert(text.endsWith('\n')&&text.indexOf('\n')===text.length-1,'Exactly one cleanup commit frame required');accept(JSON.parse(text));}catch(e){reject(e);}};
 const fail=()=>finish(Error('Cleanup input failed'));const data=chunk=>{if(done)return;if(bytes.length+chunk.length>bound)return finish(Error('Cleanup commit exceeds bound'));bytes=Buffer.concat([bytes,chunk]);};const end=()=>finish();const timer=setTimeout(()=>finish(Error('Cleanup commit timed out')),timeout);stream.on('data',data);stream.once('end',end);stream.once('error',fail);stream.resume();});
}
/** Continuous framing handles fragmented and coalesced frames without losing an early terminal error. */
export function cleanupFrames(stream,{timeout=900000,bound=2*1024**2}={}){
 let buffer=Buffer.alloc(0),terminal=null,ended=false,total=0;const queue=[],waiters=[];
 const fail=error=>{terminal??=error;while(waiters.length)waiters.shift().reject(terminal);};
 stream.on('error',()=>fail(Error('Cleanup channel failed')));stream.on('data',chunk=>{
  if(terminal)return;total+=chunk.length;if(total>bound)return fail(Error('Cleanup channel exceeds bound'));buffer=Buffer.concat([buffer,chunk]);let at;
  while((at=buffer.indexOf(10))>=0){try{const value=JSON.parse(buffer.subarray(0,at).toString('utf8'));buffer=buffer.subarray(at+1);const pending=waiters.shift();pending?pending.accept(value):queue.push(value);}catch{return fail(Error('Malformed cleanup frame'));}}
 });stream.on('end',()=>{ended=true;if(buffer.length)fail(Error('Truncated cleanup frame'));else while(waiters.length)waiters.shift().reject(Error('Cleanup channel EOF'));});
 return {next:()=>new Promise((accept,reject)=>{if(terminal)return reject(terminal);if(queue.length)return accept(queue.shift());if(ended)return reject(Error('Cleanup channel EOF'));const pending={accept:v=>{clearTimeout(timer);accept(v);},reject:e=>{clearTimeout(timer);reject(e);}};const timer=setTimeout(()=>{const i=waiters.indexOf(pending);if(i>=0)waiters.splice(i,1);reject(Error('Cleanup channel timed out; retain lease'));},timeout);waiters.push(pending);}),finish:()=>{assert(!terminal&&ended&&buffer.length===0&&queue.length===0,'Unexpected or incomplete cleanup output');}};
}
