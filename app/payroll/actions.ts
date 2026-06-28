'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  closeBatch,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  prefillFixedZakat,
  prefillOvertimeFromAttendance,
  prefillShiftDifferentialFromRoster,
  prefillTp1FromSelfRelief,
  setPayrollInput,
} from '@/core/payroll';
import { prefillClaimsForBatch } from '@/core/claims';
import { prefillLoansForBatch } from '@/core/loans';
import { listEmployees } from '@/core/read';

export async function createBatchAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const payPeriod = String(formData.get('payPeriod'));
  const departmentIds = formData.getAll('departmentIds').map(String).filter(Boolean);
  const submittedEmploymentIds = formData.getAll('employmentIds').map(String).filter(Boolean);

  // Guard against a silent under-set: generatePayslips drops any employmentId whose company !=
  // batch.companyId without erroring (a double-submit racing the company-change reset, or any
  // cross-company id, would otherwise yield a smaller run with no signal). Intersect the submitted
  // ids with the chosen company's employees so only valid ids reach createBatch.
  let employmentIds = submittedEmploymentIds;
  if (submittedEmploymentIds.length) {
    const companyEmps = await listEmployees(s, [companyId]);
    const valid = new Set(companyEmps.map((e) => e.employmentId));
    employmentIds = submittedEmploymentIds.filter((id) => valid.has(id));
  }

  let batchId = '';
  try {
    ({ batchId } = await createBatch(s, { companyId, payPeriod, scope: { departmentIds, employmentIds } }));
  } catch (e) {
    redirect(`/payroll?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll');
  redirect(`/payroll/${batchId}`);
}

/** Wave 2C (ADR-0024) — add an additional same-month run. Gated: createAdditionalRun throws unless
 *  MULTI_CYCLE_PAYROLL_ENABLED, and the gated form that posts here is only rendered under the same flag. */
export async function addRunAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const payPeriod = String(formData.get('payPeriod'));
  const runType = String(formData.get('runType')) as 'off_cycle' | 'bonus' | 'adjustment';
  let batchId = '';
  try {
    ({ batchId } = await createAdditionalRun(s, { companyId, payPeriod, runType }));
  } catch (e) {
    redirect(`/payroll?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll');
  redirect(`/payroll/${batchId}`);
}

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
