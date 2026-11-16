import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createMovementEvent,editMovementEvent,movementHistory,reverseMovementEvent,reverseMovementForImportTx} from '../core/movement';
import {movementDeleteAccess} from '../core/movement-delete-access';
import {WorkforceAccessError} from '../core/workforce-access';

let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(closeAll);
async function subject(){
 const ctx=adminCtx(b);
 const {employmentId}=await hireEmployee(ctx,{person:{fullName:'Fictional Movement Delete',primaryEmail:'delete@example.test'},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2026-01-01'});
 await createMovementEvent(ctx,{employmentId,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB});
 const row=(await movementHistory(ctx,employmentId)).find(row=>row.kind==='transfer')!;
 return {ctx,employmentId,row};
}
describe('separate Movement Delete permission',()=>{
 it('denies manual and import deletion under a fresh explicit deny while allowing Edit',async()=>{
  const {ctx,employmentId,row}=await subject();
  expect(await movementDeleteAccess(ctx,employmentId)).toBe(true);
  await owner.db.insert(s.accessUserOverride).values({tenantId:b.tenantId,userId:b.adminUserId,capabilityId:'workforce.movement.delete',companyId:b.companyId,effect:'deny'});
  expect(await movementDeleteAccess(ctx,employmentId)).toBe(false);
  const input={employmentId,movementId:row.id,reason:'Fictional correction'};
  await expect(reverseMovementEvent(ctx,{...input,acknowledgeClosedPayroll:true})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(withTenant(ctx,tx=>reverseMovementForImportTx(tx,ctx,employmentId,row.id,input.reason))).rejects.toBeInstanceOf(WorkforceAccessError);
  expect((await movementHistory(ctx,employmentId)).find(event=>event.id===row.id)?.status).toBe('applied');
  await editMovementEvent(ctx,{...input,kind:'transfer',effectiveDate:'2026-02-02',departmentId:b.deptB});
  expect((await movementHistory(ctx,employmentId)).find(event=>event.id===row.id)?.status).toBe('reversed');
 });
 it('allows an authorized delete and retains the original event plus its reason',async()=>{
  const {ctx,employmentId,row}=await subject();
  const before=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,row.id));
  await reverseMovementEvent(ctx,{employmentId,movementId:row.id,reason:'Fictional event entered in error'});
  expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,row.id))).toEqual(before);
  const [reversal]=await owner.db.select({payload:s.domainEvent.payload}).from(s.domainEvent).where(and(eq(s.domainEvent.subjectEmploymentId,employmentId),eq(s.domainEvent.eventType,'employment.movement.reversed')));
  expect(reversal.payload).toMatchObject({movementId:row.id,reason:'Fictional event entered in error',corrected:false});
 });
 it('does not let a grant for another company or a forged role escape tenant scope',async()=>{
  const {ctx,employmentId,row}=await subject(),other=await seedBase();
  const forged={...adminCtx(other),roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]};
  expect(await movementDeleteAccess(forged,employmentId)).toBe(false);
  await expect(reverseMovementEvent(forged,{employmentId,movementId:row.id,reason:'Fictional forbidden delete'})).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await movementDeleteAccess(ctx,employmentId)).toBe(true);
 });
 it('locks payroll inputs for historical assignment and issued-payroll companies in one resolver',async()=>{
  const {ctx,employmentId}=await subject();
  const [former]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Former Employer',registrationNo:'FAKE-FORMER'}).returning();
  await owner.db.update(s.assignment).set({companyId:former.id,departmentId:null,positionId:null,businessUnitId:null,costCenterId:null,locationId:null}).where(and(eq(s.assignment.employmentId,employmentId),eq(s.assignment.validFrom,'2026-01-01')));
  const rows=await withTenant(ctx,tx=>tx.execute<{key:string}>(sql`select k as key from app.payroll_input_lock_keys(array[${employmentId}::uuid],null) k`));
  expect(rows.map(row=>row.key).sort()).toEqual([b.companyId,former.id].map(companyId=>'payroll-inputs:'+b.tenantId+':'+companyId).sort());
 });
});
