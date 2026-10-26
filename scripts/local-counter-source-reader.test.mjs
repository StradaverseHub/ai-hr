/** Private Git/filesystem metadata only; no application, compiler or database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {boundedReader,trackedSourceReader} from './local-counter-exception-evidence.mjs';
import {sha256} from './local-counter-exception.mjs';
function fixture(run){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'counter-source-reader-')));
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'ignore'});
 try{
  git('init','-q');
  const route='app/(admin)/people/[id]/page.tsx';mkdirSync(join(root,'app/(admin)/people/[id]'),{recursive:true});
  writeFileSync(join(root,route),'export const value = "owned source";\n');
  writeFileSync(join(root,'plain.ts'),'plain');writeFileSync(join(root,'untracked.ts'),'not selected');
  symlinkSync(join(root,'plain.ts'),join(root,'tracked-link.ts'));git('add','--',route,'plain.ts','tracked-link.ts');
  run({root,route,git});
 }finally{rmSync(root,{recursive:true});}
}
test('tracked route parentheses/brackets are source paths, while artifact grammar stays strict',()=>fixture(({root,route})=>{
 const artifacts=[],read=trackedSourceReader(root,artifacts);
 assert.equal(read(route),'export const value = "owned source";\n');
 assert.equal(artifacts[0].path,route);assert.equal(artifacts[0].sha256,sha256('export const value = "owned source";\n'));
 assert.throws(()=>boundedReader(root,'source',[])(route),/unsafe artifact path/);
 assert.equal(read('untracked.ts'),null);assert.equal(read('missing.ts'),null);
}));
test('source reader refuses traversal, absolute/control/backslash paths and tracked symlinks',()=>fixture(({root,route})=>{
 const read=trackedSourceReader(root,[]);
 for(const path of ['', '../plain.ts','/plain.ts','app//page.tsx','app/./page.tsx','app/../plain.ts','app\\page.tsx','plain.ts\n','plain.ts\0','tracked-link.ts'])assert.throws(()=>read(path));
 rmSync(join(root,route));symlinkSync(join(root,'plain.ts'),join(root,route));assert.throws(()=>read(route));
}));
test('tracked source retains per-file and aggregate budgets and canonical ancestor refusal',()=>fixture(({root,route})=>{
 assert.throws(()=>trackedSourceReader(root,[],{maxFileBytes:4})(route),/budget/);
 const read=trackedSourceReader(root,[],{maxFileBytes:100,maxTotalBytes:5});assert.equal(read('plain.ts'),'plain');assert.throws(()=>read(route),/budget/);
 const alias=root+'-alias';symlinkSync(root,alias);
 try{assert.throws(()=>trackedSourceReader(alias,[]),/noncanonical/);}finally{rmSync(alias);}
}));
