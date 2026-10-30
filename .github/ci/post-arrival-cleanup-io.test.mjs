import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync,readFileSync,lstatSync,renameSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCleanupCommit,acquireCleanupLock,consumeCleanupChallenge,publishCleanupRecord} from './post-arrival-cleanup-io.mjs';
test('production private reader accepts one bounded line and refuses EOF, oversize, malformed and timeout',async()=>{
 for(const [payload,pattern]of [['{"ok":true}\n',null],['',/EOF/],['{bad}\n',/Malformed/],['x'.repeat(65537),/bound/],['{}\n{}\n',/one/]]){
  const stream=new PassThrough(),result=readCleanupCommit(stream);stream.end(payload);
  if(pattern)await assert.rejects(result,pattern);else assert.deepEqual(await result,{ok:true});
 }
 await assert.rejects(readCleanupCommit(new PassThrough(),{deadlineMs:5}),/deadline/);
});
test('per-install exclusive lock and consumed nonce refuse concurrency/replay without changing originals',()=>{
 const root=mkdtempSync(join(tmpdir(),'cleanup-io-'));
 try{
  const install=join(root,'install');mkdirSync(install,{mode:0o700});const path=join(install,'post-arrival-finalizer.lock');
  const release=acquireCleanupLock(path,{pid:123});const original=readFileSync(path);
  assert.equal(lstatSync(path).mode&0o777,0o600);assert.throws(()=>acquireCleanupLock(path,{pid:999}));assert.deepEqual(readFileSync(path),original);
  consumeCleanupChallenge(install,{nonce:'synthetic'});const marker=readFileSync(join(install,'post-arrival-finalizer-consumed.json'));
  assert.throws(()=>consumeCleanupChallenge(install,{nonce:'other'}));assert.deepEqual(readFileSync(join(install,'post-arrival-finalizer-consumed.json')),marker);
  publishCleanupRecord(join(install,'audit.json'),{synthetic:true});assert.throws(()=>publishCleanupRecord(join(install,'audit.json'),{synthetic:false}));
  release();release();
  const releaseReplaced=acquireCleanupLock(path,{pid:123});renameSync(path,path+'.original');writeFileSync(path,'foreign',{mode:0o600});
  assert.throws(()=>releaseReplaced(),/preserved/);assert.equal(readFileSync(path,'utf8'),'foreign');
 }finally{rmSync(root,{recursive:true,force:true});}
});
