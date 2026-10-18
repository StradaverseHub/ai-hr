import {randomUUID} from 'node:crypto';
import {asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {assignment,domainEvent,employment} from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {applyDueMovementsTx,createMovementEvent,MovementNoChangeError,movementCurrentState,rehearseMovementSequenceTx,type CreateMovementInput,type MovementSequenceCreate} from '../core/movement';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const hire=()=>hireEmployee(adminCtx(b),{person:{fullName:'Fictional sequence admission',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-60)});
async function snapshot(id:string){return {
 employment:await owner.db.select().from(employment).where(eq(employment.id,id)).orderBy(asc(employment.id)),
 assignment:await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),
 events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence)),
};}
describe('canonical future sequence admission lifetime',()=>{
 it('admits a verified return to today’s department while manual future no-op remains refused',async()=>{
  const {employmentId}=await hire(),ctx=adminCtx(b),first:CreateMovementInput={employmentId,kind:'transfer',effectiveDate:day(7),departmentId:b.deptB},second:CreateMovementInput={employmentId,kind:'transfer',effectiveDate:day(14),departmentId:b.deptA};
  await expect(createMovementEvent(ctx,second)).rejects.toBeInstanceOf(MovementNoChangeError);
  const before=await snapshot(employmentId);
  await withTenant(ctx,async tx=>{
   const prepared=await rehearseMovementSequenceTx(tx,ctx,async(shadow,create)=>{
    await create(first);expect(await applyDueMovementsTx(shadow,ctx,employmentId,day(7))).toMatchObject({applied:1});
    await create(second);expect(await applyDueMovementsTx(shadow,ctx,employmentId,day(14))).toMatchObject({applied:1});return 'verified';
   });
   expect(prepared.value).toBe('verified');
   const [live]=await tx.select({departmentId:assignment.departmentId}).from(assignment).where(eq(assignment.employmentId,employmentId)).orderBy(asc(assignment.validFrom));expect(live.departmentId).toBe(b.deptA);
   expect(await prepared.replay(first)).toMatchObject({scheduled:true});expect(await prepared.replay(second)).toMatchObject({scheduled:true});
   await expect(prepared.replay(second)).rejects.toThrow('movement_sequence_not_available');
  });
  const after=await snapshot(employmentId);expect(after.employment).toEqual(before.employment);expect(after.assignment).toEqual(before.assignment);expect(after.events.filter(row=>row.eventType==='employment.movement.scheduled')).toHaveLength(2);
  expect((await movementCurrentState(ctx,employmentId)).departmentId).toBe(b.deptA);
  await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,employmentId,day(7)));expect((await movementCurrentState(ctx,employmentId)).departmentId).toBe(b.deptB);
  await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,employmentId,day(14)));expect((await movementCurrentState(ctx,employmentId)).departmentId).toBe(b.deptA);
 });
 it('requires exact frozen ordered inputs and rolls the entire outer write back on replay mismatch',async()=>{
  const {employmentId}=await hire(),ctx=adminCtx(b),before=await snapshot(employmentId),first:CreateMovementInput={employmentId,kind:'secondment',effectiveDate:day(-2),remarks:'Original first'},second:CreateMovementInput={employmentId,kind:'actingPosition',effectiveDate:day(-1),remarks:'Original second'};
  await expect(withTenant(ctx,async tx=>{
   const prepared=await rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{await create(first);await create(second);});
   await prepared.replay(first);await prepared.replay({...second,remarks:'Tampered after rehearsal'});
  })).rejects.toThrow('movement_sequence_input_changed');expect(await snapshot(employmentId)).toEqual(before);
  await expect(withTenant(ctx,async tx=>{const prepared=await rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{await create(first);await create(second);});await prepared.replay(second);})).rejects.toThrow('movement_sequence_input_changed');
  expect(await snapshot(employmentId)).toEqual(before);
 });
 it('does not return a replay from failed rehearsal, even when its create refusal was swallowed',async()=>{
  const {employmentId}=await hire(),ctx=adminCtx(b),before=await snapshot(employmentId),valid:CreateMovementInput={employmentId,kind:'secondment',effectiveDate:day(-2)};let escaped:MovementSequenceCreate|undefined;
  await expect(withTenant(ctx,tx=>rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{escaped=create;await create(valid);try{await create({...valid,kind:'unknown_fixture_type'});}catch{/* The owner still poisons this rehearsal. */}}))).rejects.toThrow('movement_sequence_rehearsal_failed');
  expect(escaped).toBeDefined();await expect(escaped!(valid)).rejects.toThrow('movement_sequence_not_available');expect(await snapshot(employmentId)).toEqual(before);
  await expect(withTenant(ctx,tx=>rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{await create(valid);throw new Error('Fictional required side-effect failure');}))).rejects.toThrow('Fictional required side-effect failure');expect(await snapshot(employmentId)).toEqual(before);
 });
 it('refuses multiple subjects, reverse date order and more than twenty creates without retaining rehearsal writes',async()=>{
  const first=await hire(),second=await hire(),ctx=adminCtx(b),before=await snapshot(first.employmentId),input:CreateMovementInput={employmentId:first.employmentId,kind:'secondment',effectiveDate:day(-2)};
  await expect(withTenant(ctx,tx=>rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{await create(input);await create({...input,employmentId:second.employmentId});}))).rejects.toThrow('movement_sequence_employee_changed');
  await expect(withTenant(ctx,tx=>rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{await create(input);await create({...input,effectiveDate:day(-3)});}))).rejects.toThrow('movement_sequence_order_changed');
  await expect(withTenant(ctx,tx=>rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{for(let index=0;index<21;index++)await create({...input,remarks:String(index)});}))).rejects.toThrow('too_many_employee_rows');expect(await snapshot(first.employmentId)).toEqual(before);
 });
 it('copies its original scalar input and refuses replay after the owning transaction has ended',async()=>{
  const {employmentId}=await hire(),ctx=adminCtx(b),input:CreateMovementInput={employmentId,kind:'secondment',effectiveDate:day(-2),remarks:'Frozen remarks'};
  await withTenant(ctx,async tx=>{const prepared=await rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{await create(input);});input.remarks='Mutated outside owner';await prepared.replay({...input,remarks:'Frozen remarks'});});
  const recorded=(await snapshot(employmentId)).events.filter(row=>row.eventType==='employment.movement.recorded');expect(recorded).toHaveLength(1);expect(recorded[0].payload).toMatchObject({remarks:'Frozen remarks'});
  const before=await snapshot(employmentId);let expired:MovementSequenceCreate|undefined;
  await withTenant(ctx,async tx=>{expired=(await rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{await create(input);})).replay;});
  expect(expired).toBeDefined();await expect(expired!(input)).rejects.toThrow();expect(await snapshot(employmentId)).toEqual(before);
 });
 it('refuses changed request authority before any replay write',async()=>{
  const {employmentId}=await hire(),ctx={...adminCtx(b)},before=await snapshot(employmentId),input:CreateMovementInput={employmentId,kind:'secondment',effectiveDate:day(-2)};
  await expect(withTenant(ctx,async tx=>{const prepared=await rehearseMovementSequenceTx(tx,ctx,async(_shadow,create)=>{await create(input);});ctx.roles=['employee'];await prepared.replay(input);})).rejects.toThrow('movement_sequence_context_changed');expect(await snapshot(employmentId)).toEqual(before);
 });
});
