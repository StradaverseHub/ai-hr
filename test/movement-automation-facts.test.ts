import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {domainEvent} from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent,movementAutomationFactsTx,movementHistory,reverseMovementEvent} from '../core/movement';
import {sweepDueMovements} from '../core/movement-apply';
import {saveMovementEventType} from '../core/movement-type';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
async function hire(){const result=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional workflow subject',primaryEmail:`${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-120)});await setCompensation(adminCtx(b),{employmentId:result.employmentId,basicSalary:3000,effectiveFrom:day(-120)});return result.employmentId;}
const facts=(employmentId:string,today?:string)=>owner.withTenant({tenantId:b.tenantId,roles:['hr_admin']},tx=>movementAutomationFactsTx(tx,{tenantId:b.tenantId,companyId:b.companyId,employmentId,today}));

it('requires the real maintenance connection, no adopted human, and exact tenant/company binding',async()=>{
 const employmentId=await hire(),input={tenantId:b.tenantId,companyId:b.companyId,employmentId};
 await expect(withTenant(adminCtx(b),tx=>movementAutomationFactsTx(tx,input))).rejects.toThrow();
 await expect(owner.withTenant(adminCtx(b),tx=>movementAutomationFactsTx(tx,input))).rejects.toThrow(/maintenance/);
 await expect(owner.withTenant({tenantId:b.tenantId,roles:['super_admin']},tx=>movementAutomationFactsTx(tx,{...input,tenantId:randomUUID()}))).rejects.toThrow(/maintenance/);
 expect(await owner.withTenant({tenantId:b.tenantId,roles:['hr_admin']},tx=>movementAutomationFactsTx(tx,{...input,companyId:randomUUID()}))).toEqual([]);
 expect(await facts(employmentId)).toEqual([]);
});

it('uses the actual application event as the source and never treats an overdue failed intent as applied',async()=>{
 const employmentId=await hire(),future=day(30);await createMovementEvent(adminCtx(b),{employmentId,kind:'promotion',effectiveDate:future,basicSalary:3300,remarks:'PRIVATE PAY REMARK'});
 const [pending]=await facts(employmentId,future);expect(pending).toMatchObject({kind:'promotion',effectiveDate:future,status:'pending',sourceEventId:null,sourceSequence:null});
 expect(await sweepDueMovements(adminCtx(b),{today:future})).toMatchObject({applied:1,failed:0});
 const [application]=await owner.db.select().from(domainEvent).where(and(eq(domainEvent.tenantId,b.tenantId),eq(domainEvent.eventType,'employment.movement.applied')));
 expect(await facts(employmentId,future)).toEqual([{movementId:pending.movementId,kind:'promotion',effectiveDate:future,status:'applied',sourceEventId:application.id,sourceSequence:application.sequence}]);expect(JSON.stringify(await facts(employmentId,future))).not.toContain('PRIVATE');
});

it('preserves canonical custom promotion classification and reversal status without returning HR content',async()=>{
 const employmentId=await hire(),custom=await saveMovementEventType(adminCtx(b),{label:'Fictional advancement',behaviourKind:'promotion'});await createMovementEvent(adminCtx(b),{employmentId,kind:custom.code,effectiveDate:day(-2),basicSalary:3400,remarks:'PRIVATE MOVEMENT NOTE'});
 const [applied]=await facts(employmentId),history=(await movementHistory(adminCtx(b),employmentId)).find(row=>row.kind===custom.code)!;expect(applied).toMatchObject({movementId:history.id,kind:'promotion',status:'applied',sourceEventId:history.id});
 await reverseMovementEvent(adminCtx(b),{employmentId,movementId:history.id,reason:'Fictional source reversal'});expect((await facts(employmentId))[0]).toMatchObject({...applied,status:'reversed'});expect(Object.keys(applied).sort()).toEqual(['movementId','kind','effectiveDate','status','sourceEventId','sourceSequence'].sort());
});

it('excludes advisory review approval while retaining a real confirmation movement',async()=>{
 const employmentId=await hire(),ctx=adminCtx(b);await withTenant(ctx,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'employmentReview',aggregateId:randomUUID(),eventType:'employment-review.decided',subjectEmploymentId:employmentId,actor:actorOf(ctx),payload:{decision:'confirm',reviewType:'probation'}}));expect(await facts(employmentId)).toEqual([]);
 await createMovementEvent(ctx,{employmentId,kind:'confirmation',effectiveDate:day(-1)});const actual=await facts(employmentId);expect(actual).toHaveLength(1);expect(actual[0]).toMatchObject({kind:'confirmation',effectiveDate:day(-1),status:'applied'});
});
