import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {hash} from './manifest.mjs';
import {CANONICAL_DOC_PATHS,proveCanonicalRefs,validateCanonicalContext} from './canonical-docs-advance.mjs';
function fixture(change){
 const cwd=mkdtempSync(join(tmpdir(),'canonical-doc-proof-'));
 const git=(...args)=>execFileSync('git',['-c','user.name=CI fixture','-c','user.email=ci@example.invalid','-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  git('init','-q');for(const p of CANONICAL_DOC_PATHS){mkdirSync(dirname(join(cwd,p)),{recursive:true});writeFileSync(join(cwd,p),'baseline\n');}
  git('add','.');git('commit','-qm','baseline');const base=git('rev-parse','HEAD');
  for(const p of CANONICAL_DOC_PATHS)writeFileSync(join(cwd,p),'reviewed wording\n');
  change?.({cwd,git,base});git('add','.');git('commit','-qm','documentation');const head=git('rev-parse','HEAD');
  const input={cwd,originalController:base,baseline:base,candidate:base,main:head,alpha:head,approvedDocsHead:head};
  return {input,git,cleanup:()=>rmSync(cwd,{recursive:true,force:true})};
 }catch(error){rmSync(cwd,{recursive:true,force:true});throw error;}
}
test('One pinned two-path documentation commit preserves actual source and records immutable bytes',()=>{
 const f=fixture();try{const c=proveCanonicalRefs(f.input);assert.equal(c.kind,'IMMUTABLE_CANONICAL_DOCS_ADVANCE');assert.equal(c.focusedController,f.input.main);assert.equal(c.candidate,f.input.candidate);assert.deepEqual(c.paths.map(p=>p.path),CANONICAL_DOC_PATHS);assert.equal(validateCanonicalContext(c,f.input),c);}finally{f.cleanup();}
});
for(const [name,change] of [
 ['additional executable input',({cwd})=>writeFileSync(join(cwd,'package.json'),'{}')],
 ['other documentation',({cwd})=>writeFileSync(join(cwd,'docs/other.md'),'unreviewed')],
 ['deleted reviewed file',({cwd})=>unlinkSync(join(cwd,CANONICAL_DOC_PATHS[0]))],
 ['symlink reviewed file',({cwd})=>{unlinkSync(join(cwd,CANONICAL_DOC_PATHS[0]));symlinkSync('../architecture/STATUTORY-SOURCES.md',join(cwd,CANONICAL_DOC_PATHS[0]));}],
 ['executable documentation',({cwd})=>chmodSync(join(cwd,CANONICAL_DOC_PATHS[0]),0o755)],
 ['multiple commits',({git,cwd})=>{git('add','.');git('commit','-qm','first wording');writeFileSync(join(cwd,CANONICAL_DOC_PATHS[0]),'second wording\n');}],
])test('Canonical advance refuses '+name,()=>{const f=fixture(change);try{assert.throws(()=>proveCanonicalRefs(f.input));}finally{f.cleanup();}});
for(const [name,change] of [
 ['unapproved head',x=>delete x.approvedDocsHead],['wrong approved head',x=>x.approvedDocsHead=x.baseline],
 ['divergent published branches',x=>x.alpha=x.baseline],['foreign original controller',x=>x.originalController='f'.repeat(40)],
])test('Canonical identity refuses '+name,()=>{const f=fixture();try{const x={...f.input};change(x);assert.throws(()=>proveCanonicalRefs(x));}finally{f.cleanup();}});
test('Context tampering, rehashed foreign scope and changed source identities refuse',()=>{
 const f=fixture();try{const c=proveCanonicalRefs(f.input);const x=structuredClone(c);x.paths[0].headSha256='0'.repeat(64);assert.throws(()=>validateCanonicalContext(x,f.input));
  x.paths[0].path='docs/another.md';const {fingerprint,...body}=x;x.fingerprint=hash(body);assert.throws(()=>validateCanonicalContext(x,f.input));
  assert.throws(()=>validateCanonicalContext(c,{...f.input,candidate:'a'.repeat(40)}));
 }finally{f.cleanup();}
});
test('Unadvanced exact canonical refs require alignment and no documentation exception',()=>{
 const f=fixture();try{const c=proveCanonicalRefs({...f.input,main:f.input.baseline,alpha:f.input.baseline,approvedDocsHead:undefined});assert.equal(c.kind,'EXACT_CANONICAL_REFS');assert.equal(c.focusedController,f.input.originalController);}finally{f.cleanup();}
});
