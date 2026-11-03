/** AI v2 Phase 2 P2-1 — the missed clock-outs loop's automatic step, at Level 2 (Act within limits) and above.
 *
 * The loop sets a missed clock-out to the roster end itself, only when every condition holds, and always through the
 * attendance owner (packs/attendance/service), never by writing an attendance row:
 *  - Conditions, read under the sponsor's current authority: the day still has a clock-in and no clock-out, exactly as
 *    the case recorded; no approved leave that day (packs/leave/service approvedLeavePresenceByEmploymentTx, part days
 *    included); the day is not the sponsor's own; and the condition the group administrator chose: "roster end and site
 *    exit agree" (the product records no site exit today, so the loop then never acts and leaves the card for the person),
 *    or "roster end, no approved leave and no other clocking that day" (the one clock-in and nothing else).
 *  - Apply: the attendance owner's own clock-data correction, the path HR uses on an employee's attendance day: the day's
 *    clockings plus one clock-out at the roster end, requested and approved through the owner in one transaction under
 *    the sponsor's authority, so every owner check runs (locks, payroll closed). The transaction carries the loop's
 *    attribution (core/loops/attribution.ts), so the correction and every event record the loop, its agent principal and
 *    the sponsor who answers for it, never the sponsor alone. A correction the owner routes to an approval workflow, or a
 *    fix that would create overtime, keeps nothing: the card stays with the person. The same transaction appends the
 *    notice event that tells the employee (core/notifications.ts 'teras-loop.action.applied').
 *  - Observe: whether the clock-out the loop set still stands; a later different or removed clock-out is a person's
 *    change, and counts against the loop (core/loops/act.ts demotion).
 *  - Compensate (undo): the owner's clock-data correction again, voiding only the clock-out the loop added. The original
 *    clockings stay, and nothing is deleted.
 * No pay, rate or overtime figure is read or written here; the attendance owner recomputes the day itself. No model. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appendEvent} from '../../db/events';
import {attendance,attendanceWorkflowRequest,domainEvent,employment} from '../../db/schema';
import {AttendancePayrollClosedError,attendanceCorrectionClockSourceTx,attendanceForEmploymentsRange,decideAttendanceCorrection,requestAttendanceCorrection} from '../../packs/attendance/service';
import {approvedLeavePresenceByEmploymentTx} from '../../packs/leave/service';
import {clockOf,unique} from './detect';
import {setLoopAttributionTx} from './attribution';
import type {LoopAttribution} from '../../lib/ai-centre/loop-attribution';
import type {LoopActionCheck,LoopActionFacts,LoopActionReason,LoopLimits,UndoneBy} from './autonomy-types';

export const CLOCK_OUT_ACT_VERSION='loop_missed_clock_outs.act@v1';
const SOURCE='packs/attendance/service.ts#attendanceCorrectionClockSourceTx';
const LEAVE='packs/leave/service.ts#approvedLeavePresenceByEmploymentTx';
const OWNER='packs/attendance/service.ts#requestAttendanceCorrection';

export class LoopActRefused extends Error{constructor(readonly reason:LoopActionReason){super('Loop action not applied: '+reason);this.name='LoopActRefused';}}
export class LoopUndoRefused extends Error{constructor(readonly reason:'changed'|'unavailable'){super('Loop undo refused: '+reason);this.name='LoopUndoRefused';}}

export type ClockOutCandidate=Readonly<{caseId:string;companyId:string;employmentId:string;date:string;checkIn:string;proposedCheckOut:string}>;
export type ClockOutEvaluation=Readonly<{ok:boolean;reason:LoopActionReason|null;checks:readonly LoopActionCheck[]}>;
const check=(name:string,ruleVersion:string|null,ok:boolean):LoopActionCheck=>Object.freeze({check:name,ruleVersion,result:ok?'pass':'fail'});
const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const isClock=(value:unknown):value is string=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/** A case's facts as a candidate, or null when the case lacks what the action needs. */
export function clockOutCandidate(row:Readonly<{id:string;companyId:string;employmentId:string|null;facts:Readonly<Record<string,unknown>>}>):ClockOutCandidate|null{
 const {date,checkIn,proposedCheckOut}=row.facts;
 return row.employmentId&&isDate(date)&&isClock(checkIn)&&isClock(proposedCheckOut)
  ?Object.freeze({caseId:row.id,companyId:row.companyId,employmentId:row.employmentId,date,checkIn,proposedCheckOut}):null;
}

type ClockRow=Readonly<{id:string;punchAt:string;direction:'in'|'out';voided:boolean}>;
async function clockRowsTx(tx:Tx,employmentId:string,date:string){
 const source=await attendanceCorrectionClockSourceTx(tx,employmentId,date);
 return {baseline:source.baseline,rows:source.rows.map(row=>({id:row.id,punchAt:String(row.punchAt),direction:row.direction as 'in'|'out',voided:row.voided})) as ClockRow[]};
}
/** The day as the case saw it: at least one clock-in, no clock-out, the first clock-in the one on the card. */
const dayUnchanged=(rows:readonly ClockRow[],checkIn:string)=>{
 const active=rows.filter(row=>!row.voided);
 const ins=active.filter(row=>row.direction==='in').map(row=>row.punchAt.slice(0,5)).sort();
 return ins.length>0&&!active.some(row=>row.direction==='out')&&ins[0]===checkIn;
};
/** "No other clocking that day": the one clock-in on record and nothing else. */
const onlyTheClockIn=(rows:readonly ClockRow[])=>rows.filter(row=>!row.voided).length===1;

/** Every condition for one candidate, read under the sponsor. Never writes. */
export async function evaluateClockOut(sponsor:SessionContext,item:ClockOutCandidate,limits:LoopLimits):Promise<ClockOutEvaluation>{
 return withTenant(sponsor,async tx=>{
  const checks:LoopActionCheck[]=[check('clock_in_and_roster_end',null,true)];
  const presence=await approvedLeavePresenceByEmploymentTx(tx,[item.employmentId],item.date,item.date);
  const onLeave=presence.get(item.employmentId)?.has(item.date)===true;
  checks.push(check('no_approved_leave',LEAVE,!onLeave));
  if(onLeave)return Object.freeze({ok:false,reason:'condition_leave' as const,checks:Object.freeze(checks)});
  const [subject]=await tx.select({personId:employment.personId}).from(employment).where(eq(employment.id,item.employmentId)).limit(1);
  const own=!!subject&&!!sponsor.personId&&subject.personId===sponsor.personId;
  checks.push(check('not_sponsor_own_day',null,!own));
  if(!subject||own)return Object.freeze({ok:false,reason:'condition_sponsor_self' as const,checks:Object.freeze(checks)});
  let rows:ClockRow[]=[];
  try{rows=(await clockRowsTx(tx,item.employmentId,item.date)).rows;}catch{rows=[];}
  const unchanged=dayUnchanged(rows,item.checkIn);
  checks.push(check('day_unchanged',SOURCE,unchanged));
  if(!unchanged)return Object.freeze({ok:false,reason:'condition_day_changed' as const,checks:Object.freeze(checks)});
  if(limits.condition==='roster_and_site_exit'){
   // No site exit is recorded anywhere in the product: the condition cannot be shown to hold, so it does not.
   checks.push(check('site_exit_agrees',null,false));
   return Object.freeze({ok:false,reason:'condition_site_exit' as const,checks:Object.freeze(checks)});
  }
  const alone=onlyTheClockIn(rows);
  checks.push(check('no_other_clocking',SOURCE,alone));
  if(!alone)return Object.freeze({ok:false,reason:'condition_other_clocking' as const,checks:Object.freeze(checks)});
  return Object.freeze({ok:true,reason:null,checks:Object.freeze(checks)});
 });
}

const ymd=(at:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);

const otMinutesTx=async(tx:Tx,employmentId:string,date:string)=>(await tx.select({ot:attendance.otMinutes}).from(attendance)
 .where(and(eq(attendance.employmentId,employmentId),eq(attendance.attendanceDate,date))).limit(1))[0]?.ot??0;

export type ClockOutApplied=Readonly<{ownerRef:string;addedPunchId:string}>;
/** Apply through the attendance owner under the sponsor, attributed to the loop, with the employee's notice, in one
 * transaction. */
export async function applyClockOut(sponsor:SessionContext,p:Readonly<{item:ClockOutCandidate;actionId:string;undoUntil:Date;principalId:string;workerId:string;
 attribution:LoopAttribution;condition:LoopLimits['condition']}>):Promise<ClockOutApplied>{
 const {item}=p;
 try{
  return await withTenant(sponsor,async tx=>{
   await setLoopAttributionTx(tx,p.attribution);
   const before=await clockRowsTx(tx,item.employmentId,item.date);
   if(!dayUnchanged(before.rows,item.checkIn))throw new LoopActRefused('condition_day_changed');
   if(p.condition==='roster_end'&&!onlyTheClockIn(before.rows))throw new LoopActRefused('condition_other_clocking');
   const overtimeBefore=await otMinutesTx(tx,item.employmentId,item.date);
   const active=before.rows.filter(row=>!row.voided);
   const entries=[...active.map(row=>({id:row.id,punchAt:row.punchAt,direction:row.direction})),{punchAt:`${item.proposedCheckOut}:00`,direction:'out' as const}];
   const reason=`AI Centre: missed clock-out set automatically to the roster end ${item.proposedCheckOut} by the missed clock-outs loop (action ${p.actionId.slice(0,8)}). It can be undone until ${ymd(p.undoUntil)}.`;
   const {correctionId}=await requestAttendanceCorrection(sponsor,{employmentId:item.employmentId,date:item.date,reason,
    clockChanges:{version:1,baseline:before.baseline,entries}},tx);
   // The loop decides only a correction the owner leaves to HR's own decision, never a routed approval stage.
   const [routed]=await tx.select({id:attendanceWorkflowRequest.id}).from(attendanceWorkflowRequest).where(eq(attendanceWorkflowRequest.correctionId,correctionId)).limit(1);
   if(routed)throw new LoopActRefused('approval_routed');
   const outcome=await decideAttendanceCorrection(sponsor,{correctionId,decision:'approved',remarks:reason,expectedStageIndex:0},tx);
   if(outcome.status!=='approved')throw new LoopActRefused('approval_pending');
   // The fix never creates overtime: the day's overtime as the owner recomputed it may not grow.
   if(await otMinutesTx(tx,item.employmentId,item.date)>overtimeBefore)throw new LoopActRefused('would_create_overtime');
   const after=await clockRowsTx(tx,item.employmentId,item.date);
   const added=after.rows.find(row=>!row.voided&&row.direction==='out'&&!active.some(old=>old.id===row.id));
   if(!added||added.punchAt.slice(0,5)!==item.proposedCheckOut)throw new LoopActRefused('owner_refused');
   // Tell the employee (the subject of the event), as the agent acting for the sponsor.
   await appendEvent(tx,{tenantId:sponsor.tenantId,aggregateType:'teras-loop-action',aggregateId:p.actionId,eventType:'teras-loop.action.applied',
    actor:{type:'agent',id:p.principalId},subjectEmploymentId:item.employmentId,
    payload:{workerId:p.workerId,date:item.date,checkOut:item.proposedCheckOut,undoUntil:p.undoUntil.toISOString(),correctionId,addedPunchId:added.id,sponsorUserId:sponsor.userId??null,owner:OWNER}});
   return Object.freeze({ownerRef:correctionId,addedPunchId:added.id});
  });
 }catch(error){
  if(error instanceof LoopActRefused)throw error;
  throw new LoopActRefused(error instanceof AttendancePayrollClosedError?'payroll_closed':'owner_refused');
 }
}

/** For an action left half-way by an interrupted run: the owner's own record says whether the change committed. The
 * notice event is written in the same transaction as the correction, so its presence proves both. */
export async function appliedRecordOf(sponsor:SessionContext,actionId:string):Promise<Readonly<{ownerRef:string;addedPunchId:string;at:Date}>|null>{
 return withTenant(sponsor,async tx=>{
  const [row]=await tx.select({payload:domainEvent.payload,at:domainEvent.occurredAt}).from(domainEvent)
   .where(and(eq(domainEvent.aggregateType,'teras-loop-action'),eq(domainEvent.aggregateId,actionId),eq(domainEvent.eventType,'teras-loop.action.applied'))).limit(1);
  const payload=row?.payload as Record<string,unknown>|null|undefined;
  return payload&&typeof payload.correctionId==='string'&&typeof payload.addedPunchId==='string'
   ?Object.freeze({ownerRef:payload.correctionId,addedPunchId:payload.addedPunchId,at:row!.at}):null;
 });
}

/** Whether each applied action's clock-out still stands as the loop set it, read under the sponsor. A day the read
 * cannot see is left unknown (absent from the result), never counted as a change. */
export async function observeClockOuts(sponsor:SessionContext,actions:readonly Readonly<{id:string;employmentId:string;facts:LoopActionFacts}>[]):Promise<Map<string,string|null>>{
 const out=new Map<string,string|null>();
 const items=actions.flatMap(action=>isDate(action.facts.date)&&isClock(action.facts.checkOut)?[{...action,date:action.facts.date as string,checkOut:action.facts.checkOut as string}]:[]);
 if(!items.length)return out;
 const dates=items.map(item=>item.date).sort(),ids=unique(items.map(item=>item.employmentId));
 for(let offset=0;offset<ids.length;offset+=100){
  const range=await attendanceForEmploymentsRange(sponsor,ids.slice(offset,offset+100),dates[0],dates[dates.length-1]);
  for(const item of items){
   const rows=range.get(item.employmentId);if(!rows)continue;
   const day=rows.find(row=>row.date===item.date);if(!day)continue;
   const recorded=clockOf(day.checkOutAt);
   if(recorded!==item.checkOut)out.set(item.id,recorded);
  }
 }
 return out;
}

/** The compensating correction for an undo, in the caller's transaction: void only the clock-out the loop added. */
export async function compensateClockOutTx(tx:Tx,authority:SessionContext,p:Readonly<{actionId:string;employmentId:string;facts:LoopActionFacts;by:UndoneBy}>):Promise<string>{
 const date=p.facts.date,added=p.facts.addedPunchId;
 if(!isDate(date)||typeof added!=='string')throw new LoopUndoRefused('unavailable');
 const source=await clockRowsTx(tx,p.employmentId,date);
 const punch=source.rows.find(row=>row.id===added);
 if(!punch||punch.voided)throw new LoopUndoRefused('changed');
 const entries=source.rows.filter(row=>!row.voided&&row.id!==added).map(row=>({id:row.id,punchAt:row.punchAt,direction:row.direction}));
 const reason=`AI Centre: undo of the clock-out the missed clock-outs loop set on ${date} (action ${p.actionId.slice(0,8)}), asked by ${p.by==='employee'?'the employee':'HR'}.`;
 const {correctionId}=await requestAttendanceCorrection(authority,{employmentId:p.employmentId,date,reason,clockChanges:{version:1,baseline:source.baseline,entries}},tx);
 const outcome=await decideAttendanceCorrection(authority,{correctionId,decision:'approved',remarks:reason,expectedStageIndex:0},tx);
 if(outcome.status!=='approved')throw new LoopUndoRefused('unavailable');
 return correctionId;
}
