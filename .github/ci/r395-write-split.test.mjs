/** Frozen original source and in-memory negative controls; no app, DB or Vitest execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readWriteSplitSources,verifyWriteSplit} from './r395-write-source-proof.mjs';
import {WRITE_CONTEXT_PARTITIONS as parts} from '../../test/r395-write-context-partitions.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('all original24contexts are disjoint/complete and each partition includes real non-vacuity controls',()=>{
 assert.equal(parts.primary.length,12);assert.equal(parts.secondary.length,12);assert.deepEqual([...parts.primary,...parts.secondary].sort((a,b)=>a-b),Array.from({length:24},(_,i)=>i));assert.equal(new Set([...parts.primary,...parts.secondary]).size,24);
 assert.deepEqual(parts.supplemental,[0,16]);assert(parts.supplemental.every(i=>parts.primary.includes(i)));assert(parts.supplemental.every(i=>!parts.secondary.includes(i)));assert(Object.isFrozen(parts)&&Object.values(parts).every(Object.isFrozen));
});
test('frozen original callbacks, queries, roles, savepoints, all63other cases and both thresholds are retained',()=>{
 const proof=verifyWriteSplit(readWriteSplitSources(root));assert.equal(proof.originalCases,88);assert.equal(proof.expectedSplitCases,91);assert.equal(proof.releaseAuthorized,false);
});
for(const [label,key,from,to] of [
 ['missing context','partitions','[1,4,6,8','[4,6,8'],
 ['omitted non-vacuity threshold','fixture','toBeGreaterThanOrEqual(40)','toBeGreaterThanOrEqual(0)'],
 ['changed savepoint cleanup','fixture','rollback to savepoint w; release savepoint w','release savepoint w'],
 ['missing original admin mutation','primary',"expect(mutated).toMatch(/row-level security policy for table \"person\"/);",'expect(true).toBe(true);'],
 ['same report destination','fixture',"process.env.R395_REPORT + '.' + reportLabel + '.json'",'process.env.R395_REPORT'],
 ['replacement oracle','baseline','always roll the savepoint back','sometimes keep the rows'],
])test('refuse '+label,()=>{const sources=readWriteSplitSources(root);assert(sources[key].includes(from),'Negative-control anchor is nonempty');sources[key]=sources[key].replace(from,to);assert.throws(()=>verifyWriteSplit(sources));});
