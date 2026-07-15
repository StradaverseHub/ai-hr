'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { endReportingLine, setEmployeeCode, setEmploymentAssignment, setEmploymentGrade, setEmploymentHolidayCalendar, setEmploymentInfo, setReportingLine, terminateEmployment, transferEmployee, updatePerson, type AssignmentStatusValue, type EmploymentTypeValue, type HolidayCalendarSelection } from '@/core/org';
import { setCompensation, updateCompensation } from '@/core/comp';
import { assignEmployeeShift } from '@/core/roster';
import { setEmployeeClockingLocations, setGeofencing } from '@/core/clocking-location';
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
import { mapEpfUiMode } from '@/lib/epf-mode-map';
import { defaultSocsoEisNumber, dobFromIC } from '@/localization/my/statutory';

// Tab retention (feedback bd2f0bb2): the client tab shell (components/personnel-tabs.tsx) injects a hidden
// `tab` field into every submitting form. Each action appends `&tab=<key>` to its post-save redirect so the
// reloaded page lands back on the tab the user was editing instead of resetting to Profile. Absent/empty =
// legacy behaviour (no tab param → first tab). All these URLs already carry a `?`, so we always append `&`.
function withTab(formData: FormData, url: string): string {
  const tab = String(formData.get('tab') ?? '').trim();
  return tab ? `${url}&tab=${encodeURIComponent(tab)}` : url;
}

const REVIEW_TYPES: ReviewType[] = ['probation', 'contract', 'internship'];

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

export async function transferAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await transferEmployee(s, {
      employmentId,
      effectiveDate: String(formData.get('effectiveDate')),
      departmentId: String(formData.get('departmentId')),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/** ADR-0054: set (or clear) an employee's location, effective-dated through the existing transfer path
 *  (CLOSE+INSERT on assignment). An empty locationId clears it. Cross-company coherence is enforced in
 *  the service. */
export async function setLocationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await transferEmployee(s, {
      employmentId,
      effectiveDate: String(formData.get('effectiveDate')),
      locationId: (formData.get('locationId') as string) || null,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
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

export async function terminateAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    const rawType = String(formData.get('terminationType') ?? '');
    const terminationType = (
      ['voluntary', 'involuntary', 'retired', 'contract_end', 'death', 'other'] as const
    ).includes(rawType as never)
      ? (rawType as 'voluntary' | 'involuntary' | 'retired' | 'contract_end' | 'death' | 'other')
      : undefined;
    await terminateEmployment(s, {
      employmentId,
      terminationDate: String(formData.get('terminationDate')),
      terminationType,
      terminationReason: (formData.get('terminationReason') as string) || undefined,
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

export async function addReportingLineAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setReportingLine(s, {
      subordinateEmploymentId: employmentId,
      managerEmploymentId: String(formData.get('managerEmploymentId')),
      lineType: String(formData.get('lineType')) as 'administrative' | 'functional' | 'project' | 'dotted',
      validFrom: String(formData.get('validFrom')),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

export async function endReportingLineAction(formData: FormData) {
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

export async function setCompensationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setCompensation(s, {
      employmentId,
      basicSalary: Number(formData.get('basicSalary')),
      // Allowance is no longer maintained on the Basic Salary screen (feedback 87c82b18) — allowances
      // belong to Pay Components. Omitting it CARRIES the existing figure forward (never wipes it).
      remarks: String(formData.get('remarks') ?? '').trim() || undefined,
      effectiveFrom: String(formData.get('effectiveFrom')),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

/**
 * Edit Salary Record (feedback 87c82b18, flow #4). Corrects the basic salary / remarks of an existing
 * OPEN salary row (latest active or future-effective). The service enforces immutability of historical
 * rows and appends the compensation.updated audit event; the screen re-derives increment/status.
 */
export async function editCompensationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    const rawBasic = formData.get('basicSalary');
    const rawBasicStr = String(rawBasic ?? '').trim();
    await updateCompensation(s, {
      compensationId: String(formData.get('compensationId')),
      employmentId,
      basicSalary: rawBasicStr !== '' ? Number(rawBasicStr) : undefined,
      // Remarks always submitted (possibly empty → cleared to NULL).
      remarks: String(formData.get('remarks') ?? '').trim() || null,
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
    // Holiday calendar (state OR HR-defined group) — the SINGLE unified input that replaces the standalone
    // work-state field, so the two assignment columns can never disagree.
    await setEmploymentHolidayCalendar(s, {
      employmentId,
      selection: parseHolidayCalendar(formData.get('holidayCalendar')),
    });
    // 2E (ADR-0041): seniority grade — same form, drives grade-scoped leave entitlements.
    await setEmploymentGrade(s, { employmentId, gradeId: String(formData.get('gradeId') ?? '') || null });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

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
 * b4682879 Emergency Contact — instant-write of the extended emergency-contact block via updatePerson.
 * fullName / primaryEmail / phone are carried through as hidden fields (pass-through, never wiped).
 */
export async function setEmergencyContactAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updatePerson(s, {
      personId: String(formData.get('personId')),
      fullName: String(formData.get('fullName') ?? ''),
      primaryEmail: String(formData.get('primaryEmail') ?? ''),
      phone: orNull(formData.get('phone')),
      emergencyContactName: orNull(formData.get('emergencyContactName')),
      emergencyContactRelationship: orNull(formData.get('emergencyContactRelationship')),
      emergencyContactPhone: orNull(formData.get('emergencyContactPhone')),
      emergencyContactPhone2: orNull(formData.get('emergencyContactPhone2')),
      emergencyContactAddress: orNull(formData.get('emergencyContactAddress')),
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
  // Helper: a present-but-blank field is an explicit clear (null); an absent field is untouched. Every
  // input on this single form is always rendered, so "" → null is the intended clear semantic here.
  const str = (name: string): string | null => {
    const v = formData.get(name);
    if (v == null) return null;
    const t = String(v).trim();
    return t === '' ? null : t;
  };
  try {
    await setEmploymentInfo(s, {
      employmentId,
      hiredOn: str('hiredOn') ?? undefined, // hiredOn is NOT NULL — a blank submit must not clear it.
      probationMonths: str('probationMonths') as string | null,
      probationDays: str('probationDays') as string | null,
      confirmationDate: str('confirmationDate'),
      resignationNoticeMonths: str('resignationNoticeMonths') as string | null,
      resignationNoticeDays: str('resignationNoticeDays') as string | null,
      resignationDate: str('resignationDate'),
      shortNoticeMonths: str('shortNoticeMonths') as string | null,
      shortNoticeDays: str('shortNoticeDays') as string | null,
      orgBranch: str('orgBranch'),
      orgDivision: str('orgDivision'),
      orgRegion: str('orgRegion'),
      orgLine: str('orgLine'),
      orgSection: str('orgSection'),
      orgTeam: str('orgTeam'),
      orgBase: str('orgBase'),
      employmentCategory: str('employmentCategory'),
    });
  } catch (e) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(withTab(formData, `/admin/personnel/${employmentId}?toast=Saved`));
}

const EMPLOYMENT_TYPES: readonly EmploymentTypeValue[] = ['full_time', 'part_time', 'contract', 'intern'];
const ASSIGNMENT_STATUSES: readonly AssignmentStatusValue[] = ['active', 'on_leave', 'probation', 'offboarding', 'terminated'];

/**
 * Employment tab org-info edit (feedback 594323a6) — the single Save for the five organisation fields HR
 * maintains on the Personnel Employment tab: Department, Position, Employment Type, Employee Status (all
 * effective-dated through setEmploymentAssignment: CLOSE+INSERT so history is preserved + an audited
 * `employment.assignment.changed` event) and Job Grade (routed to setEmploymentGrade, which owns
 * employment.gradeId). Enum values are validated here (defence-in-depth over the DB column types); an
 * out-of-catalog department/position id is FK-rejected by Postgres and surfaced via ?error=. Admin-gated.
 */
export async function setEmploymentAssignmentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const t = await getTranslations('people.detail');
  const rawType = String(formData.get('employmentType') ?? '').trim();
  const rawStatus = String(formData.get('status') ?? '').trim();
  const employmentType = EMPLOYMENT_TYPES.includes(rawType as EmploymentTypeValue)
    ? (rawType as EmploymentTypeValue)
    : undefined;
  const status = ASSIGNMENT_STATUSES.includes(rawStatus as AssignmentStatusValue)
    ? (rawStatus as AssignmentStatusValue)
    : undefined;
  // A present-but-unrecognised enum value is a tampered/stale submit — reject rather than silently ignore.
  if ((rawType && !employmentType) || (rawStatus && !status)) {
    redirect(withTab(formData, `/admin/personnel/${employmentId}?error=${encodeURIComponent(t('employmentInfo.invalidValue'))}`));
  }
  const effectiveDate = String(formData.get('effectiveDate') ?? '').trim();
  try {
    // Job Grade lives on `employment` — its own audited writer (no-ops when unchanged).
    await setEmploymentGrade(s, { employmentId, gradeId: String(formData.get('gradeId') ?? '') || null });
    // Department / Position / Employment Type / Employee Status — effective-dated assignment change.
    await setEmploymentAssignment(s, {
      employmentId,
      effectiveDate,
      departmentId: (formData.get('departmentId') as string) || undefined,
      positionId: (formData.get('positionId') as string) || null,
      employmentType,
      status,
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
      socsoNumber: defaultSocsoEisNumber({
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
  const derivedDob = dobFromIC(icRaw);
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
 * Item e3ce0d4d — save ONLY the passport identification columns for a NON-Malaysian employee. The counterpart
 * to setIcAction: the Profile-tab identity form shows the IC field for Malaysians and these passport fields for
 * everyone else (client-side, driven by the selected nationality). Like setIcAction the pack setter SEEDS the
 * statutory row (UPSERT) — but with NO IC (ic_number stays null) and SKIPS MyKad validation. It requires the
 * passport number + issue date + expiry date (remark optional) and appends `employee.passport.updated`.
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
