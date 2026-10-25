import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,symlinkSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {repairArtifactReader} from './local-environment-repair-evidence.mjs';
import {digest} from './local-environment-repair.mjs';
test('Reader binds exact regular artifact bytes and nested paths',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-repair-reader-')));
 try{
  mkdirSync(join(root,'full'));writeFileSync(join(root,'full','result.json'),'{}\n');const manifest=[];
  assert.equal(repairArtifactReader(root,'original',manifest)('full/result.json'),'{}\n');
  assert.deepEqual(manifest,[{group:'original',path:'full/result.json',bytes:3,sha256:digest('{}\n')}]);
 }finally{rmSync(root,{recursive:true});}
});
test('Reader refuses traversal, symlink files/directories, missing files and nonfiles',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-repair-reader-')));
 try{
  mkdirSync(join(root,'real'));writeFileSync(join(root,'real','record.json'),'{}');
  symlinkSync(join(root,'real','record.json'),join(root,'file-link'));symlinkSync(join(root,'real'),join(root,'directory-link'));
  const read=repairArtifactReader(root,'fresh',[]);
  for(const path of ['../record.json','real/../real/record.json','/record.json','./real/record.json','real//record.json','file-link','directory-link/record.json','real','missing.json'])assert.throws(()=>read(path),path);
  assert.throws(()=>repairArtifactReader(join(root,'directory-link'),'fresh',[]));
 }finally{rmSync(root,{recursive:true});}
});
