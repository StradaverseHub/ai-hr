'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { endReportingLine, setEmploymentGrade, setEmploymentHolidayCalendar, setReportingLine, terminateEmployment, transferEmployee, updatePerson, type HolidayCalendarSelection } from '@/core/org';
import { setCompensation } from '@/core/comp';
import { setEmployeeClockingLocations, setGeofencing } from '@/core/clocking-location';
import { FixedTransactionDateError, setEmploymentPayComponent, UnsupportedFixedCurrencyError } from '@/core/pay-components';
import { setReviewEndDate, startReview, type ReviewType } from '@/core/employment-review';
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
    // Surface the two typed validation errors as localised inline messages (people.detail.dateError /
    // currencyUnsupported); any other error falls back to its raw message via the same ?error= banner.
    const t = await getTranslations('people.detail');
    const msg =
      e instanceof FixedTransactionDateError
        ? t('dateError')
        : e instanceof UnsupportedFixedCurrencyError
          ? t('currencyUnsupported')
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
      // 1.2.4 Zakat election. Percent is entered as a % and stored as a decimal (÷100). The setter
      // validates state/method and nulls the off-method amount; null/empty fields ⇒ no election.
      zakatActive: formData.get('zakatActive') === 'on',
      zakatState: (formData.get('zakatState') as string) || null,
      zakatMethod: (() => {
        const m = String(formData.get('zakatMethod') ?? '');
        return m === 'percent_of_pcb' || m === 'fixed' ? m : null;
      })(),
      zakatPercent: formData.get('zakatPercent') ? Number(formData.get('zakatPercent')) / 100 : null,
      zakatFixed: formData.get('zakatFixed') ? Number(formData.get('zakatFixed')) : null,
      zakatEffectiveFrom: (formData.get('zakatEffectiveFrom') as string) || null,
      zakatEffectiveTo: (formData.get('zakatEffectiveTo') as string) || null,
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
