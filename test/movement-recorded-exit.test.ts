/** c445 report contract: recorded lifecycle exit values, with effect/intent provenance and truthful Unknown. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee,terminateEmployment} from '../core/org';
import {createMovementEvent,movementHistoryTx,movementRecordedExitOf,reverseMovementEvent} from '../core/movement';
import {sweepDueMovements} from '../core/movement-apply';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const occurredAt=new Date('2026-01-01T00:00:00Z');
function event(payload:unknown,eventType='employment.terminated') {return {id:'recorded-event',eventType,payload,occurredAt};}
function days(iso:string,n:number) {
  // Calendar arithmetic from an already-local ISO date; no host-current instant is used.
  const date=new Date(iso+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+n);return date.toISOString().slice(0,10);
}
let b:Base;
afterAll(closeAll);
const history=(id:string)=>withTenant(adminCtx(b),tx=>movementHistoryTx(tx,adminCtx(b),id),{readOnlySnapshot:true});
const hire=()=>hireEmployee(adminCtx(b),{person:{fullName:'Recorded Exit',primaryEmail:`recorded-exit-${randomUUID()}@demo.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:days(todayInKualaLumpur(),-365)});

describe('recorded exit parsing',()=>{
  it('preserves explicit blank/zero and source event without a current-value fallback',()=>{
    expect(movementRecordedExitOf(event({terminationReasonCode:null,terminationNoticeDays:0}))).toEqual({
      source:{eventId:'recorded-event',eventType:'employment.terminated',role:'effect',occurredAt:occurredAt.toISOString()},
      terminationReasonCode:{known:true,value:null},terminationNoticeDays:{known:true,value:0},
    });
    expect(movementRecordedExitOf(event({terminationReasonCode:'legacy_recorded_code',terminationNoticeDays:null}))?.terminationReasonCode).toEqual({known:true,value:'legacy_recorded_code'});
    expect(movementRecordedExitOf(event({terminationReasonCode:'redundancy',terminationNoticeDays:null}))?.terminationNoticeDays).toEqual({known:true,value:null});
  });
  it.each([{},null,[],{terminationReasonCode:42,terminationNoticeDays:'30'},{terminationReasonCode:' ',terminationNoticeDays:1.5},{terminationReasonCode:false,terminationNoticeDays:Infinity}])('keeps absent or malformed legacy values Unknown: %s',payload=>{
    const recorded=movementRecordedExitOf(event(payload));
    expect(recorded?.terminationReasonCode).toEqual({known:false,value:null});
    expect(recorded?.terminationNoticeDays).toEqual({known:false,value:null});
  });
  it('uses only the termination intent input and labels it as intent',()=>{
    const recorded=movementRecordedExitOf(event({type:'termination',terminationReasonCode:'misconduct',input:{terminationReasonCode:'redundancy',terminationNoticeDays:30}},'employment.movement.scheduled'));
    expect(recorded?.source.role).toBe('intent');
    expect(recorded?.terminationReasonCode).toEqual({known:true,value:'redundancy'});
    expect(recorded?.terminationNoticeDays).toEqual({known:true,value:30});
    expect(movementRecordedExitOf(event({type:'termination',input:[]},'employment.movement.scheduled'))?.terminationReasonCode).toEqual({known:false,value:null});
    expect(movementRecordedExitOf(event({type:'promotion',input:{terminationReasonCode:'redundancy'}},'employment.movement.scheduled'))).toBeNull();
    expect(movementRecordedExitOf(event({terminationReasonCode:'redundancy'},'employment.info.updated'))).toBeNull();
  });
});

describe('canonical Movement report snapshot exit projection',()=>{
  beforeAll(migrateTestDb);
  beforeEach(async()=>{await resetDb();b=await seedBase();});
  it('reports the exact applied event even after mutable employment exit columns differ',async()=>{
    const {employmentId}=await hire(),date=days(todayInKualaLumpur(),-2);
    await createMovementEvent(adminCtx(b),{employmentId,kind:'termination',effectiveDate:date,endDate:date,terminationReasonCode:'redundancy',terminationNoticeDays:0,remarks:'Recorded effect'});
    const recordedEvents=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.subjectEmploymentId,employmentId),eq(s.domainEvent.eventType,'employment.terminated'))).orderBy(asc(s.domainEvent.sequence));
    expect(recordedEvents).toHaveLength(1);
    // Deliberately divergent current fixture state detects any fallback to today's mutable columns.
    await owner.db.update(s.employment).set({terminationReasonCode:'misconduct',terminationNoticeDays:99}).where(eq(s.employment.id,employmentId));
    const rows=await history(employmentId),row=rows.find(item=>item.id===recordedEvents[0].id)!;
    expect(row.recordedExit).toEqual({source:{eventId:recordedEvents[0].id,eventType:'employment.terminated',role:'effect',occurredAt:recordedEvents[0].occurredAt.toISOString()},terminationReasonCode:{known:true,value:'redundancy'},terminationNoticeDays:{known:true,value:0}});
    expect(rows.find(item=>item.kind==='hired')?.recordedExit).toBeNull();
  });
  it('keeps legacy omitted exit fields Unknown even if current employment has populated values',async()=>{
    const {employmentId}=await hire();
    await terminateEmployment(adminCtx(b),{employmentId,terminationDate:days(todayInKualaLumpur(),-1),terminationReason:'Legacy exit'});
    await owner.db.update(s.employment).set({terminationReasonCode:'redundancy',terminationNoticeDays:30}).where(eq(s.employment.id,employmentId));
    const row=(await history(employmentId)).find(item=>item.kind==='termination')!;
    expect(row.recordedExit?.source.role).toBe('effect');
    expect(row.recordedExit?.terminationReasonCode).toEqual({known:false,value:null});
    expect(row.recordedExit?.terminationNoticeDays).toEqual({known:false,value:null});
  });
  it('distinguishes explicitly recorded null fields from legacy omission through the real termination owner',async()=>{
    const {employmentId}=await hire();
    await terminateEmployment(adminCtx(b),{employmentId,terminationDate:days(todayInKualaLumpur(),-1),terminationReasonCode:null,terminationNoticeDays:null});
    const row=(await history(employmentId)).find(item=>item.kind==='termination')!;
    expect(row.recordedExit?.terminationReasonCode).toEqual({known:true,value:null});
    expect(row.recordedExit?.terminationNoticeDays).toEqual({known:true,value:null});
  });
  it('retains canceled scheduled intent as history without pretending it was an effect',async()=>{
    const {employmentId}=await hire(),date=days(todayInKualaLumpur(),10);
    await createMovementEvent(adminCtx(b),{employmentId,kind:'termination',effectiveDate:date,endDate:date,terminationReasonCode:'redundancy',terminationNoticeDays:0});
    const pending=(await history(employmentId)).find(item=>item.kind==='termination')!;
    await reverseMovementEvent(adminCtx(b),{employmentId,movementId:pending.id,reason:'Withdrawn fictional exit'});
    const canceled=(await history(employmentId)).find(item=>item.id===pending.id)!;
    expect(canceled.status).toBe('reversed');
    expect(canceled.recordedExit).toEqual(pending.recordedExit);
    expect(canceled.recordedExit?.source.role).toBe('intent');
    const [current]=await owner.db.select().from(s.employment).where(eq(s.employment.id,employmentId));
    expect(current.terminatedOn).toBeNull();
  });

  it('keeps the same frozen scheduled intent before and after application, with separate applied status',async()=>{
    const {employmentId}=await hire(),date=days(todayInKualaLumpur(),10);
    await createMovementEvent(adminCtx(b),{employmentId,kind:'termination',effectiveDate:date,endDate:date,terminationReasonCode:'redundancy',terminationNoticeDays:30,remarks:'Recorded intent'});
    const pending=(await history(employmentId)).find(item=>item.kind==='termination')!;
    expect(pending.status).toBe('pending');expect(pending.recordedExit?.source.role).toBe('intent');
    expect(pending.recordedExit?.terminationReasonCode).toEqual({known:true,value:'redundancy'});
    expect(pending.recordedExit?.terminationNoticeDays).toEqual({known:true,value:30});
    await owner.db.update(s.employment).set({terminationReasonCode:'misconduct',terminationNoticeDays:99}).where(eq(s.employment.id,employmentId));
    expect((await history(employmentId)).find(item=>item.id===pending.id)?.recordedExit).toEqual(pending.recordedExit);
    await sweepDueMovements(adminCtx(b),{today:date});
    const applied=(await history(employmentId)).find(item=>item.id===pending.id)!;
    expect(applied.status).toBe('applied');expect(applied.recordedExit).toEqual(pending.recordedExit);
    expect((await history(employmentId)).filter(item=>item.recordedExit)).toHaveLength(1);
  });
});
