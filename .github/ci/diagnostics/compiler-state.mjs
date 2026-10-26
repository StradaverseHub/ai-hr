/** Bounded compiler-state transport for a same-candidate, separate-runner diagnostic.
 * This module never runs a compiler, returns a PASS receipt or authorizes release. */
import assert from 'node:assert/strict';
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const KIND='SAME_CANDIDATE_COMPILER_STATE_NOT_TEST_OR_RELEASE_EVIDENCE';
const MAX_STATE=64*1024**2,MAX_METADATA=16*1024;
const digest=b=>createHash('sha256').update(b).digest('hex');
const keys=(value,expected)=>assert(value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),expected.slice().sort()),'Compiler state fields differ');
export function compilerStateIdentity(value){
 keys(value,['source','controller','runId','attempt','runtime','inputs']);
 for(const field of ['source','controller'])assert(/^[0-9a-f]{40}$/.test(value[field]),'Exact source/controller required');
 assert(/^\d+$/.test(value.runId)&&value.attempt==='1','One first-attempt diagnostic run required');
 keys(value.runtime,['node','typescript','next','platform','arch']);
 assert(/^22\.\d+\.\d+$/.test(value.runtime.node)&&/^\d+\.\d+\.\d+$/.test(value.runtime.typescript)&&/^\d+\.\d+\.\d+$/.test(value.runtime.next),'Exact toolchain required');
 assert(value.runtime.platform==='linux'&&value.runtime.arch==='x64','Expected hosted Linux x64 compiler');
 keys(value.inputs,['tsconfig','lockfile','package','workspace','nextConfig','compilerCli']);
 assert(Object.values(value.inputs).every(v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)),'Exact compiler-input digests required');
 return JSON.parse(JSON.stringify(value));
}
function validateState(bytes,identity){
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_STATE,'Compiler state size/type refused');
 const data=JSON.parse(bytes.toString('utf8'));
 assert(data&&typeof data==='object'&&!Array.isArray(data)&&data.version===identity.runtime.typescript,'Compiler-state tool version differs');
 assert(Array.isArray(data.fileNames)&&data.fileNames.length>0&&data.fileNames.length<=100000&&data.fileNames.every(v=>typeof v==='string'&&v.length>0),'Missing bounded compiler graph');
}
export function makeCompilerState(bytes,identity,completed){
 const pinned=compilerStateIdentity(identity);validateState(bytes,pinned);
 keys(completed,['processExitCode','files','completedAt']);
 assert(completed.processExitCode===0&&Number.isSafeInteger(completed.files)&&completed.files>0,'Only completed whole compiler state may be transported');
 assert(typeof completed.completedAt==='string'&&Number.isFinite(Date.parse(completed.completedAt)),'Missing compiler completion time');
 return {schemaVersion:1,kind:KIND,identity:pinned,completed:{...completed},bytes:bytes.length,sha256:digest(bytes),releaseAuthorized:false};
}
export function verifyCompilerState(bytes,envelope,expected,{now=Date.now()}={}){
 keys(envelope,['schemaVersion','kind','identity','completed','bytes','sha256','releaseAuthorized']);
 assert(envelope.schemaVersion===1&&envelope.kind===KIND&&envelope.releaseAuthorized===false,'State is never a test or release witness');
 const identity=compilerStateIdentity(expected);assert(isDeepStrictEqual(compilerStateIdentity(envelope.identity),identity),'Compiler state origin/toolchain/input mismatch');
 assert(envelope.bytes===bytes.length&&envelope.sha256===digest(bytes),'Compiler-state bytes differ');
 assert(isDeepStrictEqual(makeCompilerState(bytes,identity,envelope.completed),envelope),'Compiler-state envelope differs');
 const age=now-Date.parse(envelope.completed.completedAt);assert(Number.isFinite(now)&&age>=-60000&&age<=24*60*60*1000,'Compiler state completion time refused');
 return {files:envelope.completed.files,sha256:envelope.sha256,bytes:envelope.bytes,releaseAuthorized:false};
}
function directory(path,{privateOutput=false}={}){
 const stat=lstatSync(path);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&realpathSync(path)===path,'Canonical regular snapshot directory required');
 assert(stat.uid===process.getuid()&&(stat.mode&0o022)===0,'Snapshot directory must be owned and not writable by others');
 if(privateOutput)assert((stat.mode&0o077)===0,'Private snapshot output required');
 return stat;
}
function readBounded(path,max){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const a=fstatSync(fd);assert(a.isFile()&&a.uid===process.getuid()&&a.size>0&&a.size<=max&&(a.mode&0o022)===0,'Snapshot member refused');const bytes=readFileSync(fd);const b=fstatSync(fd);assert(a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&bytes.length===b.size&&a.mtimeMs===b.mtimeMs,'Snapshot member changed while reading');return bytes;}finally{closeSync(fd);}
}
export function publishCompilerState(path,bytes,identity,completed){
 const before=directory(path,{privateOutput:true});assert.equal(readdirSync(path).length,0,'New empty snapshot directory required');
 const envelope=makeCompilerState(bytes,identity,completed);
 writeFileSync(join(path,'whole-project.tsbuildinfo'),bytes,{flag:'wx',mode:0o600});
 writeFileSync(join(path,'provenance.json'),JSON.stringify(envelope,null,2)+'\n',{flag:'wx',mode:0o600});
 const after=directory(path,{privateOutput:true});assert(before.dev===after.dev&&before.ino===after.ino,'Snapshot directory changed');return envelope;
}
export function readCompilerState(path,expected,options){
 const before=directory(path);assert(isDeepStrictEqual(readdirSync(path).sort(),['provenance.json','whole-project.tsbuildinfo']),'Unexpected snapshot members');
 const envelope=JSON.parse(readBounded(join(path,'provenance.json'),MAX_METADATA));
 const bytes=readBounded(join(path,'whole-project.tsbuildinfo'),MAX_STATE),verified=verifyCompilerState(bytes,envelope,expected,options);
 const after=directory(path);assert(before.dev===after.dev&&before.ino===after.ino,'Snapshot directory changed');return {bytes,envelope,verified};
}
