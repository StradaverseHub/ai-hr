'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { listLeaveTypes, myEmployment } from '@/core/read';
import {
  // 65f466e2 — role-aware identity, replacing a dead `code === 'EMERGENCY'` comparison.
  leaveTypeIs,
  addLeaveAttachment,
  adminCancelLeave,
  cancelOwnLeave,
  editLeaveRequest,
  requestLeave,
  requestLeaveCancellation,
  previewLeaveDeduction,
  leaveTypeApplySummary,
  validateLeaveDocument,
  isEmergencyReasonCategory,
  todayInKualaLumpur,
  type LeaveDurationType,
} from '@/core/leave';
import { resolveEssView } from '@/core/ess-view';
// 296fc027 — the employee replacement-leave request path, reached through the leave-pack facade.
import { decideReplacementLeaveRequest, submitReplacementLeaveRequest } from '@/packs/leave/service';
import { localizeLeaveError } from '@/app/me/actions';

/** Feedback 31474452 (Step 5): read-only pre-submission preview for the Leave-tab form (which can apply
 *  on-behalf-of any employment the caller can see, via the Field label={t('fieldEmployee')} select). Runs
 *  under the caller's own session — RLS on leave_ledger/leave_type gates disclosure exactly as requestLeave
 *  does; an out-of-scope employmentId simply yields an RLS-empty balance rather than a throw.
 *
 *  Employee apply-popup enhancement: the Employee selector is rendered ONLY on the on-behalf-of path, so a
 *  plain self-service employee reached here with an empty employmentId and ALWAYS got null — the "this will
 *  deduct N day(s)" line was silently dead for the ticket's actual user. Fall back to the caller's own
 *  employment exactly like requestLeaveAction does. includeDayRows rides along on this same call so the
 *  day-by-day panel and the deduction line come from ONE computation (no second action, no stale-response
 *  race, no extra read). */
export async function previewLeaveDeductionAction(p: {
  employmentId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  durationType: LeaveDurationType;
}) {
  const session = await getSession();
  if (!p.leaveTypeId || !p.startDate || !p.endDate) return null;
  try {
    const employmentId = p.employmentId || (await myEmployment(session))?.employmentId;
    if (!employmentId) return null;
    // Override Leave Application (56910869): the tenant-local "today" the advance-notice trigger is judged
    // against — the SAME value requestLeaveAction passes below, so the pop-out the employee is shown and the
    // rule the submission applies can never disagree about the notice given.
    return await previewLeaveDeduction(session, {
      ...p,
      employmentId,
      includeDayRows: true,
      today: todayInKualaLumpur(),
    });
  } catch {
    return null; // preview is best-effort — the submit action remains the authoritative gate
  }
}

/** Employee apply-popup entitlement summary (Taken / Pending / Balance / Available) for the currently-selected
 *  leave type. Read-only and best-effort — a failure renders nothing, never blocking the form.
 *
 *  ESS gating is decided HERE, not in core, because the consumers answer it differently:
 *   - Pending is gated on the resolved `pendingApproval` key, Taken on `taken`, Available on `available` —
 *     each on the key that names it, exactly as §1 of ENTITLEMENT_PANEL_SECTIONS gates the same four rows;
 *   - Balance is gated on Available AND Taken being visible. It carries no ess-view key of its own (§1
 *     documents "Balance has no essKey"), but feedback 082fa566 made it the row Available is visibly derived
 *     FROM, so leaving it ungated would hand back the gross figure HR had just hidden — the same leak
 *     deriveBalanceRow closes on the balance table with the same two-key test;
 *   - and gating is skipped ENTIRELY when the resolved employment is not the caller's own — the admin/HR
 *     on-behalf read, which core/read.ts already documents as never gated (EntitlementBreakdown's
 *     applyEssConfig=false convention).
 *  A gated figure comes back null and renders as a dash. */
export async function leaveApplySummaryAction(p: { employmentId: string; leaveTypeId: string }) {
  const session = await getSession();
  if (!p.leaveTypeId) return null;
  try {
    const me = await myEmployment(session);
    const employmentId = p.employmentId || me?.employmentId;
    if (!employmentId) return null;
    const s = await leaveTypeApplySummary(session, { employmentId, leaveTypeId: p.leaveTypeId });
    if (!me || employmentId !== me.employmentId) {
      return { pending: s.pending, taken: s.taken, balance: s.balance, available: s.available };
    }
    const view = resolveEssView(s.essViewConfig);
    return {
      pending: view.pendingApproval ? s.pending : null,
      taken: view.taken ? s.taken : null,
      balance: view.available && view.taken ? s.balance : null,
      available: view.available ? s.available : null,
    };
  } catch {
    return null;
  }
}

export async function requestLeaveAction(formData: FormData) {
  const session = await getSession();
  const leaveTypeId = String(formData.get('leaveTypeId'));
  const durationType = (String(formData.get('durationType') || 'full_day') as LeaveDurationType);
  // Hourly-leave time window (0129): the form now posts a From/To window (not a raw hours number) for hourly
  // leave; the service derives hours from the span. Empty ⇒ undefined ⇒ the service throws its mandatory gate.
  const fromTime = String(formData.get('fromTime') ?? '').trim();
  const toTime = String(formData.get('toTime') ?? '').trim();
  // Emergency Leave (Phase-B #12): category routes the cascade (illness → paid SICK first); the consent
  // checkbox gates an UNPAID child. Both are inert for non-EL types.
  const reasonCategoryRaw = String(formData.get('reasonCategory') ?? '').trim();
  const reasonCategory = isEmergencyReasonCategory(reasonCategoryRaw) ? reasonCategoryRaw : undefined;
  const unpaidConsent = String(formData.get('unpaidConsent') ?? '') === 'on';
  // Override Leave Application (56910869): the employee's confirmation of the rule(s) that will CHANGE this
  // application, one `trigger:action` token per rule (the form posts one hidden field per rule it showed).
  // getAll, not get: two rules can fire on one application and consent to one is not consent to the other.
  // Forwarded unconditionally — the SERVICE is the gate, and it refuses a converting rule whose token is
  // missing, so a client that skips the pop-out cannot submit a silently-converted application.
  const overrideConsent = formData.getAll('overrideConsent').map(String).filter((v) => v !== '');
  // Phase-B #13 (ADR-0062): maternity-only s.37 paid-allowance facts. Inert for non-maternity types (the
  // service only reads them for a MATERNITY request). Empty inputs ⇒ undefined ⇒ conservative paid default.
  const survivingChildrenRaw = String(formData.get('survivingChildren') ?? '').trim();
  const confinementDateRaw = String(formData.get('confinementDate') ?? '').trim();
  // Supporting-document config: read the optional file + remark (mirrors /me's myRequestLeave). The remark
  // is required server-side only when the selected type sets employeeRemarkRequired; an empty box → undefined.
  const file = formData.get('document');
  const hasFile = file instanceof File && file.size > 0;
  const employeeRemark = String(formData.get('employeeRemark') ?? '').trim() || undefined;
  // Resolve the selected type once. This is NOT mirroring /me's listEligibleLeaveTypesFor eligibility filter:
  // the Leave-Tab dropdown renders the unfiltered listLeaveTypes (it can apply on behalf of an employee who
  // may be ineligible), and requestLeave re-runs assertEligible server-side. We only need the localized name
  // (for errors) and the mime/size config (for the orphan-prevention pre-check) here.
  const locale = await getLocale();
  const types = await listLeaveTypes(session, { locale });
  const selected = types.find((t) => t.id === leaveTypeId);
  // Emergency Leave (0106) edge: EL short-circuits to requestEmergencyLeave, which decomposes into
  // ANNUAL+UNPAID child rows that hard-code employeeRemark:null and never carry a document. Attaching here
  // would dangle a file on a hidden child. So for EL we hide the fields (LeaveDurationFields) AND ignore any
  // posted file/remark here as a server-side backstop against a stale form.
  // Balance Deduction Source (cdf9ca48): the short-circuit only happens while EL has NO configured balance
  // source. Once HR points it at another type's balance it goes through the ordinary single-request path,
  // which persists a real EMERGENCY row that CAN carry a document and a remark — so this backstop must
  // narrow with it, otherwise it would silently discard an attachment the form legitimately offered.
  // 65f466e2 — ask the ROLE. This read `code === 'EMERGENCY'`, which is false on every tenant that did not
  // take the pack's code verbatim (production's is `EL`), so the backstop below silently never engaged.
  const isEL = leaveTypeIs(selected, 'emergency') && selected?.balanceSourceTypeId == null;
  const attach = hasFile && !isEL;
  // Phase-B #15: a non-blocking holiday-completeness warning is surfaced via ?warn= when the request's
  // (state, year) has fewer than the s.60D minimum of 11 gazetted holidays loaded.
  let warnQuery = '';
  try {
    // Orphan-prevention: validate the file BEFORE requestLeave commits the row + event, so a
    // disallowed/oversized file is rejected with no committed pending request left behind.
    if (attach) {
      if (!selected) {
        // The posted type isn't in the projection — we can't resolve its mime/size rule. Let requestLeave
        // reject the unknown type (it will) and never call addLeaveAttachment for an unresolved type.
        throw new Error('Leave type not found.');
      }
      validateLeaveDocument(
        { allowedMimeTypes: selected.allowedMimeTypes, maxDocBytes: selected.maxDocBytes },
        { mimeType: file.type || 'application/octet-stream', sizeBytes: file.size },
      );
    }
    // Self-service apply (item 69088c13): the ESS form no longer renders the Employee selector, so no
    // employmentId is posted. Fall back to the signed-in viewer's own employment (mirrors /me's myRequestLeave)
    // so a self-service submit still binds to the logged-in employee. The on-behalf admin/manager path still
    // posts an explicit employmentId from the selector, which takes precedence.
    const postedEmploymentId = String(formData.get('employmentId') ?? '').trim();
    const employmentId = postedEmploymentId || (await myEmployment(session))?.employmentId;
    if (!employmentId) {
      throw new Error('No employment on record for this account.');
    }
    const res = await requestLeave(session, {
      employmentId,
      leaveTypeId,
      startDate: String(formData.get('startDate')),
      endDate: String(formData.get('endDate')),
      reason: (formData.get('reason') as string) || undefined,
      hasDocument: attach,
      employeeRemark: isEL ? undefined : employeeRemark,
      durationType,
      fromTime: durationType === 'hourly' && fromTime !== '' ? fromTime : undefined,
      toTime: durationType === 'hourly' && toTime !== '' ? toTime : undefined,
      reasonCategory,
      unpaidConsent,
      overrideConsent,
      survivingChildren: survivingChildrenRaw !== '' ? Number(survivingChildrenRaw) : undefined,
      confinementDate: confinementDateRaw !== '' ? confinementDateRaw : undefined,
      // Configurable backdated-leave restriction (0133): tenant-local (MYT) "today" for the boundary. The
      // on-behalf admin path bypasses the limit anyway (isAdmin override), but pass it for correctness/parity.
      today: todayInKualaLumpur(),
    });
    if (attach && file instanceof File) {
      // Same server-action session that just created the row, so the new pending request is visible to this
      // RLS session (transitively, also for the on-behalf-of admin). Order matters: addLeaveAttachment
      // requires status==='pending', which is exactly the state requestLeave leaves it in.
      await addLeaveAttachment(session, {
        leaveRequestId: res.leaveRequestId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
    const w = res.holidayWarnings?.[0];
    if (w) {
      warnQuery = `?warnHoliday=1&loaded=${w.loaded}&state=${encodeURIComponent(w.state ?? '')}&year=${w.year}`;
    }
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e, selected?.name))}`);
  }
  revalidatePath('/leave');
  // Success confirmation (feedback 45c781e2) — until now a successful submission was SILENT: the dialog
  // closed and the page refreshed, which is indistinguishable from having dismissed it. It rides the
  // redirect rather than being raised in the client, so it fires only on CONFIRMED success — this line is
  // reached only after the service call returned without throwing, and the failure path above redirects to
  // ?error= instead. Appended rather than assigned, because the holiday-warning query may already be set
  // and a submission can legitimately produce both.
  //
  // Duplicate success notification (feedback 29710798): this used to redirect with the OPAQUE MARKER
  // `?toast=leaveSubmitted`, which two separate listeners answered — the globally-mounted ToastFromQuery
  // (app/layout.tsx) fired the raw marker text, and a second /leave-only client component fired the
  // translated sentence. Two toasts, one submission. The marker is gone: this now carries the already-
  // LOCALISED message, the house convention every other redirect here follows (ToastFromQuery renders the
  // raw query string, so never pass an i18n key), leaving exactly one emitter and the right words in it.
  const tToast = await getTranslations('leave');
  const done = encodeURIComponent(tToast('submittedToast'));
  redirect(`/leave${warnQuery}${warnQuery ? '&' : '?'}toast=${done}`);
}

// Partial Leave Cancellation (ADR-0065): an employee gives back a SUBSET of an approved leave's dates. The
// checkboxes post one `cancelDate` value per ticked future working day. requestLeaveCancellation re-runs every
// gate server-side (subject-only, approved+full_day+non-EL+non-REPLACEMENT, per-date future, closed-period,
// pending-overlap) so a stale form can't slip a bad date through. Revalidate /leave, /approvals, /leave/tracker
// and / so the manager's inbox, the Leave Calendar and the dashboard's away count all pick up the new request.
export async function requestLeaveCancellationAction(formData: FormData) {
  const session = await getSession();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  const cancelDates = formData.getAll('cancelDate').map((d) => String(d)).filter(Boolean);
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  try {
    // R5 Build #2 (Fix B): pass MYT "today" so the per-date "hasn't started yet" gate uses Malaysia time
    // (mirrors requestLeaveAction). Import already present at the top of this file.
    await requestLeaveCancellation(session, { leaveRequestId, cancelDates, reason, today: todayInKualaLumpur() });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  revalidatePath('/approvals');
  revalidatePath('/'); // the dashboard's Team Away Today count
  revalidatePath('/leave/tracker'); // a00c4f64 — the calendar itself lives here now
  redirect('/leave?toast=cancellationRequested');
}

// HR Admin Leave Cancellation on behalf of an employee (feedback 22e68ff0). Immediate, no approval workflow:
// adminCancelLeave re-runs every gate server-side (HR-only, self-ban, pending|approved status, approved-
// REPLACEMENT block, closed-payroll block) so a stale form can't slip through. The `back` field lands the
// caller back where they started — '/leave/tracker' from the calendar, '/leave' from Leave Management — with the
// record list refreshed. We pass the real HR actor via cancelledByEmploymentId (deciderEmploymentId pattern).
export async function adminCancelLeaveAction(formData: FormData) {
  const session = await getSession();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  // Whitelist the return surface so a crafted form can't redirect off-app. fe3eb141 adds Employee
  // Leave Records, which selects its employee via `?emp=` — that id is carried back (re-validated as
  // a uuid here, never interpolated raw) so cancelling does not silently jump to another employee.
  const backRaw = String(formData.get('back') ?? '');
  const backEmp = String(formData.get('backEmp') ?? '');
  let back: string;
  // a00c4f64: the calendar's return surface is '/leave/tracker', not '/' — the dashboard no longer
  // renders it. An old form still posting '/' falls through to '/leave', which is a real page.
  if (backRaw === '/leave/tracker') back = '/leave/tracker';
  else if (backRaw === '/leave/employee-records') {
    back = /^[0-9a-f-]{36}$/i.test(backEmp)
      ? `/leave/employee-records?emp=${encodeURIComponent(backEmp)}`
      : '/leave/employee-records';
  } else back = '/leave';
  const withParam = (kv: string) => `${back}${back.includes('?') ? '&' : '?'}${kv}`;
  try {
    const me = await myEmployment(session);
    await adminCancelLeave(session, { leaveRequestId, reason, cancelledByEmploymentId: me?.employmentId });
  } catch (e) {
    redirect(withParam(`error=${encodeURIComponent(await localizeLeaveError(e))}`));
  }
  revalidatePath('/leave');
  revalidatePath('/leave/employee-records');
  revalidatePath('/approvals');
  revalidatePath('/'); // the dashboard's Team Away Today count
  revalidatePath('/leave/tracker'); // a00c4f64 — the calendar itself lives here now
  redirect(withParam('toast=adminCancelled'));
}

// Edit / cancel own leave by status (item c9a19e34): an employee edits or withdraws their OWN PENDING leave
// from the /leave history table. Both re-run every gate server-side (subject-only + status='pending'). The
// listLeaveTypes lookup supplies the localized type name for any validation error message.
export async function editLeaveAction(formData: FormData) {
  const session = await getSession();
  const leaveTypeId = String(formData.get('leaveTypeId'));
  const durationType = String(formData.get('durationType') || 'full_day') as LeaveDurationType;
  const fromTime = String(formData.get('fromTime') ?? '').trim();
  const toTime = String(formData.get('toTime') ?? '').trim();
  const locale = await getLocale();
  const types = await listLeaveTypes(session, { locale });
  const selected = types.find((t) => t.id === leaveTypeId);
  try {
    await editLeaveRequest(session, {
      leaveRequestId: String(formData.get('leaveRequestId')),
      leaveTypeId,
      startDate: String(formData.get('startDate')),
      endDate: String(formData.get('endDate')),
      reason: (formData.get('reason') as string) || undefined,
      employeeRemark: (formData.get('employeeRemark') as string) || undefined,
      durationType,
      fromTime: durationType === 'hourly' && fromTime !== '' ? fromTime : undefined,
      toTime: durationType === 'hourly' && toTime !== '' ? toTime : undefined,
      today: todayInKualaLumpur(),
    });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e, selected?.name))}`);
  }
  revalidatePath('/leave');
  redirect('/leave?toast=leaveUpdated');
}

export async function cancelOwnLeaveAction(formData: FormData) {
  const session = await getSession();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  try {
    await cancelOwnLeave(session, { leaveRequestId });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  revalidatePath('/approvals');
  revalidatePath('/leave/tracker'); // a00c4f64 — this action is also posted from the calendar's pills
  redirect('/leave?toast=leaveCancelled');
}

// Item r80 (Request subsection on Employee Details): `decideLeaveAction` used to live here — the Leave
// page's OWN approve/reject path, from the era when /leave rendered inline decide buttons. Consultant
// feedback #8/#10 removed those buttons (see the header comment on app/leave/page.tsx: "approvals live in
// the Approvals inbox"), but left this exported server action behind with no caller anywhere in the repo.
// Because every export of a 'use server' module is a callable endpoint, that vestige was still a second
// way IN to the leave decision — exactly the duplication the reporter asked to end. It is gone; leave is
// approved and rejected ONLY through Approval Items (app/approvals/actions.ts → core/leave decideLeave,
// single and bulk). Nothing else moved: the Requests table this page still carries has never held an
// approve or reject control — see the enumeration recorded in test/leave-requests-not-approvals.test.ts.

/**
 * 296fc027 · Submit an employee replacement-leave request.
 *
 * The form posts one repeated field per worked-date row (`workedDate`, plus `days` OR `fromTime`/`toTime`
 * depending on the unit), which is the plain HTML shape — `getAll` zips them back into rows by INDEX. That
 * is safe here because every row renders all of its own inputs unconditionally for the chosen unit, so the
 * arrays are the same length by construction; a row with a blank date is dropped before zipping so a
 * half-filled row cannot shift the alignment of the ones after it.
 *
 * EVERY CONTROL IS THE SERVICE'S. This action validates nothing about eligibility, the employee-request
 * switch or the First Schedule floor — it shapes the form data and lets core/replacement-request.ts refuse
 * it. That is deliberate: an action is one POST away from being called directly, so a check here would be
 * a check that can be skipped.
 */
export async function submitReplacementLeaveRequestAction(formData: FormData) {
  const session = await getSession();
  const unit = String(formData.get('unit') ?? 'day') === 'hour' ? ('hour' as const) : ('day' as const);
  const workedDates = formData.getAll('workedDate').map(String);
  const daysRaw = formData.getAll('days').map(String);
  const fromTimes = formData.getAll('fromTime').map(String);
  const toTimes = formData.getAll('toTime').map(String);

  const lines = workedDates
    .map((workedDate, i) => ({
      workedDate: workedDate.trim(),
      days: unit === 'day' ? Number(daysRaw[i] ?? 0) : undefined,
      fromTime: unit === 'hour' ? (fromTimes[i] ?? '').trim() : undefined,
      toTime: unit === 'hour' ? (toTimes[i] ?? '').trim() : undefined,
    }))
    .filter((l) => l.workedDate !== '');

  try {
    const employmentId = (await myEmployment(session))?.employmentId;
    if (!employmentId) throw new Error('No employment on record for this account.');
    await submitReplacementLeaveRequest(session, {
      employmentId,
      leaveTypeId: String(formData.get('leaveTypeId') ?? '') || null,
      unit,
      lines,
      reason: String(formData.get('reason') ?? '').trim() || undefined,
      firstScheduleConsent: formData.get('firstScheduleConsent') === 'on',
      today: todayInKualaLumpur(),
    });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
  revalidatePath('/leave');
  const t = await getTranslations('replacementRequest');
  redirect(`/leave?toast=${encodeURIComponent(t('submittedToast'))}`);
}

/**
 * 296fc027 · Decide one (line-manager approval only — `assertCanDecide`, never the multi-level chain).
 * Approving here is what MINTS the credits, with the expiry counted from this moment.
 */
export async function decideReplacementLeaveRequestAction(formData: FormData) {
  const session = await getSession();
  const requestId = String(formData.get('requestId') ?? '');
  const decision = String(formData.get('decision') ?? '') === 'approved' ? ('approved' as const) : ('rejected' as const);
  try {
    await decideReplacementLeaveRequest(session, {
      requestId,
      decision,
      note: String(formData.get('note') ?? '').trim() || undefined,
    });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
  revalidatePath('/leave');
  redirect('/leave');
}
