import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {controllerRegressionRoots,frozenRegressionRoots} from './controller-regression-roots.mjs';

function fixture(t){
 const workspace=realpathSync(mkdtempSync(join(tmpdir(),'aihr-regression-roots-')));
 t.after(()=>rmSync(workspace,{recursive:true,force:true}));
 const git=(cwd,...args)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{
  cwd,encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},
 }).trim();
 const create=(name,text)=>{
  const path=join(workspace,name);mkdirSync(path);
  git(path,'init','--quiet');writeFileSync(join(path,'fixture.txt'),text);
  git(path,'add','fixture.txt');git(path,'-c','user.name=CI Fixture','-c','user.email=ci@example.invalid','commit','--quiet','-m','Fictional fixture');
  return git(path,'rev-parse','HEAD');
 };
 return {workspace,controller:join(workspace,'automation'),controllerSha:create('automation','controller'),candidateSha:create('source','candidate')};
}

test('the regression inputs resolve two different clean committed checkouts',t=>{
 const f=fixture(t);
 assert.notEqual(f.controllerSha,f.candidateSha);
 assert.deepEqual(frozenRegressionRoots(f),{controller:f.controller,candidate:join(f.workspace,'source')});
 for(const change of [{candidateSha:f.controllerSha},{controllerSha:f.candidateSha},{candidateSha:'HEAD'},{controller:join(f.workspace,'source')}])
  assert.throws(()=>frozenRegressionRoots({...f,...change}));
});

test('dirty source, dirty automation, and aliased candidate paths refuse',t=>{
 const f=fixture(t),source=join(f.workspace,'source'),file=join(source,'fixture.txt');
 writeFileSync(file,'changed');assert.throws(()=>frozenRegressionRoots(f),/checkout is dirty/);
 writeFileSync(file,'candidate');
 const extra=join(f.controller,'untracked');writeFileSync(extra,'foreign');
 assert.throws(()=>frozenRegressionRoots(f),/checkout is dirty/);rmSync(extra);
 const renamed=join(f.workspace,'former-source');renameSync(source,renamed);symlinkSync(renamed,source);
 assert.throws(()=>frozenRegressionRoots(f),/Canonical owned regression checkout required/);
});

test('the normal resolve job refuses missing or foreign dispatch identity before fallback',()=>{
 assert.throws(()=>controllerRegressionRoots({AIHR_CI_REGRESSION_CANDIDATE:'a'.repeat(40)}),/managed resolve job/);
 assert.throws(()=>controllerRegressionRoots({GITHUB_ACTIONS:'true',GITHUB_WORKFLOW:'alpha-staging-ci',GITHUB_JOB:'resolve'}),/controller identity/);
 const ordinary=controllerRegressionRoots({});assert.equal(ordinary.candidate,ordinary.controller);
});
