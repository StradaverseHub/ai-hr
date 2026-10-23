/** One parent calculation contract for policy financial consumers. This composes the existing
 * duration, captured-source and central money owners. It does not grant a module permission,
 * create an approval, reserve a source or authorize a payment. Those owners must admit it. */
import {isDeepStrictEqual} from 'node:util';
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';
import type {OvertimeLine} from '../../lib/overtime-pattern-model';
import {attendancePolicyDurationReplay,attendancePolicyRecordedApprovalStatus,attendancePolicyIndependentDurationReplay,attendancePolicyIndependentRecordedApprovalStatus,attendancePolicyIndependentSource,type IndependentPolicyDurationSource} from './policy-duration-replay';
import {attendancePolicyCashReplay,type PolicyCashReplay} from './policy-cash-replay';
import {attendancePolicyPricingProposal,type PolicyPricingProposal} from './policy-pricing-proposal';
import {attendancePolicyCapturedCoverageProposal,attendancePolicyIndependentCapturedCoverage,type PolicyCapturedCoverageProposal} from './policy-captured-coverage';
import {materializeAttendancePolicyProposalParts,type PolicyProposalStoragePart} from './policy-proposal-parts';
import type {PolicyCoverageIdentity} from './policy-coverage';
import {attendancePolicyStoredPartCount} from './policy-count-attribution';

type PreparedCash=Extract<PolicyCashReplay,{state:'known'}>;
type PreparedPricing=Extract<PolicyPricingProposal,{state:'proposed'}>;
type CapturedCoverage=Extract<PolicyCapturedCoverageProposal,{state:'prepared'}>;
export type PolicyFinancialLine={sequence:number;partSequence:number;calendarDate:string;
 dayClass:PolicyProposalStoragePart['dayClass'];moneyDay:PolicyProposalStoragePart['moneyDay'];
 versionId:string;line:OvertimeLine};
export type PolicyFinancialContract=
 |{state:'unavailable';authority:'policyFinancialContractOnly';reason:'sourceUnavailable'|'approvalUnavailable'|
  'durationUnavailable'|'coverageUnavailable'|'pricingUnavailable'|'partitionMismatch'|'lineMismatch'}
 |{state:'prepared';authority:'policyFinancialContractOnly';identity:PolicyCoverageIdentity;
  policyRevisionId:string;inputDigest:string;approvalDigest:string;referenceDigest:string;
  approvalStatus:'approved'|'notRequired';durationDigest:string;minutes:number;
  currency:{code:string;minorScale:number};amountMinorUnits:string;cash:PreparedCash;
  coverage:CapturedCoverage;parts:PolicyProposalStoragePart[];lines:PolicyFinancialLine[]};

/** Dated allocations and lines remain beneath one parent. This contract never invents an
 * assignment or a parent formula version, reruns duration rounding, or adds a money calculator. */
export function attendancePolicyFinancialContract(identity:PolicyCoverageIdentity,snapshot:CanonicalOvertimeSnapshot):PolicyFinancialContract{
 const unavailable=(reason:Extract<PolicyFinancialContract,{state:'unavailable'}>['reason']):PolicyFinancialContract=>
  ({state:'unavailable',authority:'policyFinancialContractOnly',reason});
 try{
  const input=snapshot.input,policy=snapshot.attendanceGroupPolicy,context=snapshot.policyExecutionContext;
  if(!policy||context?.state!=='policy'||input.source.tenantId!==identity.tenantId
   ||input.source.employmentId!==identity.employmentId||input.source.date!==identity.date
   ||context.companyId!==identity.companyId||policy.companyId!==identity.companyId
   ||!isDeepStrictEqual(context.selected,policy)||!Number.isSafeInteger(policy.activation.epoch)
   ||policy.activation.epoch<1)return unavailable('sourceUnavailable');
  const approvalStatus=attendancePolicyRecordedApprovalStatus(snapshot);
  if(approvalStatus!=='approved'&&approvalStatus!=='notRequired')return unavailable('approvalUnavailable');
  const duration=attendancePolicyDurationReplay(snapshot);
  if(duration.state!=='known'||!Number.isSafeInteger(duration.minutes)||duration.minutes<=0)return unavailable('durationUnavailable');
  const coverage=attendancePolicyCapturedCoverageProposal(identity,snapshot);
  if(coverage.state!=='prepared'||coverage.durationDigest!==duration.digest||coverage.minutes!==duration.minutes
   ||!coverage.allocations.length||!coverage.intervals.length)return unavailable('coverageUnavailable');
  const parts=materializeAttendancePolicyProposalParts({source:input.source,policy,context,
   work:snapshot.policyWorkInput,formulas:snapshot.policyFormulaInput,durationFormulas:snapshot.policyDurationFormulaInput,
   approvals:snapshot.policyApprovalInput,proposal:snapshot.policyExecutionProposal,rawEffect:snapshot.policyRawEffectSource});
  if(!parts||!parts.length||parts.length>3||parts.reduce((n,p)=>n+(attendancePolicyStoredPartCount(p)??NaN),0)!==duration.minutes)
   return unavailable('partitionMismatch');
  const pricing=attendancePolicyPricingProposal(snapshot),cash=attendancePolicyCashReplay(snapshot);
  if(pricing.state!=='proposed'||cash.state!=='known'||pricing.durationDigest!==duration.digest
   ||cash.minutes!==duration.minutes||pricing.amountMinorUnits!==cash.amountMinorUnits
   ||!isDeepStrictEqual(pricing.currency,cash.currency))return unavailable('pricingUnavailable');
  if(pricing.parts.length!==parts.filter(p=>(attendancePolicyStoredPartCount(p)??NaN)>0).length)return unavailable('partitionMismatch');
  const lines:PolicyFinancialLine[]=[],keys=new Set<string>();let amount=BigInt('0');
  for(const priced of pricing.parts){
   const part=parts[priced.sequence],row=priced.pricing;
   if(!part||part.sequence!==priced.sequence||part.calendarDate!==priced.date||!part.versionId
    ||part.versionId!==row.patternVersionId||attendancePolicyStoredPartCount(part)!==row.minutes
    ||row.policyBinding.revisionId!==policy.id||row.policyBinding.calendarDate!==part.calendarDate
    ||row.policyBinding.dayClass!==part.dayClass||!isDeepStrictEqual(row.source,input.source)
    ||!isDeepStrictEqual(row.currency,cash.currency))return unavailable('partitionMismatch');
   if(!moneyScopeMatches(pricing,row))return unavailable('partitionMismatch');
   let partAmount=BigInt('0');
   for(const line of row.lines){
    if(keys.has(line.id)||line.id.length>2048||!/^\d{1,78}$/.test(line.amountMinorUnits)
     ||line.mapping.currency!==cash.currency.code||lines.length>=16384)return unavailable('lineMismatch');
    keys.add(line.id);partAmount+=BigInt(line.amountMinorUnits);
    lines.push({sequence:lines.length,partSequence:priced.sequence,calendarDate:part.calendarDate,
     dayClass:part.dayClass,moneyDay:part.moneyDay,versionId:part.versionId,line});
   }
   if(partAmount!==BigInt(row.amountMinorUnits))return unavailable('lineMismatch');
   amount+=partAmount;
  }
  if(!lines.length||amount!==BigInt(cash.amountMinorUnits))return unavailable('lineMismatch');
  return {state:'prepared',authority:'policyFinancialContractOnly',identity:{...identity},policyRevisionId:policy.id,
   inputDigest:input.source.inputDigest,approvalDigest:input.source.approvalDigest,referenceDigest:snapshot.referenceDigest,
   approvalStatus,durationDigest:duration.digest,minutes:duration.minutes,currency:{...cash.currency},
   amountMinorUnits:cash.amountMinorUnits,cash,coverage,parts,lines};
 }catch{return unavailable('sourceUnavailable');}
}
function moneyScopeMatches(pricing:PreparedPricing,row:PreparedPricing['parts'][number]['pricing']):boolean{
 if(pricing.parts.length===1)return row.moneyScope.kind==='singleAllocation';
 return row.moneyScope.kind==='parent'&&row.moneyScope.amountMinorUnits===pricing.amountMinorUnits
  &&isDeepStrictEqual(row.moneyScope.partBindings,pricing.parts.map(p=>p.pricing.policyBinding));
}

/** Current consumers must obtain their snapshot through canonical, scoped reads under their
 * existing source/configuration barriers. Stored JSON or a digest alone cannot supply freshness. */
export function attendancePolicyCurrentFinancialMatches(identity:PolicyCoverageIdentity,
 current:CanonicalOvertimeSnapshot,recorded:unknown):boolean{
 const expected=attendancePolicyFinancialContract(identity,current);
 return expected.state==='prepared'&&isDeepStrictEqual(expected,recorded);
}

type FinancialSource=typeof import('../../db/schema').attendanceOvertimeSource.$inferSelect;
type FinancialHeader=typeof import('../../db/schema').attendanceOvertimeCalculation.$inferSelect;
type FinancialEvidence=typeof import('../../db/schema').attendanceOvertimeCalculationEvidence.$inferSelect;
type FinancialStoredLine=typeof import('../../db/schema').attendanceOvertimeLine.$inferSelect;
/** Historical replay accepts the complete immutable parent, never a caller-supplied total.
 * Current freshness is separately proved by the scoped canonical financial reader. */
export function recordedAttendancePolicyFinancialContractMatches(source:FinancialSource,header:FinancialHeader,
 evidence:FinancialEvidence|undefined,lines:readonly FinancialStoredLine[]):boolean{
 try{
  if(!evidence||header.bindingKind!=='attendanceGroupPolicy'||header.sourceId!==source.id
   ||header.tenantId!==source.tenantId||header.companyId!==source.companyId
   ||evidence.calculationId!==header.id||evidence.tenantId!==source.tenantId||evidence.companyId!==source.companyId)return false;
  const stored=evidence.evidence as Record<string,unknown>,input=evidence.inputs as unknown as CanonicalOvertimeSnapshot['input'];
  if(!stored||!input||!input.source||input.source.tenantId!==source.tenantId
   ||input.source.employmentId!==source.employmentId||input.source.attendanceId!==source.attendanceId
   ||input.source.date!==source.attendanceDate||input.source.inputDigest!==header.inputDigest
   ||input.source.approvalDigest!==header.approvalDigest||header.versionId!==null||header.assignmentId!==null)return false;
  // Original staged records have no financial contract and cannot be promoted by replay.
  if(!Object.hasOwn(stored,'policyFinancialContract'))return header.outcome==='refused'
   &&header.durationOutcome==='refused'&&!header.transferable&&lines.length===0;
  const snapshot:CanonicalOvertimeSnapshot={input,resolvedLegacyRuleId:null,referenceDigest:header.referenceDigest,
   attendanceGroupPolicy:stored.attendanceGroupPolicy as CanonicalOvertimeSnapshot['attendanceGroupPolicy'],
   policyExecutionContext:stored.policyExecutionContext as CanonicalOvertimeSnapshot['policyExecutionContext'],
   policyClockSource:stored.policyClockSource as CanonicalOvertimeSnapshot['policyClockSource'],
   policyClockReview:stored.policyClockReview as CanonicalOvertimeSnapshot['policyClockReview'],
   policyClockMeasurements:stored.policyClockMeasurements as CanonicalOvertimeSnapshot['policyClockMeasurements'],
   policyWorkInput:stored.policyWorkInput as CanonicalOvertimeSnapshot['policyWorkInput'],
   policyApprovalInput:stored.policyApprovalInput as CanonicalOvertimeSnapshot['policyApprovalInput'],
   policyFormulaInput:stored.policyFormulaInput as CanonicalOvertimeSnapshot['policyFormulaInput'],
   policyDurationFormulaInput:stored.policyDurationFormulaInput as CanonicalOvertimeSnapshot['policyDurationFormulaInput'],
   policyPricingFacts:stored.policyPricingFacts as CanonicalOvertimeSnapshot['policyPricingFacts'],
   policyExecutionProposal:stored.policyExecutionProposal as CanonicalOvertimeSnapshot['policyExecutionProposal'],
   policyRawEffectSource:stored.policyRawEffectSource as CanonicalOvertimeSnapshot['policyRawEffectSource']};
  const expected=attendancePolicyFinancialContract({tenantId:source.tenantId,companyId:source.companyId,
   employmentId:source.employmentId,sourceId:source.id,calculationId:header.id,date:source.attendanceDate},snapshot);
  if(!isDeepStrictEqual(stored.policyFinancialContract,expected))return false;
  const independent=attendancePolicyIndependentSource(snapshot);
  const duration=independent?attendancePolicyFinancialDurationContract({tenantId:source.tenantId,companyId:source.companyId,
   employmentId:source.employmentId,sourceId:source.id,calculationId:header.id,date:source.attendanceDate},independent):undefined;
  if(!isDeepStrictEqual(stored.policyFinancialDurationContract,duration))return false;
  if(duration?.state==='prepared'){
   if(header.durationOutcome!=='ready'||header.durationInputDigest!==duration.durationDigest
    ||header.payableNumerator!==String(duration.minutes)||header.payableDenominator!=='1'
    ||header.approvalStatus!==duration.approvalStatus||header.policyRevisionId!==duration.policyRevisionId
    ||header.policyPartCount!==duration.parts.length)return false;
  }else if(header.durationOutcome!=='refused'||header.payableNumerator!==null||header.payableDenominator!==null)return false;
  if(expected.state!=='prepared')return header.outcome==='refused'&&!header.transferable&&lines.length===0;
  if(header.outcome!=='ready'||header.durationOutcome!=='ready'||!header.transferable
   ||header.policyRevisionId!==expected.policyRevisionId||header.policyPartCount!==expected.parts.length
   ||header.approvalStatus!==expected.approvalStatus||header.currency!==expected.currency.code
   ||header.minorScale!==expected.currency.minorScale||header.durationInputDigest!==expected.durationDigest
   ||header.payableNumerator!==String(expected.minutes)||header.payableDenominator!=='1'
   ||lines.length!==expected.lines.length)return false;
  return lines.every((row,index)=>{const owned=expected.lines[index];return row.tenantId===source.tenantId
   &&row.companyId===source.companyId&&row.calculationId===header.id&&row.sequence===index
   &&row.lineKey===owned.line.id&&row.componentId===owned.line.mapping.earningItemId
   &&row.amountMinorUnits===owned.line.amountMinorUnits&&isDeepStrictEqual(row.evidence,owned);});
 }catch{return false;}
}

export type PolicyFinancialDurationContract=
 |{state:'unavailable';authority:'policyFinancialDurationContractOnly'}
 |{state:'prepared';authority:'policyFinancialDurationContractOnly';identity:PolicyCoverageIdentity;
  policyRevisionId:string;approvalStatus:'approved'|'notRequired';durationDigest:string;minutes:number;
  coverage:CapturedCoverage;parts:PolicyProposalStoragePart[]};
/** Salary-free financial duration projection, consumed independently by TOIL. No cash input,
 * monetary formula, earning mapping, full retained cash JSON or salary digest is accepted. */
export function attendancePolicyFinancialDurationContract(identity:PolicyCoverageIdentity,
 source:IndependentPolicyDurationSource):PolicyFinancialDurationContract{
 const unavailable:PolicyFinancialDurationContract={state:'unavailable',authority:'policyFinancialDurationContractOnly'};
 try{
  const replay=attendancePolicyIndependentDurationReplay(source),approvalStatus=attendancePolicyIndependentRecordedApprovalStatus(source);
  if(replay.state!=='known'||replay.minutes<=0||!['approved','notRequired'].includes(approvalStatus))return unavailable;
  const coverage=attendancePolicyIndependentCapturedCoverage(identity,source);
  if(coverage.state!=='prepared'||coverage.durationDigest!==replay.digest||coverage.minutes!==replay.minutes)return unavailable;
  const parts=materializeAttendancePolicyProposalParts({source:source.source,policy:source.attendanceGroupPolicy,
   context:source.policyExecutionContext,work:source.policyWorkInput,durationFormulas:source.policyDurationFormulaInput,
   approvals:source.policyApprovalInput,proposal:source.policyExecutionProposal,rawEffect:source.policyRawEffectSource});
  if(!parts?.length||parts.length>3||parts.reduce((sum,part)=>sum+(attendancePolicyStoredPartCount(part)??NaN),0)!==replay.minutes)return unavailable;
  return {state:'prepared',authority:'policyFinancialDurationContractOnly',identity:{...identity},
   policyRevisionId:source.attendanceGroupPolicy!.id,approvalStatus:approvalStatus as 'approved'|'notRequired',
   durationDigest:replay.digest,minutes:replay.minutes,coverage,parts};
 }catch{return unavailable;}
}
