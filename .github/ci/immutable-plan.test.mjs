import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {immutablePlan} from './immutable-plan.mjs';
const runtime={node:'22.23.3',platform:'linux',arch:'x64'};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'aihr-immutable-plan-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const write=(p,s)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),s);};
 for(const p of ['.github/ci/policy-version.mjs','.github/ci/manifest.mjs','.github/ci/db-scheduling.mjs','.github/ci/db-duration-hints.json','.github/ci/pdf-tool-scope.mjs','scripts/gate-db-classify.ts','lib/borang-8a-pdf.ts','lib/borang-8b-pdf.ts','lib/cp21-fields.ts','lib/cp22a-fields.ts'])
  write(p,readFileSync(new URL('../../'+p,import.meta.url)));
 write('test/payslip-pdf.test.ts','// pdftotext\n');write('test/r379-pcb2ii-pdf.test.ts','// pdftoppm\n');
 write('test/sample.dom.test.tsx',"import fixture from './fixture.json';\n");write('test/fixture.json','{}');
 write('test/db.test.ts',"import './harness';\n");write('test/harness.ts','// DATABASE_URL\n');
 write('test/experience.browser.test.tsx','// browser\n');
 git('init','-q');git('config','user.name','Private fixture');git('config','user.email','fixture@example.invalid');
 const commit=()=>{git('add','.');git('commit','-qm','private fixture');return git('rev-parse','HEAD');};
 const initial=commit();const args={repository:root,candidate:initial,controller:initial,baseline:initial,runtime};
 return {root,git,write,commit,args,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('complete immutable membership includes JSON-resolved DOM files and all engines',()=>{
 const f=fixture();try{
  const r=immutablePlan(f.args);assert.equal(r.plan.suite.length,4);assert.equal(r.plan.units.filter(u=>u.kind==='browser').length,3);
  assert(r.plan.units.some(u=>u.kind==='nodb'&&u.files.includes('test/sample.dom.test.tsx')));
  assert(r.plan.units.some(u=>u.kind==='db'&&u.files.includes('test/db.test.ts')));
  assert.equal(r.binding.candidateCodeExecuted,false);
 }finally{f.close();}
});
test('dirty and untracked working bytes cannot change historical coverage',()=>{
 const f=fixture();try{const before=immutablePlan(f.args);f.write('test/sample.dom.test.tsx','// DATABASE_URL');f.write('test/untracked.test.ts','// DATABASE_URL');assert.deepEqual(immutablePlan(f.args),before);}finally{f.close();}
});
test('new commit follows actual changed fixture bytes and never executes candidate classifier',()=>{
 const f=fixture();try{
  f.write('scripts/gate-db-classify.ts',"throw Error('candidate classifier must never execute');");
  f.write('test/fixture.json','{"connection":"DATABASE_URL"}');const candidate=f.commit();
  const r=immutablePlan({...f.args,candidate});assert(r.plan.units.some(u=>u.kind==='db'&&u.files.includes('test/sample.dom.test.tsx')));
  assert.equal(r.plan.sha,candidate);
 }finally{f.close();}
});
test('another controller policy is refused rather than relabelled under current topology',()=>{
 const f=fixture();try{f.write('.github/ci/policy-version.mjs',"export const CI_POLICY='other';");const controller=f.commit();assert.throws(()=>immutablePlan({...f.args,candidate:controller,controller}),/Controller planning inputs differ/);}finally{f.close();}
});
test('nonregular coverage source and symbolic identities are refused',()=>{
 const f=fixture();try{assert.throws(()=>immutablePlan({...f.args,candidate:'HEAD'}),/Exact immutable/);f.git('update-index','--add','--cacheinfo','120000,'+f.git('hash-object','-w','--stdin')+',test/unsafe.test.ts');f.git('commit','-qm','symlink fixture');const candidate=f.git('rev-parse','HEAD');assert.throws(()=>immutablePlan({...f.args,candidate}),/Nonregular coverage source/);}finally{f.close();}
});

test('reviewed v12 profile retains its original policy and rejects altered timing bytes',()=>{
 const f=fixture();try{
  f.write('.github/ci/policy-version.mjs',"export const CI_POLICY='aihr-staging-ci/v12';\n");
  const hints=readFileSync(new URL('./fixtures/resume-v12-duration-hints.json',import.meta.url));
  f.write('.github/ci/db-duration-hints.json',hints);const controller=f.commit();
  const r=immutablePlan({...f.args,candidate:controller,controller});assert.equal(r.plan.policyVersion,'aihr-staging-ci/v12');
  assert.equal(r.plan.execution.scheduling.hintsSha256,'fe1443fdbb01760720d1e7630a659a7fd6366e72d3216ca39672ad8ca8c588db');
  f.write('.github/ci/db-duration-hints.json',Buffer.concat([hints,Buffer.from(' ')]));const bad=f.commit();
  assert.throws(()=>immutablePlan({...f.args,candidate:bad,controller:bad}),/Controller planning inputs differ/);
 }finally{f.close();}
});
