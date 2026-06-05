'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { endReportingLine, setReportingLine, terminateEmployment, transferEmployee } from '@/core/org';
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
  redirect(`/people/${employmentId}`);
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
  redirect(`/people/${employmentId}`);
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
  redirect(`/people/${employmentId}`);
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
  redirect(`/people/${employmentId}`);
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
  redirect(`/people/${employmentId}`);
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
      eisEligible: formData.get('eisEligible') === 'on',
      bankName: (formData.get('bankName') as string) || undefined,
      bankAccountNo: (formData.get('bankAccountNo') as string) || undefined,
    });
  } catch (e) {
    redirect(`/people/${employmentId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  redirect(`/people/${employmentId}`);
}
