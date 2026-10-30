/** Bounded private IPC and exclusive file primitives shared by live code and hosted fixtures. */
import assert from 'node:assert/strict';
import {openSync,writeFileSync,fsyncSync,closeSync,lstatSync,fstatSync,realpathSync,unlinkSync} from 'node:fs';
import {dirname,basename,resolve,join} from 'node:path';
import {installJson} from './ci-install-grant.mjs';
import {digest} from './post-arrival-cleanup-policy.mjs';
function parent(path){const p=dirname(path),st=lstatSync(p);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o777)===0o700&&realpathSync(p)===resolve(p),'Private owned canonical parent required');}
export function publishCleanupRecord(path,value){
 parent(path);const fd=openSync(path,'wx',0o600);
 try{writeFileSync(fd,installJson(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const folder=openSync(dirname(path),'r');try{fsyncSync(folder);}finally{closeSync(folder);}
}
export function acquireCleanupLock(path,record){
 assert(basename(path)==='post-arrival-finalizer.lock','Exact per-install lock required');parent(path);
 const fd=openSync(path,'wx',0o600),opened=fstatSync(fd);
 try{writeFileSync(fd,installJson(record)+'\n');fsyncSync(fd);}catch(error){closeSync(fd);throw error;}
 let released=false;
 return ()=>{
  if(released)return;released=true;
  try{const st=lstatSync(path);assert(!st.isSymbolicLink()&&st.dev===opened.dev&&st.ino===opened.ino,'Replaced lock must be preserved');unlinkSync(path);}finally{closeSync(fd);}
 };
}
export function consumeCleanupChallenge(directory,preparation){
 publishCleanupRecord(join(directory,'post-arrival-finalizer-consumed.json'),{kind:'SINGLE_CLEANUP_COMMIT_CONSUMED',preparationSha256:digest(installJson(preparation))});
}
export function readCleanupCommit(stream,{deadlineMs=120000,bound=65536}={}){
 assert(Number.isSafeInteger(deadlineMs)&&deadlineMs>0&&deadlineMs<=120000&&bound===65536,'Bounded private commit input required');
 return new Promise((accept,reject)=>{
  let buffer=Buffer.alloc(0),done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);stream.off('data',data);stream.off('end',end);stream.off('error',fail);stream.pause();error?reject(error):accept(value);};
  const fail=()=>finish(Error('Private cleanup input failed'));
  const end=()=>finish(Error('Cleanup commit EOF'));
  const data=chunk=>{
   chunk=Buffer.from(chunk);if(buffer.length+chunk.length>bound)return finish(Error('Cleanup commit exceeds bound'));
   buffer=Buffer.concat([buffer,chunk]);const newline=buffer.indexOf(10);if(newline<0)return;
   if(newline!==buffer.length-1)return finish(Error('Exactly one private commit line required'));
   try{finish(null,JSON.parse(buffer.subarray(0,newline).toString('utf8')));}catch{finish(Error('Malformed private cleanup commit'));}
  };
  const timer=setTimeout(()=>finish(Error('Cleanup commit deadline exceeded')),deadlineMs);
  stream.on('data',data);stream.once('end',end);stream.once('error',fail);stream.resume();
 });
}
