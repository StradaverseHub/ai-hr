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
test('frozen original callbacks, queries, roles, savepoints, all63other cases and both thresholds are retained',()=>{
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
