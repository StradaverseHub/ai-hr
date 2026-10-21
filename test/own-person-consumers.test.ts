/** Prepared real-principal regressions; execute only with both test slots and the DB lease.
 * General HR reads must succeed for the same populated subject refused by own-only APIs. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,eventTypesFor,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {employeeDetail,myEmployment,myEmployments,myOwnEmploymentSubjects,myEmploymentIdsAll,myPersonName} from '../core/read';
import {myProfile,myProfileChangeRequests,updateOwnContact} from '../core/profile';
import {readOwnProfileFacts} from '../core/profile-view';
import {readOwnProfileWorkspace} from '../core/profile-edit';
import {submitResignation,withdrawResignation,myResignation,listResignationRequests} from '../core/offboarding';
import {cancelOwnReplacementLeaveRequest} from '../core/replacement-request';
import {person,profileChangeRequest,replacementLeaveRequest,resignationRequest} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';

let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function worker(name:string,role:'hr_admin'|'employee'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx:SessionContext={...adminCtx(b),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]};
 return {...hired,ctx};
}
async function fixture(){
 const hr=await worker('Actual HR person','hr_admin'),other=await worker('Actual other person','employee');
 return {hr,other,forged:{...hr.ctx,personId:other.personId}};
}
describe('own-only consumer identity is independent of broad HR row visibility',()=>{
 it('refuses a substituted Person in own headers, salary inventory, Profile and workspace, while keeping general HR access',async()=>{
  const {hr,other,forged}=await fixture();
  await setCompensation(adminCtx(b),{employmentId:other.employmentId,basicSalary:4321,monthlyAllowance:17,effectiveFrom:'2024-01-01'});
  expect((await employeeDetail(hr.ctx,other.employmentId))?.employmentId).toBe(other.employmentId);
  expect((await myEmployment(other.ctx))?.employmentId).toBe(other.employmentId);
  expect((await myEmployments(other.ctx))[0]?.basic).toBe('4321.00');
  expect((await myProfile(hr.ctx))?.person?.fullName).toBe('Actual HR person');
  expect(await myPersonName(hr.ctx)).toBe('Actual HR person');
  expect((await myOwnEmploymentSubjects(hr.ctx)).map(row=>row.employmentId)).toContain(hr.employmentId);
  expect((await myEmploymentIdsAll(hr.ctx)).map(row=>row.employmentId)).toContain(hr.employmentId);
  expect(await myEmployment(forged)).toBeNull();expect(await myPersonName(forged)).toBeNull();
  expect(await myProfile(forged)).toBeNull();expect(await myEmployments(forged)).toEqual([]);
  expect(await myOwnEmploymentSubjects(forged)).toEqual([]);expect(await myEmploymentIdsAll(forged)).toEqual([]);
  await expect(readOwnProfileFacts(forged,other.employmentId)).rejects.toMatchObject({code:'permission'});
  await expect(readOwnProfileWorkspace(forged,{employmentId:other.employmentId})).rejects.toMatchObject({code:'permission'});
  expect((await readOwnProfileWorkspace(hr.ctx,{employmentId:hr.employmentId})).personId).toBe(hr.personId);
 });
 it('keeps populated own request history and direct-contact writes bound to the actual login',async()=>{
  const {hr,other,forged}=await fixture();
  const [request]=await owner.db.insert(profileChangeRequest).values({tenantId:b.tenantId,employmentId:other.employmentId,personId:other.personId,proposed:{fullName:'Fictional private proposal'}}).returning({id:profileChangeRequest.id});
  expect((await myProfileChangeRequests(other.ctx)).map(row=>row.id)).toContain(request.id);
  expect(await myProfileChangeRequests(forged)).toEqual([]);
  await updateOwnContact(hr.ctx,{phone:'0123456789'});
  expect((await myProfile(hr.ctx))?.person?.phone).toBe('0123456789');
  const before=await owner.db.select().from(person).where(eq(person.id,other.personId));
  await expect(updateOwnContact(forged,{phone:'0199999999'})).rejects.toMatchObject({code:'permission'});
  expect(await owner.db.select().from(person).where(eq(person.id,other.personId))).toEqual(before);
 });
 it('refuses forged resignation submission/read/withdrawal and a real HR Person paired with another employment',async()=>{
  const {hr,other,forged}=await fixture();
  const input={employmentId:other.employmentId,lastWorkingDay:todayInKualaLumpur(new Date(Date.now()+30*86400_000)),reason:'Fictional own request'};
  await expect(submitResignation(forged,input)).rejects.toThrow('not linked');
  await expect(submitResignation(hr.ctx,input)).rejects.toThrow('selected employee profile');
  expect(await owner.db.select().from(resignationRequest)).toEqual([]);
  const {requestId}=await submitResignation(other.ctx,input);
  expect((await listResignationRequests(hr.ctx)).map(row=>row.id)).toContain(requestId);
  expect((await myResignation(other.ctx,other.employmentId))?.id).toBe(requestId);
  expect(await myResignation(forged,other.employmentId)).toBeNull();
  expect(await myResignation(hr.ctx,other.employmentId)).toBeNull();
  const events=await eventTypesFor(b.tenantId,requestId);
  await expect(withdrawResignation(forged,{requestId})).rejects.toThrow('Only the employee');
  expect((await myResignation(other.ctx,other.employmentId))?.status).toBe('pending');
  expect(await eventTypesFor(b.tenantId,requestId)).toEqual(events);
  const withdrawals=await Promise.allSettled([withdrawResignation(other.ctx,{requestId}),withdrawResignation(other.ctx,{requestId})]);
  expect(withdrawals.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(withdrawals.filter(result=>result.status==='rejected')).toHaveLength(1);
  expect((await myResignation(other.ctx,other.employmentId))?.status).toBe('withdrawn');
  expect((await eventTypesFor(b.tenantId,requestId)).filter(type=>type==='resignation.withdrawn')).toHaveLength(1);
 });
 it('serializes concurrent own resignation submissions before the pending-request check',async()=>{
  const {other}=await fixture();
  const input={employmentId:other.employmentId,lastWorkingDay:todayInKualaLumpur(new Date(Date.now()+30*86400_000)),reason:'Fictional concurrent own request'};
  const results=await Promise.allSettled([submitResignation(other.ctx,input),submitResignation(other.ctx,input)]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  const rows=await owner.db.select({id:resignationRequest.id}).from(resignationRequest).where(eq(resignationRequest.employmentId,other.employmentId));
  expect(rows).toHaveLength(1);
  expect((await eventTypesFor(b.tenantId,rows[0].id)).filter(type=>type==='resignation.submitted')).toHaveLength(1);
 });
 it('refuses forged own-credit cancellation without changing the populated pending request or audit',async()=>{
  const {other,forged}=await fixture();
  const [request]=await owner.db.insert(replacementLeaveRequest).values({tenantId:b.tenantId,employmentId:other.employmentId,unit:'day',submittedOn:'2026-01-01',totalDays:'1'}).returning({id:replacementLeaveRequest.id});
  const events=await eventTypesFor(b.tenantId,request.id);
  await expect(cancelOwnReplacementLeaveRequest(forged,{requestId:request.id})).rejects.toThrow('not found');
  expect((await owner.db.select().from(replacementLeaveRequest).where(eq(replacementLeaveRequest.id,request.id)))[0]?.status).toBe('pending');
  expect(await eventTypesFor(b.tenantId,request.id)).toEqual(events);
  await cancelOwnReplacementLeaveRequest(other.ctx,{requestId:request.id});
  expect((await owner.db.select().from(replacementLeaveRequest).where(eq(replacementLeaveRequest.id,request.id)))[0]?.status).toBe('cancelled');
 });
});
