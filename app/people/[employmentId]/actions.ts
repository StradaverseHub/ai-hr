'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { endReportingLine, setReportingLine, terminateEmployment, transferEmployee, updatePerson } from '@/core/org';
import { setCompensation } from '@/core/comp';
import { packFor } from '@/localization/registry';

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
    await terminateEmployment(s, {
      employmentId,
      terminationDate: String(formData.get('terminationDate')),
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
      // EPF contribution mode (Wave 2B). Rates are entered as percentages → stored as decimals.
      epfMode: (() => {
        const m = String(formData.get('epfMode') ?? 'auto');
        return m === 'voluntary_excess' || m === 'exempt' ? m : 'auto';
      })(),
      epfEmployeeRate: formData.get('epfEmployeeRate') ? Number(formData.get('epfEmployeeRate')) / 100 : null,
      epfEmployerRate: formData.get('epfEmployerRate') ? Number(formData.get('epfEmployerRate')) / 100 : null,
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
