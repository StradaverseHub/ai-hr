/** Physical clock provenance for a dated policy snapshot. This reads existing capture receipts;
 * it never assigns a day from a clock label, approves work, pairs clocks or calculates duration/pay. */
import {and,asc,eq,inArray} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendanceClockCapture,type attendancePunch} from '../../db/schema';
import {HR_LOCAL_TZ} from '../../lib/hr-date';
import {clockCaptureInstantTx} from '../../core/attendance-clock';
export type RecordedPolicyClockSource=
 |{state:'unavailable';authority:'sourceOnly';reason:'missingCapture'|'captureMismatch'|'outsidePeriod'}
 |{state:'known';authority:'sourceOnly';timeZone:typeof HR_LOCAL_TZ;periodMilliseconds:number;
   clocks:{id:string;captureId:string;direction:'in'|'out';atMilliseconds:number;recordedAt:string}[]};
/** Inputs are rows already selected by the canonical Attendance reader, never a posted interval set.
 * Preserve milliseconds: flooring to seconds before a minimum-gap test can accept a too-close event. */
export async function recordedPolicyClockSourceTx(tx:Tx,ctx:SessionContext,p:{attendanceId:string;employmentId:string;date:string;
 punches:readonly (typeof attendancePunch.$inferSelect)[]}):Promise<RecordedPolicyClockSource>{
 const unavailable=(reason:Extract<RecordedPolicyClockSource,{state:'unavailable'}>['reason']):RecordedPolicyClockSource=>({state:'unavailable',authority:'sourceOnly',reason});
 if(p.punches.length>128)return unavailable('outsidePeriod');
 if(p.punches.some(punch=>!punch.clockCaptureId))return unavailable('missingCapture');
 const ids=p.punches.map(punch=>punch.clockCaptureId!);
 if(new Set(ids).size!==ids.length)return unavailable('captureMismatch');
 const rows=ids.length?await tx.select({id:attendanceClockCapture.id,tenantId:attendanceClockCapture.tenantId,
  employmentId:attendanceClockCapture.employmentId,date:attendanceClockCapture.attendanceDate,
  // The capture's true instant: an accepted offline punch's effective time, never its later arrival.
  direction:attendanceClockCapture.direction,recordedAt:await clockCaptureInstantTx(tx)})
  .from(attendanceClockCapture).where(and(eq(attendanceClockCapture.tenantId,ctx.tenantId),inArray(attendanceClockCapture.id,ids)))
  .orderBy(asc(attendanceClockCapture.id)).limit(129):[];
 if(rows.length!==ids.length)return unavailable('missingCapture');
 const base=Date.parse(p.date+'T00:00:00+08:00'),periodMilliseconds=4320*60000;
 if(!Number.isSafeInteger(base))return unavailable('outsidePeriod');
 const format=new Intl.DateTimeFormat('en-GB',{timeZone:HR_LOCAL_TZ,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
 const clocks:Extract<RecordedPolicyClockSource,{state:'known'}>['clocks']=[];
 for(const punch of p.punches){
  const capture=rows.find(row=>row.id===punch.clockCaptureId);
  if(!capture||punch.tenantId!==ctx.tenantId||punch.employmentId!==p.employmentId||punch.attendanceId!==p.attendanceId||punch.attendanceDate!==p.date
   ||capture.employmentId!==p.employmentId||capture.date!==p.date||capture.direction!==punch.direction)return unavailable('captureMismatch');
  const instant=capture.recordedAt.getTime(),atMilliseconds=instant-base;
  if(!Number.isSafeInteger(atMilliseconds)||atMilliseconds<0||atMilliseconds>periodMilliseconds)return unavailable('outsidePeriod');
  // PostgreSQL time labels have second precision on this server-capture path. Import/manual labels
  // and created_at are never promoted into an actual instant or an overnight calendar date.
  if(!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.0+)?$/.test(punch.punchAt)||format.format(capture.recordedAt)!==punch.punchAt.slice(0,8))
   return unavailable('captureMismatch');
  clocks.push({id:punch.id,captureId:capture.id,direction:punch.direction,atMilliseconds,recordedAt:capture.recordedAt.toISOString()});
 }
 clocks.sort((a,b)=>a.atMilliseconds-b.atMilliseconds||a.id.localeCompare(b.id));
 return {state:'known',authority:'sourceOnly',timeZone:HR_LOCAL_TZ,periodMilliseconds,clocks};
}
