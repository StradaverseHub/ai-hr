import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import {execFileSync} from 'node:child_process';
import { tmpdir } from 'node:os';
import { recordReleaseLearning } from '../scripts/improve/release-learning';
import { environmentHash,impactFor } from '../scripts/gate-impact-git';
import { saveGate,releaseHistory,pendingReleaseMirrors } from '../scripts/gate-learning';
import { planImpact } from '../scripts/gate-impact';
let root:string,old:string|undefined;const sha='a'.repeat(40),base='b'.repeat(40);
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'release-hook-'));old=process.env.AIHR_IMPACT_STATE_DIR;process.env.AIHR_IMPACT_STATE_DIR=join(root,'learning');
 saveGate({sha,base,environmentHash:environmentHash(root),result:'PASS',tier:'full',plan:planImpact([],new Map()),failed:[],wallSeconds:1,fullReceipt:{sha,result:'PASS',tier:'full',files:1,suiteFiles:1}});
});
afterEach(()=>{if(old===undefined)delete process.env.AIHR_IMPACT_STATE_DIR;else process.env.AIHR_IMPACT_STATE_DIR=old;rmSync(root,{recursive:true,force:true});});
const input=()=>({worktree:root,sha,buildId:'build',receipt:{sha,result:'PASS',tier:'full'},status:{state:'ok',built_ref:sha,stale_build:'0'}});
describe('learning after the official successful deployment build',()=>{
 it('records once locally, mirrors it, and reports build evidence without claiming a restart',()=>{
  const mirror=vi.fn();const saved=recordReleaseLearning({...input(),mirror});
  expect(mirror).toHaveBeenCalledWith(saved);expect(releaseHistory()).toHaveLength(1);expect(pendingReleaseMirrors()).toEqual([]);
  expect(saved.deploymentState).toBe('built');expect(saved.activeServiceVerified).toBe(false);
 });
 it('keeps a durable outbox on a lost connection and clears it on an idempotent retry',()=>{
  expect(()=>recordReleaseLearning({...input(),mirror:()=>{throw Error('connection lost');}})).toThrow('connection lost');
  expect(releaseHistory()).toHaveLength(1);expect(pendingReleaseMirrors()).toHaveLength(1);
  recordReleaseLearning({...input(),mirror:vi.fn()});expect(releaseHistory()).toHaveLength(1);expect(pendingReleaseMirrors()).toEqual([]);
 });
 it('does not record a failed, stale, or different source as a successful release',()=>{
  expect(()=>recordReleaseLearning({...input(),status:{state:'failed',built_ref:sha,stale_build:'1'},mirror:vi.fn()})).toThrow('unverified built source');
  expect(releaseHistory()).toEqual([]);
 });
});


describe('shipping scope is distinct from the last verification repair',()=>{
 it('records every change since production even when the gate reused an undeployed full candidate',()=>{
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','--quiet');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  mkdirSync(join(root,'lib'));mkdirSync(join(root,'test'));writeFileSync(join(root,'.gitignore'),'learning/\n');
  writeFileSync(join(root,'lib/feature.ts'),'export const value=1;');writeFileSync(join(root,'lib/repair.ts'),"export function repair(){throw new Error('before');}");
  writeFileSync(join(root,'test/feature.test.ts'),"import '../lib/feature';");writeFileSync(join(root,'test/repair.test.ts'),"import '../lib/repair';");
  const commit=()=>{git('add','.');git('commit','--quiet','-m','fixture');return git('rev-parse','HEAD');};const deployed=commit();
  writeFileSync(join(root,'lib/feature.ts'),'export const value=2;');const fullCandidate=commit();
  writeFileSync(join(root,'lib/repair.ts'),"export function repair(){throw new Error('after');}");const head=commit(),plan=impactFor(fullCandidate,'HEAD',root);
  saveGate({sha:head,base:fullCandidate,environmentHash:environmentHash(root),result:'PASS',tier:'impact',plan,failed:[],wallSeconds:1});
  const record=recordReleaseLearning({worktree:root,sha:head,buildId:'scope',previousRef:deployed,receipt:{sha:head,result:'PASS',tier:'impact'},status:{state:'ok',built_ref:head,stale_build:'0'},mirror:vi.fn()});
  expect(record.gate?.plan.changed).toEqual(['lib/repair.ts']);
  expect(record.classifications.map(c=>c.path).sort()).toEqual(['lib/feature.ts','lib/repair.ts']);
  expect(record.deployedBase).toBe(deployed);expect(record.impactUncertainties).toEqual([]);
 });
 it('retains a verified build and explicitly saves unknown scope when the deployed baseline cannot be reconstructed',()=>{
  const unavailable='d'.repeat(40),record=recordReleaseLearning({...input(),previousRef:unavailable,mirror:vi.fn()});
  expect(record.deployedBase).toBe(unavailable);expect(record.impactUncertainties).toHaveLength(1);expect(releaseHistory()).toHaveLength(1);
 });
});
