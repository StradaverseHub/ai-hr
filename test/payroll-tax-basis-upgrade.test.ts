/** Ordinary journal upgrade over a populated, trigger-protected pre-0737 database. Hosted only. */
import {randomUUID,createHash} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import type {PgTable} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createDb} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {seedPayrollCycleCatalog,previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../packs/payroll/service';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(async()=>{await resetDb();});afterAll(closeAll);

it('applies only0737 through the ordinary migrator after closed payroll and immutable import history exist, preserving their bytes and the applied ledger prefix',async()=>{
 const sourceUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(sourceUrl.hostname);expect(sourceUrl.port).toBe('5433');expect(sourceUrl.pathname).toMatch(/^\/ai_hr_test/);
 const name='ai_hr_tax_upgrade_'+randomUUID().replaceAll('-','');
 const adminUrl=new URL(sourceUrl);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.toString(),{max:1});
 const destinationUrl=new URL(sourceUrl);destinationUrl.pathname='/'+name;
 const preDirectory=mkdtempSync(join(tmpdir(),'aihr-tax-pre0737-'));
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 expect(journal.entries.at(-1).tag).toBe('0737_payroll_tax_basis_corrections');
 mkdirSync(join(preDirectory,'meta'));writeFileSync(join(preDirectory,'meta','_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
 for(const entry of journal.entries.slice(0,-1))copyFileSync(join('db/migrations',entry.tag+'.sql'),join(preDirectory,entry.tag+'.sql'));
 let target:ReturnType<typeof createDb>|undefined;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);target=createDb(destinationUrl.toString(),{max:1});
  await migrate(target.db,{migrationsFolder:preDirectory});
  const beforeLedger=await target.db.execute<{hash:string;created_at:string}>(sql`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`);
  expect(beforeLedger.length).toBeGreaterThan(500);expect(Number(beforeLedger.at(-1)!.created_at)).toBeLessThan(1793330000074);
  expect((await target.db.execute(sql`select to_regclass('public.payroll_tax_basis_revision') as relation`))[0]).toMatchObject({relation:null});

  // Create valid old-contract data through the real authorized fixture services, then copy the
  // required old-domain graph in FK order. Every destination trigger remains enabled throughout.
  const b=await seedBase();await setModule(b.tenantId,'payroll','active');const ctx=await entitledCtx(b);
  const hired=await hireEmployee(ctx,{person:{fullName:'Fictional populated upgrade employee',primaryEmail:'upgrade@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'UPGRADE-001',hiredOn:'2025-01-01'});
  await seedPayrollCycleCatalog(ctx,b.companyId);
  const rows=['BASIC','EEEPF','EESOCSO','EEEIS','PCB'].map(code=>['UPGRADE-001','2026-01','ME',code,b.companyId,code==='BASIC'?'5000':'0']);
  const preview=await previewPayrollHistoryUpload(ctx,{name:'upgrade-history.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows])),operationKey:randomUUID()});
  expect(preview.plan.counts).toMatchObject({created:1,invalid:0});await confirmPayrollHistoryUpload(ctx,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true});
  const tables:PgTable[]=[schema.tenant,schema.company,schema.department,schema.position,schema.costCenter,schema.person,schema.appUser,schema.roleAssignment,schema.employment,schema.payrollCycle,schema.payPeriod,schema.payrollHistoryImportAttempt,schema.payrollBatch,schema.payslip,schema.payrollHistoryImportRecord,schema.payrollHistoryImportSnapshot,schema.payrollHistoryImportRevision,schema.payrollHistoryImportEvent,schema.domainEvent];
  for(const table of tables){const rows=await owner.db.select().from(table);if(rows.length)await target.db.insert(table).values(rows);}
  const snapshot=async()=>{
   const out:Record<string,unknown>={};
   for(const table of ['payslip','payroll_batch','payroll_history_import_attempt','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision','payroll_history_import_event','domain_event'])out[table]=await target!.client.unsafe(`select to_jsonb(t) as value from public.${table} t order by id`);
   return out;
  };
  const old=await snapshot();expect((old.payslip as unknown[])).toHaveLength(1);expect((old.payroll_history_import_snapshot as unknown[])).toHaveLength(1);expect((old.payroll_history_import_revision as unknown[])).toHaveLength(1);
  expect((await target.db.select().from(schema.payslip))[0]).toMatchObject({employmentId:hired.employmentId,grossPay:'5000.00',netPay:'5000.00'});
  const protectedBefore=await target.db.execute(sql`select tgname,tgenabled from pg_trigger where tgrelid='public.payroll_history_import_snapshot'::regclass and not tgisinternal order by tgname`);expect(protectedBefore.length).toBeGreaterThan(0);expect(protectedBefore.every(row=>row.tgenabled==='O')).toBe(true);

  await migrate(target.db,{migrationsFolder:'db/migrations'});
  expect(await snapshot()).toEqual(old);
  const afterLedger=await target.db.execute<{hash:string;created_at:string}>(sql`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`);
  expect(afterLedger.slice(0,-1)).toEqual(beforeLedger);expect(afterLedger).toHaveLength(beforeLedger.length+1);
  expect(afterLedger.at(-1)).toEqual({hash:createHash('sha256').update(readFileSync('db/migrations/0737_payroll_tax_basis_corrections.sql')).digest('hex'),created_at:'1793330000074'});
  expect(await target.db.execute(sql`select tgname,tgenabled from pg_trigger where tgrelid='public.payroll_history_import_snapshot'::regclass and not tgisinternal order by tgname`)).toEqual(protectedBefore);
  expect((await target.db.execute(sql`select relrowsecurity as protected from pg_class where oid='public.payroll_tax_basis_revision'::regclass`))[0]).toEqual({protected:true});
  expect((await target.db.execute(sql`select has_table_privilege('ai_hr_app','public.payroll_tax_basis_revision','SELECT') as can_read,has_table_privilege('ai_hr_app','public.payroll_tax_basis_revision','INSERT') as can_insert,has_table_privilege('ai_hr_app','public.payroll_tax_basis_revision','DELETE') as can_delete`))[0]).toEqual({can_read:true,can_insert:true,can_delete:false});
  await expect(target.db.execute(sql`update payroll_history_import_snapshot set value_hash=value_hash`)).rejects.toThrow();
  await migrate(target.db,{migrationsFolder:'db/migrations'});expect(await target.db.execute(sql`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`)).toEqual(afterLedger);
 }finally{
  if(target)await target.client.end();await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();rmSync(preDirectory,{recursive:true,force:true});
 }
},120000);
