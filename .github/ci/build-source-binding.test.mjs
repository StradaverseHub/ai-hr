/** Tiny typed fixture exercises actual admission and source-binding, never application code. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceBoundBuild} from './release-ci.mjs';
import {buildPacketFixture,fixtureHash} from './build-artifact-test-fixture.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {initAiManifestFixture,regenerateAiManifests,commitAiManifestFixture,writeFixture} from './ai-manifest-test-fixture.mjs';
test('actual async verifier requires frozen source manifests and canonical preparation, refusing source/evidence drift',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ci-source-bind-'))),source=join(root,'candidate'),dir=join(root,'evidence'),packet=join(dir,BUILD_ARTIFACT);
 try{
  mkdirSync(source);initAiManifestFixture(source);
  mkdirSync(join(source,'scripts/improve'),{recursive:true});mkdirSync(join(source,'lib/system-testing'),{recursive:true});
  const packageBytes=Buffer.from('{"type":"module"}');writeFileSync(join(source,'package.json'),packageBytes);
  writeFileSync(join(source,'pnpm-lock.yaml'),'synthetic-lock');
  // The external synthetic record is created after freezing Git. No self-referential source SHA.
  writeFileSync(join(source,'scripts/improve/system-testing-manifest.ts'),
   'import {readFileSync} from "node:fs";\nexport function prepareSystemTestingBuild(p: {worktree: string; candidate: string; buildRecordId: string}) {const record=JSON.parse(readFileSync('+JSON.stringify(join(packet,'system-testing.json'))+',"utf8"));if(p.worktree!=='+JSON.stringify(source)+'||p.candidate!==record.identity.sourceRef||p.buildRecordId!==record.identity.buildRecordId)throw Error("wrong canonical request");return record;}\n');
  writeFileSync(join(source,'lib/system-testing/hash.ts'),'export const stableTestingJson = (value: unknown): string => JSON.stringify(value);\n');
  regenerateAiManifests(source);const candidate=commitAiManifestFixture(source);
  const f=buildPacketFixture({candidate}),p=f.expected;
  for(const [name,bytes]of Object.entries(f.entries)){const path=join(packet,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,bytes,{mode:0o600});}
  f.provenance.packageSha256=fixtureHash(packageBytes);writeFileSync(join(packet,'build-provenance.json'),JSON.stringify(f.provenance));
  const jobs=[{name:'build',run_id:p.runId,head_sha:p.controller,started_at:p.producerStartedAt,completed_at:p.producerCompletedAt}];
  const result=await sourceBoundBuild({candidatePath:source,dir,p,jobs});
  assert.equal(result.canonicalCandidateInputsVerified,true);assert.equal(result.releaseAuthorized,false);
  await assert.rejects(sourceBoundBuild({candidatePath:source,dir,p,jobs:[{...jobs[0],run_id:999}]}),/producing job identity/);
  writeFileSync(join(source,'pnpm-lock.yaml'),'changed');
  await assert.rejects(sourceBoundBuild({candidatePath:source,dir,p,jobs}),/exact clean candidate/);
  writeFileSync(join(source,'pnpm-lock.yaml'),f.source.lockBytes);
  writeFileSync(join(packet,'bytes/build-bundle.tar.gz'),'changed binary');
  await assert.rejects(sourceBoundBuild({candidatePath:source,dir,p,jobs}),/archive bytes differ/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('independent source binding refuses stale approval-order input before reading build evidence',async()=>{
 const source=realpathSync(mkdtempSync(join(tmpdir(),'ci-stale-source-bind-')));
 try{
  initAiManifestFixture(source);
  writeFixture(source,'lib/ai/provider-data-approvals.ts','// Changed after module generation\n');
  const candidate=commitAiManifestFixture(source);
  await assert.rejects(sourceBoundBuild({candidatePath:source,dir:'/nonexistent-synthetic-evidence',p:{candidate},jobs:[]}),/AI manifest --check refused: scripts\/ai-agent-source-manifest.mjs/);
 }finally{rmSync(source,{recursive:true,force:true});}
});
