import {attendancePolicyAttestedWorkInput,attestedPolicyCountSegments} from './policy-attested-work-input';
import {replayAttendancePolicyRawClocks} from './policy-clock-replay';
import {attendancePolicyDurationExecutionProposal} from './policy-execution-proposal';
import {attendancePolicyFormulaInputTx,attendancePolicyDurationFormulaInputTx} from './policy-formula-input';
import {attendancePolicyApprovalInput} from './policy-approval-input';
import {attendancePolicyNetWorkedMinutes,attendancePolicyWorkInput} from './policy-work-input';
import {attendancePolicyClockMeasurements} from './policy-clock-measurements';
/** Canonical Attendance/Personnel inputs. No current profile substitution for historical facts. */
import {createHash} from 'node:crypto';
import {and, asc, desc, eq, gt, inArray, isNull, lte, or, sql} from 'drizzle-orm';
import type {SessionContext, Tx} from '../../db/client';
import {recordedAttendanceGroupPolicyTx} from './policy-selection';
import {recordedPolicyClockSourceTx} from './policy-clock-input';
import {assignment, attendance, attendanceCorrection, attendancePolicyRequestContract, attendancePolicyFinalReceipt, attendancePunch, company, compensation, employment} from '../../db/schema';
import {provenCompanyDatesTx} from '../../core/employment-company';
import {compensationEffectiveOn} from '../../core/comp';
import {isAttendanceTrace} from '../../core/attendance-trace';
import {attendancePolicyExecutionContextTx} from '../../core/attendance';
import {assertModuleGate} from '../../core/module-gate';
import {currencyMinorScale, isCurrencyCode} from '../../lib/currencies';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {isCalendarDate} from '../../lib/calendar-date';
import {recordedOvertimeWork, type RecordedWorkInterval} from '../../lib/overtime-recorded-work';
import type {OvertimeFact, OvertimeFacts, OvertimeProvenance} from '../../lib/overtime-pattern-model';
import {captureOvertimePersonnelContextTx, readOvertimePersonnelContextTx, OvertimeOwnerError,
  type CanonicalOvertimeSnapshot} from './overtime-patterns';

const MUTABLE_AXES = ['gradeId', 'orgDivision', 'orgBranch', 'orgRegion', 'orgLine', 'orgSection', 'orgTeam', 'orgBase', 'employmentCategory'] as const;
const unknown = <T>(reason: string): OvertimeFact<T> => ({state: 'unknown', reason});
const known = <T>(value: T, provenance: OvertimeProvenance): OvertimeFact<T> => ({state: 'known', value, provenance});
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const unavailable = (): never => {throw new OvertimeOwnerError('unavailable', 'Recorded overtime inputs are unavailable for this employee and date.');};
const minute = (value: number | null | undefined, provenance: OvertimeProvenance): OvertimeFact<string> => value == null
  ? unknown('recordedDurationUnavailable') : Number.isSafeInteger(value) && value >= 0 ? known(String(value), provenance) : unknown('invalidRecordedDuration');
function sumRecordedMoney(first: string, second: string): string | null {
  const minor = (value: string): bigint | null => {
    const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
    return match ? BigInt(match[1]) * BigInt('100') + BigInt((match[2] ?? '').padEnd(2, '0')) : null;
  };
  const a = minor(first), b = minor(second);
  if (a == null || b == null) return null;
  const value = a + b;
  return String(value / BigInt('100')) + '.' + String(value % BigInt('100')).padStart(2, '0');
}

/** One money-fact projection for the actual period-effective compensation owner. */
function recordedSalaryFacts(salary:typeof compensation.$inferSelect|null,currency:string,date:string):Pick<OvertimeFacts,'basicSalary'|'calculationBase'>{
 if(!salary||salary.currency!==currency){const reason=salary?'recordedCurrencyMismatch':'recordedCompensationUnavailable';
  return {basicSalary:unknown(reason),calculationBase:unknown(reason)};}
 const provenance:OvertimeProvenance={owner:'payroll',reference:salary.id,asOf:date,basis:'effectiveDated'};
 const base=sumRecordedMoney(salary.basicSalary,salary.monthlyAllowance);
 return {basicSalary:known(salary.basicSalary,provenance),calculationBase:base===null?unknown('invalidRecordedMoney'):known(base,provenance)};
}

/** Called at the actual first current-day check-in, never by a client preview or historical import. */
export async function captureCanonicalOvertimePersonnelContextTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string}) {
  assertModuleGate(ctx, 'attendance');
  if (p.date !== todayInKualaLumpur()) return null;
  const proof = (await provenCompanyDatesTx(tx, [p])).get(p.employmentId + '|' + p.date);
  if (!proof?.companyId) return null; // compatibility: absent dated proof cannot break an unassigned legacy clock-in
  const [personnel] = await tx.select().from(employment).where(and(eq(employment.tenantId, ctx.tenantId), eq(employment.id, p.employmentId))).limit(1);
  if (!personnel) return null;
  const facts: OvertimeFacts = {};
  for (const field of MUTABLE_AXES) facts[field] = known(personnel[field], {owner: 'personnel', reference: personnel.id + ':' + field, asOf: p.date, basis: 'recorded'});
  return captureOvertimePersonnelContextTx(tx, ctx, {...p, facts});
}

/** Only captured calculation intervals with canonical punch corroboration can establish placement. */
function recordedIntervals(day: typeof attendance.$inferSelect, punches: (typeof attendancePunch.$inferSelect)[]): RecordedWorkInterval[] | null {
  const trace = isAttendanceTrace(day.calcTrace) ? day.calcTrace : null;
  if (!trace || !Array.isArray(trace.punch.calculationIntervals) || !trace.punch.calculationIntervals.length || !day.checkOutAt) return null;
  const intervals = trace.punch.calculationIntervals;
  // An old elapsed-envelope calculation does not become multiple physical sessions by inference.
  if (trace.punch.intervalSource !== 'closedPunchPairs' && (punches.length !== 2 || punches.filter(row => row.direction === 'in').length !== 1)) return null;
  if (intervals.length > 64 || punches.length !== intervals.length * 2) return null;
  const toMinute = (clock: string) => {const [hour, minute] = clock.split(':').map(Number); return hour * 60 + minute;};
  const used = new Set<string>();
  const base = Date.parse(day.attendanceDate + 'T00:00:00+08:00'); // existing HR_LOCAL_TZ clock owner contract
  const out: RecordedWorkInterval[] = [];
  for (const part of intervals) {
    if (![part.inAbs, part.outAbs].every(Number.isSafeInteger) || part.inAbs < 0 || part.outAbs <= part.inAbs || part.outAbs > 4320) return null;
    const ins = punches.filter(row => row.direction === 'in' && toMinute(row.punchAt) === part.inAbs % 1440 && !used.has(row.id));
    const outs = punches.filter(row => row.direction === 'out' && toMinute(row.punchAt) === part.outAbs % 1440 && !used.has(row.id));
    if (ins.length !== 1 || outs.length !== 1) return null;
    used.add(ins[0].id); used.add(outs[0].id);
    const localDate = new Date(Date.parse(day.attendanceDate + 'T00:00:00Z') + Math.floor(part.inAbs / 1440) * 86400000).toISOString().slice(0, 10);
    out.push({id: ins[0].id + ':' + outs[0].id, startEpochSeconds: String((base + part.inAbs * 60000) / 1000), localDate,
      localStartSecond: part.inAbs % 1440 * 60, elapsedSeconds: (part.outAbs - part.inAbs) * 60});
  }
  return used.size === punches.length ? out : null;
}

export async function canonicalOvertimeInputTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string}): Promise<CanonicalOvertimeSnapshot> {
  assertModuleGate(ctx, 'attendance');
  return readCanonicalInputsTx(tx, ctx, p);
}
/** Existing financial obligations remain source-checked if Attendance is later removed. This is a
 * distinct trusted reader, not a client-provided bypass of the Attendance configuration gate. */
export async function canonicalOvertimePayrollInputTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string}): Promise<CanonicalOvertimeSnapshot> {
  assertModuleGate(ctx, 'payroll');
  if (!isCalendarDate(p.date) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.employmentId)) unavailable();
  const proof = (await provenCompanyDatesTx(tx, [p])).get(p.employmentId + '|' + p.date);
  if (!proof?.companyId) unavailable();
  const permission = await tx.execute(sql`select app.can_admin_payroll_for(${proof!.companyId}::uuid) as allowed`) as unknown as {allowed: boolean}[];
  if (!permission[0]?.allowed) throw new OvertimeOwnerError('permission', 'The overtime source is outside your financial scope.');
  let snapshot=await readCanonicalInputsTx(tx,ctx,p);
  if(snapshot.attendanceGroupPolicy){
    // Transfers hold employee/source before entering. Retained Payroll consumers acquire the
    // SAME tenant epoch before their batch lock; this repeated shared read cannot invert it.
    await tx.execute(sql`select app.lock_attendance_policy_execution_context(${p.employmentId}::uuid,${p.date}::date)`);
    snapshot=await readCanonicalInputsTx(tx,ctx,p);
    const after=await tx.execute(sql`select app.can_admin_payroll_for(${proof!.companyId}::uuid) as allowed`) as unknown as {allowed:boolean}[];
    if(!after[0]?.allowed)throw new OvertimeOwnerError('permission','The overtime source is outside your financial scope.');
  }
  return snapshot;
}
/** TOIL's canonical owner already proves the election/decision authority. This reader retains
 * subject RLS and never elevates salary access merely to verify price-independent duration. */
export async function canonicalOvertimeToilInputTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string}): Promise<CanonicalOvertimeSnapshot> {
  assertModuleGate(ctx, 'toil');
  let snapshot=await readCanonicalInputsTx(tx,ctx,p,'duration');
  if(snapshot.attendanceGroupPolicy){
    // The TOIL owner takes employment/source locks before entering this shared configuration
    // barrier. Re-read after any wait; no monetary inputs are requested by this purpose.
    await tx.execute(sql`select app.lock_attendance_policy_execution_context(${p.employmentId}::uuid,${p.date}::date)`);
    snapshot=await readCanonicalInputsTx(tx,ctx,p,'duration');
  }
  return snapshot;
}
async function readCanonicalInputsTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string}, purpose:'money'|'duration'='money'): Promise<CanonicalOvertimeSnapshot> {
  if (!isCalendarDate(p.date) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.employmentId)) unavailable();
  const proof = (await provenCompanyDatesTx(tx, [p])).get(p.employmentId + '|' + p.date);
  if (!proof?.companyId) unavailable();
  const [day] = await tx.select().from(attendance).where(and(eq(attendance.tenantId, ctx.tenantId), eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date))).limit(1);
  const [entity] = await tx.select({id: company.id, currency: company.currency}).from(company).where(and(eq(company.tenantId, ctx.tenantId), eq(company.id, proof!.companyId!))).limit(1);
  if (!day || !entity || !isCurrencyCode(entity.currency)) unavailable();
  const policySelection=await recordedAttendanceGroupPolicyTx(tx,ctx,p);
  if(policySelection.state==='unavailable')unavailable();
  const selectedPolicy=policySelection.state==='policy'?policySelection.selected:undefined;
  const attestedSelection=policySelection.state==='policy'?policySelection.attested:undefined;
  const [assignments, salaries, punches, decisions, context] = await Promise.all([
    tx.select().from(assignment).where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.employmentId, p.employmentId), isNull(assignment.supersededAt), lte(assignment.validFrom, p.date), or(isNull(assignment.validTo), gt(assignment.validTo, p.date)))).orderBy(asc(assignment.validFrom), asc(assignment.id)).limit(2),
    // Dated group policies already own duration independently of salary. Legacy formulas keep
    // their existing source contract, including any explicitly configured duration fact dependency.
    selectedPolicy&&purpose==='duration'?Promise.resolve([]):tx.select().from(compensation).where(and(eq(compensation.tenantId, ctx.tenantId), eq(compensation.employmentId, p.employmentId), compensationEffectiveOn(p.date))).orderBy(asc(compensation.validFrom), asc(compensation.id)).limit(2),
    tx.select().from(attendancePunch).where(and(eq(attendancePunch.tenantId, ctx.tenantId), eq(attendancePunch.attendanceId, day.id), isNull(attendancePunch.voidedAt))).orderBy(asc(attendancePunch.punchAt), asc(attendancePunch.id)).limit(129),
    tx.select().from(attendanceCorrection).where(and(eq(attendanceCorrection.tenantId, ctx.tenantId), eq(attendanceCorrection.employmentId, p.employmentId), eq(attendanceCorrection.attendanceDate, p.date))).orderBy(desc(attendanceCorrection.decidedAt), desc(attendanceCorrection.createdAt), desc(attendanceCorrection.id)).limit(501),
    readOvertimePersonnelContextTx(tx, ctx, p),
  ]);
  if (assignments.length !== 1 || assignments[0].companyId !== proof!.companyId || punches.length > 128 || decisions.length > 500) unavailable();
  const policyClockSource=selectedPolicy?await recordedPolicyClockSourceTx(tx,ctx,{attendanceId:day.id,employmentId:p.employmentId,date:p.date,punches}):undefined;
  const assigned = assignments[0], salary = salaries.length === 1 ? salaries[0] : null;
  const trace = isAttendanceTrace(day.calcTrace) ? day.calcTrace : null;
  let policyExecutionContext:CanonicalOvertimeSnapshot['policyExecutionContext'];
  if(selectedPolicy){
    const resolved=await attendancePolicyExecutionContextTx(tx,ctx,p);
    const clockMinute=(clock:string|null)=>clock===null?null:Number(clock.slice(0,2))*60+Number(clock.slice(3,5));
    // Live configuration is a source input, not proof that an older raw result used it. Refuse a
    // mismatched recorded schedule rather than grafting new windows onto a historical calculation.
    if(attestedSelection&&resolved.state==='policy'&&fingerprint(resolved)===fingerprint(attestedSelection.context))policyExecutionContext=resolved;
    else if(resolved.state==='policy'&&trace&&resolved.selected.id===selectedPolicy.id&&resolved.companyId===selectedPolicy.companyId
      &&resolved.schedule.ruleId===trace.schedule.ruleId&&resolved.schedule.source===trace.schedule.source
      &&resolved.schedule.shiftId===trace.schedule.shiftId&&resolved.schedule.crossesMidnight===trace.schedule.crossesMidnight
      &&resolved.schedule.dailyCutoffMinutes===trace.schedule.dailyCutoffMinutes
      &&resolved.schedule.normalMinutes===(trace.schedule.normalMinutesOverride??trace.schedule.scheduledMinutes)
      &&resolved.schedule.breakMinutes===trace.schedule.breakMinutes&&clockMinute(resolved.schedule.start)===trace.schedule.startAbs
      &&(resolved.schedule.end===null?null:clockMinute(resolved.schedule.end)!+(resolved.schedule.crossesMidnight?1440:0))===trace.schedule.endAbs)
      policyExecutionContext=resolved;
    else policyExecutionContext={state:'unavailable',reason:'scheduleUnavailable'};
  }

  const attendanceProvenance = (field: string): OvertimeProvenance => ({owner: 'attendance', reference: day.id + ':' + field, asOf: p.date, basis: 'recorded'});
  const assignmentProvenance = (field: string): OvertimeProvenance => ({owner: 'personnel', reference: assigned.id + ':' + field, asOf: p.date, basis: 'effectiveDated'});
  const facts: OvertimeFacts = {};
  for (const field of MUTABLE_AXES) facts[field] = context?.facts[field] ?? unknown('recordedPersonnelContextUnavailable');
  for (const field of ['companyId', 'departmentId', 'businessUnitId', 'positionId', 'employmentType'] as const) facts[field] = known(assigned[field], assignmentProvenance(field));
  facts.employmentId = known(p.employmentId, assignmentProvenance('employmentId'));
  facts.shiftId = trace?.schedule.shiftId === undefined ? unknown('recordedShiftUnavailable') : known(trace.schedule.shiftId, attendanceProvenance('shiftId'));
  facts.scheduleGroupId = trace ? known(trace.schedule.ruleId, attendanceProvenance('scheduleGroupId')) : unknown('recordedScheduleGroupUnavailable');
  facts.attendanceStatus = known(day.status, attendanceProvenance('status'));
  facts.dayType = day.dayType ? known(day.dayType, attendanceProvenance('dayType')) : unknown('recordedDayTypeUnavailable');
  facts.actualWorkingMinutes = minute(day.workedMinutes, attendanceProvenance('workedMinutes'));
  facts.requiredWorkingMinutes = minute(trace ? trace.schedule.normalMinutesOverride ?? trace.schedule.scheduledMinutes : null, attendanceProvenance('requiredWorkingMinutes'));
  facts.lateMinutes = minute(day.lateMinutes, attendanceProvenance('lateMinutes'));
  Object.assign(facts,recordedSalaryFacts(salary,entity.currency,p.date));
  let work = recordedOvertimeWork({attendanceId: day.id, attendanceDate: p.date, workedMinutes: day.workedMinutes, dayType: day.dayType, intervals: recordedIntervals(day, punches)});
  // Use the same latest approved OT-bearing decision the canonical landing owner reasserts. A pending
  // later request does not silently revoke a completed decision; its exact state is included in the digest.
  const otDecisions = decisions.filter(row => row.requestedOtMinutes != null);
  const approved = otDecisions.find(row => row.status === 'approved');
  const pending = otDecisions.find(row => row.status === 'pending');
  const rejected = otDecisions.find(row => row.status === 'rejected');
  const approvalProvenance: OvertimeProvenance = {owner: 'approval', reference: approved?.id ?? pending?.id ?? rejected?.id ?? day.id + ':noOtRequest', asOf: p.date, basis: 'recorded'};
  const legacyRows = trace?.overtime?.rows;
  if (legacyRows != null && (!Array.isArray(legacyRows) || legacyRows.some(row => !row || typeof row !== 'object'))) unavailable();
  const legacyManualRows = legacyRows?.filter(row => row.manual) ?? [];
  // Legacy manual rate rows cannot be silently retiered by a different formula definition. The
  // original path still consumes them; a new formula requires deliberate review/clearance first.
  const approvalStatus = legacyManualRows.length ? 'unknown' : approved ? 'approved' : pending ? 'pending' : rejected ? 'rejected' : 'notRequired';
  const approvalMinutes = legacyManualRows.length ? unknown<string>('legacyManualOvertimeNeedsReview') : approved ? minute(approved.approvedOtMinutes, approvalProvenance) : approvalStatus === 'notRequired' ? work.rawMinutes : unknown<string>('approvalNotComplete');
  const policyContracts=selectedPolicy&&otDecisions.length?await tx.select().from(attendancePolicyRequestContract)
    .where(and(eq(attendancePolicyRequestContract.tenantId,ctx.tenantId),inArray(attendancePolicyRequestContract.correctionId,otDecisions.map(row=>row.id))))
    .orderBy(asc(attendancePolicyRequestContract.correctionId)).limit(501):[];
  const policyReceipts=selectedPolicy&&otDecisions.length?await tx.select().from(attendancePolicyFinalReceipt)
    .where(and(eq(attendancePolicyFinalReceipt.tenantId,ctx.tenantId),inArray(attendancePolicyFinalReceipt.correctionId,otDecisions.map(row=>row.id))))
    .orderBy(asc(attendancePolicyFinalReceipt.correctionId)).limit(501):[];
  const policyApprovalInput=selectedPolicy?attendancePolicyApprovalInput(selectedPolicy,otDecisions,policyContracts,policyReceipts):undefined;
  // New policy proofs retain exact timestamp strings and original plan labels. Keep the existing
  // legacy digest contract unchanged; neither labels nor a digest establish final-effect authority.
  const approvalDigest = fingerprint(policyApprovalInput??otDecisions.map(row => ({id: row.id, status: row.status, requested: row.requestedOtMinutes, approved: row.approvedOtMinutes, decidedAt: row.decidedAt, appliedAt: row.appliedAt, method: row.otApprovalMethod})));
  // Replay actual capture receipts and the stored raw projection independently. The selected
  // pairing may be closed pairs or First-In/Last-Out; neither permits a mismatched stored envelope.
  const policyClockReview=selectedPolicy?replayAttendancePolicyRawClocks(policyExecutionContext,policyClockSource,trace,day):undefined;
  const attestedReplay=attestedSelection?attendancePolicyAttestedWorkInput(policyExecutionContext,policyApprovalInput,ctx.tenantId,attestedSelection.source):undefined;
  if(attestedSelection&&attestedReplay?.state!=='known')unavailable();
  if(attestedSelection&&attestedReplay?.state==='known'){
    work=attestedPolicyCountSegments(attestedReplay,attestedSelection.source);
    const c=attestedSelection.context;
    facts.shiftId=known(c.schedule.shiftId,attendanceProvenance('attestedShift'));
    facts.scheduleGroupId=known(c.schedule.ruleId,attendanceProvenance('attestedScheduleGroup'));
    facts.requiredWorkingMinutes=minute(c.schedule.normalMinutes,attendanceProvenance('attestedRequiredMinutes'));
  }
  const policyClockMeasurements=attestedReplay?.state==='known'?attestedReplay.measurements:selectedPolicy?attendancePolicyClockMeasurements(policyExecutionContext,policyClockReview?.state==='known'?policyClockReview.evidence:undefined):undefined;
  const policyWorkInput=attestedReplay?.state==='known'?attestedReplay.work:selectedPolicy?attendancePolicyWorkInput(policyExecutionContext,policyClockReview?.state==='known'?policyClockReview.evidence:undefined):undefined;
  if(selectedPolicy){
    // New policy formula facts consume the exact captured/pair/break source. The old row's outer
    // envelope is not evidence that the new pairing or incomplete-clock policy actually ran.
    facts.actualWorkingMinutes=minute(attendancePolicyNetWorkedMinutes(policyWorkInput),
      attendanceProvenance('policyWorkedMinutes:'+selectedPolicy.id));
    const measured=policyClockMeasurements?.state==='measured'?policyClockMeasurements.lateIn:undefined;
    facts.lateMinutes=measured?.state==='known'?minute(measured.minutes,attendanceProvenance('policyLateMinutes:'+selectedPolicy.id))
      :unknown(measured?.state==='suppressed'?'policyLatenessSuppressed':measured?.state==='notApplicable'?'fixedClockNotApplicable':'policyClockBoundaryUnavailable');
  }
  const formulaSource=selectedPolicy?{sourceDate:p.date,policy:selectedPolicy,
    calendar:policyExecutionContext?.state==='policy'?policyExecutionContext.calendar:[],currency:{code:entity.currency,minorScale:currencyMinorScale(entity.currency)}}:undefined;
  const policyFormulaInput=formulaSource&&purpose==='money'?await attendancePolicyFormulaInputTx(tx,ctx,formulaSource):undefined;
  // Duration identity/state is independent of earning mappings even in a cash snapshot.
  // The bounded shared version reader omits salary and earning-component reads for this branch.
  const policyDurationFormulaInput=formulaSource?await attendancePolicyDurationFormulaInputTx(tx,ctx,formulaSource):undefined;
  const policyRawTrace=trace?{...trace}:null;
  if(policyRawTrace)delete policyRawTrace.overtimePattern;
  const policyRawEffectSource=selectedPolicy?{clocks:policyClockSource,current:{attendanceId:day.id,checkInAt:day.checkInAt,
    checkOutAt:day.checkOutAt,workedMinutes:day.workedMinutes,lateMinutes:day.lateMinutes,earlyOutMinutes:day.earlyOutMinutes,
    underMinutes:day.underMinutes,dayType:day.dayType,trace:policyRawTrace},
    ...(attestedSelection?{attested:attestedSelection.source}:{})}:undefined;
  const policyExecutionProposal=selectedPolicy
    ?attendancePolicyDurationExecutionProposal(policyExecutionContext,policyWorkInput,policyDurationFormulaInput,policyApprovalInput,ctx.tenantId,policyRawEffectSource):undefined;
  // An explicit new comparison mode is retained only when actual dated formula identities
  // differ. Old absent metadata keeps same-version pricing and its original refused history.
  const policyMoneyParts=policyExecutionProposal?.state==='proposed'&&policyExecutionProposal.duration.status==='calculated'
    ?policyExecutionProposal.duration.parts:[];
  const policyMoneyVersions=policyExecutionProposal?.state==='proposed'?policyExecutionProposal.formulaParts
    .filter((_part,index)=>(policyMoneyParts[index]?.allocatedPayableMinutes??0)>0).map(part=>part.versionId):[];
  const policyMoneyScope=purpose==='money'&&new Set(policyMoneyVersions).size>1?'identicalDefinitions' as const:undefined;
  // A dated child uses its own compensation selection, never the parent shift's salary by guess.
  // This bounded money-only read does not enter the import path or TOIL duration source.
  let policyPricingFacts:CanonicalOvertimeSnapshot['policyPricingFacts'];
  if(selectedPolicy&&purpose==='money'&&policyExecutionContext?.state==='policy'){
    policyPricingFacts={};
    const dates=[...new Set(policyExecutionContext.calendar.filter(row=>row.state==='known'&&row.companyId===entity.id).map(row=>row.date))].sort();
    if(dates.length>3)unavailable();
    const companies=await provenCompanyDatesTx(tx,dates.map(date=>({employmentId:p.employmentId,date})));
    for(const date of dates){
      if(companies.get(p.employmentId+'|'+date)?.companyId!==entity.id)continue;
      const rows=date===p.date?salaries:await tx.select().from(compensation).where(and(eq(compensation.tenantId,ctx.tenantId),
        eq(compensation.employmentId,p.employmentId),compensationEffectiveOn(date))).orderBy(asc(compensation.validFrom),asc(compensation.id)).limit(2);
      policyPricingFacts[date]=recordedSalaryFacts(rows.length===1?rows[0]:null,entity.currency,date);
    }
  }
  const inputDigest = fingerprint({day: {id: day.id, date: day.attendanceDate, checkIn: day.checkInAt, checkOut: day.checkOutAt, status: day.status, dayType: day.dayType, workedMinutes: day.workedMinutes, lateMinutes: day.lateMinutes, calculation: trace ? {v: trace.v, schedule: trace.schedule, punch: trace.punch, lateness: trace.lateness, legacyManualRows} : null}, assignment: assigned, salary, context, punches,
    ...(selectedPolicy?{policyExecutionContext,policyClockSource,policyClockReview,policyRawEffectSource,policyClockMeasurements,policyWorkInput,policyExecutionProposal,...(policyMoneyScope?{policyMoneyScope}:{}),...(policyPricingFacts?{policyPricingFacts}:{})}:{})});
  const source = {tenantId: ctx.tenantId, employmentId: p.employmentId, attendanceId: day.id, date: p.date, inputDigest, approvalDigest};
  return {
    ...(selectedPolicy?{attendanceGroupPolicy:selectedPolicy,policyExecutionContext,policyClockSource,policyClockReview,policyRawEffectSource,policyClockMeasurements,policyWorkInput,policyApprovalInput,policyFormulaInput,policyExecutionProposal,
      ...(policyDurationFormulaInput?{policyDurationFormulaInput}:{}),...(policyMoneyScope?{policyMoneyScope}:{}),...(policyPricingFacts?{policyPricingFacts}:{})}:{}),
    input: {source, currency: {code: entity.currency, minorScale: currencyMinorScale(entity.currency)}, facts,
      layer: 'raw', sessionGranularity: work.placement === 'recordedIntervals' ? 'recorded' : 'dayAggregate', approval: {status: approvalStatus, minutes: approvalMinutes, provenance: approvalProvenance},
      // This is a measurement ceiling per segment, not an invented approved physical interval. The
      // independently evidenced day approval cap above is applied once after eligibility by the engine.
      segments: work.segments.map(segment => ({...segment, approvedMinutes: segment.rawMinutes})),
      resources: [
        {id: day.id + ':lateIn', resource: 'lateIn', evidence: 'measured', basis: 'day', sessionId: null, sourceKeys: [day.id + ':lateMinutes'], measure: {unit: 'minutes', quantity: minute(day.lateMinutes, attendanceProvenance('lateMinutes'))}},
        // Capacity for an explicitly configured additional policy deduction; this is not an actual
        // scheduled break, which has already been removed from the canonical worked duration.
        {id: day.id + ':postOtBreak', resource: 'postOtBreak', evidence: 'policyCapacity', basis: 'day', sessionId: null, sourceKeys: [day.id + ':configuredPostOtBreak'], measure: {unit: 'minutes', quantity: work.rawMinutes}},
      ],
    },
    resolvedLegacyRuleId: trace ? trace.schedule.ruleId : null,
    referenceDigest: fingerprint({assignmentId: assigned.id, salaryId: salary?.id ?? null, contextReference: context?.ownerReference ?? null, entity, readerContract: 1,
      ...(selectedPolicy?{attendanceGroupPolicy:selectedPolicy,policyFormulaInput,
        ...(policyDurationFormulaInput?{policyDurationFormulaInput}:{}),...(policyMoneyScope?{policyMoneyScope}:{}),...(policyPricingFacts?{policyPricingFacts}:{})}:{} )}),
  };
}
