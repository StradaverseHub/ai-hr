import { beforeEach,afterEach,describe,expect,it } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { impactFor,environmentHash,readyProductionBaseline } from '../scripts/gate-impact-git';
import { saveGate } from '../scripts/gate-learning';
import { validateImpactReceipt,type ImpactReceipt } from '../scripts/improve/release-impact-gate';
let root:string,base:string,head:string,receipt:ImpactReceipt,prior:string|undefined;
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function commit(){git('add','.');git('commit','-m','fixture');return git('rev-parse','HEAD');}
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'release-impact-'));prior=process.env.AIHR_IMPACT_STATE_DIR;process.env.AIHR_IMPACT_STATE_DIR=join(root,'.learning');
 mkdirSync(join(root,'lib'));mkdirSync(join(root,'test'));writeFileSync(join(root,'.gitignore'),'.learning/\n.env.local\n');
 git('init');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
 writeFileSync(join(root,'lib/value.ts'),'export const value=1;');writeFileSync(join(root,'test/value.test.ts'),"import '../lib/value';");base=commit();
 const baselinePlan=impactFor(base,'HEAD',root);saveGate({sha:base,base,environmentHash:environmentHash(root),result:'PASS',tier:'full',plan:baselinePlan,failed:[],wallSeconds:1,fullReceipt:{sha:base,result:'PASS',tier:'full',files:1,suiteFiles:1}});
 writeFileSync(join(root,'lib/value.ts'),'export const value=2;');head=commit();const plan=impactFor(base,'HEAD',root);
 receipt={sha:head,result:'PASS',tier:'impact',base,deployedBase:base,environmentHash:environmentHash(root),policyVersion:plan.policyVersion,plan,run:plan.run,counts:{files:plan.run.length,browserFiles:0}};
});
afterEach(()=>{if(prior===undefined)delete process.env.AIHR_IMPACT_STATE_DIR;else process.env.AIHR_IMPACT_STATE_DIR=prior;rmSync(root,{recursive:true,force:true});});
const verify=()=>validateImpactReceipt(receipt,{head,deployedRef:base,worktree:root});
describe('impact receipt against actual git, environment and test graph',()=>{
 it('accepts complete counted coverage for the exact clean revision',()=>{expect(verify().ok).toBe(true);});
 it('refuses stale revisions and moved production',()=>{
  expect(validateImpactReceipt(receipt,{head:'c'.repeat(40),deployedRef:base,worktree:root}).ok).toBe(false);
  expect(validateImpactReceipt(receipt,{head,deployedRef:'d'.repeat(40),worktree:root}).ok).toBe(false);
 });
 it('refuses dirty source or a changed environment',()=>{
  writeFileSync(join(root,'lib/value.ts'),'export const value=3;');expect(verify().ok).toBe(false);
  git('restore','lib/value.ts');writeFileSync(join(root,'.env.local'),'TEST_FLAG=changed');expect(verify().ok).toBe(false);
 });
 it('refuses omitted tests, changed fingerprints, and unverified policy versions',()=>{
  const valid={...receipt};receipt={...valid,run:[],counts:{files:0}};expect(verify().ok).toBe(false);
  receipt={...valid,policyVersion:999};expect(verify().ok).toBe(false);
  receipt={...valid,plan:{...valid.plan!,fingerprint:'altered'}};expect(verify().ok).toBe(false);
 });
 it('reuses a full verified candidate for a later repair before that candidate is deployed',()=>{
  const baseline=head,full=saveGate({sha:baseline,base,environmentHash:environmentHash(root),result:'PASS',tier:'full',plan:receipt.plan!,failed:[],wallSeconds:1,fullReceipt:{sha:baseline,result:'PASS',tier:'full',files:1,suiteFiles:1}});
  writeFileSync(join(root,'lib/value.ts'),'export const value=3;');head=commit();const plan=impactFor(baseline,'HEAD',root);
  receipt={...receipt,sha:head,base:baseline,baselineFull:full,plan,run:plan.run,counts:{files:plan.run.length}};
  expect(verify().ok).toBe(true);
  receipt.baselineFull={...full,fullReceipt:{...full.fullReceipt,result:'FAIL'}};expect(verify().ok).toBe(false);
 });
 it('an undeployed baseline needs a complete full witness, not an arbitrary convenient ref',()=>{
  receipt={...receipt,base:head};expect(verify().ok).toBe(false);
 });
});


describe('production baseline readiness',()=>{
 it('accepts only a completed source/build pair, refusing an in-flight or stale replacement',()=>{
  const status={state:'ok',stale_build:'0',ref:'a'.repeat(40),built_ref:'a'.repeat(40)};
  expect(readyProductionBaseline(status)).toBe(status.built_ref);
  for(const changed of [{state:'running'},{stale_build:'1'},{ref:'b'.repeat(40)},{built_ref:'short'}])expect(()=>readyProductionBaseline({...status,...changed})).toThrow('stable deployed baseline');
 });
});
