'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { scopedAdmin } from '@/lib/scope';
import { batchDetail, createAdditionalRun, createBatch, generatePayslips, preProcessAdvisoryForSelection, updateBatchScope, type PreProcessAdvisory } from '@/core/payroll';
import { getActivePayrollCycle } from '@/core/payroll-cycle';
import { allowedCompanies, listEmployees, listEmployeesForPayrollRun, type PayrollRunEmployeeRow } from '@/core/read';
import {
  companiesMissingCycle,
  encodeRunGroupResult,
  reasonForError,
  runMultiCompanyPayroll,
  summarize,
  type CompanyOutcome,
  type IntendedRunType,
} from '@/core/payroll-run-group';
import { unattachedHoldersOutsideSelection, type UnattachedHolderRow } from '@/core/payroll-view';

/** Step 2 population (plan §2) — fetched by the client once company(ies) + period are chosen. Accepts one
 *  or more company ids so the multi-company run's Step-2 list spans every selected company (3653d14b). */
export async function fetchPayrollRunEmployees(
  companyIds: string | string[],
  payPeriod: string,
): Promise<PayrollRunEmployeeRow[]> {
  const s = await getSession();
  const ids = (Array.isArray(companyIds) ? companyIds : [companyIds]).filter(Boolean);
  if (ids.length === 0 || !/^\d{4}-\d{2}$/.test(payPeriod)) return [];
  return listEmployeesForPayrollRun(s, ids, payPeriod);
}

const EMPTY_ADVISORY: PreProcessAdvisory = {
  missingCompensation: [],
  missingStatutory: [],
  missingBank: [],
};

/**
 * Payroll Process wizard — Validation step (R37 70764928). Runs the SAME pre-processing checks the batch
 * page and the terminal Process action enforce, but BEFORE the batch exists, over the wizard's live
 * selection (companies + period + touched employee scope). The client renders the result green/amber/red
 * and blocks advance to Process when there are blockers (missing/zero salary record — feedback 64fb5e48:
 * the Personnel Basic Salary record is authoritative; a BASIC pay item is never required).
 * Read-only — no state mutation, no event (the durable event is appended when the run is actually created).
 */
export async function validatePayrollSelection(input: {
  companyIds: string[];
  payPeriod: string;
  employmentIds?: string[];
}): Promise<PreProcessAdvisory> {
  const s = await getSession();
  const companyIds = (input.companyIds ?? []).filter(Boolean);
  if (companyIds.length === 0 || !/^\d{4}-\d{2}$/.test(input.payPeriod)) return EMPTY_ADVISORY;
  const employmentIds = (input.employmentIds ?? []).filter(Boolean);
  return preProcessAdvisoryForSelection(s, {
    companyIds,
    payPeriod: input.payPeriod,
    employmentIds: employmentIds.length ? employmentIds : undefined,
  });
}

/**
 * Organization Module — Automatic Payroll Cycle Assignment (361e3b15). Wizard Validation-step PRE-FLIGHT:
 * which selected companies have no active cycle of the intended run type, so the operator sees a clear
 * per-company message BEFORE submit instead of the run quietly skipping them. Reuses the exact per-company
 * gate the run applies (companiesMissingCycle). Read-only — no state mutation, no event.
 */
export async function checkPayrollCycleReadiness(input: {
  companyIds: string[];
  intendedRunType: IntendedRunType;
}): Promise<{ companyId: string; companyName: string }[]> {
  const s = await getSession();
  const companyIds = (input.companyIds ?? []).filter(Boolean);
  if (companyIds.length === 0) return [];
  return companiesMissingCycle(s, companyIds, input.intendedRunType);
}

/**
 * Feedback d0d2c9d1 — Validation-step PRE-FLIGHT: which employees the run is about to LEAVE OUT are
 * holding transactions that have not reached a payslip, and how much.
 *
 * This is the first of the two ways RM23,170 went unpaid: `generatePayslips` only attaches on
 * `!subset && runType === 'regular'`, so narrowing a run to some employees silently strands everyone
 * else's transactions for that month. Nothing said so at any point before or after submit.
 *
 * DELIBERATELY A SEPARATE ACTION, NOT A FIELD ON PreProcessAdvisory. generateAction (app/payroll/
 * actions.ts) and app/payroll/[batchId]/page.tsx both SUM the advisory's optional arrays into a
 * `warnings` count that decides whether the ackWarnings=1 confirm dialog is demanded. Adding an array
 * there would silently change that gate for every tenant on every run — for something that is purely
 * informational. It is modelled on checkPayrollCycleReadiness above, which is informational for the
 * same reason: a narrowed run can be exactly what the operator intends.
 *
 * c11e81aa AMENDS THE OLD "[] FOR AN UNSCOPED RUN" NOTE, which read: a full regular run collects every
 * outstanding row for the month, so there is nothing to warn about. That stopped being true when a
 * transaction gained the right to NAME a Pay Cycle — a full regular run now walks past every row marked
 * "Bonus" or "Mid-Month", whoever is selected. So the run type travels with the selection, and the
 * pre-flight reports that money too rather than going silent on it. Read-only — no state, no event.
 */
export async function checkUnattachedForSelection(input: {
  companyIds: string[];
  payPeriod: string;
  employmentIds?: string[];
  /** The run type Step 1's chosen cycle maps to. Absent in resume mode, where it is already fixed. */
  intendedRunType?: IntendedRunType;
}): Promise<UnattachedHolderRow[]> {
  const s = await getSession();
  return unattachedHoldersOutsideSelection(s, input);
}

/**
 * Payroll Process wizard (Step 1–2 → terminal action). Creation is the TERMINAL wizard action — no
 * eager batch creation on Step-3 entry, no auto-prefill orchestration (plan §"CUT"). Redirects to the
 * existing draft batch page, now presented as Step 3 of 3, with a compact one-shot holiday-warning
 * code list in the query string (the domain event remains the durable record).
 */
export async function createRunAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const payPeriod = String(formData.get('payPeriod'));
  const payrollCycleId = String(formData.get('payrollCycleId') || '');
  const paymentDate = String(formData.get('paymentDate') || '');
  const submittedEmploymentIds = formData.getAll('employmentIds').map(String).filter(Boolean);

  // ADR-0069: resolve the selected cycle server-side and derive runType/remarks from the ROW — the client
  // only submits the id, and a stale/cross-company/archived id can never reach the kernel (defence in
  // depth; RLS already scopes the read, this rejects with a friendly redirect instead of a raw throw).
  const cycle = payrollCycleId ? await getActivePayrollCycle(s, payrollCycleId, companyId) : null;
  if (!cycle) {
    redirect(`/payroll/process?error=${encodeURIComponent('Select a valid, active payroll cycle for this company.')}`);
  }

  // Same guard as the legacy create form: intersect submitted ids with the chosen company's employees so
  // a stale/cross-company id can never reach createBatch/createAdditionalRun and silently under-set the run.
  let employmentIds = submittedEmploymentIds;
  if (submittedEmploymentIds.length) {
    const companyEmps = await listEmployees(s, [companyId]);
    const valid = new Set(companyEmps.map((e) => e.employmentId));
    employmentIds = submittedEmploymentIds.filter((id) => valid.has(id));
  }
  // Scope rule (plan): ANY filter use or manual deselect ⇒ submit the resolved explicit snapshot. NO
  // filters and nobody deselected ⇒ submit no scope at all (today's whole-company dynamic default). The
  // client only ever posts employmentIds when the user actually narrowed the set (see step-selection.tsx).
  const scope = employmentIds.length ? { employmentIds } : undefined;

  let batchId = '';
  let holidayWarnings: unknown[] = [];
  try {
    if (cycle.runType === 'regular') {
      // c11e81aa — the run records the cycle it was opened under, not merely its behaviour.
      const r = await createBatch(s, { companyId, payPeriod, scope, paymentDate: paymentDate || undefined, payrollCycleId: cycle.id });
      batchId = r.batchId;
      holidayWarnings = r.holidayWarnings ?? [];
    } else {
      // Non-regular runs (off_cycle / bonus / adjustment) map straight through; the resolved cycle carries
      // any preset label (e.g. 'Advance Salary' / 'Mid-Month') in its remarks, snapshotted onto the batch.
      const r = await createAdditionalRun(s, {
        companyId,
        payPeriod,
        runType: cycle.runType,
        remarks: cycle.remarks ?? undefined,
        scope,
        paymentDate: paymentDate || undefined,
        // c11e81aa — three default cycles are run_type 'off_cycle'; only this id tells them apart, and
        // only this id lets the run collect the transactions the operator named it on.
        payrollCycleId: cycle.id,
      });
      batchId = r.batchId;
    }
  } catch (e) {
    redirect(`/payroll/process?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll');
  // Compact one-shot codes 'country|state|year|loaded|required' (';'-joined) — the domain event appended
  // inside createBatch remains the durable record; this query param only carries the warning to Step 3
  // for the ONE render right after creation (the page itself displays no persistent warning banner today).
  const hw = holidayWarnings.length
    ? `&hw=${encodeURIComponent(
        (holidayWarnings as { country: string; state: string | null; year: number; loaded: number; required: number }[])
          .map((w) => `${w.country}|${w.state ?? ''}|${w.year}|${w.loaded}|${w.required}`)
          .join(';'),
      )}`
    : '';
  redirect(`/payroll/${batchId}?from=process${hw}`);
}

/**
 * Payroll Process wizard — RESUME a draft batch, and now RUN it. Called from Step 3's terminal button in
 * resume mode: it re-sets the existing draft's employee-selection scope (never re-creates the batch), then
 * calculates the run and lands on the SAME result page a fresh multi-company run lands on. The scope is
 * only posted when the admin actually narrowed the set (any filter use or manual deselect — the client
 * posts employmentIds only then, mirroring createRunAction's touched rule); an untouched selection leaves
 * the whole-company default. The cross-company intersection + orphan cleanup live in updateBatchScope.
 *
 * 7076f8af — THE RESUME PATH IS TERMINAL NOW. It used to end by handing the operator back to
 * `/payroll/<id>?from=process`, the long run screen, which is why repointing Reset alone would not have
 * satisfied the reporter: reset would have sent them into the flow and the flow would have delivered them
 * straight back out to the screen they were trying to leave. A resumed run therefore reports its outcome
 * the way every other run does — succeeded / failed, with a reason.
 *
 * The single-company outcome is wrapped in the EXISTING `RunGroupResult` shape rather than a second result
 * format, so `/payroll/process/result` renders it with no change of its own: one row, the same counts, the
 * same friendly reason vocabulary. `summarize` derives the header figures, so this cannot disagree with the
 * multi-company run about what "partial" or "failed" means.
 *
 * The try/catch around the generation is deliberate and mirrors runMultiCompanyPayroll's HAZARD 2: a
 * generation that throws (most often PreProcessBlockedError — somebody in scope has no salary record) must
 * render as a REASON ROW on the result page, not as a thrown error page. Note redirect() signals by
 * THROWING, so every redirect here is placed outside the try that could swallow it.
 */
export async function resumeRunAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const touched = String(formData.get('filtersTouched')) === 'true';
  const submittedEmploymentIds = formData.getAll('employmentIds').map(String).filter(Boolean);
  const scope = touched && submittedEmploymentIds.length ? { employmentIds: submittedEmploymentIds } : undefined;
  try {
    // Only re-set scope when the admin actually touched the selection; an untouched resume leaves the
    // existing scope as-is (no needless write, no spurious removal cleanup).
    if (touched) {
      await updateBatchScope(s, { batchId, scope });
    }
  } catch (e) {
    redirect(`/payroll/process?resume=${batchId}&error=${encodeURIComponent((e as Error).message)}`);
  }

  // Re-read the batch AFTER the scope write: the persisted scope is the authority on who this run covers
  // (updateBatchScope intersects out cross-company ids and normalises an empty selection back to
  // whole-company), so the "selected" count on the result page is the run's own figure, never the client's.
  const data = await batchDetail(s, batchId);
  if (!data) {
    redirect(`/payroll/process?error=${encodeURIComponent('That payroll run is no longer available.')}`);
  }
  const batch = data.batch;
  const persistedScope = (batch.scope ?? null) as { employmentIds?: string[] } | null;
  const companyName =
    (await allowedCompanies(s)).find((c) => c.id === batch.companyId)?.name ?? batch.companyId;
  const employeesSelected = persistedScope?.employmentIds?.length
    ? persistedScope.employmentIds.length
    : (await listEmployees(s, [batch.companyId])).length;

  const startedAt = new Date().toISOString();
  let outcome: CompanyOutcome;
  try {
    const gen = await generatePayslips(s, { batchId });
    // Full draft→processed generation (never the reprocessSubset path), so `payslips` is present; the
    // fallback satisfies the union return type, exactly as in runMultiCompanyPayroll.
    const payslips = 'payslips' in gen && typeof gen.payslips === 'number' ? gen.payslips : 0;
    // r226 — the additional-run skip, carried onto the result payload exactly as the multi-company
    // orchestrator does. Same guard, same shape: the single-company path is the SAME result screen and
    // must not be the one that loses the account of who was left out. r227 carries the COUNT only — the
    // names are read back from this batch's own `payroll-batch.processed` event by the result page, so
    // the redirect stays O(companies) whatever the headcount (see CompanyOutcome.employeesSkipped).
    const skipped = 'skipped' in gen && Array.isArray(gen.skipped) ? gen.skipped : [];
    outcome = {
      companyId: batch.companyId,
      companyName,
      status: 'succeeded',
      batchId,
      employeesSelected,
      employeesSucceeded: payslips,
      ...(skipped.length > 0 ? { employeesSkipped: skipped.length } : {}),
    };
  } catch (e) {
    outcome = {
      companyId: batch.companyId,
      companyName,
      status: 'failed',
      batchId,
      employeesSelected,
      employeesSucceeded: 0,
      reason: reasonForError((e as Error).message),
    };
  }
  const result = summarize(batch.payPeriod, startedAt, new Date().toISOString(), [outcome]);

  revalidatePath('/payroll');
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/process/result?r=${encodeRunGroupResult(result)}`);
}

/**
 * Payroll Process wizard — MULTI-COMPANY run (feedback 3653d14b, Phase 1). Called from Step 2's confirm
 * button when the admin selected one, several, or ALL companies in Step 1. Composes the existing per-company
 * primitives via `runMultiCompanyPayroll` (NO kernel change) and lands on the new Step-3 result page.
 *
 * "All my companies" is resolved to the admin's ACTIVE company-context scope here (scopedAdmin → scopeIds:
 * allowedCompanies ∩ the company_scope cookie) — matching the UI's scoped list and never wider — and every
 * explicit id is re-intersected against allowedCompanies inside the orchestrator (hazard 1). The per-company
 * failure handling (hazard 2 — one company failing never aborts the run) lives there too.
 */
export async function runMultiCompanyAction(formData: FormData) {
  // scopedAdmin() redirects non-admins and returns the session + the active company scope (the same set the
  // page's multi-select is bounded to). Using it here keeps "all" consistent between the UI and the run.
  const { s, scopeIds } = await scopedAdmin();
  const payPeriod = String(formData.get('payPeriod'));
  const payrollCycleId = String(formData.get('payrollCycleId') || '');
  const paymentDate = String(formData.get('paymentDate') || '');
  const selectAll = String(formData.get('selectAll')) === 'true';
  const submittedCompanyIds = formData.getAll('companyIds').map(String).filter(Boolean);
  const employmentIds = formData.getAll('employmentIds').map(String).filter(Boolean);

  if (!/^\d{4}-\d{2}$/.test(payPeriod)) {
    redirect(`/payroll/process?error=${encodeURIComponent('Select a valid payroll month.')}`);
  }

  // "All my companies" resolves to the admin's ACTIVE scope server-side (the client list is only a hint); an
  // explicit selection is re-intersected against allowedCompanies inside the orchestrator, so both paths are
  // bounded to what this administrator may run.
  const companyIds = selectAll ? scopeIds : submittedCompanyIds;
  if (companyIds.length === 0) {
    redirect(`/payroll/process?error=${encodeURIComponent('Select at least one company to process.')}`);
  }

  let encoded: string;
  try {
    const result = await runMultiCompanyPayroll(s, {
      companyIds,
      payPeriod,
      payrollCycleId,
      paymentDate,
      employmentIds,
    });
    encoded = encodeRunGroupResult(result);
  } catch (e) {
    // A whole-run failure (e.g. an invalid session) is rare — per-company failures are caught inside the
    // orchestrator and reported as rows. Surface anything that escapes as a Step-1 error banner.
    redirect(`/payroll/process?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll');
  redirect(`/payroll/process/result?r=${encoded}`);
}
