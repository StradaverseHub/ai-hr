/** Real app-role UX scope. Scope is not a replacement for each downstream owner's authority. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {allowedCompanies} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';
import {shiftHomeDate} from '../lib/home-calendar-model';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function own(){const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional own company subject',primaryEmail:randomUUID()+'@home.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});const userId=await createAppUser(b.tenantId,employee.personId,'employee');const ctx:SessionContext={...adminCtx(b),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};return{...employee,ctx};}
describe('own company scope follows canonical verified-login inclusive eligibility',()=>{
 it.each(['current','future','final'] as const)('includes %s own employment',async(kind)=>{const self=await own(),today=todayInKualaLumpur();if(kind!=='current')await owner.db.update(s.employment).set({terminatedOn:kind==='final'?today:shiftHomeDate(today,1)}).where(eq(s.employment.id,self.employmentId));expect(await allowedCompanies(self.ctx)).toEqual([{id:b.companyId,name:'Acme Sdn Bhd'}]);});
 it.each(['past','earlier-resignation','earlier-last-day','blacklisted','future-hire','archived-login','wrong-person'] as const)('excludes %s rather than adding a loose future-date OR',async(kind)=>{const self=await own(),today=todayInKualaLumpur(),past=shiftHomeDate(today,-1),future=shiftHomeDate(today,1);if(kind==='archived-login')await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,self.ctx.userId!));else if(kind==='wrong-person')self.ctx={...self.ctx,personId:randomUUID()};else await owner.db.update(s.employment).set(kind==='blacklisted'?{blacklistedAt:new Date()}:kind==='future-hire'?{hiredOn:future}:kind==='earlier-resignation'?{terminatedOn:future,resignationDate:past}:kind==='earlier-last-day'?{terminatedOn:future,lastWorkingDate:past}:{terminatedOn:past}).where(eq(s.employment.id,self.employmentId));expect(await allowedCompanies(self.ctx)).toEqual([]);});
 it('does not add an unrelated company and keeps explicit grant branches separate',async()=>{const self=await own();const [foreign]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional unlinked company'}).returning();expect((await allowedCompanies(self.ctx)).map(row=>row.id)).toEqual([b.companyId]);expect((await allowedCompanies({...self.ctx,grants:[{role:'hr_admin',companyId:foreign.id}]})).map(row=>row.id).sort()).toEqual([b.companyId,foreign.id].sort());});
});
