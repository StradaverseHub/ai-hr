import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {ensureStandardRule} from '../core/attendance-rule';
import {hireEmployee} from '../core/org';
import {attendanceGroupPolicyHistory,attendanceGroupPolicyOnTx,scheduleAttendanceGroupPolicy} from '../core/attendance-group-policy';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';
import {activateOvertimePattern,saveOvertimePatternDraft,validateOvertimePatternActivation} from '../packs/attendance/service';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,ruleId:string;
const plus=(days:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const policy=():AttendanceGroupPolicy=>({version:1,clock:{pairing:'auto',minimumIntervalMinutes:5,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:true},
 overtime:{enabled:false,beforeShift:false,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:false,offsetLateness:false,approval:'manual',autoMethod:'actual',rounding:{mode:'none',step:null},
 days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:null}])) as AttendanceGroupPolicy['overtime']['days']}});
const input=()=>({companyId:b.companyId,ruleId,expectedOrdinal:0,effectiveFrom:plus(1),reason:'Fictional forward policy',policy:policy()});
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);ruleId=(await ensureStandardRule(ctx)).id;});
describe('future attendance execution policy history',()=>{
 it('lets an employee calculation read its employer policy while denying unrelated companies and configuration writes',async()=>{
  const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional unrelated policy company'}).returning();
  await scheduleAttendanceGroupPolicy(ctx,input());
  await scheduleAttendanceGroupPolicy(ctx,{...input(),companyId:other.id});
  const employee=await hireEmployee(ctx,{person:{fullName:'Fictional policy reader',primaryEmail:'policy-reader@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:plus(-1)});
  const userId=await createAppUser(b.tenantId,employee.personId,'employee');
  const self={...ctx,userId,personId:employee.personId,roles:['employee']};
  const visible=await withTenant(self,tx=>tx.select({companyId:s.attendanceGroupPolicyRevision.companyId}).from(s.attendanceGroupPolicyRevision).orderBy(asc(s.attendanceGroupPolicyRevision.companyId)));
  expect(visible).toEqual([{companyId:b.companyId}]);
  await expect(attendanceGroupPolicyHistory(self,{companyId:b.companyId,ruleId})).rejects.toThrow();
  await expect(withTenant({...self,roles:['hr_admin']},tx=>tx.insert(s.attendanceGroupPolicyRevision).values({
   tenantId:b.tenantId,companyId:b.companyId,ruleId,ordinal:2,effectiveFrom:plus(2),policy:policy(),
   reason:'Fictional forged-role write',createdByUserId:userId}))).rejects.toThrow();
  await expect(scheduleAttendanceGroupPolicy({...self,roles:['hr_admin']},{...input(),expectedOrdinal:1,effectiveFrom:plus(2)})).rejects.toThrow();
  expect(await attendanceGroupPolicyHistory(ctx,{companyId:b.companyId,ruleId})).toHaveLength(1);
 });
 it('does not use a superseded organisation record as authority to read another employer policy',async()=>{
  const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional corrected employer reference'}).returning();
  await scheduleAttendanceGroupPolicy(ctx,input());
  await scheduleAttendanceGroupPolicy(ctx,{...input(),companyId:other.id});
  const employee=await hireEmployee(ctx,{person:{fullName:'Fictional corrected-history reader',primaryEmail:'corrected-history@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:plus(-10)});
  const userId=await createAppUser(b.tenantId,employee.personId,'employee');
  const self:SessionContext={tenantId:b.tenantId,userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}],entitlements:ctx.entitlements};
  // Retained, explicitly superseded evidence is visible to its subject. It must not independently
  // extend present authority to the corrected-away company. No actual assignment is retargeted.
  const [obsolete]=await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId:employee.employmentId,
   departmentId:b.deptA,companyId:other.id,employmentType:'full_time',validFrom:plus(-10),validTo:plus(-5),supersededAt:new Date()}).returning();
  expect(await withTenant(self,tx=>tx.select({id:s.assignment.id}).from(s.assignment).where(eq(s.assignment.id,obsolete.id))))
   .toEqual([{id:obsolete.id}]);
  const visible=await withTenant(self,tx=>tx.select({companyId:s.attendanceGroupPolicyRevision.companyId}).from(s.attendanceGroupPolicyRevision));
  expect(visible).toEqual([{companyId:b.companyId}]);
 });
 it('binds the existing central formula version only when active for this employer on the policy date',async()=>{
  const [earning]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'POLICY_OT',name:'Fictional policy earning',kind:'allowance'}).returning();
  const definition=prepareOvertimeStarter('ot15','day','earliest');
  definition.currency={code:'MYR',minorScale:2};
  definition.eligibility={id:'eligibility',type:'constant',value:true};
  definition.rates[0].when={id:'rate_eligibility',type:'constant',value:true};
  const tier=definition.rates[0].tiers[0];tier.mapping={earningItemId:earning.id,currency:'MYR'};
  if(tier.payment.method!=='hourly'||tier.payment.rate.type!=='hourlyRate')throw Error('Fixture must retain the hourly formula');
  tier.payment.rate.divisorMinutes={id:'hourly_divisor',unit:'minutes',type:'literal',value:'480'};
  const draft=await saveOvertimePatternDraft(ctx,{draft:{code:'POLICY_'+randomUUID().slice(0,8),name:'Fictional 1.5 pattern',creationCompanyId:b.companyId,companyIds:[b.companyId],definition}});
  const check=await validateOvertimePatternActivation(ctx,{versionId:draft.versionId,expectedRevision:draft.revision});
  expect(check.issues).toEqual([]);expect(check.validationDigest).not.toBeNull();
  await activateOvertimePattern(ctx,{versionId:draft.versionId,expectedRevision:draft.revision,validationDigest:check.validationDigest!,effectiveFrom:plus(2)});
  const configured=policy();configured.overtime.enabled=true;
  for(const key of ATTENDANCE_POLICY_DAY_CLASSES)configured.overtime.days[key].patternVersionId=draft.versionId;
  await expect(scheduleAttendanceGroupPolicy(ctx,{...input(),policy:configured})).rejects.toThrow();
  const saved=await scheduleAttendanceGroupPolicy(ctx,{...input(),effectiveFrom:plus(2),policy:configured});
  expect((await attendanceGroupPolicyHistory(ctx,{companyId:b.companyId,ruleId})).find(row=>row.id===saved.id)?.policy).toEqual(configured);
 });
 it('saves/reopens one immutable snapshot and leaves earlier days in legacy mode',async()=>{
  const saved=await scheduleAttendanceGroupPolicy(ctx,input());
  const history=await attendanceGroupPolicyHistory(ctx,{companyId:b.companyId,ruleId});
  expect(history).toHaveLength(1);expect(history[0]).toMatchObject({...saved,policy:policy(),createdByUserId:ctx.userId});
  const resolve=(date:string)=>withTenant(ctx,tx=>attendanceGroupPolicyOnTx(tx,ctx,{companyId:b.companyId,ruleId,date}));
  expect(await resolve(todayInKualaLumpur())).toBeNull();
  expect(await resolve(plus(1))).toMatchObject({id:saved.id,policy:policy()});
  const secondPolicy=policy();secondPolicy.clock.pairing='firstInLastOut';
  const next=await scheduleAttendanceGroupPolicy(ctx,{...input(),expectedOrdinal:1,effectiveFrom:plus(2),policy:secondPolicy});
  expect(await resolve(plus(1))).toMatchObject({id:saved.id,policy:policy()});
  expect(await resolve(plus(2))).toMatchObject({id:next.id,policy:secondPolicy});
  await expect(owner.db.update(s.attendanceGroupPolicyRevision).set({reason:'mutated'}).where(eq(s.attendanceGroupPolicyRevision.id,saved.id))).rejects.toThrow();
  await expect(owner.db.delete(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.id,saved.id))).rejects.toThrow();
 });
 it('serializes simultaneous stale writers and records exactly one scheduled-policy event',async()=>{
  const results=await Promise.allSettled([scheduleAttendanceGroupPolicy(ctx,input()),scheduleAttendanceGroupPolicy(ctx,input())]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,ruleId),eq(s.domainEvent.eventType,'attendance-rule.policy.scheduled'))).orderBy(asc(s.domainEvent.sequence));
  expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({companyId:b.companyId,previousOrdinal:0,ordinal:1});
 });
 it('refuses foreign group/company references, missing or unactivated formulas, missing actors and same-day activation',async()=>{
  const other=await seedBase(),foreignRule=(await ensureStandardRule(adminCtx(other))).id;
  await expect(scheduleAttendanceGroupPolicy(ctx,{...input(),companyId:other.companyId})).rejects.toThrow();
  await expect(scheduleAttendanceGroupPolicy(ctx,{...input(),ruleId:foreignRule})).rejects.toThrow();
  await expect(scheduleAttendanceGroupPolicy({...ctx,userId:undefined},input())).rejects.toThrow();
  await expect(scheduleAttendanceGroupPolicy(ctx,{...input(),effectiveFrom:todayInKualaLumpur()})).rejects.toThrow('future');
  const invalid=policy();invalid.overtime.enabled=true;
  for(const key of ATTENDANCE_POLICY_DAY_CLASSES)invalid.overtime.days[key].patternVersionId=randomUUID();
  await expect(scheduleAttendanceGroupPolicy(ctx,{...input(),policy:invalid})).rejects.toThrow();
  expect(await attendanceGroupPolicyHistory(ctx,{companyId:b.companyId,ruleId})).toEqual([]);
 });
 it('checks current grants and module status before returning history or writing new versions',async()=>{
  await scheduleAttendanceGroupPolicy(ctx,input());
  await setModule(b.tenantId,'attendance','disabled');
  await expect(attendanceGroupPolicyHistory(await entitledCtx(b),{companyId:b.companyId,ruleId})).rejects.toThrow();
  await setModule(b.tenantId,'attendance','active');
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,ctx.userId!));
  expect(await withTenant(ctx,tx=>tx.select({id:s.attendanceGroupPolicyRevision.id}).from(s.attendanceGroupPolicyRevision))).toEqual([]);
  await expect(attendanceGroupPolicyHistory(ctx,{companyId:b.companyId,ruleId})).rejects.toThrow();
  await expect(scheduleAttendanceGroupPolicy(ctx,{...input(),expectedOrdinal:1,effectiveFrom:plus(2)})).rejects.toThrow();
 });
});
