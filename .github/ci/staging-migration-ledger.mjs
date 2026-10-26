/** Read-only exact candidate/Drizzle ledger comparison. No migration or application database import. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {appliedMigrationIdentity} from './migration-history.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
const regular=path=>{const st=lstatSync(path);assert(st.isFile()&&!st.isSymbolicLink()&&st.size>0&&st.size<=16*1024**2,'Bounded regular migration source required');return readFileSync(path);};
export function expectedMigrationLedger(source){
 const journal=JSON.parse(regular(join(source,'db/migrations/meta/_journal.json')));
 assert(Array.isArray(journal.entries)&&journal.entries.length>0&&journal.entries.length<=10000,'Complete bounded migration journal required');
 const seen=new Set();
 return journal.entries.map(row=>{
  // Historical journal idx/when values need not be monotonic. Preserve its actual array order.
  assert(typeof row.tag==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(row.tag)&&!seen.has(row.tag)&&Number.isSafeInteger(row.when)&&row.when>0,'Unique safe migration tag and exact timestamp required');seen.add(row.tag);
  return {tag:row.tag,created_at:String(row.when),...appliedMigrationIdentity(row.tag,row.when,regular(join(source,'db/migrations',row.tag+'.sql')))};
 });
}
/** Bound the actual baseline prefix before downloads, pending markers or source changes. */
export function expectedBaselineMigrationLedger(source,baseline){
 assert(/^[a-f0-9]{40}$/.test(baseline??''),'Exact baseline commit required');
 const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8',maxBuffer:4*1024**2,timeout:10000});
 const before=JSON.parse(git('show',baseline+':db/migrations/meta/_journal.json')).entries;
 const current=JSON.parse(regular(join(source,'db/migrations/meta/_journal.json'))).entries;
 assert(Array.isArray(before)&&before.length>0&&before.length<=current.length&&isDeepStrictEqual(before,current.slice(0,before.length)),'Applied baseline journal is not an unchanged prefix');
 const changed=new Set(git('diff','--name-only',baseline,'--','db/migrations').trim().split('\n'));
 for(const row of before)assert(!changed.has('db/migrations/'+row.tag+'.sql'),'Applied baseline SQL changed');
 return expectedMigrationLedger(source).slice(0,before.length);
}
export const stagingLedgerProbeCommand=()=>[
 'set -eu','cd /opt/ai-hr','set -a','. ./.env.production','set +a',
 'test -n "${MIGRATION_DATABASE_URL:-}"',
 'PGCONNECT_TIMEOUT=5 PGOPTIONS='+"'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000'"+' psql --dbname="$MIGRATION_DATABASE_URL" -X -q -A -t --no-password -v ON_ERROR_STOP=1',
].join('\n');
export function validateMigrationLedgerRows(expected,rows){
 assert(Array.isArray(expected)&&expected.length>0&&Array.isArray(rows)&&rows.length===expected.length,'Full migration ledger count differs');
 let prior=0n;
 for(let i=0;i<expected.length;i++){
  const actual=rows[i],wanted=expected[i];
  assert(actual&&Object.keys(actual).sort().join(',')==='created_at,hash,id'&&typeof actual.id==='string'&&/^[1-9][0-9]*$/.test(actual.id)&&BigInt(actual.id)>prior,'Actual ledger IDs must be positive and ordered');
  assert(typeof actual.created_at==='string'&&actual.created_at===wanted.created_at&&actual.hash===wanted.hash,'Applied migration order/content/timestamp differs at index '+i);prior=BigInt(actual.id);
 }
 return {format:1,kind:'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE',rows:rows.length,expectedSha256:installHash(installJson(expected)),actualSha256:installHash(installJson(rows)),releaseAuthorized:false};
}
export const LEDGER_QUERY='BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'+
 "SELECT coalesce(json_agg(json_build_object('id',id::text,'hash',hash,'created_at',created_at::text) ORDER BY id),'[]'::json) FROM drizzle.__drizzle_migrations;\nCOMMIT;\n";
export function verifyBaselineMigrationPreflight({candidatePath,baseline,ssh}){
 const expected=expectedBaselineMigrationLedger(candidatePath,baseline);
 const actual=JSON.parse(ssh(stagingLedgerProbeCommand(),{input:LEDGER_QUERY,timeout:20000,maxBuffer:4*1024**2}));
 return validateMigrationLedgerRows(expected,actual);
}
export function collectMigrationLedger(source='/opt/ai-hr'){
 assert(process.platform==='linux'&&source==='/opt/ai-hr'&&realpathSync(source)===source,'Only the canonical Linux staging source may query its ledger');
 assert(typeof process.env.MIGRATION_DATABASE_URL==='string'&&/^postgres(?:ql)?:\/\//.test(process.env.MIGRATION_DATABASE_URL),'Private migration connection required');
 const expected=expectedMigrationLedger(source);
 let bytes;
 try{
  bytes=execFileSync('psql',['--dbname',process.env.MIGRATION_DATABASE_URL,'-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1'],{encoding:'utf8',timeout:20000,maxBuffer:4*1024**2,
   input:LEDGER_QUERY,env:{...process.env,PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000'}});
 }catch{throw Error('Bounded read-only staging migration-ledger query failed');}
 const result=validateMigrationLedgerRows(expected,JSON.parse(bytes));
 // Refuse a source rewrite while the snapshot was being read.
 assert(installJson(expectedMigrationLedger(source))===installJson(expected),'Migration source changed during ledger verification');
 return {...result,verifiedAt:new Date().toISOString()};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{assert(process.argv.length===2,'Ledger CLI takes no selected database/path');console.log(JSON.stringify(collectMigrationLedger()));}catch(error){console.error(error);process.exitCode=1;}
}
