import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {bindOriginalController,ORIGINAL_AUTHORITY_ROOTS} from './ci-origin-binding.mjs';
function fixture(t){const repository=mkdtempSync(join(tmpdir(),'aihr-controller-binding-'));t.after(()=>rmSync(repository,{recursive:true,force:true}));const git=(...args)=>execFileSync('git',args,{cwd:repository,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git('init','-q');git('config','user.name','Private fixture');git('config','user.email','fixture@example.invalid');const put=(path,bytes)=>{mkdirSync(dirname(join(repository,path)),{recursive:true});writeFileSync(join(repository,path),bytes);};for(const path of [...ORIGINAL_AUTHORITY_ROOTS.map(p=>'.github/ci/'+p),'scripts/gate-db-classify.ts'])put(path,'original '+path);const commit=()=>{git('add','.');git('commit','-qm','fixture');return git('rev-parse','HEAD');};const controller=commit();put('extension.mjs','new verifier');const verifier=commit();return {repository,controller,verifier,put,commit};}
test('extension preserves exact original controller and all authority bytes',t=>{const f=fixture(t),proof=bindOriginalController(f);assert.equal(proof.controller,f.controller);assert.equal(proof.verifier,f.verifier);assert.equal(proof.pins.length,ORIGINAL_AUTHORITY_ROOTS.length+1);assert.equal(proof.releaseAuthorized,false);});
test('changing an original authority primitive refuses',t=>{const f=fixture(t);f.put('.github/ci/release-policy.mjs','weaker');f.verifier=f.commit();assert.throws(()=>bindOriginalController(f),/authority primitive differs/);});
test('a verifier preceding its original controller refuses',t=>{const f=fixture(t);assert.throws(()=>bindOriginalController({...f,controller:f.verifier,verifier:f.controller}));});
test('non-exact identities refuse',t=>{const f=fixture(t);assert.throws(()=>bindOriginalController({...f,controller:'alpha'}),/Exact/);});
