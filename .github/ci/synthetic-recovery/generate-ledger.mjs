import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [directory, verifier]=process.argv.slice(2);
assert(isAbsolute(directory)&&isAbsolute(verifier),'Use absolute paths for a new fixture directory and frozen ledger verifier');
mkdirSync(directory,{mode:0o700});
const migrations=join(directory,'db/migrations');
mkdirSync(join(migrations,'meta'),{recursive:true});
const entries=Array.from({length:656},(_,idx)=>({
 idx,tag:'fixture_'+String(idx).padStart(4,'0'),when:1700000000000+idx,
}));
for(const {idx,tag} of entries) writeFileSync(join(migrations,tag+'.sql'),`SELECT ${idx};\n`);
writeFileSync(join(migrations,'meta/_journal.json'),JSON.stringify({entries}));
const {expectedMigrationLedger,validateMigrationLedgerRows}=await import(pathToFileURL(verifier));
const expected=expectedMigrationLedger(directory);
const rows=expected.map(({hash,created_at},idx)=>({id:String(idx+1),hash,created_at}));
const receipt=validateMigrationLedgerRows(expected,rows);
assert.throws(()=>validateMigrationLedgerRows(expected,rows.toReversed()),/ordered|differs/);
assert.throws(()=>validateMigrationLedgerRows(expected,rows.slice(1)),/count/);
const sql=[
 'BEGIN;',
 'CREATE SCHEMA drizzle;',
 'CREATE TABLE drizzle.__drizzle_migrations (id bigint PRIMARY KEY, hash text NOT NULL, created_at bigint NOT NULL);',
 ...rows.map(({id,hash,created_at})=>{
  assert.match(hash,/^[a-f0-9]{64}$/);
  return `INSERT INTO drizzle.__drizzle_migrations VALUES (${id}, '${hash}', ${created_at});`;
 }),
 'COMMIT;',
].join('\n')+'\n';
writeFileSync(join(directory,'seed-ledger.sql'),sql,{flag:'wx',mode:0o600});
console.log(JSON.stringify(receipt));
