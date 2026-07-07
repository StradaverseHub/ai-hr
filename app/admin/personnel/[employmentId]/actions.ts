'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { endReportingLine, setEmploymentGrade, setEmploymentHolidayCalendar, setReportingLine, terminateEmployment, transferEmployee, updatePerson, type HolidayCalendarSelection } from '@/core/org';
import { setCompensation } from '@/core/comp';
import { assignDefaultShift } from '@/core/roster';
import { setEmployeeClockingLocations, setGeofencing } from '@/core/clocking-location';
import { FixedTransactionAmountError, FixedTransactionDateError, setEmploymentPayComponent, UnsupportedFixedCurrencyError } from '@/core/pay-components';
import { setReviewEndDate, startReview, uploadReviewDocument, type ReviewType } from '@/core/employment-review';
import { buildReviewLetterPdf } from '@/lib/review-letter-build';
import { setPersonComplianceFields } from '@/core/profile';
import { packFor } from '@/localization/registry';
import { mapEpfUiMode } from '@/lib/epf-mode-map';

const REVIEW_TYPES: ReviewType[] = ['probation', 'contract', 'internship'];

export async function setReviewEndDateAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const rawType = String(formData.get('reviewType') ?? '');
  const reviewType = (REVIEW_TYPES as string[]).includes(rawType) ? (rawType as ReviewType) : 'probation';
  try {
    await setReviewEndDate(s, { employmentId, reviewType, endDate: String(formData.get('endDate') || '') || null });
  } catch (e) {
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
}

export async function startReviewAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await startReview(s, { employmentId });
  } catch (e) {
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Review started`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Document uploaded`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Letter saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
}

/** ec4cbf63 — assign (or clear, when shiftId is empty) the employee's DEFAULT shift. Mirrors the payroll-
 *  policy assignPolicyAction shape: admin-gated, real actor via the session, localized toast on success and
 *  the raw service message via ?error= on failure. The engine uses the default shift on any date without a
 *  dated roster row (roster row → default shift → company policy). */
export async function setDefaultShiftAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const rawShift = String(formData.get('shiftId') ?? '').trim();
  try {
    await assignDefaultShift(s, { employmentId, shiftId: rawShift || null });
  } catch (e) {
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  const t = await getTranslations('people.detail');
  redirect(`/admin/personnel/${employmentId}?toast=${encodeURIComponent(t('defaultShiftAssigned'))}`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
}

export async function setCompensationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setCompensation(s, {
      employmentId,
      basicSalary: Number(formData.get('basicSalary')),
      monthlyAllowance: Number(formData.get('monthlyAllowance') || 0),
      effectiveFrom: String(formData.get('effectiveFrom')),
    });
  } catch (e) {
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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

export async function setPersonAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updatePerson(s, {
      personId: String(formData.get('personId')),
      fullName: String(formData.get('fullName') ?? ''),
      primaryEmail: String(formData.get('primaryEmail') ?? ''),
      phone: (formData.get('phone') as string) || null,
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
}

/**
 * HR/Admin sets the two compliance-sensitive identity fields (gender, marital status) that drive
 * leave eligibility (Wave 2A-1). Routed through the approval-gated apply path (setPersonComplianceFields),
 * NOT the instant-write updatePerson — ADR-0012 refinement #24 deliberately keeps these fields on the
 * audited path. A blank select value ("") is an explicit clear-to-null. Marital status here does NOT
 * change the PCB/tax bracket (a separate statutory field) — surfaced on-screen.
 */
export async function setComplianceFieldsAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setPersonComplianceFields(s, {
      employmentId,
      gender: (formData.get('gender') as string) || null,
      maritalStatus: (formData.get('maritalStatus') as string) || null,
    });
  } catch (e) {
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    await pack.statutory.set(s, {
      personId,
      icNumber: String(formData.get('icNumber')),
      epfNumber: (formData.get('epfNumber') as string) || undefined,
      socsoNumber: (formData.get('socsoNumber') as string) || undefined,
      taxNumber: (formData.get('taxNumber') as string) || undefined,
      taxCategory: Number(formData.get('taxCategory')) || 1,
      numChildren: Number(formData.get('numChildren')) || 0,
      eisEligible: formData.get('eisEligible') === 'on',
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
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
    redirect(`/admin/personnel/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  redirect(`/admin/personnel/${employmentId}?toast=Saved`);
}
