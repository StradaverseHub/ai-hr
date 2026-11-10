/**
 * c03670cc — Schedule Group clock settings for All Companies or specific companies.
 *
 * Real database, real RLS and the migration 4600 guard. What is pinned:
 *  · precedence: a company's own revision effective on the date wins, else the group-wide one, else legacy;
 *  · All Companies covers a company created AFTER the save;
 *  · only a group administrator can write All Companies (service, RLS and trigger each refuse otherwise);
 *  · specific companies write one revision per company in ONE transaction (all or nothing);
 *  · the service dates every change itself (tomorrow, or the day after that chain's latest start), records a
 *    system reason, writes nothing when the settings are unchanged, and refuses a stale revision token;
 *  · saving never recalculates attendance that already exists;
 *  · All Companies audit history and scheduled-change events are read by exactly the group administrators
 *    who may write them (owner decision 11 Nov 2026); company administrators keep their own companies only.
 */
import {randomUUID} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {addImportedPunchesBatchTx} from '../core/attendance';
import {attendanceClockPolicyGroupHistory,attendanceClockPolicyHistory,attendanceClockPolicyOnTx,
  saveScheduleGroupClockPolicy,scheduleAttendanceClockPolicy} from '../core/attendance-clock-policy';
import {ensureStandardRule} from '../core/attendance-rule';
import {hireEmployee} from '../core/org';
import {assignDefaultShift,createShift} from '../core/roster';
import type {AttendanceClockPolicy} from '../lib/attendance-clock-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base,admin:SessionContext,ruleId:string;
const day=(offset:number)=>addDaysIso(todayInKualaLumpur(),offset);
const fil:AttendanceClockPolicy={pairing:{normal:'firstInLastOut',rest:'firstInLastOut',off:'auto',publicHoliday:'firstInLastOut'},minimumIntervalMinutes:2};
const auto:AttendanceClockPolicy={pairing:{normal:'auto',rest:'auto',off:'auto',publicHoliday:'auto'},minimumIntervalMinutes:5};
const resolve=(ctx:SessionContext,companyId:string,date:string)=>withTenant(ctx,tx=>attendanceClockPolicyOnTx(tx,ctx,{companyId,ruleId,date}));
const REASON='Updated in Schedule Group settings';

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async()=>{
  await resetDb();
  base=await seedBase();
  await setModule(base.tenantId,'attendance','active');
  admin={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
  ruleId=(await ensureStandardRule(admin)).id;
});

async function companyScopedAdmin(companyId:string):Promise<SessionContext> {
  const [account]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'fixture_'+randomUUID()}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:account.id,companyId,role:'hr_admin'});
  return {...admin,userId:account.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]};
}
const newCompany=async(name:string)=>(await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:name}).returning())[0];

describe('precedence: company-specific, then group-wide, then legacy', ()=>{
  it('a company revision effective on the date wins; otherwise the group-wide revision applies', async()=>{
    const other=await newCompany('Fictional Sample Trading');
    const group=await scheduleAttendanceClockPolicy(admin,{companyId:null,ruleId,expectedOrdinal:0,effectiveFrom:day(2),reason:'Fictional group',policy:auto});
    const own=await scheduleAttendanceClockPolicy(admin,{companyId:base.companyId,ruleId,expectedOrdinal:0,effectiveFrom:day(4),reason:'Fictional own',policy:fil});
    expect(await resolve(admin,base.companyId,day(1)),'before either: legacy').toBeNull();
    expect(await resolve(admin,base.companyId,day(3))).toEqual({...group,policy:auto});
    expect(await resolve(admin,base.companyId,day(4))).toEqual({...own,policy:fil});
    expect(await resolve(admin,base.companyId,day(9))).toEqual({...own,policy:fil});
    expect(await resolve(admin,other.id,day(9)),'a company without its own follows the group').toEqual({...group,policy:auto});
    // Each chain is independent and append-only: the group chain started at ordinal 1 as well.
    expect(await attendanceClockPolicyGroupHistory(admin,{ruleId})).toEqual([{...group,policy:auto}]);
    expect(await attendanceClockPolicyHistory(admin,{companyId:base.companyId,ruleId})).toMatchObject([{ordinal:1,effectiveFrom:day(4)}]);
  });

  it('an employee and a payroll partner can read the group-wide revision for their employer', async()=>{
    const group=await scheduleAttendanceClockPolicy(admin,{companyId:null,ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'Fictional group',policy:fil});
    const worker=await hireEmployee(admin,{person:{fullName:'Fictional group clock reader',primaryEmail:randomUUID()+'@fixture.invalid'},
      companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:day(-1)});
    const employee={...admin,userId:await createAppUser(base.tenantId,worker.personId,'employee'),personId:worker.personId,roles:['employee'],grants:[]};
    expect(await resolve(employee,base.companyId,day(1))).toEqual({...group,policy:fil});
    const [account]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'fixture_'+randomUUID()}).returning();
    await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:account.id,companyId:base.companyId,role:'payroll_partner'});
    const payroll={...admin,userId:account.id,roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:base.companyId}]};
    expect(await resolve(payroll,base.companyId,day(1))).toEqual({...group,policy:fil});
    await expect(attendanceClockPolicyGroupHistory(employee,{ruleId}),'history stays an administrator view').rejects.toThrow(/scope/i);
  });
});

describe('All Companies', ()=>{
  it('covers a company created after the save', async()=>{
    const result=await saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:fil,expected:{group:0},reason:REASON});
    expect(result.saved).toMatchObject([{companyId:null,ordinal:1,effectiveFrom:day(1)}]);
    const later=await newCompany('Fictional company added later');
    expect(await resolve(admin,later.id,day(1))).toMatchObject({ordinal:1,effectiveFrom:day(1),policy:fil});
    expect(await resolve(admin,later.id,day(0)),'today keeps its legacy behaviour').toBeNull();
    const [row]=await owner.db.select().from(schema.attendanceClockPolicyRevision)
      .where(and(eq(schema.attendanceClockPolicyRevision.ruleId,ruleId),isNull(schema.attendanceClockPolicyRevision.companyId)));
    expect(row).toMatchObject({companyId:null,reason:REASON,createdByUserId:admin.userId});
  });

  it('a company-scoped administrator cannot write it — service, RLS and trigger each refuse', async()=>{
    const scoped=await companyScopedAdmin(base.companyId);
    await expect(saveScheduleGroupClockPolicy(scoped,{ruleId,scope:{kind:'all'},policy:fil,expected:{group:0},reason:REASON}))
      .rejects.toThrow(/group administrator/i);
    await expect(scheduleAttendanceClockPolicy(scoped,{companyId:null,ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'x',policy:fil}))
      .rejects.toThrow(/group administrator/i);
    await expect(withTenant(scoped,tx=>tx.insert(schema.attendanceClockPolicyRevision).values({tenantId:base.tenantId,companyId:null,ruleId,
      ordinal:1,effectiveFrom:day(1),policy:fil,reason:'Fictional direct write',createdByUserId:scoped.userId!}))).rejects.toThrow();
    expect(await attendanceClockPolicyGroupHistory(admin,{ruleId})).toEqual([]);
    // …while their own company is still theirs to set.
    const own=await saveScheduleGroupClockPolicy(scoped,{ruleId,scope:{kind:'companies',companyIds:[base.companyId]},policy:fil,
      expected:{[base.companyId]:0},reason:REASON});
    expect(own.saved).toMatchObject([{companyId:base.companyId,ordinal:1,effectiveFrom:day(1)}]);
  });

  it('the group chain is append-only and keeps its own ordinal and date uniqueness', async()=>{
    const first=await scheduleAttendanceClockPolicy(admin,{companyId:null,ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'Fictional',policy:fil});
    const row={tenantId:base.tenantId,companyId:null,ruleId,ordinal:1,effectiveFrom:day(5),policy:fil,reason:'Fictional duplicate',createdByUserId:admin.userId!};
    await expect(withTenant(admin,tx=>tx.insert(schema.attendanceClockPolicyRevision).values(row)),'duplicate ordinal').rejects.toThrow();
    await expect(withTenant(admin,tx=>tx.insert(schema.attendanceClockPolicyRevision).values({...row,ordinal:2,effectiveFrom:day(1)})),'not after the latest').rejects.toThrow();
    await expect(owner.db.update(schema.attendanceClockPolicyRevision).set({reason:'Changed'}).where(eq(schema.attendanceClockPolicyRevision.id,first.id))).rejects.toThrow();
    await expect(owner.db.delete(schema.attendanceClockPolicyRevision).where(eq(schema.attendanceClockPolicyRevision.id,first.id))).rejects.toThrow();
  });
});

describe('All Companies audit history and events (owner decision 11 Nov 2026)', ()=>{
  type AuditRow={id:string;ordinal:number;effectiveFrom:string;policy:unknown;reason:string};
  const nativeHistory=(ctx:SessionContext,companyId:string|null)=>withTenant(ctx,tx=>tx.execute<AuditRow>(sql`
    select id,ordinal,effective_from::text as "effectiveFrom",policy,reason
    from app.attendance_clock_policy_history(${companyId}::uuid,${ruleId}::uuid) order by ordinal`));
  const scheduledEvents=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute<{revisionId:string;companyId:string|null;reason:string}>(sql`
    select payload->>'versionId' as "revisionId",payload->>'companyId' as "companyId",payload->>'reason' as reason
    from public.domain_event where tenant_id=${base.tenantId}::uuid and event_type='attendance-rule.clock-policy.scheduled'
      and aggregate_id=${ruleId}::uuid order by sequence`));
  const GROUP_REASON='Fictional All Companies audit reason',OWN_REASON='Fictional own company audit reason';

  async function scheduleBoth() {
    const group=await scheduleAttendanceClockPolicy(admin,{companyId:null,ruleId,expectedOrdinal:0,effectiveFrom:day(2),reason:GROUP_REASON,policy:auto});
    const own=await scheduleAttendanceClockPolicy(admin,{companyId:base.companyId,ruleId,expectedOrdinal:0,effectiveFrom:day(3),reason:OWN_REASON,policy:fil});
    return {
      group,own,
      groupRow:{id:group.id,ordinal:1,effectiveFrom:day(2),policy:auto,reason:GROUP_REASON},
      ownRow:{id:own.id,ordinal:1,effectiveFrom:day(3),policy:fil,reason:OWN_REASON},
      groupEvent:{revisionId:group.id,companyId:null,reason:GROUP_REASON},
      ownEvent:{revisionId:own.id,companyId:base.companyId,reason:OWN_REASON},
    };
  }

  it('a group administrator sees the All Companies history and events; a forged event scope stays hidden', async()=>{
    const {group,own,groupRow,ownRow,groupEvent,ownEvent}=await scheduleBoth();
    const [written]=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId,ruleId),sql`${schema.domainEvent.payload}->>'versionId'=${group.id}`));
    expect(written?.payload,'fixture precondition: the real writer records the group scope').toMatchObject({companyId:null,scope:'group'});
    const forged=(payload:Record<string,unknown>)=>({tenantId:base.tenantId,aggregateType:'attendance-rule',aggregateId:ruleId,
      eventType:'attendance-rule.clock-policy.scheduled',actorType:'user',actorId:admin.userId,payload});
    await owner.db.insert(schema.domainEvent).values([
      forged({versionId:group.id,companyId:base.companyId,scope:'company',reason:'Fictional group row claimed as a company'}),
      forged({versionId:group.id,reason:'Fictional group row without a company field'}),
      forged({versionId:group.id,companyId:null,reason:'Fictional group row without a scope label'}),
      forged({versionId:own.id,companyId:null,scope:'group',reason:'Fictional company row claimed as All Companies'}),
    ]);
    expect(await nativeHistory(admin,null)).toEqual([groupRow]);
    expect(await nativeHistory(admin,base.companyId),'the company chain is still its own').toEqual([ownRow]);
    expect(await scheduledEvents(admin)).toEqual([groupEvent,ownEvent]);
  });

  it('a company-scoped administrator still sees only their own company', async()=>{
    const {group,ownRow,ownEvent}=await scheduleBoth();
    const scoped=await companyScopedAdmin(base.companyId);
    expect(await nativeHistory(scoped,null)).toEqual([]);
    expect(await nativeHistory(scoped,base.companyId)).toEqual([ownRow]);
    expect(await scheduledEvents(scoped)).toEqual([ownEvent]);
    // The dated group-wide settings (no audit fields) stay readable to administrators, as before.
    expect(await attendanceClockPolicyGroupHistory(scoped,{ruleId})).toEqual([{...group,policy:auto}]);
  });

  it('an employee sees no clock policy audit history or events, even with a forged group grant', async()=>{
    await scheduleBoth();
    const worker=await hireEmployee(admin,{person:{fullName:'Fictional audit reader',primaryEmail:randomUUID()+'@fixture.invalid'},
      companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:day(-1)});
    const employee={...admin,userId:await createAppUser(base.tenantId,worker.personId,'employee'),personId:worker.personId,roles:['employee'],grants:[]};
    const forgedGroup={...employee,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
    for(const ctx of [employee,forgedGroup]) {
      expect(await nativeHistory(ctx,null)).toEqual([]);
      expect(await nativeHistory(ctx,base.companyId)).toEqual([]);
      expect(await scheduledEvents(ctx)).toEqual([]);
    }
  });

  it('another tenant’s group administrator sees nothing, including through a forged tenant', async()=>{
    await scheduleBoth();
    const foreign=await seedBase();
    await setModule(foreign.tenantId,'attendance','active');
    const foreignAdmin={...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]};
    for(const ctx of [foreignAdmin,{...foreignAdmin,tenantId:base.tenantId}]) {
      expect(await nativeHistory(ctx,null)).toEqual([]);
      expect(await nativeHistory(ctx,base.companyId)).toEqual([]);
      expect(await scheduledEvents(ctx)).toEqual([]);
    }
  });
});

describe('specific companies', ()=>{
  it('writes one revision per selected company in one transaction; unselected companies keep their own', async()=>{
    const second=await newCompany('Fictional Example Sdn Bhd'),third=await newCompany('Fictional untouched company');
    await scheduleAttendanceClockPolicy(admin,{companyId:third.id,ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'Fictional own',policy:auto});
    const result=await saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'companies',companyIds:[base.companyId,second.id]},policy:fil,
      expected:{[base.companyId]:0,[second.id]:0},reason:REASON});
    expect(result.saved.map(row=>row.companyId).sort()).toEqual([base.companyId,second.id].sort());
    expect(await resolve(admin,base.companyId,day(1))).toMatchObject({policy:fil});
    expect(await resolve(admin,second.id,day(1))).toMatchObject({policy:fil});
    expect(await resolve(admin,third.id,day(1)),'not chosen ⇒ keeps its own').toMatchObject({policy:auto});
    expect(await attendanceClockPolicyGroupHistory(admin,{ruleId}),'no group-wide row').toEqual([]);
  });

  it('is all or nothing: a company outside the administrator’s scope refuses the whole save', async()=>{
    const other=await newCompany('Fictional other employer');
    const scoped=await companyScopedAdmin(base.companyId);
    await expect(saveScheduleGroupClockPolicy(scoped,{ruleId,scope:{kind:'companies',companyIds:[base.companyId,other.id]},policy:fil,
      expected:{[base.companyId]:0,[other.id]:0},reason:REASON})).rejects.toThrow(/scope/i);
    expect(await attendanceClockPolicyHistory(admin,{companyId:base.companyId,ruleId}),'the first company was rolled back').toEqual([]);
  });
});

describe('server-supplied dating, unchanged settings and stale forms', ()=>{
  it('dates from tomorrow, then the day after the chain’s latest start; unchanged settings write nothing', async()=>{
    const first=await saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:fil,expected:{group:0},reason:REASON});
    expect(first.saved).toMatchObject([{ordinal:1,effectiveFrom:day(1)}]);
    const same=await saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:fil,expected:{group:1},reason:REASON});
    expect(same).toEqual({saved:[],unchanged:[null]});
    const changed=await saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:{...fil,minimumIntervalMinutes:3},expected:{group:1},reason:REASON});
    expect(changed.saved,'a second change today starts the day after the scheduled one').toMatchObject([{ordinal:2,effectiveFrom:day(2)}]);
    // Changing ONE day type leaves the other three exactly as saved (per-day independence).
    const oneDay={...fil,minimumIntervalMinutes:3,pairing:{...fil.pairing,off:'firstInLastOut' as const}};
    await saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:oneDay,expected:{group:2},reason:REASON});
    const history=await attendanceClockPolicyGroupHistory(admin,{ruleId});
    expect(history.at(-1)?.policy).toEqual(oneDay);
    expect(history.at(-1)?.policy.pairing).toMatchObject({normal:fil.pairing.normal,rest:fil.pairing.rest,publicHoliday:fil.pairing.publicHoliday});
  });

  it('refuses a stale revision token and an empty or oversized reason', async()=>{
    await saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:fil,expected:{group:0},reason:REASON});
    await expect(saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:auto,expected:{group:0},reason:REASON}))
      .rejects.toThrow(/changed/i);
    await expect(saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:auto,expected:{},reason:REASON}))
      .rejects.toThrow(/changed/i);
    await expect(saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:auto,expected:{group:1},reason:' '}))
      .rejects.toThrow(/reason/i);
    expect(await attendanceClockPolicyGroupHistory(admin,{ruleId})).toHaveLength(1);
  });
});

describe('no recalculation of existing attendance', ()=>{
  it('a save leaves every existing attendance row byte-identical, and new days use the group setting', async()=>{
    const {employmentId}=await hireEmployee(admin,{person:{fullName:'Fictional existing day',primaryEmail:randomUUID()+'@fixture.invalid'},
      companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:day(-30)});
    const {id:shiftId}=await createShift(admin,{companyId:base.companyId,code:'GROUP_CLOCK',name:'Fictional fixed day',
      startTime:'09:00',endTime:'18:00',breakMinutes:0,weeklyPattern:[1,2,3,4,5,6,7],ruleId});
    await assignDefaultShift(admin,{employmentId,shiftId});
    const work=[['09:00:00','in'],['09:01:00','out'],['12:00:00','out'],['13:00:00','in'],['18:00:00','out']] as const;
    const importDay=(date:string)=>withTenant(admin,tx=>addImportedPunchesBatchTx(tx,admin,{runId:randomUUID(),
      days:[{employmentId,day:date,punches:work.map(([time,direction])=>({time,direction}))}]}));
    await importDay(day(-1));
    await importDay(day(0));
    const rows=async()=>owner.db.execute(sql`select to_jsonb(a) as row from attendance a where a.employment_id=${employmentId}::uuid order by a.attendance_date`);
    const before=await rows();
    expect(before.length,'fixture precondition: two existing days').toBe(2);

    await saveScheduleGroupClockPolicy(admin,{ruleId,scope:{kind:'all'},policy:fil,expected:{group:0},reason:REASON});
    expect(await rows(),'nothing already captured is reworked').toEqual(before);

    await importDay(day(1));
    const [tomorrow]=await owner.db.select().from(schema.attendance)
      .where(and(eq(schema.attendance.employmentId,employmentId),eq(schema.attendance.attendanceDate,day(1))));
    expect(tomorrow.calcTrace,'tomorrow is calculated with the group-wide revision').toMatchObject({clockPolicy:{pairing:'firstInLastOut',minimumIntervalMinutes:2}});
  });
});
