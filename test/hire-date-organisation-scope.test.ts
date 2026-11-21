import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,isNull} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {correctHireDetails,hireCorrectionView} from '../core/hire-correction';
import {recordHistoryMovementTx} from '../core/movement-history';
import {recordEmploymentOrganisationTagsTx} from '../core/company-organisation';

let b:Base,id:string,historicalCompanyId:string,correctedCompanyId:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const ctx=adminCtx(b);
 const companies=await owner.db.insert(s.company).values([
  {tenantId:b.tenantId,legalName:'Fictional Historical Employer',country:'MY'},
  {tenantId:b.tenantId,legalName:'Fictional Corrected Hire Employer',country:'MY'},
 ]).returning();
 historicalCompanyId=companies[0].id;correctedCompanyId=companies[1].id;
 await owner.withTenant(ctx,tx=>tx.update(s.department).set({isGlobal:true}).where(eq(s.department.id,b.deptA)));
 id=(await hireEmployee(ctx,{person:{fullName:'Fictional Historical Hire',primaryEmail:'historical-hire@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 await withTenant(ctx,tx=>recordHistoryMovementTx(tx,ctx,{employmentId:id,kind:'entityTransfer',effectiveDate:'2026-03-01',before:{companyId:historicalCompanyId},after:{companyId:b.companyId}}));
});
afterAll(closeAll);

describe('hire-date organisation scope after a historical entity transfer',()=>{
 it.each([false,true])('corrects the original date with simultaneous company correction=%s',async(changeCompany)=>{
  const ctx=adminCtx(b);
  const existingEvents=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.subjectEmploymentId,id)).orderBy(s.domainEvent.sequence);
  expect(existingEvents.length).toBeGreaterThan(0);
  await correctHireDetails(ctx,{employmentId:id,changes:{},hireInformation:{hiredOn:'2026-01-06',joinDate:'2026-01-06',...(changeCompany?{companyId:correctedCompanyId}:{})},reason:'Correct fictional original hire facts'});
  const [current]=await owner.db.select().from(s.employment).where(eq(s.employment.id,id));
  expect(current).toMatchObject({companyId:b.companyId,hiredOn:'2026-01-06'});
  const rows=await owner.db.select({companyId:s.assignment.companyId,from:s.assignment.validFrom,to:s.assignment.validTo}).from(s.assignment).where(and(eq(s.assignment.employmentId,id),isNull(s.assignment.supersededAt))).orderBy(s.assignment.validFrom);
  expect(rows).toEqual([
   {companyId:changeCompany?correctedCompanyId:historicalCompanyId,from:'2026-01-06',to:'2026-03-01'},
   {companyId:b.companyId,from:'2026-03-01',to:null},
  ]);
  expect(await hireCorrectionView(ctx,id)).toMatchObject({groupJoinDate:'2026-01-06',companyId:changeCompany?correctedCompanyId:historicalCompanyId});
  const retained=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.subjectEmploymentId,id)).orderBy(s.domainEvent.sequence);
  expect(retained.slice(0,existingEvents.length)).toEqual(existingEvents);
 });

 it('still rejects organisation tags for a company that does not own the historical date',async()=>{
  const ctx=adminCtx(b);
  await expect(withTenant(ctx,tx=>recordEmploymentOrganisationTagsTx(tx,ctx,{employmentId:id,companyId:b.companyId,asOf:'2026-01-06',trigger:'correction'}))).rejects.toMatchObject({cause:{code:'42501',message:'Organisation write scope is unavailable'}});
  const [current]=await owner.db.select().from(s.employment).where(eq(s.employment.id,id));
  expect(current).toMatchObject({companyId:b.companyId,hiredOn:'2026-01-01'});
 });
});
