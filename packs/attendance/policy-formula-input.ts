/** Exact central-formula source references. This reader neither evaluates nor authorizes a payment. */
import {and,desc,eq,inArray,isNull,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {overtimePattern,overtimePatternVersion,overtimePatternVersionCompany,overtimePatternVersionState,payComponent} from '../../db/schema';
import {attendanceGroupPolicyOnTx,type ResolvedAttendanceGroupPolicy} from '../../core/attendance-group-policy';
import type {PolicyCalendarProof} from '../../lib/attendance-policy-calendar';
import {payComponentReferenceStamp} from '../../lib/pay-component-contract';
import {validateOvertimePattern} from '../../lib/overtime-pattern-schema';
import {OVERTIME_LIMITS,OvertimePatternError,type OvertimePattern} from '../../lib/overtime-pattern-model';

import {attendancePolicyDurationFormulaProjection,type FormulaReference,type PolicyFormulaInput,type PolicyDurationFormulaInput} from './policy-formula-source';
export type {PolicyFormulaInput,PolicyDurationFormulaInput} from './policy-formula-source';

/** Policy/calendar inputs are supplied by the canonical snapshot reader. Re-prove the policy's
 * actual selected identity, then read every formula through its existing tenant/company RLS. The
 * formula/date references do not prove calendar provenance, approval or a complete payable partition. */
type FormulaSourceParameters={sourceDate:string;policy:ResolvedAttendanceGroupPolicy;calendar:readonly PolicyCalendarProof[];currency:{code:string;minorScale:number}};
export function attendancePolicyFormulaInputTx(tx:Tx,ctx:SessionContext,p:FormulaSourceParameters):Promise<PolicyFormulaInput>{
 return readAttendancePolicyFormulaInputTx(tx,ctx,p,'money');
}
export async function attendancePolicyDurationFormulaInputTx(tx:Tx,ctx:SessionContext,p:FormulaSourceParameters):Promise<PolicyDurationFormulaInput>{
 return attendancePolicyDurationFormulaProjection(await readAttendancePolicyFormulaInputTx(tx,ctx,p,'duration'));
}
/** One canonical version/state reader; the duration branch never queries earning components. */
async function readAttendancePolicyFormulaInputTx(tx:Tx,ctx:SessionContext,p:FormulaSourceParameters,stage:'money'|'duration'):Promise<PolicyFormulaInput>{
 const current=async()=>{
  const [row]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
  if(!row?.allowed)throw Error('Current Attendance principal required.');
 };
 await current();
 const selected=await attendanceGroupPolicyOnTx(tx,ctx,{companyId:p.policy.companyId,ruleId:p.policy.ruleId,date:p.sourceDate});
 if(!selected||selected.id!==p.policy.id)return {authority:'sourceOnly',state:'unavailable',reason:'policyChanged'};
 if(!selected.policy.overtime.enabled){await current();return {authority:'sourceOnly',state:'disabled',references:[]};}
 if(p.calendar.length>3)throw Error('The policy formula source exceeds its calendar bound.');
 if(!p.calendar.length){await current();return {authority:'sourceOnly',state:'unavailable',reason:'calendarUnavailable'};}
 const references:FormulaReference[]=[];
 for(const fact of p.calendar){
  const unavailable=(reason:Extract<FormulaReference,{state:'unavailable'}>['reason'])=>references.push({date:fact.date,state:'unavailable',reason});
  if(fact.state!=='known'||fact.companyId!==selected.companyId){unavailable('calendarUnavailable');continue;}
  const versionId=selected.policy.overtime.days[fact.dayClass].patternVersionId;
  if(!versionId){unavailable('bindingMissing');continue;}
  const [version]=await tx.select({id:overtimePatternVersion.id,definition:overtimePatternVersion.definition,digest:overtimePatternVersion.digest,
   kind:overtimePatternVersion.kind,activatedAt:overtimePatternVersion.activatedAt})
   .from(overtimePatternVersion).innerJoin(overtimePattern,and(eq(overtimePattern.id,overtimePatternVersion.patternId),eq(overtimePattern.tenantId,ctx.tenantId),isNull(overtimePattern.archivedAt)))
   .innerJoin(overtimePatternVersionCompany,and(eq(overtimePatternVersionCompany.versionId,overtimePatternVersion.id),
    eq(overtimePatternVersionCompany.tenantId,ctx.tenantId),eq(overtimePatternVersionCompany.companyId,selected.companyId)))
   .where(and(eq(overtimePatternVersion.id,versionId),eq(overtimePatternVersion.tenantId,ctx.tenantId))).limit(1);
  if(!version||version.kind!=='formula'||!version.activatedAt){unavailable('formulaUnavailable');continue;}
  const [state]=await tx.select().from(overtimePatternVersionState).where(and(eq(overtimePatternVersionState.versionId,version.id),
   eq(overtimePatternVersionState.tenantId,ctx.tenantId),lte(overtimePatternVersionState.effectiveFrom,fact.date)))
   .orderBy(desc(overtimePatternVersionState.effectiveFrom),desc(overtimePatternVersionState.sequence)).limit(1);
  if(state?.state!=='active'){unavailable('formulaInactive');continue;}
  let definition:OvertimePattern;
  try{definition=validateOvertimePattern(version.definition);}catch(error){if(!(error instanceof OvertimePatternError))throw error;unavailable('formulaInvalid');continue;}
  if(definition.currency.code!==p.currency.code||definition.currency.minorScale!==p.currency.minorScale){unavailable('currencyMismatch');continue;}
  const ids=stage==='money'?[...new Set(definition.rates.flatMap(rate=>rate.tiers.map(tier=>tier.mapping.earningItemId)))].sort():[];
  const items=ids.length?await tx.select().from(payComponent).where(and(eq(payComponent.tenantId,ctx.tenantId),inArray(payComponent.id,ids),
   isNull(payComponent.archivedAt),isNull(payComponent.pendingInputKind),eq(payComponent.kind,'allowance'),eq(payComponent.isNonPayable,false))):[];
  if(stage==='money'&&(items.length!==ids.length||definition.rates.some(rate=>rate.tiers.some(tier=>tier.mapping.currency!==p.currency.code)))){unavailable('mappingUnavailable');continue;}
  const reference:Extract<FormulaReference,{state:'known'}>={date:fact.date,state:'known',dayClass:fact.dayClass,moneyDay:fact.moneyDay,versionId:version.id,definition,definitionDigest:version.digest,
   activeState:{id:state.id,sequence:state.sequence,effectiveFrom:state.effectiveFrom},
   earningReferences:items.sort((a,b)=>a.id.localeCompare(b.id)).map(item=>JSON.parse(JSON.stringify(payComponentReferenceStamp(item))) as Record<string,unknown>)};
  if(new TextEncoder().encode(JSON.stringify(reference)).length>OVERTIME_LIMITS.jsonBytes){unavailable('referenceLimit');continue;}
  references.push(reference);
 }
 await current();
 return {authority:'sourceOnly',state:'known',references};
}
