/** Verify the critical Rewards roster query retains native dated grouping and readiness. */
import {sql} from 'drizzle-orm';
import {afterAll,expect,it} from 'vitest';
import {employedByCompanyDuring} from '../core/employment-company';
import {withRewardsTenant} from '../core/module-gate';
import {hireEmployee} from '../core/org';
import {personnelGroupingReadinessTx} from '../core/personnel-quality';
import type {SessionContext} from '../db/client';
import {businessUnit,company,department} from '../db/schema';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
import {setupCompanyStructureFixture} from './rewards-setup-fixture';

afterAll(closeAll);

async function matchingRosters(ctx:SessionContext,companyId:string,businessUnitId:string,date:string){
 const overlap=employedByCompanyDuring(companyId,date,date);
 const inWorkforce=sql`${overlap} and employment.hired_on<=${date}::date
   and (employment.terminated_on is null or employment.terminated_on>${date}::date)`;
 const activeAssignment=sql`assignment.valid_from<=${date}::date
   and (assignment.valid_to is null or assignment.valid_to>${date}::date)
   and assignment.superseded_at is null`;
 return withRewardsTenant(ctx,async tx=>{
  const organizationFilter=async()=>Array.from(await tx.execute(sql`
   select employment.id,assignment.id as assignment_id from employment
   join person on person.id=employment.person_id
   join assignment on assignment.employment_id=employment.id
   left join job_grade on job_grade.id=employment.grade_id
   where ${inWorkforce} and ${activeAssignment}
    and (case when app.employment_organisation_tags(employment.id,${date}::date)->>'status'='legacy'
     then assignment.business_unit_id
     else (app.employment_organisation_tags(employment.id,${date}::date)->>'businessUnitId')::uuid end)=${businessUnitId}::uuid
   order by employment.employee_code,employment.id`));
  const organizationOnce=async()=>Array.from(await tx.execute(sql`
   with workforce as materialized (
    select employment.id,employment.employee_code,
      app.employment_organisation_tags(employment.id,${date}::date) as tags
    from employment join person on person.id=employment.person_id
    where ${inWorkforce}
   )
   select workforce.id,assignment.id as assignment_id from workforce
   join assignment on assignment.employment_id=workforce.id
   where ${activeAssignment}
    and (case when workforce.tags->>'status'='legacy' then assignment.business_unit_id
     else (workforce.tags->>'businessUnitId')::uuid end)=${businessUnitId}::uuid
   order by workforce.employee_code,workforce.id`));
  const [current,materialized]=await Promise.all([organizationFilter(),organizationOnce()]);
  expect(materialized).toEqual(current);
  const subjects=await tx.execute<{id:string;status:string}>(sql`
   select employment.id,app.employment_organisation_tags(employment.id,${date}::date)->>'status' as status
   from employment join person on person.id=employment.person_id where ${inWorkforce}
  `);
  const readiness=await personnelGroupingReadinessTx(tx,ctx,{
   employmentIds:subjects.map(row=>row.id),asOf:date,
  });
  return {members:materialized.map(row=>row.id),statuses:subjects.map(row=>row.status),readiness};
 });
}

it('preserves legacy assignments, published mapping and pending structure in dated Rewards roster reads',async()=>{
 await migrateTestDb();
 await resetDb();
 const base=await seedBase();
 await setModule(base.tenantId,'rewards','active');
 const ctx=await entitledCtx(base);
 const [unmapped]=await owner.db.insert(company).values({tenantId:base.tenantId,legalName:'Fictional unmapped company'}).returning();
 const [unmappedDepartment]=await owner.db.insert(department).values({tenantId:base.tenantId,companyId:unmapped.id,
  code:'TEST',name:'Fictional unmapped department'}).returning();
 const [legacy,published,unmappedUnit]=await owner.db.insert(businessUnit).values([
  {tenantId:base.tenantId,companyId:base.companyId,code:'LEGACY',name:'Fictional former grouping'},
  {tenantId:base.tenantId,companyId:base.companyId,code:'MAPPED',name:'Fictional reviewed grouping'},
  {tenantId:base.tenantId,companyId:unmapped.id,code:'UNMAPPED',name:'Fictional unmapped grouping'},
 ]).returning();

 const hire=(companyId:string,departmentId:string,businessUnitId:string,key:string)=>hireEmployee(ctx,{
  companyId,departmentId,businessUnitId,employmentType:'full_time',hiredOn:'2024-01-01',
  person:{fullName:'Fictional roster '+key,primaryEmail:key+'@reward-roster.example.invalid'},
 });
 const ready=await hire(base.companyId,base.deptA,legacy.id,'mapped');
 const pending=await hire(unmapped.id,unmappedDepartment.id,unmappedUnit.id,'unmapped');
 const historical='2026-01-10',effectiveOn='2026-01-11';
 await setupCompanyStructureFixture(ctx,[{companyId:base.companyId,businessUnitId:published.id}],effectiveOn);

 const before=await matchingRosters(ctx,base.companyId,legacy.id,historical);
 expect(before.members).toContain(ready.employmentId);
 expect(before.statuses).toContain('legacy');
 expect(before.readiness).toContainEqual({employmentId:ready.employmentId,companyId:base.companyId,ready:true,reason:null});

 const after=await matchingRosters(ctx,base.companyId,published.id,effectiveOn);
 expect(after.members).toContain(ready.employmentId);
 expect(after.statuses).toContain('ready');
 expect(after.readiness).toContainEqual({employmentId:ready.employmentId,companyId:base.companyId,ready:true,reason:null});
 const replaced=await matchingRosters(ctx,base.companyId,legacy.id,effectiveOn);
 expect(replaced.members.includes(ready.employmentId)).toBe(false);

 const blocked=await matchingRosters(ctx,unmapped.id,unmappedUnit.id,effectiveOn);
 expect(blocked.members).toEqual([]);
 expect(blocked.statuses).toEqual(['pending']);
 expect(blocked.readiness).toEqual([{employmentId:pending.employmentId,companyId:unmapped.id,
  ready:false,reason:'company_not_in_structure'}]);
},120_000);
