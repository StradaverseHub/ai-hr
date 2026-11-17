/** Genuine native Form signatures at the exact pre5974 journal, followed by ordinary migration.
 * No signed rows, receipts, function replacements or owner guards are manufactured by this fixture. */
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {sql} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';

it('preserves a genuinely signed old known label and old unresolved private label after the alias upgrade',async()=>{
 const tag='5974_contract_form_native_field_parity';
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string}[]};
 const boundary=journal.entries.findIndex(entry=>entry.tag===tag);expect(boundary).toBeGreaterThan(5300);
 const keys=['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL','DATABASE_URL','MIGRATION_DATABASE_URL'] as const;
 const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);expect(['localhost','127.0.0.1']).toContain(ownerUrl.hostname);
 const name='ai_hr_contract_alias_upgrade_'+randomUUID().replaceAll('-','');ownerUrl.pathname='/postgres';
 const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});ownerUrl.pathname='/'+name;
 const directory=mkdtempSync(join(tmpdir(),'contract-form-alias-upgrade-'));
 let created=false,storage:postgres.Sql|undefined,close:(()=>Promise<unknown>)|undefined;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;
  storage=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
  await storage.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO ai_hr_app`);
  await storage.unsafe('GRANT USAGE, CREATE ON SCHEMA public TO ai_hr_app');
  await storage.unsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app');
  await storage.unsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app');
  mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
  await migrate(drizzle(storage),{migrationsFolder:directory});
  // Change only this isolated test worker's disposable database, before importing the app singleton.
  for(const key of keys){const target=new URL(original[key]!);target.pathname='/'+name;process.env[key]=target.toString();}
  const harness=await import('./harness');close=harness.closeAll;
  const {seedCatalogs}=await import('../scripts/seed-catalogs');await seedCatalogs(harness.owner.db);
  const {formFixture,saveAnswers,actForm,visible}=await import('./helpers/contract-document-fixture');
  const {readContractSharedLetter}=await import('../packs/contracts/service');
  const {readContractSharedForm}=await import('../core/contract-shared-form');
  const {renderContractSharedLetter}=await import('../core/contract-shared-signing');
  const {merge}=await import('../lib/lifecycle-v9-model');
  const f=await formFixture([],{introText:'Known {Full name}; unresolved {Bank account number}.'});
  await saveAnswers(f.admin,f.letterId,{hrChoice:'No'});await actForm(f.admin,f.letterId,'reviewed');
  await actForm(f.admin,f.letterId,'signed');await actForm(f.employeeActor,f.letterId,'signed');
  const before=await readContractSharedLetter(f.admin,f.letterId),form=visible(await readContractSharedForm(f.admin,f.letterId));
  expect(before.state).toBe('released');expect(before.valuesFixed).toBe(true);expect(before.body).not.toBeNull();
  expect(before.body!.values.bankAcc).toBe('FICTIONAL-BANK-001');expect(before.body!.values).not.toHaveProperty('Bank account number');
  const render=(letter:typeof before)=>{const document=renderContractSharedLetter(letter)!;const intro=document.blocks.find(block=>block.id==='intro')!;return merge(intro.text,{...document.mergeValues,...form.values}).text;};
  const expected='Known Fictional ending subject; unresolved {Bank account number}.';
  expect(render(before)).toBe(expected);
  const [ledger]=await storage<{n:number}[]>`select count(*)::int n from drizzle.__drizzle_migrations`;expect(ledger.n).toBe(boundary);
  await migrate(drizzle(storage),{migrationsFolder:'db/migrations'});
  await harness.owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-CORRECTION-AFTER-SIGN' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
  const after=await readContractSharedLetter(f.admin,f.letterId),retained=visible(await readContractSharedForm(f.admin,f.letterId));
  expect(after.contentHash).toBe(before.contentHash);expect(after.contentRevision).toBe(before.contentRevision);
  expect(after.body!.fingerprintSource).toBe(before.body!.fingerprintSource);expect(after.body!.values).toEqual(before.body!.values);
  expect(retained.values.lockedBank).toBe('FICTIONAL-BANK-001');expect(retained.legalBaseHash).toBe(form.legalBaseHash);
  expect(after.body!.values).not.toHaveProperty('Bank account number');expect(render(after)).toBe(expected);
 }finally{
  if(close)await close();if(storage)await storage.end({timeout:5});
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},300000);
