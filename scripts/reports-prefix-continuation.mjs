/** Continue only the independently captured Reports prefix; never provisions, repairs or resets rows. */
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {REPORTS_MIGRATION_ATTEMPT} from './reports-migration-only-recovery.mjs';
import {readReportFixtureConnections,assertReportFixtureConnections} from './report-fixture-connection.mjs';
export const REPORTS_PREFIX_ADMISSION='reports-prefix-continuation-c260-v1.json';
const FAILED_CANDIDATE='c260108d3ca8d9ad28954450a5162eeed1c7a1ed';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw new Error('Unproven Reports prefix continuation; preserve all existing rows and receipts.');};
function metadata(name,bytes,sha256){const value=readFileSync(new URL(name,import.meta.url));if(value.length!==bytes||hash(value)!==sha256)fail();return JSON.parse(value.toString());}
const inventory=metadata('./reports-prefix-inventory.json',40802,'c08070903492aaf32969d4bc44ffb5660441aa11cc732876f54ab41af5885b2c');
const bindings=metadata('./reports-prefix-bindings.json',2579,'d05c782022249896982de83b9be381ec9f11430f15e5b36f8837adb74ccf36c8');
export const REPORTS_PREFIX_ORIGINAL_FILES=Object.freeze([...REPORTS_MIGRATION_ATTEMPT.files,
 {fileName:'reports-migration-only-recovery-b4f-v1.json',bytes:199622,sha256:'416f1f8f09c7c447d3baeb151e2b4639097af503a63309d978f6a8a97a97aea2'},
 {fileName:FAILED_CANDIDATE+'-1792237920670-browser-fixture-first.log',bytes:81,sha256:'3fe4ab84ad43b62152db05265fdf681a59253050b8974ed08441e26f8edbce30'},
].map(row=>Object.freeze(row)));
const originalFiles=REPORTS_PREFIX_ORIGINAL_FILES;
export function validateReportsPrefixSnapshot(snapshot,journal){
 assertReportFixtureConnections(snapshot.connections,{database:REPORTS_MIGRATION_ATTEMPT.database,ownerName:'postgres'});
 if(snapshot.connections.application.database_oid!=='218928'||snapshot.readOnly!=='on'||snapshot.isolation!=='repeatable read'||snapshot.fullVisibility!==true||!same(snapshot.inventory,inventory)||journal.length!==460||snapshot.applied.length!==460)fail();
 for(let i=0;i<journal.length;i++)if(!Number.isSafeInteger(journal[i].when)||String(snapshot.applied[i].created_at)!==String(journal[i].when)||snapshot.applied[i].hash!==journal[i].sha256)fail();
}
export function validateReportsPrefixAdmission(value,{root,candidate,coordinatorPid}){
 if(value?.format!==1||value.kind!=='reviewed-reports-prefix-continuation'||value.root!==root||value.candidate!==candidate||value.coordinatorPid!==coordinatorPid||!Number.isSafeInteger(coordinatorPid)||coordinatorPid<=1||value.originalCandidate!==FAILED_CANDIDATE||value.database!==REPORTS_MIGRATION_ATTEMPT.database||value.databaseOid!=='218928'||value.namespace!=='board18reports'||value.port!==3197||value.inventorySha256!=='c08070903492aaf32969d4bc44ffb5660441aa11cc732876f54ab41af5885b2c'||value.bindingsSha256!=='d05c782022249896982de83b9be381ec9f11430f15e5b36f8837adb74ccf36c8'||!same(value.originalFiles,originalFiles)||value.migrationRuns!==0||value.seedRuns!==0||value.provisioningRuns!==0||value.companyCreationRuns!==0||value.fixtureOutcome!=='UNRUN'||value.applicationAcceptance!=='UNVERIFIED')fail();
}
async function ownedFile(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size<1||stat.size>1000000||await fs.realpath(file)!==file)fail();const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail();return bytes;}
function git(root,args){return execFileSync('git',['-C',root,...args],{cwd:root,maxBuffer:16000000});}
async function provePrefix({root,candidate,out,owner,app}){
 if(path.resolve(root)!==root||await fs.realpath(root)!==root||out!==path.join(root,'scratchpad/board18-reports')||!/^[0-9a-f]{40}$/.test(candidate)||git(root,['rev-parse','HEAD']).toString().trim()!==candidate||git(root,['status','--porcelain']).length||git(root,['diff','--name-only',FAILED_CANDIDATE,candidate,'--','db/migrations','db/schema.ts','packs/catalog.ts']).length)fail();
 for(const expected of originalFiles){const bytes=await ownedFile(path.join(out,expected.fileName));if(bytes.length!==expected.bytes||hash(bytes)!==expected.sha256)fail();}
 const connections=await readReportFixtureConnections(app,owner);
 const entries=JSON.parse(await fs.readFile(path.join(root,'db/migrations/meta/_journal.json'),'utf8')).entries,journal=[];
 for(const entry of entries){if(!/^[a-zA-Z0-9_-]+$/.test(entry.tag))fail();journal.push({when:entry.when,sha256:hash(await fs.readFile(path.join(root,'db/migrations',entry.tag+'.sql')))});}
 const snapshot=await owner.begin('isolation level repeatable read read only',async tx=>{
  await tx`select set_config('statement_timeout','10000',true)`;
  const [state]=await tx`select current_setting('transaction_read_only') as read_only,current_setting('transaction_isolation') as isolation,rolsuper or rolbypassrls as full_visibility from pg_roles where rolname=current_user`;
  const applied=await tx`select hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
  const names=await tx`select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by c.relname`;
  if(!same(names.map(row=>row.name),inventory.map(row=>row.name)))fail();
  const actual=[];
  for(const expected of inventory){
   if(!/^[a-z_][a-z0-9_]{0,62}$/.test(expected.name))fail();
   const [count]=await tx.unsafe(`select count(*) as rows from public."${expected.name}"`);if(Number(count.rows)!==expected.rows)fail();
   const [row]=await tx.unsafe(`select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'null'),'UTF8')),'hex') as digest from public."${expected.name}" t`);
   actual.push({name:expected.name,rows:Number(count.rows),digest:row.digest});
  }
  return {connections,readOnly:state.read_only,isolation:state.isolation,fullVisibility:state.full_visibility,applied,inventory:actual};
 });
 validateReportsPrefixSnapshot(snapshot,journal);return {journal,snapshot};
}
export function validateReportsPrefixNames(names){
 const known=new Set(originalFiles.map(row=>row.fileName));
 if(names.some(name=>['fixture-manifest.json','browser-manifest.json','browser.pid','browser-stopped.json',REPORTS_PREFIX_ADMISSION].includes(name)||name.startsWith('browser-resume-')||!known.has(name)&&(/-browser-(fixture|migrate)/.test(name)||name.endsWith('-drizzle.config.ts'))))fail();
}
export async function prepareReportsPrefixContinuation(input){
 validateReportsPrefixNames(await fs.readdir(input.out));
 const observed=await provePrefix(input);
 const value={format:1,kind:'reviewed-reports-prefix-continuation',root:input.root,candidate:input.candidate,coordinatorPid:input.coordinatorPid,originalCandidate:FAILED_CANDIDATE,database:REPORTS_MIGRATION_ATTEMPT.database,databaseOid:'218928',namespace:'board18reports',port:3197,inventorySha256:'c08070903492aaf32969d4bc44ffb5660441aa11cc732876f54ab41af5885b2c',bindingsSha256:'d05c782022249896982de83b9be381ec9f11430f15e5b36f8837adb74ccf36c8',originalFiles,...observed,migrationRuns:0,seedRuns:0,provisioningRuns:0,companyCreationRuns:0,fixtureOutcome:'UNRUN',applicationAcceptance:'UNVERIFIED'};
 validateReportsPrefixAdmission(value,input);return {name:REPORTS_PREFIX_ADMISSION,value,reference:{fileName:REPORTS_PREFIX_ADMISSION,sha256:hash(JSON.stringify(value,null,2)+'\n')}};
}
export async function readReportsFixturePrefix(input){
 const bytes=await ownedFile(path.join(input.out,REPORTS_PREFIX_ADMISSION)),value=JSON.parse(bytes.toString());
 validateReportsPrefixAdmission(value,input);
 const observed=await provePrefix(input);if(!same(observed.snapshot,value.snapshot)||!same(observed.journal,value.journal))fail();
 return {bindings:structuredClone(bindings),reference:{fileName:REPORTS_PREFIX_ADMISSION,sha256:hash(bytes)}};
}
