import {randomUUID} from 'node:crypto';
import {asc, eq} from 'drizzle-orm';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {withTenant} from '../db/client';
import {assignment, compensation, domainEvent, employment, payPeriod, payrollBatch, payslip, reportingLine, roleAssignment} from '../db/schema';
import {hireEmployee, setReportingLine} from '../core/org';
import {setCompensation} from '../core/comp';
import {applyDueMovementsTx, createMovementEvent, editMovementEvent, movementCurrentState, movementDetail, movementHistory, reverseMovementEvent} from '../core/movement';
import {saveMovementEventType} from '../core/movement-type';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(closeAll);
const day=(n:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
async function hire(hiredOn=day(-90)){
 return (await hireEmployee(adminCtx(b),{person:{fullName:'Fictional exit subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn})).employmentId;
}
async function snapshot(id:string){return {
 employment:await owner.db.select().from(employment).where(eq(employment.id,id)),
 assignment:await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),
 reporting:await owner.db.select().from(reportingLine).where(eq(reportingLine.subordinateEmploymentId,id)).orderBy(asc(reportingLine.id)),
 compensation:await owner.db.select().from(compensation).where(eq(compensation.employmentId,id)).orderBy(asc(compensation.id)),
 events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence)),
};}
async function terminate(id:string,date=day(-3),kind='termination',reason='redundancy'){
 await createMovementEvent(adminCtx(b),{employmentId:id,kind,effectiveDate:date,endDate:date,terminationReasonCode:reason,...(reason==='resignation'?{resignationDate:day(-10)}:{})});
 return (await movementHistory(adminCtx(b),id)).find(row=>row.recordedExit?.terminationReasonCode.value===reason)!;
}
describe('retained exit organisation history',()=>{
 it.each(['redundancy','resignation'])('retains department, position and manager for %s without reopening employment or rewriting history',async reason=>{
  const id=await hire(),manager=await hire();
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:id,managerEmploymentId:manager,lineType:'administrative',validFrom:day(-90)});
  const hireRow=(await movementHistory(adminCtx(b),id)).find(row=>row.kind==='hired')!;
  const hireBefore=await movementDetail(adminCtx(b),id,hireRow.id);
  const row=await terminate(id,day(-3),'termination',reason),before=await snapshot(id);
  expect(row).toMatchObject({department:'Finance',jobTitle:'Executive',status:'applied'});
  const detail=await movementDetail(adminCtx(b),id,row.id);
  const expected={company:'Acme Sdn Bhd',department:'Finance',position:'Executive',employmentType:'full_time',manager:'Fictional exit subject'};
  expect(detail?.before).toMatchObject(expected);expect(detail?.after).toMatchObject(expected);
  expect(detail?.exitInformation).toEqual({effectiveDate:day(-3)});
  expect((await movementDetail(adminCtx(b),id,hireRow.id))?.after).toEqual(hireBefore?.after);
  expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBeNull();
  expect(await snapshot(id)).toEqual(before);
 });
 it('uses custom Termination behavior and does not treat blank exit inputs as clearing the saved assignment',async()=>{
  const id=await hire(),type=await saveMovementEventType(adminCtx(b),{label:'Fictional custom exit',behaviourKind:'termination'});
  const row=await terminate(id,day(-3),type.code);
  expect(row.kind).toBe(type.code);
  expect((await movementDetail(adminCtx(b),id,row.id))?.after).toMatchObject({department:'Finance',position:'Executive'});
 });
 it('shows same-day hire/exit from retained evidence and same-day transfer as the state immediately preceding exit',async()=>{
  const id=await hire(day(-3));
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'transfer',effectiveDate:day(-3),departmentId:b.deptB});
  const row=await terminate(id),detail=await movementDetail(adminCtx(b),id,row.id);
  expect(detail?.before).toMatchObject({department:'Operations',position:'Executive'});
  expect(detail?.after).toMatchObject({department:'Operations',position:'Executive'});
  expect(row).toMatchObject({department:'Operations',jobTitle:'Executive'});
 });
 it('keeps future exits as pending intent until the sweep applies and then retains the closing assignment',async()=>{
  const id=await hire(),row=await terminate(id,day(7));
  expect(row.status).toBe('pending');
  expect((await movementDetail(adminCtx(b),id,row.id))?.exitInformation).toBeUndefined();
  expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBe(b.deptA);
  await withTenant(adminCtx(b),tx=>applyDueMovementsTx(tx,adminCtx(b),id,day(7)));
  const detail=await movementDetail(adminCtx(b),id,row.id);
  expect(detail?.row.status).toBe('applied');expect(detail?.after.department).toBe('Finance');
  expect(detail?.exitInformation?.effectiveDate).toBe(day(7));
 });
 it('preserves exit information across an audited earlier transfer correction and exit rollback',async()=>{
  const id=await hire();
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'transfer',effectiveDate:day(-15),departmentId:b.deptB});
  const transfer=(await movementHistory(adminCtx(b),id)).find(row=>row.kind==='transfer')!;
  await terminate(id);
  await editMovementEvent(adminCtx(b),{employmentId:id,movementId:transfer.id,kind:'transfer',effectiveDate:day(-16),departmentId:b.deptB,reason:'Correct fictional transfer day'});
  const exit=(await movementHistory(adminCtx(b),id)).find(row=>row.kind==='termination'&&row.status==='applied')!;
  expect((await movementDetail(adminCtx(b),id,exit.id))?.after.department).toBe('Operations');
  await reverseMovementEvent(adminCtx(b),{employmentId:id,movementId:exit.id,reason:'Withdraw fictional exit'});
  expect((await movementHistory(adminCtx(b),id)).find(row=>row.id===exit.id)?.status).toBe('reversed');
  expect((await movementCurrentState(adminCtx(b),id)).departmentId).toBe(b.deptB);
 });
 it('refuses a foreign tenant and leaves closed payroll and statutory snapshots byte-for-byte unchanged during history reads',async()=>{
  const id=await hire();await setCompensation(adminCtx(b),{employmentId:id,basicSalary:3000,effectiveFrom:day(-90)});
  const row=await terminate(id),period=day(-60).slice(0,7);
  const [p]=await owner.db.insert(payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'closed'}).returning();
  const [batch]=await owner.db.insert(payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:p.id,payPeriod:period,batchDate:period+'-25',status:'closed'}).returning();
  const [slip]=await owner.db.insert(payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',statutory:{fixture:'retained'},totalDeductions:'0.00',netPay:'3000.00',employerCost:'3000.00'}).returning();
  await movementDetail(adminCtx(b),id,row.id);await movementHistory(adminCtx(b),id);
  expect(await owner.db.select().from(payslip).where(eq(payslip.id,slip.id))).toEqual([slip]);
  expect(await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id,batch.id))).toEqual([batch]);
  const foreign=await seedBase();await expect(movementDetail(adminCtx(foreign),id,row.id)).rejects.toThrow();
 });
 it('retains ordered history with 70 companies and over 1000 employments under group and company authority',async()=>{
  const id=await hire(),row=await terminate(id),before=await snapshot(id);
  await owner.client`insert into company(tenant_id,legal_name,company_label)
    select ${b.tenantId}::uuid,'Fictional exit shape '||n,'EXSH'||n from generate_series(1,69) n`;
  await owner.client`insert into department(tenant_id,company_id,name)
    select ${b.tenantId}::uuid,c.id,'Shape department' from company c
    where c.tenant_id=${b.tenantId}::uuid and c.company_label like 'EXSH%'`;
  await owner.client`insert into person(tenant_id,full_name,primary_email)
    select ${b.tenantId}::uuid,'Fictional noise '||n,'exit-shape-'||n||'@example.invalid' from generate_series(1,1000) n`;
  await owner.client`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
    with companies as (select id,row_number() over(order by company_label,id) as n from company where tenant_id=${b.tenantId}::uuid and company_label like 'EXSH%'),
    people as (select id,row_number() over(order by full_name,id) as n from person where tenant_id=${b.tenantId}::uuid and primary_email like 'exit-shape-%')
    select ${b.tenantId}::uuid,p.id,c.id,'EXNOISE'||p.n,${day(-90)}::date from people p join companies c on c.n=1+(p.n-1)%69`;
  await owner.client`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
    select ${b.tenantId}::uuid,e.id,e.company_id,d.id,'full_time',${day(-90)}::date from employment e
    join department d on d.company_id=e.company_id and d.name='Shape department'
    where e.tenant_id=${b.tenantId}::uuid and e.employee_code like 'EXNOISE%'`;
  const [shape]=await owner.client<{companies:number;employments:number}[]>`select
    (select count(*)::integer from company where tenant_id=${b.tenantId}::uuid) as companies,
    (select count(*)::integer from employment where tenant_id=${b.tenantId}::uuid) as employments`;
  expect(shape.companies).toBe(70);expect(shape.employments).toBeGreaterThanOrEqual(1000);
  const groupHistory=await movementHistory(adminCtx(b),id);
  expect(groupHistory.map(value=>[value.kind,value.department,value.jobTitle])).toEqual([['hired','Finance','Executive'],['termination','Finance','Executive']]);
  const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');
  await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,scopedUser));
  const scoped={...adminCtx(b),userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
  expect((await movementHistory(scoped,id)).map(value=>[value.id,value.kind,value.department,value.jobTitle])).toEqual(groupHistory.map(value=>[value.id,value.kind,value.department,value.jobTitle]));
  expect((await movementDetail(scoped,id,row.id))?.after).toMatchObject({department:'Finance',position:'Executive'});
  expect(await snapshot(id)).toEqual(before);
  const [other]=await owner.client<{id:string}[]>`select id from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'EXNOISE%' order by employee_code,id limit 1`;
  await expect(movementHistory(scoped,other.id)).rejects.toThrow();
 },90000); // Includes the 70-company/1000-employment fixture and two separately authorized history reads.

});
