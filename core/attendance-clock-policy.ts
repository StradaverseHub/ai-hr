/** Company-specific clock policies are independent of overtime activation and pattern versions. */
import {and,asc,desc,eq,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {attendanceClockPolicyRevision,company} from '../db/schema';
import {validateAttendanceClockPolicy,type AttendanceClockPolicy} from '../lib/attendance-clock-policy';
import {attendanceGroupPolicyActivationDate} from '../lib/attendance-group-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {overtimeDate,overtimeUuid} from '../lib/overtime-pattern-schema';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {assertModuleGate,withAttendanceTenant} from './module-gate';

type ClockPolicyScope = {companyId:string;ruleId:string};
export type AttendanceClockPolicyVersion = {id:string;ordinal:number;effectiveFrom:string;policy:AttendanceClockPolicy};

function scopedRevision(ctx:SessionContext,p:ClockPolicyScope) {
  return and(eq(attendanceClockPolicyRevision.tenantId,ctx.tenantId),
    eq(attendanceClockPolicyRevision.companyId,overtimeUuid(p.companyId,'companyId')),
    eq(attendanceClockPolicyRevision.ruleId,overtimeUuid(p.ruleId,'ruleId')));
}
const summary={
  id:attendanceClockPolicyRevision.id,
  ordinal:attendanceClockPolicyRevision.ordinal,
  effectiveFrom:attendanceClockPolicyRevision.effectiveFrom,
  policy:attendanceClockPolicyRevision.policy,
};

async function requireCompanyAdminTx(tx:Tx,ctx:SessionContext,companyId:string) {
  const [row]=await tx.select({allowed:sql<boolean>`app.attendance_policy_principal_current() and app.is_admin_for(${company.id})`})
    .from(company).where(and(eq(company.id,companyId),eq(company.tenantId,ctx.tenantId))).limit(1);
  if(!row?.allowed)throw new Error('This clock policy is outside your company administrator scope.');
}

/** Internal lookup. The caller supplies the canonical employer and Schedule Group for the business day. */
export async function attendanceClockPolicyOnTx(
  tx:Tx,ctx:SessionContext,p:ClockPolicyScope & {date:string},
):Promise<AttendanceClockPolicyVersion|null> {
  const date=overtimeDate(p.date,'attendanceDate');
  const [row]=await tx.select(summary).from(attendanceClockPolicyRevision)
    .where(and(scopedRevision(ctx,p),lte(attendanceClockPolicyRevision.effectiveFrom,date)))
    .orderBy(desc(attendanceClockPolicyRevision.effectiveFrom)).limit(1);
  return row?{...row,policy:validateAttendanceClockPolicy(row.policy)}:null;
}

/** Cheap import preflight. RLS limits the existence result to the caller's visible companies. */
export async function hasAttendanceClockPoliciesTx(tx:Tx,ctx:SessionContext,throughDate:string):Promise<boolean> {
  const date=overtimeDate(throughDate,'attendanceDate');
  const [row]=await tx.select({id:attendanceClockPolicyRevision.id}).from(attendanceClockPolicyRevision)
    .where(and(eq(attendanceClockPolicyRevision.tenantId,ctx.tenantId),lte(attendanceClockPolicyRevision.effectiveFrom,date))).limit(1);
  return row!==undefined;
}

export async function attendanceClockPolicyHistory(
  ctx:SessionContext,p:ClockPolicyScope,
):Promise<(AttendanceClockPolicyVersion & {reason:string})[]> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  p={...p};
  const where=scopedRevision(ctx,p);
  return withAttendanceTenant(ctx,async tx=>{
    await requireCompanyAdminTx(tx,ctx,p.companyId);
    const rows=await tx.select({...summary,reason:attendanceClockPolicyRevision.reason}).from(attendanceClockPolicyRevision)
      .where(where).orderBy(asc(attendanceClockPolicyRevision.ordinal)).limit(501);
    if(rows.length>500)throw new Error('This clock policy history exceeds the supported review limit.');
    await requireCompanyAdminTx(tx,ctx,p.companyId);
    return rows.map(row=>({...row,policy:validateAttendanceClockPolicy(row.policy)}));
  });
}

/** Join the same barriers before creating a new group and clock policy in one transaction. */
export async function lockAttendanceClockPolicyConfigurationTx(tx:Tx,ctx:SessionContext) {
  assertModuleGate(ctx,'attendance');
  await tx.execute(sql`select app.lock_attendance_clock_policy_configuration(${ctx.tenantId}::uuid)`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
}

export async function scheduleAttendanceClockPolicy(
  ctx:SessionContext,
  input:ClockPolicyScope & {expectedOrdinal:number;effectiveFrom:string;reason:string;policy:unknown},
  existingTx?:Tx,
):Promise<{id:string;ordinal:number;effectiveFrom:string}> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  const p={...input,companyId:overtimeUuid(input.companyId,'companyId').toLowerCase(),
    ruleId:overtimeUuid(input.ruleId,'ruleId').toLowerCase()};
  const actor=ctx.userId;
  if(!actor||!Number.isSafeInteger(p.expectedOrdinal)||p.expectedOrdinal<0||p.expectedOrdinal>=2147483647||
    typeof p.reason!=='string'||!p.reason.trim()||p.reason.trim().length>500)
    throw new Error('Provide the saved revision and a reason of up to 500 characters.');
  const effectiveFrom=attendanceGroupPolicyActivationDate(p.effectiveFrom,todayInKualaLumpur());
  const policy=validateAttendanceClockPolicy(p.policy);
  const reason=p.reason.trim();
  const write=async(tx:Tx)=>{
    await lockAttendanceClockPolicyConfigurationTx(tx,ctx);
    await requireCompanyAdminTx(tx,ctx,p.companyId);
    const [previous]=await tx.select({ordinal:summary.ordinal,effectiveFrom:summary.effectiveFrom})
      .from(attendanceClockPolicyRevision).where(scopedRevision(ctx,p))
      .orderBy(desc(attendanceClockPolicyRevision.ordinal)).limit(1);
    if((previous?.ordinal??0)!==p.expectedOrdinal||(previous&&previous.effectiveFrom>=effectiveFrom))
      throw new Error('Clock policy history changed. Reload and choose a date after the saved policy start.');
    const [saved]=await tx.insert(attendanceClockPolicyRevision).values({tenantId:ctx.tenantId,companyId:p.companyId,
      ruleId:p.ruleId,ordinal:p.expectedOrdinal+1,effectiveFrom,policy,reason,createdByUserId:actor})
      .returning({id:summary.id,ordinal:summary.ordinal,effectiveFrom:summary.effectiveFrom});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-rule',aggregateId:p.ruleId,
      eventType:'attendance-rule.clock-policy.scheduled',actor:actorOf(ctx),payload:{versionId:saved.id,
        companyId:p.companyId,previousOrdinal:p.expectedOrdinal,ordinal:saved.ordinal,effectiveFrom,reason,policy}});
    return saved;
  };
  return existingTx?write(existingTx):withAttendanceTenant(ctx,write);
}
