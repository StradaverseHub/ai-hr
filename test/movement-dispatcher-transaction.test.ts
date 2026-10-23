import {WorkforceAccessError} from '../core/workforce-access';
/** Movement imports must compose the actual New Event dispatcher, never separately committed legs. */
import {randomUUID} from 'node:crypto';
import {asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {assignment,domainEvent,employment,leaveLedger,leaveEntitlementRecalcAudit} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createJobGrade} from '../core/admin';
import {createMovementEvent,createMovementEventTx,movementCurrentStateTx,movementHistory} from '../core/movement';
import {movementNeedsEntitlementReprojection} from '../core/movement-kinds';
import {saveMovementEventType,setMovementEventTypeActive} from '../core/movement-type';
import {reprojectEntitlementForEmployment} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,type Base} from './harness';
let base:Base;
const dateOffset=(days:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();});afterAll(closeAll);
async function employee(){return hireEmployee(adminCtx(base),{person:{fullName:'Fictional Movement transaction',primaryEmail:`movement-tx-${randomUUID()}@example.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:dateOffset(-30)});}
async function rows(id:string){return {
 employment:await owner.db.select().from(employment).where(eq(employment.id,id)).orderBy(asc(employment.id)),
 assignments:await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),
 events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence)),
};}
describe('canonical Movement dispatcher caller transaction',()=>{
 it('rolls back scheduled comparison, lifecycle and their audit rows with the caller transaction',async()=>{
  const e=await employee(),ctx=adminCtx(base),before=await rows(e.employmentId);
  await expect(withTenant(ctx,async tx=>{
   await createMovementEventTx(tx,ctx,{employmentId:e.employmentId,kind:'transfer',effectiveDate:dateOffset(7),departmentId:base.deptB});
   await createMovementEventTx(tx,ctx,{employmentId:e.employmentId,kind:'blacklist',effectiveDate:todayInKualaLumpur(),blacklisted:true,remarks:'Fictional transaction only'});
   const [inside]=await tx.select({blacklistedAt:employment.blacklistedAt}).from(employment).where(eq(employment.id,e.employmentId));expect(inside.blacklistedAt).not.toBeNull();
   expect((await tx.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,e.employmentId))).some(row=>row.eventType==='employment.movement.scheduled')).toBe(true);
   throw new Error('Fictional later row failure');
  })).rejects.toThrow('Fictional later row failure');
  expect(await rows(e.employmentId)).toEqual(before);
 });
 it('sees an earlier real write through the same canonical current-state reader and commits one ordered sequence',async()=>{
  const e=await employee(),ctx=adminCtx(base);
  await withTenant(ctx,async tx=>{
   await createMovementEventTx(tx,ctx,{employmentId:e.employmentId,kind:'transfer',effectiveDate:dateOffset(-2),departmentId:base.deptB});
   expect((await movementCurrentStateTx(tx,e.employmentId)).departmentId).toBe(base.deptB);
   await createMovementEventTx(tx,ctx,{employmentId:e.employmentId,kind:'secondment',effectiveDate:dateOffset(-1),remarks:'Fictional recorded assignment'});
  });
  const result=await rows(e.employmentId);expect(result.assignments.filter(row=>row.validTo===null)).toMatchObject([{departmentId:base.deptB}]);
  const history=await movementHistory(ctx,e.employmentId);expect(history.filter(row=>row.kind==='transfer')).toHaveLength(1);expect(history.filter(row=>row.kind==='secondment')).toHaveLength(1);
 });
 it('uses the live tenant type code in both manual and caller-owned dispatch and refuses a switched-off type',async()=>{
  const e=await employee(),ctx=adminCtx(base),type=await saveMovementEventType(ctx,{label:'Fictional field placement',behaviourKind:'secondment'});
  await withTenant(ctx,tx=>createMovementEventTx(tx,ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:dateOffset(-2)}));
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:dateOffset(-1)});
  const before=await rows(e.employmentId),recorded=before.events.filter(row=>row.eventType==='employment.movement.recorded');expect(recorded).toHaveLength(2);for(const row of recorded)expect(row.payload).toMatchObject({type:type.code});
  await setMovementEventTypeActive(ctx,{code:type.code,active:false});
  await expect(withTenant(ctx,tx=>createMovementEventTx(tx,ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:todayInKualaLumpur()}))).rejects.toThrow('switched off');
  expect(await rows(e.employmentId)).toEqual(before);
 });
 it('retains the administrator gate before any dispatcher write',async()=>{
  const e=await employee(),ctx={...adminCtx(base),roles:['employee']},before=await rows(e.employmentId);
  await expect(withTenant(ctx,tx=>createMovementEventTx(tx,ctx,{employmentId:e.employmentId,kind:'blacklist',effectiveDate:todayInKualaLumpur()}))).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await rows(e.employmentId)).toEqual(before);
 });
 it('resolves a custom promotion for the entitlement trigger and rolls its real leave adjustment/audit back with a later failure',async()=>{
  const ctx=adminCtx(base),year=todayInKualaLumpur().slice(0,4),grade=await createJobGrade(ctx,{code:'B20H',name:'Fictional higher entitlement'});
  await seedEntitlement(ctx,{leaveTypeId:base.annualLeaveTypeId,annualDays:8,validFrom:`${year}-01-01`,name:'Fictional baseline entitlement'});
  await seedEntitlement(ctx,{leaveTypeId:base.annualLeaveTypeId,annualDays:16,gradeId:grade.id,validFrom:`${year}-01-01`,name:'Fictional grade entitlement'});
  const e=await hireEmployee(ctx,{person:{fullName:'Fictional atomic entitlement',primaryEmail:`movement-leave-${randomUUID()}@example.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${year}-01-01`,grantLeaveTypes:[{id:base.annualLeaveTypeId,code:'ANNUAL'}]});
  const type=await saveMovementEventType(ctx,{label:'Fictional advancement',behaviourKind:'promotion'}),before=await rows(e.employmentId);
  const ledger=()=>owner.db.select().from(leaveLedger).where(eq(leaveLedger.employmentId,e.employmentId)).orderBy(asc(leaveLedger.id));
  const audit=()=>owner.db.select().from(leaveEntitlementRecalcAudit).where(eq(leaveEntitlementRecalcAudit.employmentId,e.employmentId)).orderBy(asc(leaveEntitlementRecalcAudit.id));
  const beforeLedger=await ledger(),beforeAudit=await audit();expect(beforeLedger.reduce((sum,row)=>sum+Number(row.days),0)).toBe(8);
  await expect(withTenant(ctx,async tx=>{
   const gradeBefore={gradeId:(await movementCurrentStateTx(tx,e.employmentId)).gradeId};
   const result=await createMovementEventTx(tx,ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:todayInKualaLumpur(),gradeId:grade.id});
   expect(result.behaviourKind).toBe('promotion');expect(movementNeedsEntitlementReprojection(result.behaviourKind)).toBe(true);
   expect(movementNeedsEntitlementReprojection(type.code)).toBe(false); // The old raw-code action would skip this real effect.
   const recalc=await reprojectEntitlementForEmployment(ctx,{employmentId:e.employmentId,trigger:'movement_recorded',gradeBefore,changeEffectiveOn:todayInKualaLumpur()},tx);
   expect(recalc).toEqual({affected:1,totalDelta:8});
   expect(await tx.select().from(leaveEntitlementRecalcAudit).where(eq(leaveEntitlementRecalcAudit.employmentId,e.employmentId))).toHaveLength(beforeAudit.length+1);
   throw new Error('Fictional later selected event failure');
  })).rejects.toThrow('Fictional later selected event failure');
  expect(await rows(e.employmentId)).toEqual(before);expect(await ledger()).toEqual(beforeLedger);expect(await audit()).toEqual(beforeAudit);
 });
});
