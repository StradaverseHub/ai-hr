/**
 * Multi-company payroll run orchestration (feedback 3653d14b, Phase 1).
 *
 * The Payroll Process wizard can now run one, several, or ALL of an administrator's companies in a single
 * initiated action. This module composes the EXISTING per-company primitives — it introduces NO kernel or
 * statutory-computation change: the payroll calculation for any single company is byte-identical to what it
 * was before. The only new behaviour is the loop, the per-company authorization + failure handling, and the
 * run-group summary that feeds the Step-3 result page.
 *
 * Engine reality (see plan §3): `generatePayslips` is all-or-nothing PER BATCH for FAILURE — it throws
 * wholesale on a hard failure and never returns a per-employee failure list. So Phase 1 reports failure at
 * COMPANY granularity (the caught throw, mapped to a reason code) plus the pre-flight "missing salary"
 * signal that already exists on the Step-2 employee row (`hasCurrentCompensation`). Per-employee failure
 * reasons are Phase 2.
 *
 * r226 AMENDS THAT IN EXACTLY ONE DIRECTION, AND IT IS NOT THE FAILURE DIRECTION. The kernel now returns a
 * per-employee SKIP list — the people the run had nothing to pay in that cycle. r369 widened WHICH runs
 * produce one (a regular run now skips an employee with no monthly basic and nothing payable) and changed
 * nothing about how it is reported: the shape, the arithmetic and the rule below are r226's. Skipped
 * is a third outcome beside succeeded and failed: it is counted separately, subtracted out of
 * `totalEmployeesFailed`, and must never be rendered as a failure. The all-or-nothing constraint on
 * FAILURE is untouched.
 *
 * Sequential, not parallel: each `generatePayslips` is its own transaction, so companies are processed one
 * at a time and presented to the user as a single run. HAZARD DISCIPLINE (both covered by tests):
 *   1. Per-company AUTHORIZATION — the submitted company set (and the "all" affordance) is re-intersected
 *      server-side with the admin's actual grants (`allowedCompanies`). A company the admin cannot access
 *      becomes a NOT_AUTHORIZED failure row, never a widened run and never a hard throw.
 *   2. CATCH PER COMPANY — one company failing (typically "already processed this month") must never abort
 *      the run; its throw is mapped to a reason code and the loop continues to the next company.
 */
import { NonCashBenefitConfigurationError } from '../localization/noncash-benefits';
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
  // 7076f8af — the pre-processing BLOCKER, named. It was already reachable here (generatePayslips throws
  // PreProcessBlockedError before it writes anything), but it landed in SYSTEM_VALIDATION_ERROR, which
  // tells an operator nothing they can act on. It matters more now that a RESUMED run reports through
  // this same result page: "somebody in scope has no current salary record" is the failure that path
  // will actually produce, and it is one the operator can fix in a minute.
  | 'TAX_SCHEME_DECLARATION_REQUIRED'
  | 'PRE_PROCESS_BLOCKED'
  | 'TAX_SELECTION_CONFIRMATION_REQUIRED'
  | 'TAX_SELECTION_INVALID_SCHEME'
  | 'TAX_SELECTION_CITIZENSHIP_UNKNOWN'
  | 'TAX_SELECTION_NOT_RESIDENT'
  | 'NON_CASH_CLASSIFICATION_CONFLICT'
  | 'NON_CASH_UNSUPPORTED_KIND'
  | 'NON_CASH_NORMAL_REMUNERATION_REQUIRED'
  | 'NON_CASH_MONTH_BASELINE_UNAVAILABLE'
  | 'NON_CASH_CONFIGURATION_INVALID'
  | 'SYSTEM_VALIDATION_ERROR';

/** The four fixed behavioural run types a cycle maps to (mirrors payrollRunTypeEnum / PayrollCycleRunType). */
export type IntendedRunType = 'regular' | 'off_cycle' | 'bonus' | 'adjustment';

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
  /**
   * r226 — THE THIRD OUTCOME, AND IT IS NOT A FAILURE. On an ADDITIONAL run (Bonus / Off-cycle /
   * Adjustment) the kernel does not process an employee it has nothing to pay in that cycle. Absent on a
   * regular run and on every run that skipped nobody, so a payload written before this shipped decodes
   * unchanged and reads as "nobody skipped".
   *
   * r227 MADE THIS A COUNT, AND IT WAS A LIST OF NAMED EMPLOYEES. This struct is JSON-encoded into the
   * result page's query string (`encodeRunGroupResult` → `?r=`), so it must stay O(companies); as a list
   * it was O(HEADCOUNT), and the runs this feature exists for are exactly the ones with a long list.
   * Measured on the r226 shape: 40 skipped = 9,298 bytes, 80 = 18,018, 245 = 54,136 — against Node's
   * 16,384-byte default header budget (deploy/aihr.service:29 starts `next start` with no
   * `--max-http-header-size`), shared with the request line and the session cookies, behind a cloudflared
   * tunnel with a similar cap. The result screen therefore failed to load at roughly seventy skipped
   * employees — AFTER the payroll had already committed, on the runs it was built for.
   *
   * THE NAMES DID NOT GO ANYWHERE. They are read from the DURABLE record instead — the
   * `payroll-batch.processed` domain event, which the kernel already writes with every skipped
   * employment id and reason — by `listSkippedEmployees` (core/payroll-view.ts), keyed off `batchId`
   * below. That is strictly better than the payload was: it also survives a refresh, which the one-shot
   * `?r=` string never did.
   */
  employeesSkipped?: number;
  /** Set on a failed company. */
  reason?: RunGroupReasonCode;
  /** Organization Module (361e3b15) — on an INVALID_CYCLE failure, the run TYPE that had no active cycle in
   *  this company, so the result page can name the company AND the missing cycle type (not a bare "no cycle"). */
  missingCycleRunType?: IntendedRunType;
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
  /** r226 — skipped is its OWN outcome, counted apart from processed and never reported as a failure. */
  totalEmployeesSkipped: number;
  totalEmployeesFailed: number;
  perCompany: CompanyOutcome[];
};

/** Map a thrown engine error to a stable reason code (pure — unit-tested directly). */
export function reasonForError(message: string): RunGroupReasonCode {
  if (message.startsWith('PCB tax scheme declaration: ')) return 'TAX_SCHEME_DECLARATION_REQUIRED';
  if (message.includes('A payroll process already exists for this period')) return 'PERIOD_ALREADY_PROCESSED';
  if (/No localization pack/i.test(message)) return 'NO_PAYROLL_CONFIG';
  // PreProcessBlockedError's own message (core/payroll.ts) — matched on its stable phrasing rather than by
  // instanceof, because this function is pure and takes only the message the caller already caught.
  if (/^Payroll cannot be processed: \d+ employees? in scope /.test(message)) return 'PRE_PROCESS_BLOCKED';
  return 'SYSTEM_VALIDATION_ERROR';
}

/** Typed calculation refusals retain actionable reasons without exposing engine text. */
export function reasonForPayrollError(error: unknown): RunGroupReasonCode {
  if (error instanceof Error && error.name === 'TaxSelectionError' && 'code' in error) {
    const codes = {confirmation_required:'TAX_SELECTION_CONFIRMATION_REQUIRED',invalid_scheme:'TAX_SELECTION_INVALID_SCHEME',citizenship_unknown:'TAX_SELECTION_CITIZENSHIP_UNKNOWN',not_resident:'TAX_SELECTION_NOT_RESIDENT'} as const;
    if (typeof error.code === 'string' && Object.hasOwn(codes, error.code)) return codes[error.code as keyof typeof codes];
    return 'SYSTEM_VALIDATION_ERROR';
  }
  if (error instanceof NonCashBenefitConfigurationError) {
    const codes = {classification_conflict:'NON_CASH_CLASSIFICATION_CONFLICT',unsupported_kind:'NON_CASH_UNSUPPORTED_KIND',normal_remuneration_required:'NON_CASH_NORMAL_REMUNERATION_REQUIRED',month_baseline_unavailable:'NON_CASH_MONTH_BASELINE_UNAVAILABLE'} as const;
    return Object.hasOwn(codes, error.reason) ? codes[error.reason] : 'NON_CASH_CONFIGURATION_INVALID';
  }
  return reasonForError(error instanceof Error ? error.message : typeof error === 'string' ? error : '');
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
  const totalEmployeesSkipped = perCompany.reduce((n, c) => n + (c.employeesSkipped ?? 0), 0);
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
    totalEmployeesSkipped,
    // Every selected employee in a wholesale-failed company counts as failed, plus any per-company gap
    // (comp-less hires the engine silently dropped) in a succeeded company.
    //
    // r226 — MINUS THE SKIPPED, and this subtraction is the whole reason the count exists. Without it
    // every employee an additional run deliberately left out would land in this figure and render RED on
    // the result page as "Failed to process" — the system reporting its own correct decision as forty
    // failures. A run that skipped nobody subtracts 0 and is arithmetically unchanged.
    totalEmployeesFailed: totalEmployeesSelected - totalEmployeesSucceeded - totalEmployeesSkipped,
    perCompany,
  };
}

/**
 * Organization Module — Automatic Payroll Cycle Assignment (361e3b15). PRE-FLIGHT for the wizard's Validation
 * step: which of the selected companies have NO active cycle of the intended run type. Reuses the EXACT gate
 * the run applies per company (listPayrollCycles active → find runType===intendedRunType), keyed on the actual
 * run runType — so it flags a genuinely un-runnable company (no false positive for a null default that still
 * resolves, no false negative for a default pointing at a different type) BEFORE submit, with the company
 * named. Companies outside the admin's grants are simply dropped (authz is re-checked in the run itself).
 */
export async function companiesMissingCycle(
  ctx: SessionContext,
  companyIds: string[],
  intendedRunType: IntendedRunType,
): Promise<{ companyId: string; companyName: string }[]> {
  const allowed = await allowedCompanies(ctx);
  const allowedById = new Map(allowed.map((c) => [c.id, c.name]));
  const requested = [...new Set(companyIds)].filter(Boolean).filter((id) => allowedById.has(id));
  const missing: { companyId: string; companyName: string }[] = [];
  for (const companyId of requested) {
    const cycle = (await listPayrollCycles(ctx, companyId, { activeOnly: true })).find(
      (c) => c.runType === intendedRunType,
    );
    if (!cycle) missing.push({ companyId, companyName: allowedById.get(companyId)! });
  }
  return missing;
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
      //
      // c11e81aa — THE OPERATOR'S OWN PICK WINS FOR THE COMPANY IT BELONGS TO. `getActivePayrollCycle`
      // re-validates the id against THIS company and returns null for any other, so the chosen row is used
      // where it is legitimate and the type-based resolution below still covers every other company. This
      // was a latent wart while only `runType`/`remarks` were read off the result — picking "Mid-Month"
      // resolved to whichever off_cycle cycle sorted first, losing both the identity AND the remarks label.
      // It stopped being latent the moment a transaction could name a cycle: the run has to record the
      // cycle the operator actually chose, or a row saved as "Mid-Month" is collected by nobody.
      const chosen = input.payrollCycleId ? await getActivePayrollCycle(ctx, input.payrollCycleId, companyId) : null;
      const cycle =
        chosen ?? (await listPayrollCycles(ctx, companyId, { activeOnly: true })).find((c) => c.runType === intendedRunType);
      if (!cycle) {
        perCompany.push({
          companyId,
          companyName,
          status: 'failed',
          employeesSelected,
          employeesSucceeded: 0,
          reason: 'INVALID_CYCLE',
          // Organization Module (361e3b15) — carry the intended run type so the result page's message names it.
          missingCycleRunType: intendedRunType,
        });
        continue;
      }

      const created =
        cycle.runType === 'regular'
          ? await createBatch(ctx, {
              companyId,
              payPeriod: input.payPeriod,
              scope,
              paymentDate: input.paymentDate || undefined,
              payrollCycleId: cycle.id,
            })
          : await createAdditionalRun(ctx, {
              companyId,
              payPeriod: input.payPeriod,
              runType: cycle.runType,
              remarks: cycle.remarks ?? undefined,
              scope,
              paymentDate: input.paymentDate || undefined,
              // c11e81aa — the run's identity, not just its behaviour. Without it a non-regular run
              // cannot be told from its same-typed siblings and collects no named transaction at all.
              payrollCycleId: cycle.id,
            });

      // Full draft→processed generation (never the reprocessSubset path), so `payslips` is present;
      // fall back to 0 to satisfy the union return type of generatePayslips.
      const genResult = await generatePayslips(ctx, { batchId: created.batchId });
      const payslips = 'payslips' in genResult && typeof genResult.payslips === 'number' ? genResult.payslips : 0;
      // r226 — the kernel's own skip list. Same union-return guard as `payslips`: the subset-reprocess
      // branch has no `skipped` key and this path never takes it. r227 carries only its LENGTH onto the
      // outcome (see `employeesSkipped`) — the names ride the durable event, not the redirect.
      const skipped = 'skipped' in genResult && Array.isArray(genResult.skipped) ? genResult.skipped : [];
      perCompany.push({
        companyId,
        companyName,
        status: 'succeeded',
        batchId: created.batchId,
        employeesSelected,
        employeesSucceeded: payslips,
        ...(skipped.length > 0 ? { employeesSkipped: skipped.length } : {}),
      });
    } catch (e) {
      // HAZARD 2 — catch PER COMPANY. One company's failure never aborts the others in the run.
      perCompany.push({
        companyId,
        companyName,
        status: 'failed',
        employeesSelected: 0,
        employeesSucceeded: 0,
        reason: reasonForPayrollError(e),
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
          // r226 — the run-group event is the DURABLE record (the `?r=` payload dies with the redirect),
          // so the skip has to be inspectable here too. A COUNT only: the per-employee ids and reasons
          // are on each batch's own `payroll-batch.processed` event, written by the kernel, which is
          // where the result screen reads them from (r227). Recording them twice would let two durable
          // records of the same fact disagree.
          employeesSkipped: c.employeesSkipped ?? 0,
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
