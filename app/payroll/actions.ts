'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  BatchHasBlockingAnomaliesError,
  BatchNeedsRecalculationError,
  BatchNotCloseableError,
  BatchSwingTooLargeError,
  BatchNotDraftError,
  BatchNotResettableError,
  BatchNotUnlockableError,
  PayrollPermissionDeniedError,
  PreProcessBlockedError,
  RemoveNoEmployeesError,
  RemovePeriodClosedError,
  RemoveReasonRequiredError,
  RemoveWholeRunError,
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
  removeEmployeePayroll,
  reprocessSelectedEmployees,
  resetProcessedBatch,
  setPayrollInput,
  unlockClosedBatch,
} from '@/core/payroll';
// 1b0943d5 — the two refusals a transferred month can produce: the month does not tile (close), and
// the counterpart employer's run is already closed so the days it owes can never be added (generate).
import { PayrollCounterpartClosedError, PayrollCoverageIncompleteError } from '@/core/payroll-coverage';
import { evaluateBatchAnomalies, resolveAnomalyVerdict } from '@/core/payroll-anomaly';
import { narrateVerdict } from '@/core/payroll-anomaly-narrate';
import { proposeHypotheses } from '@/core/payroll-hypothesis';
// 9066bd6c — the two ENTITLEMENT refusals removeEmployeePayroll throws BEFORE its reason check. Both are
// reachable by a direct post (the entry points hide their links while the setting is off, and the route
// 404s without the module), and without them the catch below pushed the service's raw English into the
// error banner for all six locales.
import { ModuleNotEnabledError, SettingNotEnabledError } from '@/core/entitlements';
// ADR-0080 rung 3 (D9): the claims payout path rides the PayrollInputContributor kernel contract
// instead of a direct core/claims import. The side-effect import evaluates the claims pack's
// contributor wiring (static registration at module load — the D8 convention), so the by-id
// resolution in prefillClaimsAction is guaranteed to succeed.
import '@/packs/claims/payroll';
import { payrollInputContributorById } from '@/packs/contracts';
import { prefillLoansForBatch } from '@/core/loans';
import { transferAllowancesToBatch } from '@/core/attendance-allowance';
// 7076f8af — the draft-adjustment panel is no longer a fixture of the run screen (it is rendered on the
// Payroll Process wizard's Review step and on a screen under Transactions), so the eight actions it drives
// return to the screen they were pressed on. The destination is whitelisted, never echoed raw. See
// lib/return-to.ts.
import {
  adjustmentReturnTo,
  payrollListAfterReset,
  payrollListReturnTo,
  withPayrollFrom,
  withQueryParam,
} from '@/lib/return-to';

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
  // r253 — THE RUN SCREEN THIS RETURNS TO KEEPS THE OPERATOR'S FILTER SELECTION. The form posts the same
  // `from` its own Back is built from; without it, generating from a January-filtered list landed on a
  // run screen whose Back went to a bare `/payroll`, i.e. the current period. See `withPayrollFrom`.
  const home = withPayrollFrom(`/payroll/${batchId}`, formData.get('from'));
  const acknowledged = String(formData.get('ackWarnings') ?? '') === '1';
  const t = await getTranslations('payroll.batch');
  let errMsg: string | null = null;
  let toastMsg = 'Payslips generated';
  try {
    const checks = await preProcessAdvisory(s, batchId);
    // BLOCKER count: no compensation row covering the period OR a zero basic/rate (feedback 64fb5e48) —
    // both stop generation (server re-asserts via PreProcessBlockedError). The old BASIC-pay-item
    // existence blocker is gone: the Personnel Basic Salary record is the authoritative pay source.
    // A stale BASIC pay item (amount differing from Personnel) joins the confirm-to-proceed warnings.
    const blockers = checks.missingCompensation.length + (checks.zeroBasic?.length ?? 0);
    // Item 1bb09a73 — its OWN count and its OWN message. `preChecksBlockedError` names a missing salary
    // record; a TP3 year mismatch is a different fault on employees whose salary record is fine, and a
    // refusal that misdescribes itself sends the operator to the wrong screen.
    const tp3Blockers = checks.tp3YearMismatch?.length ?? 0;
    // Item 4ca06dea — the same shape again, and the same reason: generatePayslips ALREADY refuses these
    // runs (`unpayablePayMode` is the third term of its exact set), so before this the operator pressed
    // Generate and got `preChecksBlockedError` — a message about a missing salary record, for employees
    // whose salary record is fine. Named here, before the press, in words that match the actual fault.
    const payModeBlockers = checks.unpayablePayMode?.length ?? 0;
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
    } else if (payModeBlockers > 0) {
      errMsg = t('preChecksBlockedPayModeError', { n: payModeBlockers });
    } else if (tp3Blockers > 0) {
      errMsg = t('preChecksBlockedTp3Error', { n: tp3Blockers });
    } else if (warnings > 0 && !acknowledged) {
      errMsg = t('preChecksConfirmRequired', { n: warnings });
    } else {
      // r226 — an ADDITIONAL run skips the employees it has nothing to pay in the cycle. This screen has
      // no result payload to carry the names (that is the wizard's Step-3 page, which does list them), so
      // the toast at least says HOW MANY are absent rather than leaving forty missing payslips to be
      // noticed by counting. The run screen itself shows what was written.
      const gen = await generatePayslips(s, { batchId });
      const skipped = 'skipped' in gen && Array.isArray(gen.skipped) ? gen.skipped.length : 0;
      if (skipped > 0) toastMsg = t('generatedWithSkipped', { n: skipped });
    }
  } catch (e) {
    const tp = await getTranslations('payroll.process');
    errMsg =
      (e as Error).name === 'TaxSchemeDeclarationError'
        ? tp('taxSchemeDeclarationRequired')
        : e instanceof PreProcessBlockedError
        ? t('preChecksBlockedError', { n: e.count })
        : // 1b0943d5 — a transferred employee whose OTHER employer's run for this period is already
          // closed. Refused in the kernel before anything commits; the operator gets the real reason,
          // in their own language, rather than the service's raw English.
          e instanceof PayrollCounterpartClosedError
          ? t('generateBlockedByCounterpartClosed', { n: e.employmentIds.length })
          : (e as Error).message;
  }
  if (errMsg) redirect(withQueryParam(home, 'error', errMsg));
  revalidatePath(`/payroll/${batchId}`);
  redirect(withQueryParam(home, 'toast', toastMsg));
}

export async function setPayrollInputAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const back = adjustmentReturnTo(formData.get('returnTo'), batchId);
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
    redirect(withQueryParam(back, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}`);
  redirect(withQueryParam(back, 'toast', 'Saved'));
}

export async function prefillOvertimeAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const back = adjustmentReturnTo(formData.get('returnTo'), batchId);
  let applied = 0;
  let ineligible = 0;
  try {
    ({ applied, ineligible } = await prefillOvertimeFromAttendance(s, { batchId }));
  } catch (e) {
    redirect(withQueryParam(back, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    applied === 0
      ? 'No overtime found in attendance for this period'
      : `OT prefilled for ${applied} employee${applied === 1 ? '' : 's'}${
          ineligible ? ` (${ineligible} above RM4,000 — not statutorily entitled)` : ''
        }`;
  redirect(withQueryParam(back, 'toast', note));
}

export async function prefillShiftDifferentialAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const back = adjustmentReturnTo(formData.get('returnTo'), batchId);
  let applied = 0;
  let gated = false;
  try {
    const r = await prefillShiftDifferentialFromRoster(s, { batchId });
    applied = r.applied;
    gated = 'gated' in r && r.gated === true;
  } catch (e) {
    redirect(withQueryParam(back, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}`);
  const note = gated
    ? 'Typed pay components are off — shift differential not applied'
    : applied === 0
      ? 'No shift differentials found for this period'
      : `Shift differential prefilled for ${applied} employee${applied === 1 ? '' : 's'}`;
  redirect(withQueryParam(back, 'toast', note));
}

export async function prefillClaimsAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const back = adjustmentReturnTo(formData.get('returnTo'), batchId);
  let applied = 0;
  let claims = 0;
  let total = 0;
  try {
    // Registered by the static side-effect import above, so the non-null assertion cannot fire
    // (same reasoning as the sidebar's registry lookups). `sourceCount` is the contract's word for
    // what claims calls `claims` — the toast copy below is unchanged.
    ({ applied, sourceCount: claims, total } = await payrollInputContributorById('claims')!.contribute(s, { batchId }));
  } catch (e) {
    redirect(withQueryParam(back, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    claims === 0
      ? 'No approved taxable claims awaiting payout'
      : `Queued ${claims} claim${claims === 1 ? '' : 's'} (RM ${total.toLocaleString('en-MY', {
          minimumFractionDigits: 2,
        })}) onto ${applied} payslip${applied === 1 ? '' : 's'}`;
  redirect(withQueryParam(back, 'toast', note));
}

// 1.2.8 Loan deductions (ADR-0060) — RESERVE the next instalment of each active loan onto a REGULAR DRAFT
// batch. The ledger is advanced at generation, not here. Actor passed through via the session.
export async function prefillLoansAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const back = adjustmentReturnTo(formData.get('returnTo'), batchId);
  let loans = 0;
  let total = 0;
  try {
    ({ loans, total } = await prefillLoansForBatch(s, { batchId }));
  } catch (e) {
    redirect(withQueryParam(back, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    loans === 0
      ? 'No active loans to deduct this cycle'
      : `Reserved ${loans} loan instalment${loans === 1 ? '' : 's'} (RM ${total.toLocaleString('en-MY', {
          minimumFractionDigits: 2,
        })})`;
  redirect(withQueryParam(back, 'toast', note));
}

export async function prefillTp1Action(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const back = adjustmentReturnTo(formData.get('returnTo'), batchId);
  let applied = 0;
  let skipped = 0;
  try {
    ({ applied, skipped } = await prefillTp1FromSelfRelief(s, { batchId }));
  } catch (e) {
    redirect(withQueryParam(back, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    applied === 0
      ? 'No submitted TP1 self-relief found for this period'
      : `TP1 self-relief fed onto ${applied} payslip${applied === 1 ? '' : 's'}${
          skipped ? ` (${skipped} left as a manual override)` : ''
        }`;
  redirect(withQueryParam(back, 'toast', note));
}

// 1.2.4 Zakat — prefill the FIXED-zakat amount onto in-scope employees' batch rows (visibility/edit
// convenience; the kernel already auto-applies it at generate time). Actor passed through.
export async function prefillFixedZakatAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const back = adjustmentReturnTo(formData.get('returnTo'), batchId);
  let applied = 0;
  try {
    ({ applied } = await prefillFixedZakat(s, { batchId }));
  } catch (e) {
    redirect(withQueryParam(back, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    applied === 0
      ? 'No active fixed-zakat elections for this batch'
      : `Fixed zakat prefilled for ${applied} employee${applied === 1 ? '' : 's'}`;
  redirect(withQueryParam(back, 'toast', note));
}

// Attendance Allowance (ADR-0072) — transfer a Monthly policy's qualified allowances onto this draft
// batch. Gated by TYPED_PAY_COMPONENTS_ENABLED (off ⇒ no-op with a clear banner). Re-derives qualification
// live at transfer time and reverses rows for employees who no longer qualify. Actor passed via session.
export async function transferAllowancesAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const back = adjustmentReturnTo(formData.get('returnTo'), batchId);
  const policyId = String(formData.get('policyId') ?? '');
  if (!policyId) redirect(withQueryParam(back, 'error', 'Select an attendance-allowance policy first'));
  let applied = 0;
  let ineligible = 0;
  let reversed = 0;
  let gated = false;
  try {
    ({ applied, ineligible, reversed, gated } = await transferAllowancesToBatch(s, { batchId, policyId }));
  } catch (e) {
    redirect(withQueryParam(back, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}`);
  const note = gated
    ? "Transfer recorded 0 rows — the typed pay-components feature is off, so this won't reach payslips yet"
    : `Attendance allowance transferred to ${applied} employee${applied === 1 ? '' : 's'}` +
      (ineligible ? ` (${ineligible} did not qualify)` : '') +
      (reversed ? `; removed ${reversed} previously-transferred row${reversed === 1 ? '' : 's'} that no longer qualify` : '');
  redirect(withQueryParam(back, 'toast', note));
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
 * Payroll Reset / Zeroization (feedback a03b2d9b) — revert a PROCESSED run to DRAFT after an explicit
 * confirmation. Explicit RBAC here (not just the pages' admin gates) because server actions
 * are callable from any surface: reset is ADMIN-only — a payroll_partner passes the payroll pages
 * but must not reset. The service re-asserts the role, enforces processed-only (closed is
 * permanently immutable), reverses the loan/claim side-effects and appends the audited
 * payroll-batch.reset event with the session's real actor. Toast/error copy localised here
 * (ToastFromQuery renders the raw query string — same convention as deleteDraftBatchAction).
 *
 * WHERE IT LANDS HAS NOW BEEN DECIDED TWICE, AND THIS IS THE SECOND ANSWER. The history matters, because
 * the first answer was not a mistake:
 *
 *   · Originally a successful reset dropped the operator back on `/payroll/<id>`, a long draft screen
 *     carrying functions they never asked for and a payslip list that is EMPTY at that exact moment
 *     (resetProcessedBatch deletes the run's payslips).
 *   · 7076f8af replaced that with the guided run flow (`resumeHref`) on the reporter's own instruction,
 *     which fixed the empty screen.
 *   · 65e2d5de is the reporter REVERSING that: "Payroll Process → Reset Payroll → Confirm → Submit →
 *     Payroll Process". Landing inside Continue Progress is a workflow they did not ask to enter, and the
 *     list is where the run's new Draft status can actually be seen. The Continue link on the row is still
 *     there for anyone who does want the guided flow, so nothing is lost — only the default changed.
 *
 * So the destination is now the PAYROLL PROCESS LIST, as the operator left it: the reset form posts the
 * screen's own filter query as `from`, and `payrollListAfterReset` whitelists it BY SHAPE (a posted value
 * is untrusted — see lib/return-to.ts). Absent or hostile ⇒ a bare `/payroll`, which is still the list.
 *
 * WHY `payrollListAfterReset` AND NOT `payrollListReturnTo`. Reset is offered on PROCESSED runs only, so
 * "Status: Processed" is the filter the operator is most likely standing in when they press it — and this
 * action makes the run DRAFT. Following the posted query verbatim would land them on a list the row they
 * just acted on has fallen out of: a success toast over a table with no sign of the run. The helper drops
 * a status filter that would hide the reset run and keeps every other one (year, months, company, cycle),
 * so the run is on the list, showing Draft. Its doc comment carries the full reasoning, including why the
 * filter is cleared rather than widened — the Status control is a single `<select>`.
 *
 * A FAILED reset RETURNS TO THE SURFACE IT WAS PRESSED FROM, which is not the same place for both of
 * them (9f8cd608). Two forms post here: the run screen's own panel, and app/payroll/[batchId]/reset.
 * Sending the screen's operator back to `/payroll/<id>` would drop them on the long run screen 7076f8af
 * was raised to get them OFF, and throw away the filter query and the reason they came in with — so the
 * screen posts a `surface` flag and gets its refusal back on itself, with the message and the reason,
 * exactly as the sibling Remove screen does. The run screen posts no flag and is unchanged: its refusals
 * still land on the run screen, where the run still is and where the refusal makes sense.
 */
export async function resetAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const reason = String(formData.get('reason') ?? '').trim();
  // 65e2d5de — the list AS THE OPERATOR LEFT IT, minus a status filter that would hide the Draft run this
  // reset is about to create. Both reset forms post the filter query they were pressed with; whitelisted
  // by shape, never echoed raw. A form that posts nothing resolves to '/payroll'.
  const back = payrollListAfterReset(String(formData.get('from') ?? ''));
  // 9f8cd608 — WHICH SURFACE PRESSED IT, so a refusal comes back where the operator is standing. A FLAG,
  // never a posted destination: a path read off a form is an untrusted value, and a flag needs no
  // whitelist at all. Anything but the reset screen's own marker means the run screen, i.e. the old
  // behaviour. `refusalFrom` is the ORIGINAL filter query, whitelisted by shape and NOT run through
  // `payrollListAfterReset` — a refused reset leaves the run processed, so the status filter that would
  // have hidden the (never created) Draft run must stay exactly as the operator set it.
  const onResetScreen = formData.get('surface') === 'reset-screen';
  const refusalFrom = payrollListReturnTo(formData.get('from'));
  const t = await getTranslations('payroll.batch');
  try {
    await resetProcessedBatch(s, { batchId, reason: reason || undefined });
  } catch (e) {
    // ORDERED AS THE SERVICE THROWS THEM. `SettingNotEnabledError` is FIRST because `resetProcessedBatch`
    // raises it before anything else, and it was the hole left here: unmapped, this catch fell through to
    // `(e as Error).message` and painted the service's raw English ("Payroll reset is not enabled.") into
    // the banner in all six locales — the identical defect test/payroll-remove-i18n.test.ts was written
    // to close for Remove. It needs the risk switch to flip between rendering the form and pressing it,
    // which is narrow, but "narrow" is not "translated".
    const msg =
      e instanceof SettingNotEnabledError
        ? t('resetDisabled')
        : e instanceof PayrollPermissionDeniedError
          ? t('resetAdminOnly')
          : e instanceof ResetReasonRequiredError
            ? t('resetReasonRequired')
            : e instanceof BatchNotResettableError
              ? t('resetOnlyProcessed')
              : (e as Error).message;
    if (onResetScreen) {
      const q = new URLSearchParams({ error: msg });
      // Only when it is not the default, so an unfiltered visit keeps a clean URL — the Remove screen's
      // convention, and it keeps Back/Cancel pointing at the list the operator actually came from.
      if (refusalFrom !== '/payroll') q.set('from', refusalFrom);
      // The reason comes back IN THE BOX, so a refusal costs no retyping. Length-capped because this
      // rides in a redirect Location header rather than a page body: a pathological essay is dropped
      // rather than turned into a header a proxy may refuse. The one refusal reachable without a race —
      // a whitespace-only reason, which `required` happily accepts — trims to '' and carries nothing.
      if (reason && reason.length <= 500) q.set('reason', reason);
      redirect(`/payroll/${batchId}/reset?${q.toString()}`);
    }
    redirect(`/payroll/${batchId}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  revalidatePath('/payroll');
  revalidatePath('/payroll/process');
  // All three revalidatePath calls above are kept: the list is now the destination, so its cache MUST be
  // dropped or the operator lands on a page still showing the run as Processed. The toast rides along and
  // is rendered by the layout's ToastFromQuery, exactly as before.
  redirect(withQueryParam(back, 'toast', t('resetDone')));
}

/**
 * Selective per-employee reprocessing (feedback 9bc442bc, reporter ask #3 + #8) — queue an idempotent
 * reprocess job that recomputes ONLY the ticked employees IN PLACE (version-bumped payslips, delta
 * totals), leaving everyone else physically untouched. Granular RBAC (payroll.reprocess.selective),
 * processed-only, membership intersection, the queue/idempotency guard and the delta recompute all live
 * in reprocessSelectedEmployees (the service); the session carries the real actor. Stays on the SAME
 * processed run (in-place). Copy localised here.
 *
 * e440991b — IT NOW ENDS WHERE IT STARTED. This used to redirect back to the long run screen with a
 * one-line "N of M reprocessed" toast, which told the operator a count and nothing about what actually
 * moved. It returns to /payroll/<id>/reprocess carrying the JOB ID, and that page renders the completed
 * job: every employee reprocessed, net pay before and after off the stored snapshots, which figures
 * moved and why. Refusals come back to the same screen so the selection is still in front of you.
 *
 * b372e923 — AND IT CARRIES `from` ACROSS THE ROUND TRIP, the way removeEmployeePayrollAction does. A
 * redirect builds a brand-new URL: whatever the operator arrived with is gone unless the form posted it
 * and this action puts it back. It was gone, and the cost was not only this screen's Back — the result
 * table it lands on renders a Payroll Result link per employee, and each of those hands `from` on to the
 * result screen. With none in the address bar the whole chain fell back to a bare, unfiltered list.
 * Whitelisted by shape here as well as on the page, because a FormData value is untrusted input.
 */
export async function reprocessSelectedAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const employmentIds = formData.getAll('employmentIds').map(String).filter(Boolean);
  const reason = String(formData.get('reason') ?? '').trim();
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const t = await getTranslations('payroll.batch');
  const backPath = `/payroll/${batchId}/reprocess`;
  // r253 — …AND IT COMES BACK WITH THE FILTER SELECTION STILL ON IT. Reprocess is one of the five Back
  // destinations the reporter named, and this redirect is the ordinary way onto it: pressing the button
  // stripped the `from` the screen was opened with, so Back from the job result went to the current
  // period. `backPath` stays bare for `revalidatePath`, which takes a path and not a query.
  const back = withPayrollFrom(backPath, formData.get('from'));
  if (employmentIds.length === 0) {
    redirect(withQueryParam(back, 'error', t('reprocessNoneSelected')));
  }
  let jobId = '';
  try {
    const r = await reprocessSelectedEmployees(s, {
      batchId,
      employmentIds,
      reason: reason || undefined,
      idempotencyKey: idempotencyKey || undefined,
    });
    jobId = r.jobId;
  } catch (e) {
    const msg =
      e instanceof PayrollPermissionDeniedError
        ? t('reprocessAdminOnly')
        : e instanceof BatchNotResettableError
          ? t('reprocessNotProcessed')
          : // 1b0943d5 — same refusal as generation: recomputing this run would leave a transferred
            // employee short on a counterpart run that is already closed and can no longer take the days.
            e instanceof PayrollCounterpartClosedError
            ? t('generateBlockedByCounterpartClosed', { n: e.employmentIds.length })
            : (e as Error).message;
    redirect(withQueryParam(back, 'error', msg));
  }
  revalidatePath('/payroll');
  revalidatePath(`/payroll/${batchId}`);
  revalidatePath(backPath);
  redirect(withQueryParam(back, 'job', jobId));
}

/**
 * 9066bd6c — REMOVE ONE EMPLOYEE'S PAYROLL from a processed run.
 *
 * The counterpart to `resetAction`, and deliberately NOT a variant of it: Reset clears every employee
 * on the run and drops it to Draft; this deletes only the ticked employees' results, unwinds only their
 * loan instalment / paid claims / one-off markers, and leaves the run Processed with its totals reduced
 * by exactly what went. All authority (the reset setting gate, the multi-cycle module gate,
 * payroll.remove.employee, processed-only, period-open, the whole-run refusal and the audit) lives in
 * `removeEmployeePayroll`; this maps its refusals onto translated copy and returns to the same screen so
 * the selection is still in front of the operator.
 *
 * `from` carries the Payroll Process list's filters through the round trip (see lib/return-to.ts) so
 * the Back link on the screen the operator lands on still returns the list as they left it.
 */
export async function removeEmployeePayrollAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const employmentIds = formData.getAll('employmentIds').map(String).filter(Boolean);
  const reason = String(formData.get('reason') ?? '').trim();
  const from = payrollListReturnTo(formData.get('from'));
  const t = await getTranslations('payroll.batch');
  const back = `/payroll/${batchId}/remove`;
  const to = (params: Record<string, string>) => {
    const sp = new URLSearchParams(params);
    // Only carried when it is not the default, so an unfiltered visit keeps a clean URL.
    if (from !== '/payroll') sp.set('from', from);
    return `${back}?${sp.toString()}`;
  };
  if (employmentIds.length === 0) {
    redirect(to({ error: t('removeNoneSelected') }));
  }
  let removed = 0;
  try {
    const r = await removeEmployeePayroll(s, { batchId, employmentIds, reason: reason || undefined });
    removed = r.payslipsRemoved;
  } catch (e) {
    // ORDERED AS THE SERVICE THROWS THEM: the two entitlement gates come first, before the reason check,
    // and each of the eight has its own translated line. `(e as Error).message` is the floor, not a
    // fallback anyone should land on — every refusal this service can raise is named above it.
    const msg =
      e instanceof SettingNotEnabledError
        ? t('removeDisabled')
        : e instanceof ModuleNotEnabledError
          ? t('removeModuleOff')
          : e instanceof PayrollPermissionDeniedError
            ? t('removeAdminOnly')
            : e instanceof RemoveReasonRequiredError
              ? t('removeReasonMissing')
              : e instanceof RemoveWholeRunError
                ? t('removeWholeRunRefused')
                : e instanceof RemovePeriodClosedError
                  ? t('removePeriodClosed')
                  : e instanceof RemoveNoEmployeesError
                    ? t('removeNotOnRun')
                    : e instanceof BatchNotResettableError
                      ? t('removeNotProcessed')
                      : (e as Error).message;
    redirect(to({ error: msg }));
  }
  revalidatePath('/payroll');
  revalidatePath(`/payroll/${batchId}`);
  revalidatePath(`/payroll/${batchId}/reprocess`);
  revalidatePath(back);
  redirect(to({ removed: String(removed) }));
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
  // r253 — the run screen it returns to keeps the filter selection the operator arrived with.
  const home = withPayrollFrom(`/payroll/${batchId}`, formData.get('from'));
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
    redirect(withQueryParam(home, 'error', msg));
  }
  revalidatePath(`/payroll/${batchId}`);
  revalidatePath('/payroll');
  const toast = warned ? t('unlockDoneWarned') : t('unlockDone');
  redirect(withQueryParam(home, 'toast', toast));
}

/**
 * Close (publish) a processed run — feedback ef31d251.
 *
 * Three fixes, none of them touching the close mechanics (all authority stays in closeBatch: payroll.close,
 * processed-only, the release derivation and the payroll-batch.closed event that fans out payslip.ready):
 *  - `revalidatePath('/payroll')`. This action revalidated ONLY the run's own page, so the list's new
 *    unpublished badge + banner would have gone stale the instant a run was closed.
 *  - The success toast was the hardcoded English `?toast=Batch closed`. It IS rendered (ToastFromQuery is
 *    mounted in app/layout.tsx), so it was untranslated copy on the confirmed flow.
 *  - The catch pushed `(e as Error).message` — raw English core strings — into the URL. Mapped to
 *    translated copy per named error, mirroring unlockAction.
 */
export async function closeAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  // r253 — THE PATH THE REPORTER ACTUALLY WALKED. Filter to January, open a processed run, press Close
  // payroll: this redirect landed on `/payroll/<id>?toast=…` with no `from`, so the run screen's Back
  // then went to a bare `/payroll` — September. The Back LINKS were carrying the selection all along;
  // this button was throwing it away, which is why the item read as "already works" and was not.
  const home = withPayrollFrom(`/payroll/${batchId}`, formData.get('from'));
  const t = await getTranslations('payroll.batch');
  const ta = await getTranslations('anomaly');
  try {
    await closeBatch(s, { batchId });
  } catch (e) {
    const msg =
      e instanceof BatchNotCloseableError
        ? t('closeNotProcessed')
        : // 1b0943d5 — a mid-period entity transfer whose two halves do not cover the month exactly. Close
          // is where the money becomes final, so it is where the tiling has to hold; the operator is told
          // how many people are affected and sent to the other company's run for the same period.
          e instanceof PayrollCoverageIncompleteError
          ? t('closeBlockedByCoverage', { n: e.employmentIds.length })
          : // 49e7e0a2 — the run's transactions changed after it was processed. The BUTTON is already
          // hidden while that is true, so reaching here means a direct post or a mark that landed
          // between the render and the submit; either way the operator gets the real reason, in their
          // own language, rather than the service's raw English.
          e instanceof BatchNeedsRecalculationError
          ? t('closeBlockedRecalc')
          : // ADR-0076 — the two anomaly refusals. Both are reachable from a direct post or a verdict that
            // landed between the render and the submit, so both get the real reason in the operator's own
            // language rather than the service's raw English.
            e instanceof BatchHasBlockingAnomaliesError
            ? ta('closeBlockedByAnomalies', { count: e.employmentIds.length })
            : e instanceof BatchSwingTooLargeError
              ? ta('closeBlockedBySwing', { movement: e.movementPct, threshold: e.thresholdPct })
              : e instanceof PayrollPermissionDeniedError
                ? t('closePermissionDenied')
                : (e as Error).message;
    redirect(withQueryParam(home, 'error', msg));
  }
  revalidatePath(`/payroll/${batchId}`);
  revalidatePath('/payroll');
  redirect(withQueryParam(home, 'toast', t('closeDone')));
}

/**
 * ADR-0076 — run the anomaly checks over a batch.
 *
 * READ-ONLY with respect to money, which is why this needs no confirmation dialog: it reads the payslips
 * and writes verdicts, and re-running is the normal case rather than the exception.
 */
export async function evaluateAnomaliesAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  // r253 — Anomalies' own Back goes to the RUN, and the run screen's Back goes to the list, so an
  // anomalies redirect that drops `from` loses the selection TWO screens further on than anybody was
  // looking. Every form on that screen posts the value the page was opened with.
  const home = withPayrollFrom(`/payroll/${batchId}/anomalies`, formData.get('from'));
  const t = await getTranslations('anomaly');
  let summary: { block: number; review: number; autoClear: number };
  try {
    const run = await evaluateBatchAnomalies(s, { batchId });
    summary = { block: run.block, review: run.review, autoClear: run.autoClear };
  } catch (e) {
    redirect(withQueryParam(home, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}/anomalies`);
  revalidatePath(`/payroll/${batchId}`);
  redirect(
    withQueryParam(
      home,
      'toast',
      t('evaluated', { block: summary.block, review: summary.review, clear: summary.autoClear }),
    ),
  );
}

/** Record a human's disposition of one verdict. The note is optional; the resolution is not. */
/**
 * ADR-0076 §2.6 — ask for the plain-words explanation of one exception.
 *
 * Deliberately a BUTTON rather than something the page does on render. The prose costs a provider call
 * on the tenant's own key, so it is spent when an operator actually wants it and then persisted; and it
 * keeps the narrator off the render path, which is what lets the queue open at 3,000 people whatever the
 * provider is doing. Every failure — no provider, provider down, prose naming a figure the facts do not
 * support — leaves the row exactly as it was, with its facts, and says so.
 */
export async function narrateAnomalyAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const verdictId = String(formData.get('verdictId'));
  const home = withPayrollFrom(`/payroll/${batchId}/anomalies`, formData.get('from')); // r253 — see above
  const t = await getTranslations('anomaly');
  let outcome: Awaited<ReturnType<typeof narrateVerdict>>;
  try {
    outcome = await narrateVerdict(s, { verdictId });
  } catch (e) {
    redirect(withQueryParam(home, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}/anomalies`);
  // Three outcomes, three different sentences. "Nothing happened" is never rendered as success.
  const msg = outcome.notConfigured
    ? t('narrateNotConfigured')
    : outcome.narrated > 0
      ? t('narrated', { n: outcome.narrated })
      : outcome.rejected > 0
        ? t('narrateRejected')
        : t('narrateNothing');
  redirect(withQueryParam(home, 'toast', msg));
}

/**
 * ADR-0084 §2.6 — ask the second-opinion layer to look at what the fixed checks cleared.
 *
 * The nightly sweep already runs this unattended, which is the point of the whole ADR; the button exists
 * so an operator can ask NOW, and because a layer nobody can trigger by hand is a layer nobody can
 * evaluate. Every outcome gets its own sentence — "not switched on", "run too small", "no provider" and
 * "nothing stood out" are four different facts, and rendering any of them as success would be the
 * "nothing happened, reported as fine" failure `narrateAnomalyAction` above already refuses.
 */
export async function proposeHypothesesAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const home = withPayrollFrom(`/payroll/${batchId}/anomalies`, formData.get('from')); // r253 — see above
  const t = await getTranslations('anomaly');
  let run: Awaited<ReturnType<typeof proposeHypotheses>>;
  try {
    run = await proposeHypotheses(s, { batchId });
  } catch (e) {
    redirect(withQueryParam(home, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}/anomalies`);
  revalidatePath(`/payroll/${batchId}`);
  const msg = run.disabled
    ? t('hypothesisDisabled')
    : run.cohortTooSmall
      ? t('hypothesisTooSmall')
      : run.raised > 0
        ? t('hypothesisRaised', { n: run.raised })
        : run.notConfigured
          ? t('hypothesisNotConfigured')
          : t('hypothesisNone');
  redirect(withQueryParam(home, 'toast', msg));
}

/**
 * ⚠️ r245 — TWO SCREENS RESOLVE, AND THERE IS STILL ONE ACTION. The cross-run queue at
 * /control-tower/exceptions posts here too, so `returnTo` says where to land afterwards; it is
 * ALLOWLISTED rather than echoed, because it becomes a redirect target. A second copy of this action
 * would be a second place the ledger stamp (r238's `hypothesisProposalsToStamp`, inside
 * `resolveAnomalyVerdict`) could be forgotten.
 */
const RESOLVE_RETURNS = ['tower'] as const;

export async function resolveAnomalyAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  const verdictId = String(formData.get('verdictId'));
  const resolution = String(formData.get('resolution')) as 'accepted' | 'fixed_upstream' | 'false_positive';
  const note = String(formData.get('note') ?? '').trim();
  const back = String(formData.get('returnTo') ?? '');
  // r253 — the Payroll branch carries the operator's filter selection (see `evaluateAnomaliesAction`).
  // The cross-run queue at /control-tower/exceptions does NOT: it is not reached from the Payroll
  // Process list and has no selection to restore, so it keeps exactly the address it has today.
  const home = (RESOLVE_RETURNS as readonly string[]).includes(back)
    ? '/control-tower/exceptions'
    : withPayrollFrom(`/payroll/${batchId}/anomalies`, formData.get('from'));
  const t = await getTranslations('anomaly');
  try {
    await resolveAnomalyVerdict(s, { verdictId, resolution, note: note || undefined });
  } catch (e) {
    redirect(withQueryParam(home, 'error', (e as Error).message));
  }
  revalidatePath(`/payroll/${batchId}/anomalies`);
  revalidatePath(`/payroll/${batchId}`);
  revalidatePath('/control-tower/exceptions');
  revalidatePath('/control-tower');
  redirect(withQueryParam(home, 'toast', t('resolved')));
}
