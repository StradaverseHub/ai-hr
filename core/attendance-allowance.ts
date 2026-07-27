/**
 * Attendance Allowance (ADR-0072, Monthly v1). A company-scoped catalog policy that rewards good
 * attendance with a fixed amount, transferred into a draft payroll run via the existing pay-component
 * prefill path. Evaluation is a PURE READ (no award table); the only persisted output is the
 * payroll_batch_component row created at transfer time (claims / OT precedent).
 *
 * Substrate: every WRITE method appends a DomainEvent (actorOf / appendEvent) before returning. The
 * evaluation READ appends nothing (a pure read). The transfer path appends through
 * setPayrollBatchComponent, exactly as the OT / claims prefill already does.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  attendanceAllowancePolicy,
  company,
  department,
  employment,
  payComponent,
  payrollBatch,
  payrollBatchComponent,
  type AttendanceAllowanceCriteria,
  type AttendanceAllowanceScope,
} from '../db/schema';
import { attendanceMonthSummary, type MonthSummaryRow } from './attendance';
import { BatchNotDraftError } from './payroll';
import { setPayrollBatchComponent, UnsupportedBatchComponentError } from './pay-components';
import { isModuleEnabled } from './entitlements';

// v1 accepts only the Monthly method. Text tag (app-side check); Daily deferred.
export const ALLOWANCE_METHODS = ['monthly'] as const;
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
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error('Amount must be a non-negative number');
  return n.toFixed(2);
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
  const effectiveFrom = cleanText(p.effectiveFrom, 'Effective date');
  const criteria = cleanCriteria(p.criteria);
  const scope = cleanScope(p.scope);
  return withTenant(ctx, async (tx) => {
    let id: string;
    try {
      const [row] = await tx
        .insert(attendanceAllowancePolicy)
        .values({
          tenantId: ctx.tenantId,
          companyId,
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
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-allowance-policy',
      aggregateId: id,
      eventType: 'attendance-allowance-policy.created',
      actor: actorOf(ctx),
      payload: { companyId, code, name, method, amount, payComponentId, effectiveFrom, criteria, scope },
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
      .limit(1);
    if (!before) throw new Error('Attendance-allowance policy not found');
    const code = p.code !== undefined ? cleanText(p.code, 'Code') : before.code;
    const name = p.name !== undefined ? cleanText(p.name, 'Name') : before.name;
    const amount = p.amount !== undefined ? cleanAmount(p.amount) : before.amount;
    const payComponentId =
      p.payComponentId !== undefined ? cleanText(p.payComponentId, 'Pay component') : before.payComponentId;
    const effectiveFrom =
      p.effectiveFrom !== undefined ? cleanText(p.effectiveFrom, 'Effective date') : before.effectiveFrom;
    const criteria = p.criteria !== undefined ? cleanCriteria(p.criteria) : before.criteria;
    const scope = p.scope !== undefined ? cleanScope(p.scope) : before.scope;
    try {
      await tx
        .update(attendanceAllowancePolicy)
        .set({ code, name, amount, payComponentId, effectiveFrom, criteria, scope })
        .where(eq(attendanceAllowancePolicy.id, p.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateAllowancePolicyCodeError();
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-allowance-policy',
      aggregateId: p.id,
      eventType: 'attendance-allowance-policy.updated',
      actor: actorOf(ctx),
      payload: {
        before: {
          code: before.code,
          name: before.name,
          amount: before.amount,
          payComponentId: before.payComponentId,
          effectiveFrom: before.effectiveFrom,
          criteria: before.criteria,
          scope: before.scope,
        },
        after: { code, name, amount, payComponentId, effectiveFrom, criteria, scope },
      },
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
};

/**
 * Evaluate a policy for a month across the policy's company. Loads the policy, runs the shared monthly
 * summary, resolves each employee's org placement (scope join), post-filters against policy.scope, and
 * runs evaluateMonthly per in-scope row. PURE READ — no writes, no events. Out-of-scope employees are
 * excluded from the returned list (they are not candidates for this policy).
 */
export async function evaluateAllowancesForPeriod(
  ctx: SessionContext,
  p: { policyId: string; month: string; today?: string },
): Promise<{ policyId: string; month: string; rows: AllowanceEvaluationRow[] }> {
  return withTenant(ctx, async (tx) => {
    const [policy] = await tx
      .select()
      .from(attendanceAllowancePolicy)
      .where(eq(attendanceAllowancePolicy.id, p.policyId))
      .limit(1);
    if (!policy) throw new Error('Attendance-allowance policy not found');
    const criteria = policy.criteria ?? {};
    const scope = policy.scope ?? {};

    // The policy is company-scoped; the monthly summary is scoped to that company.
    const summary = await attendanceMonthSummary(ctx, {
      month: p.month,
      companyIds: [policy.companyId],
      today: p.today,
    });
    const info = await scopeInfoFor(tx, summary.map((s) => s.employmentId));

    const rows: AllowanceEvaluationRow[] = [];
    for (const s of summary) {
      const scoped = inScope(scope, info.get(s.employmentId));
      if (!scoped) continue; // not a candidate for this policy
      const ev = evaluateMonthly(s, criteria);
      rows.push({
        employmentId: s.employmentId,
        name: s.name,
        qualified: ev.qualified,
        amount: ev.qualified ? policy.amount : '0.00',
        reasons: ev.reasons,
        perCriterion: ev.perCriterion,
        inScope: true,
      });
    }
    return { policyId: policy.id, month: p.month, rows };
  });
}

// ─────────────────────── Payroll transfer (reuses setPayrollBatchComponent) ───────────────────────

export type TransferResult = {
  applied: number;
  ineligible: number;
  reversed: number;
  gated: boolean;
};

/**
 * Transfer a Monthly policy's qualified allowances onto a DRAFT payroll batch, reusing the existing
 * pay-component prefill path (setPayrollBatchComponent). Mirrors prefillOvertimeFromAttendance's shape:
 *   1. Load the draft batch; throw BatchNotDraftError if not draft.
 *   2. GATE CHECK FIRST (like prefillShiftDifferentialFromRoster): if TYPED_PAY_COMPONENTS_ENABLED is
 *      not 'true', return { gated: true } and write NOTHING, so the UI can warn the amount won't reach
 *      payslips.
 *   3. SUPPORTED-COMPONENT GUARD: reject a PCB-taxable non-EPF/non-SOCSO/non-payable component up front
 *      with UnsupportedBatchComponentError (setPayrollBatchComponent throws on it mid-loop otherwise).
 *   4. Re-derive qualification at transfer time from CURRENT attendance (evaluation is a live read).
 *      Each qualified in-scope employee gets amount = policy.amount via the idempotent upsert (by
 *      batch+employment+component), so re-running does not double-pay.
 *   5. REVERSAL: if an employee no longer qualifies (attendance corrected downward after a prior
 *      transfer) but has an existing batch component row for THIS pay component, remove it. The batch row
 *      is the single source of truth — no award table to keep in sync.
 */
export async function transferAllowancesToBatch(
  ctx: SessionContext,
  p: { batchId: string; policyId: string },
): Promise<TransferResult> {
  // 2. Gate check first — no session/DB work when the pipeline is off.
  if (!isModuleEnabled(ctx, 'typed_pay_components')) {
    return { applied: 0, ineligible: 0, reversed: 0, gated: true };
  }
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const [policy] = await tx
      .select()
      .from(attendanceAllowancePolicy)
      .where(eq(attendanceAllowancePolicy.id, p.policyId))
      .limit(1);
    if (!policy) throw new Error('Attendance-allowance policy not found');

    // 3. Supported-component guard — fail fast, not mid-loop.
    const [comp] = await tx
      .select({
        includedInEpf: payComponent.includedInEpf,
        includedInSocsoEis: payComponent.includedInSocsoEis,
        includedInPcb: payComponent.includedInPcb,
        isNonPayable: payComponent.isNonPayable,
        code: payComponent.code,
      })
      .from(payComponent)
      .where(eq(payComponent.id, policy.payComponentId))
      .limit(1);
    if (!comp) throw new Error('Pay component not found for this policy');
    if (comp.includedInPcb && (comp.isNonPayable || (!comp.includedInEpf && !comp.includedInSocsoEis))) {
      throw new UnsupportedBatchComponentError(comp.code);
    }

    // The company's country is not needed — evaluation is calendar-month based. Match the summary month
    // to the batch's payPeriod (v1 is Monthly, so ONE component row per employee is correct — no summing).
    const evaluation = await evaluateAllowancesForPeriod(ctx, {
      policyId: policy.id,
      month: batch.payPeriod,
    });

    const qualifiedIds = new Set(evaluation.rows.filter((r) => r.qualified).map((r) => r.employmentId));

    // Existing rows for this policy's component on this batch — the reversal candidates.
    const existing = await tx
      .select({ employmentId: payrollBatchComponent.employmentId })
      .from(payrollBatchComponent)
      .where(
        and(
          eq(payrollBatchComponent.batchId, batch.id),
          eq(payrollBatchComponent.componentId, policy.payComponentId),
        ),
      );

    let applied = 0;
    let ineligible = 0;
    let reversed = 0;

    // 4. Upsert the fixed amount for each qualified employee.
    for (const row of evaluation.rows) {
      if (!row.qualified) {
        ineligible += 1;
        continue;
      }
      await setPayrollBatchComponent(
        ctx,
        {
          batchId: batch.id,
          employmentId: row.employmentId,
          componentId: policy.payComponentId,
          amount: Number(policy.amount),
          notes: `Attendance allowance (${policy.code})`,
        },
        tx,
      );
      applied += 1;
    }

    // 5. Reversal — remove rows for employees who previously qualified but no longer do.
    for (const ex of existing) {
      if (!qualifiedIds.has(ex.employmentId)) {
        await tx
          .delete(payrollBatchComponent)
          .where(
            and(
              eq(payrollBatchComponent.batchId, batch.id),
              eq(payrollBatchComponent.employmentId, ex.employmentId),
              eq(payrollBatchComponent.componentId, policy.payComponentId),
            ),
          );
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'payroll-batch-component',
          aggregateId: batch.id,
          eventType: 'payroll-batch-component.removed',
          actor: actorOf(ctx),
          subjectEmploymentId: ex.employmentId,
          // ADR-0030 Layer 0: the amount is not carried in the event payload; reference only.
          payload: { batchId: batch.id, componentId: policy.payComponentId, reason: 'attendance-allowance-disqualified' },
        });
        reversed += 1;
      }
    }

    // Policy-level command event so the transfer is auditable (per-employee sets already logged by
    // setPayrollBatchComponent). No monetary value in the payload (ADR-0030 Layer 0).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-allowance-policy',
      aggregateId: policy.id,
      eventType: 'attendance-allowance-policy.transferred',
      actor: actorOf(ctx),
      payload: { batchId: batch.id, payPeriod: batch.payPeriod, applied, ineligible, reversed },
    });

    return { applied, ineligible, reversed, gated: false };
  });
}
