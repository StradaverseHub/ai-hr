/** Inactive600x source packet: actual information-correction boundaries, not fabricated Assignment rows. */
import {sql} from 'drizzle-orm';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {migrateTestDb,closeAll,owner} from './harness';
import {previewInformationCorrection,correctInformation} from '../core/information-correction';
import {movementHistory} from '../core/movement';
import {contractPostingFixture,releaseContractPosting,approveAppliedContractPosting} from './helpers/contract-posting-fixture';
import {addCalendarMonths,todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';

beforeAll(migrateTestDb);afterAll(closeAll);

describe('Contract approval across an independently corrected Assignment boundary',()=>{
 it('uses the canonical lift and reapply owner without changing the later Personnel correction or current pay',async()=>{
  const target=addCalendarMonths(todayInKualaLumpur().slice(0,7)+'-01',-1);
  const f=await contractPostingFixture({endOn:addDaysIso(target,-1),beforeAdopt:async({admin,employee,b,newStart})=>{
   const input={employmentId:employee.employmentId,changes:{departmentId:b.deptB},reason:'Fictional later Personnel correction',effectiveOn:addDaysIso(newStart,5)};
   const preview=await previewInformationCorrection(admin,input);
   await correctInformation(admin,{...input,fingerprint:preview.fingerprint,method:'manual'});
  }});
  const originalHistory=await movementHistory(f.admin,f.employee.employmentId);
  expect(originalHistory.some(row=>row.kind==='transfer')).toBe(false);
  const facts=async()=>{
   const[row]=await owner.db.execute<{department:string;validFrom:string;salary:string;counter:number;start:string;end:string}>(sql`
    select a.department_id as department,a.valid_from::text as "validFrom",c.basic_salary::text as salary,
     e.contract_number as counter,e.contract_start_date::text as start,e.contract_end_date::text as "end"
    from public.employment e join public.assignment a on a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null
    join public.compensation c on c.tenant_id=e.tenant_id and c.employment_id=e.id and c.valid_to is null and c.superseded_at is null
    where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);
   return row;
  };
  const before=await facts();expect(before).toMatchObject({department:f.b.deptB,validFrom:addDaysIso(f.newStart,5),counter:4});
  const posting=await releaseContractPosting(f);
  const approved=await approveAppliedContractPosting(f.approver,{id:posting.id,revision:posting.revision});
  expect(approved).toMatchObject({postingStatus:'approved',applicationState:'applied'});
  expect(await facts()).toEqual({...before,counter:5,start:f.newStart,end:f.newEnd});
  const[boundaries]=await owner.db.execute<{reapplied:number}>(sql`
   select count(*) filter(where d.event_type='employment.information.boundary.reapplied')::int as reapplied
   from public.domain_event d where d.tenant_id=${f.b.tenantId}::uuid and d.subject_employment_id=${f.employee.employmentId}::uuid`);
  expect(boundaries.reapplied).toBeGreaterThan(0);
 });
});
