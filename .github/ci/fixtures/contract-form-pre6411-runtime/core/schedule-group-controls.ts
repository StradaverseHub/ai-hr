import {rosterUuidSet} from './roster-write-batches';
import { liveArrangementsTx, pickArrangementOn, type ArrangementPeriod } from './shift-arrangement-resolve';
/** Canonical group controls. Exception revisions are immutable and forward dated. */
import { and, asc, eq, gte, lte, inArray, sql } from 'drizzle-orm';
import { withTenant, type Tx, type SessionContext } from '../db/client';
import {accessLockModeHeldTx,lockAccessConfigurationTx,lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {lockLeaveDependenciesTx,lockLeaveDependenciesWaitTx,lockLeaveDependencyConfigurationTx} from '../packs/leave/service';
import { attendanceExceptionRevision, attendanceRule, employment, shift, rosterAssignment } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { todayInKualaLumpur } from '../lib/hr-date';
import { isAdmin } from '../lib/authz-model';
import { lockPayrollForAttendanceChange, markPayrollForAttendanceChange } from '../packs/payroll/service';
export function scheduleGroupDisplayName(group:{name:string;label?:string|null}):string { return group.label?.trim()&&group.label.trim()!==group.name?`${group.label.trim()} — ${group.name}`:group.name; }
export async function exceptionLookupTx(tx:Tx) {
 const rows=await tx.select().from(attendanceExceptionRevision).orderBy(...EXCEPTION_REVISION_ORDER);
 return exceptionLookupFrom(rows);
}
/** exceptionLookupTx over its rows (every revision, by rule then effective date). */
export function exceptionLookupFrom(rows:readonly (typeof attendanceExceptionRevision.$inferSelect)[]){
 return (ruleId:string|null|undefined,date:string)=>{
  const applicable=rows.filter(r=>r.ruleId===ruleId && r.effectiveFrom<=date).reduce<typeof rows[number]|null>((a,b)=>!a||b.effectiveFrom>a.effectiveFrom?b:a,null);
  return {enabled:applicable?.enabled??false,revisionId:applicable?.id??null,effectiveFrom:applicable?.effectiveFrom??null};
 };
}
export const EXCEPTION_REVISION_ORDER=[asc(attendanceExceptionRevision.ruleId),asc(attendanceExceptionRevision.effectiveFrom)];
/** scheduleGroupLookupTx's selects, shared with the Before payroll statement (core/attendance.ts
 * attendanceRangeChecklistBundleSql), which reads the same rows as JSON sections. */
export const SCHEDULE_GROUP_EMPLOYEE_FIELDS={id:employment.id,groupId:employment.attendanceRuleId,defaultShiftId:employment.defaultShiftId};
export const SCHEDULE_GROUP_ROSTER_FIELDS={employmentId:rosterAssignment.employmentId,date:rosterAssignment.shiftDate,shiftId:rosterAssignment.shiftId,isRestDay:rosterAssignment.isRestDay};
export const SCHEDULE_GROUP_SHIFT_FIELDS={id:shift.id,ruleId:shift.ruleId};
export const scheduleGroupEmployeeWhere=(ids:readonly string[])=>rosterUuidSet(employment.id,ids);
export const scheduleGroupRosterWhere=(ids:readonly string[],from:string,to:string)=>and(rosterUuidSet(rosterAssignment.employmentId,ids),gte(rosterAssignment.shiftDate,from),lte(rosterAssignment.shiftDate,to));
type ScheduleGroupInputs={employees:readonly {id:string;groupId:string|null;defaultShiftId:string|null}[];
 roster:readonly {employmentId:string;date:string;shiftId:string|null;isRestDay:boolean}[];arrangements:ReadonlyMap<string,ArrangementPeriod[]>};
/** The shift ids scheduleGroupLookupTx reads the rule of: every default, rostered and arranged shift. */
export const scheduleGroupShiftIds=({employees,roster,arrangements}:ScheduleGroupInputs)=>
 [...new Set([...employees.flatMap(e=>e.defaultShiftId?[e.defaultShiftId]:[]),...roster.flatMap(r=>r.shiftId?[r.shiftId]:[]),...[...arrangements.values()].flatMap(rows=>rows.map(r=>r.shiftId))])];
/** Same calculation precedence as scheduleFor: explicit employment group, dated shift default, Standard. */
export async function scheduleGroupLookupTx(tx:Tx,ids:readonly string[],from:string,to:string){
 const employees=ids.length?await tx.select(SCHEDULE_GROUP_EMPLOYEE_FIELDS).from(employment).where(scheduleGroupEmployeeWhere(ids)):[];
 const roster=ids.length?await tx.select(SCHEDULE_GROUP_ROSTER_FIELDS).from(rosterAssignment).where(scheduleGroupRosterWhere(ids,from,to)):[];
 const arrangements=await liveArrangementsTx(tx,[...ids]);
 const shiftIds=scheduleGroupShiftIds({employees,roster,arrangements});
 const shifts=shiftIds.length?await tx.select(SCHEDULE_GROUP_SHIFT_FIELDS).from(shift).where(rosterUuidSet(shift.id,shiftIds)):[];
 const [standard]=await tx.select({id:attendanceRule.id}).from(attendanceRule).where(eq(attendanceRule.isDefault,true)).limit(1);
 return scheduleGroupLookupFrom({employees,roster,arrangements},shifts,standard);
}
/** scheduleGroupLookupTx over its rows. `shifts` may hold any superset of the shifts it names (each is found by id). */
export function scheduleGroupLookupFrom({employees,roster,arrangements}:ScheduleGroupInputs,shifts:readonly {id:string;ruleId:string|null}[],standard:{id:string}|undefined){
 return (employmentId:string,date:string)=>{
  const e=employees.find(e=>e.id===employmentId);if(!e)return null;
  if(e.groupId)return e.groupId;
  const assigned=roster.find(r=>r.employmentId===employmentId&&r.date===date);
  // An explicit rest day has no shift rule and resolves Standard (matching the policy branch).
  if(assigned)return assigned.shiftId?shifts.find(sh=>sh.id===assigned.shiftId)?.ruleId??standard?.id??null:standard?.id??null;
  const periods=arrangements.get(employmentId)??[];const dated=pickArrangementOn(periods,date);
  const shiftId=dated?.shiftId??(periods.length?null:e.defaultShiftId);
  return shifts.find(sh=>sh.id===shiftId)?.ruleId??standard?.id??null;
 };
}
export async function exceptionDecisionsTx(tx:Tx,ids:readonly string[],from:string,to:string){
 const groupOn=await scheduleGroupLookupTx(tx,ids,from,to),exceptionOn=await exceptionLookupTx(tx);
 return exceptionDecisionsFrom(groupOn,exceptionOn);
}
export function exceptionDecisionsFrom(groupOn:ReturnType<typeof scheduleGroupLookupFrom>,exceptionOn:ReturnType<typeof exceptionLookupFrom>){
 return (employmentId:string,date:string)=>exceptionOn(groupOn(employmentId,date),date);
}

export function scheduleGroupControls(ctx:SessionContext,ruleId:string) {
 return withTenant(ctx,async tx=>{
  const [rule]=await tx.select().from(attendanceRule).where(eq(attendanceRule.id,ruleId));
  if(!rule)throw new Error('Schedule Group not found.');
  const revisions=await tx.select().from(attendanceExceptionRevision).where(eq(attendanceExceptionRevision.ruleId,ruleId)).orderBy(asc(attendanceExceptionRevision.effectiveFrom));
  return {label:rule.label,dutyRosterControl:rule.dutyRosterControl,revisions};
 });
}
export function saveScheduleGroupControl(ctx:SessionContext,p:{ruleId:string;kind:'exception'|'duty';enabled:boolean}) {
 p={...p};ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!isAdmin(ctx))throw new Error('Only an HR administrator can change Schedule Group controls.');
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  const [rule]=await tx.select().from(attendanceRule).where(eq(attendanceRule.id,p.ruleId)).for('update');
  if(!rule)throw new Error('Schedule Group not found.');
  if(p.kind==='duty') {
   if(rule.dutyRosterControl===p.enabled)return {effectiveFrom:null};
   await tx.update(attendanceRule).set({dutyRosterControl:p.enabled,updatedAt:new Date()}).where(eq(attendanceRule.id,p.ruleId));
   await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-rule',aggregateId:p.ruleId,eventType:'attendance-rule.duty-roster-control.changed',actor:actorOf(ctx),payload:{before:rule.dutyRosterControl,enabled:p.enabled}});
   return {effectiveFrom:null};
  }
  if(p.kind!=='exception')throw new Error('Unknown Schedule Group control.');
  const effectiveFrom=new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const revisions=await tx.select().from(attendanceExceptionRevision).where(eq(attendanceExceptionRevision.ruleId,p.ruleId)).orderBy(asc(attendanceExceptionRevision.effectiveFrom));
  const existing=revisions.find(r=>r.effectiveFrom===effectiveFrom);
  if(existing){if(existing.enabled===p.enabled)return {effectiveFrom};throw new Error('A saved exception revision already takes effect tomorrow. Wait until it starts before scheduling the next change.');}
  const previous=revisions.reduce<typeof revisions[number]|null>((a,b)=>!a||b.effectiveFrom>a.effectiveFrom?b:a,null);
  if((previous?.enabled??false)===p.enabled)return {effectiveFrom:previous?.effectiveFrom??null};
  await tx.insert(attendanceExceptionRevision).values({tenantId:ctx.tenantId,ruleId:p.ruleId,enabled:p.enabled,effectiveFrom,createdBy:ctx.userId??'system'});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-rule',aggregateId:p.ruleId,eventType:'attendance-rule.exception.scheduled',actor:actorOf(ctx),payload:{before:previous?.enabled??false,enabled:p.enabled,effectiveFrom,scope:['absent','late','early_out']}});
  return {effectiveFrom};
 });
}
/** No caller-supplied purpose can bypass this guard. Automatic rotations are derived, not manual rows. */
export class DutyRosterWriteRefusal extends Error {constructor(readonly category:'permission'|'validation',message:string){super(message);this.name='DutyRosterWriteRefusal';}}
export async function assertDutyRosterWriteTx(tx:Tx,ctx:SessionContext,changes:readonly {employmentId:string;shiftDate:string;shiftId?:string|null;isRestDay?:boolean;note?:string|null;clear?:boolean}[]) {
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!isAdmin(ctx))throw new DutyRosterWriteRefusal('permission','Only an HR administrator can change the roster.');
 changes=changes.map(change=>({...change}));
 const ids=[...new Set(changes.map(c=>c.employmentId))];if(!ids.length)return;
 // A cell edit writes only its employees' roster days, so it shares the Access lock and waits for their
 // employment locks; those and the employment rows below serialise it with every other writer of the same
 // people. Bulk batches take the exclusive lock first and keep it, with the original no-wait subject locks.
 if(await accessLockModeHeldTx(tx,ctx.tenantId)==='X')await lockLeaveDependenciesTx(tx,ctx.tenantId,ids);
 else{await lockAccessConfigurationTx(tx,ctx.tenantId);await lockLeaveDependenciesWaitTx(tx,ctx.tenantId,ids);}
 const employees=await tx.select({id:employment.id,groupId:employment.attendanceRuleId,defaultShiftId:employment.defaultShiftId}).from(employment).where(rosterUuidSet(employment.id,ids)).orderBy(asc(employment.id)).for('update');
 if(employees.length!==ids.length)throw new DutyRosterWriteRefusal('permission','An employee is unavailable in your company scope.');
 const rules=await tx.select().from(attendanceRule).orderBy(asc(attendanceRule.id)).for('update');
 const targetIds=[...new Set(changes.flatMap(c=>c.shiftId?[c.shiftId]:[]))];
 // Group rows, then the target shifts, both in id order and before any payroll lock or audit event: the
 // order assertShiftsAllowedForEmploymentsTx takes them in. Under the shared lock a cell writer must already
 // own these rows when it appends its event, or it could wait for a shift held by a writer that is waiting
 // for the audit chain this transaction then holds.
 if(targetIds.length)await tx.select({id:shift.id}).from(shift).where(rosterUuidSet(shift.id,targetIds)).orderBy(asc(shift.id)).for('update');
 const targetShifts=targetIds.length?await tx.select({id:shift.id,ruleId:shift.ruleId}).from(shift).where(rosterUuidSet(shift.id,targetIds)):[];
 const allDates=changes.map(c=>c.shiftDate).sort();const groupOn=await scheduleGroupLookupTx(tx,ids,allDates[0],allDates.reduce((a,b)=>a>b?a:b));
 for(const emp of employees){
  const [permission]=await tx.execute(sql`select app.can_admin_employment(${emp.id}::uuid) as allowed`) as unknown as {allowed:boolean}[];
  if(!permission?.allowed)throw new DutyRosterWriteRefusal('permission','You cannot administer this employee.');
  const ownGroups=[...new Set(changes.filter(c=>c.employmentId===emp.id).flatMap(c=>[groupOn(emp.id,c.shiftDate),...(!emp.groupId&&c.shiftId?[targetShifts.find(sh=>sh.id===c.shiftId)?.ruleId??null]:[])]))];
  const group=rules.find(r=>r.id===ownGroups[0]);
  for(const id of ownGroups){const applicable=rules.find(r=>r.id===id);if(applicable&&!applicable.dutyRosterControl)throw new DutyRosterWriteRefusal('validation',`Duty Roster Control is Off for “${scheduleGroupDisplayName(applicable)}”. Enable it before changing an individual roster.`);}
  const own=changes.filter(c=>c.employmentId===emp.id);
  const dates=[...new Set(own.map(c=>c.shiftDate))].sort();
  for(const date of dates)if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T00:00:00Z')))throw new DutyRosterWriteRefusal('validation','Choose a valid roster date.');
  // The canonical owner already accepts the complete date set: it locks every
  // existing Attendance/OT day in order, then reads/locks Payroll once for this
  // employment. Repeating that same native Payroll query per date is unnecessary.
  const batches=await lockPayrollForAttendanceChange(tx,emp.id,dates);
  if(batches.some(b=>b.status==='closed'))throw new DutyRosterWriteRefusal('validation','The roster change touches a closed payroll attendance period.');
  await markPayrollForAttendanceChange(tx,ctx,batches,emp.id);
  const before=await tx.select().from(rosterAssignment).where(and(eq(rosterAssignment.employmentId,emp.id),inArray(rosterAssignment.shiftDate,dates))).orderBy(asc(rosterAssignment.shiftDate));
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:emp.id,eventType:'roster.manual-changes',subjectEmploymentId:emp.id,actor:actorOf(ctx),payload:{groupId:group?.id??null,changes:own.map(c=>({date:c.shiftDate,before:before.find(r=>r.shiftDate===c.shiftDate)??null,after:c.clear?null:{shiftId:c.shiftId??null,isRestDay:c.isRestDay??false,note:c.note??null}}))}});
 }
}
