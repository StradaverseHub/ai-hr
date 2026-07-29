'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  BatchNotDraftError,
  BatchNotResettableError,
  BatchNotUnlockableError,
  PayrollPermissionDeniedError,
  PreProcessBlockedError,
  ResetReasonRequiredError,
  UnlockReasonRequiredError,
  closeBatch,
  deleteDraftBatch,
  generatePayslips,
  preProcessAdvisory,
  prefillFixedZakat,
  prefillOvertimeFromAttendance,
  prefillShiftDifferentialFromRoster,
  prefillTp1FromSelfRelief,
  reprocessSelectedEmployees,
  resetProcessedBatch,
  setPayrollInput,
  unlockClosedBatch,
} from '@/core/payroll';
// ADR-0080 rung 3 (D9): the claims payout path rides the PayrollInputContributor kernel contract
// instead of a direct core/claims import. The side-effect import evaluates the claims pack's
// contributor wiring (static registration at module load — the D8 convention), so the by-id
// resolution in prefillClaimsAction is guaranteed to succeed.
import '@/packs/claims/payroll';
import { payrollInputContributorById } from '@/packs/contracts';
import { prefillLoansForBatch } from '@/core/loans';
import { transferAllowancesToBatch } from '@/core/attendance-allowance';

// Note: run creation (regular + additional) moved to app/payroll/process/actions.ts (createRunAction) as
// part of the Payroll Process wizard — creation is now the wizard's TERMINAL action. createBatch /
// createAdditionalRun remain in core/payroll.ts unchanged; this file keeps only the draft-batch actions
// (prefill/generate/close) that operate on an existing batch id.

/**
 * Generate (process) a draft run — now behind the pre-processing gate (feedback f1564110, Phase 1):
 * validation runs BEFORE calculation, matching the reporter's "maintain → validate → process" workflow.
 * Blockers (employees with no current salary record — previously silently dropped from the run) always
 * stop generation; the kernel re-asserts this server-side (PreProcessBlockedError), so the gate holds
 * even if this action is bypassed. Warning-class gaps (missing statutory profile / bank details) require
 * the operator's explicit confirmation — the page's ConfirmSubmit dialog posts ackWarnings=1; a submit
 * without it is bounced back with an error so the confirm can never be skipped client-side.
 */
export async function generateAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const acknowledged = String(formData.get('ackWarnings') ?? '') === '1';
  const t = await getTranslations('payroll.batch');
  let errMsg: string | null = null;
  try {
    const checks = await preProcessAdvisory(s, batchId);
    // BLOCKER count: no compensation row covering the period OR a zero basic/rate (feedback 64fb5e48) —
    // both stop generation (server re-asserts via PreProcessBlockedError). The old BASIC-pay-item
    // existence blocker is gone: the Personnel Basic Salary record is the authoritative pay source.
    // A stale BASIC pay item (amount differing from Personnel) joins the confirm-to-proceed warnings.
    const blockers = checks.missingCompensation.length + (checks.zeroBasic?.length ?? 0);
    // 297ae65a — a non-MYR/mixed-currency salary joins the confirm-to-proceed warnings (never blocks).
    // r79 — so does an explicit "Subject to HRDF = Yes" at a company with no HRD Corp registration band.
    // WARN, not REFUSE: the flag is legitimate forward setup, the levy is correctly zero either way, and
    // people still need paying — but generation now requires the operator's explicit acknowledgement,
    // so the contradiction can no longer ride through eight runs unseen.
    const warnings =
      checks.missingStatutory.length +
      checks.missingBank.length +
      (checks.staleBasicComponent?.length ?? 0) +
      (checks.currencyMismatch?.length ?? 0) +
      (checks.hrdfSubjectUnregistered?.length ?? 0);
    if (blockers > 0) {
      errMsg = t('preChecksBlockedError', { n: blockers });
    } else if (warnings > 0 && !acknowledged) {
      errMsg = t('preChecksConfirmRequired', { n: warnings });
    } else {
      await generatePayslips(s, { batchId });
    }
  } catch (e) {
    errMsg = e instanceof PreProcessBlockedError ? t('preChecksBlockedError', { n: e.count }) : (e as Error).message;
  }
  if (errMsg) redirect(`/payroll/${batchId}?error=${encodeURIComponent(errMsg)}`);
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
    // Registered by the static side-effect import above, so the non-null assertion cannot fire
    // (same reasoning as the sidebar's registry lookups). `sourceCount` is the contract's word for
    // what claims calls `claims` — the toast copy below is unchanged.
    ({ applied, sourceCount: claims, total } = await payrollInputContributorById('claims')!.contribute(s, { batchId }));
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
    // (deleteDraftBatch never calls redirect(), so no Next redirect-signal can surface here.)
    // BatchNotDraftError's raw message is generation-phrased — map it to the delete-specific copy. ANY
    // other failure (e.g. a DB/foreign-key error like the reported "Failed query: delete from
    // payroll_batch …" leak, feedback ec3873a6) must surface a friendly, localised message — NEVER the
    // raw query text. Log the technical detail server-side for troubleshooting.
    if (e instanceof BatchNotDraftError) {
      redirect(`/payroll?error=${encodeURIComponent(t('deleteDraftNotDraft'))}`);
    }
    console.error('[deleteDraftBatchAction] delete failed', { batchId, error: e });
    redirect(`/payroll?error=${encodeURIComponent(t('deleteDraftFailed'))}`);
  }
  revalidatePath('/payroll');
  redirect(`/payroll?toast=${encodeURIComponent(t('toastDeleted'))}`);
}

/**
 * Payroll Reset / Zeroization (feedback a03b2d9b) — revert a PROCESSED run to DRAFT after the
 * ConfirmSubmit dialog. Explicit RBAC here (not just the pages' admin gates) because server actions
 * are callable from any surface: reset is ADMIN-only — a payroll_partner passes the payroll pages
 * but must not reset. The service re-asserts the role, enforces processed-only (closed is
 * permanently immutable), reverses the loan/claim side-effects and appends the audited
 * payroll-batch.reset event with the session's real actor. Toast/error copy localised here
 * (ToastFromQuery renders the raw query string — same convention as deleteDraftBatchAction).
 */
export async function resetAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const reason = String(formData.get('reason') ?? '').trim();
  const t = await getTranslations('payroll.batch');
  try {
    await resetProcessedBatch(s, { batchId, reason: reason || undefined });
  } catch (e) {
    const msg =
      e instanceof PayrollPermissionDeniedError
        ? t('resetAdminOnly')
        : e instanceof ResetReasonRequiredError
          ? t('resetReasonRequired')
          : e instanceof BatchNotResettableError
            ? t('resetOnlyProcessed')
            : (e as Error).message;
    redirect(`/payroll/${batchId}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  revalidatePath('/payroll');
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(t('resetDone'))}`);
}

/**
 * Selective per-employee reprocessing (feedback 9bc442bc, reporter ask #3 + #8) — queue an idempotent
 * reprocess job that recomputes ONLY the ticked employees IN PLACE (version-bumped payslips, delta
 * totals), leaving everyone else physically untouched. Granular RBAC (payroll.reprocess.selective),
 * processed-only, membership intersection, the queue/idempotency guard and the delta recompute all live
 * in reprocessSelectedEmployees (the service); the session carries the real actor. Stays on the SAME
 * processed run (in-place), with an "N of M reprocessed" summary. Copy localised here.
 */
export async function reprocessSelectedAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const employmentIds = formData.getAll('employmentIds').map(String).filter(Boolean);
  const reason = String(formData.get('reason') ?? '').trim();
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const t = await getTranslations('payroll.batch');
  if (employmentIds.length === 0) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent(t('reprocessNoneSelected'))}`);
  }
  let reprocessed = employmentIds.length;
  let headcount = employmentIds.length;
  try {
    const r = await reprocessSelectedEmployees(s, {
      batchId,
      employmentIds,
      reason: reason || undefined,
      idempotencyKey: idempotencyKey || undefined,
    });
    if ('reprocessed' in r && typeof r.reprocessed === 'number') reprocessed = r.reprocessed;
    if ('headcount' in r && typeof r.headcount === 'number') headcount = r.headcount;
  } catch (e) {
    const msg =
      e instanceof PayrollPermissionDeniedError
        ? t('reprocessAdminOnly')
        : e instanceof BatchNotResettableError
          ? t('reprocessNotProcessed')
          : (e as Error).message;
    redirect(`/payroll/${batchId}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath('/payroll');
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(t('reprocessDone', { n: reprocessed, total: headcount }))}`);
}

/**
 * Unlock a CLOSED run back to Processed (feedback 9bc442bc, reporter ask #2; simplified in 62e85140).
 * The on-screen confirmation is now a single confirm dialog (no OTP), so this action only reads the
 * batch id + the mandatory reason. Warnings (payment disbursed / statutory filed) are computed + audited
 * in the service; the success toast surfaces them so the operator sees them immediately. All authority
 * (payroll.unlock, closed-only, escape-hatch flip, period reopen, audit) lives in unlockClosedBatch.
 */
export async function unlockAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const reason = String(formData.get('reason') ?? '').trim();
  const t = await getTranslations('payroll.batch');
  let warned = false;
  try {
    const r = await unlockClosedBatch(s, { batchId, reason: reason || undefined });
    warned = r.warnings.paymentDisbursed || r.warnings.statutoryFiled;
  } catch (e) {
    const msg =
      e instanceof PayrollPermissionDeniedError
        ? t('unlockPermissionDenied')
        : e instanceof UnlockReasonRequiredError
          ? t('unlockReasonRequired')
          : e instanceof BatchNotUnlockableError
            ? t('unlockNotClosed')
            : (e as Error).message;
    redirect(`/payroll/${batchId}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  revalidatePath('/payroll');
  const toast = warned ? t('unlockDoneWarned') : t('unlockDone');
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(toast)}`);
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
