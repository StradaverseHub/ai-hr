/** Exact historical applied bytes, not a checksum waiver or permission to replay SQL. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const HISTORICAL_MIGRATIONS=Object.freeze([
 Object.freeze({tag:'0180_profile_option',when:1781862179000,
  appliedSha256:'ae128e75c9491bd1d39537fdddd18ad9307b2050f813b8a056d473dcfda9d41f',
  currentSha256:'2e4c8e82998f00ffdc4e06913ef25c37216f4c86a9ce0a5216bf0abb2bd30898',
  originalCommit:'b33432256168fc67955e5f183bb84c1a444b63ed'}),
 Object.freeze({tag:'0212_dashboard_card_config',when:1781862211000,
  appliedSha256:'aa9337028da35cd3816d8d66486455595e36aea709c98405868ca36320c99f41',
  currentSha256:'f02ea6e29fa45da548a6d2fd524f0822299d7ebb748ad3db742dcf308de6bf56',
  originalCommit:'b8bb0740d3fa5ef1cf60400eb484fa40399e921c'}),
]);
const known=new Map(HISTORICAL_MIGRATIONS.map(r=>[r.tag,r]));
const archive=record=>{
 const path=new URL('./historical-migrations/'+record.tag+'.sql',import.meta.url),s=lstatSync(path);
 assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size>0&&s.size<=32768,'Historical SQL must be a bounded original regular file');return readFileSync(path);
};
/** Specific to the retained staging history: a fresh installation is a different ledger baseline. */
export function appliedMigrationIdentity(tag,when,sourceBytes,{readArchive=archive}={}){
 assert(Buffer.isBuffer(sourceBytes)&&sourceBytes.length>0,'Complete current SQL bytes required');
 const sourceSha256=hash(sourceBytes),record=known.get(tag);if(!record)return {hash:sourceSha256};
 assert(when===record.when&&sourceSha256===record.currentSha256,'Historical migration source/timestamp differs from audited version');
 const original=readArchive(record);assert(Buffer.isBuffer(original)&&original.length>0&&original.length<=32768&&hash(original)===record.appliedSha256,'Original applied SQL bytes differ');
 return {hash:record.appliedSha256,sourceSha256,historicalAppliedVersion:{originalCommit:record.originalCommit,originalSqlSha256:record.appliedSha256}};
}
