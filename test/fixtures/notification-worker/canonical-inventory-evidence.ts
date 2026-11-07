/** Diagnostic byte ownership. No path from a database row is ever opened. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {constants,openSync,fstatSync,readFileSync,writeFileSync,fsyncSync,closeSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {nativePreparationEnvironment} from '../../../.github/ci/candidate-environment.mjs';
import {nativeInventoryCanonical,nativeInventoryLimits} from './canonical-inventory';
export const inventoryHash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export function inventoryRegularBytes(path:string,maximum:number,privateFile=false){
 assert.equal(resolve(path),realpathSync(path));
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=maximum,'Bounded regular inventory evidence required');
  if(privateFile){assert.equal(before.uid,process.getuid!());assert.equal(before.mode&0o077,0);}
  const bytes=readFileSync(fd),after=fstatSync(fd),pathStat=lstatSync(path);
  assert.equal(bytes.length,before.size);for(const field of ['dev','ino','size','mtimeMs','ctimeMs'] as const){assert.equal(after[field],before[field]);assert.equal(pathStat[field],before[field]);}
  assert(!pathStat.isSymbolicLink());return bytes;
 }finally{closeSync(fd);}
}
const journalSchema=z.object({version:z.literal('7'),dialect:z.literal('postgresql'),entries:z.array(z.object({idx:z.number().int().safe().nonnegative(),version:z.literal('7'),when:z.number().int().safe().positive(),tag:z.string().regex(/^[0-9]{4}_[a-z0-9_]+$/),breakpoints:z.boolean()}).strict()).min(1).max(10000)}).strict();
const ledgerSchema=z.array(z.object({id:z.number().int().safe().positive(),hash:z.string().regex(/^[a-f0-9]{64}$/),created_at:z.string().regex(/^[1-9][0-9]*$/)}).strict());
/** Fresh CI ledger only: historical installation hash normalization is forbidden.
 * Sparse idx and nonmonotonic timestamps are legal; native application order is not sorted away. */
export function assertInventoryLedger(source:{migrations:readonly {sha256:string;when:number}[]},input:unknown){
 const ledger=ledgerSchema.parse(input);assert.equal(ledger.length,source.migrations.length,'Complete applied/source membership differs');
 let last=0;for(let index=0;index<ledger.length;index++){
  const actual=ledger[index],expected=source.migrations[index];assert(actual.id>last,'Native ledger order differs');last=actual.id;
  assert.equal(actual.hash,expected.sha256,'Native/source SQL bytes differ');assert.equal(actual.created_at,String(expected.when),'Native/source migration timestamp differs');
 }
 return ledger;
}
/** One exact Git tree listing; descriptor-read bytes must match each immutable Git blob. */
export function inventorySource(){
 const cwd=realpathSync(process.cwd()),git=(...args:string[])=>execFileSync('git',['-c','safe.directory='+cwd,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd,env:nativePreparationEnvironment(process.env),maxBuffer:16*1024*1024});
 const source=git('rev-parse','HEAD').toString('utf8').trim();assert.equal(source,process.env.AIHR_CI_HEAD);assert.equal(git('status','--porcelain').toString('utf8'),'');
 const records=new Map<string,{mode:string;blob:string}>();
 for(const entry of git('ls-tree','-r','-z','HEAD','--','db/migrations','test/helpers/personnel-draft-discard-ci-role-fixture.ts','scripts/migrate-with-focused-prerequisites.ts','scripts/lib/discard-premigration.ts').toString('utf8').split('\0').filter(Boolean)){
  const match=/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(entry);assert(match,'Only committed regular source blobs admitted');assert(!records.has(match[3]));records.set(match[3],{mode:match[1],blob:match[2]});
 }
 const read=(path:string)=>{
  assert(!path.split('/').some(part=>part==='..'||part==='.'||!part));const record=records.get(path);assert(record,'Missing committed source blob');
  const bytes=inventoryRegularBytes(join(cwd,path),4*1024*1024),blob=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');assert.equal(blob,record.blob,'Source bytes differ from immutable Git tree');
  const text=bytes.toString('utf8');assert(Buffer.from(text).equals(bytes),'Lossless UTF8 source required');return{path,...record,sha256:inventoryHash(bytes),bytes:bytes.length,text};
 };
 const journal=read('db/migrations/meta/_journal.json'),parsed=journalSchema.parse(JSON.parse(journal.text));
 assert.equal(new Set(parsed.entries.map(row=>row.tag)).size,parsed.entries.length);assert.equal(new Set(parsed.entries.map(row=>row.idx)).size,parsed.entries.length);
 const migrations=parsed.entries.map((entry,position)=>({...entry,position,...read('db/migrations/'+entry.tag+'.sql')}));
 const prerequisites={helper:read('test/helpers/personnel-draft-discard-ci-role-fixture.ts'),wrapper:read('scripts/migrate-with-focused-prerequisites.ts'),orchestration:read('scripts/lib/discard-premigration.ts')};
 const journalPaths=new Set(migrations.map(row=>row.path));
 const unlistedSql=[...records.keys()].filter(path=>/^db\/migrations\/[^/]+\.sql$/.test(path)&&!journalPaths.has(path)).sort().map(read);
 const result={source,journal,migrations,unlistedSql,unlistedSqlDisposition:'SOURCE_ONLY_NOT_IN_JOURNAL_NOT_CLAIMED_APPLIED',prerequisites};assert(Buffer.byteLength(nativeInventoryCanonical(result))<=nativeInventoryLimits.fileBytes,'Complete source inventory byte bound exceeded');return result;
}
/** Each member is exclusive, private, fully fsynced and never silently truncated.
 * Incomplete reports cannot be confused with a profile or a completed snapshot. */
export function writeInventoryEvidence(directory:string,name:string,value:unknown){
 assert(/^notification-canonical-(?:raw|normalized|source|report|incomplete)\.json$/.test(name));
 assert.equal(realpathSync(directory),directory);const parent=lstatSync(directory);assert(parent.isDirectory()&&!parent.isSymbolicLink());assert.equal(parent.uid,process.getuid!());
 const bytes=Buffer.from(nativeInventoryCanonical(value)+'\n');assert(bytes.length<=nativeInventoryLimits.fileBytes,'Complete inventory member exceeds16MiB; refused without truncation');
 const path=join(directory,name),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 const retained=inventoryRegularBytes(path,nativeInventoryLimits.fileBytes,true);assert(retained.equals(bytes),'Retained inventory bytes differ');return{file:name,bytes:bytes.length,sha256:inventoryHash(bytes)};
}
