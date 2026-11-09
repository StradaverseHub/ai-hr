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
const resolve=(ctx:SessionContext,companyId:string,date:string,wantedRule=ruleId)=>
 withTenant(ctx,tx=>attendanceClockPolicyOnTx(tx,ctx,{companyId,ruleId:wantedRule,date}));

const nativeHistory=(ctx:SessionContext,companyId:string,wantedRule=ruleId)=>
 withTenant(ctx,tx=>tx.execute(sql`select id,ordinal,effective_from::text as "effectiveFrom",policy,reason
  from app.attendance_clock_policy_history(${companyId}::uuid,${wantedRule}::uuid) order by ordinal`));

async function expectPrivateClockAuditColumnsDenied(ctx:SessionContext,revisionId:string){
 const [carrier]=await withTenant(ctx,tx=>tx.execute<{role:string;session:string;current:boolean;admin:boolean}>(sql`
  select current_user::text as "role",session_user::text as "session",
   app.principal_snapshot_current() as "current",app.is_admin_for(${base.companyId}::uuid) as admin`));
 expect(carrier).toEqual({role:'ai_hr_app',session:'ai_hr_app',current:true,admin:false});
 const calls=['reason','created_by_user_id','created_at'].map(column=>
  withTenant(ctx,tx=>tx.execute(sql`select ${sql.identifier(column)}
   from public.attendance_clock_policy_revision where id=${revisionId}::uuid`)));
 await Promise.all(calls.map(call=>expect(call).rejects.toMatchObject({cause:{code:'42501'}})));
}


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
 await expectPrivateClockAuditColumnsDenied(employee,saved.id);
 expect(await nativeHistory(employee,base.companyId)).toEqual([]);
 const forged={...employee,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]};
 expect(await nativeHistory(forged,base.companyId)).toEqual([]);
 await expect(scheduleAttendanceClockPolicy({...employee,roles:['hr_admin']},{...input(),expectedOrdinal:1,effectiveFrom:day(5)})).rejects.toThrow();

 const [account]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'fixture_'+randomUUID()}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:account.id,companyId:base.companyId,role:'hr_admin'});
 const scoped={...admin,userId:account.id,grants:[{role:'hr_admin',companyId:base.companyId}]};
 expect(await attendanceClockPolicyHistory(scoped,input())).toHaveLength(1);
 expect(await nativeHistory(scoped,base.companyId)).toEqual([{...saved,policy,reason:input().reason}]);
 expect(await nativeHistory(scoped,other.id)).toEqual([]);
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

it('lets financial replay read its employer clock policy without Workforce authority',async()=>{
 const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional unrelated payroll employer'}).returning();
 const saved=await scheduleAttendanceClockPolicy(admin,input());
 await scheduleAttendanceClockPolicy(admin,{...input(),companyId:other.id});
 const [account]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'fixture_'+randomUUID()}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:account.id,companyId:base.companyId,role:'payroll_partner'});
 const payroll:SessionContext={...admin,userId:account.id,roles:['payroll_partner'],
  grants:[{role:'payroll_partner',companyId:base.companyId}]};
 const [scope]=await withTenant(payroll,tx=>tx.execute(sql`select
  app.can_admin_payroll_for(${base.companyId}::uuid) as "payroll",
  app.is_admin_for(${base.companyId}::uuid) as "admin",
  coalesce(cardinality(app.visible_employment_ids()::uuid[]),0) as "workforceRows"`));
 expect(scope).toMatchObject({payroll:true,admin:false,workforceRows:0});
 expect(await resolve(payroll,base.companyId,day(3))).toEqual({...saved,policy});
 expect(await resolve(payroll,other.id,day(3))).toBeNull();
 await expect(attendanceClockPolicyHistory(payroll,input())).rejects.toThrow(/scope/i);
 const foreign=await seedBase();
 await setModule(foreign.tenantId,'attendance','active');
 const foreignAdmin=await entitledCtx(foreign);
 const foreignRule=(await ensureStandardRule(foreignAdmin)).id;
 const foreignSaved=await scheduleAttendanceClockPolicy(foreignAdmin,{
  ...input(),companyId:foreign.companyId,ruleId:foreignRule,
 });
 expect(await resolve(foreignAdmin,foreign.companyId,day(3),foreignRule)).toEqual({...foreignSaved,policy});
 expect(await resolve(payroll,foreign.companyId,day(3),foreignRule)).toBeNull();
 await expectPrivateClockAuditColumnsDenied(payroll,saved.id);
 expect(await nativeHistory(payroll,base.companyId)).toEqual([]);
 const forged={...payroll,tenantId:foreign.tenantId,roles:['hr_admin'],
  grants:[{role:'hr_admin',companyId:foreign.companyId}]};
 expect(await nativeHistory(forged,foreign.companyId,foreignRule)).toEqual([]);
 await expect(scheduleAttendanceClockPolicy(payroll,{...input(),expectedOrdinal:1,effectiveFrom:day(5)})).rejects.toThrow();
});


it('keeps clock policy audit event reasons inside the company administrator scope',async()=>{
 const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional other clock audit company'}).returning();
 const ownReason='Fictional own company clock audit';
 const otherReason='Fictional other company clock audit';
 const own=await scheduleAttendanceClockPolicy(admin,{...input(),reason:ownReason});
 const foreign=await scheduleAttendanceClockPolicy(admin,{...input(),companyId:other.id,reason:otherReason});
 const [account]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'fixture_'+randomUUID()}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:account.id,companyId:base.companyId,role:'hr_admin'});
 const scoped={...admin,userId:account.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]};
 const rows=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute<{revisionId:string;reason:string;actorId:string}>(sql`
  select payload->>'versionId' as "revisionId",payload->>'reason' as reason,actor_id::text as "actorId"
  from public.domain_event
  where tenant_id=${base.tenantId}::uuid and event_type='attendance-rule.clock-policy.scheduled'
    and aggregate_id=${ruleId}::uuid order by sequence`));
 await owner.db.insert(schema.domainEvent).values([
  {tenantId:base.tenantId,aggregateType:'attendance-rule',aggregateId:ruleId,
   eventType:'attendance-rule.clock-policy.scheduled',actorType:'user',actorId:admin.userId,
   payload:{versionId:foreign.id,companyId:base.companyId,reason:'Fictional forged company'}},
  {tenantId:base.tenantId,aggregateType:'attendance-rule',aggregateId:ruleId,
   eventType:'attendance-rule.clock-policy.scheduled',actorType:'user',actorId:admin.userId,
   payload:{versionId:'not-a-uuid',companyId:base.companyId,reason:'Fictional malformed revision'}},
  {tenantId:base.tenantId,aggregateType:'attendance-rule',aggregateId:ruleId,
   eventType:'attendance-rule.fixture-audit-probe',actorType:'user',actorId:admin.userId},
 ]);
 const ownEvent={revisionId:own.id,reason:ownReason,actorId:admin.userId};
 const foreignEvent={revisionId:foreign.id,reason:otherReason,actorId:admin.userId};
 expect(await rows(admin)).toEqual([ownEvent,foreignEvent]);
 await expect(attendanceClockPolicyHistory(scoped,{...input(),companyId:other.id})).rejects.toThrow(/scope/i);
 const scopedEvents=await rows(scoped);
 expect(scopedEvents.map(row=>row.revisionId)).toEqual([own.id]);
 expect(scopedEvents).toEqual([ownEvent]);
 expect(await rows({...scoped,grants:[{role:'hr_admin',companyId:other.id}]})).toEqual([]);
 const unrelated=await withTenant(scoped,tx=>tx.execute(sql`select id from public.domain_event
  where tenant_id=${base.tenantId}::uuid and aggregate_id=${ruleId}::uuid and event_type='attendance-rule.fixture-audit-probe'`));
 expect(unrelated).toHaveLength(1);
});
