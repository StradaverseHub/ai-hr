/** Shared formula source contracts and pure duration projection; no database or salary read. */
import type {AttendancePolicyDayClass} from '../../lib/attendance-group-policy';
import type {OvertimePattern} from '../../lib/overtime-pattern-model';

export type FormulaReference=
 |{date:string;state:'unavailable';reason:'calendarUnavailable'|'bindingMissing'|'formulaUnavailable'|'formulaInactive'|'formulaInvalid'|'currencyMismatch'|'mappingUnavailable'|'referenceLimit'}
 |{date:string;state:'known';dayClass:AttendancePolicyDayClass;moneyDay:'workday'|'rest_day'|'holiday';versionId:string;
   definition:OvertimePattern;definitionDigest:string;activeState:{id:string;sequence:number;effectiveFrom:string};
   earningReferences:Record<string,unknown>[]};
export type PolicyFormulaInput=
 |{authority:'sourceOnly';state:'unavailable';reason:'policyChanged'|'calendarUnavailable'}
 |{authority:'sourceOnly';state:'disabled';references:[]}
 |{authority:'sourceOnly';state:'known';references:FormulaReference[]};

/** Price-independent formula references for the TOIL duration replay owner. An earning mapping
 * or salary fact is not needed to retain the frozen version and its count-allocation direction. */
export type PolicyDurationFormulaInput=
 |{authority:'durationSourceOnly';state:'unavailable';reason:'policyChanged'|'calendarUnavailable'}
 |{authority:'durationSourceOnly';state:'disabled';references:[]}
 |{authority:'durationSourceOnly';state:'known';references:(
   |Extract<FormulaReference,{state:'unavailable'}>
   |Omit<Extract<FormulaReference,{state:'known'}>,'definition'|'earningReferences'>&{durationAllocation:'earliest'|'latest'})[]};
/** This projection does not turn a money-source refusal into duration proof. The private source
 * reader must first obtain canonical duration metadata without requesting earning references. */
export function attendancePolicyDurationFormulaProjection(input:PolicyFormulaInput):PolicyDurationFormulaInput{
 if(input.state==='unavailable')return {authority:'durationSourceOnly',state:'unavailable',reason:input.reason};
 if(input.state==='disabled')return {authority:'durationSourceOnly',state:'disabled',references:[]};
 return {authority:'durationSourceOnly',state:'known',references:input.references.map(row=>{
  if(row.state!=='known')return {...row};
  return {state:'known',date:row.date,dayClass:row.dayClass,moneyDay:row.moneyDay,versionId:row.versionId,
   definitionDigest:row.definitionDigest,activeState:{...row.activeState},durationAllocation:row.definition.durationAllocation};
 })};
}

