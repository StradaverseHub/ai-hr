'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { createAdditionalRun, createBatch, updateBatchScope } from '@/core/payroll';
import { listEmployees, listEmployeesForPayrollRun, type PayrollRunEmployeeRow } from '@/core/read';

/** Step 2 population (plan §2) — fetched by the client once company + period are chosen. */
export async function fetchPayrollRunEmployees(companyId: string, payPeriod: string): Promise<PayrollRunEmployeeRow[]> {
  const s = await getSession();
  if (!companyId || !/^\d{4}-\d{2}$/.test(payPeriod)) return [];
  return listEmployeesForPayrollRun(s, companyId, payPeriod);
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
  const cycle = String(formData.get('cycle') || 'regular');
  const paymentDate = String(formData.get('paymentDate') || '');
  const submittedEmploymentIds = formData.getAll('employmentIds').map(String).filter(Boolean);

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
    if (cycle === 'regular') {
      const r = await createBatch(s, { companyId, payPeriod, scope, paymentDate: paymentDate || undefined });
      batchId = r.batchId;
      holidayWarnings = r.holidayWarnings ?? [];
    } else {
      // Advance Salary / Mid-Month ship as labelled off_cycle presets (plan §Deferred); Bonus/Adjustment/
      // Off-cycle map straight through. Cycle codes 'advance' and 'midmonth' carry a remarks label.
      const runType = cycle === 'advance' || cycle === 'midmonth' ? 'off_cycle' : (cycle as 'off_cycle' | 'bonus' | 'adjustment');
      const remarks = cycle === 'advance' ? 'Advance Salary' : cycle === 'midmonth' ? 'Mid-Month' : undefined;
      const r = await createAdditionalRun(s, { companyId, payPeriod, runType, remarks, scope, paymentDate: paymentDate || undefined });
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
 * Payroll Process wizard — RESUME a draft batch. Called from Step 2's confirm button in resume mode: it
 * re-sets the existing draft's employee-selection scope (never re-creates the batch) then hands off to the
 * SAME Transaction Key-In screen (?from=process) a fresh run reaches. The scope is only posted when the
 * admin actually narrowed the set (any filter use or manual deselect — the client posts employmentIds only
 * then, mirroring createRunAction's touched rule); an untouched selection leaves the whole-company default.
 * The cross-company intersection + orphan cleanup live in updateBatchScope (the service).
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
  revalidatePath('/payroll');
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}?from=process`);
}
