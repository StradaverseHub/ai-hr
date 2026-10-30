/** Native-owned review projection. Every number comes from the persisted/native calculation owners. */
import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import * as s from '../../db/schema';
import {AttendanceDayReviewRow,AttendanceDayReviewSummary,AttendanceDayReviewWitness,AttendanceDayReviewView,type AttendanceDayReviewSummaryData,type AttendanceDayReviewWitnessData} from '../../lib/attendance-day-review';
import type {AttendanceDayEditorData} from './day-adjustment';
import {readOvertimePatternCalculationTx} from './overtime-calculation';
const State=z.object({override:AttendanceDayReviewSummary.shape.override,day:AttendanceDayReviewSummary.shape.day,pattern:AttendanceDayReviewSummary.shape.pattern,payroll:AttendanceDayReviewSummary.shape.payroll,rows:z.array(AttendanceDayReviewRow).max(256)}).strict();
export async function captureAttendanceDayReviewStateTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},payrollBatchIds:string[],editor:AttendanceDayEditorData){
 const ids=z.array(z.guid()).max(25).parse([...new Set(payrollBatchIds)].sort());
 const [record]=await tx.execute<{state:unknown}>(sql`select app.assistant_attendance_day_schedule_effect_state(${p.employmentId}::uuid,${p.date}::date,${JSON.stringify(ids)}::jsonb) as state`);
 const state=State.parse(record?.state),summary=AttendanceDayReviewSummary.parse({override:state.override,day:state.day,pattern:state.pattern,payroll:state.payroll,resolvedShiftCode:editor.schedule.shiftCode??null,resolvedDayKind:editor.schedule.dayKind,legacyRows:editor.rows.map(row=>({key:row.key,bucket:row.bucket,ratePattern:row.ratePattern,rate:row.rate??null,calculatedMinutes:row.calculatedMinutes,effectiveMinutes:row.effectiveMinutes,orphan:row.orphan===true}))});
 return {summary,rows:state.rows};
}
/** Opaque tuple hashes/safe summaries only. Subject-readable events never carry OT monetary evidence. */
export async function attendanceDayReviewWitnessTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},payrollBatchIds:string[],before:{summary:AttendanceDayReviewSummaryData;rows:z.infer<typeof AttendanceDayReviewRow>[]},after:typeof before):Promise<AttendanceDayReviewWitnessData>{
 const write=after.rows.find(row=>row.kind==='adjustment');if(!write||!ctx.userId)throw Error('Native day effect proof is unavailable.');
 const ids=[...new Set(payrollBatchIds)].sort(),events=await tx.execute<{id:string}>(sql`select d.id from domain_event d where d.tenant_id=${ctx.tenantId}::uuid and d.subject_employment_id=${p.employmentId}::uuid and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.xmin=${write.xid}::xid and ((d.event_type='overtime.calculation.recorded' and d.aggregate_id=${after.summary.pattern.sourceId}::uuid and d.payload->>'calculationId'=${after.summary.pattern.calculationId}) or (d.event_type='attendance.overtime-pattern.refused' and d.payload->>'date'=${p.date}) or (d.event_type='payroll-batch.recalc-required' and d.aggregate_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)))) order by d.id limit 101`);
 const witness=AttendanceDayReviewWitness.parse({version:1,date:p.date,payrollBatchIds:ids,before,after,relatedEventIds:Array.from(events).map(row=>row.id)});
 const punches=(rows:typeof before.rows)=>rows.filter(row=>['punch','attendance_clock','payroll_other'].includes(row.kind)).map(({kind,key,digest})=>({kind,key,digest}));
 if(JSON.stringify(punches(before.rows))!==JSON.stringify(punches(after.rows)))throw Error('A day schedule correction cannot change captured clocks.');
 return witness;
}
/** Component code/name are current authorized display labels, as on the native screen. Amounts and
 * policy/version/assignment evidence come from the immutable revision, never current pricing definitions. */
/** Private/historical money is read ONLY through the native financial evidence owner, never an event payload. */
export async function attendanceDayReviewViewTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},summary:AttendanceDayReviewSummaryData){
 const ref=summary.pattern,empty={sourcePresent:ref.sourceId!==null,calculationPresent:ref.calculationId!==null,revision:ref.revision,marker:ref.marker,outcome:null,durationOutcome:null,approvalStatus:null,bindingKind:null,versionId:null,assignmentId:null,policyRevisionId:null,cashIssues:[],durationIssues:[],policyCashRefusal:null,policyDurationRefusal:null,currency:null,minorScale:null,amountMinorUnits:null,payableNumerator:null,payableDenominator:null,lines:[]};
 if(!ref.sourceId)return AttendanceDayReviewView.parse({...summary,pattern:empty});
 const recorded=await readOvertimePatternCalculationTx(tx,ctx,{...p,...(ref.calculationId?{revisionId:ref.calculationId}:{})});
 if(!recorded||recorded.sourceId!==ref.sourceId)throw Error('Native pattern evidence is unavailable.');
 if(!ref.calculationId)return AttendanceDayReviewView.parse({...summary,pattern:empty});
 const [header]=await tx.select().from(s.attendanceOvertimeCalculation).where(and(eq(s.attendanceOvertimeCalculation.id,ref.calculationId),eq(s.attendanceOvertimeCalculation.sourceId,ref.sourceId),eq(s.attendanceOvertimeCalculation.tenantId,ctx.tenantId))).limit(1);
 if(!header)throw Error('Native pattern header is unavailable.');
 const lines=await tx.select().from(s.attendanceOvertimeLine).where(and(eq(s.attendanceOvertimeLine.calculationId,ref.calculationId),eq(s.attendanceOvertimeLine.tenantId,ctx.tenantId))).orderBy(asc(s.attendanceOvertimeLine.sequence),asc(s.attendanceOvertimeLine.id)).limit(65);
 if(lines.length>64)throw Error('Review this pattern on the native Attendance screen.');
 const ids=[...new Set(lines.map(row=>row.componentId))].sort(),labels=ids.length?await tx.select({id:s.payComponent.id,code:s.payComponent.code,name:s.payComponent.name}).from(s.payComponent).where(and(eq(s.payComponent.tenantId,ctx.tenantId),inArray(s.payComponent.id,ids))).orderBy(asc(s.payComponent.id)).for('share'):[];
 if(ids.some(id=>!labels.some(label=>label.id===id)))throw Error('Native earning labels are unavailable.');
 const policy=recorded.policyFinancial?.state==='prepared'?recorded.policyFinancial:null,evaluation=recorded.evaluation&&recorded.evaluation.status!=='refused'?recorded.evaluation:null;
 const mapped=lines.map(row=>{const label=labels.find(label=>label.id===row.componentId)!,part=policy?.lines.find(part=>part.sequence===row.sequence),line=part?.line??evaluation?.lines.find(line=>line.id===row.lineKey);if(!line||line.amountMinorUnits!==row.amountMinorUnits)throw Error('Native earning evidence is unavailable.');return {sequence:row.sequence,calendarDate:part?.calendarDate??null,partSequence:part?.partSequence??null,payableNumerator:line.payableMinutes.numerator,payableDenominator:line.payableMinutes.denominator,componentId:row.componentId,code:label.code,name:label.name,amountMinorUnits:row.amountMinorUnits};});
 return AttendanceDayReviewView.parse({...summary,pattern:{...empty,outcome:header.outcome,durationOutcome:header.durationOutcome,approvalStatus:header.approvalStatus,bindingKind:header.bindingKind,versionId:header.versionId,assignmentId:header.assignmentId,policyRevisionId:header.policyRevisionId,cashIssues:recorded.evaluation?.status==='refused'?recorded.evaluation.issues:[],durationIssues:recorded.duration?.status==='refused'?recorded.duration.issues:[],policyCashRefusal:recorded.policyFinancial?.state==='unavailable'?recorded.policyFinancial.reason:null,policyDurationRefusal:recorded.policyDuration?.state==='unavailable'?recorded.policyDuration.reason:null,currency:header.currency,minorScale:header.minorScale,amountMinorUnits:policy?.amountMinorUnits??evaluation?.amountMinorUnits??null,payableNumerator:header.payableNumerator,payableDenominator:header.payableDenominator,lines:mapped}});
}
