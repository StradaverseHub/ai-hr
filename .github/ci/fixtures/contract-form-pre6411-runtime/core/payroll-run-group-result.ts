/**
 * The multi-company payroll run's result shapes and their pure derivations (reason codes, header counts, the
 * one-shot `?r=` transport), split out of core/payroll-run-group.ts so the processing job (which maps a failed
 * run to its reason) and the run-group record can share them without importing the orchestrator. Unchanged in
 * behaviour; core/payroll-run-group.ts re-exports every name.
 */
import { NonCashBenefitConfigurationError } from '../localization/noncash-benefits';
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
  | 'SYSTEM_VALIDATION_ERROR'
  | 'EMPTY_SELECTION'
  | 'INVALID_SELECTION'
  | 'DRAFT_REQUIRES_REGULAR';

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
  /** Absent on historical/processed results. Draft means no generation was requested. */
  mode?: 'draft';
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
