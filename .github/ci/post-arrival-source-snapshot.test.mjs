/** Hosted byte/metadata fixtures only; never connects to staging or verifies an application. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync,lstatSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {digest} from './post-arrival-cleanup-policy.mjs';
import {createSourceSnapshot,verifySnapshot} from './post-arrival-source-snapshot.mjs';
test('read-only sender metadata can normalize a disposable snapshot while immutable bytes and original stay unchanged',()=>{
 const root=mkdtempSync(join(tmpdir(),'source-snapshot-'));
 try{
  const original=join(root,'original'),sender=join(root,'sender'),snapshot=join(root,'snapshot');mkdirSync(original);mkdirSync(sender);
  for(const path of [join(original,'fixture.txt'),join(sender,'fixture.txt')]){writeFileSync(path,'public synthetic source\n');chmodSync(path,0o644);}
  utimesSync(join(original,'fixture.txt'),1000000000,1000000000);utimesSync(join(sender,'fixture.txt'),1100000000,1100000000);
  const before=lstatSync(join(original,'fixture.txt')).mtimeMs,rows=[{path:'fixture.txt',kind:'file',mode:0o644,sha256:digest(readFileSync(join(original,'fixture.txt')))}];
  createSourceSnapshot(original,snapshot,rows);const list=join(root,'files');writeFileSync(list,'fixture.txt\n');
  execFileSync('rsync',['-a','--checksum','--existing','--files-from='+list,sender+'/',snapshot+'/']);
  verifySnapshot(snapshot,rows);assert.equal(lstatSync(join(original,'fixture.txt')).mtimeMs,before);assert.equal(lstatSync(join(snapshot,'fixture.txt')).mtimeMs,lstatSync(join(sender,'fixture.txt')).mtimeMs);
  writeFileSync(join(snapshot,'fixture.txt'),'different');assert.throws(()=>verifySnapshot(snapshot,rows),/Git bytes/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('unknown members, directories and unsafe inventory paths refuse',()=>{
 const root=mkdtempSync(join(tmpdir(),'source-snapshot-'));
 try{
  const original=join(root,'original');mkdirSync(original);writeFileSync(join(original,'a'),'a');chmodSync(join(original,'a'),0o644);
  const rows=[{path:'a',kind:'file',mode:0o644,sha256:digest('a')}];
  assert.throws(()=>createSourceSnapshot(original,join(root,'unsafe'),[{...rows[0],path:'../a'}]));
  const snapshot=join(root,'snapshot');createSourceSnapshot(original,snapshot,rows);mkdirSync(join(snapshot,'unknown'));
  assert.throws(()=>verifySnapshot(snapshot,rows),/Unknown/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
