/** Separate trusted test code from frozen candidate fixtures before dependency hooks. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SINGLETON_FILES} from './singleton-protocol.mjs';

const controllerRoot=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);

// Shared singleton fixtures that only a singleton-bearing candidate tracks. The regression
// checkout is verified clean, so presence on disk is tracked presence.
const SINGLETON_FIXTURE_MARKERS=Object.freeze([
 'test/fixtures/historical-migrations','test/helpers/ci-singleton-admission.ts',
]);
/**
 * Regression fixtures built from the candidate's own singleton closure apply only to a
 * candidate that carries one. ANY registered singleton file or shared singleton fixture
 * selects the strict mode, where every missing closure member still fails. Only a
 * candidate with none of them (for example a main-based candidate, whose plan cannot form
 * a singleton unit) is singleton-free.
 */
export function candidateCarriesSingletonFixtures(candidate){
 const present=path=>{try{lstatSync(join(candidate,path));return true;}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}};
 return [...SINGLETON_FIXTURE_MARKERS,...Object.keys(SINGLETON_FILES)].some(present);
}
export const SINGLETON_FREE_CANDIDATE='singleton-free candidate: no registered singleton file or shared singleton fixture is tracked, so its plan cannot form a singleton unit';

export function frozenRegressionRoots({workspace,controller,candidateSha,controllerSha}){
 assert(typeof workspace==='string'&&realpathSync(workspace)===workspace,'Canonical regression workspace required');
 assert.equal(controller,join(workspace,'automation'),'Regression test code must come from automation');
 assert(sha(candidateSha)&&sha(controllerSha),'Exact regression source and controller commits required');
 const candidate=join(workspace,'source');
 for(const [root,expected] of [[controller,controllerSha],[candidate,candidateSha]]){
  const info=lstatSync(root);
  assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&realpathSync(root)===root,'Canonical owned regression checkout required');
  const git=(...args)=>execFileSync('/usr/bin/git',['--no-replace-objects','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{
   cwd:root,encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
   env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0'},
  }).trim();
  assert.equal(git('rev-parse','--show-toplevel'),root,'Regression checkout Git root differs');
  assert.equal(git('rev-parse','HEAD'),expected,'Regression checkout commit differs');
  assert.equal(git('status','--porcelain=v1','--untracked-files=all'),'','Regression checkout is dirty');
 }
 return {controller,candidate};
}

export function controllerRegressionRoots(env=process.env){
 const managed=env.GITHUB_ACTIONS==='true'&&env.GITHUB_WORKFLOW==='alpha-staging-ci'&&env.GITHUB_JOB==='resolve';
 if(!managed){
  assert(env.AIHR_CI_REGRESSION_CANDIDATE===undefined,'Split controller regression requires the managed resolve job');
  return {controller:controllerRoot,candidate:controllerRoot};
 }
 assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856'
  &&env.GITHUB_WORKFLOW_SHA===env.AIHR_CI_CONTROL_HEAD,'Unexpected regression controller identity');
 return frozenRegressionRoots({workspace:env.GITHUB_WORKSPACE,controller:controllerRoot,
  controllerSha:env.AIHR_CI_CONTROL_HEAD,candidateSha:env.AIHR_CI_REGRESSION_CANDIDATE});
}
