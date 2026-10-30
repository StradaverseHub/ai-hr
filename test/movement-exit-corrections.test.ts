import {randomUUID} from 'node:crypto';
import {asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {assignment,domainEvent,employment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createMovementEvent,editMovementEvent,movementCurrentState,movementHistory,reverseMovementEvent} from '../core/movement';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const hire=()=>hireEmployee(adminCtx(b),{person:{fullName:'Fictional exit correction',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-90)});
const snapshot=async(id:string)=>({employment:await owner.db.select().from(employment).where(eq(employment.id,id)).orderBy(asc(employment.id)),assignments:await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence))});
const exit=async(id:string)=>{await createMovementEvent(adminCtx(b),{employmentId:id,kind:'termination',effectiveDate:day(-3),endDate:day(-3),terminationReasonCode:'resignation',resignationDate:day(-10)});return (await movementHistory(adminCtx(b),id)).find(row=>row.kind==='resignation')!;};
describe('646355e5 revision 2 — correction of exited employees and wrong event types',()=>{
 it('undoes the CHCE0067 shape: applied voluntary termination tagged as termination, without deleting history',async()=>{
  const e=await hire(),ctx=adminCtx(b),row=await exit(e.employmentId);
  expect(row).toMatchObject({status:'applied',canEdit:true,canReverse:true});
  expect((await snapshot(e.employmentId)).employment[0].terminatedOn).toBe(day(-3));
  await reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,reason:'Fictional exit entered by mistake'});
  expect((await snapshot(e.employmentId)).employment[0].terminatedOn).toBeNull();
  expect((await movementHistory(ctx,e.employmentId)).find(r=>r.id===row.id)?.status).toBe('reversed');
  expect((await movementCurrentState(ctx,e.employmentId)).departmentId).toBe(b.deptA);
 });
 it('replaces a mistaken applied exit with a transfer through the canonical dispatcher and links the audit',async()=>{
  const e=await hire(),ctx=adminCtx(b),row=await exit(e.employmentId);
  await editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind:'transfer',effectiveDate:day(-3),departmentId:b.deptB,reason:'Fictional event type correction'});
  const history=await movementHistory(ctx,e.employmentId);
  expect(history.find(r=>r.id===row.id)?.status).toBe('reversed');
  const replacement=history.find(r=>r.kind==='transfer'&&r.status==='applied');expect(replacement).toBeDefined();
  expect((await snapshot(e.employmentId)).employment[0].terminatedOn).toBeNull();
  expect((await movementCurrentState(ctx,e.employmentId)).departmentId).toBe(b.deptB);
  const events=(await snapshot(e.employmentId)).events;
  expect(events.find(e=>e.eventType==='employment.movement.corrected')?.payload).toMatchObject({movementId:row.id,replacementMovementId:replacement!.id,fromType:'termination',toType:'transfer'});
 });
 it('a record-only event changed to a termination executes the exit instead of merely relabelling the history',async()=>{
  const e=await hire(),ctx=adminCtx(b);
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:'secondment',effectiveDate:day(-2)});
  const row=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind==='secondment')!;
  await editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind:'termination',effectiveDate:day(-2),endDate:day(-2),terminationReasonCode:'resignation',resignationDate:day(-10),reason:'Fictional replacement exit'});
  expect((await snapshot(e.employmentId)).employment[0].terminatedOn).toBe(day(-2));
  expect((await movementHistory(ctx,e.employmentId)).filter(r=>r.kind==='resignation'&&r.status==='applied')).toHaveLength(1);
 });
 it('rolls the exit inverse and every ledger write back if the replacement is invalid',async()=>{
  const e=await hire(),ctx=adminCtx(b),row=await exit(e.employmentId),before=await snapshot(e.employmentId);
  await expect(editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind:'entityTransfer',effectiveDate:day(-3),reason:'Fictional missing destination'})).rejects.toThrow(/company/i);
  expect(await snapshot(e.employmentId)).toEqual(before);
 });
 it('rejects foreign scope and missing reasons without changing the exited employee',async()=>{
  const e=await hire(),ctx=adminCtx(b),row=await exit(e.employmentId),before=await snapshot(e.employmentId),foreign=await seedBase();
  await expect(editMovementEvent(adminCtx(foreign),{employmentId:e.employmentId,movementId:row.id,kind:'transfer',effectiveDate:day(-3),departmentId:b.deptB,reason:'Fictional foreign correction'})).rejects.toThrow();
  await expect(editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind:'transfer',effectiveDate:day(-3),departmentId:b.deptB,reason:' '})).rejects.toThrow(/reason/i);
  expect(await snapshot(e.employmentId)).toEqual(before);
 });
});
