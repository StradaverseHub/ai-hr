/** Bounded byte transport only. The release caller must authenticate the full API inventory first. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants,lstatSync,realpathSync,statfsSync,openSync,closeSync,fstatSync,readSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX} from './build-artifact.mjs';
import {REPOSITORY,verifyArtifactBytes} from './release-policy.mjs';
const bound=a=>a.name===BUILD_ARTIFACT?BUILD_ZIP_MAX:64*1024**2;
function metadata(a){
 assert(a&&Number.isSafeInteger(a.id)&&a.id>0&&typeof a.name==='string'&&/^[A-Za-z][A-Za-z0-9._-]{0,159}$/.test(a.name),'Unsafe archive identity');
 assert(a.expired===false&&Number.isSafeInteger(a.size_in_bytes)&&a.size_in_bytes>0&&a.size_in_bytes<=bound(a)&&/^sha256:[a-f0-9]{64}$/.test(a.digest??''),'Invalid archive byte boundary');
}
function owner(dir,original){
 const s=lstatSync(dir);assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(dir)===dir&&s.uid===process.getuid()&&(s.mode&0o777)===0o700,'Private real archive directory required');
 if(original)assert(s.dev===original.dev&&s.ino===original.ino,'Archive directory changed');return s;
}
const startGithub=a=>spawn('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${a.id}/zip`],{stdio:['ignore','pipe','pipe']});
async function one(a,dir,identity,{start,timeoutMs}){
 owner(dir,identity);const path=join(dir,a.name+'.zip'),began=Date.now();
 const fd=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 let child,timer,terminal,timedOut=false,bytes=0;const hash=createHash('sha256');
 try{
  child=start(a);assert(child?.stdout&&child?.stderr&&typeof child.kill==='function','Archive transport must expose bounded child streams');
  terminal=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('close',(code,signal)=>resolve({code,signal}));});
  // Drain diagnostics without accumulating credentials, network responses or unbounded stderr.
  child.stderr.on('data',()=>{});
  timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');child.stdout.destroy(new Error('Archive transfer deadline exceeded'));},timeoutMs);
  for await(const chunk of child.stdout){
   assert(Buffer.isBuffer(chunk),'Binary archive stream required');bytes+=chunk.length;assert(bytes<=a.size_in_bytes&&bytes<=bound(a),'Archive exceeds authenticated size');hash.update(chunk);
   let offset=0;while(offset<chunk.length){const {bytesWritten}=await fd.write(chunk,offset,chunk.length-offset);assert(bytesWritten>0,'Archive write made no progress');offset+=bytesWritten;}
  }
  const end=await terminal;assert(!timedOut&&!end.error&&end.code===0&&end.signal===null,'Archive transport failed or timed out');
  const digest='sha256:'+hash.digest('hex');assert(bytes===a.size_in_bytes&&digest===a.digest,'Archive digest or size differs');
  owner(dir,identity);const stat=await fd.stat();assert(stat.isFile()&&stat.nlink===1&&stat.size===bytes&&(stat.mode&0o777)===0o600,'Archive file changed');
  return {id:a.id,name:a.name,path,bytes,digest,startedAt:new Date(began).toISOString(),completedAt:new Date().toISOString(),elapsedMs:Date.now()-began,status:'verified'};
 }catch(error){
  if(child){child.kill('SIGKILL');child.stdout?.destroy();if(terminal)await terminal;}
  throw error;
 }finally{clearTimeout(timer);await fd.close();}
}
/** At most four streams; partial failures remain private evidence and never become extracted inputs. */
export async function downloadCiArchives(artifacts,directory,{concurrency=4,timeoutMs=120000,start=startGithub}={}){
 assert(Array.isArray(artifacts)&&artifacts.length>0&&artifacts.length<=512,'Bounded complete archive inventory required');
 assert(Number.isSafeInteger(concurrency)&&concurrency>=1&&concurrency<=4&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=120000,'Invalid archive concurrency/deadline');
 artifacts.forEach(metadata);assert(new Set(artifacts.map(a=>a.name)).size===artifacts.length&&new Set(artifacts.map(a=>a.id)).size===artifacts.length,'Duplicate archive identity');
 const dir=resolve(directory),identity=owner(dir),space=statfsSync(dir);const total=artifacts.reduce((n,a)=>n+a.size_in_bytes,0);
 assert(Number.isSafeInteger(total)&&space.bavail*space.bsize>=total+64*1024**2,'Insufficient archive disk headroom');
 const queue=artifacts.map((a,index)=>({a:Object.freeze({...a}),index})).sort((x,y)=>y.a.size_in_bytes-x.a.size_in_bytes||x.index-y.index);
 const started=Date.now(),results=Array(artifacts.length),errors=[];let next=0;
 async function worker(){for(;;){const position=next++;if(position>=queue.length)return;const {a,index}=queue[position];try{results[index]=await one(a,dir,identity,{start,timeoutMs});}catch(error){errors.push(error);results[index]={id:a.id,name:a.name,status:'failed',error:String(error)};}}}
 await Promise.all(Array.from({length:Math.min(concurrency,artifacts.length)},worker));owner(dir,identity);
 const report={kind:'BOUNDED_AUTHENTICATED_ARCHIVE_BYTES_NOT_RELEASE_ACCEPTANCE',concurrency,scheduling:'largest-authenticated-archive-first',elapsedMs:Date.now()-started,artifacts:results,releaseAuthorized:false};
 if(errors.length){const error=new AggregateError(errors,'One or more authenticated archive transfers failed');error.report=report;throw error;}
 return report;
}
/** Recheck bounded immutable bytes immediately before extraction, including post-download tampering. */
export function readCiArchive(artifact,path){
 metadata(artifact);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.size===artifact.size_in_bytes&&before.size<=bound(artifact),'Archive file boundary differs');
  const bytes=Buffer.allocUnsafe(before.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);assert(n>0,'Archive truncated during read');offset+=n;}
  const extra=Buffer.alloc(1);assert(readSync(fd,extra,0,1,offset)===0,'Archive grew during read');const after=fstatSync(fd),current=lstatSync(path);
  for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert(before[key]===after[key]&&before[key]===current[key],'Archive identity changed');
  assert(!current.isSymbolicLink(),'Archive path became symlink');verifyArtifactBytes(artifact,bytes);return bytes;
 }finally{closeSync(fd);}
}
