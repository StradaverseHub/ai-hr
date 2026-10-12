/** Attendance allowance policy definitions, pure preview and atomic source-owned payroll transfer.
 * ADR-0106 extends ADR-0072 without reinterpreting any NULL-rules legacy monthly policy.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
import { withAttendanceTenant as withTenant } from './module-gate';
import { createHash } from 'node:crypto';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  attendanceAllowancePolicy,
  company,
  attendanceAllowanceVersion, attendanceAllowanceResult, attendanceAllowanceResultRevision, attendanceAllowanceTransfer, shift, businessUnit, position, jobGrade,
  department,
  employment,person,
  payComponent,
  payrollBatch,
  type AttendanceAllowanceCriteria,
  type AttendanceAllowanceScope,
} from '../db/schema';
import { attendanceMonthSummary, type MonthSummaryRow } from './attendance';
import { BatchNotDraftError, AllowancePayrollConflictError, UnsupportedBatchComponentError, isUnsupportedTaxableComponent, resolveBatchScopeFilter, projectAttendanceAllowanceTx, type BatchScope } from '../packs/payroll/service';
import { allowanceInputsTx } from './attendance-allowance-context';
import { allowanceCents, allowanceMoney, allowanceEmployeeMatches, evaluateAllowancePeriods, validateAllowanceRules, allowancePeriods, type AllowanceRules, type AllowancePeriodMethod, type AllowancePolicyType, type AllowancePeriodEvaluation } from '../lib/attendance-allowance-rules';
import { todayInKualaLumpur } from '../lib/hr-date';
import { employedByCompanyDuring } from './employment-company';
export * from '../lib/attendance-allowance-rules';
import { isModuleEnabled } from './entitlements';

// The fixed amount applies once per qualifying period; the leaf engine defines ownership.
export const ALLOWANCE_METHODS = ['monthly','weekly','daily'] as const;
export type AllowanceMethod = (typeof ALLOWANCE_METHODS)[number];
export const ALLOWANCE_STATUSES = ['active', 'inactive'] as const;
export type AllowanceStatus = (typeof ALLOWANCE_STATUSES)[number];

/** Thrown when a code collides with a live policy in the same company (the partial-unique index). */
export class DuplicateAllowancePolicyCodeError extends Error {
  constructor(message = 'An attendance-allowance policy with this code already exists for this company') {
    super(message);
    this.name = 'DuplicateAllowancePolicyCodeError';
  }
}

function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

function cleanText(v: string | undefined | null, field: string): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error(`${field} is required`);
  return s;
}

function normalizeMethod(v: string | undefined): AllowanceMethod {
  const m = (v ?? 'monthly').trim();
  if (!ALLOWANCE_METHODS.includes(m as AllowanceMethod)) throw new Error(`Unknown allowance method: ${m}`);
  return m as AllowanceMethod;
}

function normalizeStatus(v: string | undefined): AllowanceStatus {
  const s = (v ?? 'active').trim();
  if (!ALLOWANCE_STATUSES.includes(s as AllowanceStatus)) throw new Error(`Unknown status: ${s}`);
  return s as AllowanceStatus;
}

function cleanAmount(v: number | string | undefined): string {
  if(v===undefined)throw new Error('Amount is required');
  return allowanceMoney(allowanceCents(v));
}
function cleanDate(v:string):string {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)!==v)throw new Error('Invalid effective date');
  return v;
}
async function assertPolicyAdminTx(tx:Tx,companyId:string){
  const [row]=await tx.select({allowed:sql<boolean>`app.is_admin_for(${company.id})`}).from(company).where(eq(company.id,companyId)).limit(1);
  if(!row?.allowed)throw new Error('Only an authorised company administrator may manage attendance allowances');
}
type PolicyRow=typeof attendanceAllowancePolicy.$inferSelect;
async function validateDefinitionTx(tx:Tx,p:{companyId:string;payComponentId:string;policyType:string;rules:AllowanceRules|null}){
  await assertPolicyAdminTx(tx,p.companyId);
  const [component]=await tx.select().from(payComponent).where(eq(payComponent.id,p.payComponentId));
  if(!component)throw new Error('Pay code not found');
  if(isUnsupportedTaxableComponent(component))throw new UnsupportedBatchComponentError(component.code);
  if(component.archivedAt||component.isNonPayable||(component.rule&&component.rule.kind!=='fixed')||(p.policyType==='deduction'?component.kind!=='deduction':component.kind!=='allowance'))throw new Error('Choose an active fixed Payroll code compatible with Earning or Deduction');
  if(!p.rules)return;
  const selected=p.rules.attendance.shiftIds;
  if(selected.length){const rows=await tx.select({id:shift.id}).from(shift).where(and(inArray(shift.id,selected),isNull(shift.archivedAt),sql`(${shift.companyId} is null or ${shift.companyId}=${p.companyId})`));if(rows.length!==selected.length)throw new Error('Selected shifts must be active and available to the policy company');}
  const empIds=p.rules.employee.employmentIds;
  if(empIds.length){const rows=await tx.select({id:employment.id,allowed:sql<boolean>`app.can_admin_employment(${employment.id})`}).from(employment).where(and(inArray(employment.id,empIds),eq(employment.companyId,p.companyId)));if(rows.length!==empIds.length||rows.some(r=>!r.allowed))throw new Error('Select employees within the policy company and your administrative scope');}
  for(const c of p.rules.employee.criteria){
    if(c.field==='companyId'&&c.values.some(id=>id!==p.companyId))throw new Error('A policy belongs to one company; employee company criteria must match that company');
    if(c.field==='departmentId'){const rows=await tx.select({id:department.id}).from(department).where(and(inArray(department.id,c.values),isNull(department.archivedAt),sql`(${department.companyId}=${p.companyId} or ${department.isGlobal})`));if(rows.length!==c.values.length)throw new Error('Departments must belong to the policy company');}
    if(c.field==='businessUnitId'){const rows=await tx.select({id:businessUnit.id}).from(businessUnit).where(and(inArray(businessUnit.id,c.values),isNull(businessUnit.archivedAt),sql`(${businessUnit.companyId}=${p.companyId} or ${businessUnit.isGlobal})`));if(rows.length!==c.values.length)throw new Error('Business units must be available to the policy company');}
    if(c.field==='positionId'){const rows=await tx.select({id:position.id}).from(position).where(and(inArray(position.id,c.values),isNull(position.archivedAt),sql`(${position.companyId}=${p.companyId} or ${position.isGlobal})`));if(rows.length!==c.values.length)throw new Error('Positions must be available to the policy company');}
    if(c.field==='gradeId'){const rows=await tx.select({id:jobGrade.id}).from(jobGrade).where(and(inArray(jobGrade.id,c.values),isNull(jobGrade.archivedAt)));if(rows.length!==c.values.length)throw new Error('Choose active job grades');}
    if(c.field==='employmentCategory'){const cats=await tx.selectDistinct({value:employment.employmentCategory}).from(employment).where(eq(employment.companyId,p.companyId));if(c.values.some(v=>!cats.some(r=>r.value===v)))throw new Error('Choose an employee category recorded in the policy company');}
  }
}
async function saveVersionTx(tx:Tx,row:PolicyRow){
  await tx.insert(attendanceAllowanceVersion).values({tenantId:row.tenantId,companyId:row.companyId,policyId:row.id,version:row.version,snapshot:JSON.parse(JSON.stringify(row))});
}

/** Coerce a criteria bag: drop unknown keys, clamp numeric thresholds to non-negative integers, keep the
 *  boolean flag. A criterion not computable from MonthSummaryRow is not accepted (not in the type). */
export function cleanCriteria(raw: AttendanceAllowanceCriteria | undefined | null): AttendanceAllowanceCriteria {
  const c = raw ?? {};
  const out: AttendanceAllowanceCriteria = {};
  const num = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const a = num(c.minAttendanceDays);
  if (a !== undefined) out.minAttendanceDays = a;
  const b = num(c.maxAbsentDays);
  if (b !== undefined) out.maxAbsentDays = b;
  const d = num(c.maxLateCount);
  if (d !== undefined) out.maxLateCount = d;
  const e = num(c.maxTotalLeaveDays);
  if (e !== undefined) out.maxTotalLeaveDays = e;
  if (c.requirePerfectAttendance === true) out.requirePerfectAttendance = true;
  return out;
}

/** Coerce a scope bag: keep only string-id arrays under the three known axes; drop empties. */
export function cleanScope(raw: AttendanceAllowanceScope | undefined | null): AttendanceAllowanceScope {
  const s = raw ?? {};
  const arr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const ids = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
    return ids.length ? ids : undefined;
  };
  const out: AttendanceAllowanceScope = {};
  const dep = arr(s.departmentIds);
  if (dep) out.departmentIds = dep;
  const bu = arr(s.businessUnitIds);
  if (bu) out.businessUnitIds = bu;
  const co = arr(s.companyIds);
  if (co) out.companyIds = co;
  return out;
}

// ─────────────────────── Pure predicate (unit-testable) ───────────────────────

export type CriterionKey =
  | 'minAttendanceDays'
  | 'maxAbsentDays'
  | 'maxLateCount'
  | 'maxTotalLeaveDays'
  | 'requirePerfectAttendance';

export type CriterionResult = {
  key: CriterionKey;
  threshold: number; // for requirePerfectAttendance this is 0 (the required max)
  actual: number;
  pass: boolean;
};

export type MonthlyEvaluation = {
  qualified: boolean;
  perCriterion: CriterionResult[];
  /** Static i18n keys (attendanceAllowance.reason.<criterionKey>) for the failing criteria — never a
   *  dynamic/interpolated criterion NAME, so the 6 locales cannot silently fall back to English. */
  reasons: string[];
};

/**
 * Evaluate one employee's month roll-up against a criteria bag. PURE — no DB, no events. When a criterion
 * is not present in the bag it is simply not evaluated. attendanceDays = present + late + halfDay.
 */
export function evaluateMonthly(
  row: Pick<MonthSummaryRow, 'present' | 'late' | 'halfDay' | 'absent' | 'leaveDays'>,
  criteria: AttendanceAllowanceCriteria,
): MonthlyEvaluation {
  const attendanceDays = row.present + row.late + row.halfDay;
  const per: CriterionResult[] = [];

  if (criteria.minAttendanceDays !== undefined) {
    per.push({
      key: 'minAttendanceDays',
      threshold: criteria.minAttendanceDays,
      actual: attendanceDays,
      pass: attendanceDays >= criteria.minAttendanceDays,
    });
  }
  if (criteria.maxAbsentDays !== undefined) {
    per.push({
      key: 'maxAbsentDays',
      threshold: criteria.maxAbsentDays,
      actual: row.absent,
      pass: row.absent <= criteria.maxAbsentDays,
    });
  }
  if (criteria.maxLateCount !== undefined) {
    per.push({
      key: 'maxLateCount',
      threshold: criteria.maxLateCount,
      actual: row.late,
      pass: row.late <= criteria.maxLateCount,
    });
  }
  if (criteria.maxTotalLeaveDays !== undefined) {
    per.push({
      key: 'maxTotalLeaveDays',
      threshold: criteria.maxTotalLeaveDays,
      actual: row.leaveDays,
      pass: row.leaveDays <= criteria.maxTotalLeaveDays,
    });
  }
  if (criteria.requirePerfectAttendance) {
    // absent == 0 && late == 0. `actual` surfaces the offending count (absent + late) for the UI.
    per.push({
      key: 'requirePerfectAttendance',
      threshold: 0,
      actual: row.absent + row.late,
      pass: row.absent === 0 && row.late === 0,
    });
  }

  const reasons = per.filter((p) => !p.pass).map((p) => `attendanceAllowance.reason.${p.key}`);
  return { qualified: per.every((p) => p.pass), perCriterion: per, reasons };
}

// ─────────────────────────────── CRUD ───────────────────────────────

export type AllowancePolicyInput = {
  companyId: string;
  code: string;
  name: string;
  policyType?: AllowancePolicyType;
  rules?: AllowanceRules | null;
  method?: string; // v1: 'monthly'
  amount: number | string;
  payComponentId: string;
  effectiveFrom: string; // ISO date
  criteria?: AttendanceAllowanceCriteria | null;
  scope?: AttendanceAllowanceScope | null;
};

export async function createAllowancePolicy(
  ctx: SessionContext,
  p: AllowancePolicyInput,
): Promise<{ id: string }> {
  const companyId = cleanText(p.companyId, 'Company');
  const code = cleanText(p.code, 'Code');
  const name = cleanText(p.name, 'Name');
  const method = normalizeMethod(p.method);
  const amount = cleanAmount(p.amount);
  const payComponentId = cleanText(p.payComponentId, 'Pay component');
  const effectiveFrom = cleanDate(cleanText(p.effectiveFrom, 'Effective date'));
  const policyType = p.policyType ?? 'earning';
  if(!['earning','deduction'].includes(policyType))throw new Error('Unknown policy type');
  const rules = p.rules ? validateAllowanceRules(p.rules) : null;
  if(method!=='monthly'&&!rules)throw new Error('Daily and weekly policies require the new attendance conditions');
  const criteria = cleanCriteria(p.criteria);
  const scope = cleanScope(p.scope);
  return withTenant(ctx, async (tx) => {
    await validateDefinitionTx(tx,{companyId,payComponentId,policyType,rules});
    let id: string;
    try {
      const [row] = await tx
        .insert(attendanceAllowancePolicy)
        .values({
          tenantId: ctx.tenantId,
          companyId,
          policyType,rules,
          code,
          name,
          method,
          amount,
          payComponentId,
          effectiveFrom,
          status: 'active',
          criteria,
          scope,
        })
        .returning({ id: attendanceAllowancePolicy.id });
      id = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateAllowancePolicyCodeError();
      throw e;
    }
    const [definition]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,id));
    await saveVersionTx(tx,definition);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-allowance-policy',
      aggregateId: id,
      eventType: 'attendance-allowance-policy.created',
      actor: actorOf(ctx),
      payload: { companyId, code, name, method, payComponentId, effectiveFrom, version:definition.version },
    });
    return { id };
  });
}

export async function updateAllowancePolicy(
  ctx: SessionContext,
  p: {
    id: string;
    code?: string;
    name?: string;
    method?: string;
    policyType?: AllowancePolicyType;
    rules?: AllowanceRules | null;
    amount?: number | string;
    payComponentId?: string;
    effectiveFrom?: string;
    criteria?: AttendanceAllowanceCriteria | null;
    scope?: AttendanceAllowanceScope | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select()
      .from(attendanceAllowancePolicy)
      .where(eq(attendanceAllowancePolicy.id, p.id))
      .for('update');
    if (!before) throw new Error('Attendance-allowance policy not found');
    if(before.archivedAt)throw new Error('An archived policy cannot be edited');
    const method=p.method===undefined?before.method:normalizeMethod(p.method);
    const policyType=p.policyType??before.policyType;
    if(!['earning','deduction'].includes(policyType))throw new Error('Unknown policy type');
    const rules=p.rules===undefined?before.rules:p.rules?validateAllowanceRules(p.rules):null;
    if(method!=='monthly'&&!rules)throw new Error('Daily and weekly policies require new conditions');
    const code = p.code !== undefined ? cleanText(p.code, 'Code') : before.code;
    const name = p.name !== undefined ? cleanText(p.name, 'Name') : before.name;
    const amount = p.amount !== undefined ? cleanAmount(p.amount) : before.amount;
    const payComponentId =
      p.payComponentId !== undefined ? cleanText(p.payComponentId, 'Pay component') : before.payComponentId;
    const effectiveFrom =
      p.effectiveFrom !== undefined ? cleanDate(cleanText(p.effectiveFrom, 'Effective date')) : before.effectiveFrom;
    const criteria = p.criteria !== undefined ? cleanCriteria(p.criteria) : before.criteria;
    const scope = p.scope !== undefined ? cleanScope(p.scope) : before.scope;
    await validateDefinitionTx(tx,{companyId:before.companyId,payComponentId,policyType,rules});
    try {
      await tx
        .update(attendanceAllowancePolicy)
        .set({ code, name, amount, payComponentId, effectiveFrom, criteria, scope,method,policyType,rules,version:before.version+1 })
        .where(eq(attendanceAllowancePolicy.id, p.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateAllowancePolicyCodeError();
      throw e;
    }
    const [definition]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,p.id));
    await saveVersionTx(tx,definition);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-allowance-policy',
      aggregateId: p.id,
      eventType: 'attendance-allowance-policy.updated',
      actor: actorOf(ctx),
      payload: { beforeVersion:before.version,afterVersion:definition.version },
    });
    return { id: p.id };
  });
}

export async function setAllowancePolicyStatus(
  ctx: SessionContext,
  p: { id: string; status: string },
): Promise<{ id: string }> {
  const status = normalizeStatus(p.status);
  return withTenant(ctx, async (tx) => {
    const [before]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,p.id)).for('update');
    if(!before||before.archivedAt)throw new Error('Attendance-allowance policy not found');
    await assertPolicyAdminTx(tx,before.companyId);
    if(status==='active')await validateDefinitionTx(tx,{companyId:before.companyId,payComponentId:before.payComponentId,policyType:before.policyType,rules:before.rules});
    await tx
      .update(attendanceAllowancePolicy)
      .set({ status })
      .where(eq(attendanceAllowancePolicy.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-allowance-policy',
      aggregateId: p.id,
      eventType: 'attendance-allowance-policy.status-changed',
      actor: actorOf(ctx),
      payload: { status },
    });
    return { id: p.id };
  });
}

export async function archiveAllowancePolicy(ctx: SessionContext, p: { id: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [before]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,p.id)).for('update');
    if(!before||before.archivedAt)throw new Error('Attendance-allowance policy not found');
    await assertPolicyAdminTx(tx,before.companyId);
    await tx
      .update(attendanceAllowancePolicy)
      .set({ archivedAt: sql`now()`, status: 'inactive' })
      .where(eq(attendanceAllowancePolicy.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-allowance-policy',
      aggregateId: p.id,
      eventType: 'attendance-allowance-policy.archived',
      actor: actorOf(ctx),
      payload: {},
    });
    return { id: p.id };
  });
}

export function getAllowancePolicy(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(attendanceAllowancePolicy)
      .where(eq(attendanceAllowancePolicy.id, id))
      .limit(1);
    return row ?? null;
  });
}

// ────────────────── Scope-filter join (employment → dept → BU) ──────────────────
// MonthSummaryRow returns only employmentId/name — NOT department/BU/company. So we join
// employment → current OPEN assignment (validTo IS NULL, supersededAt IS NULL) → department to resolve
// each employee's departmentId + businessUnitId, and read companyId off the employment. Filtered in app
// code because the summary is a shared, hot function we do not modify.
type ScopeInfo = { companyId: string; departmentId: string | null; businessUnitId: string | null };

async function scopeInfoFor(tx: Tx, employmentIds: string[]): Promise<Map<string, ScopeInfo>> {
  const out = new Map<string, ScopeInfo>();
  if (employmentIds.length === 0) return out;
  const rows = await tx
    .select({
      employmentId: employment.id,
      companyId: employment.companyId,
      departmentId: assignment.departmentId,
      businessUnitId: department.businessUnitId,
    })
    .from(employment)
    .leftJoin(
      assignment,
      and(
        eq(assignment.employmentId, employment.id),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .leftJoin(department, eq(department.id, assignment.departmentId))
    .where(inArray(employment.id, employmentIds));
  for (const r of rows) {
    out.set(r.employmentId, {
      companyId: r.companyId,
      departmentId: r.departmentId ?? null,
      businessUnitId: r.businessUnitId ?? null,
    });
  }
  return out;
}

/** True iff the employee's org placement matches the policy scope. Empty scope ⇒ all-in-scope. Each
 *  populated axis must match (AND across axes; OR within an axis). */
export function inScope(scope: AttendanceAllowanceScope, info: ScopeInfo | undefined): boolean {
  if (!info) return false;
  if (scope.companyIds?.length && !scope.companyIds.includes(info.companyId)) return false;
  if (scope.departmentIds?.length && !(info.departmentId && scope.departmentIds.includes(info.departmentId)))
    return false;
  if (
    scope.businessUnitIds?.length &&
    !(info.businessUnitId && scope.businessUnitIds.includes(info.businessUnitId))
  )
    return false;
  return true;
}

// ─────────────────────── Evaluation (pure read, no events) ───────────────────────

export type AllowanceEvaluationRow = {
  employmentId: string;
  name: string;
  qualified: boolean;
  amount: string;
  reasons: string[];
  perCriterion: CriterionResult[];
  inScope: boolean;
  periods: AllowancePeriodEvaluation[];
};

/**
 * Evaluate a policy for a month across the policy's company. Loads the policy, runs the shared monthly
 * summary, resolves each employee's org placement (scope join), post-filters against policy.scope, and
 * runs evaluateMonthly per in-scope row. PURE READ — no writes, no events. Out-of-scope employees are
 * excluded from the returned list (they are not candidates for this policy).
 */
export async function evaluateAllowancesForPeriod(
  ctx: SessionContext,p: { policyId: string; month: string; today?: string; batchId?:string },
): Promise<{policyId:string;policyVersion:number;month:string;inputDigest:string;rows:AllowanceEvaluationRow[]}> {
  return withTenant(ctx,tx=>evaluateAllowancesTx(tx,ctx,p));
}
export class StaleAllowancePreviewError extends Error { constructor(){super('Attendance or the policy changed. Preview the calculation again before transferring.');this.name='StaleAllowancePreviewError';} }
async function evaluateAllowancesTx(tx:Tx,ctx:SessionContext,p:{policyId:string;month:string;today?:string;batchId?:string}) {
  const [policy]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,p.policyId));
  if(!policy)throw new Error('Attendance-allowance policy not found');
  await assertPolicyAdminTx(tx,policy.companyId);
  const periods=allowancePeriods(policy.method as AllowancePeriodMethod,p.month);
  const rows:AllowanceEvaluationRow[]=[];
  if(!policy.rules){
    // Null rules is the compatibility switch. Never re-interpret legacy monthly qualification.
    const summary=await attendanceMonthSummary(ctx,{month:p.month,companyIds:[policy.companyId],today:p.today});
    const info=await scopeInfoFor(tx,summary.map(s=>s.employmentId));
    for(const row of summary){
      if(!inScope(policy.scope??{},info.get(row.employmentId)))continue;
      const ev=evaluateMonthly(row,policy.criteria??{});
      rows.push({employmentId:row.employmentId,name:row.name,qualified:ev.qualified,amount:ev.qualified?policy.amount:'0.00',reasons:ev.reasons,perCriterion:ev.perCriterion,inScope:true,
        periods:[{...periods[0],qualified:ev.qualified,amount:ev.qualified?policy.amount:'0.00',eligibleDates:[],attendanceIds:[],metrics:{workingMinutes:row.workedMinutes,actualMinutes:null,overtimeMinutes:row.otWorkday+row.otRestDay+row.otHoliday,lateMinutes:null,earlyOutMinutes:null,absentDays:row.absent,attendanceDays:row.present+row.late+row.halfDay,eligibleWorkingDays:null},criteria:[],reasons:ev.reasons,sourceDays:[]}],
      });
    }
  }else{
    const rules=validateAllowanceRules(policy.rules);
    const from=periods[0]?.from,to=periods[periods.length-1]?.to;
    const today=p.today??todayInKualaLumpur();
    const inputs=from&&to?await allowanceInputsTx(tx,policy.companyId,from,to,today):[];
    for(const input of inputs){
      // Employee selection is resolved on each period's final owned employment date, independently
      // of the attendance predicate; no today's department is silently substituted for history.
      const evaluated=evaluateAllowancePeriods({method:policy.method as AllowancePeriodMethod,month:p.month,amount:policy.amount,effectiveFrom:policy.effectiveFrom,today,rules,days:input.days});
      let candidate=false;
      for(const period of evaluated){
        const employeeDates=input.days.filter(d=>d.date>=period.from&&d.date<=period.to).map(d=>d.date).sort();
        const date=employeeDates[employeeDates.length-1];
        const facts=date?input.factsByDate.get(date):undefined;
        const pass=!!facts&&allowanceEmployeeMatches(rules.employee,input.employmentId,facts);
        period.employeeSelection={asOf:date??null,facts:facts??null,pass,factSources:{companyId:'dated-company-segments',departmentId:'dated-assignment',businessUnitId:'dated-assignment-with-department-fallback',positionId:'dated-assignment',employmentType:'dated-assignment',gradeId:'current-personnel-profile-no-historical-version',employmentCategory:'current-personnel-profile-no-historical-version',status:'employment-tenure'}};
        if(!pass){
          period.qualified=false;period.amount='0.00';period.reasons.push('employeeCriteriaFailed');
        }else candidate=true;
      }
      if(!candidate)continue;
      const amount=allowanceMoney(evaluated.reduce((n,r)=>n+allowanceCents(r.amount),0n));
      rows.push({employmentId:input.employmentId,name:input.name,qualified:evaluated.some(r=>r.qualified),amount,reasons:[...new Set(evaluated.flatMap(r=>r.reasons))],perCriterion:[],inScope:true,periods:evaluated});
    }
  }
  let batchScope:BatchScope|null=null;
  if(p.batchId){
    const [batch]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId));
    if(!batch||batch.companyId!==policy.companyId||batch.payPeriod!==p.month)throw new Error('The payroll run does not match this policy and payment month');
    batchScope=batch.scope as BatchScope|null;
    const scoped=await resolveBatchScopeFilter(tx,batchScope);
    if(scoped.employmentIds){const allowed=new Set(scoped.employmentIds);for(let i=rows.length-1;i>=0;i--)if(!allowed.has(rows[i].employmentId))rows.splice(i,1);}
  }
  const inputDigest=createHash('sha256').update(JSON.stringify({policy,month:p.month,batchId:p.batchId??null,batchScope,rows})).digest('hex');
  return {policyId:policy.id,policyVersion:policy.version,month:p.month,inputDigest,rows};
}

// ─────────────────────── Source-owned payroll transfer ───────────────────────

export type TransferResult = {
  applied: number;
  ineligible: number;
  reversed: number;
  gated: boolean;
};

/** Recalculate inside employment/run locks and replace only this policy's current sources.
 * Results, immutable revisions, aggregate payroll inputs and success receipts commit atomically.
 * A processed run requires explicit reprocess and is marked stale; a closed run always refuses.
 * The optional digest binds interactive transfers to the preview the administrator reviewed.
 */
export async function transferAllowancesToBatch(
  ctx: SessionContext,p: { batchId: string; policyId: string; expectedDigest?:string; reprocess?:boolean },
): Promise<TransferResult> {
  if(!isModuleEnabled(ctx,'typed_pay_components'))return {applied:0,ineligible:0,reversed:0,gated:true};
  try{
    return await withTenant(ctx,async tx=>{
      const [candidateBatch]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId));
      const [candidatePolicy]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,p.policyId));
      if(!candidateBatch||!candidatePolicy)throw new Error('Payroll run or policy not found');
      await assertPolicyAdminTx(tx,candidatePolicy.companyId);
      if(candidatePolicy.companyId!==candidateBatch.companyId)throw new Error('Policy and payroll run must belong to the same company');
      const periods=allowancePeriods(candidatePolicy.method as AllowancePeriodMethod,candidateBatch.payPeriod);
      const from=periods[0]?.from??`${candidateBatch.payPeriod}-01`,to=periods[periods.length-1]?.to??from;
      // Correction, clock and import writers lock subjects BEFORE payroll runs. Preserve that order.
      const subjects=await tx.select({id:employment.id}).from(employment).where(employedByCompanyDuring(candidatePolicy.companyId,from,to)).orderBy(asc(employment.id));
      for(const subject of subjects)await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+subject.id},0))`);
      const [batch]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId)).for('update');
      const [policy]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,p.policyId)).for('update');
      if(!batch||!policy||policy.version!==candidatePolicy.version)throw new StaleAllowancePreviewError();
      if(batch.status==='closed'||(batch.status!=='draft'&&!(batch.status==='processed'&&p.reprocess)))throw new BatchNotDraftError();
      if(policy.companyId!==batch.companyId)throw new Error('Policy and payroll run must belong to the same company');
      if(policy.status!=='active'||policy.archivedAt)throw new Error('Activate this policy before transferring');
      await validateDefinitionTx(tx,{companyId:policy.companyId,payComponentId:policy.payComponentId,policyType:policy.policyType,rules:policy.rules});
      const evaluation=await evaluateAllowancesTx(tx,ctx,{policyId:policy.id,month:batch.payPeriod,batchId:batch.id});
      if(p.expectedDigest&&p.expectedDigest!==evaluation.inputDigest)throw new StaleAllowancePreviewError();
      const contributions:Parameters<typeof projectAttendanceAllowanceTx>[2]['contributions']=[];
      for(const row of evaluation.rows){
        for(const period of row.periods){
          const evidence=JSON.parse(JSON.stringify({policyVersion:policy.version,period,policySnapshot:{policyId:policy.id,version:policy.version,method:policy.method,policyType:policy.policyType,payComponentId:policy.payComponentId},legacy:!policy.rules}));
          const digest=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
          const [result]=await tx.insert(attendanceAllowanceResult).values({tenantId:ctx.tenantId,companyId:policy.companyId,policyId:policy.id,policyVersion:policy.version,employmentId:row.employmentId,payMonth:batch.payPeriod,periodKey:period.key,periodFrom:period.from,periodTo:period.to,amount:period.amount,qualified:period.qualified,evidence,inputDigest:digest})
            .onConflictDoUpdate({target:[attendanceAllowanceResult.tenantId,attendanceAllowanceResult.policyId,attendanceAllowanceResult.policyVersion,attendanceAllowanceResult.employmentId,attendanceAllowanceResult.periodKey],set:{amount:period.amount,qualified:period.qualified,evidence,inputDigest:digest,status:'calculated',calculatedAt:new Date()}}).returning({id:attendanceAllowanceResult.id});
          await tx.insert(attendanceAllowanceResultRevision).values({tenantId:ctx.tenantId,companyId:policy.companyId,resultId:result.id,employmentId:row.employmentId,inputDigest:digest,amount:period.amount,evidence}).onConflictDoNothing();
          if(period.qualified)contributions.push({resultId:result.id,employmentId:row.employmentId,componentId:policy.payComponentId,periodKey:period.key,amount:period.amount});
        }
      }
      const projected=await projectAttendanceAllowanceTx(tx,ctx,{batchId:batch.id,policyId:policy.id,companyId:policy.companyId,payMonth:batch.payPeriod,contributions,reprocess:p.reprocess});
      await tx.insert(attendanceAllowanceTransfer).values({tenantId:ctx.tenantId,companyId:policy.companyId,policyId:policy.id,policyVersion:policy.version,batchId:batch.id,batchRef:batch.id,status:'transferred',inputDigest:evaluation.inputDigest});
      const result={...projected,ineligible:evaluation.rows.filter(r=>!r.qualified).length,gated:false};
      await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-allowance-policy',aggregateId:policy.id,eventType:'attendance-allowance-policy.transferred',actor:actorOf(ctx),payload:{batchId:batch.id,payPeriod:batch.payPeriod,policyVersion:policy.version,inputDigest:evaluation.inputDigest,...result}});
      return result;
    });
  }catch(error){
    // A failed atomic transfer rolls back all money and results. Persist a separately authorised,
    // reference-only failure receipt so an administrator can resolve it and retry safely.
    await withTenant(ctx,async tx=>{
      const [policy]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,p.policyId));
      const [batch]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId));
      if(!policy||!batch||policy.companyId!==batch.companyId)return;
      await assertPolicyAdminTx(tx,policy.companyId);
      const errorCode=error instanceof StaleAllowancePreviewError?'stalePreview':error instanceof BatchNotDraftError?'payrollLocked':error instanceof UnsupportedBatchComponentError?'unsupportedCode':error instanceof AllowancePayrollConflictError?'payrollConflict':'validationFailed';
      const [attempt]=await tx.insert(attendanceAllowanceTransfer).values({tenantId:ctx.tenantId,companyId:policy.companyId,policyId:policy.id,policyVersion:policy.version,batchId:batch.id,batchRef:batch.id,status:'failed',errorCode,inputDigest:p.expectedDigest??null}).returning({id:attendanceAllowanceTransfer.id});
      await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-allowance-policy',aggregateId:policy.id,eventType:'attendance-allowance-policy.transfer-failed',actor:actorOf(ctx),payload:{attemptId:attempt.id,batchId:batch.id,errorCode}});
    }).catch(()=>undefined); // Preserve the original refusal; never expose a hidden policy through logging.
    throw error;
  }
}
export function allowanceTransferHistory(ctx:SessionContext,policyId:string){
  return withTenant(ctx,async tx=>{
    const [policy]=await tx.select().from(attendanceAllowancePolicy).where(eq(attendanceAllowancePolicy.id,policyId));
    if(!policy)throw new Error('Attendance-allowance policy not found');
    await assertPolicyAdminTx(tx,policy.companyId);
    const [attempts,results,versions,revisions]=await Promise.all([
      tx.select().from(attendanceAllowanceTransfer).where(eq(attendanceAllowanceTransfer.policyId,policyId)).orderBy(sql`${attendanceAllowanceTransfer.createdAt} desc`,attendanceAllowanceTransfer.id).limit(100),
      tx.select().from(attendanceAllowanceResult).where(eq(attendanceAllowanceResult.policyId,policyId)).orderBy(sql`${attendanceAllowanceResult.calculatedAt} desc`,attendanceAllowanceResult.id).limit(500),
      tx.select().from(attendanceAllowanceVersion).where(eq(attendanceAllowanceVersion.policyId,policyId)).orderBy(sql`${attendanceAllowanceVersion.version} desc`),
      tx.select({id:attendanceAllowanceResultRevision.id,resultId:attendanceAllowanceResultRevision.resultId,createdAt:attendanceAllowanceResultRevision.createdAt,amount:attendanceAllowanceResultRevision.amount,evidence:attendanceAllowanceResultRevision.evidence}).from(attendanceAllowanceResultRevision).innerJoin(attendanceAllowanceResult,eq(attendanceAllowanceResult.id,attendanceAllowanceResultRevision.resultId)).where(eq(attendanceAllowanceResult.policyId,policyId)).orderBy(sql`${attendanceAllowanceResultRevision.createdAt} desc`,attendanceAllowanceResultRevision.id).limit(500),
    ]);
    return {attempts,results,versions,revisions};
  });
}

/** Company-scoped setup vocabulary. Only actual configured fields are offered; no invented branch/division. */
export function allowanceSetupOptions(ctx:SessionContext,companyIds:string[]){
  return withTenant(ctx,async tx=>{
    for(const id of companyIds)await assertPolicyAdminTx(tx,id);
    if(!companyIds.length)return {companies:[],departments:[],businessUnits:[],positions:[],grades:[],employees:[],categories:[],shifts:[]};
    const [companies,departments,businessUnits,positions,grades,employees,shifts]=await Promise.all([
      tx.select({id:company.id,label:company.legalName,currency:company.currency}).from(company).where(inArray(company.id,companyIds)).orderBy(company.legalName),
      tx.select({id:department.id,label:department.name,companyId:department.companyId,isGlobal:department.isGlobal}).from(department).where(and(isNull(department.archivedAt),sql`(${inArray(department.companyId,companyIds)} or ${department.isGlobal})`)).orderBy(department.name),
      tx.select({id:businessUnit.id,label:businessUnit.name,companyId:businessUnit.companyId,isGlobal:businessUnit.isGlobal}).from(businessUnit).where(and(isNull(businessUnit.archivedAt),sql`(${inArray(businessUnit.companyId,companyIds)} or ${businessUnit.isGlobal})`)).orderBy(businessUnit.name),
      tx.select({id:position.id,label:position.title,companyId:position.companyId,isGlobal:position.isGlobal}).from(position).where(and(isNull(position.archivedAt),sql`(${inArray(position.companyId,companyIds)} or ${position.isGlobal})`)).orderBy(position.title),
      tx.select({id:jobGrade.id,label:jobGrade.name}).from(jobGrade).where(isNull(jobGrade.archivedAt)).orderBy(jobGrade.rank,jobGrade.name),
      tx.select({id:employment.id,label:person.fullName,companyId:employment.companyId,category:employment.employmentCategory}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(and(inArray(employment.companyId,companyIds),sql`app.can_admin_employment(${employment.id})`)).orderBy(person.fullName,employment.id),
      tx.select({id:shift.id,label:shift.name,companyId:shift.companyId}).from(shift).where(and(isNull(shift.archivedAt),sql`(${shift.companyId} is null or ${inArray(shift.companyId,companyIds)})`)).orderBy(shift.name),
    ]);
    return {companies,departments,businessUnits,positions,grades,employees,categories:[...new Set(employees.flatMap(e=>e.category?[e.category]:[]))],shifts};
  });
}
