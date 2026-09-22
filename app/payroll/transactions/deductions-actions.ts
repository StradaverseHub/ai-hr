'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setPayrollDeductionInput } from '@/core/payroll';
import { employmentSubject } from '@/core/read';
import {
  approveTp1ForPerson,
  cancelTp1ForPerson,
  discardTp1DraftForPerson,
  rejectTp1ForPerson,
  saveTp1DraftForPerson,
  submitTp1ForPerson,
} from '@/core/tax-relief';
import { readTp1FormInput } from '@/lib/tp1-form-input';

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
  // ONE reader, shared with mySaveTp1Draft / mySubmitTp1 (lib/tp1-form-input.ts). See its header for why
  // two copies of seventeen items' field names is not a plan.
  const input = readTp1FormInput(formData);
  const personId = await resolveTarget(s, employmentId, input.assessmentYear);
  try {
    await saveTp1DraftForPerson(s, { personId, ...input });
  } catch (e) {
    backToTp1(employmentId, input.assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, input.assessmentYear, 'toast=Draft+saved');
}

export async function adminSubmitTp1(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const input = readTp1FormInput(formData);
  const personId = await resolveTarget(s, employmentId, input.assessmentYear);
  try {
    await submitTp1ForPerson(s, { personId, ...input });
  } catch (e) {
    backToTp1(employmentId, input.assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, input.assessmentYear, 'toast=TP1+submitted');
}

// ── Section F — employer consent (7ad37961) ────────────────────────────────────────────────────────
// Admin-only by construction: `requireAdmin()` here, `requireAdminTarget` in core, and the tp1_relief
// RLS policy underneath both. The declaration id arrives as a form field and is resolved AGAINST the
// trusted personId in core, so an id belonging to another person is simply not found.

/** The decision fields the consent form carries, plus the resolved target. */
async function readTp1Decision(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const id = String(formData.get('tp1ReliefId') ?? '');
  const assessmentYear = Number(formData.get('assessmentYear'));
  const personId = await resolveTarget(s, employmentId, assessmentYear);
  return {
    s,
    employmentId,
    assessmentYear,
    input: {
      personId,
      id,
      approvedMonth: formData.get('approvedMonth') as string | null,
      approvedYear: formData.get('approvedYear') as string | null,
      approverPosition: formData.get('approverPosition') as string | null,
    },
  };
}

export async function adminApproveTp1(formData: FormData) {
  const { s, employmentId, assessmentYear, input } = await readTp1Decision(formData);
  try {
    await approveTp1ForPerson(s, input);
  } catch (e) {
    backToTp1(employmentId, assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, assessmentYear, 'toast=TP1+approved');
}

export async function adminRejectTp1(formData: FormData) {
  const { s, employmentId, assessmentYear, input } = await readTp1Decision(formData);
  try {
    await rejectTp1ForPerson(s, input);
  } catch (e) {
    backToTp1(employmentId, assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, assessmentYear, 'toast=TP1+rejected');
}

/**
 * 27605faa — SUBMIT AND APPROVE IN ONE PRESS.
 *
 * The reporter asked not to reopen a second screen to approve what they had just keyed. What they should
 * not have to do is make a second pass; what nobody skips is the record.
 *
 * ⚠️ IT COMPOSES THE SAME TWO SERVICES, IN ORDER, AND WRITES NO STATUS ITSELF. `submitTp1ForPerson` then
 * `approveTp1ForPerson` — never a direct update — for the reason dae7a10f (r322) records about the
 * attendance correction: `decide()` is what stamps the event, the approver and the approved month, and a
 * second write path is how a money-affecting figure changes with no trail.
 *
 * ⚠️ AND WHEN THE APPROVAL IS REFUSED, THE SUBMISSION SURVIVES. An administrator approving their own
 * declaration is refused by `approveTp1ForPerson` (see `refuseSelfApproval`), and at that point the row
 * is already SUBMITTED. That is the correct outcome rather than an error to roll back: the work is not
 * lost, it simply needs a second person — exactly what the two-step screen would have produced. The
 * refusal is surfaced; it is never swallowed, because an administrator quietly approving their own tax
 * relief is the one thing this press must not be able to do.
 */
export async function adminSubmitAndApproveTp1(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const input = readTp1FormInput(formData);
  const personId = await resolveTarget(s, employmentId, input.assessmentYear);

  let submitted: { id: string };
  try {
    submitted = await submitTp1ForPerson(s, { personId, ...input });
  } catch (e) {
    backToTp1(employmentId, input.assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }

  try {
    await approveTp1ForPerson(s, {
      personId,
      id: submitted!.id,
      // The consent fields ride the same form; absent ones fall back inside the service to the
      // declaration's own deduction month and assessment year rather than being invented here.
      approvedMonth: formData.get('approvedMonth') as string | null,
      approvedYear: formData.get('approvedYear') as string | null,
      approverPosition: formData.get('approverPosition') as string | null,
    });
  } catch (e) {
    // SUBMITTED, NOT APPROVED — and the message says which, so the operator knows the work is safe.
    revalidatePath('/payroll/transactions/tp1');
    backToTp1(employmentId, input.assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }

  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, input.assessmentYear, 'toast=TP1+submitted+and+approved');
}

/**
 * 27605faa rev 2 — DELETE A TP1 RECORD FROM THE TRANSACTION HISTORY, whatever state it is in.
 *
 * ONE ACTION ON THE SCREEN, TWO SERVICES BEHIND IT, CHOSEN BY STATUS — and that is deliberate rather
 * than a convenience. `discardTp1DraftForPerson` accepts only a draft; `cancelTp1ForPerson` accepts only
 * a submitted or approved row. Each refusal is the audit meaning of that state, so widening either
 * service to cover both would erase a distinction the records rely on: nobody was ever told about a
 * draft, whereas a cancelled declaration was declared and then withdrawn. The SCREEN does not need that
 * distinction, so it routes; the services keep it.
 *
 * ⚠️ STILL NOT A ROW DELETE, and the reporter was told so in plain words before approving. tp1_relief is
 * a tax record: it is what somebody's PCB was reduced by, and if LHDN asks why a month's tax was lower
 * the answer has to still exist. "Delete" here means status 'cancelled' — which `tp1CountableWhere`
 * already excludes from every figure (it requires 'approved'), so the row stops feeding payroll the
 * moment it is written, with no second exclusion to keep in step.
 *
 * A REJECTED row is refused by both services, which is correct: rejection is already an ending, and the
 * screen does not offer Delete on one.
 */
export async function adminDeleteTp1(formData: FormData) {
  const { s, employmentId, assessmentYear, input } = await readTp1Decision(formData);
  const status = String(formData.get('status') ?? '');
  try {
    if (status === 'draft') await discardTp1DraftForPerson(s, input);
    else await cancelTp1ForPerson(s, input);
  } catch (e) {
    backToTp1(employmentId, assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, assessmentYear, 'toast=TP1+record+deleted');
}

/** 27605faa — discard a DRAFT. Distinct from cancel, which is for a submitted or approved row. */
export async function adminDiscardTp1Draft(formData: FormData) {
  const { s, employmentId, assessmentYear, input } = await readTp1Decision(formData);
  try {
    await discardTp1DraftForPerson(s, input);
  } catch (e) {
    backToTp1(employmentId, assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, assessmentYear, 'toast=Draft+discarded');
}

export async function adminCancelTp1(formData: FormData) {
  const { s, employmentId, assessmentYear, input } = await readTp1Decision(formData);
  try {
    await cancelTp1ForPerson(s, input);
  } catch (e) {
    backToTp1(employmentId, assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backToTp1(employmentId, assessmentYear, 'toast=TP1+cancelled');
}
