'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { endReportingLine, setEmployeeCode, setEmploymentGrade, setEmploymentHolidayCalendar, setEmploymentInfo, setReportingLine, terminateEmployment, transferEmployee, updatePerson, type HolidayCalendarSelection } from '@/core/org';
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
import { defaultSocsoEisNumber } from '@/localization/my/statutory';

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
 */
export async function setContactAddressAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updatePerson(s, {
      personId: String(formData.get('personId')),
      fullName: String(formData.get('fullName') ?? ''),
      primaryEmail: String(formData.get('primaryEmail') ?? ''),
      phone: orNull(formData.get('phone')),
      personalEmail: orNull(formData.get('personalEmail')),
      addressLine1: orNull(formData.get('addressLine1')),
      addressLine2: orNull(formData.get('addressLine2')),
      addressLine3: orNull(formData.get('addressLine3')),
      postcode: orNull(formData.get('postcode')),
      city: orNull(formData.get('city')),
      state: orNull(formData.get('state')),
      country: orNull(formData.get('country')),
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
    const icNumber = String(formData.get('icNumber'));
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
      taxNumber: (formData.get('taxNumber') as string) || undefined,
      taxCategory: Number(formData.get('taxCategory')) || 1,
      numChildren: Number(formData.get('numChildren')) || 0,
      // Item 5a461b99 — SOCSO & EIS statutory controls. eisEligible doubles as "Subject to EIS".
      eisEligible: formData.get('eisEligible') === 'on',
      subjectToSocso: formData.get('subjectToSocso') === 'on',
      subjectToSkbbk: formData.get('subjectToSkbbk') === 'on',
      employerBearsSocso: formData.get('employerBearsSocso') === 'on',
      employerBearsEis: formData.get('employerBearsEis') === 'on',
      employerBearsSkbbk: formData.get('employerBearsSkbbk') === 'on',
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
      bankName: (formData.get('bankName') as string) || undefined,
      bankAccountNo: (formData.get('bankAccountNo') as string) || undefined,
      tp3Year: Number(formData.get('tp3Year')) || null,
      tp3NetRemuneration: formData.get('tp3NetRemuneration') ? Number(formData.get('tp3NetRemuneration')) : null,
      tp3EpfClaimed: formData.get('tp3EpfClaimed') ? Number(formData.get('tp3EpfClaimed')) : null,
      tp3PcbPaid: formData.get('tp3PcbPaid') ? Number(formData.get('tp3PcbPaid')) : null,
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
