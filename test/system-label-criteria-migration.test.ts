import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
import {setLabelGlobal} from '../core/system-labels';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
function preflight(){const source=readFileSync(new URL('../db/migrations/0550_system_label_company_criteria.sql',import.meta.url),'utf8'),start=source.indexOf('DO $$\nDECLARE v_kind'),end=source.indexOf('--> statement-breakpoint',start);expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);const body=source.slice(start,end);expect(body.length).toBeGreaterThan(1000);return body;}
describe('exact0550 preflight against preserved legacy data',()=>{
 it('accepts already valid scoped/global records without changing their values',async()=>{await setLabelGlobal(adminCtx(b),{kind:'department',labelId:b.deptA,isGlobal:true});const before=await owner.db.select().from(s.department).orderBy(s.department.id);await owner.db.execute(sql.raw(preflight()));expect(await owner.db.select().from(s.department).orderBy(s.department.id)).toEqual(before);});
 it.each(['orphan','origin-tenancy'] as const)('refuses legacy %s without choosing an automatic repair',async fault=>{
  const [otherTenant]=await owner.db.insert(s.tenant).values({name:'Synthetic migration foreign tenant',workosOrgId:randomUUID()}).returning({id:s.tenant.id});
  const [otherCompany]=await owner.db.insert(s.company).values({tenantId:fault==='origin-tenancy'?otherTenant.id:b.tenantId,legalName:'Synthetic migration company'}).returning({id:s.company.id});
  // Simulate pre0550 rows in a disposable fixture transaction. A preflight failure rolls back both
  // fixture rows and trigger changes; no trigger is left disabled for the next test.
  await expect(owner.db.transaction(async tx=>{
   await tx.execute(sql`alter table department disable trigger user`);await tx.execute(sql`alter table label_company_assignment disable trigger user`);
   if(fault==='orphan')await tx.insert(s.labelCompanyAssignment).values({tenantId:b.tenantId,labelKind:'department',labelId:randomUUID(),companyId:b.companyId});
   else if(fault==='origin-tenancy')await tx.insert(s.department).values({tenantId:b.tenantId,companyId:otherCompany.id,name:'Invalid legacy origin',isGlobal:true});
   await tx.execute(sql.raw(preflight()));
  })).rejects.toThrow();
 });
});
