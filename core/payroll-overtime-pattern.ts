/** Formula OT is a canonical Payroll input, never an individual transaction or a second money ledger.
 * Generation/close hold the batch and use MVCC reads; only transfer acquires employee -> source -> batch. */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
import { attendance, company, compensation, employment, payComponent, payrollBatch, payrollCycle, type PayrollPolicyConfig } from '../db/schema';
import { withPayrollTenant } from './module-gate';
import { assertModuleGate } from './module-gate';
import { appendEvent, actorOf } from '../db/events';
import {
  assertOvertimeSettlementAvailableTx, reserveOvertimeSettlementTx, readOvertimeCalculationTx,
  readOvertimeSettlementForDayTx, readOvertimeCashSettlementsTx, listCoveredOvertimeDaysTx,
  readOvertimeCashDefinitionTx, canonicalOvertimePayrollInputTx, attendancePolicyFinancialContract, attendancePolicyStoredPartCount, lockOvertimePayrollBatchContextTx,
} from '../packs/attendance/service';
import { parseRecordedOvertimeEvaluation } from '../lib/overtime-pattern-result';
import { evaluateOvertimePattern, validateOvertimeInput } from '../lib/overtime-pattern-evaluate';
import { type OvertimeEvaluation, type OvertimeExact, type OvertimeLine } from '../lib/overtime-pattern-model';
import { compensationEffectiveOn } from './comp';
import { packFor } from '../localization/registry';
import { assertStatutory } from './company-tier';
import { resolveAssignedPolicy } from './payroll-policy';
import { applyOvertimeCapsDetailed } from './payroll-policy-config';
import { employedByCompanyDuring, provenCompanyDatesTx } from './employment-company';
import { EXCLUDE_TOIL_BANKED_DAYS, collectableCycleIds, prefillOvertimeFromAttendanceTx, resolveBatchScopeFilter, resolveEmploymentOvertimeWindowTx, type BatchScope } from './payroll';

/** Shared policy configuration precedes a batch lock; source locking remains the transfer
 * owner's employee/source order, and generation/close retain their no-source-lock read path. */
export async function lockPayrollOvertimeBatchContextTx(tx:Tx,ctx:SessionContext,batchId:string){
 return lockOvertimePayrollBatchContextTx(tx,ctx,batchId);
}

export const OVERTIME_PAYROLL_ERROR_CODES = ['invalid','permission','unavailable','stale','approval','currency','mapping','statutoryFloor','wageIneligible','unsupportedRun','coverage','conflict','unknownHours'] as const;
export type OvertimePayrollErrorCode = typeof OVERTIME_PAYROLL_ERROR_CODES[number];
const SAFE: Record<OvertimePayrollErrorCode,string> = {
 invalid:'Choose a valid overtime day, calculation, draft run and reason.', permission:'Your financial authority does not cover this overtime source or run.',
 unavailable:'The recorded overtime calculation is unavailable. Review the Attendance day.', stale:'Overtime inputs or approval changed. Recalculate Attendance before Payroll.',
 approval:'Overtime must have a ready, approved calculation before cash transfer.', currency:'The overtime currency or precision is incompatible with this Payroll run.',
 mapping:'An overtime earning item is unavailable or has incompatible statutory treatment.', statutoryFloor:'The formula payment is below the country or assigned Payroll policy minimum. Review the formula.',
 wageIneligible:'The period-effective wage basis does not qualify for the country overtime calculation.', unsupportedRun:'Formula overtime can be paid only in a regular Payroll run.',
 coverage:'This overtime day or employee is outside the run scope or overtime cut-off window.', conflict:'This day already has an incompatible Payroll or TOIL settlement.',
 unknownHours:'A monthly overtime hours cap requires evidenced hours for every cash input. Review manual or one-off overtime.',
};
export class OvertimePayrollError extends Error { constructor(readonly code:OvertimePayrollErrorCode){super(SAFE[code]);this.name='OvertimePayrollError';} }
function fail(code:OvertimePayrollErrorCode):never{throw new OvertimePayrollError(code);}
const round2=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
function uuid(v:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))fail('invalid');return v;}
function date(v:string){const parsed=new Date(v+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==v)fail('invalid');return v;}
function exactNumber(v:OvertimeExact){const n=Number(v.numerator),d=Number(v.denominator);if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||n<0||d<=0)fail('unavailable');return n/d;}
function minorNumber(v:string){if(!/^\d{1,16}$/.test(v))fail('unavailable');const n=Number(v);if(!Number.isSafeInteger(n))fail('unavailable');return n;}
function stableJSON(raw:unknown):string {if(Array.isArray(raw))return '['+raw.map(stableJSON).join(',')+']';if(raw&&typeof raw==='object')return '{'+Object.keys(raw).sort().map(k=>JSON.stringify(k)+':'+stableJSON((raw as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(raw);}
function record(raw:unknown):Record<string,unknown>|null{return raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:null;}
function periodEnd(period:string){if(!/^\d{4}-\d{2}$/.test(period))fail('invalid');const [y,m]=period.split('-').map(Number);if(m<1||m>12)fail('invalid');return period+'-'+String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0');}
async function financial(tx:Tx,companyId:string){const rows=await tx.execute(sql`select app.can_admin_payroll_for(${companyId}::uuid) as allowed`) as unknown as {allowed:boolean}[];if(!rows[0]?.allowed)fail('permission');}

/** All selected formula outcomes exclude legacy payment. Missing source identity is a durable refusal. */
export async function readPayrollOvertimeCoverageTx(tx:Tx,ctx:SessionContext,p:{companyId:string;from:string;to:string;employmentIds?:readonly string[];refuseUnresolved?:boolean;payPeriod?:string}){
 await financial(tx,p.companyId);
 const days=await tx.select({employmentId:attendance.employmentId,date:attendance.attendanceDate,trace:attendance.calcTrace,minutes:attendance.otMinutes,dayType:attendance.dayType,cashEligible:EXCLUDE_TOIL_BANKED_DAYS}).from(attendance).innerJoin(employment,eq(employment.id,attendance.employmentId)).where(and(employedByCompanyDuring(p.companyId,p.from,p.to),gte(attendance.attendanceDate,p.from),lte(attendance.attendanceDate,p.to),p.employmentIds?inArray(attendance.employmentId,[...p.employmentIds]):undefined)).orderBy(asc(attendance.employmentId),asc(attendance.attendanceDate)).limit(50001);
 if(days.length>50000)fail('unavailable');
 const ids=[...new Set(days.map(r=>r.employmentId))];
 const covered=ids.length?await listCoveredOvertimeDaysTx(tx,ctx,{employmentIds:ids,from:p.from,to:p.to}):[];
 const keys=new Set(covered.filter(r=>r.companyId===p.companyId).map(r=>r.employmentId+'|'+r.date));
 const unresolved:{employmentId:string;date:string}[]=[];
 for(const day of days){const marker=record(record(day.trace)?.overtimePattern);if(marker?.status==='refused'&&marker.reason==='sourceUnavailable'){keys.add(day.employmentId+'|'+day.date);unresolved.push(day);}}
 if(p.refuseUnresolved&&unresolved.length){for(const day of unresolved){const window=await resolveEmploymentOvertimeWindowTx(tx,{companyId:p.companyId,employmentId:day.employmentId,payPeriod:p.payPeriod??p.to.slice(0,7)});if(day.date>=window.start&&day.date<=window.end)fail('unavailable');}}
 return {keys,days,employmentIds:[...new Set([...covered.filter(r=>r.companyId===p.companyId).map(r=>r.employmentId),...unresolved.map(r=>r.employmentId)])],unresolved};
}

export type PayrollOvertimePatternLine={sourceId:string;calculationId:string;sourceRevision:number;settlementId:string;employmentId:string;date:string;dayType:'workday'|'rest_day'|'holiday';lineId:string;earningItemId:string;earningItemCode:string;earningItemName:string;treatment:{epf:boolean;socso:boolean;pcb:boolean;hrdf:boolean};floorEvidence:{countryMinimumApplicable:boolean;minimumMinorUnits:string;periodEnd:string};amountMinorUnits:string;payableMinutes:OvertimeExact;evidence:OvertimeLine};
export type PayrollOvertimePatternCash={lines:PayrollOvertimePatternLine[];byEmployment:Map<string,PayrollOvertimePatternLine[]>};

type CalculationRead=NonNullable<Awaited<ReturnType<typeof readOvertimeCalculationTx>>>;
/** Verify the original immutable definition against matched canonical inputs; never reprice with today's policy. */
async function boundCalculationTx(tx:Tx,ctx:SessionContext,r:CalculationRead){
 const c=r.calculation,e=r.evidence;
 if(!c||!e||c.id!==r.source.currentCalculationId||c.ordinal!==r.source.revision||c.sourceId!==r.source.id)fail('stale');
 if(c.bindingKind==='attendanceGroupPolicy')return boundPolicyCalculationTx(tx,ctx,r);
 if(!c.versionId||!c.assignmentId)fail('stale');
 const evaluation=parseRecordedOvertimeEvaluation(record(e.evidence)?.evaluation);
 if(!evaluation||evaluation.status!=='ready'||!evaluation.transferable||c.outcome!=='ready'||!c.transferable||!['approved','notRequired'].includes(c.approvalStatus))fail('approval');
 const stored=validateOvertimeInput(e.inputs);
 if(stored.mode!=='actual'||stored.layer!=='raw'||evaluation.source.tenantId!==ctx.tenantId||evaluation.source.employmentId!==r.source.employmentId||evaluation.source.attendanceId!==r.source.attendanceId||evaluation.source.date!==r.source.attendanceDate||evaluation.patternVersionId!==c.versionId||evaluation.assignmentId!==c.assignmentId||evaluation.source.inputDigest!==c.inputDigest||evaluation.source.approvalDigest!==c.approvalDigest||stored.source.inputDigest!==c.inputDigest||stored.source.approvalDigest!==c.approvalDigest||stored.source.tenantId!==ctx.tenantId||stored.source.employmentId!==r.source.employmentId||stored.source.attendanceId!==r.source.attendanceId||stored.source.date!==r.source.attendanceDate||stored.patternVersionId!==c.versionId||stored.assignmentId!==c.assignmentId||stored.approval.status!==c.approvalStatus||c.durationOutcome!=='ready')fail('stale');
 if(e.calculationId!==c.id||e.companyId!==r.source.companyId||e.tenantId!==ctx.tenantId)fail('unavailable');
 const fresh=await canonicalOvertimePayrollInputTx(tx,ctx,{employmentId:r.source.employmentId,date:r.source.attendanceDate});
 if(fresh.attendanceGroupPolicy)fail('stale');
 if(fresh.input.source.inputDigest!==c.inputDigest||fresh.input.source.approvalDigest!==c.approvalDigest||fresh.referenceDigest!==c.referenceDigest||fresh.input.source.attendanceId!==r.source.attendanceId||fresh.input.approval.status!==c.approvalStatus)fail('stale');
 const canonical=validateOvertimeInput({...fresh.input,mode:'actual',patternVersionId:c.versionId,assignmentId:c.assignmentId});
 if(stableJSON(stored)!==stableJSON(canonical))fail('stale');
 const definition=await readOvertimeCashDefinitionTx(tx,ctx,{versionId:c.versionId,assignmentId:c.assignmentId,companyId:r.source.companyId,employmentId:r.source.employmentId,date:r.source.attendanceDate,facts:canonical.facts});
 // Digests establish freshness, not computation authenticity. Verify the entire recorded result
 // with the one shared engine and the EXACT recorded version; mismatch refuses, never rewrites.
 const verified=evaluateOvertimePattern(definition.definition,canonical);
 if(verified.status!=='ready'||!verified.transferable||stableJSON(verified)!==stableJSON(evaluation))fail('stale');
 if(evaluation.currency.code!==c.currency||evaluation.currency.minorScale!==c.minorScale||definition.definition.currency.code!==c.currency||definition.definition.currency.minorScale!==c.minorScale||fresh.input.currency.code!==c.currency||fresh.input.currency.minorScale!==c.minorScale||c.minorScale!==2)fail('currency');
 if(r.lines.length!==evaluation.lines.length)fail('unavailable');
 for(let i=0;i<r.lines.length;i++){const line=r.lines[i],proof=evaluation.lines[i];if(line.tenantId!==ctx.tenantId||line.companyId!==r.source.companyId||line.calculationId!==c.id||line.sequence!==i||line.lineKey!==proof.id||line.componentId!==proof.mapping.earningItemId||line.amountMinorUnits!==proof.amountMinorUnits||stableJSON(line.evidence)!==stableJSON(proof))fail('unavailable');}
 // Duration and cash proofs must agree exactly; the independent persisted duration is not a new payout identity.
 if(evaluation.payableMinutes.numerator!==c.payableNumerator||evaluation.payableMinutes.denominator!==c.payableDenominator)fail('unavailable');
 return {kind:'assigned' as const,evaluation,fresh,calculationId:c.id};
}

/** Policy identity remains distinct from an assignment and from any one dated formula.
 * Rebuild one parent through the existing canonical duration/captured/central money owners. */
async function boundPolicyCalculationTx(tx:Tx,ctx:SessionContext,r:CalculationRead){
 const c=r.calculation,e=r.evidence;
 if(!c||!e||c.bindingKind!=='attendanceGroupPolicy'||c.versionId!==null||c.assignmentId!==null
  ||!c.policyRevisionId||c.outcome!=='ready'||c.durationOutcome!=='ready'||!c.transferable)fail('approval');
 if(e.calculationId!==c.id||e.companyId!==r.source.companyId||e.tenantId!==ctx.tenantId)fail('unavailable');
 const fresh=await canonicalOvertimePayrollInputTx(tx,ctx,{employmentId:r.source.employmentId,date:r.source.attendanceDate});
 const contract=attendancePolicyFinancialContract({tenantId:ctx.tenantId,companyId:r.source.companyId,
  employmentId:r.source.employmentId,sourceId:r.source.id,calculationId:c.id,date:r.source.attendanceDate},fresh);
 if(contract.state!=='prepared'||contract.policyRevisionId!==c.policyRevisionId
  ||contract.inputDigest!==c.inputDigest||contract.approvalDigest!==c.approvalDigest||contract.referenceDigest!==c.referenceDigest
  ||contract.durationDigest!==c.durationInputDigest||String(contract.minutes)!==c.payableNumerator||c.payableDenominator!=='1'
  ||contract.approvalStatus!==c.approvalStatus||contract.parts.length!==c.policyPartCount
  ||stableJSON(contract)!==stableJSON(record(e.evidence)?.policyFinancialContract))fail('stale');
 if(stableJSON(e.inputs)!==stableJSON({...fresh.input,mode:'actual',patternVersionId:null,assignmentId:null}))fail('stale');
 if(contract.currency.code!==c.currency||contract.currency.minorScale!==c.minorScale||c.minorScale!==2)fail('currency');
 const parts='policyParts' in r?r.policyParts:undefined;
 if(!parts||parts.length!==contract.parts.length)fail('unavailable');
 const fields=['sequence','calendarDate','dayClass','moneyDay','versionId','rawMinutes','allocatedPayableMinutes','sourceIntervals','calendarReferences','durationEvidence'] as const;
 for(const [index,part]of parts.entries()){
  if(part.tenantId!==ctx.tenantId||part.companyId!==r.source.companyId||part.calculationId!==c.id||part.inputDigest!==c.inputDigest
   ||stableJSON(Object.fromEntries(fields.map(key=>[key,part[key]])))!==stableJSON(contract.parts[index]))fail('unavailable');
 }
 if(r.lines.length!==contract.lines.length)fail('unavailable');
 for(const [index,row]of r.lines.entries()){
  const expected=contract.lines[index];
  if(row.tenantId!==ctx.tenantId||row.companyId!==r.source.companyId||row.calculationId!==c.id||row.sequence!==index
   ||row.lineKey!==expected.line.id||row.componentId!==expected.line.mapping.earningItemId
   ||row.amountMinorUnits!==expected.line.amountMinorUnits||stableJSON(row.evidence)!==stableJSON(expected))fail('unavailable');
 }
 return {kind:'policy' as const,contract,fresh,calculationId:c.id};
}

/** Cutoff admission follows every positive dated allocation of a validated parent.
 * The original Attendance date remains its source identity, not an invented pricing date. */
function calculationDates(r:CalculationRead):string[]{
 if(r.calculation?.bindingKind!=='attendanceGroupPolicy')return [r.source.attendanceDate];
 const parts='policyParts' in r?r.policyParts:undefined;
 if(!parts||parts.length!==r.calculation.policyPartCount)fail('unavailable');
 const dates=parts.filter(part=>(attendancePolicyStoredPartCount(part)??-1)>0).map(part=>part.calendarDate);
 if(!dates.length||dates.length>3||new Set(dates).size!==dates.length)fail('unavailable');
 return dates;
}

async function targetTx(tx:Tx,ctx:SessionContext,p:{batchId:string;employmentId:string;date:string;dates?:readonly string[];companyId:string;status:'draft'|'processed'}){
 const [batch]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,uuid(p.batchId))).limit(1);if(!batch||batch.companyId!==p.companyId)fail('coverage');await financial(tx,batch.companyId);
 if(batch.status!==p.status)fail('stale');if(batch.runType!=='regular')fail('unsupportedRun');
 const scoped=await resolveBatchScopeFilter(tx,batch.scope as BatchScope|null);if(scoped.employmentIds&&!scoped.employmentIds.includes(p.employmentId))fail('coverage');
 const dates=[...new Set(p.dates??[p.date])];if(!dates.length||dates.length>3)fail('coverage');
 const window=await resolveEmploymentOvertimeWindowTx(tx,{companyId:batch.companyId,employmentId:p.employmentId,payPeriod:batch.payPeriod});
 for(const on of dates){date(on);if(on<window.start||on>window.end)fail('coverage');}
 const companies=await provenCompanyDatesTx(tx,dates.map(on=>({employmentId:p.employmentId,date:on})));
 if(dates.some(on=>companies.get(p.employmentId+'|'+on)?.companyId!==batch.companyId))fail('coverage');
 const collectable=await collectableCycleIds(tx,batch);if(!collectable.collectsUnnamed)fail('coverage');
 return batch;
}
async function pricedLinesTx(tx:Tx,ctx:SessionContext,r:CalculationRead,batch:typeof payrollBatch.$inferSelect,settlementId:string):Promise<PayrollOvertimePatternLine[]>{
 const bound=await boundCalculationTx(tx,ctx,r),calculationId=bound.calculationId;
 type Allocation={sequence:number;date:string;dayType:'workday'|'rest_day'|'holiday';minutes:OvertimeExact;amountMinorUnits:string;lines:OvertimeLine[]};
 const allocations:Allocation[]=[];
 const currency=bound.kind==='policy'?bound.contract.currency:bound.evaluation.currency;
 if(bound.kind==='policy'){
  for(const [sequence,part]of bound.contract.parts.entries()){
   const minutes=attendancePolicyStoredPartCount(part);if(minutes===null)fail('unavailable');if(!minutes)continue;
   if(!['workday','rest_day','holiday'].includes(part.moneyDay))fail('unavailable');
   const lines=bound.contract.lines.filter(row=>row.partSequence===sequence).map(row=>row.line);
   allocations.push({sequence,date:part.calendarDate,dayType:part.moneyDay as Allocation['dayType'],
    minutes:{unit:'minutes',numerator:String(minutes),denominator:'1'},
    amountMinorUnits:lines.reduce((n,line)=>n+BigInt(line.amountMinorUnits),BigInt('0')).toString(),lines});
  }
 }else{
  const day=bound.fresh.input.facts.dayType;
  if(day?.state!=='known'||typeof day.value!=='string'||!['workday','rest_day','holiday'].includes(day.value))fail('unavailable');
  allocations.push({sequence:0,date:r.source.attendanceDate,dayType:day.value as Allocation['dayType'],
   minutes:bound.evaluation.payableMinutes,amountMinorUnits:bound.evaluation.amountMinorUnits,lines:bound.evaluation.lines});
 }
 if(!allocations.length)fail('unavailable');
 // The parent is indivisible. Every actual payable date must fit this run's existing cut-off
 // and dated employer scope; a parent source date cannot stand in for its next-day money.
 if(bound.kind==='policy')await targetTx(tx,ctx,{batchId:batch.id,employmentId:r.source.employmentId,date:r.source.attendanceDate,
  companyId:r.source.companyId,status:batch.status==='draft'?'draft':'processed',dates:allocations.map(row=>row.date)});
 const [entity]=await tx.select().from(company).where(eq(company.id,batch.companyId)).limit(1);
 if(!entity)fail('permission');assertStatutory(entity.statutoryTier,'Payroll',entity.legalName);
 const pack=packFor(entity.country);if(!pack)fail('unavailable');if(entity.currency!==currency.code)fail('currency');
 const seed=pack.payComponents.defaults.find(row=>row.code===pack.payComponents.backfillCodes.overtime);if(!seed)fail('mapping');
 const allLines=allocations.flatMap(row=>row.lines),ids=[...new Set(allLines.map(line=>line.mapping.earningItemId))];
 const components=ids.length?await tx.select().from(payComponent).where(and(inArray(payComponent.id,ids),eq(payComponent.tenantId,ctx.tenantId),isNull(payComponent.archivedAt),isNull(payComponent.pendingInputKind))):[];
 const byId=new Map(components.map(row=>[row.id,row]));
 for(const line of allLines){const item=byId.get(line.mapping.earningItemId);
  if(!item||line.mapping.currency!==entity.currency||item.kind!==seed.kind||item.isNonPayable!==seed.isNonPayable
   ||item.includedInEpf!==seed.includedInEpf||item.includedInSocsoEis!==seed.includedInSocsoEis
   ||item.includedInPcb!==seed.includedInPcb||item.includedInHrdfBase!==seed.includedInHrdfBase||item.epfBonus2012
   ||item.pcbExemptionCode||item.pcbRemunerationType==='optional_deduction'||item.pcbRemunerationType==='normal')fail('mapping');
 }
 const end=periodEnd(batch.payPeriod),comps=await tx.select().from(compensation)
  .where(and(eq(compensation.employmentId,r.source.employmentId),compensationEffectiveOn(end))).limit(2);
 if(comps.length!==1||comps[0].currency!==entity.currency)fail('unavailable');
 const rules=await pack.payroll.loadRuleset(tx,{asOf:end}),cfg=(await resolveAssignedPolicy(tx,r.source.employmentId))?.config??null;
 const result:PayrollOvertimePatternLine[]=[];
 for(const allocation of allocations){
  const minimum=pack.payroll.overtimePay({monthlyWages:round2(Number(comps[0].basicSalary)+Number(comps[0].monthlyAllowance??0)),
   days:[{dayType:allocation.dayType,minutes:exactNumber(allocation.minutes)}],wageCeiling:rules.ot.wageCeiling,
   restDayExcessMultiplier:rules.ot.restDayExcessMultiplier,holidayExcessMultiplier:rules.ot.holidayExcessMultiplier});
  // Country and assigned policy floors retain their existing owners, independently for each
  // actual dated part. Above-ceiling contractual money is not replaced by a fabricated floor.
  const floor=minimum.eligible?applyOvertimeCapsDetailed({overtime:{multiplier:cfg?.overtime?.multiplier}},
   {workday:minimum.workday,restDay:minimum.restDay,holiday:minimum.holiday,workedOtHours:0}).capped:0;
  if(minorNumber(allocation.amountMinorUnits)<Math.round(floor*100))fail('statutoryFloor');
  for(const line of allocation.lines)result.push({sourceId:r.source.id,calculationId,sourceRevision:r.source.revision,settlementId,
   employmentId:r.source.employmentId,date:allocation.date,dayType:allocation.dayType,lineId:line.id,
   earningItemId:line.mapping.earningItemId,earningItemCode:byId.get(line.mapping.earningItemId)!.code,
   earningItemName:byId.get(line.mapping.earningItemId)!.name,
   treatment:{epf:seed.includedInEpf,socso:seed.includedInSocsoEis,pcb:seed.includedInPcb,hrdf:seed.includedInHrdfBase},
   floorEvidence:{countryMinimumApplicable:minimum.eligible,minimumMinorUnits:String(Math.round(floor*100)),periodEnd:end},
   amountMinorUnits:line.amountMinorUnits,payableMinutes:line.payableMinutes,evidence:line});
 }
 return result;
}

/** Retained obligations remain readable after Attendance module removal. No employee/source locks here. */
export async function readPayrollOvertimePatternCashTx(tx:Tx,ctx:SessionContext,p:{batchId:string}):Promise<PayrollOvertimePatternCash>{
 const claims=await readOvertimeCashSettlementsTx(tx,ctx,p);const lines:PayrollOvertimePatternLine[]=[];
 for(const claim of claims){const calculation=claim.calculation;if(!calculation){continue;} // Legacy cash claims protect identity; legacy Payroll still supplies their amount.
  const [b]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId)).limit(1);if(!b)fail('unavailable');
  const evidence=claim.evidence;if(!evidence)fail('stale');
  const contribution:CalculationRead=calculation.bindingKind==='attendanceGroupPolicy'
   ?await readOvertimeCalculationTx(tx,ctx,{employmentId:claim.source.employmentId,date:claim.source.attendanceDate})??fail('stale')
   :{source:claim.source,calculation,evidence,lines:claim.lines};
  if(contribution.calculation?.id!==calculation.id)fail('stale');
  await targetTx(tx,ctx,{batchId:p.batchId,employmentId:claim.source.employmentId,date:claim.source.attendanceDate,
   dates:calculationDates(contribution),companyId:claim.source.companyId,status:b.status==='draft'?'draft':'processed'});
  lines.push(...await pricedLinesTx(tx,ctx,contribution,b,claim.settlement.id));
 }
 const byEmployment=new Map<string,PayrollOvertimePatternLine[]>();for(const line of lines){const list=byEmployment.get(line.employmentId)??[];list.push(line);byEmployment.set(line.employmentId,list);}return {lines,byEmployment};
}

/** Combined order: legacy policy re-rate/filter; formula filter only; one hours cap then one money cap.
 * Exact minor-unit line allocation uses proportional floors and a residual in stable line order. */
export function composePayrollOvertime(p:{config:PayrollPolicyConfig|null;legacy:{workday:number;restDay:number;holiday:number;minutes:number|null};lines:PayrollOvertimePatternLine[]}){
 const ot=p.config?.overtime;
 const legacy=applyOvertimeCapsDetailed({overtime:{multiplier:ot?.multiplier,eligibleDayTypes:ot?.eligibleDayTypes}},{...p.legacy,workedOtHours:0}).capped;
 const eligible=p.lines.filter(l=>!ot?.eligibleDayTypes||ot.eligibleDayTypes.includes(l.dayType));
 const formulaMinor=eligible.reduce((sum,l)=>sum+BigInt(l.amountMinorUnits),BigInt('0'));if(formulaMinor>BigInt(Number.MAX_SAFE_INTEGER))fail('unavailable');
 const formula=Number(formulaMinor)/100;
 if(ot?.maxHoursPerMonth&&p.legacy.minutes===null&&(p.legacy.workday+p.legacy.restDay+p.legacy.holiday)>0)fail('unknownHours');
 // Canonical policy filters MONEY but compares ALL evidenced OT hours. Source representation cannot alter this basis.
 const minutes=(p.legacy.minutes??0)+p.lines.reduce((sum,l)=>sum+exactNumber(l.payableMinutes),0);
 const capped=applyOvertimeCapsDetailed({overtime:{maxHoursPerMonth:ot?.maxHoursPerMonth,maxAmount:ot?.maxAmount}},{workday:round2(legacy+formula),restDay:0,holiday:0,workedOtHours:minutes/60});
 const preMinor=BigInt(Math.round(capped.preCap*100)),totalMinor=BigInt(Math.round(capped.capped*100));
 const ordered=[{id:'legacy',amount:BigInt(Math.round(legacy*100))},...eligible.map(l=>({id:l.settlementId+':'+l.lineId,amount:BigInt(l.amountMinorUnits)}))];
 const values=ordered.map(l=>preMinor?l.amount*totalMinor/preMinor:BigInt('0'));
 let remaining=totalMinor-values.reduce((sum,value)=>sum+value,BigInt('0'));
 // Stable reverse order preserves the existing residual convention, but only ORIGINAL positive
 // capacity may receive it. Zero-price mappings never become paid merely by being last.
 for(let i=ordered.length-1;i>=0&&remaining>BigInt('0');i--){const capacity=ordered[i].amount-values[i],take=capacity<remaining?capacity:remaining;values[i]+=take;remaining-=take;}
 if(remaining!==BigInt('0')||values.some((value,i)=>value<BigInt('0')||value>ordered[i].amount))fail('unavailable');
 const allocations=ordered.map((l,i)=>({id:l.id,amountMinorUnits:values[i].toString()}));
 return {capped:capped.capped,excess:capped.excess,preCap:capped.preCap,allocations,minutes,evidence:{order:'legacy-policy-then-formula-filter-then-hours-then-amount',allocation:'proportional-minor-floor-stable-capacity-residual',hourBasis:'all-evidenced-ot-minutes-before-day-type-money-filter',sourceLines:p.lines,allocations}};
}

export async function overtimePatternTransferOptions(ctx:SessionContext,p:{employmentId:string;date:string}){
 assertModuleGate(ctx,'attendance');uuid(p.employmentId);date(p.date);
 return withPayrollTenant(ctx,async tx=>{
  const read=await readOvertimeCalculationTx(tx,ctx,p);if(!read)fail('unavailable');const claim=await readOvertimeSettlementForDayTx(tx,ctx,p);const c=read.calculation;
  const [entity]=await tx.select({currency:company.currency}).from(company).where(eq(company.id,read.source.companyId)).limit(1);if(!entity)fail('permission');
  const batches=await tx.select({batch:payrollBatch,cycleName:payrollCycle.name}).from(payrollBatch).leftJoin(payrollCycle,eq(payrollCycle.id,payrollBatch.payrollCycleId)).where(and(eq(payrollBatch.companyId,read.source.companyId),eq(payrollBatch.status,'draft'),eq(payrollBatch.runType,'regular'))).orderBy(asc(payrollBatch.payPeriod),asc(payrollBatch.id)).limit(1001);if(batches.length>1000)fail('unavailable');
  const runs:{id:string;payPeriod:string;runType:string;batchDate:string;cycleName:string|null;status:'draft';transferable:boolean;refusal:OvertimePayrollErrorCode|null}[]=[];
  for(const r of batches){try{await targetTx(tx,ctx,{batchId:r.batch.id,...p,dates:calculationDates(read),companyId:read.source.companyId,status:'draft'});runs.push({id:r.batch.id,payPeriod:r.batch.payPeriod,runType:r.batch.runType,batchDate:r.batch.batchDate,cycleName:r.cycleName,status:'draft',transferable:false,refusal:'unavailable'});}catch(error){if(!(error instanceof OvertimePayrollError)||error.code!=='coverage')throw error;}}
  const result=c?parseRecordedOvertimeEvaluation(record(read.evidence?.evidence)?.evaluation):null;
  const policyFinancial=record(record(read.evidence?.evidence)?.policyFinancialContract);
  let transferable=false;
  for(const run of runs){
   if(claim?.settlement&&(claim.settlement.mode==='toil'||claim.settlement.payrollBatchId!==run.id)){run.refusal='conflict';continue;}
   if(!c||c.outcome!=='ready'||!c.transferable){
    // A refused/unknown source is not necessarily an approval failure.
    run.refusal=c&&['pending','rejected'].includes(c.approvalStatus)?'approval':'unavailable';continue;
   }
   try{
    const candidate=batches.find(r=>r.batch.id===run.id)!.batch;
    await pricedLinesTx(tx,ctx,read,candidate,claim?.settlement?.id??'preview');
    run.transferable=true;run.refusal=null;transferable=true;
   }catch(error){if(!(error instanceof OvertimePayrollError))throw error;run.refusal=error.code;}
  }
  return {companyId:read.source.companyId,currency:entity.currency,...p,calculation:c?{id:c.id,sourceRevision:read.source.revision,status:c.outcome,approvalStatus:c.approvalStatus,transferable,amountMinorUnits:c.bindingKind==='attendanceGroupPolicy'
   ?policyFinancial?.state==='prepared'?String(policyFinancial.amountMinorUnits):null
   :result&&result.status!=='refused'?result.amountMinorUnits:null,minorScale:c.minorScale}:null,runs,settlement:claim?.settlement?{id:claim.settlement.id,mode:claim.settlement.mode,batchId:claim.settlement.payrollBatchId}:null};
 });
}
export async function transferOvertimePatternToPayroll(ctx:SessionContext,p:{employmentId:string;date:string;expectedCalculationId:string;expectedSourceRevision:number;batchId:string;reason:string}){
 assertModuleGate(ctx,'attendance');uuid(p.employmentId);uuid(p.expectedCalculationId);uuid(p.batchId);date(p.date);const reason=p.reason?.trim();if(!reason||reason.length>1000||!Number.isSafeInteger(p.expectedSourceRevision)||p.expectedSourceRevision<1)fail('invalid');
 return withPayrollTenant(ctx,async tx=>{
  // This owner helper takes employee advisory then existing source; only then may the batch lock be taken.
  const available=await assertOvertimeSettlementAvailableTx(tx,ctx,{employmentId:p.employmentId,date:p.date,mode:'cash'});
  if(available.source.revision!==p.expectedSourceRevision||available.source.currentCalculationId!==p.expectedCalculationId)fail('stale');
  const read=await readOvertimeCalculationTx(tx,ctx,p);if(!read)fail('unavailable');
  // Employee/source precede the policy epoch; the fresh binding must finish before batch.
  await boundCalculationTx(tx,ctx,read);
  await lockPayrollOvertimeBatchContextTx(tx,ctx,p.batchId);
  const [locked]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId)).limit(1).for('update');if(!locked)fail('coverage');
  const batch=await targetTx(tx,ctx,{...p,dates:calculationDates(read),companyId:available.source.companyId,status:'draft'});
  await pricedLinesTx(tx,ctx,read,batch,available.existing?.id??'pending');
  if(available.existing&&(available.existing.payrollBatchId!==p.batchId||available.existing.calculationId!==p.expectedCalculationId))fail('conflict');
  const settlement=await reserveOvertimeSettlementTx(tx,ctx,{employmentId:p.employmentId,date:p.date,mode:'cash',calculationId:p.expectedCalculationId,payrollBatchId:p.batchId});
  // Remove the old aggregate for this covered day in the SAME transaction; independent keyed OT and bonus survive.
  await prefillOvertimeFromAttendanceTx(tx,ctx,{batchId:p.batchId,preserveManual:true,employmentId:p.employmentId});
  if(!available.existing)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-batch',aggregateId:p.batchId,eventType:'payroll-batch.overtime-pattern-transferred',actor:actorOf(ctx),payload:{sourceId:read.source.id,calculationId:p.expectedCalculationId,settlementId:settlement.id,reason}});
  return {sourceId:read.source.id,calculationId:p.expectedCalculationId,settlementId:settlement.id,batchId:p.batchId,status:available.existing?'unchanged' as const:'transferred' as const};
 });
}
