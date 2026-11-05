import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {company,appUser,person,roleAssignment} from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {companyRegistrationOverview,changeCompanyRegistrationClassification,companyRegistrationPayrollWarning} from '../core/company-registration-readiness';
import {packFor} from '../localization/registry';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base;
beforeAll(async()=>{await migrateTestDb();});beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
it('recognizes a partially filled registration, excludes explicit group/test/archive records and records classification history',async()=>{
 const[gc]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Explicit grouping',country:'MY'}).returning();
 await changeCompanyRegistrationClassification(adminCtx(b),{companyId:gc.id,entityKind:'grouping_node',isTestEntity:false,expectedRevision:0});
 await changeCompanyRegistrationClassification(adminCtx(b),{companyId:b.companyId,entityKind:'legal_entity',isTestEntity:true,expectedRevision:0});
 await packFor('MY')!.companyStatutory.set(adminCtx(b),{companyId:b.companyId,epfEmployerNo:'EPF-ONLY',hrdfStatus:'mandatory'});
 const rows=await companyRegistrationOverview(adminCtx(b)),group=rows.find(r=>r.id===gc.id)!,test=rows.find(r=>r.id===b.companyId)!;
 expect(group).toMatchObject({status:'not_required',counted:false});expect(test).toMatchObject({status:'missing',counted:false,levyUnavailable:false});expect(test.missing).toEqual(['socsoEmployerCode','lhdnEmployerNo']);
 const[e]=await owner.db.execute(sql`select count(*)::int as n from domain_event where tenant_id=${b.tenantId}::uuid and event_type='company.registration-classification.changed'`);expect(e.n).toBe(2);
});
it('refuses a stale classification without an extra update or audit event',async()=>{
 const p={companyId:b.companyId,entityKind:'legal_entity',isTestEntity:true,expectedRevision:0};await changeCompanyRegistrationClassification(adminCtx(b),p);
 await expect(changeCompanyRegistrationClassification(adminCtx(b),p)).rejects.toThrow(/changed/);
 const[r]=await owner.db.execute(sql`select revision from company_registration_classification where company_id=${b.companyId}::uuid`);expect(r.revision).toBe(1);
 const[e]=await owner.db.execute(sql`select count(*)::int as n from domain_event where tenant_id=${b.tenantId}::uuid and event_type='company.registration-classification.changed'`);expect(e.n).toBe(1);
});
it('keeps foreign tenant classification and readiness out of both direct reads and writes',async()=>{
 const other=await seedBase();await changeCompanyRegistrationClassification(adminCtx(other),{companyId:other.companyId,entityKind:'grouping_node',isTestEntity:false,expectedRevision:0});
 expect((await companyRegistrationOverview(adminCtx(b))).some(r=>r.id===other.companyId)).toBe(false);
 await expect(changeCompanyRegistrationClassification(adminCtx(b),{companyId:other.companyId,entityKind:'grouping_node',isTestEntity:false,expectedRevision:1})).rejects.toThrow(/not available/);
 const raw=await withTenant(adminCtx(b),tx=>tx.execute(sql`select company_id from company_registration_classification where company_id=${other.companyId}::uuid`));expect(raw).toHaveLength(0);
});
it('narrows readiness and classification to an actual company-scoped administrator',async()=>{
 const[c]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Outside admin scope'}).returning();const[p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Scoped reviewer',primaryEmail:randomUUID()+'@registration.test'}).returning();const[u]=await owner.db.insert(appUser).values({tenantId:b.tenantId,personId:p.id,workosUserId:randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,companyId:b.companyId,role:'hr_admin'});
 const ctx:SessionContext={...adminCtx(b),userId:u.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect((await companyRegistrationOverview(ctx)).some(r=>r.id===c.id)).toBe(false);await expect(changeCompanyRegistrationClassification(ctx,{companyId:c.id,entityKind:'grouping_node',isTestEntity:false,expectedRevision:0})).rejects.toThrow(/not available/);
});

it('counts only actual selected payroll-period employments and does not claim levy loss when HRDF is registered',async()=>{
 const ctx=adminCtx(b),today=todayInKualaLumpur(),year=Number(today.slice(0,4));
 const hire=(name:string,hiredOn:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@payroll-registration.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});
 const first=await hire('First eligible payroll person',`${year-1}-01-01`),second=await hire('Second eligible payroll person',`${year-1}-01-01`);
 await hire('Future hire outside this payroll period',`${year+1}-01-01`);
 const input={companyIds:[b.companyId],payPeriod:today.slice(0,7)};
 expect(await companyRegistrationPayrollWarning(ctx,input)).toMatchObject({employees:2,companies:1});
 expect(await companyRegistrationPayrollWarning(ctx,{...input,employmentIds:[second.employmentId,randomUUID()]})).toMatchObject({employees:1});
 expect(await companyRegistrationPayrollWarning(ctx,{...input,employmentIds:[]})).toMatchObject({employees:0});
 await packFor('MY')!.companyStatutory.set(ctx,{companyId:b.companyId,epfEmployerNo:'PARTIAL-EPF',hrdfStatus:'mandatory'});
 expect((await companyRegistrationOverview(ctx)).find(r=>r.id===b.companyId)?.status).toBe('missing');
 expect(await companyRegistrationPayrollWarning(ctx,{...input,employmentIds:[first.employmentId]})).toMatchObject({employees:0});
});
