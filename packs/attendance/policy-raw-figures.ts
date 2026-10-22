/** Canonical raw-measurement composition; no approval, OT pricing, settlement or database write. */
import {deductionMinutes,deductionsApplyOn} from '../../core/attendance-calc';
import type {ResolvedAttendanceRule} from '../../core/attendance-rule';
import {exceptionRevisionOn} from '../../lib/schedule-exception';
import type {attendancePolicyRawInputTx} from './policy-raw-input';
import {attendancePolicyNetWorkedMinutes} from './policy-work-input';
type RawPolicyInput=Extract<Awaited<ReturnType<typeof attendancePolicyRawInputTx>>,{state:'policy'}>;
export type PolicyRawFigures=
 |{state:'unavailable';reason:'ruleUnavailable'}
 |{state:'calculated';authority:'rawMeasurementOnly';workedMinutes:number|null;lateMinutes:number|null;
   earlyOutMinutes:number|null;underMinutes:number|null;lateDeductMinutes:number|null;earlyOutDeductMinutes:number|null};
/** The canonical writer supplies its resolved rule and frozen day classification. Unknown boundary
 * measurements remain null, including their related deduction, rather than asserting zero. Existing
 * dated deduction switches and exception revisions remain the sole owners of deduction semantics. */
export function attendancePolicyRawFigures(raw:RawPolicyInput,rule:ResolvedAttendanceRule|null,
 dayType:'workday'|'rest_day'|'holiday'):PolicyRawFigures{
 if(!rule||rule.id!==raw.context.schedule.ruleId)return {state:'unavailable',reason:'ruleUnavailable'};
 const workedMinutes=attendancePolicyNetWorkedMinutes(raw.work);
 const measured=raw.measurements.state==='measured'?raw.measurements:null;
 const lateMinutes=measured?.lateIn.state==='known'?measured.lateIn.minutes:null;
 const earlyOutMinutes=measured?.earlyOut.state==='known'?measured.earlyOut.minutes:null;
 const exempt=exceptionRevisionOn(rule.exceptions,raw.context.date)?.enabled===true;
 const deductible=deductionsApplyOn(rule,raw.context.date)&&!exempt;
 return {state:'calculated',authority:'rawMeasurementOnly',workedMinutes,lateMinutes,earlyOutMinutes,
  underMinutes:dayType==='workday'&&workedMinutes!==null?Math.max(0,raw.context.schedule.normalMinutes-workedMinutes):null,
  lateDeductMinutes:lateMinutes===null?null:deductible?deductionMinutes(lateMinutes,rule.lateAfterMinutes,rule.lateDeductMinutes):0,
  earlyOutDeductMinutes:earlyOutMinutes===null?null:deductible?deductionMinutes(earlyOutMinutes,rule.earlyAfterMinutes,rule.earlyDeductMinutes):0};
}
