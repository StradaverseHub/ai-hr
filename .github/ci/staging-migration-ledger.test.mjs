/** Exact ledger pure fixtures; no PostgreSQL process/connection is started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expectedMigrationLedger,validateMigrationLedgerRows,LEDGER_QUERY} from './staging-migration-ledger.mjs';
const wanted=[{tag:'001_a',created_at:'2000',hash:'a'.repeat(64)},{tag:'003_b',created_at:'1000',hash:'b'.repeat(64)}];
const rows=()=>wanted.map((r,i)=>({id:String(i*3+1),hash:r.hash,created_at:r.created_at}));
test('full exact ledger follows journal array order including historical lower timestamps and ID gaps',()=>{
 const r=validateMigrationLedgerRows(wanted,rows());assert.equal(r.rows,2);assert.equal(r.releaseAuthorized,false);assert.match(r.actualSha256,/^[a-f0-9]{64}$/);
});
test('counts alone cannot accept changed SQL, timestamp, reorder, duplicates, foreign rows or unrun migrations',()=>{
 for(const mutate of [a=>a.pop(),a=>a.push({...a[0],id:'9'}),a=>a[0].hash='f'.repeat(64),a=>a[0].created_at='1999',a=>a.reverse(),a=>a[1]={...a[0]},a=>a[1].id='0',a=>a[1].id=4,a=>a[0].extra=true]){
  const a=rows();mutate(a);assert.throws(()=>validateMigrationLedgerRows(wanted,a));
 }
});
test('expected hashes use complete SQL bytes without sorting or inventing sequential journal indices',t=>{
 const source=mkdtempSync(join(tmpdir(),'ledger-fixture-'));t.after(()=>rmSync(source,{recursive:true,force:true}));
 mkdirSync(join(source,'db/migrations/meta'),{recursive:true});const entries=wanted.map((r,i)=>({tag:r.tag,when:Number(r.created_at),idx:i===0?8:3}));
 const journal=join(source,'db/migrations/meta/_journal.json');writeFileSync(journal,JSON.stringify({entries}));
 for(const r of wanted)writeFileSync(join(source,'db/migrations',r.tag+'.sql'),'-- '+r.tag+'\nselect 1;\n');
 const actual=expectedMigrationLedger(source);assert.deepEqual(actual.map(x=>x.tag),wanted.map(x=>x.tag));assert.equal(actual[0].created_at,'2000');
 writeFileSync(join(source,'db/migrations/001_a.sql'),'-- changed SQL\nselect 1;\n');assert.notEqual(expectedMigrationLedger(source)[0].hash,actual[0].hash);
 entries[1].tag=entries[0].tag;writeFileSync(journal,JSON.stringify({entries}));assert.throws(()=>expectedMigrationLedger(source));
 entries[1].tag='../escape';writeFileSync(journal,JSON.stringify({entries}));assert.throws(()=>expectedMigrationLedger(source));
});
test('migration symlinks refuse rather than reading another path',t=>{
 const source=mkdtempSync(join(tmpdir(),'ledger-link-'));t.after(()=>rmSync(source,{recursive:true,force:true}));mkdirSync(join(source,'db/migrations/meta'),{recursive:true});
 const journal=join(source,'db/migrations/meta/_journal.json');writeFileSync(journal,JSON.stringify({entries:[{tag:'001_a',when:1}]}));
 symlinkSync(journal,join(source,'db/migrations/001_a.sql'));assert.throws(()=>expectedMigrationLedger(source));
});
test('query has an explicit read-only repeatable snapshot and reads only the ordered Drizzle ledger',()=>{
 assert.match(LEDGER_QUERY,/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/);assert.match(LEDGER_QUERY,/ORDER BY id/);
 assert.equal((LEDGER_QUERY.match(/FROM /g)||[]).length,1);assert.match(LEDGER_QUERY,/FROM drizzle\.__drizzle_migrations/);assert.doesNotMatch(LEDGER_QUERY,/\b(INSERT|UPDATE|DELETE|ALTER|TRUNCATE|CREATE|DROP)\b/i);
});
