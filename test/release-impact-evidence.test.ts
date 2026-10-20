import { beforeEach,afterEach,describe,expect,it } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { impactFor,environmentHash,readyProductionBaseline,sourceFiles } from '../scripts/gate-impact-git';
import { saveGate } from '../scripts/gate-learning';
import { validateImpactReceipt,type ImpactReceipt } from '../scripts/improve/release-impact-gate';
import { coverageBody,runAttempt,unitsFor,type Unit } from '../scripts/gate-checkpoint';
let root:string,base:string,head:string,receipt:ImpactReceipt,prior:string|undefined,attempts=0;
const log=(u:Unit,ok=true)=>Buffer.from(ok?` Test Files  ${u.files.length} passed (${u.files.length})\n`:` Test Files  1 failed | ${u.files.length-1} passed (${u.files.length})\n`);
/** ADR-0133: what gate-impact-run records for each unit, driven through the same code. */
function checkpointed(r:ImpactReceipt,p:{resume?:boolean;red?:string[]}={}):ImpactReceipt{
 const plan=r.plan!,body=coverageBody({sha:r.sha!,base:r.base!,deployed:r.deployedBase!,environmentHash:r.environmentHash!,policyVersion:plan.policyVersion,tier:plan.tier,run:plan.run,browser:plan.browser,
  units:unitsFor(plan,f=>{try{return readFileSync(join(root,f),'utf8');}catch{return null;}},[])});
 const a=runAttempt({body,resume:!!p.resume,attempt:'fixture'+attempts++,planFingerprint:plan.fingerprint,planHash:'h'.repeat(64),
  execute:u=>({exitCode:p.red?.includes(u.id)?1:0,logBytes:log(u,!p.red?.includes(u.id)),startedAt:new Date().toISOString(),endedAt:new Date().toISOString()})});
 return {...r,result:a.passed?'PASS':'FAIL',checkpoints:a.checkpoints};
}
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function commit(){git('add','.');git('commit','-m','fixture');return git('rev-parse','HEAD');}
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'release-impact-'));prior=process.env.AIHR_IMPACT_STATE_DIR;process.env.AIHR_IMPACT_STATE_DIR=join(root,'.learning');
 mkdirSync(join(root,'lib'));mkdirSync(join(root,'test'));writeFileSync(join(root,'.gitignore'),'.learning/\n.env.local\n');
 git('init');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
 writeFileSync(join(root,'lib/value.ts'),'export const value=1;');writeFileSync(join(root,'test/value.test.ts'),"import '../lib/value';");
 // A database-classified consumer gives the plan two units (no-DB + one DB batch), as a real gate has.
 writeFileSync(join(root,'test/value-db.test.ts'),"import sql from '"+'post'+"gres';import '../lib/value';");base=commit();
 const baselinePlan=impactFor(base,'HEAD',root);saveGate({sha:base,base,environmentHash:environmentHash(root),result:'PASS',tier:'full',plan:baselinePlan,failed:[],wallSeconds:1,fullReceipt:{sha:base,result:'PASS',tier:'full',files:1,suiteFiles:1}});
 writeFileSync(join(root,'lib/value.ts'),'export const value=2;');head=commit();const plan=impactFor(base,'HEAD',root);
 receipt={sha:head,result:'PASS',tier:'impact',base,deployedBase:base,environmentHash:environmentHash(root),policyVersion:plan.policyVersion,plan,run:plan.run,counts:{files:plan.run.length,browserFiles:0}};
 receipt=checkpointed(receipt);
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
  receipt=checkpointed({...receipt,sha:head,base:baseline,baselineFull:full,plan,run:plan.run,counts:{files:plan.run.length}});
  expect(verify().ok).toBe(true);
  receipt.baselineFull={...full,fullReceipt:{...full.fullReceipt,result:'FAIL'}};expect(verify().ok).toBe(false);
 });
 it('an undeployed baseline needs a complete full witness, not an arbitrary convenient ref',()=>{
  receipt={...receipt,base:head};expect(verify().ok).toBe(false);
 });
});


describe('policy 2: unit checkpoints (ADR-0133)',()=>{
 it('refuses an impact receipt that lists no checkpoints, even when everything else matches',()=>{
  const {checkpoints:_,...bare}=receipt;receipt=bare;const r=verify();
  expect(r.ok).toBe(false);expect(r.lines[0]).toMatch(/lists no unit checkpoints/);
 });
 it('accepts a receipt assembled by resuming after a red unit, and says so',()=>{
  expect(receipt.checkpoints!.units.map(u=>u.unit)).toEqual(['nodb','db-001']);
  const fresh={...receipt,checkpoints:undefined};
  const red=checkpointed(fresh,{red:['db-001']});expect(red.result).toBe('FAIL');
  receipt=checkpointed(fresh,{resume:true});
  const r=verify();expect(r.ok).toBe(true);expect(receipt.checkpoints!.assembled).toBe(true);
  expect(r.lines.join('\n')).toMatch(/assembled from 2 attempt/);
 });
 it("refuses when a listed checkpoint's log changed after the gate",()=>{
  const dir=join(root,'.learning','checkpoints',head,receipt.checkpoints!.coverageId),id=receipt.checkpoints!.units[0].id;
  writeFileSync(join(dir,id+'.log'),readFileSync(join(dir,id+'.log'),'utf8')+'edited\n');
  const r=verify();expect(r.ok).toBe(false);expect(r.lines[0]).toMatch(/log was altered/);
 });
 it('refuses checkpoints taken against a different production baseline',()=>{
  const moved=checkpointed({...receipt,checkpoints:undefined,deployedBase:head},{});
  receipt={...receipt,checkpoints:moved.checkpoints};
  expect(verify().ok).toBe(false);
 });
});


describe('production baseline readiness',()=>{
 it('accepts only a completed source/build pair, refusing an in-flight or stale replacement',()=>{
  const status={state:'ok',stale_build:'0',ref:'a'.repeat(40),built_ref:'a'.repeat(40)};
  expect(readyProductionBaseline(status)).toBe(status.built_ref);
  for(const changed of [{state:'running'},{stale_build:'1'},{ref:'b'.repeat(40)},{built_ref:'short'}])expect(()=>readyProductionBaseline({...status,...changed})).toThrow('stable deployed baseline');
 });
});


describe('source collection preserves the complete tracked test/program input',()=>{
 it('retains valid source containing an embedded null character and its test dependency',()=>{
  const path='test/raw-null.test.ts';writeFileSync(join(root,path),"import '../lib/value';const value='"+String.fromCharCode(0)+"';");commit();
  expect(sourceFiles(root).has(path)).toBe(true);expect(impactFor(base,'HEAD',root).run).toContain(path);
 });
 it('retains every actual tracked code file byte-for-byte, including the real null-character fixture',()=>{
  const repository=process.cwd(),files=sourceFiles(repository);
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:repository,encoding:'utf8'}).split(String.fromCharCode(0)).filter(p=>/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p));
  for(const path of tracked){expect(files.has(path),path).toBe(true);expect(files.get(path)===readFileSync(join(repository,path),'utf8'),path).toBe(true);}
 });
});
