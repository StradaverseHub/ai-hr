'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setPayrollDeductionInput } from '@/core/payroll';
import { employmentSubject } from '@/core/read';
import { saveTp1DraftForPerson, submitTp1ForPerson } from '@/core/tax-relief';
import { TP1_CATEGORY_KEYS } from '@/db/schema';

/**
 * TP1 Relief transaction screen (approved plan, ADR-0050 §0.4). The dedicated screen edits ONE deduction
 * field per employee and delegates to the existing read-modify-write setPayrollDeductionInput so siblings
 * (overtime/bonus/zakat) survive and the same payroll-batch.input-set event is appended.
 *
 * COPY TRAP avoided: a single-field screen must NOT coalesce every deduction to Number(...)||0 (that would
 * silently zero the sibling). saveTp1Action passes ONLY tp1Deduction via num() (undefined for empty/NaN),
 * leaving zakat undefined so the wrapper preserves it.
 *
 * NOTE (feedback d435673e): the sibling zakat write-screen action (saveZakatAction) was REMOVED when the
 * Zakat screen dropped its one-off per-batch override section — the Zakat screen no longer writes
 * payroll_input.zakat. The manual zakat tier survives only on the batch input grid / prefill / import.
 */

const num = (v: FormDataEntryValue | null): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

const backTo = (path: string, batchId: string, qs: string) =>
  redirect(`${path}?batchId=${encodeURIComponent(batchId)}&${qs}`);

/** Set ONLY TP1 relief for one employee on a draft batch — leaves zakat (and every earning) untouched. */
export async function saveTp1Action(formData: FormData) {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId'));
  const employmentId = String(formData.get('employmentId'));
  try {
    await setPayrollDeductionInput(s, {
      batchId,
      employmentId,
      // ONLY tp1Deduction — leave zakat undefined so the wrapper preserves it. num() returns undefined for
      // empty/NaN (NOT Number(...)||0 — that is the copy trap that would zero the field).
      tp1Deduction: num(formData.get('tp1Deduction')),
    });
  } catch (e) {
    backTo('/payroll/transactions/tp1', batchId, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backTo('/payroll/transactions/tp1', batchId, 'toast=saved');
}

// ── HR admin-on-behalf TP1 declaration (Standardize-TP1, item 0cde61f3) ──
//
// These write the employee's SINGLE tp1_relief master row — the SAME record the employee edits on
// /me/tax-relief — so there is exactly one declaration per employee per assessment year (no duplicate
// store). They mirror mySaveTp1Draft / mySubmitTp1 (app/me/actions.ts) field-for-field: the per-category
// `cat_<key>` inputs + `remarks` + `assessmentYear`, with the server recomputing the authoritative total
// (the client's total is never trusted). The target personId is resolved SERVER-SIDE from the selected
// employment via employmentSubject (RLS-scoped) — never a raw personId form field — and the write is
// admin-gated in core (requireAdminTarget) with the tp1_relief RLS as the DB backstop.

/** Read the structured per-category breakdown from the HR form (identical shape to the ESS reader). */
function readAdminTp1Input(formData: FormData): { assessmentYear: number; categories: Record<string, unknown> } {
  const assessmentYear = Number(formData.get('assessmentYear'));
  const categories: Record<string, unknown> = {};
  for (const k of TP1_CATEGORY_KEYS) categories[k] = Number(formData.get(`cat_${k}`) ?? 0);
  const remarks = formData.get('remarks');
  if (remarks != null) categories.remarks = String(remarks);
  return { assessmentYear, categories };
}

/** Resolve the selected employment → trusted personId (RLS-scoped), or redirect with an error. */
async function resolveTarget(
  s: Parameters<typeof employmentSubject>[0],
  employmentId: string,
  assessmentYear: number,
): Promise<string> {
  const subject = await employmentSubject(s, employmentId);
  if (!subject) {
    backToTp1(employmentId, assessmentYear, 'error=Employee+not+found');
  }
  return subject!.personId;
}

const backToTp1 = (employmentId: string, year: number, qs: string): never =>
  redirect(`/payroll/transactions/tp1?employmentId=${encodeURIComponent(employmentId)}&year=${year}&${qs}`) as never;

export async function adminSaveTp1Draft(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const { assessmentYear, categories } = readAdminTp1Input(formData);
  const personId = await resolveTarget(s, employmentId, assessmentYear);
  try {
    await saveTp1DraftForPerson(s, { personId, assessmentYear, categories });
  } catch (e) {
    backToTp1(employmentId, assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, assessmentYear, 'toast=Draft+saved');
}

export async function adminSubmitTp1(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const { assessmentYear, categories } = readAdminTp1Input(formData);
  const personId = await resolveTarget(s, employmentId, assessmentYear);
  try {
    await submitTp1ForPerson(s, { personId, assessmentYear, categories });
  } catch (e) {
    backToTp1(employmentId, assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, assessmentYear, 'toast=TP1+submitted');
}
