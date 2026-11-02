/** Real full-workbook admission; dormant function cells are never marked supported by fixtures. */
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {validateEmployeeImport} from '../core/import';
import {workforceFullImportCompanies,WorkforceAccessError} from '../core/workforce-access';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
it('keeps the actual native HR company course and refuses unsupported operations',async()=>{
 const ctx=adminCtx(b),rows=await withTenant(ctx,tx=>tx.execute<{view:boolean;add:boolean;edit:boolean}>(sql`select app.workforce_full_import_allowed(${b.companyId}::uuid,'view') as view,app.workforce_full_import_allowed(${b.companyId}::uuid,'add') as add,app.workforce_full_import_allowed(${b.companyId}::uuid,'edit') as edit`));
 expect(rows).toEqual([{view:true,add:true,edit:false}]);
 expect(await workforceFullImportCompanies(ctx)).toContain(b.companyId);
});
it('rejects forged HR claims before analyzing a workbook and exposes no import companies',async()=>{
 const userId=await createAppUser(b.tenantId,null,'employee');
 const forged:SessionContext={...adminCtx(b),userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect(await workforceFullImportCompanies(forged)).toEqual([]);
 const before=await owner.client`select count(*)::integer as n from employment where tenant_id=${b.tenantId}::uuid`;
 await expect(validateEmployeeImport(forged,{companyId:b.companyId,records:[]})).rejects.toBeInstanceOf(WorkforceAccessError);
 expect(await owner.client`select count(*)::integer as n from employment where tenant_id=${b.tenantId}::uuid`).toEqual(before);
 expect(await owner.client`select id from employee_import_run where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);
});
