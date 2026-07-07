'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  BatchNotDraftError,
  closeBatch,
  deleteDraftBatch,
  generatePayslips,
  prefillFixedZakat,
  prefillOvertimeFromAttendance,
  prefillShiftDifferentialFromRoster,
  prefillTp1FromSelfRelief,
  setPayrollInput,
} from '@/core/payroll';
import { prefillClaimsForBatch } from '@/core/claims';
import { prefillLoansForBatch } from '@/core/loans';
import { transferAllowancesToBatch } from '@/core/attendance-allowance';

// Note: run creation (regular + additional) moved to app/payroll/process/actions.ts (createRunAction) as
// part of the Payroll Process wizard — creation is now the wizard's TERMINAL action. createBatch /
// createAdditionalRun remain in core/payroll.ts unchanged; this file keeps only the draft-batch actions
// (prefill/generate/close) that operate on an existing batch id.

export async function generateAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  try {
    await generatePayslips(s, { batchId });
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}?toast=Payslips generated`);
}

export async function setPayrollInputAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  try {
    // Fix-5 (#4/#28): OT is keyed as four MANUAL RM amounts the admin computes against the s.60/60D
    // structure (normal-day / rest-day / public-holiday OT + a flat bucket) — these are NOT rates the
    // system applies. The four amounts sum into overtimeAmount (the single scalar every downstream reader
    // uses) and the split is persisted as ot_breakdown so the four inputs can be re-prefilled on reload.
    const otFlat = Math.max(0, Number(formData.get('otFlat')) || 0);
    const otNormal = Math.max(0, Number(formData.get('otNormal')) || 0);
    const otRest = Math.max(0, Number(formData.get('otRest')) || 0);
    const otHoliday = Math.max(0, Number(formData.get('otHoliday')) || 0);
    await setPayrollInput(s, {
      batchId,
      employmentId: String(formData.get('employmentId')),
      overtimeAmount: otFlat + otNormal + otRest + otHoliday,
      otBreakdown: { flat: otFlat, normal: otNormal, rest: otRest, holiday: otHoliday },
      // Fix-5 (M#17): this form is the admin's manual OT entry — stamp provenance so a later attendance
      // prefill (and the editor's clobber warning) can tell the figure was hand-keyed.
      otSource: 'manual',
      bonusAmount: Number(formData.get('bonusAmount')) || 0,
      tp1Deduction: Number(formData.get('tp1Deduction')) || 0,
      zakat: Number(formData.get('zakat')) || 0,
    });
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}?toast=Saved`);
}

export async function prefillOvertimeAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  let applied = 0;
  let ineligible = 0;
  try {
    ({ applied, ineligible } = await prefillOvertimeFromAttendance(s, { batchId }));
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    applied === 0
      ? 'No overtime found in attendance for this period'
      : `OT prefilled for ${applied} employee${applied === 1 ? '' : 's'}${
          ineligible ? ` (${ineligible} above RM4,000 — not statutorily entitled)` : ''
        }`;
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

export async function prefillShiftDifferentialAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  let applied = 0;
  let gated = false;
  try {
    const r = await prefillShiftDifferentialFromRoster(s, { batchId });
    applied = r.applied;
    gated = 'gated' in r && r.gated === true;
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note = gated
    ? 'Typed pay components are off — shift differential not applied'
    : applied === 0
      ? 'No shift differentials found for this period'
      : `Shift differential prefilled for ${applied} employee${applied === 1 ? '' : 's'}`;
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

export async function prefillClaimsAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  let applied = 0;
  let claims = 0;
  let total = 0;
  try {
    ({ applied, claims, total } = await prefillClaimsForBatch(s, { batchId }));
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    claims === 0
      ? 'No approved taxable claims awaiting payout'
      : `Queued ${claims} claim${claims === 1 ? '' : 's'} (RM ${total.toLocaleString('en-MY', {
          minimumFractionDigits: 2,
        })}) onto ${applied} payslip${applied === 1 ? '' : 's'}`;
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

// 1.2.8 Loan deductions (ADR-0060) — RESERVE the next instalment of each active loan onto a REGULAR DRAFT
// batch. The ledger is advanced at generation, not here. Actor passed through via the session.
export async function prefillLoansAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  let loans = 0;
  let total = 0;
  try {
    ({ loans, total } = await prefillLoansForBatch(s, { batchId }));
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    loans === 0
      ? 'No active loans to deduct this cycle'
      : `Reserved ${loans} loan instalment${loans === 1 ? '' : 's'} (RM ${total.toLocaleString('en-MY', {
          minimumFractionDigits: 2,
        })})`;
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

export async function prefillTp1Action(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  let applied = 0;
  let skipped = 0;
  try {
    ({ applied, skipped } = await prefillTp1FromSelfRelief(s, { batchId }));
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    applied === 0
      ? 'No submitted TP1 self-relief found for this period'
      : `TP1 self-relief fed onto ${applied} payslip${applied === 1 ? '' : 's'}${
          skipped ? ` (${skipped} left as a manual override)` : ''
        }`;
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

// 1.2.4 Zakat — prefill the FIXED-zakat amount onto in-scope employees' batch rows (visibility/edit
// convenience; the kernel already auto-applies it at generate time). Actor passed through.
export async function prefillFixedZakatAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  let applied = 0;
  try {
    ({ applied } = await prefillFixedZakat(s, { batchId }));
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    applied === 0
      ? 'No active fixed-zakat elections for this batch'
      : `Fixed zakat prefilled for ${applied} employee${applied === 1 ? '' : 's'}`;
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

// Attendance Allowance (ADR-0072) — transfer a Monthly policy's qualified allowances onto this draft
// batch. Gated by TYPED_PAY_COMPONENTS_ENABLED (off ⇒ no-op with a clear banner). Re-derives qualification
// live at transfer time and reverses rows for employees who no longer qualify. Actor passed via session.
export async function transferAllowancesAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const policyId = String(formData.get('policyId') ?? '');
  if (!policyId) redirect(`/payroll/${batchId}?error=${encodeURIComponent('Select an attendance-allowance policy first')}`);
  let applied = 0;
  let ineligible = 0;
  let reversed = 0;
  let gated = false;
  try {
    ({ applied, ineligible, reversed, gated } = await transferAllowancesToBatch(s, { batchId, policyId }));
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note = gated
    ? "Transfer recorded 0 rows — the typed pay-components feature is off, so this won't reach payslips yet"
    : `Attendance allowance transferred to ${applied} employee${applied === 1 ? '' : 's'}` +
      (ineligible ? ` (${ineligible} did not qualify)` : '') +
      (reversed ? `; removed ${reversed} previously-transferred row${reversed === 1 ? '' : 's'} that no longer qualify` : '');
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

/**
 * Payroll Process listing (feedback 4f00d8f0) — delete a DRAFT batch after the ConfirmSubmit dialog.
 * Draft-only enforcement, RLS scoping, cascade teardown and DomainEvents live in deleteDraftBatch (the
 * service); the session carries the real actor into actorOf(ctx). ToastFromQuery renders the raw query
 * string, so the toast/error text is localised HERE (same convention as admin/payroll-cycle/actions.ts).
 */
export async function deleteDraftBatchAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const t = await getTranslations('payroll.list');
  try {
    await deleteDraftBatch(s, { batchId });
  } catch (e) {
    // BatchNotDraftError's raw message is generation-phrased — map it to the delete-specific copy.
    const msg = e instanceof BatchNotDraftError ? t('deleteDraftNotDraft') : (e as Error).message;
    redirect(`/payroll?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath('/payroll');
  redirect(`/payroll?toast=${encodeURIComponent(t('toastDeleted'))}`);
}

export async function closeAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  try {
    await closeBatch(s, { batchId });
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}?toast=Batch closed`);
}
