/**
 * Multi-company payroll run orchestration (feedback 3653d14b, Phase 1).
 *
 * The Payroll Process wizard can now run one, several, or ALL of an administrator's companies in a single
 * initiated action. This module composes the EXISTING per-company primitives — it introduces NO kernel or
 * statutory-computation change: the payroll calculation for any single company is byte-identical to what it
 * was before. The only new behaviour is the loop, the per-company authorization + failure handling, and the
 * run-group summary that feeds the Step-3 result page.
 *
 * Engine reality (see plan §3): `generatePayslips` is all-or-nothing PER BATCH — it throws wholesale on a
 * hard failure and never returns a per-employee failure list. So Phase 1 reports failure at COMPANY
 * granularity (the caught throw, mapped to a reason code) plus the pre-flight "missing salary" signal that
 * already exists on the Step-2 employee row (`hasCurrentCompensation`). Per-employee reasons are Phase 2.
 *
 * Sequential, not parallel: each `generatePayslips` is its own transaction, so companies are processed one
 * at a time and presented to the user as a single run. HAZARD DISCIPLINE (both covered by tests):
 *   1. Per-company AUTHORIZATION — the submitted company set (and the "all" affordance) is re-intersected
 *      server-side with the admin's actual grants (`allowedCompanies`). A company the admin cannot access
 *      becomes a NOT_AUTHORIZED failure row, never a widened run and never a hard throw.
 *   2. CATCH PER COMPANY — one company failing (typically "already processed this month") must never abort
 *      the run; its throw is mapped to a reason code and the loop continues to the next company.
 */
import { withTenant, type SessionContext } from '../db/client';
import { randomUUID } from 'node:crypto';
import { actorOf, appendEvent } from '../db/events';
import { createAdditionalRun, createBatch, generatePayslips } from './payroll';
import { getActivePayrollCycle, listPayrollCycles } from './payroll-cycle';
import { allowedCompanies, listEmployees } from './read';

/** Machine-stable failure reasons the result page renders as friendly, localized text. */
export type RunGroupReasonCode =
  | 'PERIOD_ALREADY_PROCESSED'
  | 'NO_PAYROLL_CONFIG'
  | 'NOT_AUTHORIZED'
  | 'INVALID_CYCLE'
  | 'SYSTEM_VALIDATION_ERROR';

/** The outcome of processing ONE company within the run. */
export type CompanyOutcome = {
  companyId: string;
  companyName: string;
  status: 'succeeded' | 'failed';
  /** The batch that was created (present on success; may be present on a post-create failure). */
  batchId?: string;
  /** Employees resolved in scope for this company (the count the run attempted to pay). */
  employeesSelected: number;
  /** Payslips actually generated (the engine's own count of paid employees). */
  employeesSucceeded: number;
  /** Set on a failed company. */
  reason?: RunGroupReasonCode;
};

/** The complete result of a multi-company run — the payload the Step-3 result page renders. */
export type RunGroupResult = {
  payPeriod: string;
  startedAt: string;
  endedAt: string;
  overallStatus: 'succeeded' | 'partial' | 'failed';
  totalCompanies: number;
  companiesSucceeded: number;
  companiesFailed: number;
  totalEmployeesSelected: number;
  totalEmployeesSucceeded: number;
  totalEmployeesFailed: number;
  perCompany: CompanyOutcome[];
};

/** Map a thrown engine error to a stable reason code (pure — unit-tested directly). */
export function reasonForError(message: string): RunGroupReasonCode {
  if (message.includes('A payroll process already exists for this period')) return 'PERIOD_ALREADY_PROCESSED';
  if (/No localization pack/i.test(message)) return 'NO_PAYROLL_CONFIG';
  return 'SYSTEM_VALIDATION_ERROR';
}

/** Derive the overall run status from the per-company outcomes (pure — unit-tested directly). */
export function overallStatusOf(perCompany: readonly CompanyOutcome[]): RunGroupResult['overallStatus'] {
  const failed = perCompany.filter((c) => c.status === 'failed').length;
  if (failed === 0) return 'succeeded';
  if (failed === perCompany.length) return 'failed';
  return 'partial';
}

/** Aggregate the per-company outcomes into the run-group header counts (pure — unit-tested directly). */
export function summarize(
  payPeriod: string,
  startedAt: string,
  endedAt: string,
  perCompany: CompanyOutcome[],
): RunGroupResult {
  const companiesSucceeded = perCompany.filter((c) => c.status === 'succeeded').length;
  const totalEmployeesSelected = perCompany.reduce((n, c) => n + c.employeesSelected, 0);
  const totalEmployeesSucceeded = perCompany.reduce((n, c) => n + c.employeesSucceeded, 0);
  return {
    payPeriod,
    startedAt,
    endedAt,
    overallStatus: overallStatusOf(perCompany),
    totalCompanies: perCompany.length,
    companiesSucceeded,
    companiesFailed: perCompany.length - companiesSucceeded,
    totalEmployeesSelected,
    totalEmployeesSucceeded,
    // Every selected employee in a wholesale-failed company counts as failed, plus any per-company gap
    // (comp-less hires the engine silently dropped) in a succeeded company.
    totalEmployeesFailed: totalEmployeesSelected - totalEmployeesSucceeded,
    perCompany,
  };
}

export type RunMultiCompanyInput = {
  /** Explicit company ids the admin selected, OR the sentinel handling of "all" done by the caller (the
   *  caller resolves "all" to the scoped set before calling — this module never widens beyond grants). */
  companyIds: string[];
  payPeriod: string;
  /** The cycle id chosen in Step 1 (bound to the PRIMARY company's catalog). Phase 1 uses a single shared
   *  cycle across the selected companies (plan §"Step 1"); since cycle ids are PER-COMPANY, this id only
   *  determines the intended run TYPE (resolved against the primary company), and each company's own active
   *  cycle of that type is resolved server-side below — never trusting one company's id for another. */
  payrollCycleId: string;
  paymentDate?: string;
  /** Explicit employee subset (across the selected companies). Empty ⇒ whole-company default per company. */
  employmentIds: string[];
};

/**
 * Run payroll across the authorized subset of the requested companies. Composes createBatch/
 * createAdditionalRun + generatePayslips per company with per-company authz and per-company failure
 * handling, then appends ONE run-group DomainEvent for the whole run (substrate discipline: the per-company
 * primitives already append their own batch/period events; this adds the run-level audit record).
 */
export async function runMultiCompanyPayroll(
  ctx: SessionContext,
  input: RunMultiCompanyInput,
): Promise<RunGroupResult> {
  const startedAt = new Date().toISOString();

  // HAZARD 1 — authorize every submitted company id against the admin's ACTUAL grants. The client list is
  // untrusted; a company outside allowedCompanies is dropped to a NOT_AUTHORIZED row, never a widened run.
  const allowed = await allowedCompanies(ctx);
  const allowedById = new Map(allowed.map((c) => [c.id, c.name]));
  const requested = [...new Set(input.companyIds)].filter(Boolean);

  // Determine the INTENDED run type from the Step-1 cycle id (bound to the primary company). Cycle ids are
  // per-company, so we never reuse this id for another company — only its runType. Default to 'regular'
  // (the common month-end case) if the id can't be resolved against any authorized company's catalog.
  const primaryId = requested.find((id) => allowedById.has(id));
  let intendedRunType: 'regular' | 'off_cycle' | 'bonus' | 'adjustment' = 'regular';
  if (primaryId && input.payrollCycleId) {
    const primaryCycle = await getActivePayrollCycle(ctx, input.payrollCycleId, primaryId);
    if (primaryCycle) intendedRunType = primaryCycle.runType;
  }

  const perCompany: CompanyOutcome[] = [];

  for (const companyId of requested) {
    const companyName = allowedById.get(companyId);
    if (!companyName) {
      // Not in the admin's grants — record and continue (do NOT throw, do NOT widen).
      perCompany.push({
        companyId,
        companyName: companyId,
        status: 'failed',
        employeesSelected: 0,
        employeesSucceeded: 0,
        reason: 'NOT_AUTHORIZED',
      });
      continue;
    }

    try {
      // Resolve this company's scope subset: intersect the submitted employment ids with THIS company's
      // employees (mirrors createRunAction's guard so a cross-company id can never under/over-set the run).
      let scope: { employmentIds: string[] } | undefined;
      let employeesSelected: number;
      const companyEmps = await listEmployees(ctx, [companyId]);
      if (input.employmentIds.length) {
        const valid = new Set(companyEmps.map((e) => e.employmentId));
        const employmentIds = input.employmentIds.filter((id) => valid.has(id));
        scope = employmentIds.length ? { employmentIds } : undefined;
        // With an explicit selection, the count attempted is the resolved subset for this company. If none
        // of the submitted ids belong to this company, fall back to the whole-company default (no scope).
        employeesSelected = scope ? scope.employmentIds.length : companyEmps.length;
      } else {
        // Whole-company default: the run attempts every employee of the company.
        employeesSelected = companyEmps.length;
      }

      // Resolve THIS company's OWN active cycle of the intended run type (cycle ids are per-company, so we
      // never apply the primary company's id here). A company with no active cycle of that type is an
      // INVALID_CYCLE failure for that company, not a run abort. At most one active regular cycle exists per
      // company (enforced at the app level, plan item 2), so the first match is deterministic.
      const cycle = (await listPayrollCycles(ctx, companyId, { activeOnly: true })).find(
        (c) => c.runType === intendedRunType,
      );
      if (!cycle) {
        perCompany.push({
          companyId,
          companyName,
          status: 'failed',
          employeesSelected,
          employeesSucceeded: 0,
          reason: 'INVALID_CYCLE',
        });
        continue;
      }

      const created =
        cycle.runType === 'regular'
          ? await createBatch(ctx, { companyId, payPeriod: input.payPeriod, scope, paymentDate: input.paymentDate || undefined })
          : await createAdditionalRun(ctx, {
              companyId,
              payPeriod: input.payPeriod,
              runType: cycle.runType,
              remarks: cycle.remarks ?? undefined,
              scope,
              paymentDate: input.paymentDate || undefined,
            });

      const { payslips } = await generatePayslips(ctx, { batchId: created.batchId });
      perCompany.push({
        companyId,
        companyName,
        status: 'succeeded',
        batchId: created.batchId,
        employeesSelected,
        employeesSucceeded: payslips,
      });
    } catch (e) {
      // HAZARD 2 — catch PER COMPANY. One company's failure never aborts the others in the run.
      perCompany.push({
        companyId,
        companyName,
        status: 'failed',
        employeesSelected: 0,
        employeesSucceeded: 0,
        reason: reasonForError((e as Error).message),
      });
    }
  }

  const endedAt = new Date().toISOString();
  const result = summarize(input.payPeriod, startedAt, endedAt, perCompany);

  // Substrate: one run-group-level DomainEvent so the multi-company run itself is auditable. Batch/company
  // level (no single employee subject) ⇒ subjectEmploymentId stays null (admin-only read, fail-closed).
  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-run-group',
      // Phase 1 has no persisted run-group row (see plan §"Run-group record"); the durable record is this
      // event. domain_event.aggregate_id is UUID-typed, so mint a synthetic id for the virtual run-group and
      // carry the human-addressable "<period>:<startedAt>" key in the payload as `runKey`.
      aggregateId: randomUUID(),
      eventType: 'payroll-run-group.completed',
      actor: actorOf(ctx),
      payload: {
        runKey: `${input.payPeriod}:${startedAt}`,
        payPeriod: input.payPeriod,
        companyIds: requested,
        startedAt,
        endedAt,
        overallStatus: result.overallStatus,
        perCompany: perCompany.map((c) => ({
          companyId: c.companyId,
          batchId: c.batchId ?? null,
          status: c.status,
          reason: c.reason ?? null,
          employeesSelected: c.employeesSelected,
          employeesSucceeded: c.employeesSucceeded,
        })),
      },
    }),
  );

  return result;
}

/**
 * One-shot result transport (Phase 1, no persistence): encode the run outcome into a compact, URL-safe
 * string carried on the redirect to the result page — mirroring how createRunAction passes holiday-warning
 * codes through the query string. The durable audit record is the run-group DomainEvent above; this string
 * is only read for the single render right after the run (a refresh loses it, by design for Phase 1).
 * Pure (no DB) so both the encode and decode are unit-testable.
 */
export function encodeRunGroupResult(result: RunGroupResult): string {
  return encodeURIComponent(JSON.stringify(result));
}

export function decodeRunGroupResult(raw: string | undefined | null): RunGroupResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as RunGroupResult;
    if (!parsed || !Array.isArray(parsed.perCompany) || typeof parsed.payPeriod !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
