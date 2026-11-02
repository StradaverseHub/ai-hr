import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {admitAiManifests} from './ai-manifest-admission.mjs';
import {initAiManifestFixture,writeFixture,commitAiManifestFixture,regenerateAiManifests,fixtureGit} from './ai-manifest-test-fixture.mjs';
const withFixture=fn=>{const cwd=mkdtempSync(join(tmpdir(),'ai-manifest-admission-'));try{fn(cwd,initAiManifestFixture(cwd));}finally{rmSync(cwd,{recursive:true,force:true});}};
test('both canonical manifest checks admit only the exact clean frozen candidate',()=>withFixture((cwd,sha)=>{
 const result=admitAiManifests(cwd,sha);assert.equal(result.releaseAuthorized,false);assert.equal(result.checks.length,2);
 assert(result.checks.every(c=>c.files>0&&c.digest.length===64));
 assert.throws(()=>admitAiManifests(cwd,'f'.repeat(40)),/exact clean/);
 writeFixture(cwd,'untracked.txt','changed');assert.throws(()=>admitAiManifests(cwd,sha),/exact clean/);
}));
test('provider approval updated AFTER generation reproduces the accepted-source ordering defect',()=>withFixture((cwd)=>{
 const provider=readFileSync(join(cwd,'lib/ai/provider-data-source-manifest.ts'));
 writeFixture(cwd,'lib/ai/provider-data-approvals.ts','export const fixtureApproval = {sourceDigest: "'+'b'.repeat(64)+'"};\n');
 const sha=commitAiManifestFixture(cwd),approval=readFileSync(join(cwd,'lib/ai/provider-data-approvals.ts'));
 // Provider check still passes because approval rows are deliberately outside its own closure.
 execFileSync(process.execPath,['scripts/ai-provider-data-source-manifest.mjs','--check'],{cwd,stdio:'pipe'});
 assert.throws(()=>admitAiManifests(cwd,sha),/ai-agent-source-manifest.mjs/);
 assert(readFileSync(join(cwd,'lib/ai/provider-data-approvals.ts')).equals(approval));
 assert(readFileSync(join(cwd,'lib/ai/provider-data-source-manifest.ts')).equals(provider));
 assert.equal(fixtureGit(cwd,'status','--porcelain'),'');
 regenerateAiManifests(cwd);const corrected=commitAiManifestFixture(cwd);
 assert.equal(admitAiManifests(cwd,corrected).checks.length,2);
 assert(readFileSync(join(cwd,'lib/ai/provider-data-approvals.ts')).equals(approval));
}));
test('provider source drift and BOTH stale manifests are refused independently',()=>withFixture((cwd)=>{
 writeFixture(cwd,'core/performance.ts','// changed provider-only closure input\n');
 const sha=commitAiManifestFixture(cwd);assert.throws(()=>admitAiManifests(cwd,sha),error=>error.message.includes('ai-provider-data-source-manifest.mjs')&&!error.message.includes(', scripts/ai-agent-source-manifest.mjs'));
 writeFixture(cwd,'lib/ai/provider-data-approvals.ts','// changed AI module input\n');
 const both=commitAiManifestFixture(cwd);assert.throws(()=>admitAiManifests(cwd,both),/ai-provider-data-source-manifest.mjs, scripts\/ai-agent-source-manifest.mjs/);
}));
test('candidate cannot replace reviewed generator or source scope with a successful no-op',()=>withFixture((cwd)=>{
 writeFixture(cwd,'scripts/ai-agent-source-manifest.mjs','process.stdout.write(JSON.stringify({files:1,digest:"'+'a'.repeat(64)+'"}));\n');
 assert.throws(()=>admitAiManifests(cwd,commitAiManifestFixture(cwd)),/Unreviewed AI manifest/);
}));
test('normal plan, canonical build, and all operator recovery source bindings require admission',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const workflow=readFileSync(join(root,'.github/workflows/alpha-staging.yml'),'utf8');
 for(const section of ['plan','build']){
  const block=workflow.split('\n  '+section+':\n')[1].split(/^  [a-z][a-z_-]*:\n/m)[0];
  assert(block.includes('node ../automation/.github/ci/ai-manifest-admission.mjs . "$AIHR_CI_HEAD"'));
  assert(block.indexOf('ai-manifest-admission.mjs')<block.indexOf(section==='plan'?'node ../automation/.github/ci/plan.mjs':'next-application-cache.mjs'));
 }
 const operator=readFileSync(join(root,'.github/ci/release-ci.mjs'),'utf8');
 assert(operator.includes('admitAiManifests(candidatePath,p.candidate);'));
 for(const name of ['focused-recovery.mjs','repair-recovery.mjs','browser-recovery.mjs'])assert(readFileSync(join(root,'.github/ci',name),'utf8').includes('await sourceBoundBuild('));
});
