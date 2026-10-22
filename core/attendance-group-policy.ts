/** One dated execution-policy owner, shared by Schedule Groups and the Overtime workspace.
 * The group/shift catalogue remains tenant-wide; execution and formula bindings are per employer.
 * Saving here does not approve a request, recalculate attendance or transfer a payment. */
import {and,asc,desc,eq,inArray,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {withAttendanceTenant} from './module-gate';
import {attendanceGroupPolicyRevision,attendanceRule,company,overtimePatternVersion,overtimePatternVersionCompany} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {todayInKualaLumpur} from '../lib/hr-date';
import {attendanceGroupPolicyActivationDate,validateAttendanceGroupPolicy,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {overtimeDate,overtimeUuid} from '../lib/overtime-pattern-schema';

export type AttendanceGroupPolicyVersion=typeof attendanceGroupPolicyRevision.$inferSelect;
export type AttendanceGroupPolicyReview={
 rule:{id:string;name:string;label:string|null};
 history:AttendanceGroupPolicyVersion[];
 patterns:{versionId:string;patternId:string;name:string;ordinal:number}[];
};
export type ResolvedAttendanceGroupPolicy={id:string;companyId:string;ruleId:string;ordinal:number;effectiveFrom:string;policy:AttendanceGroupPolicy;activation:{epoch:number;actorUserId:string;recordedAt:string;reason:string}};
async function adminCompany(tx:Tx,ctx:SessionContext,companyId:string):Promise<void>{
 overtimeUuid(companyId,'companyId');
 const [row]=await tx.select({allowed:sql<boolean>`app.attendance_policy_principal_current() AND app.is_admin_for(${company.id})`}).from(company)
  .where(and(eq(company.id,companyId),eq(company.tenantId,ctx.tenantId))).limit(1);
 if(!row?.allowed)throw Error('This company policy is outside your administrator scope.');
}
export async function attendanceGroupPolicyHistory(ctx:SessionContext,p:{companyId:string;ruleId:string}):Promise<AttendanceGroupPolicyVersion[]>{
 overtimeUuid(p.ruleId,'ruleId');
 return withAttendanceTenant(ctx,async tx=>{
  await adminCompany(tx,ctx,p.companyId);
  return historyTx(tx,ctx,p);
 });
}
async function historyTx(tx:Tx,ctx:SessionContext,p:{companyId:string;ruleId:string}):Promise<AttendanceGroupPolicyVersion[]>{
 const rows=await tx.select().from(attendanceGroupPolicyRevision).where(and(eq(attendanceGroupPolicyRevision.tenantId,ctx.tenantId),
  eq(attendanceGroupPolicyRevision.companyId,p.companyId),eq(attendanceGroupPolicyRevision.ruleId,p.ruleId)))
  .orderBy(asc(attendanceGroupPolicyRevision.ordinal)).limit(501);
 if(rows.length>500)throw Error('This policy history exceeds the supported review limit.');
 return rows.map(row=>({...row,policy:validateAttendanceGroupPolicy(row.policy,4320)}));
}
/** The central workspace reviews these same immutable group policies, not a copied rate table.
 * Labels are joined only for the exact selected employer; a missing readable version stays unknown.
 * This read neither schedules a policy nor recalculates/approves attendance. */
export function attendanceGroupPolicyReview(ctx:SessionContext,p:{companyId:string;ruleId:string}):Promise<AttendanceGroupPolicyReview|null>{
 overtimeUuid(p.ruleId,'ruleId');
 return withAttendanceTenant(ctx,async tx=>{
  await adminCompany(tx,ctx,p.companyId);
  const [rule]=await tx.select({id:attendanceRule.id,name:attendanceRule.name,label:attendanceRule.label}).from(attendanceRule)
   .where(and(eq(attendanceRule.id,p.ruleId),eq(attendanceRule.tenantId,ctx.tenantId))).limit(1);
  if(!rule)return null;
  const history=await historyTx(tx,ctx,p);
  const ids=[...new Set(history.flatMap(row=>Object.values(row.policy.overtime.days).flatMap(day=>day.patternVersionId?[day.patternVersionId]:[])))];
  const patterns=ids.length?await tx.select({versionId:overtimePatternVersion.id,patternId:overtimePatternVersion.patternId,
   name:overtimePatternVersion.name,ordinal:overtimePatternVersion.ordinal}).from(overtimePatternVersion)
   .innerJoin(overtimePatternVersionCompany,and(eq(overtimePatternVersionCompany.versionId,overtimePatternVersion.id),
    eq(overtimePatternVersionCompany.tenantId,ctx.tenantId),eq(overtimePatternVersionCompany.companyId,p.companyId)))
   .where(and(eq(overtimePatternVersion.tenantId,ctx.tenantId),inArray(overtimePatternVersion.id,ids),
    sql`app.attendance_policy_principal_current() AND app.is_admin_for(${p.companyId}::uuid)`))
   .orderBy(asc(overtimePatternVersion.patternId),asc(overtimePatternVersion.ordinal)):[];
  // A current-authority refusal during this multi-statement read must not look like an empty
  // history (legacy mode). Recheck before returning the composed review.
  await adminCompany(tx,ctx,p.companyId);
  return {rule,history,patterns};
 });
}
/** Internal canonical reader. The caller proves the subject's dated employer and resolved group;
 * neither a form nor a clock submission may supply those identities as an authorization bypass. */
export async function attendanceGroupPolicyOnTx(tx:Tx,ctx:SessionContext,p:{companyId:string;ruleId:string;date:string}):Promise<ResolvedAttendanceGroupPolicy|null>{
 overtimeUuid(p.companyId,'companyId');overtimeUuid(p.ruleId,'ruleId');overtimeDate(p.date,'attendanceDate');
 const [row]=await tx.select().from(attendanceGroupPolicyRevision).where(and(eq(attendanceGroupPolicyRevision.tenantId,ctx.tenantId),
  eq(attendanceGroupPolicyRevision.companyId,p.companyId),eq(attendanceGroupPolicyRevision.ruleId,p.ruleId),lte(attendanceGroupPolicyRevision.effectiveFrom,p.date)))
  .orderBy(desc(attendanceGroupPolicyRevision.effectiveFrom),desc(attendanceGroupPolicyRevision.ordinal)).limit(1);
 if(!row)return null;
 return {id:row.id,companyId:row.companyId,ruleId:row.ruleId,ordinal:row.ordinal,effectiveFrom:row.effectiveFrom,policy:validateAttendanceGroupPolicy(row.policy,4320),activation:{epoch:row.activationEpoch,actorUserId:row.createdByUserId,recordedAt:row.createdAt.toISOString(),reason:row.reason}};
}
export async function scheduleAttendanceGroupPolicy(ctx:SessionContext,p:{companyId:string;ruleId:string;expectedOrdinal:number;
 effectiveFrom:string;reason:string;policy:unknown}):Promise<{id:string;ordinal:number;effectiveFrom:string}>{
 overtimeUuid(p.ruleId,'ruleId');
 if(!ctx.userId||!Number.isSafeInteger(p.expectedOrdinal)||p.expectedOrdinal<0||typeof p.reason!=='string'||!p.reason.trim()||p.reason.trim().length>500)
  throw Error('Provide the saved revision and a reason for the policy change.');
 const effectiveFrom=attendanceGroupPolicyActivationDate(p.effectiveFrom,todayInKualaLumpur());
 const policy=validateAttendanceGroupPolicy(p.policy,4320);
 return withAttendanceTenant(ctx,async tx=>{
  // Access/profile authority writers take this barrier before their data locks. Recheck current
  // scope after waiting for them, then take the central overtime configuration lock below.
  await tx.execute(sql`select app.access_profile_policy_write_lock()`);
  await adminCompany(tx,ctx,p.companyId);
  // Same serial configuration lock as the central pattern owner and its DB trigger.
  await tx.execute(sql`select app.lock_overtime_configuration(${ctx.tenantId}::uuid)`);
  const [previous]=await tx.select({ordinal:attendanceGroupPolicyRevision.ordinal,effectiveFrom:attendanceGroupPolicyRevision.effectiveFrom})
   .from(attendanceGroupPolicyRevision).where(and(eq(attendanceGroupPolicyRevision.tenantId,ctx.tenantId),
    eq(attendanceGroupPolicyRevision.companyId,p.companyId),eq(attendanceGroupPolicyRevision.ruleId,p.ruleId)))
   .orderBy(desc(attendanceGroupPolicyRevision.ordinal)).limit(1);
  if((previous?.ordinal??0)!==p.expectedOrdinal||previous&&previous.effectiveFrom>=effectiveFrom)
   throw Error('Policy history changed. Reload and choose a date after the saved policy start.');
  const [saved]=await tx.insert(attendanceGroupPolicyRevision).values({tenantId:ctx.tenantId,companyId:p.companyId,
   ruleId:p.ruleId,ordinal:p.expectedOrdinal+1,effectiveFrom,policy,reason:p.reason.trim(),createdByUserId:ctx.userId!})
   .returning({id:attendanceGroupPolicyRevision.id,ordinal:attendanceGroupPolicyRevision.ordinal,effectiveFrom:attendanceGroupPolicyRevision.effectiveFrom});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-rule',aggregateId:p.ruleId,
   eventType:'attendance-rule.policy.scheduled',actor:actorOf(ctx),payload:{versionId:saved.id,companyId:p.companyId,
    previousOrdinal:p.expectedOrdinal,ordinal:saved.ordinal,effectiveFrom,reason:p.reason.trim(),policy}});
  return saved;
 });
}
