'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { endReportingLine, setEmploymentGrade, setEmploymentHolidayCalendar, setReportingLine, terminateEmployment, transferEmployee, updatePerson, type HolidayCalendarSelection } from '@/core/org';
import { setCompensation } from '@/core/comp';
import { setEmploymentPayComponent } from '@/core/pay-components';
import { packFor } from '@/localization/registry';
import { mapEpfUiMode } from '@/lib/epf-mode-map';

export async function setEmploymentComponentAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setEmploymentPayComponent(s, {
      employmentId,
      componentId: String(formData.get('componentId')),
      amount: Number(formData.get('amount')) || 0,
      effectiveFrom: String(formData.get('effectiveFrom')),
    });
  } catch (e) {
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}?toast=Saved`);
}

export async function transferAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  try {
    await transferEmployee(s, {
      employmentId,
      effectiveDate: String(formData.get('effectiveDate')),
      departmentId: String(formData.get('departmentId')),
    });
  } catch (e) {
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}?toast=Saved`);
}

export async function terminateAction(formData: FormData) {
  const s = await getSession();
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
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}?toast=Saved`);
}

export async function addReportingLineAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setReportingLine(s, {
      subordinateEmploymentId: employmentId,
      managerEmploymentId: String(formData.get('managerEmploymentId')),
      lineType: String(formData.get('lineType')) as 'administrative' | 'functional' | 'project' | 'dotted',
      validFrom: String(formData.get('validFrom')),
    });
  } catch (e) {
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}?toast=Saved`);
}

export async function endReportingLineAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  try {
    await endReportingLine(s, {
      reportingLineId: String(formData.get('reportingLineId')),
      endDate: String(formData.get('endDate')),
    });
  } catch (e) {
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}?toast=Saved`);
}

export async function setCompensationAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setCompensation(s, {
      employmentId,
      basicSalary: Number(formData.get('basicSalary')),
      monthlyAllowance: Number(formData.get('monthlyAllowance') || 0),
      effectiveFrom: String(formData.get('effectiveFrom')),
    });
  } catch (e) {
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}?toast=Saved`);
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
  const s = await getSession();
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
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}?toast=Saved`);
}

export async function setStatutoryAction(formData: FormData) {
  const s = await getSession();
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
    });
  } catch (e) {
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}?toast=Saved`);
}
