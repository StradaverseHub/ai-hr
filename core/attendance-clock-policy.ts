/** Company-specific clock policies are independent of overtime activation and pattern versions.
 * c03670cc (4600) — a revision with no company is GROUP-WIDE: it applies to every company in the tenant,
 * including companies created later, unless that company has its own revision effective on the date. */
import {and,asc,desc,eq,isNull,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {attendanceClockPolicyRevision,company} from '../db/schema';
import {validateAttendanceClockPolicy,type AttendanceClockPolicy} from '../lib/attendance-clock-policy';
import {attendanceGroupPolicyActivationDate} from '../lib/attendance-group-policy';
import {GROUP_CLOCK_SCOPE_KEY,nextIsoDate,sameClockPolicy,type ClockScope} from '../lib/schedule-clock-scope';
import {todayInKualaLumpur} from '../lib/hr-date';
import {overtimeDate,overtimeUuid} from '../lib/overtime-pattern-schema';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {assertModuleGate,withAttendanceTenant} from './module-gate';

type ClockPolicyScope = {companyId:string;ruleId:string};
/** `companyId: null` is the group-wide chain. */
type ClockPolicyChain = {companyId:string|null;ruleId:string};
export type AttendanceClockPolicyVersion = {id:string;ordinal:number;effectiveFrom:string;policy:AttendanceClockPolicy};

function chainRevision(ctx:SessionContext,p:ClockPolicyChain) {
  return and(eq(attendanceClockPolicyRevision.tenantId,ctx.tenantId),
    p.companyId===null?isNull(attendanceClockPolicyRevision.companyId)
      :eq(attendanceClockPolicyRevision.companyId,overtimeUuid(p.companyId,'companyId')),
    eq(attendanceClockPolicyRevision.ruleId,overtimeUuid(p.ruleId,'ruleId')));
}
/** Reads select only these columns, so a column-scoped SELECT grant on audit fields keeps working. */
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

/** All Companies is a group administrator's decision; a company-scoped administrator cannot make it. */
async function requireGroupAdminTx(tx:Tx) {
  const [row]=await tx.execute<{allowed:boolean}>(sql`select (app.attendance_policy_principal_current() and app.is_group_admin()) is true as allowed`);
  if(!row?.allowed)throw new Error('Only a group administrator can apply clock settings to All Companies.');
}

async function latestOnTx(tx:Tx,ctx:SessionContext,p:ClockPolicyChain,date:string){
  const [row]=await tx.select(summary).from(attendanceClockPolicyRevision)
    .where(and(chainRevision(ctx,p),lte(attendanceClockPolicyRevision.effectiveFrom,date)))
    .orderBy(desc(attendanceClockPolicyRevision.effectiveFrom)).limit(1);
  return row?{...row,policy:validateAttendanceClockPolicy(row.policy)}:null;
}

/** Internal lookup. The caller supplies the canonical employer and Schedule Group for the business day.
 * The company's own revision effective on the date wins, else the group-wide one, else null (legacy). */
export async function attendanceClockPolicyOnTx(
  tx:Tx,ctx:SessionContext,p:ClockPolicyScope & {date:string},
):Promise<AttendanceClockPolicyVersion|null> {
  const date=overtimeDate(p.date,'attendanceDate');
  return await latestOnTx(tx,ctx,{companyId:p.companyId,ruleId:p.ruleId},date)
    ?? await latestOnTx(tx,ctx,{companyId:null,ruleId:p.ruleId},date);
}

/** Cheap import preflight. RLS limits the existence result to the caller's visible companies and the
 * tenant's group-wide rows. */
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
  const companyId=overtimeUuid(p.companyId,'companyId'),ruleId=overtimeUuid(p.ruleId,'ruleId');
  return withAttendanceTenant(ctx,async tx=>{
    await requireCompanyAdminTx(tx,ctx,companyId);
    const rows=await tx.execute<{id:string;ordinal:number;effectiveFrom:string;policy:unknown;reason:string}>(sql`
      select id,ordinal,effective_from::text as "effectiveFrom",policy,reason
      from app.attendance_clock_policy_history(${companyId}::uuid,${ruleId}::uuid) order by ordinal`);
    if(rows.length>500)throw new Error('This clock policy history exceeds the supported review limit.');
    await requireCompanyAdminTx(tx,ctx,companyId);
    return rows.map(row=>({...row,policy:validateAttendanceClockPolicy(row.policy)}));
  });
}

/** The group-wide chain for one Schedule Group. Configuration review is for administrators. */
export async function attendanceClockPolicyGroupHistory(
  ctx:SessionContext,p:{ruleId:string},
):Promise<AttendanceClockPolicyVersion[]> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  const where=chainRevision(ctx,{companyId:null,ruleId:p.ruleId});
  return withAttendanceTenant(ctx,async tx=>{
    const [row]=await tx.execute<{allowed:boolean}>(sql`select (app.attendance_policy_principal_current() and app.is_admin()) is true as allowed`);
    if(!row?.allowed)throw new Error('This clock policy is outside your administrator scope.');
    const rows=await tx.select(summary).from(attendanceClockPolicyRevision)
      .where(where).orderBy(asc(attendanceClockPolicyRevision.ordinal)).limit(501);
    if(rows.length>500)throw new Error('This clock policy history exceeds the supported review limit.');
    return rows.map(row=>({...row,policy:validateAttendanceClockPolicy(row.policy)}));
  });
}

/** Join the same barriers before creating a new group and clock policy in one transaction. */
export async function lockAttendanceClockPolicyConfigurationTx(tx:Tx,ctx:SessionContext) {
  assertModuleGate(ctx,'attendance');
  await tx.execute(sql`select app.lock_attendance_clock_policy_configuration(${ctx.tenantId}::uuid)`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
}

const cleanReason=(reason:unknown)=>{
  if(typeof reason!=='string'||!reason.trim()||reason.trim().length>500)
    throw new Error('Provide the saved revision and a reason of up to 500 characters.');
  return reason.trim();
};

async function insertRevisionTx(tx:Tx,ctx:SessionContext,p:ClockPolicyChain&{ordinal:number;effectiveFrom:string;
  reason:string;policy:AttendanceClockPolicy;previousOrdinal:number}) {
  const [saved]=await tx.insert(attendanceClockPolicyRevision).values({tenantId:ctx.tenantId,companyId:p.companyId,
    ruleId:p.ruleId,ordinal:p.ordinal,effectiveFrom:p.effectiveFrom,policy:p.policy,reason:p.reason,createdByUserId:ctx.userId!})
    .returning({id:summary.id,ordinal:summary.ordinal,effectiveFrom:summary.effectiveFrom});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-rule',aggregateId:p.ruleId,
    eventType:'attendance-rule.clock-policy.scheduled',actor:actorOf(ctx),payload:{versionId:saved.id,
      companyId:p.companyId,scope:p.companyId===null?'group':'company',previousOrdinal:p.previousOrdinal,
      ordinal:saved.ordinal,effectiveFrom:p.effectiveFrom,reason:p.reason,policy:p.policy}});
  return saved;
}

/** Low-level single-chain writer with an explicit future date. Schedule Group screens use
 * saveScheduleGroupClockPolicy, which supplies the date and reason itself. */
export async function scheduleAttendanceClockPolicy(
  ctx:SessionContext,
  input:{companyId:string|null;ruleId:string} & {expectedOrdinal:number;effectiveFrom:string;reason:string;policy:unknown},
  existingTx?:Tx,
):Promise<{id:string;ordinal:number;effectiveFrom:string}> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  const p={...input,companyId:input.companyId===null?null:overtimeUuid(input.companyId,'companyId').toLowerCase(),
    ruleId:overtimeUuid(input.ruleId,'ruleId').toLowerCase()};
  if(!ctx.userId||!Number.isSafeInteger(p.expectedOrdinal)||p.expectedOrdinal<0||p.expectedOrdinal>=2147483647)
    throw new Error('Provide the saved revision and a reason of up to 500 characters.');
  const reason=cleanReason(p.reason);
  const effectiveFrom=attendanceGroupPolicyActivationDate(p.effectiveFrom,todayInKualaLumpur());
  const policy=validateAttendanceClockPolicy(p.policy);
  const write=async(tx:Tx)=>{
    await lockAttendanceClockPolicyConfigurationTx(tx,ctx);
    if(p.companyId===null)await requireGroupAdminTx(tx);else await requireCompanyAdminTx(tx,ctx,p.companyId);
    const [previous]=await tx.select({ordinal:summary.ordinal,effectiveFrom:summary.effectiveFrom})
      .from(attendanceClockPolicyRevision).where(chainRevision(ctx,p))
      .orderBy(desc(attendanceClockPolicyRevision.ordinal)).limit(1);
    if((previous?.ordinal??0)!==p.expectedOrdinal||(previous&&previous.effectiveFrom>=effectiveFrom))
      throw new Error('Clock policy history changed. Reload and choose a date after the saved policy start.');
    return insertRevisionTx(tx,ctx,{companyId:p.companyId,ruleId:p.ruleId,ordinal:p.expectedOrdinal+1,effectiveFrom,
      reason,policy,previousOrdinal:p.expectedOrdinal});
  };
  return existingTx?write(existingTx):withAttendanceTenant(ctx,write);
}

export type ScheduleGroupClockSaveResult = {
  saved:{companyId:string|null;id:string;ordinal:number;effectiveFrom:string}[];
  unchanged:(string|null)[];
};

/**
 * The Schedule Group Attendance tab's clock writer (c03670cc).
 *
 * All Companies writes ONE group-wide revision (group administrators only). Specific companies write
 * one revision per selected company, all in this one transaction, each against its own expected
 * ordinal. Each revision starts on the later of tomorrow (Malaysia) and the day after that chain's
 * latest saved start, so attendance already captured is never reworked and history stays append-only.
 * A chain whose latest saved settings already equal the submitted ones gets no new revision. Existing
 * attendance and payroll are never recalculated here.
 */
export async function saveScheduleGroupClockPolicy(
  ctx:SessionContext,
  input:{ruleId:string;scope:ClockScope;policy:unknown;expected:Record<string,number>;reason:string},
  existingTx?:Tx,
):Promise<ScheduleGroupClockSaveResult> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if(!ctx.userId)throw new Error('Sign in again before saving clock settings.');
  const ruleId=overtimeUuid(input.ruleId,'ruleId').toLowerCase();
  const policy=validateAttendanceClockPolicy(input.policy);
  const reason=cleanReason(input.reason);
  const chains:(string|null)[]=input.scope.kind==='all'?[null]
    :[...new Set(input.scope.companyIds.map(id=>overtimeUuid(id,'companyId').toLowerCase()))];
  if(!chains.length)throw new Error('Choose All Companies or at least one company for the clock settings.');
  if(chains.length>500)throw new Error('Choose at most 500 companies at once.');
  const expected=Object.fromEntries(Object.entries(input.expected).map(([key,value])=>[key.toLowerCase(),value]));
  const write=async(tx:Tx):Promise<ScheduleGroupClockSaveResult>=>{
    await lockAttendanceClockPolicyConfigurationTx(tx,ctx);
    const today=todayInKualaLumpur();
    const tomorrow=nextIsoDate(today);
    const result:ScheduleGroupClockSaveResult={saved:[],unchanged:[]};
    for(const companyId of chains) {
      if(companyId===null)await requireGroupAdminTx(tx);else await requireCompanyAdminTx(tx,ctx,companyId);
      const key=companyId??GROUP_CLOCK_SCOPE_KEY;
      const [latest]=await tx.select({ordinal:summary.ordinal,effectiveFrom:summary.effectiveFrom,policy:summary.policy})
        .from(attendanceClockPolicyRevision).where(chainRevision(ctx,{companyId,ruleId}))
        .orderBy(desc(attendanceClockPolicyRevision.ordinal)).limit(1);
      const ordinal=latest?.ordinal??0;
      if(expected[key]!==ordinal)throw new Error('Clock settings changed. Reload this Schedule Group before saving.');
      if(latest&&sameClockPolicy(validateAttendanceClockPolicy(latest.policy),policy)){result.unchanged.push(companyId);continue;}
      const afterLatest=latest?nextIsoDate(latest.effectiveFrom):tomorrow;
      const effectiveFrom=attendanceGroupPolicyActivationDate(afterLatest>tomorrow?afterLatest:tomorrow,today);
      const saved=await insertRevisionTx(tx,ctx,{companyId,ruleId,ordinal:ordinal+1,effectiveFrom,reason,policy,previousOrdinal:ordinal});
      result.saved.push({companyId,...saved});
    }
    return result;
  };
  return existingTx?write(existingTx):withAttendanceTenant(ctx,write);
}
