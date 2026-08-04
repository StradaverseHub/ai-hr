'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { changeEmploymentCompany, CompanyLockedError, DestinationCompanyNotAdministered, endReportingLine, setEmployeeCode, setEmploymentBlacklist, setEmploymentPaymentMethod, setEmploymentHolidayCalendar, setEmploymentInfo, setReportingLine, updatePerson, type EmploymentTypeValue, type HolidayCalendarSelection, type PaymentMethod, PAYMENT_METHODS } from '@/core/org';
import { PayModePeriodBoundaryError, setCompensation, supersedeCompensation, updateCompensation } from '@/core/comp';
import {
  createMovementEvent,
  editMovementEvent,
  isComparisonKind,
  MOVEMENT_FLAT_FIELDS,
  MovementNoChangeError,
  reverseMovementEvent,
  type MovementKind,
} from '@/core/movement';
import { reprojectEntitlementForEmployment } from '@/core/leave';
import { assignEmployeeShift } from '@/core/roster';
import { setEmployeeClockingLocations, setGeofencing } from '@/packs/attendance/service';
import { FixedTransactionAmountError, FixedTransactionDateError, setEmploymentPayComponent, UnsupportedFixedCurrencyError } from '@/core/pay-components';
import { setReviewEndDate, startReview, uploadReviewDocument, type ReviewType } from '@/core/employment-review';
import {
  addEmployeeDocument,
  deleteEmployeeDocument,
  replaceEmployeeDocumentContent,
  resolveDocumentUpload,
  updateEmployeeDocumentMeta,
} from '@/core/employee-documents';
import { buildReviewLetterPdf } from '@/lib/review-letter-build';
import { setPersonComplianceFields } from '@/core/profile';
import { removePersonPhoto, setPersonPhoto } from '@/core/person-photo';
import { packFor } from '@/localization/registry';
// Item d64d0df4 — the five LHDN s.48 child-relief categories, in the canonical order the grid renders.
// ADR-0080 D1/D7 — the five child-relief categories are read from core/dependents, NOT from the MY pack.
// They are the same five keys, but this is generic admin code: reaching into localization/my directly is
// what test/country-pack-drift.test.ts's ratchet forbids, and the ratchet caught it. The Family register
// stores these on employee_dependent, so core/dependents is their pack-neutral home; the MY pack's
// CHILD_RELIEF_CATEGORY_KEYS is the same list expressed for the ruleset side.
import { CHILD_RELIEF_CATEGORIES } from '@/core/dependents';
import { mapEpfUiMode } from '@/lib/epf-mode-map';

import { todayInKualaLumpur } from '@/lib/hr-date';

// Tab retention (feedback bd2f0bb2): the client tab shell (components/personnel-tabs.tsx) injects a hidden
// `tab` field into every submitting form. Each action appends `&tab=<key>` to its post-save redirect so the
// reloaded page lands back on the tab the user was editing instead of resetting to Profile. Absent/empty =
// legacy behaviour (no tab param → first tab). All these URLs already carry a `?`, so we always append `&`.
function withTab(formData: FormData, url: string): string {
  const tab = String(formData.get('tab') ?? '').trim();
  return tab ? `${url}&tab=${encodeURIComponent(tab)}` : url;
}

const REVIEW_TYPES: ReviewType[] = ['probation', 'contract', 'internship'];

/**
 * R45 7527ea5f — Automatic Leave Entitlement Recalculation. After a profile change that can move an
 * employee's leave entitlement (grade / grade group / employment type / confirmation status / hire date),
 * re-project their current-cycle entitlement and post a compensating adjustment + audit-history row (see
 * reprojectEntitlementForEmployment). Best-effort: the profile write has already committed, and the recalc
 * is idempotent + self-healing, so a hiccup here must never fail the save the admin just made. `trigger`
 * names the field that moved (recorded on the audit trail).
 */
async function recomputeEntitlement(
  s: Awaited<ReturnType<typeof requireAdmin>>,
  employmentId: string,
  trigger: string,
): Promise<void> {
  try {
    await reprojectEntitlementForEmployment(s, { employmentId, trigger });
  } catch {
    // non-fatal — idempotent, re-runs on the next profile trigger or policy edit.
  }
}

export async function setReviewEndDateAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const rawType = String(formData.get('reviewType') ?? '');
  const reviewType = (REVIEW_TYPES as string[]).includes(rawType) ? (rawType as ReviewType) : 'probation';
  try {
    await setReviewEndDate(s, { employmentId, reviewType, endDate: String(formData.get('endDate') || '') || null });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

export async function startReviewAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await startReview(s, { employmentId });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Review started`));
}

/** 6522d26a — derive a TRUSTWORTHY mime type from the file's leading bytes (fail-closed: unknown → null).
 *  Same rationale as the claims action: the service allowlist checks what the file IS, not what the
 *  browser claimed. */
function sniffMime(bytes: Buffer): string | null {
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

/** 6522d26a Fn 5 — HR uploads the final SIGNED review letter against a completed review. The service is
 *  admin-only, validates mime/size, and appends `employment-review.document-uploaded` with the session
 *  user as actor (actorOf(s) — the real user, never SYSTEM, threads through requireAdmin's session). */
export async function uploadReviewDocumentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const reviewId = String(formData.get('reviewId'));
  try {
    const file = formData.get('document');
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file to upload.');
    const content = Buffer.from(await file.arrayBuffer());
    const mimeType = sniffMime(content);
    if (!mimeType) throw new Error('Only PDF, JPG, or PNG files are allowed');
    await uploadReviewDocument(s, { reviewId, kind: 'signed_letter', fileName: file.name, mimeType, content });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Document uploaded`));
}

/** 6522d26a Fn 5 — persist the system-generated outcome letter to the review record (kind system_letter,
 *  at most one per review). Renders via the SAME builder as the download route, so the stored bytes match
 *  what HR previews. */
export async function saveReviewLetterAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const reviewId = String(formData.get('reviewId'));
  try {
    const letter = await buildReviewLetterPdf(s, reviewId);
    if (!letter) throw new Error('Review not found (or not completed).');
    await uploadReviewDocument(s, {
      reviewId,
      kind: 'system_letter',
      fileName: letter.fileName,
      mimeType: 'application/pdf',
      content: Buffer.from(letter.bytes),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Letter saved`));
}

// ── f018ce8d — Employee document store (Documents tab) ─────────────────────────────────────────────
// All admin-only (requireAdmin). Uploads/replacements sniff the file's magic bytes (resolveDocumentUpload)
// and cross-check them against the extension before the service re-validates against the allowlist — the
// browser-declared type is never trusted. The service appends the DomainEvent for every write.

export async function uploadEmployeeDocumentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    const title = String(formData.get('title') ?? '');
    if (!title.trim()) throw new Error('Document name / title is required.');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file to upload.');
    const content = Buffer.from(await file.arrayBuffer());
    const { mimeType } = resolveDocumentUpload(file.name, content); // fail-closed sniff + extension cross-check
    await addEmployeeDocument(s, {
      employmentId,
      title,
      category: String(formData.get('category') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
      fileName: file.name,
      mimeType,
      content,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Document uploaded`));
}

export async function updateEmployeeDocumentMetaAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    const title = String(formData.get('title') ?? '');
    if (!title.trim()) throw new Error('Document name / title is required.');
    await updateEmployeeDocumentMeta(s, {
      documentId: String(formData.get('documentId')),
      title,
      category: String(formData.get('category') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Document updated`));
}

export async function replaceEmployeeDocumentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a replacement file.');
    const content = Buffer.from(await file.arrayBuffer());
    const { mimeType } = resolveDocumentUpload(file.name, content);
    await replaceEmployeeDocumentContent(s, {
      documentId: String(formData.get('documentId')),
      fileName: file.name,
      mimeType,
      content,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Attachment replaced`));
}

export async function deleteEmployeeDocumentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await deleteEmployeeDocument(s, { documentId: String(formData.get('documentId')) });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Document deleted`));
}

export async function setEmploymentComponentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  // 1.2.1 Fixed Transaction — the prorate Select maps inherit/yes/no → null/true/false (null = inherit the
  // catalog flag). The effective end-date and remarks are optional; an empty value is normalised to null.
  const prorateRaw = String(formData.get('prorate') ?? 'inherit');
  const prorateOverride = prorateRaw === 'yes' ? true : prorateRaw === 'no' ? false : null;
  const effectiveTo = String(formData.get('effectiveTo') ?? '').trim() || null;
  const remarks = String(formData.get('remarks') ?? '').trim() || null;
  const currency = String(formData.get('currency') ?? 'MYR').trim() || 'MYR';
  try {
    await setEmploymentPayComponent(s, {
      employmentId,
      componentId: String(formData.get('componentId')),
      amount: Number(formData.get('amount')) || 0,
      effectiveFrom: String(formData.get('effectiveFrom')),
      effectiveTo,
      currency,
      prorateOverride,
      remarks,
    });
  } catch (e) {
    // Surface the typed validation errors as localised inline messages (people.detail.dateError /
    // currencyUnsupported / amountError); any other error falls back to its raw message via the same ?error= banner.
    const t = await getTranslations('people.detail');
    const msg =
      e instanceof FixedTransactionDateError
        ? t('dateError')
        : e instanceof UnsupportedFixedCurrencyError
          ? t('currencyUnsupported')
          : e instanceof FixedTransactionAmountError
            ? t('amountError')
            : (e as Error).message;
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent(msg)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/* r78c — transferAction (the department-only transfer) was DELETED here.
 *
 * It was an UNREFERENCED `use server` export: the Movement tab redesign (78853b97) folded the Transfer
 * card into New Event, and nothing on any page has posted to this action since. But every exported
 * `use server` function is a live RPC endpoint, and this one called transferEmployee UNTAGGED — writing
 * an `assignment.transferred` event, a MOVEMENT_EVENT_TYPE, with no movement tag, which the Employment
 * History projects as its own "Transfer" row with no movement behind it. That is the same
 * untagged-writer class as the reported Grade Change row, kept alive by an endpoint with no UI.
 *
 * Removed rather than left unreferenced, on the precedent 8ebabbf2 set when it deleted
 * setOrganisationAssignmentAction for exactly this reason. Transfer is recorded through
 * Movement → New Event → Transfer, which drives setEmploymentAssignment (carrying business unit, cost
 * centre and location) with a tagged, grouped write. */

/**
 * ADR-0054: set (or clear) an employee's Work Location, effective-dated (CLOSE+INSERT on assignment).
 *
 * r78c — routed through the MOVEMENT RECORDER. This action used to call transferEmployee directly,
 * emitting an untagged `assignment.transferred`; a Work Location change on the Attendance tab therefore
 * opened its own "Transfer" row on the Employment History with no movement behind it, and — if HR also
 * recorded a real movement that day — a second row beside it. createMovementEvent runs the same audited
 * writer inside the comparison-form dispatcher, so the leg now carries a movement tag and a groupId and
 * projects exactly ONE row.
 *
 * Three consequences of the reroute, all deliberate:
 *  · the write goes through setEmploymentAssignment, not transferEmployee — so it carries the business
 *    unit, cost centre and employment type forward (transferEmployee only ever carried a subset);
 *  · re-saving the SAME location is now a no-op instead of a fresh assignment version + event.
 *    MovementNoChangeError is swallowed to keep the save idempotent rather than surfacing an error the
 *    admin cannot act on;
 *  · an effective date BEFORE the current assignment version's valid-from is rejected by the writer
 *    (it always was on the Movement path; this screen previously bypassed that guard and inverted the
 *    dated range).
 */
export async function setLocationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await createMovementEvent(s, {
      employmentId,
      kind: 'transfer',
      effectiveDate: String(formData.get('effectiveDate')),
      // Present-but-blank clears the location; the field is always rendered by the card.
      locationId: (formData.get('locationId') as string) || null,
    });
  } catch (e) {
    // Choosing the location the employee already has is not an error — nothing to record, nothing to say.
    if (!(e instanceof MovementNoChangeError)) {
      redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
    }
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** R17 3e8350db — set the employee's shift ARRANGEMENT (the reporter's "Shift Type"): Fixed (a default
 *  shift is required and followed every working day) or Roster (no default shift; scheduled from /roster).
 *  Admin-gated, real actor via the session; assignEmployeeShift enforces the fixed⇒shift-required /
 *  roster⇒shift-cleared invariant so shift_type and default_shift_id never contradict. Localized toast on
 *  success, raw service message via ?error= on failure. */
export async function setDefaultShiftAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const rawType = String(formData.get('shiftType') ?? '').trim();
  const shiftType: 'fixed' | 'roster' = rawType === 'fixed' ? 'fixed' : 'roster';
  const rawShift = String(formData.get('shiftId') ?? '').trim();
  try {
    await assignEmployeeShift(s, { employmentId, shiftType, shiftId: rawShift || null });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  const t = await getTranslations('people.detail');
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=${encodeURIComponent(t('defaultShiftAssigned'))}`));
}

// ae9350f2 — `terminateAction` DELETED. It was an unreferenced but LIVE `use server` RPC endpoint: no UI
// called it, but an exported server action is callable by anyone who knows its id regardless. It called
// terminateEmployment directly, so it bypassed every rule this item just built — the mandatory last working
// day and coded reason, the "not already terminated" and future-movement checks, the payroll flag, the
// single-history-row tagging, and the deferral of a future-dated termination. Exactly the finding and
// exactly the disposal r78 applied to `transferAction`: the Movement module is the one door.

/**
 * Movement tab redesign (78853b97) — the single "New Event" save. Parses the movement kind + its
 * type-specific fields and hands them to core/movement.ts createMovementEvent, which delegates to the
 * existing audited writers (so DomainEvents, RLS and downstream payroll/leave sync are all inherited).
 * The leave-entitlement recompute mirrors what the existing per-card actions already do after a grade /
 * employment-type / confirmation change (R45 7527ea5f parity — best-effort, never fails the save).
 *
 * 08913328 — the Current/After comparison screen submits the WHOLE right column, so ABSENT and BLANK must
 * stay distinguishable all the way to the dispatcher: absent = the form does not offer the field (leave it
 * alone), blank = HR cleared it. `orNull` collapses both to null, which would read as "clear the Work
 * Location" on an event type that never showed it — hence `optional` below.
 */
function parseMovementForm(formData: FormData) {
  const kindRaw = String(formData.get('kind') ?? '').trim();
  // 476f23ed — the type may be one of the ORGANISATION's own (Movement Settings), so this can no longer be
  // an allowlist of the built-in kinds. It is a shape check only; core/movement.ts resolves the code
  // against the tenant's catalogue inside the transaction and refuses anything unknown or switched off.
  // That keeps ONE authority for what a type means, which is the whole point of the catalogue.
  if (!kindRaw) throw new Error('Select an event type.');
  /** absent → undefined (untouched); present-but-blank → null (explicit clear). */
  const optional = (name: string): string | null | undefined => {
    const v = formData.get(name);
    if (v == null) return undefined;
    return String(v).trim() || null;
  };
  const rawSalary = String(formData.get('basicSalary') ?? '').trim();
  const rawNoticeDays = String(formData.get('terminationNoticeDays') ?? '').trim();
  // ae9350f2 — the `terminationType` field is no longer parsed. The form does not post it and the
  // dispatcher would ignore it: the classification is derived from the reason code, in one place.
  const rawEmpType = String(formData.get('employmentType') ?? '').trim();
  const employmentType = EMPLOYMENT_TYPES.includes(rawEmpType as EmploymentTypeValue)
    ? (rawEmpType as EmploymentTypeValue)
    : undefined;
  return {
    kind: kindRaw as MovementKind,
    effectiveDate: String(formData.get('effectiveDate') ?? '').trim(),
    endDate: orNull(formData.get('endDate')),
    remarks: orNull(formData.get('remarks')),
    departmentId: optional('departmentId'),
    positionId: optional('positionId'),
    businessUnitId: optional('businessUnitId'),
    locationId: optional('locationId'),
    // gradeId: absent field = grade side untouched; present-but-blank = clear.
    gradeId: optional('gradeId'),
    employmentType,
    managerEmploymentId: optional('managerEmploymentId'),
    basicSalary: rawSalary === '' ? undefined : Number(rawSalary),
    currency: optional('currency') ?? undefined,
    payMode: optional('payMode') ?? undefined,
    paymentTerm: optional('paymentTerm') ?? undefined,
    // The flat, non-dated org columns the comparison screen now carries (Division … Category).
    ...Object.fromEntries(MOVEMENT_FLAT_FIELDS.map((f) => [f, optional(f)])),
    // ae9350f2 — the Termination movement's structured exit fields. The reason CODE is the only thing the
    // form posts for classification: core/movement.ts validates it against the built-in catalogue and
    // derives `terminationType` from it, so the two can never be submitted in contradiction.
    terminationReasonCode: optional('terminationReasonCode'),
    terminationNoticeDays: rawNoticeDays === '' ? undefined : Number(rawNoticeDays),
    resignationDate: optional('resignationDate'),
    blacklisted: String(formData.get('blacklisted') ?? 'true') !== 'false',
  };
}

export async function createMovementEventAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  /** ae9350f2 — 'YYYY-MM' payroll periods a backdated termination lands inside. Reported, never adjusted. */
  let payrollFlagged: string[] = [];
  try {
    const p = parseMovementForm(formData);
    const res = await createMovementEvent(s, { employmentId, ...p });
    if (res && 'payrollFlaggedPeriods' in res && Array.isArray(res.payrollFlaggedPeriods)) {
      payrollFlagged = res.payrollFlaggedPeriods as string[];
    }
    // Grade, employment type and the org placement all feed benefit-scheme / grade-scoped entitlement
    // resolution, and any comparison-kind movement can now move them in one submit — so recompute for the
    // whole comparison set rather than the three kinds that used to own those fields.
    // 89ea527b — groupJoinDateCorrection MUST be in this set. The Group Join Date is employment.hired_on,
    // which is what core/leave.ts's service bands and minimum-service gates read, so moving it moves leave
    // entitlement. Before this item that recompute happened because the date was edited through
    // setEmploymentInfoAction (which always recomputes); now the movement is the only writer, and omitting
    // it here would leave the employee on a stale band with no visible symptom. joinDateChange is NOT in
    // the set: join_date feeds no entitlement path (verified — its only consumers are the employeeDetail
    // projection and the Employment tab's current-company service label).
    // ae9350f2 — `termination` MUST be in this set, and the reason is symmetry rather than a new feature.
    // The leave kernel already caps a first-year a2c entitlement at `terminatedOn` (core/leave.ts's
    // serviceEnd), and the SWEEP already recomputes after every scheduled movement it applies — so a
    // termination that took effect via the cron got a recomputed entitlement while one keyed for today did
    // not, until some unrelated trigger happened to fire. Best-effort and idempotent, exactly as the other
    // kinds are. This is NOT the leave PAYOUT, which the approved plan defers to the final-settlement step.
    if (
      isComparisonKind(p.kind) ||
      p.kind === 'confirmation' ||
      p.kind === 'probationExtension' ||
      p.kind === 'groupJoinDateCorrection' ||
      p.kind === 'termination'
    ) {
      await recomputeEntitlement(s, employmentId, 'movement_recorded');
    }
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  // ae9350f2 — the approved plan's promise about a backdated termination: where a payroll run has already
  // been processed past the termination date we FLAG it rather than silently adjust a completed run. The
  // termination itself is saved and correct; what needs a human is the run.
  if (payrollFlagged.length) {
    const t = await getTranslations('people.detail.movement');
    redirect(
      withTab(
        formData,
        `/admin/personnel/${employmentId}?toast=${encodeURIComponent(
          t('form.terminationPayrollFlag', { periods: payrollFlagged.join(', ') }),
        )}`,
      ),
    );
  }
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * 66a63bd6 — the Employment History Edit save. Same form, same parse; the service rolls the movement back
 * and replays it through the same writers, so the corrected event inherits every guard the New Event path
 * has. The entitlement recompute mirrors the create action: a correction can move grade, employment type
 * or the org placement just as the original did.
 */
export async function editMovementEventAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    const p = parseMovementForm(formData);
    await editMovementEvent(s, {
      employmentId,
      movementId: String(formData.get('movementId') ?? '').trim(),
      reason: orNull(formData.get('reason')),
      ...p,
    });
    if (isComparisonKind(p.kind)) await recomputeEntitlement(s, employmentId, 'movement_recorded');
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * 66a63bd6 — the Employment History Delete (Rollback). The event is NOT removed from the ledger: the
 * movement stops applying, the employee's record goes back to the previous valid state, and the row stays
 * on the history marked reversed (the approved shape for decision item 9064cffb).
 */
export async function reverseMovementEventAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await reverseMovementEvent(s, {
      employmentId,
      movementId: String(formData.get('movementId') ?? '').trim(),
      reason: orNull(formData.get('reason')),
    });
    await recomputeEntitlement(s, employmentId, 'movement_recorded');
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** Direct Superior (dce55aff) — the Reporting Lines management UI is replaced by ONE field. Saving
 *  writes the administrative reporting line through the existing service path: setReportingLine
 *  supersedes (CLOSE + INSERT) any prior active admin line, refuses self-assignment and cycles
 *  (ReportingCycleError), and appends the reporting-line.set / .superseded DomainEvents — so the full
 *  audit trail (previous superior, new superior, actor, timestamp) is preserved without effort.
 *  Effective-dating stays internal: validFrom is always "today". An EMPTY selection clears the
 *  current superior (the employee becomes a hierarchy top) via endReportingLine. Line types
 *  functional/project/dotted are no longer maintainable from this screen. */
export async function setDirectSuperiorAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const superiorEmploymentId = String(formData.get('superiorEmploymentId') ?? '').trim();
  const currentSuperiorEmploymentId = String(formData.get('currentSuperiorEmploymentId') ?? '').trim();
  const currentLineId = String(formData.get('currentLineId') ?? '').trim();
  const today = todayInKualaLumpur();
  try {
    if (superiorEmploymentId === currentSuperiorEmploymentId) {
      // No change — skip the write so the audit trail records only genuine superior moves.
    } else if (superiorEmploymentId === '') {
      if (currentLineId) await endReportingLine(s, { reportingLineId: currentLineId, endDate: today });
    } else {
      await setReportingLine(s, {
        subordinateEmploymentId: employmentId,
        managerEmploymentId: superiorEmploymentId,
        lineType: 'administrative',
        validFrom: today,
        // 30325fc1 — TAG THIS WRITE. Employment History now requires a movement tag on every generic
        // writer's event (core/movement.ts projectRows), because an untagged event is an ordinary edit and
        // the fallback labels that invented a kind for one are gone. Direct Superior is the one generic
        // writer r78 deliberately left outside the Movement module (the CLEAR path emits
        // `reporting-line.ended`, not a movement event type, so routing only the SET path through Movement
        // would remove the only way to clear a superior). Tagging it at source keeps the Reporting Line
        // Change row it has always produced — now backed by a recorded intent instead of a guess — without
        // touching the clear path. This EXTENDS r78's tagging; it untags nothing.
        movement: { type: 'reportingLineChange', groupId: randomUUID() },
      });
    }
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** Hierarchy Management (ADR-0052): create an approval delegation FROM this employment (the delegator
 *  going on leave) TO a stand-in delegate, windowed by valid-from/valid-to. Reuses setReportingLine with
 *  lineType 'delegate' — inheriting the bitemporal window, supersede, events, and RLS. */
export async function addDelegationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setReportingLine(s, {
      subordinateEmploymentId: employmentId, // the delegator
      managerEmploymentId: String(formData.get('delegateEmploymentId')), // the stand-in
      lineType: 'delegate',
      validFrom: String(formData.get('validFrom')),
      validTo: String(formData.get('validTo') ?? '').trim() || null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** End an active delegation early (ADR-0052) — reuses endReportingLine (events + RLS). */
export async function endDelegationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await endReportingLine(s, {
      reportingLineId: String(formData.get('reportingLineId')),
      endDate: String(formData.get('endDate')),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** ADR-0078 — a pay-mode change off a period boundary maps to the localized message (the service throws a
 *  typed error so the toast is not raw English for the one rule an admin will actually hit). */
async function payModeErrorMessage(e: unknown): Promise<string> {
  if (e instanceof PayModePeriodBoundaryError || (e as Error)?.name === 'PayModePeriodBoundaryError') {
    const t = await getTranslations('people.detail');
    return t('payModeBoundaryError');
  }
  return (e as Error).message;
}

/* r78c — why the Basic Salary screen is NOT routed through the movement recorder, unlike Work Location.
 * It is the only writer of a FIRST salary record, and the only one that can move pay MODE, payment term
 * and rate_amount (a daily/hourly re-rating). applyComparisonMovementTx deliberately refuses a
 * structure-only change without an existing record and carries no rate_amount at all, so routing this
 * screen through it would remove both capabilities to fix a row that was never duplicated: an untagged
 * `compensation.set` projects ONE truthful "Salary Adjustment" row, not a second row beside a movement.
 * It is tagged below instead, which changes no label and no row count. */
export async function setCompensationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    // ADR-0078 — the salary structure rides the same revision form. The three fields are always posted by
    // the redesigned form; older/partial posts (absent keys) fall through to the service's carry-forward.
    const payModeRaw = String(formData.get('payMode') ?? '').trim();
    const paymentTermRaw = String(formData.get('paymentTerm') ?? '').trim();
    const rateRaw = String(formData.get('rateAmount') ?? '').trim();
    // 297ae65a — the salary currency (ISO 4217 code from the searchable select). An empty/absent value
    // falls through to the service's carry-forward (keeps the prior record's currency; MYR for a first
    // record), so a cleared select can never blank the stored currency.
    const currencyRaw = String(formData.get('currency') ?? '').trim();
    await setCompensation(s, {
      employmentId,
      basicSalary: Number(formData.get('basicSalary')),
      currency: currencyRaw || undefined,
      // Allowance is no longer maintained on the Basic Salary screen (feedback 87c82b18) — allowances
      // belong to Pay Components. Omitting it CARRIES the existing figure forward (never wipes it).
      remarks: String(formData.get('remarks') ?? '').trim() || undefined,
      payMode: payModeRaw || undefined,
      paymentTerm: paymentTermRaw || undefined,
      // A posted-but-empty rate on a non-monthly mode must NOT silently carry the old rate forward — the
      // admin cleared it, so pass null and let the service validate the mode/rate pair.
      rateAmount: payModeRaw ? (rateRaw !== '' ? Number(rateRaw) : null) : undefined,
      effectiveFrom: String(formData.get('effectiveFrom')),
      // r78c — the Basic Salary screen KEEPS its own writer (see the note above the action) but no longer
      // writes an untagged `compensation.set`. The tag names the same kind the projection already fell
      // back to, so the row's label is unchanged; what it adds is a groupId, so the leg is correlated
      // rather than loose, and every projected event this screen emits is accounted for.
      movement: { type: 'salaryAdjustment', groupId: randomUUID() },
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent(await payModeErrorMessage(e))}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Edit Salary Record (feedback 87c82b18, flow #4; widened for 7c7c2f80). Corrects the basic salary,
 * remarks and/or EFFECTIVE DATE of an existing OPEN salary row (latest active or future-effective).
 * The service enforces immutability of historical rows, the no-overlap and closed-payroll-period rules
 * for date moves, and appends the compensation.updated audit event; the screen re-derives
 * increment/status.
 */
export async function editCompensationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    const rawBasic = formData.get('basicSalary');
    const rawBasicStr = String(rawBasic ?? '').trim();
    const rawFrom = String(formData.get('effectiveFrom') ?? '').trim();
    // ADR-0078 — the edit form posts the pay structure too; the service records only real changes and
    // enforces the period-boundary + processed-period rules on a pay-mode change.
    const payModeRaw = String(formData.get('payMode') ?? '').trim();
    const paymentTermRaw = String(formData.get('paymentTerm') ?? '').trim();
    const rateRaw = String(formData.get('rateAmount') ?? '').trim();
    // 297ae65a — currency rides the edit form too; empty ⇒ untouched (the service records only real changes).
    const currencyRaw = String(formData.get('currency') ?? '').trim();
    await updateCompensation(s, {
      compensationId: String(formData.get('compensationId')),
      employmentId,
      basicSalary: rawBasicStr !== '' ? Number(rawBasicStr) : undefined,
      currency: currencyRaw || undefined,
      // Remarks always submitted (possibly empty → cleared to NULL).
      remarks: String(formData.get('remarks') ?? '').trim() || null,
      payMode: payModeRaw || undefined,
      paymentTerm: paymentTermRaw || undefined,
      // Cleared rate posts as null (the service rejects a null rate on a daily/hourly row).
      rateAmount: payModeRaw ? (rateRaw !== '' ? Number(rateRaw) : null) : undefined,
      // Effective date (7c7c2f80): submitted by the edit form; the service no-ops when unchanged.
      validFrom: rawFrom !== '' ? rawFrom : undefined,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent(await payModeErrorMessage(e))}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Delete Salary Record (7c7c2f80) — SOFT delete via supersedeCompensation: the row is hidden from the
 * screen and from payroll resolution (the previous record reopens), never physically erased, so a
 * closed payslip's justification survives for audit. The service (and the 0277 DB trigger) refuse when
 * the record's window overlaps a CLOSED payroll run for this employee. Confirmation-gated in the UI.
 */
export async function supersedeCompensationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await supersedeCompensation(s, {
      compensationId: String(formData.get('compensationId')),
      employmentId,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** Parse the unified "Holiday calendar" selector value into a discriminated selection. The single field
 *  emits `""` (company default), `"state:<label>"` (a built-in state), or `"group:<id>"` (an HR group),
 *  so a save of unrelated fields re-submits the existing selection rather than nulling it (clobber closed). */
function parseHolidayCalendar(raw: FormDataEntryValue | null): HolidayCalendarSelection {
  const v = String(raw ?? '');
  if (v.startsWith('group:')) return { kind: 'group', groupId: v.slice('group:'.length) };
  if (v.startsWith('state:')) return { kind: 'state', state: v.slice('state:'.length) };
  return { kind: 'none' };
}

/** Normalise a text form field to `string | null` (empty → null). */
const orNull = (v: FormDataEntryValue | null): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

export async function setPersonAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updatePerson(s, {
      personId: String(formData.get('personId')),
      fullName: String(formData.get('fullName') ?? ''),
      primaryEmail: String(formData.get('primaryEmail') ?? ''),
      phone: (formData.get('phone') as string) || null,
      // b4682879 Personal Details — new independent name parts + PDPA-sensitive demographics.
      // 8c284478 — Salutation (catalog-backed dropdown before Full Name; blank allowed → null).
      salutation: orNull(formData.get('salutation')),
      firstName: orNull(formData.get('firstName')),
      lastName: orNull(formData.get('lastName')),
      preferredName: orNull(formData.get('preferredName')),
      religion: orNull(formData.get('religion')),
      race: orNull(formData.get('race')),
      nationality: orNull(formData.get('nationality')),
    });
    // Employee ID (feedback 38668d9b): HR keys/corrects the company's real staff ID on the identity card.
    // The service validates + tenant-uniqueness-checks and no-ops when unchanged (no spurious event).
    await setEmployeeCode(s, {
      employmentId,
      employeeCode: String(formData.get('employeeCode') ?? ''),
    });
    // Item 52a30630 — Holiday Calendar RELOCATED to the Attendance tab (setEmploymentHolidayCalendarAction)
    // and Grade RELOCATED to the Leave tab (setEmploymentGradeAction). Their selects no longer live on this
    // Personal Details form, so the previously-unconditional writes here are DELETED: keeping them would read
    // the now-absent fields as null/'' and WIPE both employment columns on every Personal Details save. The
    // two target-tab forms own those writes now.
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Item 52a30630 — save ONLY the Holiday Calendar for an employment. The unified Holiday Calendar selector
 * was RELOCATED off the Profile > Personal Details form onto the Attendance tab (HTML forms can't span the
 * tab panels), so it needs its own thin partial-save action. Mirrors the write that previously lived inline
 * in setPersonAction: parse the unified value (state OR HR-defined group) and hand it to the audited service
 * (setEmploymentHolidayCalendar appends the DomainEvent). requireAdmin gates it like the profile actions.
 */
export async function setEmploymentHolidayCalendarAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setEmploymentHolidayCalendar(s, {
      employmentId,
      selection: parseHolidayCalendar(formData.get('holidayCalendar')),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/* r78c — setEmploymentGradeAction (item 52a30630) was DELETED here. This is the writer the reporter's
 * duplicate row came from.
 *
 * It was the Leave tab's one-field Job Grade save, calling setEmploymentGrade directly. That service
 * emits `employment.grade.changed`, a MOVEMENT_EVENT_TYPE, and this caller emitted it with NO movement
 * tag — so core/movement.ts fell back to `kind: 'gradeChange'` and projected a SECOND Employment History
 * row, "Grade Change", beside the Promotion that carried the same grade change as a tagged leg. One
 * movement, two rows. 8ebabbf2 recorded the caveat in-code when it made the Employment tab view-only;
 * this item closes it.
 *
 * Job Grade now changes ONLY through Movement → New Event (Promotion / Demotion / Organisation
 * Assignment Change), whose comparison writer tags the grade leg with the movement's groupId. The Leave
 * tab still SHOWS the grade — it drives grade-scoped leave entitlement, so the number belongs on that
 * screen — but read-only, with a link to Movement.
 *
 * The action is deleted rather than left unreferenced for the reason 8ebabbf2 gave: every exported
 * `use server` function is a live RPC endpoint, so an unreferenced one is still a fully working untagged
 * writer callable by anything that knows its id.
 *
 * R45 7527ea5f parity is preserved: this action's grade-change entitlement recompute is already covered
 * on the Movement path — createMovementEventAction recomputes for every comparison kind, which is every
 * kind that can move a grade. */

/**
 * b4682879 Contact & Address — instant-write of the structured home address + personal email + phone via
 * the same one writer (updatePerson). fullName is carried through as a hidden field (updatePerson keeps
 * name/email notNull), so saving contact info never wipes the identity.
 *
 * 3a25f5ee — the single structured address is now TWO independent blocks: Permanent + Correspondence (7
 * fields each). The legacy addressLine1..country columns are no longer written here (retained for rollback,
 * left unchanged since updatePerson only touches fields present on the payload). `addressCopyVia` is an
 * optional provenance marker set by the "Same as Permanent Address" client island — recorded on the audit
 * event as HOW the save happened, never any address VALUE (PDPA).
 */
export async function setContactAddressAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const via = String(formData.get('addressCopyVia') ?? '') === 'copy-permanent' ? 'copy-permanent' : undefined;
  try {
    await updatePerson(s, {
      personId: String(formData.get('personId')),
      fullName: String(formData.get('fullName') ?? ''),
      primaryEmail: String(formData.get('primaryEmail') ?? ''),
      phone: orNull(formData.get('phone')),
      // bf953339 — `phone` IS the Mobile Phone Number (label-only rename); homePhone joins it in Contact &
      // Address, and the Correspondence block carries its OWN mobile/home pair. All three are presence-gated
      // profile fields (like personalEmail), so sibling forms that omit them can never clobber them.
      homePhone: orNull(formData.get('homePhone')),
      correspondenceMobilePhone: orNull(formData.get('correspondenceMobilePhone')),
      correspondenceHomePhone: orNull(formData.get('correspondenceHomePhone')),
      personalEmail: orNull(formData.get('personalEmail')),
      via,
      permanentAddressLine1: orNull(formData.get('permanentAddressLine1')),
      permanentAddressLine2: orNull(formData.get('permanentAddressLine2')),
      permanentAddressLine3: orNull(formData.get('permanentAddressLine3')),
      permanentPostcode: orNull(formData.get('permanentPostcode')),
      permanentCity: orNull(formData.get('permanentCity')),
      permanentState: orNull(formData.get('permanentState')),
      permanentCountry: orNull(formData.get('permanentCountry')),
      correspondenceAddressLine1: orNull(formData.get('correspondenceAddressLine1')),
      correspondenceAddressLine2: orNull(formData.get('correspondenceAddressLine2')),
      correspondenceAddressLine3: orNull(formData.get('correspondenceAddressLine3')),
      correspondencePostcode: orNull(formData.get('correspondencePostcode')),
      correspondenceCity: orNull(formData.get('correspondenceCity')),
      correspondenceState: orNull(formData.get('correspondenceState')),
      correspondenceCountry: orNull(formData.get('correspondenceCountry')),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * HR/Admin sets the compliance-sensitive identity fields (gender, marital status, date of birth) that
 * drive leave eligibility (Wave 2A-1) and age-band statutory (EPF/SOCSO). Routed through the audited
 * setPersonComplianceFields path, NOT the instant-write updatePerson — ADR-0012 refinement #24 / b4682879.
 * A blank select or date input ("") is an explicit clear-to-null. Marital status here does NOT change the
 * PCB/tax bracket (a separate statutory field) — surfaced on-screen.
 */
export async function setComplianceFieldsAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setPersonComplianceFields(s, {
      employmentId,
      gender: (formData.get('gender') as string) || null,
      maritalStatus: (formData.get('maritalStatus') as string) || null,
      dateOfBirth: (formData.get('dateOfBirth') as string) || null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Employment Information enhancement (2323f671) — HR/Admin saves the employment master-data card on the
 * Employment tab (hire date + probation/notice periods, confirmation/resignation dates, org dimensions,
 * category). Mirrors setComplianceFieldsAction: requireAdmin, one audited service writer, ?error redirect
 * on failure, ?toast=Saved on success (landing back on the same tab via withTab). A blank input is an
 * explicit clear-to-null; number inputs come through as strings and are parsed/validated in the service.
 */
export async function setEmploymentInfoAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  // Helper: a present-but-blank field is an explicit clear (null); an ABSENT field is untouched (undefined).
  //
  // c5ac75fa — the absent → `undefined` leg is load-bearing now. This form used to carry the eight flat org
  // columns (orgDivision … employmentCategory) as well as the dates; the Organisation Assignment merge moved
  // them onto the consolidated assignment form, so they no longer appear in THIS submission. setEmploymentInfo
  // reads `undefined` as "leave as-is" but `null` as "clear to NULL", so returning null for an absent field
  // would make every Employment Dates save silently wipe all eight org values.
  const str = (name: string): string | null | undefined => {
    const v = formData.get(name);
    if (v == null) return undefined;
    const t = String(v).trim();
    return t === '' ? null : t;
  };
  try {
    await setEmploymentInfo(s, {
      employmentId,
      // 89ea527b — hiredOn (Group Join Date) and joinDate are deliberately NOT read from this form. Both
      // left the Employment Dates card and are now movement-only: Group Join Date Correction writes
      // hiredOn, Join Date Change writes joinDate, and setEmploymentInfo ignores either field unless the
      // call carries the matching movement tag. Not reading them here means a forged field by that name
      // is dropped twice over — the Employment tab has no path to the two service dates at all.
      probationMonths: str('probationMonths'),
      probationDays: str('probationDays'),
      confirmationDate: str('confirmationDate'),
      resignationNoticeMonths: str('resignationNoticeMonths'),
      resignationNoticeDays: str('resignationNoticeDays'),
      resignationDate: str('resignationDate'),
      shortNoticeMonths: str('shortNoticeMonths'),
      shortNoticeDays: str('shortNoticeDays'),
      // 955c7de4 — redesigned value+unit periods + new lifecycle dates. finalConfirmationDate is derived
      // server-side, never submitted.
      // d27961e3 — extendedConfirmationDate is deliberately NOT read from the form: Extended/Final
      // Confirmation Date left the Employment Dates card, and probation extensions are managed exclusively
      // through the Movement module (createMovementEventAction → 'probationExtension'). A forged form field
      // by that name is ignored here AND by setEmploymentInfo (movement-tag gated).
      probationValue: str('probationValue'),
      probationUnit: str('probationUnit'),
      extendedProbationValue: str('extendedProbationValue'),
      extendedProbationUnit: str('extendedProbationUnit'),
      noticeBeforeConfirmationValue: str('noticeBeforeConfirmationValue'),
      noticeBeforeConfirmationUnit: str('noticeBeforeConfirmationUnit'),
      noticeAfterConfirmationValue: str('noticeAfterConfirmationValue'),
      noticeAfterConfirmationUnit: str('noticeAfterConfirmationUnit'),
      tenderResignationDate: str('tenderResignationDate'),
      lastWorkingDate: str('lastWorkingDate'),
      // 8590615a — the Contract Information block. It is rendered ONLY for an employee whose current open
      // assignment is 'contract', so for everybody else these three are absent from the FormData and `str`
      // maps them to `undefined` (untouched) — which is also what stops setEmploymentInfo's
      // both-dates-required check from firing on a non-contract save. contractEndDate is the pre-existing
      // employment-review column, written here on purpose so the two screens share one date.
      contractStartDate: str('contractStartDate'),
      contractEndDate: str('contractEndDate'),
      contractRemark: str('contractRemark'),
      // c5ac75fa / 8ebabbf2 — the eight flat org columns (orgDivision/orgBranch/orgRegion/orgLine/orgSection/
      // orgTeam/orgBase/employmentCategory) are NOT written here. They were owned by
      // setOrganisationAssignmentAction, which 8ebabbf2 deleted along with the editable Organisation
      // Assignment form; their sole writer is now core/movement.ts's comparison-form leg. This action covers
      // the Employment Dates group only — and, since 89ea527b, not its two join dates either.
    });
    // R45 7527ea5f — confirmation date drives probation-eligibility entitlement; recompute the current cycle
    // when it changes. (The hire date drives service bands but no longer reaches this action — a Group Join
    // Date Correction goes through createMovementEvent → setEmploymentInfo instead.)
    await recomputeEntitlement(s, employmentId, 'employment_info_changed');
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/* 8ebabbf2 — setOrganisationAssignmentAction (c5ac75fa) was DELETED here. It was the single Save behind the editable Organisation Assignment section on the Employment
 * tab, fanning out to setEmploymentAssignment (Business Unit / Department / Position / Employment Type,
 * effective-dated) + setEmploymentGrade (Job Grade) + setEmploymentInfo (the eight flat org columns) in one
 * transaction. That section is now VIEW-ONLY: every one of those fields changes through Movement -> New Event,
 * whose comparison-form writer (core/movement.ts applyComparisonMovementTx) drives the SAME three services,
 * with the same guards, in the same one transaction, and additionally tags the legs with one groupId so the
 * change projects exactly one Employment History row.
 *
 * The action is removed rather than merely unreferenced, for the reason c5ac75fa itself gave when it deleted
 * setEmploymentAssignmentAction: every exported `use server` function is a live RPC endpoint. Leaving this one
 * exported would keep a fully working, untagged, effective-dated assignment writer callable by anything that
 * knows its id -- writing history-visible events with no movement tag, which is precisely the duplicate
 * Employment History row r76 reported. Nothing else referenced it: the only call site was the form on
 * app/admin/personnel/[employmentId]/page.tsx, which this item replaced with read-only fields.
 *
 * EMPLOYMENT_TYPES stays: parseMovementForm (the Movement New Event / Edit parser) uses it to reject a
 * tampered employment-type value, which is now the only remaining submitter of that field. */
const EMPLOYMENT_TYPES: readonly EmploymentTypeValue[] = ['full_time', 'part_time', 'contract', 'intern'];

/**
 * Personnel — Company change before any transaction (feedback 9464bd56). Commits phase 2 of the inline
 * company correction: the destination company (chosen in phase 1, carried as the hidden `newCompanyId`) plus
 * the Department (required) and any position / business unit the admin re-picked, in ONE audited transaction
 * (core changeEmploymentCompany, which re-runs the pre-transaction gate server-side). Follows
 * setOrganisationAssignmentAction: requireAdmin, withTab redirect surfacing the error, revalidatePath,
 * toast=Saved. Two typed errors get their own localized copy: DestinationCompanyNotAdministered (the actor
 * does not manage the destination) and CompanyLockedError (a transaction landed since render → steer to
 * Movement).
 */
export async function changeEmploymentCompanyAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const t = await getTranslations('people.detail');
  const newCompanyId = String(formData.get('newCompanyId') ?? '').trim();
  const departmentId = String(formData.get('departmentId') ?? '').trim();
  // A present-but-blank value clears; absent maps the same way (these are all rendered on the phase-2 form).
  const optional = (name: string): string | null => {
    const v = formData.get(name);
    const trimmed = v == null ? '' : String(v).trim();
    return trimmed === '' ? null : trimmed;
  };
  if (!newCompanyId || !departmentId) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent(t('employmentInfo.invalidValue'))}`));
  }
  try {
    await changeEmploymentCompany(s, {
      employmentId,
      newCompanyId,
      departmentId,
      positionId: optional('positionId'),
      businessUnitId: optional('businessUnitId'),
      costCenterId: optional('costCenterId'),
      locationId: optional('locationId'),
    });
    // Company-scoped country pack / leave floor may move the employee's entitlement — best-effort reproject.
    await recomputeEntitlement(s, employmentId, 'company_changed');
  } catch (e) {
    if (e instanceof DestinationCompanyNotAdministered) {
      redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent(t('employmentInfo.destinationNotAdministered'))}`));
    }
    if (e instanceof CompanyLockedError) {
      redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent(t('employmentInfo.companyLockedNote'))}`));
    }
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Employee Status redesign (R43 c26c3ce5) — set/clear the Blacklist override (the one manual, audited
 * exception status on top of the otherwise date-derived Employee Status). Admin-gated (requireAdmin + the
 * service re-checks the role); routes to setEmploymentBlacklist which emits the audit event.
 */
export async function setEmploymentBlacklistAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const blacklisted = String(formData.get('blacklisted') ?? '') === 'true';
  const reason = blacklisted ? (String(formData.get('reason') ?? '').trim() || null) : null;
  try {
    await setEmploymentBlacklist(s, { employmentId, blacklisted, reason });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * R46 79eb7151 — set the employee's Payment Method (Bank Transfer / Cheque / Cash) from the Salary section of
 * the Payroll tab. Blank clears it back to "not specified". Admin-gated (requireAdmin + the service re-checks
 * the role); routes to setEmploymentPaymentMethod, which enforces the bank-transfer-needs-bank-details
 * invariant and emits `employment.payment-method.changed`. A MissingBankForTransferError surfaces through the
 * standard ?error= toast, so HR is told exactly what is missing instead of silently saving an unpayable row.
 */
export async function setPaymentMethodAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const raw = String(formData.get('paymentMethod') ?? '').trim();
  // A present-but-unrecognised value is a tampered/stale submit — reject rather than silently ignore
  // (same posture as setEmploymentAssignmentAction's employmentType guard).
  if (raw !== '' && !(PAYMENT_METHODS as readonly string[]).includes(raw)) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent('Payment method is invalid.')}`));
  }
  try {
    await setEmploymentPaymentMethod(s, {
      employmentId,
      paymentMethod: raw === '' ? null : (raw as PaymentMethod),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * b4682879 §1.5 — upload / replace an employee's profile photo (admin-gated via requireAdmin + RLS
 * person_photo write = is_admin()). The mime is re-derived from the file's leading bytes (sniffMime,
 * accept only jpeg/png here — never trust the browser); size ≤ 2 MB is enforced in the service too.
 */
export async function setPersonPhotoAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  try {
    const file = formData.get('photo');
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose an image to upload.');
    const content = Buffer.from(await file.arrayBuffer());
    const mimeType = sniffMime(content);
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
      throw new Error('Only PNG or JPG images are allowed');
    }
    await setPersonPhoto(s, { personId, content, fileName: file.name, mimeType, sizeBytes: content.byteLength });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** b4682879 §1.5 — remove an employee's profile photo (admin-gated, no-op-safe). */
export async function removePersonPhotoAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  try {
    await removePersonPhoto(s, { personId });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

export async function setStatutoryAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  const pack = packFor('MY');
  try {
    if (!pack) throw new Error('No localization pack for MY');
    // Zakat election RELOCATED to Payroll > Transactions > Zakat (feedback 58755260): this form no
    // longer carries zakat fields, but the setter is a FULL overwrite of the statutory row — so read
    // the current election and pass it through unchanged. Without this, every Personnel statutory
    // save would silently wipe an existing election (resolveZakatElection treats absent as inactive).
    const current = await pack.statutory.get(s, personId);
    // Item 8b5334db — IC + the tax fields (taxNumber/taxCategory/numChildren/residency) were split out of this
    // full-row statutory form onto the Profile tab (IC → setIcAction) and the dedicated Identification & Tax card
    // (tax → setTaxAction). This form no longer carries those inputs, but setStatutoryProfileMY is a FULL overwrite
    // of the columns it writes — so read the stored values and pass them through unchanged (same pass-through trap
    // the bank/TP3/zakat fields already guard against). The three NEW columns (taxResidency/childReliefMode/
    // employerBearsTax) are NOT in setStatutoryProfileMY's write set, so they are untouched here regardless.
    if (!current) throw new Error('Save the IC number on the Profile tab first, then the EPF / SOCSO details.');
    // Item e3ce0d4d — icNumber is now nullable (non-Malaysian rows are passport-identified). This full-row
    // EPF/SOCSO overwrite still requires a Malaysian IC; coerce a null to '' so setStatutoryProfileMY's IC
    // validation surfaces the "save the IC first" error rather than a type break.
    const icNumber = current.icNumber ?? '';
    await pack.statutory.set(s, {
      personId,
      icNumber,
      epfNumber: (formData.get('epfNumber') as string) || undefined,
      // Item 5a461b99 — "SOCSO & EIS Number". For a Malaysian employee with a blank number, normalise to
      // their IC number server-side (mirrors the form default); non-Malaysians keep manual entry. The
      // `nationality` hidden field is the RSC page's emp.nationality (used only for this convenience default).
      socsoNumber: pack.statutory.defaultSocsoEisNumber({
        socsoNumber: (formData.get('socsoNumber') as string) || null,
        icNumber,
        nationality: (formData.get('nationality') as string) || null,
      }),
      // Tax fields now owned by the Identification & Tax card (setTaxAction) — pass the stored values through so
      // an EPF/SOCSO save never wipes them (this setter is a full overwrite of the columns it writes).
      taxNumber: current.taxNumber ?? undefined,
      taxCategory: current.taxCategory ?? 1,
      numChildren: current.numChildren ?? 0,
      // Item a7271737 — SOCSO & EIS CATEGORY is now the single per-scheme control (consolidation approved). The
      // legacy subject_to_socso / eis_eligible booleans are DERIVED from the category by setStatutoryProfileMY
      // (= category !== 'none'), so this form sends the category and the setter keeps the booleans in sync. The
      // setter defends against an out-of-range value (falls back to the boolean, then 'auto').
      socsoCategory: (() => {
        const c = String(formData.get('socsoCategory') ?? 'auto');
        return c === 'first' || c === 'second' || c === 'none' ? c : 'auto';
      })(),
      eisCategory: String(formData.get('eisCategory') ?? 'auto') === 'none' ? 'none' : 'auto',
      // Item 5a461b99 — "Subject to SKBBK" stays its own switch (SKBBK is not part of the SOCSO category).
      subjectToSkbbk: formData.get('subjectToSkbbk') === 'on',
      employerBearsSocso: formData.get('employerBearsSocso') === 'on',
      employerBearsEis: formData.get('employerBearsEis') === 'on',
      employerBearsSkbbk: formData.get('employerBearsSkbbk') === 'on',
      // Item 0d9bb2da — "Employer bears EPF Contribution" on the EPF card. This full-row setter always sends
      // the checkbox state so the flag round-trips correctly.
      employerBearsEpf: formData.get('employerBearsEpf') === 'on',
      isResident: formData.get('isResident') === 'on',
      epfCitizenship: (() => {
        const c = String(formData.get('epfCitizenship') ?? 'citizen');
        return c === 'pr' || c === 'non_citizen' ? c : 'citizen';
      })(),
      // EPF contribution mode (Wave 2B, ADR-0046). The UI surfaces five named categories; mapEpfUiMode
      // maps them down to the three lawful KWSP enum values + the rates to persist HERE (never trust the
      // client to send a clean enum). resolveEpfElection() additionally nulls rates for any
      // non-voluntary_excess mode, so auto/none always persist with both rates null.
      ...mapEpfUiMode(
        formData.get('epfMode') as string | null,
        formData.get('epfEmployeeRate') as string | null,
        formData.get('epfEmployerRate') as string | null,
      ),
      // Bank fields RELOCATED to their own Bank Information card with a dedicated partial save (setBankAction,
      // item ef720d3a). This form no longer carries them, but setStatutoryProfileMY is a FULL overwrite of the
      // bank columns — so read the stored values and pass them through unchanged. Without this, every statutory
      // save would silently wipe the salary-payment bank details (the same trap the TP3 + zakat pass-throughs
      // guard against). The four custom-holder columns are NOT in setStatutoryProfileMY's write set, so they
      // are untouched here regardless.
      bankName: current?.bankName ?? undefined,
      bankAccountNo: current?.bankAccountNo ?? undefined,
      // TP3 opening balances RELOCATED to the Payroll tab (item a6a47698) with their own partial save
      // (setTp3Action). This form no longer carries the four TP3 columns, but the setter is a FULL
      // overwrite of the statutory row — so read the stored values and pass them through unchanged.
      // Without this, every Personnel statutory save would silently wipe the opening balances the TP3
      // card wrote (exactly the trap the zakat pass-through below already guards against).
      tp3Year: current?.tp3Year ?? null,
      tp3NetRemuneration: current?.tp3NetRemuneration != null ? Number(current.tp3NetRemuneration) : null,
      tp3EpfClaimed: current?.tp3EpfClaimed != null ? Number(current.tp3EpfClaimed) : null,
      tp3PcbPaid: current?.tp3PcbPaid != null ? Number(current.tp3PcbPaid) : null,
      // tp3ZakatPaid is never on this form (it comes from payroll-history import) — pass the stored
      // value through so a statutory save doesn't silently null an imported zakat opening balance.
      tp3ZakatPaid: current?.tp3ZakatPaid != null ? Number(current.tp3ZakatPaid) : null,
      // Zakat election pass-through (owned by Payroll > Transactions > Zakat since 58755260): the
      // stored decimal percent goes back in as-is (it is already ÷100), so the election round-trips
      // bit-for-bit through the full-overwrite setter.
      zakatActive: current?.zakatActive ?? false,
      zakatState: current?.zakatState ?? null,
      zakatMethod: current?.zakatMethod ?? null,
      zakatPercent: current?.zakatPercent != null ? Number(current.zakatPercent) : null,
      zakatFixed: current?.zakatFixed != null ? Number(current.zakatFixed) : null,
      zakatEffectiveFrom: current?.zakatEffectiveFrom ?? null,
      zakatEffectiveTo: current?.zakatEffectiveTo ?? null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Item a6a47698 — save ONLY the four TP3 opening-balance columns. TP3 was relocated from the Bank &
 * Statutory card (a single full-row overwrite form) onto the Payroll tab as its own card, so it needs a
 * dedicated partial-update action that leaves the rest of the statutory row untouched. requireAdmin gates
 * it exactly like setStatutoryAction; the pack setter appends the DomainEvent.
 */
export async function setTp3Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  const pack = packFor('MY');
  try {
    if (!pack) throw new Error('No localization pack for MY');
    await pack.statutory.setTp3(s, {
      personId,
      tp3Year: Number(formData.get('tp3Year')) || null,
      tp3NetRemuneration: formData.get('tp3NetRemuneration') ? Number(formData.get('tp3NetRemuneration')) : null,
      tp3EpfClaimed: formData.get('tp3EpfClaimed') ? Number(formData.get('tp3EpfClaimed')) : null,
      tp3PcbPaid: formData.get('tp3PcbPaid') ? Number(formData.get('tp3PcbPaid')) : null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Item ef720d3a — save ONLY the salary-payment bank columns + the custom-payment-holder controls. The Bank
 * Information card was split out of the single full-row statutory form onto its own card, so it needs a
 * dedicated partial-update action that leaves the rest of the statutory row untouched (exactly like
 * setTp3Action). requireAdmin gates it like setStatutoryAction; the pack setter validates require-when-enabled
 * and appends the `employee.bank.updated` DomainEvent.
 */
export async function setBankAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  const pack = packFor('MY');
  try {
    if (!pack) throw new Error('No localization pack for MY');
    await pack.statutory.setBank(s, {
      personId,
      bankName: (formData.get('bankName') as string) || null,
      bankAccountNo: (formData.get('bankAccountNo') as string) || null,
      enableCustomHolderName: formData.get('enableCustomHolderName') === 'on',
      customHolderName: (formData.get('customHolderName') as string) || null,
      enableCustomHolderId: formData.get('enableCustomHolderId') === 'on',
      customHolderId: (formData.get('customHolderId') as string) || null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Item 8b5334db — save ONLY the icNumber column. IC was relocated from the Bank & Statutory card to the Profile
 * tab (R34 TP3-split precedent), so it needs its own partial-update action. Unlike setBank/setTp3, the IC setter
 * SEEDS the statutory row (IC is the notNull identity) — setIcProfileMY upserts. requireAdmin gates it; the pack
 * setter validates the IC and appends `employee.ic.updated`.
 */
export async function setIcAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  const pack = packFor('MY');
  const icRaw = String(formData.get('icNumber') ?? '');
  try {
    if (!pack) throw new Error('No localization pack for MY');
    await pack.statutory.setIc(s, { personId, icNumber: icRaw });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  // Item 354a500d — server-side safety net for the IC → Date-of-Birth autofill. When the entered IC yields a
  // valid derived DOB, persist it through the audited setPersonComplianceFields path (fires person.updated) so
  // the derivation holds even if the client wrapper didn't run (JS off / API import). `dobOnlyIfEmpty` guarantees
  // we NEVER overwrite an existing DOB — it fills only when the person has none. Best-effort: the IC is already
  // saved, so a failure here (e.g. DOB already set → no-op) must not fail the IC save.
  const derivedDob = packFor('MY')?.statutory.dobFromIC(icRaw);
  if (derivedDob) {
    try {
      await setPersonComplianceFields(s, { employmentId, dateOfBirth: derivedDob, dobOnlyIfEmpty: true });
    } catch {
      // non-fatal — IC persisted; DOB autofill is a convenience.
    }
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Item e3ce0d4d — save ONLY the passport identification columns. The counterpart to setIcAction. Item
 * 55865c32: the Profile-tab identity block now shows BOTH sections for every employee — the pack setter
 * derives requiredness from the person's stored nationality server-side (non-Malaysian → number + issue +
 * expiry mandatory; Malaysian → optional but all-or-nothing). Like setIcAction the pack setter SEEDS the
 * statutory row (UPSERT) — but with NO IC (ic_number stays null) and SKIPS MyKad validation. Remark and
 * issuing country are optional; appends `employee.passport.updated`.
 */
export async function setPassportAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  const pack = packFor('MY');
  try {
    if (!pack) throw new Error('No localization pack for MY');
    await pack.statutory.setPassport(s, {
      personId,
      passportNumber: (formData.get('passportNumber') as string) || null,
      passportIssueDate: (formData.get('passportIssueDate') as string) || null,
      passportExpiryDate: (formData.get('passportExpiryDate') as string) || null,
      passportRemark: (formData.get('passportRemark') as string) || null,
      passportIssuingCountry: (formData.get('passportIssuingCountry') as string) || null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Item 8b5334db — save ONLY the tax columns of the Identification & Tax card (taxNumber, taxCategory,
 * taxResidency, numChildren, childReliefMode, employerBearsTax). The card was split out of the single full-row
 * statutory form (like the Bank card), so it needs a dedicated partial-update action that leaves the rest of the
 * statutory row untouched. requireAdmin gates it; the pack setter validates the enums, keeps isResident in sync,
 * and appends `employee.tax.updated`. childReliefMode 'auto' still persists a CONFIRMED numChildren (the client
 * surfaces the family-derived suggestion for the admin to accept) — this action never silently derives tax.
 */
/**
 * Item d64d0df4 — gather the Identity & Tax card's child-relief GRID out of the posted form.
 *
 * The grid is posted as flat scalar fields ("childRelief_under_18_full", "…_half", …) because a form
 * post has no nested shape; this reassembles them into the stored
 * `{ <category>: { full, half } }` document. It does NOT validate — `setTaxProfileMY` owns that
 * (whole numbers ≥ 0, unknown keys dropped, all-zero ⇒ null), so there is exactly one place where an
 * invalid grid can be rejected no matter which door the write comes through.
 */
function collectChildReliefTable(formData: FormData): Record<string, { full: number; half: number }> {
  const out: Record<string, { full: number; half: number }> = {};
  for (const key of CHILD_RELIEF_CATEGORIES) {
    out[key] = {
      full: Number(formData.get(`childRelief_${key}_full`)) || 0,
      half: Number(formData.get(`childRelief_${key}_half`)) || 0,
    };
  }
  return out;
}

export async function setTaxAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  const pack = packFor('MY');
  try {
    if (!pack) throw new Error('No localization pack for MY');
    await pack.statutory.setTax(s, {
      personId,
      taxNumber: (formData.get('taxNumber') as string) || null,
      taxCategory: Number(formData.get('taxCategory')) || 1,
      taxResidency: (formData.get('taxResidency') as string) || 'resident',
      numChildren: Number(formData.get('numChildren')) || 0,
      childReliefMode: (formData.get('childReliefMode') as string) || 'manual',
      employerBearsTax: formData.get('employerBearsTax') === 'on',
      // Item d64d0df4 — Disabled Individual is a Yes/No SELECT, not a checkbox, so read the value rather
      // than `=== 'on'`. Anything other than an explicit 'yes' (including a missing field, which is what a
      // caller predating this control sends) is No — the default that reproduces today's PCB exactly.
      disabledIndividual: formData.get('disabledIndividual') === 'yes',
      // Item d64d0df4 — Disabled Spouse, same Yes/No select shape as the field above. Anything other
      // than an explicit 'yes' (including a missing field) is No.
      disabledSpouse: formData.get('disabledSpouse') === 'yes',
      // Item d64d0df4 — the 'auto_table' category grid, posted as one field per category+share
      // ("childRelief_<category>_full" / "_half"). Collected here into the stored shape and handed to
      // the pack setter, which validates it (whole numbers ≥ 0, unknown keys dropped, empty ⇒ null).
      // NOTE it is sent on EVERY save, not only in auto_table mode: the setter overwrites the whole tax
      // column set, so omitting it in another mode would erase a grid the admin keyed earlier and would
      // silently move their tax the next time they switched back.
      childReliefTable: collectChildReliefTable(formData),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Feedback 0df0c635 — save ONLY the Others Statutory controls (today: "Subject to HRDF").
 * The Others Statutory card is its own partial-save card on the Bank & Statutory tab (like the Bank and
 * Income Tax cards), so it needs a dedicated partial-update action that leaves the rest of the statutory
 * row untouched. requireAdmin gates it like the sibling statutory actions; the pack setter appends
 * `employee.others-statutory.updated` (before/after).
 *
 * Feedback 57840a6e — the control is a THREE-option select, not a checkbox, so the form now carries the
 * full tri-state and this action must stop collapsing it: '' (or a missing field) ⇒ null "follow the
 * company's HRDF registration default", 'yes' ⇒ true, 'no' ⇒ false. The old `=== 'on'` coercion turned
 * every save of an untouched card into an explicit false, permanently excluding that employee from the
 * HRD Corp levy even after the company set a 0.5%/1.0% rate. setOthersStatutoryMY already stores null for
 * any non-boolean, so nothing below the action changes.
 */
export async function setOthersStatutoryAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  const pack = packFor('MY');
  const hrdfChoice = formData.get('subjectToHrdf');
  try {
    if (!pack) throw new Error('No localization pack for MY');
    await pack.statutory.setOthersStatutory(s, {
      personId,
      subjectToHrdf: hrdfChoice === 'yes' ? true : hrdfChoice === 'no' ? false : null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** ADR-0070 — set-based replace of an employee's assigned clocking sites. */
export async function setEmployeeClockingLocationsAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setEmployeeClockingLocations(s, {
      employmentId,
      clockingLocationIds: formData.getAll('clockingLocationIds').map(String),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** ADR-0070 — enable/disable geofencing for one employee + set its radius (metres). */
export async function setGeofencingAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setGeofencing(s, {
      employmentId,
      enabled: formData.get('enabled') === 'on',
      radiusM: formData.get('radiusM') ? Number(formData.get('radiusM')) : null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}
