/** Genuine signatures made by the pinned pre-alias application, followed by ordinary current migration.
 * No signed rows, receipts, function replacements or owner guards are manufactured by this fixture. */
import {withoutApprovedPhoneDependency} from './helpers/approved-phone-dependency';
import {execFile,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,lstatSync,readdirSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import type {ContractSharedLetter} from '../core/contract-shared-signing';
import type {ContractSharedForm} from '../core/contract-shared-form';

type VisibleForm=Extract<ContractSharedForm,{visible:true}>;
type Ledger={hash:string;created_at:string};
type Baseline={version:1;source:string;tenantId:string;companyId:string;employmentId:string;employeePersonId:string;caseId:string;letterId:string;admin:{userId:string;personId:string};employee:{userId:string;personId:string};before:ContractSharedLetter;form:VisibleForm;rendered:string;ledger:Ledger[]};
// The original commit is unpublished provenance; only the reviewed public capsule is archived.
const SOURCE='175bdd3f31320711e84c49a16239220eb00233e0';
const CAPSULE='cf7a4a2952702683fd21de8fbdd2bd96c5c9e3c8';
const CAPSULE_PATH='.github/ci/fixtures/contract-form-pre6411-runtime';
const CAPSULE_TREE='53c9c512306a642de01a063b24cf89f04d9ef591';
const CAPSULE_MANIFEST='165dec96a678265239676a2a8551cd23ba780602844dc96a457d219111c8bd3e';
const SOURCE_VECTOR='5bb5329c43f657adc0c95b8434686731e8380107a1ec034a1021162751c3009e';
type CapsuleManifest={schemaVersion:number;kind:string;historicalProvenance:{commit:string;commitPublished:boolean;privateHistoryIncluded:boolean};evidenceParent:string;sourceFileCount:number;sourceBytes:number;sourceVector:{sha256:string};files:{path:string;gitMode:string;bytes:number;sha256:string;provenanceGitBlobSHA1:string}[]};
const DEPENDENCIES={'package.json':'e90075de8d53a96463a1a7310646d313cc4c076ae9fa39e6100f9cd664ee7e1e','pnpm-lock.yaml':'7c833cb438bd31a1e22045b1704ed1498a4922343828e2d302e3ef4a6cdfb99a','tsconfig.json':'f5bc3a05bc19d85f6d1b7735e34bdd6b93f8f15741316108cc55d67ff4173785'};
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const exec=promisify(execFile);

it('preserves a genuinely signed old known label and old unresolved private label after the alias upgrade',async()=>{
 expect(process.env.CI).toBe('true');
 const root=realpathSync(process.cwd()),tag='6411_contract_form_native_field_parity';
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{idx:number;version:string;when:number;tag:string;breakpoints:boolean}[]};
 expect(journal.entries.filter(entry=>entry.tag===tag)).toHaveLength(1);
 const boundary=journal.entries.findIndex(entry=>entry.tag===tag);expect(boundary).toBeGreaterThan(0);
 // Array position selects the prefix; allocated idx is a separate, noncontiguous identity.
 expect(journal.entries.slice(boundary-1,boundary+2)).toEqual([
  {idx:5810,version:'7',when:1794988006410,tag:'6410_contract_original_email_readiness_recheck',breakpoints:true},
  {idx:5811,version:'7',when:1794988006411,tag,breakpoints:true},
  {idx:5812,version:'7',when:1794988006412,tag:'6412_contract_setup_ending_email_readiness',breakpoints:true},
 ]);
 expect(sha(readFileSync('db/migrations/'+tag+'.sql'))).toBe('695077fddbcb4163712b8c49fb6d34eeddba1cb194394c5b43c220471b485d24');
 const keys=['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL','DATABASE_URL','MIGRATION_DATABASE_URL'] as const;
 const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const currentKeys=['DATABASE_POOLED_URL','AIHR_DB_PROCESS_ROLE','AIHR_DB_POOL_MAX','AIHR_DB_POOLER_SERVER_CONNECTIONS'] as const;
 const currentOriginal=Object.fromEntries(currentKeys.map(key=>[key,process.env[key]]));
 const urls=keys.map(key=>{
  expect(original[key],key+' must identify the disposable hosted cluster').toBeTruthy();const url=new URL(original[key]!);
  expect(url.protocol).toBe('postgres:');expect(url.hostname).toBe('127.0.0.1');expect(url.port).toBe('5433');
  expect(url.password).toBe('');expect(url.search).toBe('');expect(url.hash).toBe('');
  expect(/^\/ai_hr_test(?:_w(?:_aifocus)?[1-9][0-9]*|_tpl(?:_aifocus)?)?$/.test(url.pathname)).toBe(true);
  expect(url.username).toBe(key.includes('MIGRATION')?'postgres':'ai_hr_app');return url;
 });
 for(const url of urls){expect(url.hostname).toBe(urls[0].hostname);expect(url.pathname).toBe(urls[0].pathname);}
 const name='ai_hr_contract_alias_upgrade_'+randomUUID().replaceAll('-','');
 const at=(application:boolean)=>{const url=new URL(urls[application?0:1]);url.pathname='/'+name;return url.toString();};
 const ownerUrl=new URL(at(false));ownerUrl.pathname='/postgres';
 const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'contract-form-alias-upgrade-'))),source=join(directory,'source'),prefix=join(directory,'migrations');
 let created=false,storage:postgres.Sql|undefined,close:(()=>Promise<unknown>)|undefined;
 try{
  // The published evidence commit has only public-main ancestry. No network fallback, private
  // history lookup or current-source overlay is permitted inside this test.
  const revision=(ref:string)=>execFileSync('git',['rev-parse',ref],{cwd:root,encoding:'utf8'}).trim();
  expect(revision(CAPSULE+'^{commit}')).toBe(CAPSULE);
  expect(revision(CAPSULE+'^')).toBe('fca9a75fc28260f725e0f067d8d6879e2a70bb04');
  expect(revision(CAPSULE+':'+CAPSULE_PATH)).toBe(CAPSULE_TREE);
  mkdirSync(source);const archive=join(directory,'historical.tar');
  execFileSync('git',['archive','--format=tar','--output='+archive,CAPSULE+':'+CAPSULE_PATH],{cwd:root});
  execFileSync('tar',['-xf',archive,'-C',source]);
  const manifestBytes=readFileSync(join(source,'provenance.json'));expect(sha(manifestBytes)).toBe(CAPSULE_MANIFEST);
  const manifest=JSON.parse(manifestBytes.toString('utf8')) as CapsuleManifest;
  expect(manifest).toMatchObject({schemaVersion:1,kind:'CONTRACT_FORM_PRE6411_HISTORICAL_RUNTIME_SOURCE_CAPSULE',historicalProvenance:{commit:SOURCE,commitPublished:false,privateHistoryIncluded:false},evidenceParent:'fca9a75fc28260f725e0f067d8d6879e2a70bb04',sourceFileCount:1071,sourceBytes:39200382,sourceVector:{sha256:SOURCE_VECTOR}});
  expect(manifest.files).toHaveLength(1071);
  const paths=manifest.files.map(file=>file.path);expect(paths).toEqual([...paths].sort());expect(new Set(paths).size).toBe(1071);
  const vector=manifest.files.map(file=>[file.path,file.gitMode,file.bytes,file.sha256]);expect(sha(JSON.stringify(vector))).toBe(SOURCE_VECTOR);
  let sourceBytes=0;
  for(const file of manifest.files){
   expect(file.gitMode).toBe('100644');expect(file.path.split('/').every(part=>part.length>0&&part!=='.'&&part!=='..')).toBe(true);
   expect(file.path).not.toContain('\\');expect(file.path.startsWith('/')).toBe(false);
   const path=join(source,file.path),stat=lstatSync(path);expect(stat.isFile()).toBe(true);expect(stat.isSymbolicLink()).toBe(false);expect(stat.mode&0o111).toBe(0);
   expect(realpathSync(path)).toBe(resolve(source,file.path));
   const bytes=readFileSync(path);expect(bytes.length).toBe(file.bytes);expect(sha(bytes),file.path).toBe(file.sha256);
   expect(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')).toBe(file.provenanceGitBlobSHA1);sourceBytes+=bytes.length;
  }
  expect(sourceBytes).toBe(39200382);
  const archivePaths=(folder:string,relative=''):string[]=>readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
   const path=relative?relative+'/'+entry.name:entry.name;expect(entry.isSymbolicLink(),path).toBe(false);
   if(entry.isDirectory())return archivePaths(join(folder,entry.name),path);expect(entry.isFile(),path).toBe(true);return[path];
  });
  expect(archivePaths(source).sort()).toEqual([...paths,'provenance.json'].sort());
  for(const [file,hash] of Object.entries(DEPENDENCIES)){
   expect(sha(readFileSync(join(source,file))),file+' historical source pin').toBe(hash);
   const historical=readFileSync(join(source,file),'utf8'),prepared=readFileSync(join(root,file),'utf8');
   expect(file==='tsconfig.json'?prepared:withoutApprovedPhoneDependency(file,prepared,historical),
    file+' exact prepared dependency/toolchain transition').toBe(historical);
  }
  symlinkSync(realpathSync(join(root,'node_modules')),join(source,'node_modules'),'dir');
  // This source immediately predates native-field-parity (then5974, now6411). Its own journal
  // ends5972; the tested combined SQL prefix also includes6410. It is not an identical-journal claim.
  const historical=JSON.parse(readFileSync(join(source,'db/migrations/meta/_journal.json'),'utf8')) as typeof journal;
  expect(historical.entries.at(-1)?.tag).toBe('5972_contract_unsigned_email_form_sources');
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;
  storage=postgres(at(false),{max:1,onnotice:()=>{}});
  await storage.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO ai_hr_app`);
  await storage.unsafe('GRANT USAGE, CREATE ON SCHEMA public TO ai_hr_app');
  await storage.unsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app');
  await storage.unsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app');
  mkdirSync(join(prefix,'meta'),{recursive:true});
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(prefix,entry.tag+'.sql'));
  writeFileSync(join(prefix,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(drizzle(storage),{migrationsFolder:prefix});
  const ledger=async()=>[...await storage!<Ledger[]>`select hash,created_at::text from drizzle.__drizzle_migrations order by id`];
  const prefixLedger=journal.entries.slice(0,boundary).map(entry=>({hash:sha(readFileSync(join(prefix,entry.tag+'.sql'))),created_at:String(entry.when)}));
  expect(await ledger()).toEqual(prefixLedger);
  // A separate process resolves every app port from the historical root. No current application
  // import or borrowed worker bootstrap is allowed to generate these signatures.
  const env:NodeJS.ProcessEnv={...process.env,CI:'true',WORKER_DB:'0',DATABASE_URL:at(true),TEST_DATABASE_URL:at(true),DATABASE_POOLED_URL:at(true),MIGRATION_DATABASE_URL:at(false),TEST_MIGRATION_DATABASE_URL:at(false),TSX_TSCONFIG_PATH:join(source,'tsconfig.json'),AIHR_DB_PROCESS_ROLE:'worker',AIHR_DB_POOL_MAX:'1',AIHR_DB_POOLER_SERVER_CONNECTIONS:'1'};
  for(const key of Object.keys(env))if(key.startsWith('VITEST_'))delete env[key];
  const {stdout}=await exec(process.execPath,['--conditions=react-server','--import','tsx',resolve(root,'test/helpers/contract-form-alias-baseline-child.ts'),JSON.stringify({sourceRoot:source,expectedDatabase:name,prefixCount:boundary})],{cwd:source,env,timeout:180000,maxBuffer:4*1024*1024});
  const lines=stdout.split('\n').filter(line=>line.startsWith('CONTRACT_FORM_ALIAS_BASELINE_RESULT '));expect(lines).toHaveLength(1);
  const f=JSON.parse(lines[0].slice('CONTRACT_FORM_ALIAS_BASELINE_RESULT '.length)) as Baseline;
  expect(f).toMatchObject({version:1,source:SOURCE});
  for(const id of [f.tenantId,f.companyId,f.employmentId,f.employeePersonId,f.caseId,f.letterId,f.admin.userId,f.admin.personId,f.employee.userId,f.employee.personId])expect(id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  expect(f.admin.userId).not.toBe(f.employee.userId);expect(f.admin.personId).not.toBe(f.employee.personId);expect(f.employee.personId).toBe(f.employeePersonId);
  const {before,form}=f;
  expect(before.id).toBe(f.letterId);expect(before.caseId).toBe(f.caseId);expect(before.state).toBe('released');expect(before.valuesFixed).toBe(true);expect(before.body).not.toBeNull();
  expect(before.body!.values.bankAcc).toBe('FICTIONAL-BANK-001');expect(before.body!.values).not.toHaveProperty('Bank account number');
  const expected='Known Fictional ending subject; unresolved {Bank account number}.';
  expect(f.rendered).toBe(expected);expect(form.visible).toBe(true);expect(form.letterId).toBe(f.letterId);expect(form.values.lockedBank).toBe('FICTIONAL-BANK-001');
  expect(sha(before.body!.fingerprintSource)).toBe(before.contentHash);expect(before.body!.receipts).toHaveLength(2);expect(form.receipts).toHaveLength(3);
  expect(f.ledger).toEqual(prefixLedger);expect(await ledger()).toEqual(prefixLedger);
  // Independent physical rows prove the native actors, three response-bound actions, immutable
  // signatures and exact retained snapshots. Child PASS flags are not evidence for these assertions.
  const [subject]=await storage<{company_id:string;person_id:string}[]>`select company_id::text,person_id::text from employment where tenant_id=${f.tenantId}::uuid and id=${f.employmentId}::uuid`;
  expect(subject).toEqual({company_id:f.companyId,person_id:f.employeePersonId});
  const accounts=await storage`select id::text,person_id::text from app_user where tenant_id=${f.tenantId}::uuid and id in(${f.admin.userId}::uuid,${f.employee.userId}::uuid) order by id`;
  expect([...accounts]).toEqual([f.admin,f.employee].map(actor=>({id:actor.userId,person_id:actor.personId})).sort((a,b)=>a.id.localeCompare(b.id)));
  const [link]=await storage<{id:string;data:{state:string;valuesFixed:boolean}}[]>`select signing_document_id::text as id,data from contract_shared_letter where tenant_id=${f.tenantId}::uuid and id=${f.letterId}::uuid and case_id=${f.caseId}::uuid`;
  expect(link.id).toMatch(/^[a-f0-9-]{36}$/);expect(link.data.state).toBe('released');expect(link.data.valuesFixed).toBe(true);
  const [signed]=await storage<{content_hash:string;content_revision:number}[]>`select data->>'contentHash' as content_hash,(data->>'contentRevision')::integer as content_revision from document_signing_document where tenant_id=${f.tenantId}::uuid and id=${link.id}::uuid`;
  expect(signed.content_hash).toBe(before.contentHash);expect(signed.content_revision).toBe(before.contentRevision);
  const actions=await storage<{action_kind:string;scope:string;actor_user_id:string;actor_person_id:string;bound:boolean}[]>`select i.action_kind,i.scope,i.actor_user_id::text,i.actor_person_id::text,
   (r.action_id is not null and r.data->>'actorUserId'=i.actor_user_id::text and r.data->>'actorPersonId'=i.actor_person_id::text and r.data->>'legalBaseHash'=i.base_hash and r.data->>'responseHash'=i.response_hash and (r.data->>'responseRevision')::integer=i.response_revision) as bound
   from document_form_action_intent i left join document_form_action_receipt r using(tenant_id,document_id,action_id)
   where i.tenant_id=${f.tenantId}::uuid and i.document_id=${link.id}::uuid order by i.created_at,i.action_id`;
  expect([...actions]).toEqual([
   {action_kind:'reviewed',scope:'hr',actor_user_id:f.admin.userId,actor_person_id:f.admin.personId,bound:true},
   {action_kind:'signed',scope:'hr',actor_user_id:f.admin.userId,actor_person_id:f.admin.personId,bound:true},
   {action_kind:'signed',scope:'employee',actor_user_id:f.employee.userId,actor_person_id:f.employee.personId,bound:true},
  ]);
  const snapshot=async()=>{
   const result:Record<string,unknown>={};
   for(const table of ['document_signing_document','document_form_response','document_form_response_revision','document_form_action_intent','document_form_action_receipt','document_form_release']){
    const column=table==='document_signing_document'?'id':'document_id';
    result[table]=[...await storage!.unsafe(`select to_jsonb(t) as row from public.${table} t where tenant_id=$1::uuid and ${column}=$2::uuid order by to_jsonb(t)::text`,[f.tenantId,link.id])];
    expect((result[table] as unknown[]).length,table+' genuine signed data').toBeGreaterThan(0);
   }
   result.letter=[...await storage!`select to_jsonb(l) as row from contract_shared_letter l where tenant_id=${f.tenantId}::uuid and id=${f.letterId}::uuid`];
   result.content=[...await storage!`select to_jsonb(c) as row from contract_shared_letter_content c where tenant_id=${f.tenantId}::uuid and letter_id=${f.letterId}::uuid order by content_revision`];
   expect((result.content as unknown[]).length).toBeGreaterThan(0);return result;
  };
  const physicalBefore=await snapshot();
  await migrate(drizzle(storage),{migrationsFolder:'db/migrations'});
  expect((await ledger()).slice(0,boundary)).toEqual(prefixLedger);expect(await ledger()).toHaveLength(journal.entries.length);
  expect(await snapshot()).toEqual(physicalBefore);
  const correction=await storage`update employee_statutory_my set bank_account_no='FICTIONAL-CORRECTION-AFTER-SIGN' where tenant_id=${f.tenantId}::uuid and person_id=${f.employeePersonId}::uuid returning bank_account_no`;
  expect([...correction]).toEqual([{bank_account_no:'FICTIONAL-CORRECTION-AFTER-SIGN'}]);
  // Only now import current readers and resolve a fresh, actual post-upgrade authorized context.
  for(const key of keys)process.env[key]=at(!key.includes('MIGRATION'));
  process.env.DATABASE_POOLED_URL=at(true);process.env.AIHR_DB_PROCESS_ROLE='worker';process.env.AIHR_DB_POOL_MAX='1';process.env.AIHR_DB_POOLER_SERVER_CONNECTIONS='1';
  const harness=await import('./harness');close=harness.closeAll;
  const {withTenant}=await import('../db/client'),{resolveEntitlementsTx}=await import('../core/entitlements');
  const identity={tenantId:f.tenantId,userId:f.admin.userId,personId:f.admin.personId,roles:['hr_admin']};
  const entitlements=await withTenant(identity,tx=>resolveEntitlementsTx(tx,f.tenantId)),ctx={...identity,entitlements};
  const {readContractSharedLetter}=await import('../packs/contracts/service');
  const {readContractSharedForm}=await import('../core/contract-shared-form');
  const {renderContractSharedLetter}=await import('../core/contract-shared-signing');
  const {merge}=await import('../lib/lifecycle-v9-model');
  const after=await readContractSharedLetter(ctx,f.letterId),retained=await readContractSharedForm(ctx,f.letterId);
  expect(retained?.visible).toBe(true);if(!retained?.visible)throw new Error('Expected actual retained routed Form');
  expect(after.contentHash).toBe(before.contentHash);expect(after.contentRevision).toBe(before.contentRevision);
  expect(after.body!.fingerprintSource).toBe(before.body!.fingerprintSource);expect(after.body!.values).toEqual(before.body!.values);expect(after.body!.receipts).toEqual(before.body!.receipts);
  expect(retained.values.lockedBank).toBe('FICTIONAL-BANK-001');expect(retained.legalBaseHash).toBe(form.legalBaseHash);expect(retained.receipts).toEqual(form.receipts);
  expect(after.body!.values).not.toHaveProperty('Bank account number');
  const document=renderContractSharedLetter(after)!;const intro=document.blocks.find(block=>block.id==='intro')!;
  expect(merge(intro.text,{...document.mergeValues,...form.values}).text).toBe(expected);
  expect(await snapshot()).toEqual(physicalBefore);
 }finally{
  if(close)await close();if(storage)await storage.end({timeout:5});
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  for(const key of currentKeys){if(currentOriginal[key]===undefined)delete process.env[key];else process.env[key]=currentOriginal[key];}
  if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},300000);
