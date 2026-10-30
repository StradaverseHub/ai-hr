import {sql} from 'drizzle-orm';
import {provenCompanyDatesTx} from '../../core/employment-company';
import {OvertimeOwnerError} from './overtime-patterns';
/** Native OT effect capture. Public audit data excludes financial contents and private retention proofs. */
import type {SessionContext,Tx} from '../../db/client';
import type {AttendanceDayEditorData} from './day-adjustment';
import type {ManualOtRows} from '../../lib/attendance-day-adjustment';
import {AttendanceDayOvertimeChanges,AttendanceDayOvertimeNativeWrite,AttendanceDayOvertimeReviewSummary,AttendanceDayOvertimeReviewView,AttendanceDayOvertimeReviewWitness,type AttendanceDayOvertimeReviewSummaryData} from '../../lib/attendance-day-overtime-review';
import {captureAttendanceDayReviewStateTx,attendanceDayReviewViewTx,attendanceDayReviewWitnessTx} from './day-schedule-effects';

/** Generated BEFORE the native INSERT, independently of its RETURNING/trigger-modified values.
 * Only non-financial manual minute/provenance data already present in the native event is hashed. */
export async function captureAttendanceDayOvertimeWriteTx(tx:Tx,values:{manualOtRows:ManualOtRows;updatedBy:string;updatedAt:Date}){
 const[row]=await tx.execute<{digest:string}>(sql`select encode(sha256(convert_to(${JSON.stringify(values.manualOtRows)}::jsonb::text,'UTF8')),'hex') as digest`);
 return AttendanceDayOvertimeNativeWrite.parse({manualMapDigest:row?.digest,updatedBy:values.updatedBy,updatedAt:values.updatedAt.toISOString()});
}
export async function assertAttendanceDayOvertimeWriteTx(tx:Tx,generated:Awaited<ReturnType<typeof captureAttendanceDayOvertimeWriteTx>>,actual:{manualOtRows:ManualOtRows;updatedBy:string;updatedAt:Date}){
 const stored=await captureAttendanceDayOvertimeWriteTx(tx,actual);
 if(stored.manualMapDigest!==generated.manualMapDigest||stored.updatedBy!==generated.updatedBy||stored.updatedAt!==generated.updatedAt)throw Error('Native overtime writer metadata changed before persistence.');
}
export async function captureAttendanceDayOvertimeStateTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},batchIds:string[],editor:AttendanceDayEditorData){
 const base=await captureAttendanceDayReviewStateTx(tx,ctx,p,batchIds,editor);
 // Canonical money commitments may be needed even before the first pattern source exists.
 // Reuse the financial owner's exact dated-company predicate before reading those private inputs.
 if(base.summary.day){const proof=(await provenCompanyDatesTx(tx,[p])).get(p.employmentId+'|'+p.date);if(!proof?.companyId)throw new OvertimeOwnerError('unavailable','Native dated financial scope is unavailable.');const[permission]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${proof.companyId}::uuid) as allowed`);if(!permission?.allowed)throw new OvertimeOwnerError('permission','Review this day with an authorized company financial administrator.');}
 const summary=AttendanceDayOvertimeReviewSummary.parse({...base.summary,complete:editor.complete,approvedOtMinutes:editor.approvedOtMinutes,
  legacyRows:editor.rows.map(row=>({key:row.key,bucket:row.bucket,ratePattern:row.ratePattern,rate:row.rate??null,calculatedMinutes:row.calculatedMinutes,effectiveMinutes:row.effectiveMinutes,orphan:row.orphan,
   autoEffectiveMinutes:row.autoEffectiveMinutes,manualMinutes:row.manual?.minutes??null,manualCalculatedMinutes:row.manual?.calculatedMinutes??null}))});
 return {...base,baseSummary:base.summary,summary,adjustment:structuredClone(editor.adjustment)};
}
export async function attendanceDayOvertimeViewTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},summary:AttendanceDayOvertimeReviewSummaryData){
 const {complete,approvedOtMinutes,legacyRows,...base}=summary;
 const native=await attendanceDayReviewViewTx(tx,ctx,p,{...base,legacyRows:legacyRows.map(({manualMinutes,manualCalculatedMinutes,autoEffectiveMinutes,...row})=>row)});
 return AttendanceDayOvertimeReviewView.parse({...native,complete,approvedOtMinutes,legacyRows});
}
type State=Awaited<ReturnType<typeof captureAttendanceDayOvertimeStateTx>>;
export async function attendanceDayOvertimeWitnessTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string;rows:{key:string;minutes:number|null}[]},batchIds:string[],before:State,after:State,generated:Awaited<ReturnType<typeof captureAttendanceDayOvertimeWriteTx>>){
 const selectedRows=AttendanceDayOvertimeChanges.parse(p.rows);
 if(!ctx.userId||!after.adjustment||before.summary.override.shiftId!==after.summary.override.shiftId||before.summary.override.dayKind!==after.summary.override.dayKind)throw Error('Native overtime schedule retention is unavailable.');
 await assertAttendanceDayOvertimeWriteTx(tx,generated,after.adjustment);
 const prior:ManualOtRows=before.adjustment?.manualOtRows??{},actual=after.adjustment.manualOtRows,expected:ManualOtRows=structuredClone(prior);
 for(const input of selectedRows){
  if(input.minutes===null){delete expected[input.key];continue;}
  const row=before.summary.legacyRows.find(row=>row.key===input.key),saved=actual[input.key];
  if(!row||!saved||saved.minutes!==input.minutes||saved.bucket!==row.bucket||saved.calculatedMinutes!==row.calculatedMinutes||saved.actorId!==ctx.userId||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(saved.recordedAt)||!Number.isFinite(Date.parse(saved.recordedAt)))throw Error('Native overtime manual-row provenance is unavailable.');
  expected[input.key]=saved;
 }
 const canonical=(map:ManualOtRows)=>JSON.stringify(Object.keys(map).sort().map(key=>[key,map[key]]));
 if(canonical(expected)!==canonical(actual))throw Error('Native overtime changed an unselected manual entry.');
 const base=await attendanceDayReviewWitnessTx(tx,ctx,p,batchIds,{summary:before.baseSummary,rows:before.rows,privateRetention:before.privateRetention},{summary:after.baseSummary,rows:after.rows,privateRetention:after.privateRetention});
 return AttendanceDayOvertimeReviewWitness.parse({...base,selectedRows,write:generated,before:{summary:before.summary,rows:before.rows},after:{summary:after.summary,rows:after.rows}});
}
