/** Tiny typed fixture exercises the actual source-binding entry point, never application code. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceBoundBuild} from './release-ci.mjs';
import {buildPacketFixture} from './build-artifact-test-fixture.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
test('actual async verifier regenerates canonical preparation via candidate typed helpers and refuses source/evidence drift',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ci-source-bind-'))),source=join(root,'candidate'),dir=join(root,'evidence'),packet=join(dir,BUILD_ARTIFACT);
 const f=buildPacketFixture(),p=f.expected;
 try{
  for(const [name,bytes]of Object.entries(f.entries)){const path=join(packet,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,bytes,{mode:0o600});}
  mkdirSync(join(source,'scripts/improve'),{recursive:true});mkdirSync(join(source,'lib/system-testing'),{recursive:true});
  writeFileSync(join(source,'package.json'),'{"type":"module"}');
  // The production binder hashes package.json. Use its exact synthetic packet input below.
  const packageBytes=Buffer.from('{"type":"module"}');
  const {createHash}=await import('node:crypto');f.provenance.packageSha256=createHash('sha256').update(packageBytes).digest('hex');
  writeFileSync(join(packet,'build-provenance.json'),JSON.stringify(f.provenance));
  writeFileSync(join(source,'pnpm-lock.yaml'),f.source.lockBytes);
  writeFileSync(join(source,'scripts/improve/system-testing-manifest.ts'),
   'export function prepareSystemTestingBuild(p: {worktree: string; candidate: string; buildRecordId: string}) {if(p.worktree!=='+JSON.stringify(source)+'||p.candidate!=='+JSON.stringify(p.candidate)+'||p.buildRecordId!=='+JSON.stringify(f.provenance.buildRecordId)+')throw Error("wrong canonical request");return '+f.source.preparedBytes.toString().trim()+';}\n');
  writeFileSync(join(source,'lib/system-testing/hash.ts'),'export const stableTestingJson = (value: unknown): string => JSON.stringify(value);\n');
  const jobs=[{name:'build',run_id:p.runId,head_sha:p.controller,started_at:p.producerStartedAt,completed_at:p.producerCompletedAt}];
  const result=await sourceBoundBuild({candidatePath:source,dir,p,jobs});
  assert.equal(result.canonicalCandidateInputsVerified,true);assert.equal(result.releaseAuthorized,false);
  await assert.rejects(sourceBoundBuild({candidatePath:source,dir,p,jobs:[{...jobs[0],run_id:999}]}),/producing job identity/);
  writeFileSync(join(source,'pnpm-lock.yaml'),'changed');
  await assert.rejects(sourceBoundBuild({candidatePath:source,dir,p,jobs}),/canonical preparation differ/);
  writeFileSync(join(source,'pnpm-lock.yaml'),f.source.lockBytes);
  writeFileSync(join(packet,'bytes/build-bundle.tar.gz'),'changed binary');
  await assert.rejects(sourceBoundBuild({candidatePath:source,dir,p,jobs}),/archive bytes differ/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
