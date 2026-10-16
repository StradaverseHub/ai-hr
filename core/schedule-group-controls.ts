import { liveArrangementsTx, pickArrangementOn } from './shift-arrangement-resolve';
/** Canonical group controls. Exception revisions are immutable and forward dated. */
import { and, asc, eq, gte, lte, inArray, sql } from 'drizzle-orm';
import { withTenant, type Tx, type SessionContext } from '../db/client';
import { attendanceExceptionRevision, attendanceRule, employment, shift, rosterAssignment } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { todayInKualaLumpur } from '../lib/hr-date';
import { isAdmin } from '../lib/authz';
import { lockPayrollForAttendanceChange, markPayrollForAttendanceChange } from '../packs/payroll/service';
export function scheduleGroupDisplayName(group:{name:string;label?:string|null}):string { return group.label?.trim()&&group.label.trim()!==group.name?`${group.label.trim()} — ${group.name}`:group.name; }
export async function exceptionLookupTx(tx:Tx) {
 const rows=await tx.select().from(attendanceExceptionRevision).orderBy(asc(attendanceExceptionRevision.ruleId),asc(attendanceExceptionRevision.effectiveFrom));
 return (ruleId:string|null|undefined,date:string)=>{
  const applicable=rows.filter(r=>r.ruleId===ruleId && r.effectiveFrom<=date).reduce<typeof rows[number]|null>((a,b)=>!a||b.effectiveFrom>a.effectiveFrom?b:a,null);
  return {enabled:applicable?.enabled??false,revisionId:applicable?.id??null,effectiveFrom:applicable?.effectiveFrom??null};
 };
}
/** Same calculation precedence as scheduleFor: explicit employment group, dated shift default, Standard. */
export async function scheduleGroupLookupTx(tx:Tx,ids:readonly string[],from:string,to:string){
 const employees=ids.length?await tx.select({id:employment.id,groupId:employment.attendanceRuleId,defaultShiftId:employment.defaultShiftId}).from(employment).where(inArray(employment.id,[...ids])):[];
 const roster=ids.length?await tx.select({employmentId:rosterAssignment.employmentId,date:rosterAssignment.shiftDate,shiftId:rosterAssignment.shiftId,isRestDay:rosterAssignment.isRestDay}).from(rosterAssignment).where(and(inArray(rosterAssignment.employmentId,[...ids]),gte(rosterAssignment.shiftDate,from),lte(rosterAssignment.shiftDate,to))):[];
 const arrangements=await liveArrangementsTx(tx,[...ids]);
 const shiftIds=[...new Set([...employees.flatMap(e=>e.defaultShiftId?[e.defaultShiftId]:[]),...roster.flatMap(r=>r.shiftId?[r.shiftId]:[]),...[...arrangements.values()].flatMap(rows=>rows.map(r=>r.shiftId))])];
 const shifts=shiftIds.length?await tx.select({id:shift.id,ruleId:shift.ruleId}).from(shift).where(inArray(shift.id,shiftIds)):[];
 const [standard]=await tx.select({id:attendanceRule.id}).from(attendanceRule).where(eq(attendanceRule.isDefault,true)).limit(1);
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
 if(!isAdmin(ctx))throw new Error('Only an HR administrator can change Schedule Group controls.');
 return withTenant(ctx,async tx=>{
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
export async function assertDutyRosterWriteTx(tx:Tx,ctx:SessionContext,changes:readonly {employmentId:string;shiftDate:string;shiftId?:string|null;isRestDay?:boolean;note?:string|null;clear?:boolean}[]) {
 if(!isAdmin(ctx))throw new Error('Only an HR administrator can change the roster.');
 const ids=[...new Set(changes.map(c=>c.employmentId))];if(!ids.length)return;
 const employees=await tx.select({id:employment.id,groupId:employment.attendanceRuleId,defaultShiftId:employment.defaultShiftId}).from(employment).where(inArray(employment.id,ids)).orderBy(asc(employment.id)).for('update');
 if(employees.length!==ids.length)throw new Error('An employee is unavailable in your company scope.');
 const rules=await tx.select().from(attendanceRule).orderBy(asc(attendanceRule.id)).for('update');
 const targetIds=[...new Set(changes.flatMap(c=>c.shiftId?[c.shiftId]:[]))];
 const targetShifts=targetIds.length?await tx.select({id:shift.id,ruleId:shift.ruleId}).from(shift).where(inArray(shift.id,targetIds)):[];
 const allDates=changes.map(c=>c.shiftDate).sort();const groupOn=await scheduleGroupLookupTx(tx,ids,allDates[0],allDates.reduce((a,b)=>a>b?a:b));
 for(const emp of employees){
  const [permission]=await tx.execute(sql`select app.can_admin_employment(${emp.id}::uuid) as allowed`) as unknown as {allowed:boolean}[];
  if(!permission?.allowed)throw new Error('You cannot administer this employee.');
  const ownGroups=[...new Set(changes.filter(c=>c.employmentId===emp.id).flatMap(c=>[groupOn(emp.id,c.shiftDate),...(!emp.groupId&&c.shiftId?[targetShifts.find(sh=>sh.id===c.shiftId)?.ruleId??null]:[])]))];
  const group=rules.find(r=>r.id===ownGroups[0]);
  for(const id of ownGroups){const applicable=rules.find(r=>r.id===id);if(applicable&&!applicable.dutyRosterControl)throw new Error(`Duty Roster Control is Off for “${scheduleGroupDisplayName(applicable)}”. Enable it before changing an individual roster.`);}
  const own=changes.filter(c=>c.employmentId===emp.id);
  const dates=[...new Set(own.map(c=>c.shiftDate))].sort();
  const byBatch=new Map<string,Awaited<ReturnType<typeof lockPayrollForAttendanceChange>>[number]>();
  for(const date of dates){if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T00:00:00Z')))throw new Error('Choose a valid roster date.');for(const batch of await lockPayrollForAttendanceChange(tx,emp.id,date))byBatch.set(batch.batchId,batch);}
  const batches=[...byBatch.values()];
  if(batches.some(b=>b.status==='closed'))throw new Error('The roster change touches a closed payroll attendance period.');
  await markPayrollForAttendanceChange(tx,ctx,batches,emp.id);
  const before=await tx.select().from(rosterAssignment).where(and(eq(rosterAssignment.employmentId,emp.id),inArray(rosterAssignment.shiftDate,dates))).orderBy(asc(rosterAssignment.shiftDate));
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:emp.id,eventType:'roster.manual-changes',subjectEmploymentId:emp.id,actor:actorOf(ctx),payload:{groupId:group?.id??null,changes:own.map(c=>({date:c.shiftDate,before:before.find(r=>r.shiftDate===c.shiftDate)??null,after:c.clear?null:{shiftId:c.shiftId??null,isRestDay:c.isRestDay??false,note:c.note??null}}))}});
 }
}
