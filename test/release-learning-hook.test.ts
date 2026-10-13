import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordReleaseLearning } from '../scripts/improve/release-learning';
import { environmentHash } from '../scripts/gate-impact-git';
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
