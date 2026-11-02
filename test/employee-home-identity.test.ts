import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
import {company,department,person,roleAssignment,reportingLine} from '../db/schema';
import {hireEmployee} from '../core/org';
import {HomeAccessError,ownHomeSubjectSelection,readEmployeeHomeIdentity,readEmployeeHomeGreetingIdentity,requireOwnHomeSubject} from '../core/employee-home';
import {todayInKualaLumpur} from '../lib/hr-date';

let b:Base;
beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{await closeAll();});
async function ownEmployee(){
 const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Full Name',primaryEmail:`home-id-${randomUUID()}@example.invalid`},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee']};
 return {employee,ctx};
}
describe('salary-free employee Home identity and selection',()=>{
 it('projects only selection/role context and reads recorded names separately with the greeting card',async()=>{
  const {employee,ctx}=await ownEmployee();
  await owner.db.update(person).set({preferredName:'Recorded preferred',firstName:'Recorded given'}).where(eq(person.id,employee.personId));
  const identity=await readEmployeeHomeIdentity(ctx);
  expect(identity).toMatchObject({version:1,role:'employee',employmentState:'selected',
   selectedEmploymentId:employee.employmentId,companyEstablished:true});
  expect(Object.keys(identity).sort()).toEqual(['companyEstablished','employmentState','employments','role','selectedEmploymentId','version']);
  expect(Object.keys(identity.employments[0]).sort()).toEqual(['company','employeeCode','employmentId']);
  const greeting=await readEmployeeHomeGreetingIdentity(ctx);
  expect(greeting).toEqual({version:1,employmentId:employee.employmentId,name:'Recorded preferred',photoHref:null});
  await owner.db.update(person).set({preferredName:null}).where(eq(person.id,employee.personId));
  expect((await readEmployeeHomeGreetingIdentity(ctx)).name).toBe('Recorded given');
  await owner.db.update(person).set({firstName:null}).where(eq(person.id,employee.personId));
  expect((await readEmployeeHomeGreetingIdentity(ctx)).name).toBe('Fictional Full Name');
 });
 it('requires an explicit choice between two own employments, preserving their identities rather than choosing a first row',async()=>{
  const {employee,ctx}=await ownEmployee();
  const [otherCompany]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional second employer'}).returning();
  const [otherDepartment]=await owner.db.insert(department).values({tenantId:b.tenantId,companyId:otherCompany.id,name:'Fictional second department'}).returning();
  const second=await hireEmployee(adminCtx(b),{person:{id:employee.personId},companyId:otherCompany.id,departmentId:otherDepartment.id,
   employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const identity=await readEmployeeHomeIdentity(ctx);
  expect(identity).toMatchObject({employmentState:'choose',selectedEmploymentId:null,companyEstablished:false});
  expect(new Set(identity.employments.map(row=>row.employmentId))).toEqual(new Set([employee.employmentId,second.employmentId]));
  await expect(requireOwnHomeSubject(ctx)).rejects.toMatchObject({code:'chooseEmployment'});
  await expect(readEmployeeHomeGreetingIdentity(ctx)).rejects.toMatchObject({code:'chooseEmployment'});
  expect((await readEmployeeHomeGreetingIdentity(ctx,second.employmentId)).employmentId).toBe(second.employmentId);
  expect((await requireOwnHomeSubject(ctx,second.employmentId)).employmentId).toBe(second.employmentId);
  expect((await readEmployeeHomeIdentity(ctx,employee.employmentId)).selectedEmploymentId).toBe(employee.employmentId);
 });
 it('recognizes an organizational manager without granting access to the report as an own Home subject',async()=>{
  const {employee,ctx}=await ownEmployee();
  const report=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional report',primaryEmail:`home-report-${randomUUID()}@example.invalid`},
   companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),reportingManagerEmploymentId:employee.employmentId});
  expect((await readEmployeeHomeIdentity(ctx)).role).toBe('manager');
  await expect(requireOwnHomeSubject(ctx,report.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
  const privileged:SessionContext={...ctx,userId:await createAppUser(b.tenantId,employee.personId,'hr_admin'),roles:['hr_admin']};
  await expect(requireOwnHomeSubject(privileged,report.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
  await expect(readEmployeeHomeGreetingIdentity(privileged,report.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
  const foreign=await seedBase();
  const foreignEmployee=await hireEmployee(adminCtx(foreign),{person:{fullName:'Fictional foreign',primaryEmail:`home-foreign-${randomUUID()}@example.invalid`},
   companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  for(const id of [foreignEmployee.employmentId,randomUUID(),''])
   await expect(readEmployeeHomeIdentity(ctx,id)).rejects.toMatchObject({code:'employmentUnavailable'});
  for(const id of [report.employmentId,foreignEmployee.employmentId,randomUUID(),''])
   await expect(readEmployeeHomeGreetingIdentity(ctx,id)).rejects.toMatchObject({code:'employmentUnavailable'});
 });
 it('keeps an unreadable future reporting edge out of the Manager role and observes its later activation and revocation',async()=>{
  const {employee,ctx}=await ownEmployee(),on=todayInKualaLumpur();
  await hireEmployee(adminCtx(b),{person:{fullName:'Fictional future report',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,
   departmentId:b.deptA,employmentType:'full_time',hiredOn:on,reportingManagerEmploymentId:employee.employmentId});
  expect((await readEmployeeHomeIdentity(ctx)).role).toBe('manager');
  const tomorrow=new Date(Date.parse(on+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  await owner.db.update(reportingLine).set({validFrom:tomorrow}).where(eq(reportingLine.managerEmploymentId,employee.employmentId));
  expect((await readEmployeeHomeIdentity(ctx)).role).toBe('employee');
  await owner.db.update(reportingLine).set({validFrom:on}).where(eq(reportingLine.managerEmploymentId,employee.employmentId));
  expect((await readEmployeeHomeIdentity(ctx)).role).toBe('manager');
  await owner.db.update(reportingLine).set({supersededAt:new Date()}).where(eq(reportingLine.managerEmploymentId,employee.employmentId));
  expect((await readEmployeeHomeIdentity(ctx)).role).toBe('employee');
 });
 it('does not apply a flattened manager role to a second company outside its actual grant',async()=>{
  const {employee,ctx}=await ownEmployee();
  const [secondCompany]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional scoped Home company'}).returning();
  const [secondDepartment]=await owner.db.insert(department).values({tenantId:b.tenantId,companyId:secondCompany.id,name:'Fictional second department'}).returning();
  const second=await hireEmployee(adminCtx(b),{person:{id:employee.personId},companyId:secondCompany.id,departmentId:secondDepartment.id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:ctx.userId!,role:'manager',companyId:b.companyId});
  const manager:SessionContext={...ctx,roles:['employee','manager'],grants:[{role:'employee',companyId:null},{role:'manager',companyId:b.companyId}]};
  expect((await readEmployeeHomeIdentity(manager,employee.employmentId)).role).toBe('manager');
  expect((await readEmployeeHomeIdentity(manager,second.employmentId)).role).toBe('employee');
 });
 it('keeps no-employment and unauthenticated states distinct',async()=>{
  const {ctx}=await ownEmployee();
  const noPerson={...ctx,personId:null};
  expect(await ownHomeSubjectSelection(noPerson)).toMatchObject({state:'none',subjects:[],subject:null});
  expect(await readEmployeeHomeIdentity(noPerson)).toMatchObject({employmentState:'none',selectedEmploymentId:null,employments:[]});
  await expect(readEmployeeHomeGreetingIdentity(noPerson)).rejects.toMatchObject({code:'employmentUnavailable'});
  await expect(requireOwnHomeSubject(noPerson)).rejects.toMatchObject({code:'employmentUnavailable'});
  await expect(readEmployeeHomeIdentity({...ctx,userId:undefined})).rejects.toBeInstanceOf(HomeAccessError);
 });
});
