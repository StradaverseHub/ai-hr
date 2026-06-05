'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { endReportingLine, setReportingLine, terminateEmployment, transferEmployee } from '@/core/org';
// (actions used by the detail page below)

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
