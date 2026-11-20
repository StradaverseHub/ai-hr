import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import {employment,leaveRequestDate,person,roleAssignment,appUser} from '../../db/schema';
import {leaveRequestDateBreakdowns} from '../../core/read';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

// Retain the previous query and its per-request transaction for the comparison.
function previousRead(ctx:SessionContext, requestId:string) {
  return withTenant(ctx,tx=>tx.select({
    id:leaveRequestDate.id,
    leaveDate:leaveRequestDate.leaveDate,
    days:leaveRequestDate.days,
    status:leaveRequestDate.status,
    rejectReason:leaveRequestDate.rejectReason,
    decidedAt:leaveRequestDate.decidedAt,
    decidedBy:person.fullName,
  }).from(leaveRequestDate)
    .leftJoin(employment,eq(employment.id,leaveRequestDate.decidedByEmploymentId))
    .leftJoin(person,eq(person.id,employment.personId))
    .where(eq(leaveRequestDate.leaveRequestId,requestId)).orderBy(leaveRequestDate.leaveDate));
}

it('reads the capped leave approval page with the same ordered dates and row access',async()=>{
  await resetDb();
  const base=await seedBase();
  const companies=await owner.client<{id:string}[]>`
    insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Fictional leave approval company '||n
    from generate_series(1,72) n returning id`;
  const companyIds=companies.map(company=>company.id);
  const rows=await owner.client<{id:string;company_id:string}[]>`
    with people as (
      insert into person (tenant_id,full_name,primary_email)
      select ${base.tenantId}::uuid,'Fictional leave approval subject '||n,'leave-approval-'||n||'@example.invalid'
      from generate_series(1,1152) n
      returning id
    ), employments as (
      insert into employment (tenant_id,person_id,company_id,hired_on)
      select ${base.tenantId}::uuid,p.id,c.id,'2024-01-01'::date
      from (select id,row_number() over(order by id) as n from people) p
      join unnest(${companyIds}::uuid[]) with ordinality c(id,n) on c.n=1+(p.n-1)%72
      returning id,company_id
    ), requests as (
      insert into leave_request (tenant_id,employment_id,leave_type_id,start_date,end_date,days)
      select ${base.tenantId}::uuid,id,${base.annualLeaveTypeId}::uuid,'2026-08-10','2026-08-11',2 from employments
      returning id,employment_id
    ), dates as (
      insert into leave_request_date (tenant_id,leave_request_id,subject_employment_id,leave_date,days)
      select ${base.tenantId}::uuid,id,employment_id,day,1 from requests
      cross join (values ('2026-08-11'::date),('2026-08-10'::date)) d(day)
    )
    select r.id,e.company_id from requests r join employments e on e.id=r.employment_id order by r.id`;
  expect(rows).toHaveLength(1152);
  expect(new Set(rows.map(row=>row.company_id))).toEqual(new Set(companyIds));
  const companyId=companyIds[0];
  const [user]=await owner.db.insert(appUser).values({
    tenantId:base.tenantId,workosUserId:'leave_date_scale_'+randomUUID(),
  }).returning({id:appUser.id});
  await owner.db.insert(roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role:'hr_admin',companyId});
  const group={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
  const company={...group,userId:user.id,grants:[{role:'hr_admin',companyId}]};
  const own=rows.filter(row=>row.company_id===companyId).map(row=>row.id);
  const all=[...own,...rows.filter(row=>row.company_id!==companyId).slice(0,184).map(row=>row.id)];
  expect(all).toHaveLength(200);

  for(const [label,actor,ids,visible] of [
    ['group-all',group,all,all],
    ['group-one-company',group,own,own],
    ['company-fenced',company,all,own],
  ] as const){
    const started=performance.now();
    const before=await Promise.all(ids.map(async id=>[id,await previousRead(actor,id)] as const));
    const previousMs=Math.round(performance.now()-started);
    const batchStarted=performance.now();
    const after=await leaveRequestDateBreakdowns(actor,ids);
    const batchMs=Math.round(performance.now()-batchStarted);
    expect(after).toEqual(new Map(before.filter(([,dates])=>dates.length>0)));
    expect([...after.keys()].sort()).toEqual([...visible].sort());
    for(const dates of after.values())expect(dates.map(date=>date.leaveDate)).toEqual(['2026-08-10','2026-08-11']);
    console.info('Leave approval date comparison',{label,requests:ids.length,visible:after.size,previousMs,batchMs});
  }
},90000);
