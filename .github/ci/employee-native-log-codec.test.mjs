import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=file=>readFileSync(new URL('../../'+file,import.meta.url),'utf8'),sha=value=>createHash('sha256').update(value).digest('hex');
const originals={
 'test/performance/employee-choice-auto-explain-parser.ts':'d2465c782990fe4a03896d0b4378526d0b49e9e9302a98b3bc76dfd625f502d4',
 'test/performance/employee-choice-native-log-stream.ts':'5c5a215f509cd33e0aa4410eca27c626c96ffadeaa8fe79e297b101e1a8c53db',
 'test/performance/employee-choice-native-log-parts.ts':'9e4f031ce19b8f851d5b284f1709dbdb8e351a325e2c04173fd89e352a84e1a9',
 'test/performance/employee-choice-plan-work.ts':'4a6eb56b6e96e5311b233ce5259f5cdc2edc149c1e5bde33d92d980662670560',
};
test('canonical pure codec reconstructs every ordered original body with only enumerated type erasures',()=>{
 const proof=JSON.parse(read('docs/qualification/employee-native-log-codec-inverse-20261108.json'));
 assert.equal(proof.base,'8a494e850f287b5a47191d62d762ad00281d2c70');assert.equal(proof.semanticBehaviorQualified,false);assert.equal(proof.releaseAuthorized,false);assert.deepEqual(Object.keys(proof.originalSources).sort(),Object.keys(originals).sort());
 for(const [file,expected]of Object.entries(originals)){assert.equal(proof.originalSources[file].sha256,expected);assert.equal(sha(proof.originalSources[file].bytes),expected);}
 const body=file=>proof.originalSources[file].bytes.split('\n').filter(line=>!line.startsWith('import ')&&!line.startsWith('export type ')).join('\n');
 const parts=proof.originalSources['test/performance/employee-choice-native-log-parts.ts'].bytes,partStart=parts.indexOf(proof.composition.parts.start),partEnd=parts.indexOf(proof.composition.parts.end,partStart);assert(partStart>0&&partEnd>partStart);
 let assembled=[parts.slice(partStart,partEnd),body('test/performance/employee-choice-auto-explain-parser.ts'),body('test/performance/employee-choice-native-log-stream.ts')].join('\n');
 for(const {before,after,count}of proof.typeErasures){assert.equal(assembled.split(before).length-1,count);assembled=assembled.replaceAll(before,after);}
 const work=proof.additionalPureWork;let pureWork=proof.originalSources[work.source].bytes.slice(proof.originalSources[work.source].bytes.indexOf(work.start));
 for(const {before,after,count}of work.typeErasures){assert.equal(pureWork.split(before).length-1,count);pureWork=pureWork.replaceAll(before,after);}
 const canonical=read('.github/ci/employee-native-log-codec.mjs');assert.equal(canonical,proof.composition.header+assembled+'\n'+pureWork);assert.equal(sha(canonical),proof.canonicalSha256);
 assert.deepEqual([...canonical.matchAll(/^import .* from '([^']+)';$/gm)].map(match=>match[1]),['node:crypto','node:util','node:zlib']);
});
test('the entire SQL, native population and exact cardinality reader prefix remains byte-identical',()=>{
 const proof=JSON.parse(read('docs/qualification/employee-native-log-codec-inverse-20261108.json')),work=proof.additionalPureWork;
 const original=proof.originalSources[work.source].bytes,prefix=original.slice(0,original.indexOf(work.start));
 const current=read(work.source),importLine="import {employeeChoicePlanLimits as nativeLimits,employeeChoicePlanWork as nativeWork} from '../../.github/ci/employee-native-log-codec.mjs';\n";
 assert(current.startsWith(importLine+prefix));assert(!current.slice(importLine.length+prefix.length).includes('tx.execute'));
});
test('owned native log publication and descriptor/store behavior reconstruct byte-for-byte outside the extracted decoder',()=>{
 const proof=JSON.parse(read('docs/qualification/employee-native-log-codec-inverse-20261108.json')),inverse=proof.typedPartWriterInverse;let current=read(inverse.source);assert.equal(sha(current),inverse.currentSha256);
 for(const {before,after}of [...inverse.changes].reverse()){assert.equal(current.split(after).length-1,1);current=current.replace(after,before);}
 assert.equal(current,proof.originalSources[inverse.source].bytes);assert.equal(sha(current),originals[inverse.source]);
});
test('all original exported type aliases remain exact in the thin typed adapters',()=>{
 const proof=JSON.parse(read('docs/qualification/employee-native-log-codec-inverse-20261108.json'));
 for(const file of ['test/performance/employee-choice-auto-explain-parser.ts','test/performance/employee-choice-native-log-stream.ts','test/performance/employee-choice-native-log-parts.ts']){
  const types=value=>value.split('\n').filter(line=>line.startsWith('export type ')).sort();assert.deepEqual(types(read(file)),types(proof.originalSources[file].bytes));
 }
});
