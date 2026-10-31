/** Execution choice ONLY for the explicitly authorized fresh disposable installed581 rehearsal.
 * Existing migration-history remains the authority; never updates a ledger hash or live database. */
import assert from 'node:assert/strict';
import {lstatSync,readFileSync} from 'node:fs';
import {appliedMigrationIdentity} from './migration-history.mjs';
export function appliedMigrationExecution(tag,when,currentSql){
 // Authenticates exact current tag/timestamp/hash and the original bounded archive, when known.
 const identity=appliedMigrationIdentity(tag,when,currentSql);
 if(!identity.historicalAppliedVersion)return Object.freeze({identity,sql:Buffer.from(currentSql)});
 const file=new URL('./historical-migrations/'+tag+'.sql',import.meta.url),stat=lstatSync(file);
 assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size>0&&stat.size<=32768,'Historical execution SQL must be bounded original regular bytes');
 const sql=readFileSync(file);
 // Bind the exact buffer we will EXECUTE, not a previous read susceptible to replacement. The
 // existing owner verifies its fixed appliedSha256; there is no caller hash or source substitution.
 const exact=appliedMigrationIdentity(tag,when,currentSql,{readArchive:()=>sql});
 assert.deepEqual(exact,identity,'Historical archive changed between authentication and capture');
 return Object.freeze({identity:exact,sql:Buffer.from(sql)});
}
