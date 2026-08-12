'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import {
  generatePayslips,
  getStatutoryAdjustmentDetail,
  parseAdjustmentAmount,
  previewStatutoryAdjustment,
  revertStatutoryAdjustment,
  saveStatutoryAdjustment,
  StatutoryAdjustmentAmountInvalidError,
  StatutoryAdjustmentBatchNotOpenError,
  StatutoryAdjustmentNotFoundError,
  StatutoryAdjustmentReasonRequiredError,
  STATUTORY_ADJUSTMENT_LINES,
  type StatutoryAdjustmentValues,
} from '@/packs/payroll/service';

const PAGE = '/payroll/statutory-adjustment';

/**
 * 2961a7ae — Statutory Adjustment actions.
 *
 * NOTE — redirect() signals by THROWING (NEXT_REDIRECT). Every redirect here therefore sits OUTSIDE the
 * try/catch, or the sentinel is caught and rendered as an error message. Same discipline as
 * app/admin/pay-components/actions.ts, which carried exactly that bug.
 */

/** Map a service rejection to the stable error code the page turns into a localised message. */
function codeOf(e: unknown): string {
  if (e instanceof StatutoryAdjustmentBatchNotOpenError) return 'batchNotOpen';
  if (e instanceof StatutoryAdjustmentReasonRequiredError) return 'reasonRequired';
  if (e instanceof StatutoryAdjustmentAmountInvalidError) return 'amountInvalid';
  if (e instanceof StatutoryAdjustmentNotFoundError) return 'notFound';
  return 'unknown';
}

/** Read the nine amount boxes off the form. '' ⇒ null (no override); '0' ⇒ 0 (override to zero). */
function valuesOf(fd: FormData): StatutoryAdjustmentValues {
  const out: StatutoryAdjustmentValues = {};
  for (const line of STATUTORY_ADJUSTMENT_LINES) {
    out[line] = parseAdjustmentAmount(fd.get(line) as string | null, line);
  }
  return out;
}

/**
 * The Review step. Returns the before/after the operator confirms against — computed by the SAME pure
 * function the engine test pins to a regenerated payslip, so the review cannot promise a figure that
 * Apply does not produce.
 */
export async function previewAdjustmentAction(p: {
  batchId: string;
  employmentId: string;
  values: Record<string, string>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const detail = await getStatutoryAdjustmentDetail(s, { batchId: p.batchId, employmentId: p.employmentId });
  // Fail-closed on scope: not-found and not-yours are ONE answer, so the action cannot be used to probe
  // which batch ids exist in a company this session cannot administer.
  if (!detail || !scopeIds.includes(detail.companyId)) return { ok: false as const, code: 'notFound' };
  let values: StatutoryAdjustmentValues;
  try {
    values = {};
    for (const line of STATUTORY_ADJUSTMENT_LINES) {
      values[line] = parseAdjustmentAmount(p.values[line], line);
    }
  } catch (e) {
    return { ok: false as const, code: codeOf(e) };
  }
  return {
    ok: true as const,
    preview: previewStatutoryAdjustment({
      statutory: detail.system as unknown as Record<string, unknown>,
      grossPay: detail.grossPay,
      totalDeductions: detail.totalDeductions,
      netPay: detail.netPay,
      employerCost: detail.employerCost,
      values,
      employerBears: detail.employerBears,
    }),
  };
}

/**
 * Confirm & Apply: save the override, then RECALCULATE this employee's result in place so the figures on
 * screen are the adjusted ones straight away (the reporter's step 5). The save has already marked the run
 * and named the employee, so if the recalculation is not reached the run still says "needs reprocessing"
 * rather than sitting on figures that silently disagree with their inputs.
 */
export async function saveAdjustmentAction(formData: FormData) {
  const { s, scopeIds } = await scopedAdmin();
  const batchId = String(formData.get('batchId') ?? '');
  const employmentId = String(formData.get('employmentId') ?? '');
  const back = `${PAGE}?batch=${encodeURIComponent(batchId)}&employment=${encodeURIComponent(employmentId)}`;
  let failure: string | null = null;
  try {
    const detail = await getStatutoryAdjustmentDetail(s, { batchId, employmentId });
    if (!detail || !scopeIds.includes(detail.companyId)) throw new StatutoryAdjustmentNotFoundError();
    await saveStatutoryAdjustment(s, {
      batchId,
      employmentId,
      values: valuesOf(formData),
      reason: String(formData.get('reason') ?? ''),
    });
    await generatePayslips(s, { batchId, reprocessSubset: { employmentIds: [employmentId], reason: 'statutory-adjustment' } });
    revalidatePath(PAGE);
  } catch (e) {
    failure = codeOf(e);
  }
  if (failure) redirect(`${back}&err=${failure}`);
  redirect(`${back}&ok=applied`);
}

/** Revert: remove the override, then recalculate so the computed figures are back on the payslip. */
export async function revertAdjustmentAction(formData: FormData) {
  const { s, scopeIds } = await scopedAdmin();
  const batchId = String(formData.get('batchId') ?? '');
  const employmentId = String(formData.get('employmentId') ?? '');
  const back = `${PAGE}?batch=${encodeURIComponent(batchId)}&employment=${encodeURIComponent(employmentId)}`;
  let failure: string | null = null;
  try {
    const detail = await getStatutoryAdjustmentDetail(s, { batchId, employmentId });
    if (!detail || !scopeIds.includes(detail.companyId)) throw new StatutoryAdjustmentNotFoundError();
    await revertStatutoryAdjustment(s, { batchId, employmentId });
    await generatePayslips(s, { batchId, reprocessSubset: { employmentIds: [employmentId], reason: 'statutory-adjustment-revert' } });
    revalidatePath(PAGE);
  } catch (e) {
    failure = codeOf(e);
  }
  if (failure) redirect(`${back}&err=${failure}`);
  redirect(`${back}&ok=reverted`);
}
