/** Complete immutable proposal parts beneath ONE calculation. This does not grant approval,
 * generate payment lines or settle cash/TOIL. Parent identities/digests are bound by the writer. */
import {isDeepStrictEqual} from 'node:util';
import type {attendanceOvertimePolicyPart} from '../../db/schema';
import type {ResolvedAttendanceGroupPolicy} from '../../core/attendance-group-policy';
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {PolicyWorkInput} from './policy-work-input';
import type {PolicyFormulaInput} from './policy-formula-input';
import {attendancePolicyExecutionProposal,type PolicyExecutionProposal} from './policy-execution-proposal';

export type PolicyProposalStoragePart=Pick<typeof attendanceOvertimePolicyPart.$inferInsert,
 'sequence'|'calendarDate'|'dayClass'|'moneyDay'|'versionId'|'rawMinutes'|'allocatedPayableMinutes'|'sourceIntervals'|'calendarReferences'|'durationEvidence'>;
export type PolicyProposalPartSource={source:{employmentId:string;date:string};policy?:ResolvedAttendanceGroupPolicy;
 context?:AttendancePolicyExecutionContext;work?:PolicyWorkInput;formulas?:PolicyFormulaInput;proposal?:PolicyExecutionProposal};

/** Null rejects inconsistent prepared evidence. Empty means no complete proposal to materialize.
 * Rounding remainder stays on the parent's class evidence, never an invented child clock/date. */
export function materializeAttendancePolicyProposalParts(input:PolicyProposalPartSource):PolicyProposalStoragePart[]|null{
 if(!input.policy)return input.proposal?null:[];
 if(!input.proposal)return [];
 const context=input.context;
 if(context?.state==='policy'&&(context.employmentId!==input.source.employmentId||context.date!==input.source.date
  ||context.companyId!==input.policy.companyId||!isDeepStrictEqual(context.selected,input.policy)))return null;
 const expected=attendancePolicyExecutionProposal(context,input.work,input.formulas);
 if(!isDeepStrictEqual(expected,input.proposal))return null;
 if(expected.state!=='proposed'||expected.duration.status!=='calculated')return [];
 if(expected.policyRevisionId!==input.policy.id||expected.duration.parts.length>3
  ||expected.formulaParts.length!==expected.duration.parts.length)return null;
 const parts:PolicyProposalStoragePart[]=[];
 for(const [sequence,part]of expected.duration.parts.entries()){
  const formula=expected.formulaParts[sequence];
  if(formula.date!==part.date||formula.dayClass!==part.dayClass||part.companyId!==input.policy.companyId)return null;
  parts.push({sequence,calendarDate:part.date,dayClass:part.dayClass,moneyDay:part.moneyDay,versionId:formula.versionId,
   rawMinutes:part.minutes,allocatedPayableMinutes:part.allocatedPayableMinutes,
   sourceIntervals:part.intervals.map(row=>({...row})),calendarReferences:[...part.calendarReferences],
   durationEvidence:{authority:'proposalOnly',policyRevisionId:input.policy.id,intervalBasis:expected.duration.intervalBasis,
    parentClass:part.dayClass,allocatedIntervals:part.allocations.map(row=>({...row}))}});
 }
 return parts;
}
