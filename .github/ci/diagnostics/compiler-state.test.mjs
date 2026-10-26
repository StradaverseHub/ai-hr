/** Pure data and private disposable files; never invoke TypeScript or app tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compilerStateIdentity,makeCompilerState,verifyCompilerState,publishCompilerState,readCompilerState} from './compiler-state.mjs';
const identity=()=>({source:'a'.repeat(40),controller:'b'.repeat(40),runId:'123',attempt:'1',runtime:{node:'22.23.3',typescript:'5.9.3',next:'16.3.8',platform:'linux',arch:'x64'},inputs:Object.fromEntries(['tsconfig','lockfile','package','workspace','nextConfig','compilerCli'].map(k=>[k,'c'.repeat(64)]))});
const state=()=>Buffer.from(JSON.stringify({version:'5.9.3',fileNames:['../../source/real-root.ts']}));
const completed=()=>({processExitCode:0,files:7046,completedAt:'2026-10-25T19:00:00Z'}),options={now:Date.parse('2026-10-25T19:05:00Z')};
test('restored state binds exact bytes, candidate, run and complete toolchain/configuration; never a PASS',()=>{
 const id=identity(),bytes=state(),proof=makeCompilerState(bytes,id,completed());assert.equal(verifyCompilerState(bytes,proof,id,options).releaseAuthorized,false);
 for(const field of ['source','controller','runId','attempt']){const changed=identity();changed[field]=field==='attempt'?'2':field==='runId'?'124':'d'.repeat(40);assert.throws(()=>verifyCompilerState(bytes,proof,changed,options));}
 for(const field of Object.keys(id.runtime)){const changed=identity();changed.runtime[field]='changed';assert.throws(()=>verifyCompilerState(bytes,proof,changed,options));}
 for(const field of Object.keys(id.inputs)){const changed=identity();changed.inputs[field]='d'.repeat(64);assert.throws(()=>verifyCompilerState(bytes,proof,changed,options));}
 assert.throws(()=>verifyCompilerState(Buffer.concat([bytes,Buffer.from(' ')]),proof,id,options));
 assert.throws(()=>verifyCompilerState(bytes,{...proof,releaseAuthorized:true},id,options));assert.throws(()=>compilerStateIdentity({...id,extra:true}));
});
test('failed, stale, malformed, empty or version-mismatched state cannot establish a cache hit',()=>{
 const id=identity(),bytes=state(),proof=makeCompilerState(bytes,id,completed());
 for(const code of [null,1,2,137])assert.throws(()=>makeCompilerState(bytes,id,{...completed(),processExitCode:code}));
 for(const value of ['', '{}','[]',JSON.stringify({version:'5.8.0',fileNames:['root.ts']}),JSON.stringify({version:'5.9.3',fileNames:[]})])assert.throws(()=>makeCompilerState(Buffer.from(value),id,completed()));
 assert.throws(()=>verifyCompilerState(bytes,proof,id,{now:options.now+25*3600000}));assert.throws(()=>verifyCompilerState(bytes,proof,id,{now:options.now-3600000}));
});
test('private fixed-file transport rejects tamper, extra members and symlink redirection',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'compiler-state-'))),dir=join(root,'snapshot');mkdirSync(dir,{mode:0o700});
 try{const id=identity(),bytes=state();publishCompilerState(dir,bytes,id,completed());assert.deepEqual(readCompilerState(dir,id,options).bytes,bytes);assert.throws(()=>publishCompilerState(dir,bytes,id,completed()));
 writeFileSync(join(dir,'extra'), 'not a compiler member');assert.throws(()=>readCompilerState(dir,id,options));rmSync(join(dir,'extra'));
 writeFileSync(join(dir,'whole-project.tsbuildinfo'),Buffer.concat([bytes,Buffer.from(' ')]));assert.throws(()=>readCompilerState(dir,id,options));rmSync(join(dir,'whole-project.tsbuildinfo'));writeFileSync(join(root,'foreign-state'),bytes,{mode:0o600});symlinkSync(join(root,'foreign-state'),join(dir,'whole-project.tsbuildinfo'));assert.throws(()=>readCompilerState(dir,id,options));
 symlinkSync(dir,join(root,'alias'));assert.throws(()=>readCompilerState(join(root,'alias'),id,options));chmodSync(dir,0o777);assert.throws(()=>readCompilerState(dir,id,options));
 }finally{rmSync(root,{recursive:true});}
});
