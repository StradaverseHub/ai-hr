/** Exact applied-version provenance controls; no database, migration execution or ledger edits. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {HISTORICAL_MIGRATIONS,appliedMigrationIdentity} from './migration-history.mjs';
import {validateMigrationLedgerRows} from './staging-migration-ledger.mjs';
const current=r=>readFileSync(new URL('../../db/migrations/'+r.tag+'.sql',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
test('two archived original SQL versions have immutable hashes and bind exact approved current bytes',()=>{
 assert.equal(HISTORICAL_MIGRATIONS.length,2);assert(Object.isFrozen(HISTORICAL_MIGRATIONS));
 for(const r of HISTORICAL_MIGRATIONS){
  assert(Object.isFrozen(r));const original=readFileSync(new URL('./historical-migrations/'+r.tag+'.sql',import.meta.url));
  assert.equal(hash(original),r.appliedSha256);assert.equal(hash(current(r)),r.currentSha256);assert.notEqual(r.appliedSha256,r.currentSha256);
  const result=appliedMigrationIdentity(r.tag,r.when,current(r));assert.equal(result.hash,r.appliedSha256);assert.equal(result.sourceSha256,r.currentSha256);assert.equal(result.historicalAppliedVersion.originalCommit,r.originalCommit);
 }
});
test('ordinary migrations retain complete current-byte hashing and never consult historical archives',()=>{
 const bytes=Buffer.from('-- ordinary\nselect 1;\n');assert.deepEqual(appliedMigrationIdentity('9999_new',1,bytes,{readArchive:()=>{throw Error('unexpected archive');}}),{hash:hash(bytes)});
});
test('unknown source bytes or changed timestamp cannot inherit a historical identity',()=>{
 for(const r of HISTORICAL_MIGRATIONS){
  assert.throws(()=>appliedMigrationIdentity(r.tag,r.when+1,current(r)));
  assert.throws(()=>appliedMigrationIdentity(r.tag,r.when,Buffer.concat([current(r),Buffer.from(' ')])));
  assert.throws(()=>appliedMigrationIdentity(r.tag,r.when,Buffer.from('select 1;')));
 }
});
test('altered, absent, oversized or substituted historical SQL refuses rather than waiving a checksum',()=>{
 const r=HISTORICAL_MIGRATIONS[0];for(const bytes of [Buffer.from('wrong'),Buffer.alloc(0),Buffer.alloc(32769),current(r)])assert.throws(()=>appliedMigrationIdentity(r.tag,r.when,current(r),{readArchive:()=>bytes}));
 assert.throws(()=>appliedMigrationIdentity(r.tag,r.when,current(r),{readArchive:()=>{throw Error('missing');}}));
});
test('real observed historical hashes pass; replacing them with current-file hashes still refuses',()=>{
 const expected=HISTORICAL_MIGRATIONS.map(r=>({tag:r.tag,created_at:String(r.when),...appliedMigrationIdentity(r.tag,r.when,current(r))}));
 const actual=[{id:'217',created_at:'1781862179000',hash:'ae128e75c9491bd1d39537fdddd18ad9307b2050f813b8a056d473dcfda9d41f'},{id:'249',created_at:'1781862211000',hash:'aa9337028da35cd3816d8d66486455595e36aea709c98405868ca36320c99f41'}];
 assert.equal(validateMigrationLedgerRows(expected,actual).rows,2);
 for(let i=0;i<2;i++){const wrong=structuredClone(actual);wrong[i].hash=HISTORICAL_MIGRATIONS[i].currentSha256;assert.throws(()=>validateMigrationLedgerRows(expected,wrong));}
 for(const mutate of [a=>a.pop(),a=>a.reverse(),a=>a[0].created_at='1',a=>a[0].hash='a'.repeat(64),a=>a.push({...a[0],id:'999'})]){const wrong=structuredClone(actual);mutate(wrong);assert.throws(()=>validateMigrationLedgerRows(expected,wrong));}
});
