import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {attendanceClockPolicyHistory,attendanceClockPolicyOnTx,hasAttendanceClockPoliciesTx,scheduleAttendanceClockPolicy} from '../core/attendance-clock-policy';
import {attendanceGroupPolicyOnTx,scheduleAttendanceGroupPolicy} from '../core/attendance-group-policy';
import {ensureStandardRule} from '../core/attendance-rule';
import {hireEmployee} from '../core/org';
import {validateAttendanceClockPolicy,type AttendanceClockPolicy} from '../lib/attendance-clock-policy';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base,admin:SessionContext,ruleId:string;
const day=(offset:number)=>addDaysIso(todayInKualaLumpur(),offset);
const policy:AttendanceClockPolicy={pairing:{normal:'auto',rest:'firstInLastOut',off:'auto',publicHoliday:'firstInLastOut'},minimumIntervalMinutes:2};
const input=()=>({companyId:base.companyId,ruleId,expectedOrdinal:0,effectiveFrom:day(3),reason:'Fictional new clock schedule',policy});
const resolve=(ctx:SessionContext,companyId:string,date:string)=>withTenant(ctx,tx=>attendanceClockPolicyOnTx(tx,ctx,{companyId,ruleId,date}));

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();
 base=await seedBase();
 await setModule(base.tenantId,'attendance','active');
 admin=await entitledCtx(base);
 ruleId=(await ensureStandardRule(admin)).id;
});

it('stores ordered future clock revisions and preserves existing overtime policy and lock epoch',async()=>{
 const existingPolicy:AttendanceGroupPolicy={version:1,
  clock:{pairing:'firstInLastOut',minimumIntervalMinutes:5,lateGraceMinutes:10,earlyGraceMinutes:5,skipLatenessIfIncomplete:true},
  overtime:{enabled:false,beforeShift:false,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:false,
   offsetLateness:false,approval:'manual',autoMethod:'actual',rounding:{mode:'none',step:null},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:null}])) as AttendanceGroupPolicy['overtime']['days']},
 };
 await scheduleAttendanceGroupPolicy(admin,{...input(),effectiveFrom:day(2),policy:existingPolicy});
 const epoch=async()=>await owner.db.execute(sql`select revision from overtime_pattern_epoch where tenant_id=${base.tenantId}::uuid`);
 const overtime=()=>withTenant(admin,tx=>attendanceGroupPolicyOnTx(tx,admin,{companyId:base.companyId,ruleId,date:day(6)}));
 const oldEpoch=await epoch(),oldOvertime=await overtime();
 expect(oldOvertime?.policy).toEqual(existingPolicy);
 expect(await withTenant(admin,tx=>hasAttendanceClockPoliciesTx(tx,admin,day(6)))).toBe(false);

 const first=await scheduleAttendanceClockPolicy(admin,{...input(),reason:'  Preserve the audit reason  '});
 const nextPolicy={...policy,minimumIntervalMinutes:0};
 const second=await scheduleAttendanceClockPolicy(admin,{...input(),expectedOrdinal:1,effectiveFrom:day(4),policy:nextPolicy});
 expect(await resolve(admin,base.companyId,day(2))).toBeNull();
 expect(await resolve(admin,base.companyId,day(3))).toEqual({...first,policy});
 expect(await resolve(admin,base.companyId,day(4))).toEqual({...second,policy:nextPolicy});
 expect(await withTenant(admin,tx=>hasAttendanceClockPoliciesTx(tx,admin,day(2)))).toBe(false);
 expect(await withTenant(admin,tx=>hasAttendanceClockPoliciesTx(tx,admin,day(3)))).toBe(true);
 expect(await attendanceClockPolicyHistory(admin,input())).toEqual([
  {...first,policy,reason:'Preserve the audit reason'},
  {...second,policy:nextPolicy,reason:input().reason},
 ]);
 expect(await epoch()).toEqual(oldEpoch);
 expect(await overtime()).toEqual(oldOvertime);

 const events=await owner.db.select({payload:schema.domainEvent.payload})
  .from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,ruleId),
   eq(schema.domainEvent.eventType,'attendance-rule.clock-policy.scheduled'))).orderBy(asc(schema.domainEvent.sequence));
 expect(events.map(row=>row.payload)).toMatchObject([
  {versionId:first.id,previousOrdinal:0,ordinal:1,companyId:base.companyId},
  {versionId:second.id,previousOrdinal:1,ordinal:2,companyId:base.companyId},
 ]);
 await expect(scheduleAttendanceClockPolicy(admin,{...input(),expectedOrdinal:1,effectiveFrom:day(6)})).rejects.toThrow(/history changed/i);
 await expect(scheduleAttendanceClockPolicy(admin,{...input(),expectedOrdinal:2,effectiveFrom:day(3)})).rejects.toThrow(/history changed/i);
 await expect(owner.db.update(schema.attendanceClockPolicyRevision).set({reason:'Changed'}).where(eq(schema.attendanceClockPolicyRevision.id,first.id))).rejects.toThrow();
 await expect(owner.db.delete(schema.attendanceClockPolicyRevision).where(eq(schema.attendanceClockPolicyRevision.id,first.id))).rejects.toThrow();
});

it('validates minutes, all four day types, exact date, immutable scope, and direct writes',async()=>{
 expect(validateAttendanceClockPolicy({...policy,minimumIntervalMinutes:4320})).toMatchObject({minimumIntervalMinutes:4320});
 for(const value of [-1,0.5,4321,'2'])expect(()=>validateAttendanceClockPolicy({...policy,minimumIntervalMinutes:value})).toThrow();
 expect(()=>validateAttendanceClockPolicy({...policy,pairing:{normal:'auto'}})).toThrow();
 expect(()=>validateAttendanceClockPolicy({...policy,pairing:{...policy.pairing,replacementHoliday:'auto'}})).toThrow();
 await expect(scheduleAttendanceClockPolicy(admin,{...input(),effectiveFrom:day(0)})).rejects.toThrow(/future/i);
 await expect(scheduleAttendanceClockPolicy(admin,{...input(),reason:' '})).rejects.toThrow(/reason/i);
 const foreign=await seedBase();
 const foreignAdmin=await entitledCtx(foreign);
 const foreignRuleId=(await ensureStandardRule(foreignAdmin)).id;
 const row={tenantId:base.tenantId,companyId:base.companyId,ruleId,ordinal:1,
  effectiveFrom:day(3),policy,reason:'Fictional guarded write',createdByUserId:base.adminUserId};
 await expect(withTenant(admin,tx=>tx.insert(schema.attendanceClockPolicyRevision).values({...row,ruleId:foreignRuleId}))).rejects.toThrow();
 await expect(withTenant(admin,tx=>tx.insert(schema.attendanceClockPolicyRevision).values({...row,companyId:foreign.companyId}))).rejects.toThrow();
 await expect(withTenant(admin,tx=>tx.insert(schema.attendanceClockPolicyRevision).values({...row,createdByUserId:foreign.adminUserId}))).rejects.toThrow();
 await expect(withTenant(admin,tx=>tx.insert(schema.attendanceClockPolicyRevision).values({...row,effectiveFrom:day(0)}))).rejects.toThrow();
 await expect(withTenant(admin,tx=>tx.insert(schema.attendanceClockPolicyRevision).values({...row,ordinal:3}))).rejects.toThrow();
 await expect(withTenant(admin,tx=>tx.insert(schema.attendanceClockPolicyRevision).values({...row,policy:{...policy,minimumIntervalMinutes:4321}}))).rejects.toThrow();
 expect(await attendanceClockPolicyHistory(admin,input())).toEqual([]);
});

it('allows canonical employee reads of the employer policy and limits history and writes to company admins',async()=>{
 const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional other employer'}).returning();
 const saved=await scheduleAttendanceClockPolicy(admin,input());
 await scheduleAttendanceClockPolicy(admin,{...input(),companyId:other.id});
 const worker=await hireEmployee(admin,{person:{fullName:'Fictional clock policy reader',primaryEmail:'clock-policy-reader@fixture.invalid'},
  companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:day(-1)});
 const userId=await createAppUser(base.tenantId,worker.personId,'employee');
 const employee={...admin,userId,personId:worker.personId,roles:['employee']};
 expect(await resolve(employee,base.companyId,day(3))).toEqual({...saved,policy});
 expect(await resolve(employee,other.id,day(3))).toBeNull();
 await expect(attendanceClockPolicyHistory(employee,input())).rejects.toThrow(/scope/i);
 await expect(scheduleAttendanceClockPolicy({...employee,roles:['hr_admin']},{...input(),expectedOrdinal:1,effectiveFrom:day(5)})).rejects.toThrow();

 const [account]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'fixture_'+randomUUID()}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:account.id,companyId:base.companyId,role:'hr_admin'});
 const scoped={...admin,userId:account.id,grants:[{role:'hr_admin',companyId:base.companyId}]};
 expect(await attendanceClockPolicyHistory(scoped,input())).toHaveLength(1);
 await expect(attendanceClockPolicyHistory(scoped,{...input(),companyId:other.id})).rejects.toThrow(/scope/i);
 await expect(scheduleAttendanceClockPolicy(scoped,{...input(),companyId:other.id,expectedOrdinal:1,effectiveFrom:day(5)})).rejects.toThrow();

 const [retainedGroup]=await withTenant(admin,tx=>tx.insert(schema.attendanceRule).values({
  tenantId:base.tenantId,companyId:base.companyId,name:'Fictional legacy company-owned group',
 }).returning({id:schema.attendanceRule.id}));
 await scheduleAttendanceClockPolicy(admin,{...input(),companyId:other.id,ruleId:retainedGroup.id});
 const ruleCompanyInUse=(ctx:SessionContext,companyId:string)=>withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{inUse:boolean}>(sql`select app.attendance_clock_rule_company_in_use(${companyId}::uuid) as "inUse"`);
  return row.inUse;
 });
 expect(await ruleCompanyInUse(scoped,base.companyId)).toBe(true);
 expect(await ruleCompanyInUse(employee,base.companyId)).toBe(false);
 expect(await ruleCompanyInUse(scoped,other.id)).toBe(false);
});
