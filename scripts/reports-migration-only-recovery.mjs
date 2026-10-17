/** One reviewed migration-only Reports recovery. No migration, reset, seed or business writer here. */
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {REPORT_FIXTURE_METADATA_FILES} from './employee-master-fixture-proof.mts';
import {readReportFixtureConnections,assertReportFixtureConnections} from './report-fixture-connection.mjs';
export const REPORTS_RECOVERY_NAME='reports-migration-only-recovery-b4f-v1.json';
export const REPORTS_MIGRATION_ATTEMPT=Object.freeze({
 candidate:'b4f87438c120ef2a0940a465479c1ffc1e65839a',database:'ai_hr_board18_reports_browser',databaseOid:'218928',
 namespace:'board18reports',port:3197,
 files:Object.freeze([
  {fileName:'preparation-attempt.json',bytes:348,sha256:'95ac3e18a6f148e35a3c82bc853cba312212d09d9f5d645a822f57e8860d48d8'},
  {fileName:'b4f87438c120ef2a0940a465479c1ffc1e65839a-1792237166598-browser-migrate.log',bytes:48655,sha256:'e4139abf07eeab22faadc53f4bb0c2358d55d5218b980f6a81128d8cbcd547b2'},
  {fileName:'b4f87438c120ef2a0940a465479c1ffc1e65839a-1792237166598-browser-fixture-first.log',bytes:133,sha256:'fc4fc568647a73035bf698c6a3b916fe2292853022122d9aed806d0292e57204'},
  {fileName:'b4f87438c120ef2a0940a465479c1ffc1e65839a-1792237166598-drizzle.config.ts',bytes:480,sha256:'2752332986f74725faebab4f4141809aa2168cdb9131af169a310bfb187f75ab'},
 ]),
});
const FIXED_BLOBS=Object.freeze({
 'scripts/dev-fixture-employee-master.mts':'d8c35254007bd2e920efd2f502eb9b29e89b493c',
 'scripts/employee-master-fixture-proof.mts':'67e79804f4b23b3434ed262bbf57a1c3bf8a61d1',
 'scripts/report-fixture-connection.mjs':'1bcb9282972118f23857dbc3bc766087f2cca34d',
 'scripts/dev-browser-original18.mjs':'fc0ca9df13419d2b0d8932c3e96db0cf8c2325da',
 'scripts/original18-browser-target.mjs':'053c63485e11eadac441bdb9bca25796c7807ecd',
});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw new Error('Unproven migration-only Reports recovery; preserve the original attempt.');};
const inventoryBytes=readFileSync(new URL('./reports-migration-only-inventory.json',import.meta.url));
if(inventoryBytes.length!==40797||hash(inventoryBytes)!=='6266e1547f3de452a3001251c0f89625fd0b654e53bae70c138c41496fdf62f8')fail();
const expectedInventory=JSON.parse(inventoryBytes.toString());
export function validateReportsRecoveryFiles(files){if(!same(files,REPORTS_MIGRATION_ATTEMPT.files))fail();}
export function validateReportsRecoveryNames(names){
 if(!Array.isArray(names)||names.length>1000||names.some(name=>typeof name!=='string'||['fixture-manifest.json','browser-manifest.json','browser.pid','browser-stopped.json',REPORTS_RECOVERY_NAME].includes(name)||name.startsWith('browser-resume-')||name.includes('-browser-fixture-second.log')||/-browser-(migrate|fixture-first)\.log$/.test(name)&&!REPORTS_MIGRATION_ATTEMPT.files.some(file=>file.fileName===name)))fail();
}
export function validateReportsMigrationSnapshot(snapshot,journal){
 assertReportFixtureConnections(snapshot.connections,{database:REPORTS_MIGRATION_ATTEMPT.database,ownerName:'postgres'});
 if(snapshot.connections.application.database_oid!==REPORTS_MIGRATION_ATTEMPT.databaseOid||snapshot.readOnly!=='on'||snapshot.isolation!=='repeatable read'||!same(snapshot.tenants,[{id:'00000000-0000-0000-0000-000000000000',name:'System (auth audit)',workosOrgId:'org_system_auth_audit'}])||!same(snapshot.inventory,expectedInventory)||journal.length!==460||snapshot.applied.length!==journal.length)fail();
 // Historical journal order is authoritative even where adjacent timestamps decrease.
 for(let i=0;i<journal.length;i++)if(!Number.isSafeInteger(journal[i].when)||String(snapshot.applied[i].created_at)!==String(journal[i].when)||snapshot.applied[i].hash!==journal[i].sha256)fail();
}
async function ownedFile(file,max=1000000){
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size<1||stat.size>max||await fs.realpath(file)!==file)fail();
 const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail();return bytes;
}
function git(root,args){return execFileSync('git',['-C',root,...args],{cwd:root,maxBuffer:16000000});}
export async function readReportsRecoverySourceProof(root,candidate){
 if(!/^[0-9a-f]{40}$/.test(candidate)||git(root,['rev-parse','HEAD']).toString().trim()!==candidate||git(root,['status','--porcelain']).length||git(root,['rev-parse',REPORTS_MIGRATION_ATTEMPT.candidate+'^{commit}']).toString().trim()!==REPORTS_MIGRATION_ATTEMPT.candidate||git(root,['diff','--name-only',REPORTS_MIGRATION_ATTEMPT.candidate,candidate,'--','db/migrations','db/schema.ts','packs/catalog.ts']).length)fail();
 const result=[];
 for(const relative of new Set([...REPORT_FIXTURE_METADATA_FILES,...Object.keys(FIXED_BLOBS)])){
  const current=git(root,['show',candidate+':'+relative]),currentBlob=git(root,['rev-parse',candidate+':'+relative]).toString().trim();
  let old;
  if(relative!=='scripts/report-fixture-connection.mjs')old=git(root,['show',REPORTS_MIGRATION_ATTEMPT.candidate+':'+relative]);
  if(FIXED_BLOBS[relative]?currentBlob!==FIXED_BLOBS[relative]:!old?.equals(current))fail();
  result.push({path:relative,oldSha256:old?hash(old):null,sha256:hash(current),blob:currentBlob});
 }
 return result;
}
export async function prepareReportsMigrationOnlyRecovery({root,candidate,out,owner,app}){
 if(!path.isAbsolute(root)||path.resolve(root)!==root||await fs.realpath(root)!==root||out!==path.join(root,'scratchpad/board18-reports'))fail();
 const directory=await fs.lstat(out);if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid()||(directory.mode&0o077))fail();
 validateReportsRecoveryNames(await fs.readdir(out));
 const files=[];let attempt;
 for(const expected of REPORTS_MIGRATION_ATTEMPT.files){const bytes=await ownedFile(path.join(out,expected.fileName));files.push({fileName:expected.fileName,bytes:bytes.length,sha256:hash(bytes)});if(expected.fileName==='preparation-attempt.json')attempt=JSON.parse(bytes.toString());}
 validateReportsRecoveryFiles(files);
 if(attempt.root!==root||attempt.scenario!=='reports'||attempt.database!==REPORTS_MIGRATION_ATTEMPT.database||attempt.namespace!==REPORTS_MIGRATION_ATTEMPT.namespace||attempt.port!==3197||attempt.candidate!==REPORTS_MIGRATION_ATTEMPT.candidate)fail();
 const sources=await readReportsRecoverySourceProof(root,candidate);
 const entries=JSON.parse(await fs.readFile(path.join(root,'db/migrations/meta/_journal.json'),'utf8')).entries;
 const journal=[];for(const entry of entries){if(!/^[a-zA-Z0-9_-]+$/.test(entry.tag))fail();journal.push({tag:entry.tag,when:entry.when,sha256:hash(await fs.readFile(path.join(root,'db/migrations',entry.tag+'.sql')))});}
 const connections=await readReportFixtureConnections(app,owner);
 const snapshot=await owner.begin('isolation level repeatable read read only',async tx=>{
  await tx`select set_config('statement_timeout','10000',true)`;
  const [transaction]=await tx`select current_setting('transaction_read_only') as read_only,current_setting('transaction_isolation') as isolation`;
  const applied=await tx`select hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
  const tenants=await tx`select id::text,name,workos_org_id as "workosOrgId" from public.tenant order by id`;
  const names=await tx`select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by c.relname`;
  if(!same(names.map(row=>row.name),expectedInventory.map(row=>row.name)))fail();
  const inventory=[];
  for(const expected of expectedInventory){
   if(!/^[a-z_][a-z0-9_]{0,62}$/.test(expected.name))fail();
   const [count]=await tx.unsafe(`select count(*) as rows from public."${expected.name}"`);
   if(Number(count.rows)!==expected.rows)fail();
   const [row]=await tx.unsafe(`select count(*) as rows,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'null'),'UTF8')),'hex') as digest from public."${expected.name}" t`);
   inventory.push({name:expected.name,rows:Number(row.rows),digest:row.digest});
  }
  return {connections,readOnly:transaction.read_only,isolation:transaction.isolation,applied,tenants,inventory};
 });
 validateReportsMigrationSnapshot(snapshot,journal);
 const value={format:1,kind:'reviewed-reports-migration-only-recovery',root,candidate,scenario:'reports',database:REPORTS_MIGRATION_ATTEMPT.database,namespace:REPORTS_MIGRATION_ATTEMPT.namespace,port:3197,originalAttemptCandidate:attempt.candidate,originalFiles:files,sourceProof:sources,journal,baselineInventorySha256:hash(inventoryBytes),snapshot,plannedMigrationRuns:0,plannedSeedRuns:0,plannedFixtureRuns:2,fixtureOutcome:'UNRUN',applicationAcceptance:'UNVERIFIED'};
 const reference={fileName:REPORTS_RECOVERY_NAME,sha256:hash(JSON.stringify(value,null,2)+'\n')};
 return {name:REPORTS_RECOVERY_NAME,value,reference};
}
