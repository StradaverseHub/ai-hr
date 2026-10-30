/** Frozen original source and in-memory negative controls; no app, DB or Vitest execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readWriteSplitSources,verifyWriteSplit} from './r395-write-source-proof.mjs';
import {WRITE_CONTEXT_PARTITIONS as parts} from '../../test/r395-write-context-partitions.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('all original24contexts are disjoint/complete and each partition includes real non-vacuity controls',()=>{
 for(const label of ['primary','secondary','tertiary'])assert.equal(parts[label].length,8);assert.deepEqual([...parts.primary,...parts.secondary,...parts.tertiary].sort((a,b)=>a-b),Array.from({length:24},(_,i)=>i));assert.equal(new Set([...parts.primary,...parts.secondary,...parts.tertiary]).size,24);
 assert.deepEqual(parts.supplemental,[0,16]);assert(parts.supplemental.every(i=>parts.primary.includes(i)));assert(parts.supplemental.every(i=>!parts.secondary.includes(i)&&!parts.tertiary.includes(i)));assert(Object.isFrozen(parts)&&Object.values(parts).every(Object.isFrozen));
});
test('frozen original oracle, callbacks, queries, roles, all63other cases and both thresholds retain the exact reviewed parent controls',()=>{
 const proof=verifyWriteSplit(readWriteSplitSources(root));assert.equal(proof.originalCases,88);assert.equal(proof.expectedSplitCases,94);assert.equal(proof.releaseAuthorized,false);
});
for(const [label,key,from,to] of [
 ['missing context','partitions','[3,5,12,14','[5,12,14'],
 ['omitted non-vacuity threshold','fixture','toBeGreaterThanOrEqual(40)','toBeGreaterThanOrEqual(0)'],
 ['changed savepoint cleanup','fixture','rollback to savepoint w; release savepoint w','release savepoint w'],
 ['missing original admin mutation','primary',"expect(mutated).toMatch(/row-level security policy for table \"person\"/);",'expect(true).toBe(true);'],
 ['same report destination','fixture',"process.env.R395_REPORT + '.' + reportLabel + '.json'",'process.env.R395_REPORT'],
 ['missing tertiary control','tertiary','it.each(WRITE_CONTEXT_PARTITIONS.supplemental)', 'it.each([])'],
 ['duplicate partition report','tertiary',"registerR395WriteFixture('tertiary')","registerR395WriteFixture('secondary')"],
 ['replacement oracle','baseline','always roll the savepoint back','sometimes keep the rows'],
])test('refuse '+label,()=>{const sources=readWriteSplitSources(root);assert(sources[key].includes(from),'Negative-control anchor is nonempty');sources[key]=sources[key].replace(from,to);assert.throws(()=>verifyWriteSplit(sources));});

test('reviewed fixture delta is bound to both independently pinned source identities',()=>{
 const proof=verifyWriteSplit(readWriteSplitSources(root));
 assert.equal(proof.baselineSha256,'b1a7affec35ccb616ddebf276dc211f24ef77a85d6fbdf5016c9bc6dad6b61f0');
 assert.equal(proof.reviewedFixtureCommit,'92a2c35b00c9830df6a2817b98b78af62e1474c0');
 assert.equal(proof.reviewedFixtureDeltaSha256,'f9f477e5d99eaf78642dccdf1567d736fa2af7755cbdee25f57c614e78a8a2df');
 assert.equal(proof.reviewedOrgSha256,'2512747bb6c33510d2458365a980917f990cc2de6844a64bf027cf58a7b535fe');
 assert.equal(proof.reviewedWriteFixtureSha256,'d325fa02e1a5be12e6bfc363aa38c3c743c29b61f3bc239386421e1dbf50956a');
 assert.equal(proof.originalCases,88);assert.equal(proof.expectedSplitCases,94);assert.equal(proof.releaseAuthorized,false);
});
for(const [label,key,from,to] of [
 ['missing fresh child subject','fixture',"['freshChildA','freshChildB','freshChildA1']","['freshChildB','freshChildA1']"],
 ['missing parent binding custody','fixture','freshParents.set(String(subject.id),bindings);','freshParents.clear();'],
 ['missing original-policy positive assertion','fixture','expect(before[k],`constraint-valid positive control: ${labels[k]}`).toMatch(/^ok:/);','expect(true).toBe(true);'],
 ['missing current-policy positive assertion','fixture','expect(after[k],`current-policy positive control: ${labels[k]}`).toMatch(/^ok:/);','expect(true).toBe(true);'],
 ['missing parent tenant assertion','fixture','expect(parent.tenant_id,`${table} tenant`).toBe(subject.tenant_id);','expect(true).toBe(true);'],
 ['missing cancellation parent binding assertion','fixture',"if(table==='leave_cancellation_request')expect(parent.leave_request_id).toBe(bindings.leave_request);",'expect(true).toBe(true);'],
 ['missing helper parent binding','org','if (ref && Object.hasOwn(parentBindings,ref)) v=lit(parentBindings[ref]);','if (false) v=null;'],
 ['changed helper outside reviewed delta','org','export async function fillTables()','export async function fillDifferentTables()'],
 ['changed frozen helper oracle','orgBaseline','export async function fillTables()','export async function fillDifferentTables()'],
 ['changed reviewed delta provenance','reviewedDelta','92a2c35b00c9830df6a2817b98b78af62e1474c0','4f66743d56f34755bb662824e163bfbef5f6ff17'],
])test('refuse '+label,()=>{const sources=readWriteSplitSources(root);assert(sources[key].includes(from),'Negative-control anchor is nonempty');sources[key]=sources[key].replace(from,to);assert.throws(()=>verifyWriteSplit(sources));});
test('refuse reverting the reviewed fixture to the old split fixture',()=>{
 const sources=readWriteSplitSources(root),delta=JSON.parse(sources.reviewedDelta);
 for(const {before,after} of [...delta.files.fixture.edits].reverse()){
  assert.equal(sources.fixture.split(after).length,2);sources.fixture=sources.fixture.replace(after,()=>before);
 }
 assert.throws(()=>verifyWriteSplit(sources));
});
